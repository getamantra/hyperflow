import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import Workflow from '#models/workflow'
import Task from '#models/task'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'

@inject()
export default class HyperflowApiController {
  // GET WORKFLOW EXECUSTION LIST BASED ON FILTERS
  // MAKE CHANGES IN PAGINATION LOGIC AFTER DISCUSSSION WITH AMAN SIR ON 25.05.25
  // IF SEARCH BY NAME THEN PASS NAME IN SEARCH, DONT PASS EXECUTION_ID IN SEARCH PASS IT SEPARETELY.

  async getWorkflowExecutionList({ request, response }: HttpContext) {
    try {
      const {
        execution_id,
        workflow_id,
        search,
        status,
        start_date,
        end_date,
        tenant_id,
        page = 1,
        limit = 10,
      } = request.qs()

      const currentPage = parseInt(page, 10) || 1
      const perPage = parseInt(limit, 10) || 10

      console.log('*****workflow_id', workflow_id)

      const query = Workflow.query().orderBy('created_on', 'desc')

      if (tenant_id) {
        query.whereRaw("LOWER(SUBSTRING_INDEX(json_data->>'$.name', '_', 1)) = LOWER(?)", [
          tenant_id.toLowerCase(),
        ])
      }

      if (search) {
        query.where(() => {
          query
            .whereRaw('LOWER(SUBSTRING(json_data->>"$.name", 34)) LIKE LOWER(?)', [
              `${search.toLowerCase()}%`,
            ])
            .orWhereRaw('LOWER(json_data->>"$.variables.execution_id") = LOWER(?)', [
              search.toLowerCase(),
            ])
            .orWhereRaw('LOWER(json_data->>"$.variables.workflow_id") = LOWER(?)', [
              search.toLowerCase(),
            ])
        })
      }

      if (status) {
        query.where('status', status)
      }

      if (execution_id) {
        query.where('workflow_id', execution_id)
      }

      if (start_date && end_date) {
        const start = DateTime.fromISO(start_date)
        const end = DateTime.fromISO(end_date)

        if (!start.isValid || !end.isValid) {
          return response.status(400).json({ message: 'Invalid date format' })
        }

        query.whereBetween('created_on', [start.toSQL(), end.toSQL()])
      }

      const workflows = await query.paginate(currentPage, perPage)

      const unixToISO = (timestamp: number) => {
        if (timestamp === null || timestamp === undefined || isNaN(timestamp)) return null
        return new Date(timestamp * 1000).toISOString()
      }

      const transformedItems = workflows.all().map((item) => {
        let parsedJsonData = {}

        try {
          parsedJsonData =
            typeof item.json_data === 'string' ? JSON.parse(item.json_data) : item.json_data
        } catch (e) {
          parsedJsonData = { error: 'Invalid JSON data' }
        }

        const allItem = item.toJSON()
        delete allItem.createdOn
        delete allItem.modifiedOn

        return {
          ...allItem,
          jsonData: parsedJsonData,
          startTime: unixToISO(item.start_time),
          endTime: unixToISO(item.end_time),
          createdOn: item.created_on?.toUTC().toISO() || null,
          modifiedOn: item.modified_on?.toUTC().toISO() || null,
          execution_id: item.workflow_id,
          workflowId: undefined,
          totalTimeTaken:
            item.end_time && item.start_time
              ? this.formatTimeDifference(item.start_time, item.end_time)
              : null,
        }
      })

      const lastPage = Math.ceil(workflows.total / perPage)

      const meta = {
        total: workflows.total,
        per_page: perPage,
        current_page: currentPage,
        last_page: lastPage,
        first_page: 1,
        first_page_url: `/?page=1`,
        last_page_url: `/?page=${lastPage}`,
        next_page_url: currentPage < lastPage ? `/?page=${currentPage + 1}` : null,
        previous_page_url: currentPage > 1 ? `/?page=${currentPage - 1}` : null,
      }

      return response.status(200).send({
        meta,
        data: transformedItems,
      })
    } catch (error) {
      return response.status(500).json({ message: 'Internal server error' })
    }
  }

  // FUNCTION TO CALCULATE THE TIME TAKEN IN WORKFLOW EXECUTION
  // NOTE: FOR RUNNING WORKFLOW THE DIFFERENCE WILL BE NULL
  formatTimeDifference(startTime: any, endTime: any) {
    const diffInSeconds = endTime - startTime
    const hours = Math.floor(diffInSeconds / 3600)
    const minutes = Math.floor((diffInSeconds % 3600) / 60)
    const seconds = diffInSeconds % 60
    let result = ''

    if (hours > 0) {
      result += `${hours} hour${hours > 1 ? 's' : ''}`
    }

    if (minutes > 0) {
      if (result) result += ' '
      result += `${minutes} minute${minutes > 1 ? 's' : ''}`
    }

    if (seconds > 0 || result === '') {
      if (result) result += ' '

      result += `${seconds} second${seconds > 1 ? 's' : ''}`
    }
    return result
  }

