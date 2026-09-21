import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

export default class MetaWorkflow extends BaseModel {
  public static table = 'meta_workflow_def'

  @column.dateTime({ autoCreate: true })
  declare created_on: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare modified_on: DateTime

  @column({ isPrimary: true })
  declare name: string

  @column()
  declare version: number

  @column()
  declare latest_version: number

  @column()
  declare json_data: JSON
}
