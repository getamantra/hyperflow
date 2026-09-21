import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

export default class TaskScheduled extends BaseModel {
  public static table = 'task_scheduled'

  @column.dateTime({ autoCreate: true })
  declare created_on: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare modified_on: DateTime

  @column({ isPrimary: true })
  declare workflow_id: string

  @column({ isPrimary: true })
  declare task_key: string

  @column()
  declare task_id: string
}
