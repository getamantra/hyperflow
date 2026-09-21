import RedisClient from '../services/redis/RedisClient.js'
import { HttpContext } from '@adonisjs/core/http'
import { Worker, Queue } from 'bullmq'
import { Redis } from 'ioredis'

const redisConnection = {
  host: process.env.REDIS_HOST,
  port: Number(process.env.REDIS_PORT),
  password: process.env.REDIS_PASSWORD,
}

const redisClient = new Redis({
  host: redisConnection.host,
  port: redisConnection.port,
  password: redisConnection.password,
})
const taskQueue = new Queue('00000000000000000000000000000001_admin', {
  connection: redisConnection,
})

const LOCK_KEY = 'worker-lock'
const LOCK_TTL = 60

class CacheController {
  isRedisCache(): boolean {
    try {
      const redisClient = RedisClient.getInstance()
      return !!redisClient
    } catch {
      return false
    }
  }

  async getCachedData(key: string): Promise<any | null> {
    try {
      if (this.isRedisCache()) {
        const redisClient = RedisClient.getInstance()
        const cachedResult = await redisClient.get(key)
        return cachedResult ? JSON.parse(cachedResult) : null
      }
    } catch (error) {
      console.error(`Error retrieving cache for key: ${key}`, error)
    }
    return null
  }

  async setDataIntoCache(key: string, data: any): Promise<void> {
    try {
      if (this.isRedisCache()) {
        const redisClient = RedisClient.getInstance()
        // const ttlInSeconds = 2 * 60 // 120 seconds
        await redisClient.set(key, JSON.stringify(data))
        // await redisClient.set(key, JSON.stringify(data), {
        //   EX: ttlInSeconds,
        // })
      }
    } catch (error) {
      console.error(`Unable to set cache for key: ${key}`, error)
    }
  }

  async deleteCachedData(key: string): Promise<void> {
    try {
      if (this.isRedisCache()) {
        const redisClient = RedisClient.getInstance()
        await redisClient.del(key)
      }
    } catch (error) {
      console.error(`Unable to delete cache for key: ${key}`, error)
    }
  }

  // *Below api endpoints are only for testing purpose of redis*

  // Get cached data by query string using (key)
  async retreiveCachedData({ request, response }: HttpContext): Promise<void> {
    try {
      const key = request.qs().key
      if (!key) {
        return response.status(400).json({ message: 'Key query parameter is required' })
      }
      if (this.isRedisCache()) {
        const cachedData = await this.getCachedData(key)
        if (cachedData) {
          return response.json({ data: cachedData })
        }
      }
      response.status(404).json({ message: 'Key not found in cache' })
    } catch (error) {
      response.status(500).json({ message: 'Error retrieving cache', error })
    }
  }

  // Set key and data in cache
  async setDataIntoCacheFromApi({ request, response }: HttpContext): Promise<void> {
    try {
      const { key, data } = request.only(['key', 'data'])
      if (!key || !data) {
        return response.status(400).json({ message: 'Key and data are required' })
      }
      if (this.isRedisCache()) {
        await this.setDataIntoCache(key, data)
        return response.json({ message: `Data stored with key: ${key}` })
      }
      response.status(404).json({ message: 'Key and data not set' })
    } catch (error) {
      response.status(500).json({ message: 'Error storing data in cache', error })
    }
  }

  // Delete cache key and corresponding data
  async deleteCacheKeyAndData({ request, response }: HttpContext): Promise<void> {
    try {
      const key = request.qs().key
      if (!key) {
        return response.status(400).json({ message: 'Key query parameter is required' })
      }
      let exists
      if (this.isRedisCache()) {
        const redisClient = RedisClient.getInstance()
        exists = await redisClient.exists(key)
      }
      if (!exists) {
        return response.status(404).json({ message: `Key "${key}" not found in cache` })
      }
      await this.deleteCachedData(key)
      response.json({ message: `Key and data deleted for key: ${key}` })
    } catch (error) {
      response.status(500).json({ message: 'Error in deleteCacheKeyAndData function', error })
    }
  }

  /**
   * If method is `drain`, then it will empty the queue (remove all jobs).
   * If method is `obliterate`, it will delete the entire queue and its data(if no active jobs)
   */
  async emptyQueue({ request, response }: HttpContext): Promise<void> {
    const queueName = request.input('queueName')
    if (!queueName) {
      response.status(400).json({
        error: 'Queue name is required.',
      })
      return
    }
    try {
      const queue = new Queue(queueName, { connection: redisConnection })
      const queueResult = await queue.obliterate()
      console.log('---drained', queueResult)

      response.status(200).json({
        message: 'Queue emptied successfully.',
      })
    } catch (error: any) {
      console.error('Error emptying queue job data:', error)
      response.status(500).json({
        error: error.message,
      })
    }
  }

  // This endpoints is only for testing purpose
  async addBulkTasks({ request, response }: HttpContext): Promise<void> {
    const jobs = request.input('tasks')

    if (!Array.isArray(jobs) || jobs.length === 0) {
      return response.status(400).json({
        error: 'Invalid tasks input. Provide an array of tasks.',
      })
    }

    try {
      const queueExists = await this.isQueueExists(taskQueue.name)

      if (!queueExists) {
        throw new Error('Queue is not initialized in Redis.')
      }
      await taskQueue.addBulk(
        jobs.map((task) => ({
          name: task.name,
          data: task,
          opts: {
            priority: task.opts?.priority ?? 0,
            tags: task.opts?.tags ?? [],
          },
        }))
      )

      return response.status(200).json({
        message: `${jobs.length} tasks added to the queue successfully.`,
      })
    } catch (error: any) {
      console.error('Error adding tasks to queue:', error)
      return response.status(500).json({
        error: error.message,
      })
    }
  }

