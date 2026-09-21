import { Extras } from '#services/extra_service'
import Task from '#models/task'
class WorkflowVariableResolverService {
  // resolveObject() replaces "${...}" templates in inputParameters with their resolved literal
  // values IN PLACE, permanently destroying the template text. Any task that may be reset and
  // re-executed later (GOTO jump-back) needs its original, unresolved inputParameters preserved
  // so it can be re-resolved against the (possibly since-updated) workflow variables. This snapshot
  // is captured once per task, on first resolution, and deep-cloned (not shallow-spread) so that
  // resolveObject's in-place mutation of nested objects can never leak into the stored template.
  snapshotInputParametersTemplate(task: Record<string, any>) {
    if (!task._inputParametersTemplate) {
      task._inputParametersTemplate = JSON.parse(JSON.stringify(task.inputParameters || {}))
    }
  }

  async resolveInputParametersForTask(
    task: Record<string, any>,
    workflowJson: any,
    loopContext?: { iteration?: number; iterationData?: any[] }
  ): Promise<Record<string, any>> {
    const inputParameters = task.inputParameters
    const isDataMapperMapOneValue =
      task.activityCode === 'DATA_MAPPER' &&
      inputParameters?.mapping_type === 'map_one_value' &&
      typeof inputParameters?.mapping === 'string'

    if (!isDataMapperMapOneValue) {
      return this.resolveObject(inputParameters, workflowJson, loopContext)
    }

    let mappingArray: any[]
    try {
      mappingArray = JSON.parse(inputParameters.mapping)
      if (!Array.isArray(mappingArray)) throw new Error('mapping is not an array')
    } catch {
      // Not a parseable mapping array — fall back to the normal resolution path untouched.
      return this.resolveObject(inputParameters, workflowJson, loopContext)
    }

    const placeholderToOriginalKey = new Map<string, string>()
    const protectedMappingArray = mappingArray.map((item, index) => {
      if (item && typeof item.key === 'string') {
        const placeholder = `__DATA_MAPPER_KEY_PLACEHOLDER_${index}__`
        placeholderToOriginalKey.set(placeholder, item.key)
        return { ...item, key: placeholder }
      }
      return item
    })

    const protectedInputParameters = {
      ...inputParameters,
      mapping: JSON.stringify(protectedMappingArray),
    }

    const resolved = await this.resolveObject(protectedInputParameters, workflowJson, loopContext)

    try {
      const resolvedMappingArray = JSON.parse(resolved.mapping)
      const restoredMappingArray = resolvedMappingArray.map((item: any) => {
        if (item && typeof item.key === 'string' && placeholderToOriginalKey.has(item.key)) {
          return { ...item, key: placeholderToOriginalKey.get(item.key) }
        }
        return item
      })
      resolved.mapping = JSON.stringify(restoredMappingArray)
    } catch {}

    return resolved
  }

  // THIS WILL RETURN THE RESOLVE VALUE OF THE VARIABLE.
  async getResolvedValue(variableRef: string, workflowJson: any): Promise<any> {
    const parametersParts = variableRef.split('.')
    console.log('*****variableRef', variableRef)
    if (parametersParts.length < 2) {
      return null
    }
    const firstValue = parametersParts[0]
    const taskwfVariable = parametersParts[1]
    const variableToBeResolved = parametersParts[2]
    const triggerNameWithIndex = parametersParts[3]
    const valueKey = parametersParts.slice(4).join('.')

    if (firstValue === 'workflow' && taskwfVariable === 'variables') {
      if (variableToBeResolved in workflowJson.variables) {
        return workflowJson.variables[variableToBeResolved]
      }
    }

    const task = findTask(workflowJson, firstValue)
    if (!task) {
      return null
    }

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
      if (result !== null) return result

      // Check in loopOver
      // if (Array.isArray(task.loopOver)) {
      //   for (const loopTask of task.loopOver) {
      //     const res = this.resolveTriggerVariable(
      //       loopTask,
      //       variableToBeResolved,
      //       triggerNameWithIndex,
      //       valueKey
      //     )
      //     if (res !== null) return res
      //   }
      // }
    }

