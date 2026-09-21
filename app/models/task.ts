import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

export default class Task extends BaseModel {
  public static table = 'task'

  @column.dateTime({ autoCreate: true })
  declare created_on: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare modified_on: DateTime

  @column({ isPrimary: true })
  declare task_id: string

  @column()
  declare workflow_id: string

  @column()
  declare task_ref: string

  @column()
  // @column({
  //   prepare: (value: any) => JSON.stringify(value),
  //   consume: (value: any) => {
  //     if (typeof value === 'string') {
  //       try {
  //         return JSON.parse(value)
  //       } catch {
  //         return value
  //       }
  //     }
  //     return value
  //   },
  // })
  declare json_data: JSON
}
