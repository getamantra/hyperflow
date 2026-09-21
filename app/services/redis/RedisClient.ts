import { createClient, RedisClientType } from 'redis'
const { REDIS_HOST, REDIS_PORT, ENABLE_CACHE = 0 } = process.env

class RedisClient {
  private static instance: RedisClientType | null = null
  private constructor() {}
  public static getInstance(): RedisClientType {
    if (!this.instance) {
      if (+ENABLE_CACHE) {
        this.instance = createClient({
          url: `redis://${REDIS_HOST}:${REDIS_PORT}`,
        })

        this.instance.connect().catch((error: any) => {
          console.error(`Redis connection error: ${error.message}`)
        })

        this.instance.on('error', (error: any) => {
          console.error(`Redis error: ${error.message}`)
        })

        this.instance.on('connect', () => {
          console.log(`Redis connected on port ${REDIS_PORT}`)
        })

        this.instance.on('ready', () => {
          console.log('Redis client is ready to use.')
        })

        this.instance.on('end', () => {
          console.log('Redis client disconnected.')
        })
      } else {
        console.log('---Redis caching is disabled.')
        throw new Error('Redis caching is disabled.')
      }
    }
    return this.instance
  }
}

export default RedisClient
