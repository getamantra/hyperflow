import vine from '@vinejs/vine'
export const workflowValidator = vine.compile(
  vine.object({
    name: vine.string(),
    version: vine.number(),
    variables: vine.any().optional(),
  })
)

export const updateTaskStatusValidator = vine.compile(
  vine.object({
    workflowId: vine.string(),
    taskReferenceName: vine.string(),
    taskStatus: vine.enum([
      'SCHEDULED',
      'IN_PROGRESS',
      'COMPLETED',
      'FAILED',
      'TERMINATED',
      'RUNNING',
    ]),
    taskId: vine.string(),
    outputData: vine.any().optional(),
    // outputParameters: vine.any().optional(),
    inputParameters: vine.any().optional(),
    taskType: vine.any().optional(),
  })
)

export const workflowStatusValidator = vine.compile(
  vine.object({
    status: vine.enum(['PAUSED', 'RESUME', 'TERMINATED', 'RUNNING']),
  })
)
