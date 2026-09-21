# Contributing to Hyperflow

Thanks for your interest in improving Hyperflow, Amantra's open-source workflow orchestration engine.

## Prerequisites

- Node.js 22+
- [pnpm](https://pnpm.io/) 9+
- MySQL and Redis, running locally or reachable over the network

## Local setup

```bash
pnpm install
cp .env.example .env
node ace generate:key   # paste the generated key into .env as APP_KEY

node ace migration:run
pnpm dev
```

```bash
pnpm lint         # ESLint
pnpm format       # Prettier
pnpm typecheck    # tsc --noEmit
pnpm test         # Japa test runner
pnpm build        # production build
```

Run `pnpm typecheck` and `pnpm build` before opening a PR — CI runs the same checks.

## Submitting changes

1. Fork the repo and create a branch off `main`.
2. Make your change, keeping it focused and consistent with existing patterns (see `AGENTS.md` for an architecture overview, path aliases, and conventions).
3. Open a pull request describing the change and why it's needed.

## Reporting issues

Please include steps to reproduce, expected vs. actual behavior, and relevant logs/workflow JSON when filing a bug.
