# AGENTS.md — Hyperflow Orchestrator

## Project

Hyperflow — custom workflow orchestration engine built on **AdonisJS v6** (ESM, TypeScript) + **BullMQ** + **MySQL** + **Redis**.  
Registered workflows are executed by scheduling tasks onto a BullMQ queue; an external worker executes the task and calls back via HTTP to advance the workflow.

## Architecture

- **No long-running BullMQ worker in this repo**. Tasks are pushed to the `orchestration-queue` queue. An external worker executes the task and POSTs status back to `POST /hyperflow/api/tasks` (`updateTaskStatusAndProcessNextTask`), which advances the workflow.
- **Single-threaded orchestration**: `processNextTask` (in `workflows_controller.ts:429`) processes one task at a time.
- **Scheduler** (`start/scheduler.ts`) polls every 30s for WAIT and retry tasks from `hyperflow_wait_jobs` table.
- **No database transactions** — all `trx` code is commented out.
- **No structured logger** — all logging is `console.log`.
- **Cache layer disabled by default** (`ENABLE_CACHE=0`). The `RedisClient` singleton throws if ENABLE_CACHE is falsy.

## API

All routes under `/hyperflow/api/`. Key endpoints:

- `POST /hyperflow/api/metadata/workflow` — register workflow
- `POST /hyperflow/api/workflow` — start execution
- `POST /hyperflow/api/tasks` — update task status & process next
- `GET /hyperflow/api/execution/list` — list executions
- Swagger docs at `/hyperflow/api-docs` (login at `/hyperflow/login`, creds from env)

## Path Aliases (TypeScript)

Defined in `package.json#imports` and `tsconfig.json#paths`:

```
#controllers/*  → app/controllers/*.js
#services/*     → app/services/*.js
#models/*       → app/models/*.js
#validators/*   → app/validators/*.js
#start/*        → start/*.js
#config/*       → config/*.js
#database/*     → database/*.js
#docs/*         → docs/*
```

## Required Env (`.env`)

`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_DATABASE`, `REDIS_HOST`, `REDIS_PORT` (default 6381), `REDIS_PASSWORD`, `HYPERFLOW_URL`, `APP_KEY`, `SWAGGER_USERNAME`, `SWAGGER_PASSWORD`, `PORT`, `HOST`, `LOG_LEVEL`.

## Key Models & Tables

| Model               | Table                      | PK                                   |
| ------------------- | -------------------------- | ------------------------------------ |
| `Workflow`          | `workflow`                 | `workflow_id`                        |
| `Task`              | `task`                     | `task_id`                            |
| `TaskInProgress`    | `task_in_progress`         | composite `(task_def_name, task_id)` |
| `TaskScheduled`     | `task_scheduled`           | composite `(workflow_id, task_key)`  |
| `HyperflowWaitJobs` | `hyperflow_wait_jobs`      | `task_id`                            |
| `HyperflowLoopOver` | `hyperflow_loopover_tasks` | `execution_id`                       |

## Task Types (in workflow JSON)

`SIMPLE`, `SWITCH`, `DO_WHILE`, `END_WORKFLOW`, `WAIT`, `GOTO` (inside SWITCH branches).

**GOTO limitations** (from README and code):

- Only inside SWITCH branches, max 10 jumps per SWITCH (`MAX_JUMP_BACK = 10` in `workflows_controller.ts:552`).
- GOTO + DO_WHILE combination not supported.

## Style

- TypeScript, ESM (`"type": "module"`).
- 2-space indent, LF, UTF-8 (`.editorconfig`).
- Prettier config: `@adonisjs/prettier-config`.
- Validation: `@vinejs/vine`.
- All functional code is in controllers (no service layer separation except `resolve_variables.ts`).
