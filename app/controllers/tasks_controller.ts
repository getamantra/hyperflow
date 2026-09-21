import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import Task from '#models/task'

@inject()
export default class TasksController {
  // Fetch task by taskId
  async getTaskById({ params, response }: HttpContext) {
    try {
      const taskId = params.taskId
      if (!taskId) {
        return response.status(400).json({ message: 'taskId is required.' })
      }
      const taskDetails = await Task.findOrFail(taskId)
      const task = JSON.parse(taskDetails.json_data as unknown as string)
      if (task) {
        return response.status(200).json({ task })
      } else {
        return response.status(404).json({ message: 'Task not found.' })
      }
    } catch (error: any) {
      return response.status(500).json({
        message: 'Failed to retrieve task.',
        error: error.message,
      })
    }
  }

  // Fetch input/output variables of every activity task executed before the given task,
  // including tasks that ran inside Switch/Loop constructs at any nesting depth.
  async getPreviousActivityVariables({ params, request, response }: HttpContext) {
    try {
      const taskId = params.taskId
      if (!taskId) {
        return response.status(400).json({ message: 'taskId is required.' })
      }

      const { workflowId } = request.qs()
      if (!workflowId) {
        return response.status(400).json({ message: 'workflowId is required.' })
      }

      const currentTask = await Task.query()
        .where('task_id', taskId)
        .where('workflow_id', workflowId)
        .first()
      if (!currentTask) {
        return response.status(404).json({ message: 'Task not found for the given workflowId.' })
      }

      const ACTIVITY_TYPES = ['SIMPLE', 'AGENT', 'WAIT']
      const TERMINAL_STATUSES = ['COMPLETED', 'FAILED', 'SKIPPED', 'CANCELED', 'TERMINATED']

      const rows = await Task.query()
        .select('task_id', 'json_data', 'created_on')
        .where('workflow_id', currentTask.workflow_id)
        .where('created_on', '<', currentTask.created_on.toSQL()!)
        .whereRaw('JSON_VALID(json_data)')
        .whereRaw('JSON_UNQUOTE(JSON_EXTRACT(json_data, "$.type")) in (?, ?, ?)', ACTIVITY_TYPES)
        .whereRaw(
          'JSON_UNQUOTE(JSON_EXTRACT(json_data, "$.status")) in (?, ?, ?, ?, ?)',
          TERMINAL_STATUSES
        )
        .orderBy('created_on', 'asc')

      // Dedupe by taskReferenceName, keeping the latest occurrence (handles GOTO reruns).
      const latestByRef = new Map<string, { task_id: string; created_on: any; parsed: any }>()
      for (const row of rows) {
        let parsed: any = {}
        try {
          parsed =
            typeof row.json_data === 'string' ? JSON.parse(row.json_data) : (row.json_data ?? {})
        } catch {
          continue
        }
        const ref = parsed.taskReferenceName ?? row.task_id
        latestByRef.set(ref, { task_id: row.task_id, created_on: row.created_on, parsed })
      }

      const tasks = Array.from(latestByRef.values())
        .sort((a, b) => b.created_on - a.created_on)
        .map(({ task_id, parsed }) => ({
          taskId: task_id,
          taskReferenceName: parsed.taskReferenceName ?? null,
          name: parsed.name ?? null,
          type: parsed.type ?? parsed.taskType ?? null,
          status: parsed.status ?? null,
          inputParameters: parsed.inputParameters ?? {},
          outputParameters: parsed.outputParameters ?? {},
        }))

      return response.status(200).json({
        message: 'Previous activities input and output parameters',
        workflowId: currentTask.workflow_id,
        currentTaskId: currentTask.task_id,
        tasks,
      })
    } catch (error: any) {
      return response.status(500).json({
        message: 'Failed to retrieve previous activities parameters.',
        error: error.message,
      })
    }
  }
}
