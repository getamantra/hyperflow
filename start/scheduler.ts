import schedule from 'node-schedule'
import { DateTime } from 'luxon'
import axios from 'axios'
import Task from '#models/task'
import HyperflowWaitJobs from '#models/hyperflow_wait_jobs'
import db from '@adonisjs/lucid/services/db'
import { Queue } from 'bullmq'
const hyperflowUrl = process.env.HYPERFLOW_URL

const queueOptions: any = {
  connection: {
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT),
    password: process.env.REDIS_PASSWORD,
  },
  defaultJobOptions: {
    removeOnComplete: {
      age: 24 * 3600 * 30,
      count: 5000,
    },
    removeOnFail: {
      age: 24 * 3600 * 30,
      count: 5000,
    },
  },
}

const queue: any = new Queue(`orchestration-queue`, {
  limiter: {
    max: 5,
    duration: 5000,
    bounceBack: true,
  },
  ...queueOptions,
})

async function addTaskToQueue(taskData: any) {
  try {
    if (!taskData.name || !taskData.taskId) {
      throw new Error("Invalid task data: 'name' and 'taskId' are required.")
    }

    const task = {
      name: taskData.name,
      data: taskData,
      opts: {
        priority: taskData.priority ?? 0,
      },
    }
    const job = await queue.add(task.name, task.data, task.opts)
    console.log(`===Scheduling Task "${task.name}" added to the queue with job ID: ${job.id}`)
    return {
      status: 200,
      message: `Task "${task.name}" added to the queue successfully with job ID: ${job.id}`,
    }
  } catch (error: any) {
    return {
      status: 500,
      error: error.message,
    }
  }
}

export async function handleWaitTasks() {
  const now = DateTime.utc().toJSDate()
  console.log('**** Current UTC time', now)

  // THIS WILL DELETE JOBS OLDER THAN ONE DAYS FROM THE TABLE.
  const oneDaysBefore = DateTime.utc().minus({ days: 1 }).toJSDate()
  const deletedRows = await db
    .from('hyperflow_wait_jobs')
    .where('scheduled_time', '<', oneDaysBefore)
    .where('is_executed', true)
    .delete()

  if (typeof deletedRows === 'number' && deletedRows > 0) {
    console.log(`Deleted ${deletedRows} old WAIT task records (older than 1 days).`)
  }

  // FETCH TASKS WHERE EITHER WAIT OR SIMPLE TASK TYPE
  const pendingTasks = await db
    .from('hyperflow_wait_jobs')
    .where((query) => {
      query
        .where((q) => q.where('task_type', 'WAIT'))
        .orWhere((q) => q.where('task_type', 'SIMPLE'))
    })
    .andWhere('is_executed', false)
    .andWhere('scheduled_time', '<=', now)

  if (!pendingTasks.length) {
    console.log('**** No pending WAIT or RETRY tasks to execute at this time ****')
    return
  }

  for (const taskData of pendingTasks) {
    try {
      const taskId = taskData.task_id
      const taskType = taskData.task_type

      if (taskType === 'WAIT') {
        const task = await Task.findOrFail(taskId)
        const existingJsonData =
          typeof task.json_data === 'string' ? JSON.parse(task.json_data) : task.json_data

        const hyperflowWaitJobs = await HyperflowWaitJobs.findOrFail(taskId)
        hyperflowWaitJobs.is_executed = true
        await hyperflowWaitJobs.save()

        await axios.post(`${hyperflowUrl}/hyperflow/api/tasks`, {
          workflowId: existingJsonData.workflowInstanceId,
          taskReferenceName: existingJsonData.referenceTaskName,
          taskStatus: 'COMPLETED',
          taskId: existingJsonData.taskId,
          outputData: { message: 'wait task is executed successfully' },
          inputParameters: {},
          taskType: existingJsonData.taskType,
        })
        console.log(
          `Executed WAIT task: ${taskId} with execution_id ${existingJsonData.workflowInstanceId}`
        )
      } else if (taskType === 'SIMPLE') {
        const retryTask = await HyperflowWaitJobs.findOrFail(taskId)
        const jsonData =
          typeof retryTask.json_data === 'string'
            ? JSON.parse(retryTask.json_data)
            : retryTask.json_data

        retryTask.is_executed = true
        await retryTask.save()
        const result = await addTaskToQueue(jsonData)
        console.log(`Retrying SIMPLE task ${taskId}:`, result.message || result.error)
      } else {
        console.log(`Unknown task type "${taskType}" for task ${taskId}`)
      }
    } catch (error: any) {
      console.log(
        `Error processing task (${taskData.task_ref_name}) of type ${taskData.task_type}:`,
        error?.message || error
      )
    }
  }
}

// SCHEDULER WILL RUN IN EVERY 30 SECONDS
export function startWaitTaskScheduler() {
  schedule.scheduleJob('*/30 * * * * *', handleWaitTasks)
}