  async getTaskListByExecutionId({ request, params, response }: HttpContext) {
    try {
      const executionId = params.executionId
      const { task_id, tenant_id } = request.qs()

      if (!executionId) {
        return response.status(400).json({ message: 'executionId is required.' })
      }

      const timeFieldNames = ['scheduledTime', 'startTime', 'previousTaskEndTime', 'endTime']

      const query = Task.query()
        .select('task.task_id', 'task.json_data', 'task.created_on', 'task.modified_on')
        .where('task.workflow_id', executionId)
        // .whereRaw('json_data->>"$.type" != "DO_WHILE"')
        // .where('operator_type', '!=', 'DO_WHILE') // FOR PERFORMANCE OPTIMIZATION USE THIS
        .whereRaw('JSON_VALID(task.json_data)')
        .whereRaw('JSON_UNQUOTE(JSON_EXTRACT(task.json_data, "$.type")) != ?', ['DO_WHILE'])
        .orderBy('task.created_on', 'asc')

      if (tenant_id) {
        query
          .join('workflow', 'workflow.workflow_id', 'task.workflow_id')
          .whereRaw("LOWER(SUBSTRING_INDEX(workflow.json_data->>'$.name', '_', 1)) = LOWER(?)", [
            tenant_id.toLowerCase(),
          ])
      }

      if (task_id) {
        query.where('task.task_id', task_id)
      }

      const tasks = await query

      if (!tasks.length) {
        return response.status(200).json({ tasks: [] })
      }

      const formattedTasks = tasks.map((task) => {
        let parsedJsonData: any = {}

        try {
          parsedJsonData =
            typeof task.json_data === 'string' ? JSON.parse(task.json_data) : (task.json_data ?? {})
        } catch (err) {
          console.error(`Invalid JSON for task ${task.task_id}:`, err)
          parsedJsonData = {}
        }

        for (const timeField of timeFieldNames) {
          const timestamp = parsedJsonData[timeField]
          if (typeof timestamp === 'number') {
            parsedJsonData[timeField] = new Date(timestamp * 1000).toISOString()
          }
        }

        return {
          task_id: task.task_id,
          json_data: parsedJsonData,
          task_ref: parsedJsonData.taskReferenceName ?? null,
          status: parsedJsonData.status ?? null,
          created_on: task.created_on?.toUTC().toISO() || null,
          modified_on: task.modified_on?.toUTC().toISO() || null,
        }
      })

      return response.status(200).json({ tasks: formattedTasks })
    } catch (error) {
      console.error('Error in fetching task list:', error)
      return response.status(500).json({ message: 'Internal server error.' })
    }
  }

