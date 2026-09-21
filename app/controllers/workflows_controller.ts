import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'

import db from '@adonisjs/lucid/services/db'
// import db from '@adonisjs/lucid/services/db'
import axios from 'axios'
import Workflow from '#models/workflow'
import MetaWorkflow from '#models/meta_workflow'
import Task from '#models/task'
import TaskInProgress from '#models/task_in_progress'
import TaskScheduled from '#models/task_scheduled'
import { workflowValidator, workflowStatusValidator } from '#validators/workflow'
import { Extras } from '#services/extra_service'
import { Queue } from 'bullmq'
import WorkflowVariableResolver from '#services/resolve_variables'
// import CacheController from './cache_controller.js'
import { DateTime } from 'luxon'
import nodeSchedule from 'node-schedule'
import HyperflowWaitJobs from '#models/hyperflow_wait_jobs'
import HyperflowLoopOver from '#models/hyperflow_loopover_tasks'

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

@inject()
export default class WorkflowsController {
  scheduleJob: nodeSchedule.Job | null = null
  /**
   * This will start the workflow execution, fetch the first task
   * Add that task to various tables and in the queue (orchestartion-queue)
   */
  async startExecution({ request, response }: HttpContext) {
    // const trx = await db.transaction()
    console.log('===hyperflow start execution endpoint called===')
    console.log('===hyperflow Incoming workflow execution request===', request.body())
    try {
      const data = await request.validateUsing(workflowValidator)
      const { name, version, variables } = data

      // Fetch meta workflow details.
      const metaWorkflow = await MetaWorkflow.query()
        .where('name', name)
        .where('version', version)
        .firstOrFail()
      const currentTime = Math.floor(Date.now() / 1000)
      const workflowId = Extras.generateKey(32)
      // const key = `workflow-${workflowId}`;
      const workStatus = 'RUNNING'
      const jsonData = JSON.parse(metaWorkflow.json_data as unknown as string)
      jsonData.status = workStatus
      jsonData.workflowId = workflowId
      jsonData.createTime = currentTime
      jsonData.startTime = currentTime
      jsonData.variables = { ...(variables || {}), execution_id: workflowId }

      const timeNow = Math.floor(DateTime.now().toSeconds())
      // Insert Details in workflow Table
      const workflow = await Workflow.create(
        {
          workflow_id: workflowId,
          json_data: JSON.stringify(jsonData) as unknown as JSON,
          status: workStatus,
          start_time: timeNow,
        }
        // { client: trx }
      )
      // const cacheController =  new CacheController();
      // cacheController.setDataIntoCache(key, jsonData);
      let workflowJson = JSON.parse(workflow.json_data as unknown as string)
      if (
        workflowJson.variables &&
        typeof workflowJson.variables === 'object' &&
        Object.keys(workflowJson.variables).length > 0
      ) {
        const workflowVariableResolver = new WorkflowVariableResolver()
        workflowJson = await workflowVariableResolver.resolveVariables(workflowJson)
        workflow.json_data = JSON.stringify(workflowJson) as unknown as JSON
        await workflow.save()
        let wFDetails = await Workflow.findOrFail(workflowId)
        workflowJson =
          typeof wFDetails.json_data === 'string'
            ? JSON.parse(wFDetails.json_data)
            : wFDetails.json_data
      }

      const { next: taskJson, changed: hasLeadingSkips } = this.markSkippedAndFindNextTask(
        workflowJson.tasks
      )
      if (hasLeadingSkips) {
        workflow.json_data = JSON.stringify(workflowJson) as unknown as JSON
        await workflow.save()
      }

      if (!taskJson) {
        await this.completeWorkflow(workflowJson, workflow)
        response.status(200).json({
          message: 'Workflow execution started',
          execution_id: workflowId,
        })
        return
      }

      console.log('======taskJson', taskJson)

      const taskId = Extras.generateKey(32)

      taskJson.taskType = taskJson.type
      taskJson.status = 'SCHEDULED'
      taskJson.workflowInstanceId = workflowId
      taskJson.taskId = taskId
      taskJson.scheduledTime = currentTime
      taskJson.startTime = currentTime
      taskJson.workFlowType = workflowJson.name
      taskJson.taskDefName = taskJson.name
      taskJson.referenceTaskName = taskJson.taskReferenceName
      taskJson.workflowDescription = workflowJson.description

      // Insert Details in Task Table with taskId
      const insertRecordInTaskTable: object = {
        task_id: taskId,
        workflow_id: workflowId,
        json_data: JSON.stringify(taskJson),
        task_ref: taskJson.taskReferenceName,
      }
      await Task.create(insertRecordInTaskTable)

      // Insert details in task-scheduled table (upsert: same task can re-run on jump-back).
      await TaskScheduled.updateOrCreate(
        { workflow_id: workflowId, task_key: taskJson.name },
        { task_id: taskId }
      )

      // Insert detail in task-in-progress table.
      const insertRecordInProgressTable: object = {
        task_def_name: taskJson.name,
        task_id: taskId,
        workflow_id: workflowId,
        in_progress_status: 1,
      }
      await TaskInProgress.create(insertRecordInProgressTable)

      // Add task to queue.
      await this.addTaskToQueue(taskJson)
      // await trx.commit()
      response.status(200).json({
        message: 'Workflow execution started',
        execution_id: workflowId,
      })
    } catch (error: any) {
      // await trx.rollback()
      response.status(500).json({
        message: 'Failed to start workflow',
        error: error.message,
      })
    }
  }