  async isQueueExists(queueName: string): Promise<boolean> {
    try {
      const keys: string[] = await redisClient.keys(`bull:${queueName}:*`)
      return keys.length > 0
    } catch (error: any) {
      console.error('Queue check failed:', error.message)
      return false
    }
  }

  /**
   * This will return paginated data of the particular queue with type of status state.
   * state i.e 'waiting', 'active', 'completed', 'failed', 'prioritized', 'delayed'
   */
  async getQueueJobData({ request, response }: HttpContext): Promise<void> {
    const { queueName, status, page, limit } = request.qs()
    const currentPage = Number(page) || 1
    const perPage = Number(limit) || 10
    const start = (currentPage - 1) * perPage
    const end = start + perPage - 1

    if (!queueName || !status) {
      return response.status(400).json({ error: 'Queue name and status are required.' })
    }

    const validStatuses = ['waiting', 'active', 'completed', 'failed', 'prioritized', 'delayed']
    if (!validStatuses.includes(status)) {
      return response.status(400).json({ error: 'Invalid status value.' })
    }

    try {
      const queue = new Queue(queueName, { connection: redisConnection })

      const formatJobs = async (jobs: any[]): Promise<any[]> => {
        return Promise.all(
          jobs.map(async (job) => {
            const jobState = await job.getState()
            return {
              id: job.id,
              name: job.name,
              data: job.data,
              finishedOn: job.finishedOn || '',
              processedOn: job.processedOn || '',
              failedReason: job.failedReason || '',
              metadata: job.data.metadata || [],
              priority: job.opts.priority,
              state: jobState,
            }
          })
        )
      }

      let jobs: any[] = []
      let totalJobs = 0

      switch (status) {
        case 'waiting':
          ;[jobs, totalJobs] = await Promise.all([
            queue.getWaiting(start, end),
            queue.getJobCountByTypes('waiting'),
          ])
          break
        case 'active':
          ;[jobs, totalJobs] = await Promise.all([
            queue.getActive(start, end),
            queue.getJobCountByTypes('active'),
          ])
          break
        case 'completed':
          ;[jobs, totalJobs] = await Promise.all([
            queue.getCompleted(start, end),
            queue.getJobCountByTypes('completed'),
          ])
          break
        case 'failed':
          ;[jobs, totalJobs] = await Promise.all([
            queue.getFailed(start, end),
            queue.getJobCountByTypes('failed'),
          ])
          break
        case 'prioritized':
          ;[jobs, totalJobs] = await Promise.all([
            queue.getPrioritized(start, end),
            queue.getJobCountByTypes('prioritized'),
          ])
          break
        case 'delayed':
          ;[jobs, totalJobs] = await Promise.all([
            queue.getDelayed(start, end),
            queue.getJobCountByTypes('delayed'),
          ])
          break
      }

      const lastPage = Math.ceil(totalJobs / perPage)
      const meta = {
        total: totalJobs,
        per_page: perPage,
        current_page: currentPage,
        last_page: lastPage,
        first_page: 1,
        first_page_url: `?page=1`,
        last_page_url: `?page=${lastPage}`,
        next_page_url: currentPage < lastPage ? `?page=${currentPage + 1}` : null,
        previous_page_url: currentPage > 1 ? `?page=${currentPage - 1}` : null,
      }

      const formattedJobs = await formatJobs(jobs)

      return response.status(200).json({
        meta,
        data: formattedJobs,
      })
    } catch (error: any) {
      console.error('Error fetching queue jobs:', error)
      return response.status(500).json({ error: error.message })
    }
  }

  // Worker configuration settings (testing purpose only)
  async workerConfiguration() {
    async function acquireLock() {
      try {
        const lock = await redisClient.set(LOCK_KEY, 'locked', 'EX', LOCK_TTL, 'NX')
        return lock === 'OK'
      } catch (error) {
        console.error('Error acquiring lock:', error)
        return false
      }
    }

    async function releaseLock() {
      try {
        await redisClient.del(LOCK_KEY)
        console.log('Lock released')
      } catch (error) {
        console.error('Error releasing lock:', error)
      }
    }

    try {
      const hasLock = await acquireLock()
      if (!hasLock) {
        console.log('Another worker is already running. Exiting...')
        process.exit(1)
      }
      console.log('Worker instance acquired lock and is running...')
      const worker = new Worker(
        'test-queue',
        async (job) => {
          const lockAcquired = await acquireLock()
          if (!lockAcquired) {
            console.log(`Job ${job.id} is waiting for the lock...`)
            return
          }
          console.log(`Processing job ${job.id}`, job.data)
          await releaseLock()
        },
        {
          connection: redisConnection,
          concurrency: 1,
          limiter: {
            max: 1,
            duration: 1000,
          },
        }
      )

      worker.on('completed', async (job) => {
        console.log(`Job ${job.id} completed successfully`)
        await releaseLock()
      })

      worker.on('failed', async (job, err) => {
        console.error(`Job ${job?.id} failed with error: ${err.message}`)
        await releaseLock()
      })

      worker.on('error', async (err) => {
        console.error('Worker error:', err)
        await releaseLock()
      })

      worker.on('closed', async () => {
        console.warn('Worker closed. Releasing lock')
        await releaseLock()
      })

      worker.on('stalled', async (job) => {
        console.warn(`Job ${job} stalled. Releasing lock`)
        await releaseLock()
      })

      process.on('SIGINT', async () => {
        console.log('Worker shutting down')
        await releaseLock()
        process.exit(0)
      })

      process.on('exit', async () => {
        await releaseLock()
      })
    } catch (error) {
      console.error('Error in worker configuration:', error)
      await releaseLock()
      process.exit(1)
    }
  }
}

export default CacheController
