import router from '@adonisjs/core/services/router'
import env from '#start/env'
import { createHmac, timingSafeEqual } from 'node:crypto'
import SwaggerAuthMiddleware from '#middleware/swagger_auth_middleware'
import { swaggerSpec } from '../docs/swagger.js'

const TasksController = () => import('#controllers/tasks_controller')
const MetaWorkflowsController = () => import('#controllers/meta_workflows_controller')
const WorkflowController = () => import('#controllers/workflows_controller')
const UpdateTaskController = () => import('#controllers/update_task_controller')
const ResolveVariablesController = () => import('#controllers/resolve_variables_controller')
const CacheController = () => import('#controllers/cache_controller')
const HyperflowApiController = () => import('#controllers/hyperflow_apis_controller')

const loginAttempts = new Map<string, { count: number; lockedUntil: number }>()
const MAX_ATTEMPTS = 5
const LOCK_DURATION_MS = 15 * 60 * 1000

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  const record = loginAttempts.get(ip)

  if (!record) return false
  if (record.lockedUntil && now < record.lockedUntil) return true
  if (record.lockedUntil && now >= record.lockedUntil) {
    loginAttempts.delete(ip)
    return false
  }
  return false
}

function recordFailedAttempt(ip: string): void {
  const now = Date.now()
  const record = loginAttempts.get(ip) ?? { count: 0, lockedUntil: 0 }
  record.count += 1
  if (record.count >= MAX_ATTEMPTS) {
    record.lockedUntil = now + LOCK_DURATION_MS
  }
  loginAttempts.set(ip, record)
}

function clearAttempts(ip: string): void {
  loginAttempts.delete(ip)
}

function createSignedCookie(): string {
  const payload = 'authenticated'
  const signature = createHmac('sha256', env.get('APP_KEY')).update(payload).digest('hex')
  return `${payload}.${signature}`
}

function safeEqual(a: string, b: string): boolean {
  const secret = Buffer.from(env.get('APP_KEY'))
  const hashA = createHmac('sha256', secret).update(a).digest()
  const hashB = createHmac('sha256', secret).update(b).digest()
  return timingSafeEqual(hashA, hashB)
}

const loginHtml = `<!DOCTYPE html>
<html>
<head>
  <title>Swagger Login</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; background: #0f172a; }
    .login-box { background: #1e293b; padding: 2.5rem; border-radius: 12px; box-shadow: 0 4px 24px rgba(0,0,0,0.3); width: 340px; }
    .login-box h2 { margin-bottom: 1.5rem; text-align: center; color: #f1f5f9; font-size: 1.5rem; }
    .login-box input { width: 100%; padding: 12px; margin: 8px 0; border: 1px solid #334155; border-radius: 8px; background: #0f172a; color: #f1f5f9; font-size: 14px; outline: none; }
    .login-box input:focus { border-color: #3b82f6; }
    .login-box button { width: 100%; padding: 12px; margin-top: 12px; background: #3b82f6; color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 16px; font-weight: 600; transition: background 0.2s; }
    .login-box button:hover { background: #2563eb; }
    .error { background: #7f1d1d; color: #fecaca; padding: 8px 12px; border-radius: 6px; margin-bottom: 12px; text-align: center; font-size: 14px; display: none; }
    .error.show { display: block; }
  </style>
</head>
<body>
  <div class="login-box">
    <h2>Hypeflow api docs</h2>
    <div class="error" id="error"></div>
    <form method="POST" action="/hyperflow/login">
      <input type="text" name="username" placeholder="Username" required autocomplete="username" />
      <input type="password" name="password" placeholder="Password" required autocomplete="current-password" />
      <button type="submit">Login</button>
    </form>
  </div>
  <script>
    // Point 6: error message from query param — value is never rendered as HTML
    const params = new URLSearchParams(window.location.search)
    const errorEl = document.getElementById('error')
    if (params.get('error') === 'invalid') {
      errorEl.textContent = 'Invalid credentials. Please try again.'
      errorEl.classList.add('show')
    } else if (params.get('error') === 'locked') {
      errorEl.textContent = 'Too many failed attempts. Please try again in 15 minutes.'
      errorEl.classList.add('show')
    }
  </script>
</body>
</html>`

router
  .group(() => {
    router.post('/workflow', [MetaWorkflowsController, 'create'])
  })
  .prefix('/hyperflow/api/metadata')

