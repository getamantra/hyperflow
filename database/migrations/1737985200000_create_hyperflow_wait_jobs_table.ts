import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'hyperflow_wait_jobs'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.string('task_id').primary()
      table.string('execution_id').notNullable()
      table.string('task_ref_name').notNullable()
      table.dateTime('scheduled_time').notNullable()
      table.string('task_type').notNullable()
      table.string('timezone').notNullable()
      table.boolean('is_executed').notNullable().defaultTo(false)
      table.json('json_data').notNullable()

      table.timestamp('created_on')
      table.timestamp('modified_on')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
