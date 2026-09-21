import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import Workflow from '#models/workflow'
import Task from '#models/task'
import TaskInProgress from '#models/task_in_progress'
import { updateTaskStatusValidator } from '#validators/workflow'
import WorkflowsController from './workflows_controller.js'
import HyperflowWaitJobs from '#models/hyperflow_wait_jobs'
import { DateTime } from 'luxon'
import { Extras } from '#services/extra_service'

@inject()
export default class UpdateTaskController {
  // ===== THIS WILL UPDATE THE TASK STATUS IN WORKFLOW AND PROCESS NEXT TASK FOR EXECUTION =====
  async updateTaskStatusAndProcessNextTask({ request, response }: HttpContext) {
    // const trx = await db.transaction()
    try {
      const data = await request.validateUsing(updateTaskStatusValidator)
      const {
        workflowId,
        taskReferenceName,
        taskStatus,
        taskId,
        outputData,
        inputParameters,
        taskType,
      } = data

      console.log('*****Incoming workflowId', workflowId)
      console.log('*****Incoming taskReferenceName', taskReferenceName)
      console.log('*****Incoming taskStatus', taskStatus)
      console.log('*****Incoming taskId', taskId)
      console.log('*****Incoming outputData', outputData)
      console.log('*****Incoming inputParameters', inputParameters)
      console.log('*****Incoming taskType', taskType)

      const task = await Task.findOrFail(taskId).catch((err) => {
        console.log('*****findOrFail error:', err.message)
        return null
      })
      if (!task) {
        console.log(`*****No task found with taskId: ${taskId}`)
        return { result: false, error: `No task found with taskId: ${taskId}` }
      }
      // task.useTransaction(trx)
      const taskInProgress = await TaskInProgress.findOrFail(taskId)
      // taskInProgress.useTransaction(trx)
      const existingJsonData =
        typeof task.json_data === 'string' ? JSON.parse(task.json_data) : task.json_data

      // ADDED TASK STATUS RUNNING AS PER REQUIREMENT
      if (taskStatus === 'RUNNING') {
        existingJsonData.status = 'RUNNING'
        const jsonAsString = JSON.stringify(existingJsonData)
        await db.from('task').where('task_id', taskId).update({ json_data: jsonAsString })
        return { message: `Task is in ${taskStatus} state` }
      }

      //  ===== RETRY TASK IF FAILED AND TASK CONTAIN RETRYCOUNT MORE THAN ONE =====
      let currentRetryAttempts = existingJsonData.currentRetryAttempts || 0
      const retryCount = existingJsonData.retryCount || 0
      const retryDelaySeconds = existingJsonData.retryDelaySeconds || 60
      const timezone = 'Asia/Kolkata'
      const totalMinutes = Math.floor(retryDelaySeconds / 60)
      const hours = 0
      const minutes = totalMinutes

      if (taskStatus === 'FAILED' && currentRetryAttempts <= retryCount) {
        currentRetryAttempts += 1
        existingJsonData.currentRetryAttempts = currentRetryAttempts
        const retryTime = DateTime.now()
          .setZone(timezone)
          .plus({ hours, minutes })
          .set({ second: 0, millisecond: 0 })
        const utcDateTime = retryTime.toUTC()
        task.json_data = JSON.stringify(existingJsonData) as unknown as JSON
        await task.save()

        const hyperflowTaskConfig = new HyperflowWaitJobs()
        hyperflowTaskConfig.execution_id = workflowId
        hyperflowTaskConfig.task_ref_name = taskReferenceName
        hyperflowTaskConfig.task_id = taskId
        hyperflowTaskConfig.scheduled_time = utcDateTime
        hyperflowTaskConfig.task_type = existingJsonData.taskType
        hyperflowTaskConfig.timezone = timezone
        hyperflowTaskConfig.is_executed = false
        hyperflowTaskConfig.json_data = JSON.stringify(existingJsonData) as unknown as JSON
        await hyperflowTaskConfig.save()
        // await trx.commit()

        return response.status(200).json({
          message: `Task Retry attempt ${currentRetryAttempts} of ${retryCount} for ${existingJsonData.name}`,
        })
      }

      if (taskStatus) {
        existingJsonData.status = taskStatus
      }
      if (outputData && typeof outputData === 'object') {
        existingJsonData.outputParameters = outputData
      }
      if (inputParameters) {
        existingJsonData.inputParameters = {
          ...existingJsonData.inputParameters,
          ...inputParameters,
        }
      }
      const currentTime = Math.floor(Date.now() / 1000)
      existingJsonData.endTime = currentTime
      task.json_data = JSON.stringify(existingJsonData) as unknown as JSON
      console.log('*****saving the task json with updated data*****')
      await task.save()
      if (taskStatus !== 'SCHEDULED') {
        await taskInProgress.delete()
      }
      const workFlowDetails = await Workflow.findOrFail(workflowId)
      // workFlowDetails.useTransaction(trx)
      const existingWorkflowJsonData =
        typeof workFlowDetails.json_data === 'string'
          ? JSON.parse(workFlowDetails.json_data)
          : workFlowDetails.json_data

      // AN ACTIVITY CAN CREATE/UPDATE RUNTIME GLOBAL VARIABLES BY RETURNING A `variables`
      // OBJECT IN ITS OUTPUT. MERGE IT INTO THE WORKFLOW'S GLOBAL VARIABLE BAG SO ANY OTHER
      // ACTIVITY CAN READ/UPDATE IT VIA ${workflow.variables.<key>}.
      if (
        outputData &&
        typeof outputData === 'object' &&
        outputData.variables &&
        typeof outputData.variables === 'object' &&
        !Array.isArray(outputData.variables)
      ) {
        if (
          !existingWorkflowJsonData.variables ||
          typeof existingWorkflowJsonData.variables !== 'object'
        ) {
          existingWorkflowJsonData.variables = {}
        }
        Extras.mergeVariableData(existingWorkflowJsonData.variables, outputData.variables)
      }

      if (taskType === 'END_WORKFLOW') {
        existingWorkflowJsonData.status = taskStatus
        workFlowDetails.status = taskStatus
        workFlowDetails.end_time = Math.floor(DateTime.now().toSeconds())
        workFlowDetails.json_data = JSON.stringify(existingWorkflowJsonData) as unknown as JSON
        await workFlowDetails.save()
        // await trx.commit()
        return { message: `Workflow marked as ${taskStatus}` }
      }

      let taskIndex = existingWorkflowJsonData.tasks.findIndex(
        (task: any) => task.taskReferenceName === taskReferenceName
      )

      if (taskIndex === -1) {
        for (let i = 0; i < existingWorkflowJsonData.tasks.length; i++) {
          const task = existingWorkflowJsonData.tasks[i]
          if (
            task.type === 'SWITCH' &&
            (await this.updateSwitchTask(
              task,
              taskReferenceName,
              taskStatus,
              outputData,
              inputParameters
            ))
          ) {
            taskIndex = i
            await this.updateDoWhileTasksAfterSwitch(
              existingWorkflowJsonData.tasks,
              i,
              taskReferenceName,
              taskStatus,
              outputData
            )
            break
          }

          if (
            task.type === 'DO_WHILE' &&
            (await this.updateDoWhileTask(task, taskReferenceName, taskStatus, outputData))
          ) {
            taskIndex = i
            await this.updateSwitchTasksAfterDoWhile(
              existingWorkflowJsonData.tasks,
              i,
              taskReferenceName,
              taskStatus,
              outputData
            )
            break
          }

          if (
            task.type === 'FORK_JOIN' &&
            (await this.updateForkJoinTask(
              task,
              taskReferenceName,
              taskStatus,
              outputData,
              inputParameters
            ))
          ) {
            taskIndex = i
            break
          }
        }
      }

      if (taskIndex === -1) {
        // await trx.rollback()
        return response.status(404).json({ message: 'Task not found.' })
      }

      if (
        !['SWITCH', 'DO_WHILE', 'FORK_JOIN'].includes(
          existingWorkflowJsonData.tasks[taskIndex].type
        )
      ) {
        existingWorkflowJsonData.tasks[taskIndex].status = taskStatus
        existingWorkflowJsonData.tasks[taskIndex].outputParameters = outputData
        if (inputParameters) {
          existingWorkflowJsonData.tasks[taskIndex].inputParameters = {
            ...existingWorkflowJsonData.tasks[taskIndex].inputParameters,
            ...inputParameters,
          }
        }
      }

      if (taskStatus === 'FAILED') {
        const isOptional = existingJsonData?.optional === true
        if (!isOptional) {
          existingWorkflowJsonData.status = taskStatus
          workFlowDetails.status = 'FAILED'
          workFlowDetails.end_time = Math.floor(DateTime.now().toSeconds())
          workFlowDetails.json_data = JSON.stringify(existingWorkflowJsonData) as unknown as JSON
          await workFlowDetails.save()
          // await trx.commit()

          // IF THIS WORKFLOW WAS RUNNING AS A SUB WORKFLOW, PROPAGATE THE FAILURE
          // BACK TO THE PARENT'S SUB_WORKFLOW TASK.
          if (existingWorkflowJsonData.parentWorkflowId) {
            const workflowsController = new WorkflowsController()
            await workflowsController.notifyParentOfSubWorkflowCompletion(
              existingWorkflowJsonData,
              'FAILED'
            )
          }

          return { status: 500, message: 'Workflow marked as failed' }
          // return response.status(500).json({ message: 'Workflow marked as failed' });
        }
        console.log('optional task failed but workflow continues.')
      }

      workFlowDetails.json_data = JSON.stringify(existingWorkflowJsonData) as unknown as JSON
      await workFlowDetails.save()
      // await trx.commit()
      if (taskStatus === 'SCHEDULED') {
        return { message: "Task is in 'SCHEDULED' state" }
      }
      const workflowsController = new WorkflowsController()
      const result = await workflowsController.processNextTask(workflowId, currentTime)
      // if ('failureReason' in result) {
      //   return response.status(500).json({ failureReason: result.failureReason })
      // }
      console.log('======result', result)
      if (result?.failureReason) {
        return response.status(500).json({
          failureReason: result.failureReason,
        })
      }
      return response
        .status(200)
        .json({ message: result.message || 'Workflow and task updated successfully.' })
    } catch (error: any) {
      // await trx.rollback()
      return response
        .status(500)
        .json({ message: 'Failed to update workflow task', error: error.message })
    }
  }