    // THIS FUNCTION FIND THE TASK IN WORKFLOW RECURSIVELY.
    function findTask(workflowJson: any, taskReferenceName: string): any | null {
      function searchTasks(tasks: any[]): any | null {
        for (const task of tasks) {
          if (task.taskReferenceName === taskReferenceName) {
            return task
          }

          // SEARCH IN LOOPOVER
          if (task.do_while_ref?.iterationData && task.do_while_ref?.iterationData.length) {
            const foundInLoop = searchTasks(task.do_while_ref?.iterationData)
            if (foundInLoop) return foundInLoop
          }

          // SEARCH IN DECISIONCASES
          if (task.decisionCases) {
            for (const key in task.decisionCases) {
              if (task.decisionCases[key].length) {
                const foundInDecision = searchTasks(task.decisionCases[key])
                if (foundInDecision) return foundInDecision
              }
            }
          }

          // SEARCH IN DEFAULTCASE
          if (task.defaultCase && task.defaultCase.length) {
            const foundInDefault = searchTasks(task.defaultCase)
            if (foundInDefault) return foundInDefault
          }

          // SEARCH IN FORKTASKS BRANCHES
          if (Array.isArray(task.forkTasks)) {
            for (const branch of task.forkTasks) {
              if (Array.isArray(branch) && branch.length) {
                const foundInBranch = searchTasks(branch)
                if (foundInBranch) return foundInBranch
              }
            }
          }
        }
        return null
      }
      return searchTasks(workflowJson.tasks)
    }

    // ----- INPUT VARIABLE HANDLING -----
    if (taskwfVariable === 'input') {
      const inputPath = parametersParts.slice(2).join('.')
      const resolvedInput = this.resolveDeepPath(task.inputParameters, inputPath)
      if (resolvedInput !== null) {
        return resolvedInput
      }

      // Check in loopOver
      // if (Array.isArray(task.loopOver)) {
      //   for (const loopTask of task.loopOver) {
      //     if (loopTask.inputParameters && variableToBeResolved in loopTask.inputParameters) {
      //       return loopTask.inputParameters[variableToBeResolved]
      //     }
      //   }
      // }
    }

    // ----- OUTPUT VARIABLE HANDLING -----
    if (taskwfVariable === 'output') {
      const outputPath = parametersParts.slice(2).join('.')
      const resolvedOutput = this.resolveDeepPath(task.outputParameters, outputPath)
      if (resolvedOutput !== null) {
        return resolvedOutput
      }

      // Check in loopOver
      // if (Array.isArray(task.loopOver)) {
      //   for (const loopTask of task.loopOver) {
      //     if (loopTask.outputParameters && variableToBeResolved in loopTask.outputParameters) {
      //       return loopTask.outputParameters[variableToBeResolved]
      //     }
      //   }
      // }
    }

