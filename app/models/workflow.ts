import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

export default class Workflow extends BaseModel {
  public static table = 'workflow'

  @column.dateTime({ autoCreate: true })
  declare created_on: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare modified_on: DateTime

  @column({ isPrimary: true })
  declare workflow_id: string

  @column({ isPrimary: false })
  declare correlation_id: string

  @column()
  declare json_data: JSON

  @column()
  declare status: string

  @column()
  declare start_time: number

  @column()
  declare end_time: number
}