  async updateSwitchTasksAfterDoWhile(
    tasks: any[],
    index: number,
    taskReferenceName: string,
    taskStatus: string,
    outputData: any
  ) {
    for (let i = index + 1; i < tasks.length; i++) {
      const task = tasks[i]
      if (
        task.type === 'SWITCH' &&
        (await this.updateSwitchTask(task, taskReferenceName, taskStatus, outputData))
      ) {
        break
      }
    }
  }

  async updateDoWhileTasksAfterSwitch(
    tasks: any[],
    index: number,
    taskReferenceName: string,
    taskStatus: string,
    outputData: any
  ) {
    for (let i = index + 1; i < tasks.length; i++) {
      const task = tasks[i]
      if (
        task.type === 'DO_WHILE' &&
        (await this.updateDoWhileTask(task, taskReferenceName, taskStatus, outputData))
      ) {
        break
      }
    }
  }

  async updateSwitchTask(
    task: any,
    taskReferenceName: string,
    taskStatus: string,
    outputData: any,
    inputParameters?: any
  ): Promise<boolean> {
    if (!task.decisionCases) return false

    let found = false

    for (const caseKey in task.decisionCases) {
      const caseTasks = task.decisionCases[caseKey]

      for (const subTask of caseTasks) {
        if (subTask.taskReferenceName === taskReferenceName) {
          subTask.status = taskStatus
          subTask.outputParameters = outputData
          if (inputParameters) {
            subTask.inputParameters = {
              ...subTask.inputParameters,
              ...inputParameters,
            }
          }
          found = true
          continue
        }
        if (
          subTask.type === 'SWITCH' &&
          (await this.updateSwitchTask(
            subTask,
            taskReferenceName,
            taskStatus,
            outputData,
            inputParameters
          ))
        ) {
          found = true
          continue
        }
        if (
          subTask.type === 'DO_WHILE' &&
          (await this.updateDoWhileTask(subTask, taskReferenceName, taskStatus, outputData))
        ) {
          found = true
          continue
        }
      }
      const allSwitchTasksCompleted = caseTasks.every(
        (subTask: any) =>
          subTask.status === 'COMPLETED' ||
          subTask.status === 'SKIPPED' ||
          subTask.status === 'FAILED'
      )
      if (allSwitchTasksCompleted) {
        task.status = 'COMPLETED'
      }
    }
    return found
  }

