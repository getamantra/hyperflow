import vine from '@vinejs/vine'

// Validator for creating a task
export const createTaskValidator = vine.compile(
  vine.object({
    taskType: vine.string().maxLength(255),
    status: vine.enum(['SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'RUNNING']),
    inputData: vine.record(vine.string()),
    referenceTaskName: vine.string().optional(),
    retryCount: vine.number().min(0),
    taskDefName: vine.string().maxLength(255),
    scheduledTime: vine.number(),
    startTime: vine.number(),
    endTime: vine.number(),
    updateTime: vine.number(),
    workflowInstanceId: vine.string().optional(),
    workflowType: vine.string().optional(),
    taskId: vine.string(),
    outputData: vine.any().optional(),
    outputParameters: vine.any().optional(),
    taskDefinition: vine.record(vine.string()).optional(),
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
)

// Validator for updating a task
export const updateTaskValidator = vine.compile(
  vine.object({
    taskId: vine.string(),
    status: vine.enum(['SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'FAILED']),
    outputData: vine.record(vine.string()).optional(),
  })
)
