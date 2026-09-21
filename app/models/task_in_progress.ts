import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

export default class TaskInProgress extends BaseModel {
  public static table = 'task_in_progress'

  @column.dateTime({ autoCreate: true })
  declare created_on: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare modified_on: DateTime

  @column({ isPrimary: true })
  declare task_def_name: string

  @column({ isPrimary: true })
  declare task_id: string

  @column()
  declare workflow_id: string

  @column()
  declare in_progress_status: boolean
}
