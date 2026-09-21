import { BaseModel, column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

export default class HyperflowWaitJobs extends BaseModel {
  public static table = 'hyperflow_wait_jobs'

  @column()
  @column.dateTime({ autoCreate: true })
  declare created_on: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare modified_on: DateTime

  @column()
  declare execution_id: string

  @column()
  declare task_ref_name: string

  @column({ isPrimary: true })
  declare task_id: string

  @column.dateTime({ autoCreate: false, autoUpdate: false })
  declare scheduled_time: DateTime

  @column()
  declare task_type: string

  @column()
  declare timezone: string

  @column()
  declare is_executed: boolean

  @column()
  declare json_data: JSON
}
