# Travel Buddy API

Node.js and TypeScript backend for the Travel Buddy platform.

## Requirements

- Node.js 24 or newer
- npm 11 or newer
- Docker Desktop for local PostgreSQL

## Local setup

```bash
cp .env.example .env
npm install
docker compose up -d postgres
npm run db:migrate:dev -- --name initial_foundation
npm run dev
```

On Windows PowerShell, copy the environment file with:

```powershell
Copy-Item .env.example .env
```

The API runs at `http://localhost:3000` by default.

- API documentation: `http://localhost:3000/docs`
- Health endpoint: `GET http://localhost:3000/api/v1/health`
- Readiness endpoint: `GET http://localhost:3000/api/v1/readiness`

The health endpoint reports whether the Node.js process is running. The
readiness endpoint also checks whether PostgreSQL is reachable.

## Database workflow

The project uses PostgreSQL with Prisma ORM. Prisma keeps database changes in
reviewable migrations instead of changing production tables automatically.

```bash
npm run db:validate
npm run db:generate
npm run db:migrate:dev -- --name describe_your_change
```

Use `db:migrate:dev` only for local development. Deployed environments apply
committed migrations with:

```bash
npm run db:migrate:deploy
```

Never run development migrations or destructive reset commands against staging
or production databases.

## Quality checks

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run build
npm run db:validate
```

The integration tests require a reachable PostgreSQL database with all committed
migrations applied. GitHub Actions runs these tests automatically against an
isolated PostgreSQL service for every pull request.

## Project structure

```text
src/
  config/       Environment parsing and validation
  database/     Database connection infrastructure
  modules/      Product modules and HTTP routes
  app.ts        Fastify application composition
  server.ts     Process startup and graceful shutdown
test/           Automated tests
prisma/         Database schema and committed migrations
```

## Git workflow

Do not commit directly to `main`. Create a focused branch, run all quality
checks, push the branch, and open a pull request for review.