    return null
  }

  // FIND A TASK BY taskReferenceName ANYWHERE IN THE WORKFLOW TREE, INCLUDING
  // NESTED INSIDE do_while_ref.iterationData / decisionCases / defaultCase /
  // forkTasks BRANCHES. USED BY THE JOIN BARRIER TO CHECK BRANCH COMPLETION.
  findTaskByRef(tasks: any[], taskReferenceName: string): any | null {
    for (const task of tasks) {
      if (task.taskReferenceName === taskReferenceName) {
        return task
      }
      if (task.do_while_ref?.iterationData?.length) {
        const foundInLoop = this.findTaskByRef(task.do_while_ref.iterationData, taskReferenceName)
        if (foundInLoop) return foundInLoop
      }
      if (task.decisionCases) {
        for (const key in task.decisionCases) {
          if (task.decisionCases[key]?.length) {
            const foundInDecision = this.findTaskByRef(task.decisionCases[key], taskReferenceName)
            if (foundInDecision) return foundInDecision
          }
        }
      }
      if (task.defaultCase?.length) {
        const foundInDefault = this.findTaskByRef(task.defaultCase, taskReferenceName)
        if (foundInDefault) return foundInDefault
      }
      if (Array.isArray(task.forkTasks)) {
        for (const branch of task.forkTasks) {
          if (Array.isArray(branch) && branch.length) {
            const foundInBranch = this.findTaskByRef(branch, taskReferenceName)
            if (foundInBranch) return foundInBranch
          }
        }
      }
    }
    return null
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

  // THIS FUNCTION IS USED TO RESOLVE TRIGGER VARIABLES.
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

    console.log('*****baseObject for trigger variable resolution:', baseObject)

    if (baseObject) {
      const { objectKey, index } = this.extractArrayIndex(triggerKey)
      let targetObject = baseObject[objectKey]
      if (Array.isArray(targetObject) && index !== null) {
        targetObject = targetObject[index]
      }
      if (targetObject) {
        console.log('*****targetObject for trigger variable resolution:', targetObject)
        return this.resolveNestedValue(targetObject, valueKey)
      }
    }
    return null
  }

  resolveNestedValue(obj: any, keyPath: string): any {
    return keyPath
      .split('.')
      .reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : null), obj)
  }

  extractArrayIndex(key: string): { objectKey: string; index: number | null } {
    const match = key.match(/(\w+)\[(\d+)\]/)
    if (match) {
      return { objectKey: match[1], index: parseInt(match[2], 10) }
    }
    return { objectKey: key, index: null }
  }

  // Newer V5
  // THIS FUNCTION RETURN THE RESOLVE VALUE OF TASK INPUTPARAMETERS.
  async resolveObject(
    obj: Record<string, any>,
    workflowJson: any,
    context?: {
      iteration?: number
      iterationData?: any[]
    }
  ): Promise<Record<string, any>> {
    const variablePattern = /\$\{([^}]+)\}/g
    const isLoopScoped = (taskRef: string): boolean => {
      if (!context?.iteration || !context?.iterationData) return false
      return context.iterationData.some(
        (t) => t.taskReferenceName === `${taskRef}_${context.iteration}`
      )
    }
    for (const key in obj) {
      const value = obj[key]
      if (typeof value === 'string') {
        let newValue = value
        const matches = Array.from(newValue.matchAll(variablePattern))

        if (matches.length) {
          for (let i = matches.length - 1; i >= 0; i--) {
            const match = matches[i]
            const variableRef = match[1]
            const firstPart = variableRef.split('.')[0]

            let finalVariableRef = variableRef
            if (isLoopScoped(firstPart)) {
              finalVariableRef = variableRef.replace(
                firstPart,
                `${firstPart}_${context!.iteration}`
              )
            }

            const resolvedValue = await this.getResolvedValue(finalVariableRef, workflowJson)
            if (resolvedValue === null || resolvedValue === undefined) continue
            // SAFE ARRAY OVERRIDE ONLY IF THE ENTIRE VALUE IS A SINGLE VARIABLE
            if (Array.isArray(resolvedValue) && matches.length === 1 && newValue === match[0]) {
              obj[key] = resolvedValue.map((item) =>
                typeof item === 'object' ? item : item.toString()
              )
              break
            }
            const replacement =
              typeof resolvedValue === 'object'
                ? JSON.stringify(resolvedValue)
                : resolvedValue.toString()

            newValue =
              newValue.slice(0, match.index!) +
              replacement +
              newValue.slice(match.index! + match[0].length)
          }
        }
        // ASSIGN STRING ONLY IF ARRAY OVERRIDE DIDN'T HAPPEN
        if (typeof obj[key] === 'string') {
          obj[key] = newValue
        }
      } else if (typeof value === 'object' && value !== null) {
        obj[key] = await this.resolveObject(value, workflowJson, context)
      }
    }
    return obj
  }

  // OLDER V4 resolveObject with Deep Array Recursion (not used yet may useful)
  // async resolveObject(
  //   obj: any,
  //   workflowJson: any,
  //   context?: {
  //     iteration?: number
  //     iterationData?: any[]
  //   }
  // ): Promise<any> {
  //   const variablePattern = /\$\{([^}]+)\}/g

  //   const isLoopScoped = (taskRef: string): boolean => {
  //     if (!context?.iteration || !context?.iterationData) return false
  //     return context.iterationData.some(
  //       (t) => t.taskReferenceName === `${taskRef}_${context.iteration}`
  //     )
  //   }

  //   if (Array.isArray(obj)) {
  //     return Promise.all(obj.map((item) => this.resolveObject(item, workflowJson, context)))
  //   }

  //   if (typeof obj === 'object' && obj !== null) {
  //     const resolvedObj: Record<string, any> = {}
  //     for (const key in obj) {
  //       const value = obj[key]

  //       if (typeof value === 'string') {
  //         let newValue = value
  //         const matches = Array.from(newValue.matchAll(variablePattern))

  //         if (matches.length) {
  //           for (let i = matches.length - 1; i >= 0; i--) {
  //             const match = matches[i]
  //             const variableRef = match[1]
  //             const firstPart = variableRef.split('.')[0]

  //             let finalVariableRef = variableRef
  //             if (isLoopScoped(firstPart)) {
  //               finalVariableRef = variableRef.replace(
  //                 firstPart,
  //                 `${firstPart}_${context!.iteration}`
  //               )
  //             }

  //             const resolvedValue = await this.getResolvedValue(finalVariableRef, workflowJson)
  //             if (resolvedValue === null || resolvedValue === undefined) continue

  //             // Safe array override only if the entire value is a single variable
  //             if (Array.isArray(resolvedValue) && matches.length === 1 && newValue === match[0]) {
  //               resolvedObj[key] = resolvedValue.map((item) =>
  //                 typeof item === 'object' ? item : item.toString()
  //               )
  //               break
  //             }
  //             const replacement =
  //               typeof resolvedValue === 'object'
  //                 ? JSON.stringify(resolvedValue)
  //                 : resolvedValue.toString()

  //             newValue =
  //               newValue.slice(0, match.index!) +
  //               replacement +
  //               newValue.slice(match.index! + match[0].length)
  //           }
  //         }
  //         // Assign string only if array override didn't happen
  //         if (!(key in resolvedObj)) {
  //           resolvedObj[key] = newValue
  //         }
  //       } else {
  //         // Recursively resolve nested object/array
  //         resolvedObj[key] = await this.resolveObject(value, workflowJson, context)
  //       }
  //     }
  //     return resolvedObj
  //   }
  //   return obj
  // }

  // OLDER V3 Fixes an issue where if any variable that needs to resolve is in array of object so entire array content gets replaces with the resolved value(fixed)
  // async resolveObject(
  //   obj: Record<string, any>,
  //   workflowJson: any,
  //   context?: {
  //     iteration?: number
  //     iterationData?: any[]
  //   }
  // ): Promise<Record<string, any>> {
  //   const variablePattern = /\$\{([^}]+)\}/g

  //   const isLoopScoped = (taskRef: string): boolean => {
  //     if (!context?.iteration || !context?.iterationData) return false
  //     return context.iterationData.some(
  //       (t) => t.taskReferenceName === `${taskRef}_${context.iteration}`
  //     )
  //   }
  //   for (const key in obj) {
  //     const value = obj[key]
  //     if (typeof value === 'string') {
  //       let newValue = value
  //       const matches = Array.from(newValue.matchAll(variablePattern))

  //       if (matches.length) {
  //         for (let i = matches.length - 1; i >= 0; i--) {
  //           const match = matches[i]
  //           const variableRef = match[1]
  //           const firstPart = variableRef.split('.')[0]

  //           let finalVariableRef = variableRef
  //           if (isLoopScoped(firstPart)) {
  //             finalVariableRef = variableRef.replace(
  //               firstPart,
  //               `${firstPart}_${context!.iteration}`
  //             )
  //           }
  //           const resolvedValue = await this.getResolvedValue(finalVariableRef, workflowJson)
  //           if (resolvedValue !== null && resolvedValue !== undefined) {
  //             const replacement =
  //               typeof resolvedValue === 'object'
  //                 ? JSON.stringify(resolvedValue)
  //                 : resolvedValue.toString()
  //             newValue =
  //               newValue.slice(0, match.index) +
  //               replacement +
  //               newValue.slice(match.index + match[0].length)
  //           }
  //         }
  //       }
  //       obj[key] = newValue
  //     } else if (typeof value === 'object' && value !== null) {
  //       obj[key] = await this.resolveObject(value, workflowJson, context)
  //     }
  //   }
  //   return obj
  // }

  // OLDER V2 (05-jan-2026 outside loop task issue fix)
  // async resolveObject(
  //   obj: Record<string, any>,
  //   workflowJson: any,
  //   context?: {
  //     iteration?: number
  //     iterationData?: any[]
  //   }
  // ): Promise<Record<string, any>> {
  //   const variablePattern = /\$\{([^}]+)\}/g

  //   const isLoopScoped = (taskRef: string): boolean => {
  //     if (!context?.iteration || !context?.iterationData) return false
  //     return context.iterationData.some(
  //       (t) => t.taskReferenceName === `${taskRef}_${context.iteration}`
  //     )
  //   }

  //   for (const key in obj) {
  //     if (typeof obj[key] === 'string') {
  //       let newValue = obj[key]
  //       const matches = Array.from(newValue.matchAll(variablePattern))

  //       for (const match of matches) {
  //         const variableRef = match[1]

  //         let finalVariableRef = variableRef
  //         const firstPart = variableRef.split('.')[0]

  //         // ONLY APPEND ITERATION IF TASK IS LOOP-SCOPED
  //         if (isLoopScoped(firstPart)) {
  //           finalVariableRef = variableRef.replace(firstPart, `${firstPart}_${context!.iteration}`)
  //         }

  //         const resolvedValue = await this.getResolvedValue(finalVariableRef, workflowJson)

  //         if (resolvedValue !== null && resolvedValue !== undefined) {
  //           if (Array.isArray(resolvedValue)) {
  //             obj[key] = resolvedValue.map((item) =>
  //               typeof item === 'object' ? item : item.toString()
  //             )
  //           } else if (typeof resolvedValue === 'object' && matches.length === 1) {
  //             obj[key] = resolvedValue
  //           } else {
  //             newValue = newValue.replace(match[0], resolvedValue.toString())
  //             console.log('----newValue', newValue)
  //           }
  //         }
  //       }

  //       if (typeof obj[key] !== 'object') {
  //         obj[key] = /^\d+(\.\d+)?$/.test(newValue) ? Number(newValue) : newValue
  //       }
  //     }
  //   }
  //   return obj
  // }

  // OLDER V1 (issue in this outside loop task not resolve)
  // async resolveObject(obj: Record<string, any>, workflowJson: any): Promise<Record<string, any>> {
  //   const variablePattern = /\$\{([^}]+)\}/g
  //   for (const key in obj) {
  //     if (typeof obj[key] === 'string') {
  //       let newValue = obj[key]
  //       const matches = Array.from(newValue.matchAll(variablePattern))
  //       for (const match of matches) {
  //         const variableRef = match[1]
  //         const resolvedValue = await this.getResolvedValue(variableRef, workflowJson)
  //         console.log('--resolvedValue', resolvedValue)
  //         if (resolvedValue !== null) {
  //           if (Array.isArray(resolvedValue)) {
  //             obj[key] = resolvedValue.map((item) =>
  //               typeof item === 'object' ? item : item.toString()
  //             )
  //           } else if (typeof resolvedValue === 'object' && matches.length === 1) {
  //             obj[key] = resolvedValue
  //           } else {
  //             newValue = newValue.replace(match[0], resolvedValue.toString())
  //           }
  //         }
  //         // else {
  //         //   newValue = resolvedValue
  //         // }
  //         console.log('--newValue', newValue)
  //       }
  //       if (typeof obj[key] !== 'object') {
  //         obj[key] = /^\d+(\.\d+)?$/.test(newValue) ? Number(newValue) : newValue
  //       }
  //     }
  //   }
  //   return obj
  // }

  // EVALUATE SWITCH EXPRESSION AND RETURN THE RESOLVE EXPRESSION VALUE AS RESULT
  async evaluateSwitchExpression(
    task: Record<string, any>,
    workflowJson: any,
    loopContext?: { iteration?: number; iterationData?: any[] }
  ) {
    try {
      // Save original unresolved inputParameters once so jump-back resets can restore them.
      this.snapshotInputParametersTemplate(task)
      task.inputParameters = await this.resolveObject(
        task.inputParameters,
        workflowJson,
        loopContext
      )
      let functionBody = task.expression.trim()
      const context = { ...task.inputParameters, expression: task.expression || '' }
      const executeFunction = new Function(
        'context',
        `
        var $ = context;
        ${functionBody}
        return fun();
      `
      )
      const result = await executeFunction(context)
      console.log('Expression evaluation result:', result)

      if (typeof result === 'undefined') {
        return 'No case matched switch expression'
      }
      return result
    } catch (error) {
      console.log('Error evaluating expression:', error)
      return 'Switch marked as failed.'
    }
  }

  // EVALUATE LOOP CONDITION AND RETURN THE RESOLVE VALUE AS TRUE/FALSE
  async evaluateLoopCondition(
    task: Record<string, any>,
    workflowJson: any,
    loopContext?: { iteration?: number; iterationData?: any[] }
  ): Promise<{ result: boolean; error?: string }> {
    try {
      this.snapshotInputParametersTemplate(task)
      task.inputParameters = await this.resolveObject(
        task.inputParameters,
        workflowJson,
        loopContext
      )
      const rawLoopIteration = task.inputParameters?.loop_iteration
      const loopIteration = Number(rawLoopIteration)

      if (isNaN(loopIteration) || !Number.isFinite(loopIteration)) {
        const errMsg = `Invalid 'loop_iteration' value: "${rawLoopIteration}" is not a valid number`
        console.log('errMsg', errMsg)
        return { result: false, error: errMsg }
      }
      task.do_while_ref = task.do_while_ref || { iteration: 0 }
      const context = { ...task.inputParameters, do_while_ref: task.do_while_ref }
      const functionBody = task.loopCondition.trim()
      const executeFunction = new Function(
        'context',
        `
        var $ = context;
        return (function() { return ${functionBody}; })();
      `
      )
      const result = executeFunction(context)
      console.log('*****Evaluated Loop Condition:', result)
      return { result: Boolean(result) }
    } catch (error: any) {
      console.log('Error evaluating loop condition:', error)
      return { result: false, error: error.message }
    }
  }

  // HANDLE SIMPLE TASK
  async handleSimpleTask(task: Record<string, any>, workflowJson: any) {
    this.snapshotInputParametersTemplate(task)
    task.inputParameters = await this.resolveInputParametersForTask(task, workflowJson)
    return task
  }

  // HANDLE SUB_WORKFLOW TASK — RESOLVES INPUTPARAMETERS AND subWorkflowParam
  // (e.g. subWorkflowParam.name/version IF EITHER CONTAINS A ${...} REFERENCE).
  async handleSubWorkflowTask(task: Record<string, any>, workflowJson: any) {
    task.inputParameters = await this.resolveObject(task.inputParameters, workflowJson)
    if (task.subWorkflowParam) {
      task.subWorkflowParam = await this.resolveObject(task.subWorkflowParam, workflowJson)
    }
    return task
  }

  async handleSwitchTask(
    task: Record<string, any>,
    workflowJson: any
  ): Promise<Record<string, any>> {
    let expressionValue = ''

    if (task.expression?.includes('function fun()') && typeof task.expression === 'string') {
      expressionValue = await this.evaluateSwitchExpression(task, workflowJson)
    }
    task.resolveExpressionValue = expressionValue

    if ((!expressionValue || !task.decisionCases?.[expressionValue]) && expressionValue) {
      for (const [caseKey, branchTasks] of Object.entries(task.decisionCases || {})) {
        if (
          Array.isArray(branchTasks) &&
          branchTasks.some((t: any) => t.taskReferenceName === expressionValue)
        ) {
          task.resolveExpressionValue = caseKey
          expressionValue = caseKey
          break
        }
      }
    }

    // IF NO VALID EXPRESSIONVALUE OR DECISION CASES, RETURN TASK
    if (!expressionValue || !task.decisionCases?.[expressionValue]) {
      return task
    }

    if (task.type === 'SWITCH') {
      const matchedTasks = task.decisionCases[expressionValue]
      if (matchedTasks && Array.isArray(matchedTasks)) {
        for (let i = 0; i < matchedTasks.length; i++) {
          let nextTask = matchedTasks[i]

          if (nextTask.status === 'COMPLETED') {
            continue
          }
          console.log(`---Current switch task: ${nextTask.name}`)

          //             // IF THE NEXT TASK IS DO_WHILE, HANDLE IT SEPARATELY
          //             if (nextTask.type === "DO_WHILE") {
          //                 console.log('--- Handling DO_WHILE Task');
          //                task = await this.handleDoWhileTask(nextTask, workflowJson);
          //                return task;
          //             }

          // IF THE NEXT TASK IS ANOTHER SWITCH, HANDLE IT RECURSIVELY
          if (nextTask.type === 'SWITCH') {
            await this.handleSwitchTask(nextTask, workflowJson)
          }
        }
      }
    }

    return task
  }

  async handleDoWhileTask(
    task: Record<string, any>,
    workflowJson: any
  ): Promise<Record<string, any>> {
    try {
      const executionId = workflowJson.workflowId
      const doWhileIndex = workflowJson.tasks.findIndex(
        (t: any) => t.taskReferenceName === task.taskReferenceName
      )
      if (doWhileIndex > 0) {
        const prevTask = workflowJson.tasks[doWhileIndex - 1]
        if (prevTask && prevTask.status !== 'COMPLETED' && prevTask.status !== 'SKIPPED') {
          return task
        }
      }

      if (!task.loopOver || task.loopOver.length === 0) {
        throw new Error(`DO_WHILE task '${task.taskReferenceName}' must have loopOver tasks.`)
      }

      this.snapshotInputParametersTemplate(task)
      task.inputParameters = await this.resolveObject(task.inputParameters, workflowJson)
      const rawLoopIteration = task.inputParameters?.loop_iteration
      const loopIteration = Number(rawLoopIteration)
      console.log('---Resolved loop_iteration:', typeof rawLoopIteration, rawLoopIteration)
      if (isNaN(loopIteration) || !Number.isFinite(loopIteration)) {
        throw new Error(`Invalid loop_iteration value: "${rawLoopIteration}" is not a valid number`)
      }

      let {
        iteration = 1,
        lastTaskIndex = 0,
        loopResults = {},
        iterationData = [],
        switchTaskIndex = 0,
      } = task.do_while_ref || {
        iteration: 1,
        lastTaskIndex: 0,
        loopResults: {},
        iterationData: [],
        switchTaskIndex: 0,
      }

      while (true) {
        const { result: continueLoop, error: loopErrorMessage } = await this.evaluateLoopCondition(
          task,
          workflowJson,
          { iteration, iterationData }
        )
        if (!continueLoop) {
          return {
            ...task,
            loopError: {
              message: loopErrorMessage || `Loop condition failed at iteration ${iteration}.`,
            },
            do_while_ref: {
              iteration,
              lastTaskIndex,
              loopResults,
              iterationData,
              switchTaskIndex,
            },
          }
        }

        // FIRST TIME ONLY INSERT
        if (!task.taskId && iteration === 1 && task.inputParameters.params === 1) {
          const taskJson = { ...task }
          const taskId = Extras.generateKey(32)
          const currentTime = Math.floor(Date.now() / 1000)
          taskJson.taskType = taskJson.type
          taskJson.status = 'SCHEDULED'
          taskJson.workflowInstanceId = executionId
          taskJson.taskId = taskId
          task.taskId = taskId // important
          taskJson.scheduledTime = currentTime
          taskJson.startTime = currentTime
          taskJson.workFlowType = workflowJson.name
          taskJson.taskDefName = taskJson.name
          taskJson.referenceTaskName = taskJson.taskReferenceName
          taskJson.workflowDescription = workflowJson.description
          const loopTaskData = new Task()
          loopTaskData.task_id = taskId
          loopTaskData.workflow_id = executionId
          loopTaskData.json_data = JSON.stringify(taskJson) as unknown as JSON
          await loopTaskData.save()
          console.log('***FIRST LOOP TASK INSERTED')
        }

        if (lastTaskIndex >= task.loopOver.length) {
          iteration++
          lastTaskIndex = 0
          switchTaskIndex = 0
          // iterationData = [];
          task.inputParameters.params = iteration
          const taskId = task.taskId
          const existingLoopTask = await Task.find(taskId)
          if (existingLoopTask && iteration <= loopIteration) {
            const parsed = JSON.parse(existingLoopTask.json_data as unknown as string)
            parsed.inputParameters = task.inputParameters
            existingLoopTask.json_data = JSON.stringify(parsed) as unknown as JSON
            await existingLoopTask.save()
            console.log('***LOOP TASK ITERATION UPDATED :', iteration)
          }
        }

        if (iteration > loopIteration) {
          console.log(`Iteration ${iteration} exceeds loopIteration ${loopIteration}`)
          return task
        }

        const loopTask = structuredClone(task.loopOver[lastTaskIndex])
        // loopTask.taskReferenceName = `${loopTask.taskReferenceName}_${iteration}`
        // for (const key in loopTask.inputParameters) {
        //   const val = loopTask.inputParameters[key]
        //   if (typeof val === 'string') {
        //     loopTask.inputParameters[key] = val.replace(
        //       /\$\{([a-f0-9-]{36})(?:_\d+)?([^}]*)\}/g,
        //       (_m, uuid, rest) => `\${${uuid}_${iteration}${rest}}`
        //     )
        //   }
        // }

        if (loopTask.type !== 'SWITCH') {
          loopTask.taskReferenceName = `${loopTask.taskReferenceName}_${iteration}`
          // for (const key in loopTask.inputParameters) {
          //   const val = loopTask.inputParameters[key]
          //   if (typeof val === 'string') {
          //     loopTask.inputParameters[key] = val.replace(
          //       /\$\{([a-f0-9-]{36})(?:_\d+)?([^}]*)\}/g,
          //       (_m, uuid, rest) => `\${${uuid}_${iteration}${rest}}`
          //     )
          //   }
          // }
        }

        // loopTask.inputParameters = await this.resolveObject(loopTask.inputParameters, workflowJson)

        if (loopTask.type === 'SWITCH') {
          // ADDED ITERATION TO THE SWITCH_EXPRESSION TO RESOLVE VARIABLES CORRECTLY
          // loopTask.inputParameters.switch_expression =
          //   loopTask.inputParameters.switch_expression.replace(
          //     /(\$\{[a-f0-9-]+)(\.output)/i,
          //     `$1_${iteration}$2`
          //   )
          let expressionValue = await this.evaluateSwitchExpression(loopTask, workflowJson, {
            iteration,
            iterationData,
          })
          loopTask.resolveExpressionValue = expressionValue

          if ((!expressionValue || !loopTask.decisionCases?.[expressionValue]) && expressionValue) {
            for (const [caseKey, branchTasks] of Object.entries(loopTask.decisionCases || {})) {
              if (
                Array.isArray(branchTasks) &&
                branchTasks.some((t: any) => t.taskReferenceName === expressionValue)
              ) {
                loopTask.resolveExpressionValue = caseKey
                expressionValue = caseKey
                break
              }
            }
          }

          const selectedCaseTasks = loopTask.decisionCases[expressionValue] || loopTask.defaultCase

          if (!selectedCaseTasks || selectedCaseTasks.length === 0) {
            throw new Error(
              `No valid case found for SWITCH task '${loopTask.taskReferenceName}' with value '${expressionValue}'`
            )
          }

          if (switchTaskIndex < selectedCaseTasks.length) {
            const nextSwitchTask = { ...selectedCaseTasks[switchTaskIndex] }
            nextSwitchTask.taskReferenceName = `${nextSwitchTask.taskReferenceName}_${iteration}`
            nextSwitchTask.name = `${nextSwitchTask.name}_${iteration}`

            // HERE WE ARE ADDING THE CURRENT ITERATION VALUE TO RESOLVED VARIABLES
            // LIMITATION: VARIABLES FROM OUTSIDE THE LOOP ACTIVITY CANNOT BE RESOLVED HERE(NOW OVERCOME FROM THIS PROBLEM)
            // BECAUSE THE ITERATION VALUE IS ALSO APPENDED TO THEM, AND WE CANNOT DETERMINE WHETHER THE TASK IS INSIDE A LOOP OR NOT

            // const pattern = /\$\{([^}]+)\}/g
            // for (const key in nextSwitchTask.inputParameters) {
            //   const val = nextSwitchTask.inputParameters[key]

            //   if (typeof val === 'string') {
            //     nextSwitchTask.inputParameters[key] = val.replace(pattern, (match, inner) => {
            //       const parts = inner.split('.')
            //       const first = parts[0]
            //       if (/^[a-z0-9-]+$/i.test(first)) {
            //         parts[0] = `${first}_${iteration}`
            //         return `\${${parts.join('.')}}`
            //       }
            //       return match
            //     })
            //   }
            // }

            nextSwitchTask.inputParameters = await this.resolveInputParametersForTask(
              nextSwitchTask,
              workflowJson,
              {
                iteration,
                iterationData,
              }
            )

            iterationData.push(nextSwitchTask)
            task.do_while_ref = {
              iteration,
              lastTaskIndex,
              loopResults,
              iterationData,
              switchTaskIndex: switchTaskIndex + 1,
            }

            return task
          } else {
            lastTaskIndex++
            switchTaskIndex = 0
          }
        } else {
          // if (iteration <= loopIteration) {}
          // loopTask.taskReferenceName = `${loopTask.taskReferenceName}_${iteration}`
          loopTask.name = `${loopTask.name}_${iteration}`
          console.log(
            `Appending task ${loopTask.taskReferenceName} to iterationData (Iteration ${iteration})`
          )

          iterationData = Array.isArray(iterationData) ? iterationData : []
          iterationData.push(loopTask)

          let nextTask = iterationData.find((t: any) => !t.status)
          if (nextTask) {
            nextTask.inputParameters = await this.resolveInputParametersForTask(
              nextTask,
              workflowJson,
              {
                iteration,
                iterationData,
              }
            )

            const index = iterationData.findIndex(
              (t: any) => t.taskReferenceName === nextTask.taskReferenceName
            )
            if (index !== -1) {
              iterationData[index] = nextTask
            }
          } else {
            console.log(`No task without status found in iterationData for iteration ${iteration}`)
          }
          task.do_while_ref = {
            iteration,
            lastTaskIndex: lastTaskIndex + 1,
            loopResults,
            iterationData,
            switchTaskIndex,
          }

          return task
        }
      }
    } catch (error: any) {
      console.log(`Error in handleDoWhileTask: ${error.message}`)
      return {
        ...task,
        status: 'FAILED',
      }
    }
  }

  // ADD TASK TYPE IF NOT IN CASE
  async resolveTask(task: any, workflowJson: any) {
    switch (task.type) {
      case 'SIMPLE':
        return this.handleSimpleTask(task, workflowJson)
      case 'SWITCH':
        return this.handleSwitchTask(task, workflowJson)
      case 'DO_WHILE':
        return this.handleDoWhileTask(task, workflowJson)
      case 'END_WORKFLOW':
        return this.handleSimpleTask(task, workflowJson)
      case 'WAIT':
        return this.handleSimpleTask(task, workflowJson)
      case 'AGENT':
        return this.handleSimpleTask(task, workflowJson)
      case 'SUB_WORKFLOW':
        return this.handleSubWorkflowTask(task, workflowJson)
      default:
        return task
    }
  }

  async resolveVariables(workflowJson: any): Promise<any> {
    workflowJson.tasks = await Promise.all(
      workflowJson.tasks.map(async (task: any) => await this.resolveTask(task, workflowJson))
    )
    return workflowJson
  }
}

export default WorkflowVariableResolverService