router
  .group(() => {
    router.post('/', [WorkflowController, 'startExecution'])
    router.get('/:workflowId', [WorkflowController, 'getWorkflowById'])
    router.delete('/:workflowId', [WorkflowController, 'deleteWorkflow'])
    router.put('/:workflowId/terminate', [WorkflowController, 'terminateWorkflow'])
    router.put('/:workflowId/pause', [WorkflowController, 'pauseWorkflow'])
    router.put('/:workflowId/resume', [WorkflowController, 'resumeWorkflow'])
    router.put('/:workflowId/skiptask/:taskReferenceName', [
      WorkflowController,
      'skipTaskExecution',
    ])
    router.post('/:workflowId/resolvevariables', [ResolveVariablesController, 'getVariables'])
    router.post('/:workflowId/setvariables', [WorkflowController, 'setWorkflowGlobalVariables'])
  })
  .prefix('/hyperflow/api/workflow')

router
  .group(() => {
    router.post('/', [UpdateTaskController, 'updateTaskStatusAndProcessNextTask'])
    router.get('/:taskId', [TasksController, 'getTaskById'])
    router.get('/:taskId/previous-activities', [TasksController, 'getPreviousActivityVariables'])
  })
  .prefix('/hyperflow/api/tasks')

router
  .group(() => {
    router.get('/', [CacheController, 'retreiveCachedData'])
    router.post('/', [CacheController, 'setDataIntoCacheFromApi'])
    router.delete('/', [CacheController, 'deleteCacheKeyAndData'])
    router.post('/add-bulk-tasks', [CacheController, 'addBulkTasks'])
    router.get('/jobs', [CacheController, 'getQueueJobData'])
    router.post('/delete-queue', [CacheController, 'emptyQueue'])
  })
  .prefix('/hyperflow/api/queue')

router
  .group(() => {
    router.get('/list', [HyperflowApiController, 'getWorkflowExecutionList'])
    router.get('/:executionId/tasklist', [HyperflowApiController, 'getTaskListByExecutionId'])
    router.get('/status-count', [HyperflowApiController, 'getWorkflowCountByStatus'])
    router.get('/stats', [HyperflowApiController, 'getWorkflowExecutionStats'])
    router.get('/total', [HyperflowApiController, 'getTotalCountAndStatsPercentage'])
    router.get('/:executionId/global-variables', [HyperflowApiController, 'getGlobalVariable'])
  })
  .prefix('/hyperflow/api/execution')

router.get('/hyperflow/login', async ({ response }) => {
  response.send(loginHtml)
})

router.post('/hyperflow/login', async ({ request, response }) => {
  const ip = request.ip()

  if (isRateLimited(ip)) {
    return response.redirect('/hyperflow/login?error=locked')
  }

  const { username, password } = request.only(['username', 'password'])

  if (
    safeEqual(username ?? '', env.get('SWAGGER_USERNAME')) &&
    safeEqual(password ?? '', env.get('SWAGGER_PASSWORD'))
  ) {
    clearAttempts(ip)

    response.cookie('swagger_auth', createSignedCookie(), {
      httpOnly: true,
      maxAge: 60 * 60 * 24,
      path: '/',
      sameSite: 'lax',
      secure: env.get('NODE_ENV') === 'production',
    })
    return response.redirect('/hyperflow/api-docs')
  }

  recordFailedAttempt(ip)
  return response.redirect('/hyperflow/login?error=invalid')
})

router.get('/hyperflow/logout', async ({ response }) => {
  response.clearCookie('swagger_auth')
  response.redirect('/hyperflow/login')
})

router
  .group(() => {
    router.get('/swagger.json', async ({ response }) => {
      response.type('application/json').send(swaggerSpec)
    })

    router.get('/api-docs', async ({ response }) => {
      const fs = await import('node:fs/promises')
      let html = await fs.readFile('docs/swagger.html', 'utf-8')

      const logoutButton = `
        <style>
          #swagger-logout-btn {
            position: fixed; top: 14px; right: 20px; z-index: 9999;
            background: #e53e3e; color: white; border: none;
            padding: 8px 18px; border-radius: 6px; font-size: 14px;
            font-weight: 600; cursor: pointer; font-family: sans-serif;
            box-shadow: 0 2px 8px rgba(0,0,0,0.2);
          }
          #swagger-logout-btn:hover { background: #c53030; }
        </style>
        <button id="swagger-logout-btn" onclick="window.location.href='/hyperflow/logout'">Logout</button>`

      html = html.replace('</body>', `${logoutButton}\n</body>`)
      response.type('text/html').send(html)
    })
  })
  .prefix('/hyperflow')
  .use(async (ctx, next) => new SwaggerAuthMiddleware().handle(ctx, next))
