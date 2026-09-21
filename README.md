Single Orchestrator which can handle AI agent with RPA and BPMN workflows

# ⥤ H Y P E R F L O W ⟳

## Custom Workflow Orchestration Engine

**Hyperflow** is a custom orchestration engine built using **AdonisJS (v6+)** and **BullMQ**, designed to manage complex workflows and task execution. It allows registering workflows, scheduling tasks, and executing them in sequence or conditionally using custom operators.

## Getting Started

```bash
pnpm install
cp .env.example .env
node ace generate:key   # paste the generated key into .env as APP_KEY

node ace migration:run
pnpm dev
```

The app serves on `http://localhost:3334` by default. Swagger API docs are available at `/hyperflow/api-docs`, behind a login page at `/hyperflow/login` guarded by the `SWAGGER_USERNAME`/`SWAGGER_PASSWORD` you set in `.env`.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full development workflow, and [AGENTS.md](./AGENTS.md) for an architecture/conventions overview.

---

- **Workflow Registration**: Register custom workflows for orchestration.
- **Task Scheduling**: Tasks are scheduled and added to a queue for execution.
- **Task Execution**: A worker picks tasks from the queue and executes them.
- **Dynamic Task Handling**: Task status and variables are updated in real-time via the Hyperflow API.
- **AIRA Operator Support**:
  - `DO_WHILE`: Looping task execution.
  - `SWITCH`: Conditional task execution.
  - `END_WORKFLOW`: Terminates the workflow.
  - `WAIT`: Pause workflow execution by until or duration.
  - `GOTO`: Jump back to a previous task from within a SWITCH case branch when a specified condition is not met. The GOTO task uses `inputParameters.goto_task` to reference the target task by its `taskReferenceName`. All tasks from the target through the SWITCH are reset and re-executed. A maximum of 3 jump-backs per SWITCH is enforced to prevent infinite loops.
  - `SUB_WORKFLOW`: Runs another registered workflow (referenced via `subWorkflowParam.name`/`version`) as a child execution. The parent task stays pending until the child workflow reaches a terminal state, at which point completion or failure is propagated back to resume the parent.

---

## 🏗 Architecture

### 1️⃣ Workflow Registration

- Workflows are registered and stored in the database.

### 2️⃣ Workflow Execution

- Execution begins with the first task, which is scheduled and added to the queue.
- Each execution has a unique workflow `execution_id`.
- Each task has a unique `taskId`.
- Workflow and tasks are tracked across: `workflow`, `task`, `task_in_progress`, `task_scheduled` tables

### 3️⃣ Task Execution

- The worker service dequeues and executes tasks.
- On completion, the task status and variables are updated via the Hyperflow API.
- The next task is resolved and added to the queue.

### 4️⃣ Supported Workflow Features

- SIMPLE task execution.
- SWITCH expression are evaluated to find the right decision cases via `resolveExpressionValue`.
- Nested SWITCH statements.
- SWITCH within DO_WHILE blocks.
- DO_WHILE task execution with `loop_iteration` conditions.
- Optional task failure handling:
  Non-optional task failure → workflow fails.
  Optional task failure → workflow continues.
- Skipped task feature.
- retry mechanism.
- `END_WORKFLOW` task type terminates the workflow.
- `WAIT` workflow execution will be paused for specified datetime or time.

---

## 📊 Workflow Status Types

- `RUNNING`
- `SCHEDULED`
- `COMPLETED`
- `FAILED`
- `TERMINATED`
- `CANCELLED`

## 📦 Task Status Types

- `IN_PROGRESS`
- `SCHEDULED`
- `COMPLETED`
- `FAILED`
- `CANCELLED`

## 🧩 Hyperflow Task Types

- `SIMPLE`
- `SWITCH`
- `DO_WHILE`
- `END_WORKFLOW`
- `CANCELLED`
- `SCHEDULED`
- `WAIT`
- `GOTO`
- `SUB_WORKFLOW`

---

## 🔁 Switch Conditions: Supported Operators

### Comparison Operators

- `==` — Equal To
- `!=` — Not Equal To
- `<` — Less Than
- `<=` — Less Than or Equal To
- `>` — Greater Than
- `>=` — Greater Than or Equal To

### List-Based Operators

- `IN` — Value exists in a list
- `NOT IN` — Value does not exist in a list

### String Operators

- `CONTAINS` — Value exists in string/list
- `STARTS WITH` — String begins with substring
- `ENDS WITH` — String ends with substring

### Rules and Add Path in switch

- `AND` — both condition must be true
- `OR` — either anyone condition must be true

---

## 🎯 Use Cases and Limitations

### Supported Use Cases

- **SIMPLE task execution** — Standard sequential task processing.
- **SWITCH conditional branching** — Expression-based routing with comparison, list, and string operators.
- **Nested SWITCH statements** — SWITCH tasks inside other SWITCH case branches.
- **SWITCH within DO_WHILE** — Conditional branching inside loop iterations.
- **DO_WHILE loop execution** — Iterative task execution with `loop_iteration` limits and `loopCondition` evaluation.
- **GOTO jump-back** — Re-execution from an earlier task within a SWITCH branch (max 3 jumps per SWITCH).
- **SUB_WORKFLOW** — Run another registered workflow as a child execution, with completion/failure propagated back to the parent.
- **WAIT task** — Pause execution by duration or specific date-time.
- **END_WORKFLOW** — Graceful workflow termination.
- **Optional task failure handling** — Non-optional failure fails the workflow; optional failure allows continuation.
- **Task skip** — Individual tasks can be skipped via the `skipTask` flag.
- **Task retry** — Configurable retry count and delay for failed tasks.

### Known Limitations

- **GOTO is restricted to SWITCH branches** — Cannot be used as a top-level task or inside DO_WHILE loops.
- **GOTO only jumps backward** — The target task must appear before the SWITCH in the task array.
- **Only one GOTO per branch** — If multiple GOTO tasks exist in a SWITCH branch, only the first is processed.
- **Unconditional GOTO** — The GOTO task itself has no condition; it always triggers when its branch is selected.
- **DO_WHILE loops should not be used in workflows that use GOTO** — The jump-back reset logic does not account for DO_WHILE iteration state, which can lead to incorrect behavior.
- **Nested DO_WHILE loops** — DO_WHILE inside another DO_WHILE is not supported and will not work correctly.
- **GOTO inside DO_WHILE** — GOTO detection only runs in the SWITCH processing path; DO_WHILE tasks have no jump-back handling.
- **Forward GOTO** — Jumping to a task that appears after the SWITCH is not supported.
- **DO_WHILE loopOver must be non-empty** — An empty `loopOver` array causes an error.
- **loop_iteration must be a valid number** — Non-numeric values cause immediate failure.
- **Single-threaded orchestration** — The `processNextTask` method processes one task at a time sequentially.
- **No database transactions** — Database operations use individual saves without transaction safety.
- **Wait task scheduler granularity** — The scheduler runs every 30 seconds, introducing up to 30s latency.
- **Fixed retry delay** — Retries use a fixed delay (default 60s) with no exponential backoff.
- **No timeout handling** — No built-in protection against tasks that run indefinitely.

---
### This Document Is Maintained by the Amantra Hyperflow Engine Core Team and Is Up to Date as of 2026
