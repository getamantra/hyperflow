import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'tasks'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.timestamp('created_at')
      table.timestamp('updated_at')
      table.string('task_id').primary()
      table.json('json_data').notNullable()
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
