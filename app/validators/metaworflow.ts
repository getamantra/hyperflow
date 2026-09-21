//import vine from '@vinejs/vine'
import vine from '@vinejs/vine'
// import { isEmptyStatement } from 'typescript'
export const metaWorkflowValidator = vine.withMetaData<{ version: string }>().compile(
  vine.object({
    name: vine.string().unique(async (db, value, field) => {
      const user = await db
        .from('meta_workflow_def')
        .where('name', value)
        .where('version', field.meta.version)
        .first()
      return !user
    }),
    ownerEmail: vine.string().email().normalizeEmail(),
    description: vine.string().optional(),
    version: vine.number(),
    timeoutPolicy: vine.string(),
    timeoutSeconds: vine.number().optional(),
    tasks: vine.array(
      vine.object({
        name: vine.string(),
        taskReferenceName: vine.string(),
        type: vine.string(),
        inputParameters: vine.any(),
        retryCount: vine.number().optional(),
        decisionCases: vine.any().optional(),
        defaultCase: vine.any().optional(),
        forkTasks: vine.any().optional(),
        startDelay: vine.number().optional(),
        joinOn: vine.any().optional(),
        subWorkflowParam: vine.any().optional(),
        optional: vine.boolean().optional(),
        defaultExclusiveJoinTask: vine.any().optional(),
        asyncComplete: vine.any().optional(),
        loopCondition: vine.any().optional(),
        loopOver: vine.any().optional(),
        expression: vine.string().optional(),
        evaluatorType: vine.string().optional(),
        retryDelaySeconds: vine.number().optional(),
        timeoutSeconds: vine.number().optional(),
        responseTimeoutSeconds: vine.number().optional(),
        pollTimeoutSeconds: vine.number().optional(),
        timeoutPolicy: vine.any().optional(),
        taskDuration: vine.number().optional(),
        timeUnit: vine.number().optional(),
        priority: vine.any().optional(),
        skipTask: vine.any().optional(),
        activityCode: vine.string(),
        activityIcon: vine.string(),
        workflowDescription: vine.string().optional(),
      })
    ),
    inputParameters: vine.any().optional(),
    outputParameters: vine.any().optional(),
    variables: vine.any().optional(),
    restartable: vine.boolean(),
    workflowStatusListenerEnabled: vine.boolean().optional(),
  })
)
