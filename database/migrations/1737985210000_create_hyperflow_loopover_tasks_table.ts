import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'hyperflow_loopover_tasks'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.string('execution_id').primary()
      table.text('loopover_json', 'longtext').notNullable()

      table.timestamp('created_on')
      table.timestamp('modified_on')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
