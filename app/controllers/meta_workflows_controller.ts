import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'
import { metaWorkflowValidator } from '#validators/metaworflow'
import db from '@adonisjs/lucid/services/db'

@inject()
export default class MetaWorkflowsController {
  // This will register the workflow with latest version.
  async create({ request, response }: HttpContext) {
    console.log('===hyperflow workflow registration endpoint called===')
    console.log('===hyperflow Incoming workflow registration request body===', request.body())
    const { ...data } = await request.validateUsing(metaWorkflowValidator, {
      meta: {
        version: request.input('version'),
      },
    })
    const jsonData = JSON.stringify(data)
    const modifiedOn = DateTime.now().toSQL({ includeOffset: false })
    await db.rawQuery(
      `INSERT INTO meta_workflow_def (name, version, latest_version, json_data, modified_on)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE json_data = VALUES(json_data), latest_version = VALUES(latest_version), modified_on = VALUES(modified_on)`,
      [data.name, data.version, data.version, jsonData, modifiedOn]
    )
    await db
      .from('meta_workflow_def')
      .where('name', data.name)
      .update({ latest_version: data.version })

    response.status(200).json({ message: 'Workflow successfully registered!' })
  }
}