  // GET TOTAL STATUS COUNT OF EACH KIND OF WORKFLOW STATUS.
  // AS PER THE FINAL DISCUSSION WITH AMANDEEP SHOWING CURRENT AND LAST YEAR DATA.
  // BY DEFAULT CURRENT YEAR RECORDS WILL BE DISPLAYED.
  // WHEN USER WANT TO FURTHER FILTER BY MONTH THEN ALSO NEED TO PROVIDE YEAR AS WELL.
  // ALL STATUSCOUNT WILL BE NOT BE THE PART OF DATA FILTER.
  async getWorkflowCountByStatus({ request, response }: HttpContext) {
    try {
      const { tenant_id, month, year } = request.qs()

      const now = DateTime.now()
      const currentYear = now.year
      const lastYear = currentYear - 1

      const yearOptions = [currentYear, lastYear]

      const selectedYear = year ? parseInt(year, 10) : currentYear

      if (!yearOptions.includes(selectedYear)) {
        return response
          .status(400)
          .json({ message: 'Only current and previous year are supported' })
      }

      if (month !== undefined && year === undefined) {
        return response.status(400).json({ message: 'Year is required when filtering by month' })
      }

      const startOfYear = DateTime.fromObject({ year: selectedYear, month: 1, day: 1 }).startOf(
        'day'
      )
      const endOfYear = DateTime.fromObject({ year: selectedYear, month: 12 }).endOf('month')

      const dbQuery = db.from('workflow').select('created_on', 'status')
      dbQuery.whereBetween('created_on', [startOfYear.toSQL()!, endOfYear.toSQL()!])
      dbQuery.whereIn('status', ['COMPLETED', 'FAILED'])

      if (tenant_id) {
        dbQuery.whereRaw("LOWER(SUBSTRING_INDEX(json_data->>'$.name', '_', 1)) = LOWER(?)", [
          tenant_id.toLowerCase(),
        ])
      }

      const rawResults = await dbQuery

      const statusCount = {
        COMPLETED: 0,
        RUNNING: 0,
        TERMINATED: 0,
        PAUSE: 0,
        RESUME: 0,
        FAILED: 0,
      }
      // SEPARATE QUERY TO GET ALL COUNTS
      const statusQuery = db.from('workflow').select('status').count('* as count').groupBy('status')
      if (tenant_id) {
        statusQuery.whereRaw("LOWER(SUBSTRING_INDEX(json_data->>'$.name', '_', 1)) = LOWER(?)", [
          tenant_id.toLowerCase(),
        ])
      }

      const totalStatusCount = await statusQuery
      for (const row of totalStatusCount) {
        const status = row.status as keyof typeof statusCount
        if (status in statusCount) {
          statusCount[status] = Number(row.count)
        }
      }

      // ===== MONTH + YEAR FILTER: DAY-WISE DATA =====
      if (month !== undefined && year !== undefined) {
        const monthNum = parseInt(month.toString().padStart(2, '0'), 10)

        if (!/^(0[1-9]|1[0-2])$/.test(month.toString().padStart(2, '0'))) {
          return response.status(400).json({ message: 'Invalid month. Must be between 01 and 12' })
        }

        const targetMonthStart = DateTime.fromObject({
          year: selectedYear,
          month: monthNum,
          day: 1,
        }).startOf('month')
        const targetMonthEnd = targetMonthStart.endOf('month')

        const filteredResults = rawResults.filter((row) => {
          const created = DateTime.fromJSDate(row.created_on)
          return created >= targetMonthStart && created <= targetMonthEnd
        })

        const numDays = targetMonthEnd.day
        const dayLabels: string[] = Array.from({ length: numDays }, (_, i) => `${i + 1}`)
        const successPerDay = Array(numDays).fill(0)
        const failedPerDay = Array(numDays).fill(0)

        for (const row of filteredResults) {
          const created = DateTime.fromJSDate(row.created_on)
          const day = created.day
          if (row.status === 'COMPLETED') successPerDay[day - 1]++
          else if (row.status === 'FAILED') failedPerDay[day - 1]++
        }

        return response.status(200).json({
          years: yearOptions,
          chart: {
            categories: dayLabels,
            series: [
              { name: 'Success', data: successPerDay },
              { name: 'Failed', data: failedPerDay },
            ],
          },
          statusCount,
        })
      }

      // ===== DEFAULT TO CURRENT YEAR FILTER: MONTH-WISE DATA =====

      const monthLabels = [
        'Jan',
        'Feb',
        'Mar',
        'Apr',
        'May',
        'Jun',
        'Jul',
        'Aug',
        'Sep',
        'Oct',
        'Nov',
        'Dec',
      ]

      const monthlyStats: Record<string, { COMPLETED: number; FAILED: number }> = {}
      for (let i = 1; i <= 12; i++) {
        const key = i.toString().padStart(2, '0')
        monthlyStats[key] = { COMPLETED: 0, FAILED: 0 }
      }

      for (const row of rawResults) {
        const created = DateTime.fromJSDate(row.created_on)
        if (created.year !== selectedYear) continue
        const monthKey = created.toFormat('MM')
        if (monthlyStats[monthKey]) {
          monthlyStats[monthKey][row.status as 'COMPLETED' | 'FAILED']++
        }
      }

      const successMonthly: number[] = []
      const failedMonthly: number[] = []

      for (let i = 1; i <= 12; i++) {
        const key = i.toString().padStart(2, '0')
        const { COMPLETED, FAILED } = monthlyStats[key]
        successMonthly.push(COMPLETED)
        failedMonthly.push(FAILED)
      }

      return response.status(200).json({
        years: yearOptions,
        chart: {
          categories: monthLabels,
          series: [
            { name: 'Success', data: successMonthly },
            { name: 'Failed', data: failedMonthly },
          ],
        },
        statusCount,
      })
    } catch (error) {
      console.log('Error in getWorkflowCountByStatus:', error)
      return response.status(500).json({ message: 'Internal server error' })
    }
  }

