import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import Workflow from '#models/workflow'
import db from '@adonisjs/lucid/services/db'

@inject()
export default class ResolveVariablesController {
  async getVariables({ params, request, response }: HttpContext) {
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
        return response.status(400).json({ message: 'Request body is required with variables.' })
      }

      const resolvedValues = await this.resolveVariables(requestBody, wfDetails, workflowId)
      return response.status(200).json(resolvedValues)
    } catch (error: any) {
      return response.status(500).json({
        message: 'Failed to retrieve variables.',
        error: error.message,
      })
    }
  }

  private buildTaskMapFromWorkflowJson(workflowJson: any): Record<string, any> {
    const taskMap: Record<string, any> = {}

    const addCaseTask = (task: any) => {
      if (!task?.taskReferenceName) return
      if (!taskMap[task.taskReferenceName]) {
        taskMap[task.taskReferenceName] = task
      }
      for (const cases of Object.values(task.decisionCases ?? {}) as any[][]) {
        for (const ct of cases) addCaseTask(ct)
      }
      for (const ct of task.defaultCase ?? []) addCaseTask(ct)
    }

    // Pass 1: main tasks are authoritative
    for (const task of workflowJson.tasks ?? []) {
      if (task?.taskReferenceName) taskMap[task.taskReferenceName] = task
    }

    // Pass 2: SWITCH case/default tasks — skip if already claimed by a main task
    for (const task of workflowJson.tasks ?? []) {
      for (const cases of Object.values(task.decisionCases ?? {}) as any[][]) {
        for (const ct of cases) addCaseTask(ct)
      }
      for (const ct of task.defaultCase ?? []) addCaseTask(ct)
    }

    // Pass 3: DO_WHILE iteration tasks — overwrite with latest iteration data.
    for (const task of Object.values(taskMap)) {
      for (const iterTask of (task as any).do_while_ref?.iterationData ?? []) {
        if (iterTask?.taskReferenceName) taskMap[iterTask.taskReferenceName] = iterTask
      }
    }

    return taskMap
  }

  // Preload task map from workflow JSON and loopover rows (single query)
  //   private async preloadTasksAndLoopovers(workflowId: any, taskRefs: string[]) {
  //     const taskMap: Record<string, any> = {}
  //     // If there are no taskRefs, return empty.
  //     if (taskRefs.length === 0) {
  //       // Still fetch loopover in case variables refer to loop tasks
  //       const fetchLoopData = await db
  //         .from('hyperflow_loopover_tasks')
  //         .select('loopover_json')
  //         .where('execution_id', workflowId)
  //         .first()

  //       let loopoverArray: any[] = []
  //       if (fetchLoopData && fetchLoopData.loopover_json) {
  //         try {
  //           loopoverArray = JSON.parse(fetchLoopData.loopover_json)
  //         } catch (e) {
  //           loopoverArray = []
  //         }
  //       }
  //       return { taskMap, loopoverArray }
  //     }

  //     // Note: MySQL returns strings quoted, so we use JSON_QUOTE to compare to the raw string.
  //     const placeholders = taskRefs.map(() => '?').join(',')
  //     const values = taskRefs

  //     // Query only tasks where taskReferenceName is one of our refs and workflowInstanceId = workflowId
  //     // This avoids scanning all tasks. Keep JSON_VALID guard.
  //     // const rawQuery = `
  //     //   SELECT json_data
  //     //   FROM task
  //     //   WHERE JSON_VALID(json_data) = 1
  //     //     AND JSON_EXTRACT(json_data, '$.taskReferenceName') IN (${placeholders})
  //     //     AND JSON_EXTRACT(json_data, '$.workflowInstanceId') = ?
  //     // `
  //     const rawQuery = `
  //   SELECT json_data
  //   FROM task
  //   WHERE JSON_VALID(json_data) = 1
  //     AND JSON_UNQUOTE(JSON_EXTRACT(json_data, '$.taskReferenceName')) IN (${placeholders})
  //     AND JSON_UNQUOTE(JSON_EXTRACT(json_data, '$.workflowInstanceId')) = ?
  // `
  //     // push workflowId as final param
  //     const params = [...values, workflowId]

  //     const taskRows: any[] = await db
  //       .rawQuery(rawQuery, params)
  //       .then((r: any) => {
  //         return Array.isArray(r) && r.length ? r[0] || r : []
  //       })
  //       // .catch(async () => {
  //       //   const fallbackRows = await db
  //       //     .from('task')
  //       //     .select('json_data')
  //       //     .whereRaw('JSON_VALID(json_data) = 1')
  //       //     .andWhereRaw("JSON_EXTRACT(json_data, '$.workflowInstanceId') = ?", [workflowId])
  //       //   return fallbackRows
  //       // })
  //       .catch(() => {
  //         return []
  //       })

  //     for (const row of taskRows) {
  //       if (!row || !row.json_data) continue
  //       try {
  //         // const parsed = JSON.parse(row.json_data)
  //         const parsed = typeof row.json_data === 'string' ? JSON.parse(row.json_data) : row.json_data
  //         if (parsed.taskReferenceName) {
  //           taskMap[parsed.taskReferenceName] = parsed
  //         }
  //       } catch (e) {
  //         // ignore invalid JSON rows
  //       }
  //     }

  //     // fetch loopover once
  //     const fetchLoopData = await db
  //       .from('hyperflow_loopover_tasks')
  //       .select('loopover_json')
  //       .where('execution_id', workflowId)
  //       .first()

  //     let loopoverArray: any[] = []
  //     if (fetchLoopData && fetchLoopData.loopover_json) {
  //       try {
  //         loopoverArray = JSON.parse(fetchLoopData.loopover_json)
  //       } catch (e) {
  //         loopoverArray = []
  //       }
  //     }

  //     return { taskMap, loopoverArray }
  //   }

  private async preloadTasksAndLoopovers(workflowId: any, workflowJson: any) {
    const taskMap = this.buildTaskMapFromWorkflowJson(workflowJson)

    const fetchLoopData = await db
      .from('hyperflow_loopover_tasks')
      .select('loopover_json')
      .where('execution_id', workflowId)
      .first()

    let loopoverArray: any[] = []
    if (fetchLoopData?.loopover_json) {
      try {
        loopoverArray =
          typeof fetchLoopData.loopover_json === 'string'
            ? JSON.parse(fetchLoopData.loopover_json)
            : fetchLoopData.loopover_json
      } catch {
        loopoverArray = []
      }
    }

    return { taskMap, loopoverArray }
  }

  async resolveVariables(
    obj: Record<string, any>,
    workflowJson: any,
    workflowId: any
  ): Promise<Record<string, any>> {
    try {
      const variablePattern = /\$\{([^}]+)\}/g
      const resolvedVariables: Record<string, any> = {}

      const { taskMap, loopoverArray } = await this.preloadTasksAndLoopovers(
        workflowId,
        workflowJson
      )

      const loopTaskMap: Record<string, any> = {}
      if (Array.isArray(loopoverArray)) {
        for (const t of loopoverArray) {
          if (t && t.taskReferenceName) {
            loopTaskMap[t.taskReferenceName] = t
          }
        }
      }

      for (const key in obj) {
        const val = obj[key]
        if (typeof val === 'string') {
          let newValue = val
          const matches = Array.from(newValue.matchAll(variablePattern))

          if (matches.length > 0) {
            // for (const match of matches) {
            //   const variableRef = match[1]
            //   const resolvedValue = await this.getResolvedValueFromMaps(
            //     variableRef,
            //     workflowJson,
            //     workflowId,
            //     taskMap,
            //     loopTaskMap
            //   )

            //   if (resolvedValue !== null && resolvedValue !== undefined) {
            //     if (Array.isArray(resolvedValue)) {
            //       resolvedVariables[match[0]] = resolvedValue.map((item) =>
            //         typeof item === 'object' ? item : item.toString()
            //       )
            //     } else if (typeof resolvedValue === 'object' && matches.length === 1) {
            //       resolvedVariables[match[0]] = resolvedValue
            //     } else {
            //       resolvedVariables[match[0]] =
            //         resolvedValue !== null ? resolvedValue.toString() : resolvedValue
            //     }
            //   } else {
            //     resolvedVariables[match[0]] = resolvedValue
            //   }
            // }

            const promises = matches.map(async (match) => {
              const variableRef = match[1]

              const resolvedValue = await this.getResolvedValueFromMaps(
                variableRef,
                workflowJson,
                workflowId,
                taskMap,
                loopTaskMap
              )

              let formattedValue

              if (resolvedValue !== null && resolvedValue !== undefined) {
                if (Array.isArray(resolvedValue)) {
                  formattedValue = resolvedValue.map((item) =>
                    typeof item === 'object' ? item : item.toString()
                  )
                } else if (typeof resolvedValue === 'object' && matches.length === 1) {
                  formattedValue = resolvedValue
                } else {
                  formattedValue = resolvedValue !== null ? resolvedValue.toString() : resolvedValue
                }
              } else {
                formattedValue = resolvedValue
              }

              return { key: match[0], value: formattedValue }
            })

            const results = await Promise.all(promises)

            for (const r of results) {
              resolvedVariables[r.key] = r.value
            }
          } else {
            resolvedVariables[key] = newValue
          }
        } else {
          resolvedVariables[key] = obj[key]
        }
      }
      console.log('*****final resolved variables*****', resolvedVariables)
      return resolvedVariables
    } catch (error) {
      console.log('Error in resolveVariables:', error)
      return {}
    }
  }

  async getResolvedValueFromMaps(
    variableRef: string,
    workflowJson: any,
    workflowId: any,
    taskMap: Record<string, any>,
    loopTaskMap: Record<string, any>
  ): Promise<any> {
    console.log('---workflowId', workflowId)
    try {
      const parametersParts = variableRef.split('.')
      if (parametersParts.length < 2) {
        return null
      }
      const firstValue = parametersParts[0]
      const taskwfVariable = parametersParts[1]
      const variableToBeResolved = parametersParts[2]
      const triggerNameWithIndex = parametersParts[3]
      const valueKey = parametersParts.slice(4).join('.')

      if (firstValue === 'workflow' && taskwfVariable === 'variables') {
        const varKey = variableToBeResolved
        if (workflowJson && workflowJson.variables && varKey in workflowJson.variables) {
          return workflowJson.variables[varKey]
        }
      }

      let task = taskMap[firstValue]

      // If not found, check loopTaskMap
      if (!task) {
        task = loopTaskMap[firstValue]
      }

      if (!task) return null

      // Trigger variables
      if (
        taskwfVariable === 'trigger' &&
        (variableToBeResolved === 'before' || variableToBeResolved === 'after')
      ) {
        const result = this.resolveTriggerVariable(
          task,
          variableToBeResolved,
          triggerNameWithIndex,
          valueKey
        )
        if (result !== null && result !== undefined) return result
      }

      // Input variables: deep path resolution
      if (taskwfVariable === 'input') {
        const inputPath = parametersParts.slice(2).join('.')
        const resolved = this.resolveDeepPath(task.inputParameters, inputPath)
        if (resolved !== null) return resolved
      }

      // Output variables: support deep path resolution
      if (taskwfVariable === 'output') {
        // const resolved = await this.resolveDeepValue(task.outputParameters, variableRef)
        const resolved = this.resolveDeepValue(task.outputParameters, variableRef)
        if (resolved !== undefined) return resolved
      }

      return null
    } catch (error) {
      return null
    }
  }

  // async resolveDeepValue(obj: any, variableRef: string): Promise<any> {
  resolveDeepValue(obj: any, variableRef: string): any {
    try {
      if (!obj) return undefined
      const outputPathMatch = variableRef.match(/\.output\.(.+)$/)
      if (!outputPathMatch) return undefined

      const path = outputPathMatch[1]
      const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.')

      let current = obj
      for (const part of parts) {
        if (typeof current === 'string') {
          try {
            current = JSON.parse(current)
          } catch {
            return undefined
          }
        }
        if (current == null || typeof current !== 'object') return undefined
        if (!(part in current)) return undefined
        current = current[part]
      }

      return current
    } catch (error) {
      console.log('Error in resolveDeepValue:', error)
      return undefined
    }
  }

  // RESOLVES A DOT PATH (e.g. "response.name" or "response.address.city")
  resolveDeepPath(source: any, path: string): any {
    if (source === null || source === undefined || !path) return null
    const segments = path.split('.').filter(Boolean)
    let current: any = source
    for (const segment of segments) {
      if (typeof current === 'string') {
        try {
          current = JSON.parse(current)
        } catch {
          return null
        }
      }
      if (current === null || current === undefined || typeof current !== 'object') return null
      if (!(segment in current)) return null
      current = current[segment]
    }
    return current === undefined ? null : current
  }

  // ARRAY / ARRAY-INDEX SUPPORT (NOT WIRED IN YET — KEPT HERE FOR LATER).
  // resolveDeepPathWithArrays(source: any, path: string): any {
  //   if (source === null || source === undefined || !path) return null
  //   const normalizedPath = path.replace(/\[(\d+)\]/g, '.$1')
  //   const segments = normalizedPath.split('.').filter(Boolean)
  //   let current: any = source
  //   for (const segment of segments) {
  //     if (typeof current === 'string') {
  //       try {
  //         current = JSON.parse(current)
  //       } catch {
  //         return null
  //       }
  //     }
  //     if (current === null || current === undefined || typeof current !== 'object') return null
  //     if (!(segment in current)) return null
  //     current = current[segment]
  //   }
  //   return current === undefined ? null : current
  // }

  resolveTriggerVariable(
    task: any,
    triggerType: 'before' | 'after',
    triggerKey: string,
    valueKey: string
  ): any {
    let baseObject

    if (triggerType === 'before' && task.outputParameters?.preexecutionresult?.trigger?.before) {
      baseObject = task.outputParameters.preexecutionresult.trigger.before
    } else if (
      triggerType === 'after' &&
      task.outputParameters?.postexecutionresult?.trigger?.after
    ) {
      baseObject = task.outputParameters.postexecutionresult.trigger.after
    }

    console.log('*****baseObject for trigger', baseObject)

    if (baseObject) {
      const { objectKey, index } = this.extractArrayIndex(triggerKey)
      let targetObject = baseObject[objectKey]
      if (Array.isArray(targetObject) && index !== null) {
        targetObject = targetObject[index]
      }
      if (targetObject) {
        console.log('*****targetObject for trigger', targetObject)
        return this.resolveNestedValue(targetObject, valueKey)
      }
    }
    return null
  }

  resolveNestedValue(obj: any, keyPath: string): any {
    const data = keyPath
      .split('.')
      .reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : null), obj)
    return data
  }

  extractArrayIndex(key: string): { objectKey: string; index: number | null } {
    const match = key.match(/(\w+)\[(\d+)\]/)
    if (match) {
      return { objectKey: match[1], index: parseInt(match[2], 10) }
    }
    return { objectKey: key, index: null }
  }
}
