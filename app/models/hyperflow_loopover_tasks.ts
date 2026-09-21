import { BaseModel, column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

export default class HyperflowLoopOver extends BaseModel {
  public static table = 'hyperflow_loopover_tasks'

  @column()
  @column.dateTime({ autoCreate: true })
  declare created_on: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare modified_on: DateTime

  @column({ isPrimary: true })
  declare execution_id: string

  @column()
  declare loopover_json: string
}