  // TASK ADDITION TO QUEUE
  async addTaskToQueue(taskData: any) {
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
      console.log(`Task "${task.name}" added to the queue with job ID: ${job.id}`)
      return {
        status: 200,
        message: `Task "${task.name}" added to the queue successfully`,
      }
    } catch (error: any) {
      return {
        status: 500,
        error: error.message,
      }
    }
  }

  // Get Workflow details
  async getWorkflowById({ params, response }: HttpContext) {
    try {
      const workflowId = params.workflowId
      if (!workflowId) {
        return response.status(400).json({ message: 'workflowId is required.' })
      }
      const workFlowDetails = await Workflow.findOrFail(workflowId)
      const workFlowJson = JSON.parse(workFlowDetails.json_data as unknown as string)
      return response.status(200).json({
        message: 'Workflow fetched successfully',
        data: workFlowJson,
      })
    } catch (error: any) {
      response.status(500).json({
        message: 'An error occurred while fetching the workflow',
        error: error.message,
      })
    }
  }

  // DELETE THE WORKFLOW
  async deleteWorkflow({ params, response }: HttpContext) {
    try {
      const workflowId = params.workflowId
      if (!workflowId) {
        return response.status(400).json({ message: 'workflowId is required.' })
      }
      const workflow = await Workflow.findOrFail(workflowId)
      await workflow.delete()
      return response.status(200).json({ message: 'Workflow deleted successfully.' })
    } catch (error: any) {
      return response.status(500).json({
        message: 'Failed to delete workflow.',
        error: error.message,
      })
    }
  }

  /**
   * THIS HANDLEWAITTASK FUNCTION WILL WORK BASED ON WAITTYPE
   *
   */
  async handleWaitTask(
    workflowId: string,
    workFlowJson: any,
    taskJson: any,
    previousTaskEndTime: any
  ) {
    try {
      const inputData = taskJson.inputParameters || {}
      const waitType = inputData.wait_type || ''
      const timezone = inputData.time_zone || 'UTC'
      let result
      switch (waitType) {
        case 'WAIT-FOR': {
          const untilStr = inputData.duration || ''
          const { hours, minutes } = this.parseDurationToHM(untilStr)

          const scheduleDate = DateTime.now()
            .setZone(timezone)
            .plus({ hours, minutes })
            .set({ second: 0, millisecond: 0 })
          const utcDateTime = scheduleDate.toUTC()

          result = await this.scheduleWaitTask(
            workflowId,
            workFlowJson,
            taskJson,
            utcDateTime,
            timezone,
            previousTaskEndTime
          )
          break
        }

        case 'WAIT-SPECIFIED-DATE-TIME': {
          const datetimeStr = inputData.until || ''

          const targetTime = DateTime.fromFormat(datetimeStr, 'yyyy-MM-dd HH:mm', {
            zone: timezone,
          })

          const utcDateTime = targetTime.toUTC()

          if (!utcDateTime.isValid) {
            throw new Error('Invalid datetime format for WAIT-SPECIFIED-DATE-TIME')
          }

          result = await this.scheduleWaitTask(
            workflowId,
            workFlowJson,
            taskJson,
            utcDateTime,
            timezone,
            previousTaskEndTime
          )
          break
        }

        default:
          throw new Error(`Unsupported waitType: ${waitType}`)
      }
      return result
    } catch (error) {
      console.log('handleWaitTask error:', error)
      throw error
    }
  }

  // ADD THE WAIT TASK IN DB TABLE FOR SCHEDULING AND ALSO UPDATE THE RESPECTIVE TABLES.
  async scheduleWaitTask(
    workflowId: string,
    workFlowJson: any,
    taskJson: any,
    dateTime: DateTime,
    timezone: string,
    previousTaskEndTime: any
  ) {
    const taskId = Extras.generateKey(32)

    await HyperflowWaitJobs.create({
      execution_id: workflowId,
      task_ref_name: taskJson.taskReferenceName,
      task_id: taskId,
      scheduled_time: dateTime,
      task_type: taskJson.type,
      timezone,
      is_executed: false,
    })

    await this.updateWaitTaskInDb(workflowId, workFlowJson, taskJson, taskId, previousTaskEndTime)

    return {
      status: 200,
      message: `WAIT task taskId: ${taskId} scheduled for ${dateTime} (${timezone})`,
    }
  }

  // This will update the WAIT task in db tables.
  async updateWaitTaskInDb(
    workflowId: string,
    workFlowJson: any,
    taskJson: any,
    taskId: any,
    previousTaskEndTime: number
  ) {
    const currentTime = Math.floor(Date.now() / 1000)

    try {
      // Prepare taskJson for DB insert
      taskJson.taskType = taskJson.type
      taskJson.status = 'SCHEDULED'
      taskJson.workflowInstanceId = workflowId
      taskJson.taskId = taskId
      taskJson.scheduledTime = currentTime
      taskJson.startTime = currentTime
      taskJson.workFlowType = workFlowJson.name
      taskJson.taskDefName = taskJson.name
      taskJson.referenceTaskName = taskJson.taskReferenceName
      taskJson.previousTaskEndTime = previousTaskEndTime
      taskJson.workflowDescription = workFlowJson.description

      // Save task record to DB
      const task = new Task()
      task.task_id = taskId
      task.workflow_id = workflowId
      task.json_data = JSON.stringify(taskJson) as unknown as JSON
      task.task_ref = taskJson.taskReferenceName
      await task.save()

      // Upsert: same task can be scheduled again when a SWITCH jumps back to it.
      await TaskScheduled.updateOrCreate(
        { workflow_id: workflowId, task_key: taskJson.name },
        { task_id: taskId }
      )

      const taskInProgress = new TaskInProgress()
      taskInProgress.task_def_name = taskJson.name
      taskInProgress.task_id = taskId
      taskInProgress.workflow_id = workflowId
      taskInProgress.in_progress_status = true
      await taskInProgress.save()
    } catch (error: any) {
      console.log(
        `Failed to insert WAIT task ${taskJson.taskReferenceName}: ${error?.response?.data || error.message}`
      )
      throw error
    }
  }

  parseDurationToHM(str: string): { hours: number; minutes: number } {
    const regex = /(?:(\d+)\s*hours?)?(?:\s*(\d+)\s*minutes?)?/i
    const match = str.match(regex)
    const hours = parseInt(match?.[1] || '0', 10)
    const minutes = parseInt(match?.[2] || '0', 10)
    return { hours, minutes }
  }

  async addUpdateLoopOver(workflowId: string, taskJson: any): Promise<void> {
    try {
      if (!workflowId) {
        console.log('workflowId is required')
        return
      }
      const loopOverData = taskJson?.loopOver
      if (!Array.isArray(loopOverData) || loopOverData.length === 0) {
        console.log('No valid loopOver data found.')
        return
      }
      const existingRecord = await HyperflowLoopOver.find(workflowId)

      if (existingRecord) {
        existingRecord.loopover_json = JSON.stringify(loopOverData)
        await existingRecord.save()
      } else {
        const newRecord = new HyperflowLoopOver()
        newRecord.execution_id = workflowId
        newRecord.loopover_json = JSON.stringify(loopOverData)
        await newRecord.save()
      }
    } catch (error) {
      console.log('Error in addUpdateLoopOver:', error)
    }
  }

  // Function to poll next task from workflow and add it to queue
  async processNextTask(workflowId: any, previousTaskEndTime: any): Promise<any> {
    // const trx = await db.transaction()
    try {
      if (!workflowId) {
        return { status: 400, message: 'workflowId is required.' }
      }
      const workFlowDetails = await Workflow.findOrFail(workflowId)
      // workFlowDetails.useTransaction(trx)
      let workFlowJson =
        typeof workFlowDetails.json_data === 'string'
          ? JSON.parse(workFlowDetails.json_data)
          : workFlowDetails.json_data

      const isAllTaskCompleted = workFlowJson.tasks.every(
        (task: any) =>
          task.status === 'COMPLETED' || task.status === 'SKIPPED' || task.status === 'FAILED'
      )

      if (isAllTaskCompleted) {
        return await this.completeWorkflow(workFlowJson, workFlowDetails)
      }
      const workflowVariableResolver = new WorkflowVariableResolver()
      workFlowJson = await workflowVariableResolver.resolveVariables(workFlowJson)
      const failedTask = workFlowJson.tasks.find(
        (task: any) => task.status === 'FAILED' && task.reasonForIncompletion
      )

      if (failedTask) {
        return {
          failureReason: failedTask.reasonForIncompletion,
        }
      }
      let { next: taskJson, changed: hasUpdates } = this.markSkippedAndFindNextTask(
        workFlowJson.tasks
      )

      if (taskJson && taskJson.type === 'WAIT') {
        const res = await this.handleWaitTask(
          workFlowJson.workflowId,
          workFlowJson,
          taskJson,
          previousTaskEndTime
        )
        return res
      }

      // if (taskJson.type === 'FORK_JOIN') {
      //   return await this.handleForkJoinTask(
      //     workflowId,
      //     workFlowJson,
      //     workFlowDetails,
      //     taskJson,
      //     previousTaskEndTime
      //   )
      // }

      // if (taskJson.type === 'JOIN') {
      //   return await this.handleJoinTask(
      //     workflowId,
      //     workFlowJson,
      //     workFlowDetails,
      //     taskJson,
      //     previousTaskEndTime
      //   )
      // }

      if (taskJson.type === 'SUB_WORKFLOW') {
        const result = await this.scheduleSubWorkflowTask(
          workflowId,
          workFlowJson,
          workFlowDetails,
          taskJson,
          previousTaskEndTime
        )
        if (result) return result
        workFlowDetails.json_data = JSON.stringify(workFlowJson) as unknown as JSON
        await workFlowDetails.save()
        return { status: 200, message: 'Sub-workflow task scheduled.', workflowId }
      }

      if (taskJson || hasUpdates) {
        workFlowDetails.json_data = JSON.stringify(workFlowJson) as unknown as JSON
        await workFlowDetails.save()

        if (this.areAllTasksCompleted(workFlowJson.tasks)) {
          return await this.completeWorkflow(workFlowJson, workFlowDetails)
        }
      }

      if (!taskJson) {
        return { status: 200, message: 'No runnable task found.', workflowId }
      }

      if (taskJson.type === 'DO_WHILE' && taskJson.do_while_ref?.iterationData) {
        await this.addUpdateLoopOver(workflowId, taskJson)
      }

      if (taskJson.type === 'SWITCH' && taskJson.resolveExpressionValue && taskJson.decisionCases) {
        let matchedTasks = taskJson.decisionCases[taskJson.resolveExpressionValue] || []

        if (!Array.isArray(matchedTasks) || matchedTasks.length === 0) {
          taskJson.status = 'FAILED'
          const task = new Task()
          const taskId = Extras.generateKey(32)
          task.task_id = taskId
          task.workflow_id = workflowId
          task.json_data = JSON.stringify(taskJson) as unknown as JSON
          task.task_ref = taskJson.taskReferenceName
          await task.save()
          workFlowJson.status = 'FAILED'
          workFlowDetails.status = 'FAILED'
          workFlowDetails.end_time = Math.floor(DateTime.now().toSeconds())
          workFlowDetails.json_data = JSON.stringify(workFlowJson) as unknown as JSON
          await workFlowDetails.save()
          return { status: 500, failureReason: 'Switch case expressions are invalid' }
        }

        for (const task of matchedTasks) {
          if ((task.skipTask === 1 || task.skipTask === true) && !task.status) {
            task.status = 'SKIPPED'
          }
        }

        let nextTask = matchedTasks.find(
          (t: any) =>
            !t.status && t.type !== 'GOTO' && (t.skipTask === 0 || t.skipTask === undefined)
        )

        // JUMP-BACK via GOTO: only if no non-GOTO tasks remain pending, find the
        // GOTO task and jump back to its target. This ensures branch tasks like
        if (!nextTask) {
          const switchMainIdx = workFlowJson.tasks.findIndex(
            (t: any) => t.taskReferenceName === taskJson.taskReferenceName
          )
          const jumpBackTarget = matchedTasks.find((t: any) => {
            if (t.type === 'GOTO' && t.inputParameters?.goto_task) {
              const tIdx = workFlowJson.tasks.findIndex(
                (m: any) => m.taskReferenceName === t.inputParameters.goto_task
              )
              return tIdx !== -1 && tIdx < switchMainIdx
            }
            return false
          })

          if (jumpBackTarget) {
            const switchRef = taskJson.taskReferenceName
            const targetRef = jumpBackTarget.inputParameters.goto_task
            workFlowJson.jumpBackCounts = workFlowJson.jumpBackCounts || {}
            workFlowJson.jumpBackCounts[switchRef] =
              (workFlowJson.jumpBackCounts[switchRef] || 0) + 1

            const MAX_JUMP_BACK = 10
            if (workFlowJson.jumpBackCounts[switchRef] > MAX_JUMP_BACK) {
              taskJson.status = 'FAILED'
              taskJson.reasonForIncompletion = `Jump-back limit (${MAX_JUMP_BACK}) exceeded for switch task: ${switchRef}`
              workFlowJson.status = 'FAILED'
              workFlowDetails.status = 'FAILED'
              workFlowDetails.end_time = Math.floor(DateTime.now().toSeconds())
              workFlowDetails.json_data = JSON.stringify(workFlowJson) as unknown as JSON
              await workFlowDetails.save()
              return {
                status: 500,
                failureReason: `GOTO limit exceeded for switch task: ${switchRef}`,
              }
            }

            this.applyJumpBack(workFlowJson, targetRef, switchRef)
            workFlowDetails.json_data = JSON.stringify(workFlowJson) as unknown as JSON
            await workFlowDetails.save()
            return await this.processNextTask(workflowId, previousTaskEndTime)
          }
        }

        if (
          nextTask &&
          nextTask.type === 'SWITCH' &&
          nextTask.resolveExpressionValue === 'No case matched switch expression'
        ) {
          nextTask.status = 'FAILED'
          const task = new Task()
          const taskId = Extras.generateKey(32)
          task.task_id = taskId
          task.workflow_id = workflowId
          task.json_data = JSON.stringify(nextTask) as unknown as JSON
          task.task_ref = nextTask.taskReferenceName
          await task.save()
          workFlowJson.status = 'FAILED'
          workFlowDetails.status = 'FAILED'
          workFlowDetails.end_time = Math.floor(DateTime.now().toSeconds())
          workFlowDetails.json_data = JSON.stringify(workFlowJson) as unknown as JSON
          await workFlowDetails.save()

          return { status: 500, failureReason: 'Switch case expressions are invalid' }
        }
        while (nextTask && nextTask.type === 'SWITCH') {
          matchedTasks = nextTask.decisionCases[nextTask.resolveExpressionValue] || []
          for (const task of matchedTasks) {
            if ((task.skipTask === 1 || task.skipTask === true) && !task.status) {
              task.status = 'SKIPPED'
            }
          }
          nextTask = matchedTasks.find(
            (t: any) => !t.status && (t.skipTask === 0 || t.skipTask === undefined)
          )
          if (nextTask && nextTask.type !== 'SWITCH') {
            break
          }
        }

        const allSwitchTasksCompleted = (matchedTasks || []).every(
          (t: any) =>
            t.type === 'GOTO' ||
            t.status === 'COMPLETED' ||
            t.status === 'SKIPPED' ||
            t.status === 'FAILED'
        )
        if (allSwitchTasksCompleted) {
          taskJson.status = 'COMPLETED'
          workFlowDetails.json_data = JSON.stringify(workFlowJson) as unknown as JSON
          await workFlowDetails.save()

          if (this.areAllTasksCompleted(workFlowJson.tasks)) {
            return await this.completeWorkflow(workFlowJson, workFlowDetails)
          }
          return await this.processNextTask(workflowId, previousTaskEndTime)
        } else if (nextTask) {
          const workflowVariableResolver = new WorkflowVariableResolver()

          workflowVariableResolver.snapshotInputParametersTemplate(nextTask)
          nextTask.inputParameters = await workflowVariableResolver.resolveInputParametersForTask(
            nextTask,
            workFlowJson
          )
          taskJson = nextTask
          if (taskJson.type === 'WAIT') {
            const res = await this.handleWaitTask(
              workFlowJson.workflowId,
              workFlowJson,
              taskJson,
              previousTaskEndTime
            )
            return res
          }

          if (taskJson.type === 'DO_WHILE' && taskJson.do_while_ref?.iterationData) {
            taskJson = await workflowVariableResolver.handleDoWhileTask(taskJson, workFlowJson)
            await this.addUpdateLoopOver(workflowId, taskJson)
            if (taskJson.type === 'WAIT') {
              const res = await this.handleWaitTask(
                workFlowJson.workflowId,
                workFlowJson,
                taskJson,
                previousTaskEndTime
              )
              return res
            }
          }
        }
        workFlowDetails.json_data = JSON.stringify(workFlowJson) as unknown as JSON
        await workFlowDetails.save()
      }

      if (
        taskJson.type === 'DO_WHILE' &&
        !(taskJson.do_while_ref && taskJson.do_while_ref.iterationData)
      ) {
        taskJson = await workflowVariableResolver.handleDoWhileTask(taskJson, workFlowJson)
        if (taskJson.type === 'WAIT') {
          const res = await this.handleWaitTask(
            workFlowJson.workflowId,
            workFlowJson,
            taskJson,
            previousTaskEndTime
          )
          return res
        }
      }

      if (taskJson.type === 'DO_WHILE' && taskJson.do_while_ref?.iterationData) {
        let matchedTasks = taskJson.do_while_ref.iterationData

        for (const task of matchedTasks) {
          if ((task.skipTask === 1 || task.skipTask === true) && !task.status) {
            task.status = 'SKIPPED'
            taskJson = await workflowVariableResolver.handleDoWhileTask(taskJson, workFlowJson)
            matchedTasks = taskJson.do_while_ref.iterationData
          }
        }

        if (matchedTasks.length > 0) {
          const allDoWhileTasksCompleted = this.areAllTasksCompleted(matchedTasks)

          if (allDoWhileTasksCompleted) {
            workFlowJson = await this.updateDoWhileTaskStatus(workFlowJson)
            workFlowDetails.json_data = JSON.stringify(workFlowJson) as unknown as JSON
            await workFlowDetails.save()

            if (this.areAllTasksCompleted(workFlowJson.tasks)) {
              return await this.completeWorkflow(workFlowJson, workFlowDetails)
            }

            return await this.processNextTask(workflowId, previousTaskEndTime)
          } else {
            taskJson = matchedTasks.find((t: any) => !t.status)
            if (!taskJson) {
              // Every materialized task in this iteration already has a status but
              // allDoWhileTasksCompleted was false — nothing runnable right now.
              return { status: 200, message: 'No runnable task found.', workflowId }
            }
            if (taskJson.type === 'WAIT') {
              const res = await this.handleWaitTask(
                workFlowJson.workflowId,
                workFlowJson,
                taskJson,
                previousTaskEndTime
              )
              return res
            }
          }
        }
      }

      const allTasksCompleted = workFlowJson.tasks.every(
        (task: any) =>
          task.status === 'COMPLETED' || task.status === 'SKIPPED' || task.status === 'FAILED'
      )
      workFlowDetails.json_data = JSON.stringify(workFlowJson) as unknown as JSON
      await workFlowDetails.save()
      if (allTasksCompleted) {
        return await this.completeWorkflow(workFlowJson, workFlowDetails)
      }
      // Process the task
      if (taskJson.type === 'SUB_WORKFLOW') {
        const failure = await this.scheduleSubWorkflowTask(
          workflowId,
          workFlowJson,
          workFlowDetails,
          taskJson,
          previousTaskEndTime
        )
        if (failure) return failure
        workFlowDetails.json_data = JSON.stringify(workFlowJson) as unknown as JSON
        await workFlowDetails.save()
        return { status: 200, message: 'Sub-workflow task scheduled.', workflowId }
      }
      await this.scheduleAndQueueTask(workflowId, workFlowJson, taskJson, previousTaskEndTime)
      return { status: 200, message: 'Task updated and next task polled.', workflowId }
    } catch (error: any) {
      // await trx.rollback()
      return { status: 500, message: 'Failed to start workflow.', error: error.message }
    }
  }

  // Persist a resolved task as SCHEDULED (Task/TaskScheduled/TaskInProgress rows)
  // and push it to the orchestration queue for the external worker to execute.
  // Shared by the single-next-task path in processNextTask and by each FORK_JOIN
  // branch in handleForkJoinTask.
  private async scheduleAndQueueTask(
    workflowId: string,
    workFlowJson: any,
    taskJson: any,
    previousTaskEndTime: any
  ): Promise<void> {
    const currentTime = Math.floor(Date.now() / 1000)
    const taskId = Extras.generateKey(32)
    taskJson.taskType = taskJson.type
    taskJson.status = 'SCHEDULED'
    taskJson.workflowInstanceId = workflowId
    taskJson.taskId = taskId
    taskJson.scheduledTime = currentTime
    taskJson.startTime = currentTime
    taskJson.workFlowType = workFlowJson.name
    taskJson.taskDefName = taskJson.name
    taskJson.referenceTaskName = taskJson.taskReferenceName
    taskJson.previousTaskEndTime = previousTaskEndTime
    taskJson.workflowDescription = workFlowJson.description

    const task = new Task()
    task.task_id = taskId
    task.workflow_id = workflowId
    task.json_data = JSON.stringify(taskJson) as unknown as JSON
    task.task_ref = taskJson.taskReferenceName
    await task.save()

    await TaskScheduled.updateOrCreate(
      { workflow_id: workflowId, task_key: taskJson.name },
      { task_id: taskId }
    )

    const taskInProgress = new TaskInProgress()
    taskInProgress.task_def_name = taskJson.name
    taskInProgress.task_id = taskId
    taskInProgress.workflow_id = workflowId
    taskInProgress.in_progress_status = true
    await taskInProgress.save()

    await this.addTaskToQueue(taskJson)
  }

  // Mark a single task and its whole workflow as FAILED, mirroring the existing
  // inline FAILED-marking pattern used for invalid SWITCH cases / jump-back limits.
  private async failWorkflowForTask(
    workFlowJson: any,
    workFlowDetails: any,
    taskJson: any,
    reason: string
  ): Promise<any> {
    taskJson.status = 'FAILED'
    taskJson.reasonForIncompletion = reason
    workFlowJson.status = 'FAILED'
    workFlowDetails.status = 'FAILED'
    workFlowDetails.end_time = Math.floor(DateTime.now().toSeconds())
    workFlowDetails.json_data = JSON.stringify(workFlowJson) as unknown as JSON
    await workFlowDetails.save()

    if (workFlowJson.parentWorkflowId) {
      await this.notifyParentOfSubWorkflowCompletion(workFlowJson, 'FAILED')
    }

    return { status: 500, failureReason: reason }
  }

  // async handleForkJoinTask(
  //   workflowId: string,
  //   workFlowJson: any,
  //   workFlowDetails: any,
  //   taskJson: any,
  //   previousTaskEndTime: any
  // ): Promise<any> {
  //   if (!Array.isArray(taskJson.forkTasks) || taskJson.forkTasks.length === 0) {
  //     return await this.failWorkflowForTask(
  //       workFlowJson,
  //       workFlowDetails,
  //       taskJson,
  //       'FORK_JOIN task has no forkTasks branches.'
  //     )
  //   }

  //   const resolver = new WorkflowVariableResolver()
  //   let scheduledAny = false

  //   for (const branch of taskJson.forkTasks) {
  //     if (!Array.isArray(branch) || branch.length === 0) continue
  //     const nextInBranch = branch.find((t: any) => !t.status)
  //     if (!nextInBranch) continue

  //     if (nextInBranch.skipTask === 1 || nextInBranch.skipTask === true) {
  //       nextInBranch.status = 'SKIPPED'
  //       scheduledAny = true
  //       continue
  //     }

  //     await resolver.resolveTask(nextInBranch, workFlowJson)

  //     if (nextInBranch.type === 'SUB_WORKFLOW') {
  //       const failure = await this.scheduleSubWorkflowTask(
  //         workflowId,
  //         workFlowJson,
  //         workFlowDetails,
  //         nextInBranch,
  //         previousTaskEndTime
  //       )
  //       if (failure) return failure
  //     } else {
  //       await this.scheduleAndQueueTask(workflowId, workFlowJson, nextInBranch, previousTaskEndTime)
  //     }
  //     scheduledAny = true
  //   }

  //   const allBranchesDrained = taskJson.forkTasks.every(
  //     (branch: any[]) =>
  //       !Array.isArray(branch) ||
  //       branch.every((t: any) => ['COMPLETED', 'SKIPPED', 'FAILED'].includes(t.status))
  //   )

  //   if (allBranchesDrained) {
  //     taskJson.status = 'COMPLETED'
  //     workFlowDetails.json_data = JSON.stringify(workFlowJson) as unknown as JSON
  //     await workFlowDetails.save()
  //     return await this.processNextTask(workflowId, previousTaskEndTime)
  //   }

  //   workFlowDetails.json_data = JSON.stringify(workFlowJson) as unknown as JSON
  //   await workFlowDetails.save()

  //   return {
  //     status: 200,
  //     message: scheduledAny
  //       ? 'FORK_JOIN branch task(s) scheduled.'
  //       : 'FORK_JOIN branches in progress.',
  //     workflowId,
  //   }
  // }

  // async handleJoinTask(
  //   workflowId: string,
  //   workFlowJson: any,
  //   workFlowDetails: any,
  //   taskJson: any,
  //   previousTaskEndTime: any
  // ): Promise<any> {
  //   const joinOn: string[] = Array.isArray(taskJson.joinOn) ? taskJson.joinOn : []

  //   if (joinOn.length === 0) {
  //     return await this.failWorkflowForTask(
  //       workFlowJson,
  //       workFlowDetails,
  //       taskJson,
  //       'JOIN task has no joinOn references.'
  //     )
  //   }

  //   const resolver = new WorkflowVariableResolver()
  //   const allJoined = joinOn.every((ref) => {
  //     const branchTask = resolver.findTaskByRef(workFlowJson.tasks, ref)
  //     return branchTask && ['COMPLETED', 'SKIPPED', 'FAILED'].includes(branchTask.status)
  //   })

  //   if (!allJoined) {
  //     return { status: 200, message: 'JOIN waiting on branch completion.', workflowId }
  //   }

  //   taskJson.status = 'COMPLETED'
  //   workFlowDetails.json_data = JSON.stringify(workFlowJson) as unknown as JSON
  //   await workFlowDetails.save()
  //   return await this.processNextTask(workflowId, previousTaskEndTime)
  // }

  async scheduleSubWorkflowTask(
    parentWorkflowId: string,
    parentWorkflowJson: any,
    parentWorkflowDetails: any,
    taskJson: any,
    previousTaskEndTime: any
  ): Promise<any> {
    const currentTime = Math.floor(Date.now() / 1000)
    const param = taskJson.subWorkflowParam

    if (!param?.name || param?.version === undefined || param?.version === null) {
      return await this.failWorkflowForTask(
        parentWorkflowJson,
        parentWorkflowDetails,
        taskJson,
        'subWorkflowParam.name/version is missing or unresolved.'
      )
    }

    const metaWorkflow = await MetaWorkflow.query()
      .where('name', param.name)
      .where('version', param.version)
      .first()

    if (!metaWorkflow) {
      return await this.failWorkflowForTask(
        parentWorkflowJson,
        parentWorkflowDetails,
        taskJson,
        `Sub-workflow definition not found: ${param.name} v${param.version}`
      )
    }

    // Register the parent's own SUB_WORKFLOW task instance. There is no external
    // worker for this task type, so it is NOT pushed to the BullMQ queue.
    const parentTaskId = Extras.generateKey(32)
    taskJson.taskType = taskJson.type
    taskJson.status = 'IN_PROGRESS'
    taskJson.workflowInstanceId = parentWorkflowId
    taskJson.taskId = parentTaskId
    taskJson.scheduledTime = currentTime
    taskJson.startTime = currentTime
    taskJson.workFlowType = parentWorkflowJson.name
    taskJson.taskDefName = taskJson.name
    taskJson.referenceTaskName = taskJson.taskReferenceName
    taskJson.previousTaskEndTime = previousTaskEndTime
    taskJson.workflowDescription = parentWorkflowJson.description

    const parentTask = new Task()
    parentTask.task_id = parentTaskId
    parentTask.workflow_id = parentWorkflowId
    parentTask.json_data = JSON.stringify(taskJson) as unknown as JSON
    parentTask.task_ref = taskJson.taskReferenceName
    await parentTask.save()

    await TaskScheduled.updateOrCreate(
      { workflow_id: parentWorkflowId, task_key: taskJson.name },
      { task_id: parentTaskId }
    )

    const parentTaskInProgress = new TaskInProgress()
    parentTaskInProgress.task_def_name = taskJson.name
    parentTaskInProgress.task_id = parentTaskId
    parentTaskInProgress.workflow_id = parentWorkflowId
    parentTaskInProgress.in_progress_status = true
    await parentTaskInProgress.save()

    // Spawn the child workflow — mirrors startExecution's body.
    const childWorkflowId = Extras.generateKey(32)
    const childJson = JSON.parse(metaWorkflow.json_data as unknown as string)
    childJson.status = 'RUNNING'
    childJson.workflowId = childWorkflowId
    childJson.createTime = currentTime
    childJson.startTime = currentTime
    childJson.variables = { ...(taskJson.inputParameters || {}), execution_id: childWorkflowId }
    childJson.parentWorkflowId = parentWorkflowId
    childJson.parentTaskReferenceName = taskJson.taskReferenceName
    childJson.parentTaskId = parentTaskId

    const timeNow = Math.floor(DateTime.now().toSeconds())
    const childWorkflow = await Workflow.create({
      workflow_id: childWorkflowId,
      json_data: JSON.stringify(childJson) as unknown as JSON,
      status: 'RUNNING',
      start_time: timeNow,
    })

    const parentWorkflowLog = await db
      .from('workflow_logs')
      .where('workflow_id', parentWorkflowId)
      .first()

    if (parentWorkflowLog) {
      const namePrefix = `${parentWorkflowLog.tenant_id}_`
      const childJobName = metaWorkflow.name.startsWith(namePrefix)
        ? metaWorkflow.name.slice(namePrefix.length)
        : metaWorkflow.name

      const childJob = await db
        .from('jobs')
        .where('tenant_id', parentWorkflowLog.tenant_id)
        .where('name', childJobName)
        .first()

      if (childJob) {
        await db.table('workflow_logs').insert({
          tenant_id: parentWorkflowLog.tenant_id,
          job_id: childJob.id,
          workflow_id: childWorkflowId,
          name: metaWorkflow.name,
          job_version: childJob.version,
          status: 'RUNNING',
          initiated_by: parentWorkflowLog.initiated_by,
          is_cron: parentWorkflowLog.is_cron,
          chat_id: parentWorkflowLog.chat_id ?? null,
          start_time: timeNow,
        })
      }
    }

    taskJson.subWorkflowId = childWorkflowId

    let resolvedChildJson = childJson
    const resolver = new WorkflowVariableResolver()
    if (
      childJson.variables &&
      typeof childJson.variables === 'object' &&
      Object.keys(childJson.variables).length > 0
    ) {
      resolvedChildJson = await resolver.resolveVariables(childJson)
      childWorkflow.json_data = JSON.stringify(resolvedChildJson) as unknown as JSON
      await childWorkflow.save()
    }

    let childTaskJson
    for (const t of resolvedChildJson.tasks) {
      if (t.skipTask === 1) {
        t.status = 'SKIPPED'
        continue
      }
      if (t.skipTask === 0) {
        childTaskJson = t
        break
      }
    }

    if (!childTaskJson) {
      resolvedChildJson.status = 'COMPLETED'
      resolvedChildJson.endTime = currentTime
      childWorkflow.status = 'COMPLETED'
      childWorkflow.end_time = currentTime
      childWorkflow.json_data = JSON.stringify(resolvedChildJson) as unknown as JSON
      await childWorkflow.save()

      taskJson.status = 'COMPLETED'
      taskJson.outputParameters = await resolver.resolveObject(
        { ...(resolvedChildJson.outputParameters || {}) },
        resolvedChildJson
      )
      return undefined
    }

    await this.scheduleAndQueueTask(childWorkflowId, resolvedChildJson, childTaskJson, currentTime)
    childWorkflow.json_data = JSON.stringify(resolvedChildJson) as unknown as JSON
    await childWorkflow.save()
    return undefined
  }

  // Notify the parent workflow that a sub-workflow (identified by
  // parentWorkflowId/parentTaskReferenceName/parentTaskId in the child's own
  // json_data blob) has reached a terminal state. Reuses the exact self-HTTP-
  // callback pattern start/scheduler.ts already uses for WAIT-task completion,
  // so the parent advances through the normal task-completion endpoint/pipeline.
  async notifyParentOfSubWorkflowCompletion(workFlowJson: any, status: 'COMPLETED' | 'FAILED') {
    if (!workFlowJson.parentWorkflowId || !workFlowJson.parentTaskReferenceName) return
    try {
      let outputData: Record<string, any> = {}
      if (status === 'COMPLETED') {
        const resolver = new WorkflowVariableResolver()
        outputData = await resolver.resolveObject(
          { ...(workFlowJson.outputParameters || {}) },
          workFlowJson
        )
      } else {
        outputData = {
          error: workFlowJson.reasonForIncompletion || 'Sub-workflow execution failed.',
        }
      }

      await axios.post(`${process.env.HYPERFLOW_URL}/hyperflow/api/tasks`, {
        workflowId: workFlowJson.parentWorkflowId,
        taskReferenceName: workFlowJson.parentTaskReferenceName,
        taskId: workFlowJson.parentTaskId,
        taskStatus: status,
        outputData,
        inputParameters: {},
        taskType: 'SUB_WORKFLOW',
      })
    } catch (err: any) {
      console.log(
        `Failed to notify parent workflow ${workFlowJson.parentWorkflowId} of sub-workflow completion:`,
        err.message
      )
    }
  }

  // Reset a task's execution state so it can be re-executed (used by jump-back).
  // For SWITCH tasks, also clears the resolved expression and all case-task statuses.
  // For DO_WHILE tasks, clears the loop-iteration reference so the loop restarts.
  private resetTaskState(task: any): void {
    delete task.status
    delete task.outputParameters
    // Restore original unresolved inputParameters (snapshotted on first resolution by
    // WorkflowVariableResolverService.snapshotInputParametersTemplate) so the next resolution
    // pass re-reads current workflow variables instead of replaying stale resolved values.
    // Deep-clone the snapshot on restore so repeated jump-backs never share mutable state.
    if (task._inputParametersTemplate) {
      task.inputParameters = JSON.parse(JSON.stringify(task._inputParametersTemplate))
    }
    if (task.type === 'SWITCH') {
      delete task.resolveExpressionValue
      if (task.decisionCases) {
        for (const caseKey of Object.keys(task.decisionCases)) {
          for (const caseTask of task.decisionCases[caseKey]) {
            this.resetTaskState(caseTask)
          }
        }
      }
      if (task.defaultCase) {
        for (const caseTask of task.defaultCase) {
          this.resetTaskState(caseTask)
        }
      }
    }
    if (task.type === 'DO_WHILE') {
      delete task.do_while_ref
    }
  }

  // Reset all tasks from targetRef through switchRef (inclusive) so sequential
  // execution restarts from the target task after a SWITCH jump-back.
  private applyJumpBack(workFlowJson: any, targetRef: string, switchRef: string): void {
    const targetIndex = workFlowJson.tasks.findIndex((t: any) => t.taskReferenceName === targetRef)
    const switchIndex = workFlowJson.tasks.findIndex((t: any) => t.taskReferenceName === switchRef)
    if (targetIndex === -1 || switchIndex === -1 || targetIndex > switchIndex) return
    for (let i = targetIndex; i <= switchIndex; i++) {
      this.resetTaskState(workFlowJson.tasks[i])
    }
  }

  // Returns true when every task in the given array has reached a terminal status.
  private areAllTasksCompleted(tasks: any[]): boolean {
    return tasks.every(
      (t: any) => t.status === 'COMPLETED' || t.status === 'SKIPPED' || t.status === 'FAILED'
    )
  }

  private markSkippedAndFindNextTask(tasks: any[]): { next: any | null; changed: boolean } {
    let changed = false
    for (const task of tasks) {
      if (!task.status) {
        if (task.skipTask === 1 || task.skipTask === true) {
          task.status = 'SKIPPED'
          changed = true
        } else {
          return { next: task, changed }
        }
      }
    }
    return { next: null, changed }
  }

  // Common function to mark workflow as complete.
  async completeWorkflow(workFlowJson: any, workFlowDetails: any) {
    workFlowJson.status = 'COMPLETED'
    const currentTime = Math.floor(DateTime.now().toSeconds())
    workFlowJson.endTime = currentTime
    workFlowDetails.json_data = JSON.stringify(workFlowJson) as unknown as JSON
    workFlowDetails.status = 'COMPLETED'
    workFlowDetails.end_time = currentTime
    await workFlowDetails.save()

    // IF THIS WORKFLOW WAS RUNNING AS A SUB WORKFLOW, PROPAGATE COMPLETION BACK
    // TO THE PARENT'S SUB_WORKFLOW TASK.
    if (workFlowJson.parentWorkflowId) {
      await this.notifyParentOfSubWorkflowCompletion(workFlowJson, 'COMPLETED')
    }

    return { status: 200, message: 'Workflow completed successfully.' }
  }

  async updateDoWhileTaskStatus(workFlowJson: any): Promise<any> {
    async function findAndUpdateDoWhile(tasks: any[]): Promise<void> {
      for (const task of tasks) {
        if (task.type === 'DO_WHILE' && task.do_while_ref?.iterationData) {
          const allDoWhileTasksCompleted = task.do_while_ref.iterationData.every(
            (subTask: any) =>
              subTask.status === 'COMPLETED' ||
              subTask.status === 'SKIPPED' ||
              subTask.status === 'FAILED'
          )
          if (allDoWhileTasksCompleted) {
            task.status = 'COMPLETED'
          }
        }
      }
    }
    await findAndUpdateDoWhile(workFlowJson.tasks)
    for (const task of workFlowJson.tasks) {
      if (task.type === 'SWITCH' && task.resolveExpressionValue) {
        const caseTasks = task.decisionCases?.[task.resolveExpressionValue] || []
        await findAndUpdateDoWhile(caseTasks)

        const allCaseTasksCompleted = caseTasks.every(
          (caseTask: any) =>
            caseTask.status === 'COMPLETED' ||
            caseTask.status === 'SKIPPED' ||
            caseTask.status === 'FAILED'
        )

        if (allCaseTasksCompleted) {
          task.status = 'COMPLETED'
        }
      }
    }
    return workFlowJson
  }

  async updateSwitchTaskStatus(workFlowJson: any): Promise<void> {
    for (const task of workFlowJson.tasks) {
      if (task.type === 'SWITCH' && task.resolveExpressionValue && task.decisionCases) {
        const caseTasks = task.decisionCases[task.resolveExpressionValue] || task.defaultCase || []
        // // Ensure nested DO_WHILE tasks are updated first
        // for (const subTask of caseTasks) {
        //   if (subTask.type === 'DO_WHILE' && subTask.do_while_ref?.iterationData) {
        //     const allDoWhileTasksCompleted = subTask.do_while_ref.iterationData.every(
        //       (loopTask: any) => loopTask.status === 'COMPLETED'
        //     );
        //     if (allDoWhileTasksCompleted) {
        //       subTask.status = 'COMPLETED';
        //     }
        //   }
        // }
        const allSwitchTasksCompleted = caseTasks.every(
          (subTask: any) =>
            subTask.status === 'COMPLETED' || task.status === 'SKIPPED' || task.status === 'FAILED'
        )
        if (allSwitchTasksCompleted) {
          task.status = 'COMPLETED'
        }
      }
    }
    return workFlowJson
  }

  // Function to pause ,resume, terminate workflow
  async updateWorkflowStatus({ params, request, response }: HttpContext, successMessage: string) {
    // const trx = await db.transaction()
    try {
      const workflowId = params.workflowId
      if (!workflowId) {
        return response.status(400).json({ message: 'workflowId is required.' })
      }
      const { status } = await request.validateUsing(workflowStatusValidator)
      const workflow = await Workflow.findOrFail(workflowId)
      // workflow.useTransaction(trx)
      const existingWorkflowJsonData =
        typeof workflow.json_data === 'string' ? JSON.parse(workflow.json_data) : workflow.json_data

      existingWorkflowJsonData.status = status
      if (status === 'TERMINATED' && Array.isArray(existingWorkflowJsonData.tasks)) {
        existingWorkflowJsonData.tasks = existingWorkflowJsonData.tasks.map((task: any) => {
          if (!task.hasOwnProperty('status')) {
            task.status = 'CANCELED'
          }
          if (task.status !== 'COMPLETED') {
            task.status = 'CANCELED'
          }
          return task
        })
      }
      workflow.json_data = JSON.stringify(existingWorkflowJsonData) as unknown as JSON
      workflow.status = status
      await workflow.save()
      // await trx.commit()
      return response.status(200).json({
        message: successMessage,
        data: workflowId,
      })
    } catch (error: any) {
      // await trx.rollback()
      return response.status(error.status || 500).json({
        message: 'Error updating workflow status',
        error: error.message,
      })
    }
  }

  async terminateWorkflow(ctx: HttpContext) {
    return this.updateWorkflowStatus(ctx, 'Workflow terminated successfully')
  }

  async pauseWorkflow(ctx: HttpContext) {
    return this.updateWorkflowStatus(ctx, 'Workflow paused successfully')
  }

  async resumeWorkflow(ctx: HttpContext) {
    return this.updateWorkflowStatus(ctx, 'Workflow resumed successfully')
  }

  // Skip a task execution from current running workflow by taskReferenceName.
  async skipTaskExecution({ params, response }: HttpContext) {
    // const trx = await db.transaction()
    try {
      const { workflowId, taskReferenceName } = params
      if (!workflowId) {
        return response.status(400).json({ message: 'workflowId is required.' })
      }
      if (!taskReferenceName) {
        return response.status(400).json({ message: 'taskReferenceName is required.' })
      }
      const workflowDetails = await Workflow.findOrFail(workflowId)
      // workflowDetails.useTransaction(trx)
      const workflowJson = JSON.parse(workflowDetails.json_data as unknown as string)
      if (workflowJson.status !== 'RUNNING') {
        return response.status(400).json({ message: 'Workflow is not in running state.' })
      }
      const task = workflowJson.tasks.find((t: any) => t.taskReferenceName === taskReferenceName)
      if (!task) {
        return response.status(404).json({ message: 'Task not found in the workflow.' })
      }
      if (
        task.status === 'COMPLETED' ||
        task.status === 'SKIPPED' ||
        task.status === 'SCHEDULED' ||
        task.status === 'RUNNING'
      ) {
        return response
          .status(400)
          .json({ message: 'Task is already completed, skipped, or in progress.' })
      }
      task.status = 'SKIPPED'
      workflowDetails.json_data = JSON.stringify(workflowJson) as unknown as JSON
      await workflowDetails.save()
      // await trx.commit()
      const currentTime = Math.floor(Date.now() / 1000)
      await this.processNextTask(workflowId, currentTime)
      return response.status(200).json({
        message: 'Task execution skipped successfully.',
        workflow: workflowJson,
      })
    } catch (error: any) {
      // await trx.rollback()
      return response.status(500).json({
        message: 'Failed to skip task execution.',
        error: error.message,
      })
    }
  }

  // This will set the global variables.
  async setWorkflowGlobalVariables({ params, request, response }: HttpContext) {
    try {
      const workflowId = params.workflowId
      if (!workflowId) {
        return response.status(400).json({ message: 'workflowId is required.' })
      }
      let workFlowDetails
      try {
        workFlowDetails = await Workflow.findOrFail(workflowId)
      } catch (err) {
        return response.status(404).json({ message: 'Workflow not found.' })
      }
      const wfDetails = JSON.parse(workFlowDetails.json_data as unknown as string)

      const requestBody = request.body()
      if (!requestBody || Object.keys(requestBody).length === 0) {
        return response.status(400).json({ message: 'Object and key values are required' })
      }

      if (!wfDetails.variables || typeof wfDetails.variables !== 'object') {
        wfDetails.variables = {}
      }

      Extras.mergeVariableData(wfDetails.variables, requestBody)

      workFlowDetails.json_data = JSON.stringify(wfDetails) as unknown as JSON
      await workFlowDetails.save()
      return response.status(200).json({
        message: 'Workflow variables updated successfully.',
        variables: wfDetails.variables,
      })
    } catch (error: any) {
      return response.status(500).json({
        message: 'Failed to set variables.',
        error: error.message,
      })
    }
  }
}