  async updateForkJoinTask(
    task: any,
    taskReferenceName: string,
    taskStatus: string,
    outputData: any,
    inputParameters?: any
  ): Promise<boolean> {
    if (!Array.isArray(task.forkTasks)) return false

    let found = false

    for (const branch of task.forkTasks) {
      if (!Array.isArray(branch)) continue

      for (const subTask of branch) {
        if (subTask.taskReferenceName === taskReferenceName) {
          subTask.status = taskStatus
          subTask.outputParameters = outputData
          if (inputParameters) {
            subTask.inputParameters = {
              ...subTask.inputParameters,
              ...inputParameters,
            }
          }
          found = true
          continue
        }
        if (
          subTask.type === 'SWITCH' &&
          (await this.updateSwitchTask(
            subTask,
            taskReferenceName,
            taskStatus,
            outputData,
            inputParameters
          ))
        ) {
          found = true
          continue
        }
        if (
          subTask.type === 'DO_WHILE' &&
          (await this.updateDoWhileTask(subTask, taskReferenceName, taskStatus, outputData))
        ) {
          found = true
          continue
        }
        if (
          subTask.type === 'FORK_JOIN' &&
          (await this.updateForkJoinTask(
            subTask,
            taskReferenceName,
            taskStatus,
            outputData,
            inputParameters
          ))
        ) {
          found = true
          continue
        }
      }
    }
    return found
  }

  async updateDoWhileTask(
    task: any,
    taskReferenceName: string,
    taskStatus: string,
    outputData: any
  ): Promise<boolean> {
    let found = false

    if (task.do_while_ref?.iterationData) {
      for (const iterationTask of task.do_while_ref.iterationData) {
        if (iterationTask.taskReferenceName === taskReferenceName) {
          iterationTask.status = taskStatus
          iterationTask.outputParameters = outputData
          found = true
          break
        }
      }
    }

    if (task.loopOver && outputData) {
      const baseTaskReferenceName = taskReferenceName.replace(/_\d+$/, '')
      console.log('*****baseTaskReferenceName', baseTaskReferenceName)
      for (const loopTask of task.loopOver) {
        if (loopTask.taskReferenceName === baseTaskReferenceName) {
          loopTask.outputParameters = outputData
          found = true
          break
        }
      }
    }
    return found
  }
}