  // GET TOTAL EXECUTION OF A WORKFLOW IN A DAY WITH START_TIME AND END_TIME OF EACH EXECUTION
  async getWorkflowExecutionStats({ request, response }: HttpContext) {
    try {
      const limit = Number(request.input('limit', 100))
      const workflowId = request.input('workflow_id')

      if (!workflowId) {
        return response.badRequest({ message: 'workflow_id is required' })
      }

      const startOfDay = DateTime.local().startOf('day').toSeconds()
      const endOfDay = DateTime.local().endOf('day').toSeconds()

      const workflows = await db
        .from('workflow')
        .select('workflow_id', 'start_time', 'end_time', 'json_data')
        .whereBetween('start_time', [startOfDay, endOfDay])
        .whereRaw('LOWER(json_data->>"$.variables.workflow_id") = LOWER(?)', [workflowId])
        .orderBy('start_time', 'desc')
        .limit(limit)

      const executionIds = workflows.map((wf) => wf.workflow_id)

      const tasksData = await db
        .from('task')
        .whereIn('workflow_id', executionIds)
        .select('workflow_id', 'task_id', 'json_data')

      const taskMap = tasksData.reduce(
        (acc, task) => {
          const parsedJson =
            typeof task.json_data === 'string' ? JSON.parse(task.json_data) : task.json_data

          if (!acc[task.workflow_id]) acc[task.workflow_id] = []
          acc[task.workflow_id].push({
            task_id: task.task_id || null,
            json_data: parsedJson || null,
          })
          return acc
        },
        {} as Record<string, { task_id: string; json_data: any }[]>
      )

      const formatted = workflows.map((wf) => {
        const parsedJson =
          typeof wf.json_data === 'string' ? JSON.parse(wf.json_data as any) : (wf.json_data as any)

        return {
          execution_id: wf.workflow_id,
          workflow_name: parsedJson?.name || null,
          start_time: DateTime.fromSeconds(wf.start_time).toISO(),
          end_time: wf.end_time ? DateTime.fromSeconds(wf.end_time).toISO() : null,
          tasks: taskMap[wf.workflow_id] || [],
        }
      })

      return response.status(200).json({
        date: DateTime.local().toISODate(),
        totalExecutions: workflows.length,
        workflows: formatted || [],
      })
    } catch (error) {
      console.log('Error in getWorkflowExecutionStats:', error)
      return response.internalServerError({ message: 'Failed to fetch workflow stats.' })
    }
  }

  async getTotalCountAndStatsPercentage({ request, response }: HttpContext) {
    try {
      const { tenant_id } = request.qs()
      const query = db.from('workflow')

      if (tenant_id) {
        query.whereRaw("LOWER(SUBSTRING_INDEX(json_data->>'$.name', '_', 1)) = LOWER(?)", [
          tenant_id.toLowerCase(),
        ])
      }

      const [totalResult] = await query.clone().count('* as total')
      const total = Number(totalResult?.total) || 0

      const allStatuses = ['COMPLETED', 'FAILED', 'TERMINATED', 'RUNNING', 'PAUSED', 'RESUME']

      const statusCounts = await query
        .clone()
        .select('status')
        .whereIn('status', allStatuses)
        .groupBy('status')
        .count('* as count')

      let success = 0
      let failure = 0
      let active = 0

      for (const row of statusCounts) {
        const status = row.status
        const count = Number(row.count)

        if (status === 'COMPLETED') success += count
        else if (status === 'FAILED' || status === 'TERMINATED') failure += count
        else if (status === 'RUNNING' || status === 'PAUSED' || status === 'RESUME') active += count
      }

      const successPercentage = total > 0 ? ((success / total) * 100).toFixed(2) : '0.00'
      const failurePercentage = total > 0 ? ((failure / total) * 100).toFixed(2) : '0.00'
      const activePercentage = total > 0 ? ((active / total) * 100).toFixed(2) : '0.00'

      return response.status(200).json({
        totalExecutionCount: total,
        successPercentage: `${successPercentage}%`,
        failurePercentage: `${failurePercentage}%`,
        activePercentage: `${activePercentage}%`,
      })
    } catch (error: any) {
      console.log('Error in getTotalCountAndStatsPercentage:', error)
      return response.status(500).json({
        message: 'Failed to fetch workflow stats',
        error: error.message || 'Internal Server Error',
      })
    }
  }

  async getGlobalVariable({ params, response }: HttpContext) {
    try {
      const executionId = params.executionId
      const result = await Workflow.query().where('workflow_id', executionId).select('json_data')

      if (!result || result.length === 0) {
        return response.status(200).json({
          variables: {},
          message: 'No workflow found',
        })
      }

      const workflow = result[0]
      const jsonData = workflow.json_data
      const parsedata = JSON.parse(jsonData as unknown as string)
      const variables = parsedata.variables || {}

      return response.status(200).json({ variables })
    } catch (error) {
      console.log('Error fetching global variables:', error)
      return response.status(500).json({ message: 'Internal server error.' })
    }
  }
}
