# CRM server

The Node.js + Express backend. A self-contained project: its dependencies, configuration and
secrets all live in this folder. It is API-only: the frontend is a separate project and repository
(`../client`, hosted on Vercel) and nothing is imported between the two.

## Requirements

- Node.js 22.12 or newer
- A MongoDB database (the development database on Atlas, or a local one)

## First-time setup

```bash
cd server
npm install
cp .env.example .env      # then fill in the values
npm run seed              # creates roles, settings and the first CEO in the development database
```

## Commands (run inside `server/`)

| Command | What it does |
|---|---|
| `npm run dev` | Starts the API on port 3000 and restarts on file changes |
| `npm start` | Starts the API once (production style) |
| `npm run lint` | ESLint (including the "no classes" rule) and a Prettier check |
| `npm run format` | Formats the code with Prettier |
| `npm test` | Runs the tests (Vitest + Supertest). Database tests use an in-memory MongoDB, never a real database |
| `npm run seed` | Creates the three roles, the settings record and the first CEO user (`SEED_CEO_EMAIL`). Safe to run again |
| `node tests/helpers/downloadTestDb.js` | Once per computer: downloads the in-memory MongoDB used by the tests (about 780 MB) |

## Which database is used

`MONGODB_URI` is production. `MONGODB_URI_DEV` is development. Every run that is not
`NODE_ENV=production` uses the development one; the startup log line "Using database" says which.

## Signing in

There are no passwords. A person can sign in with Google only if an administrator has invited
their email address (a row in `users`). The first CEO comes from the seed script.
Flow: `/api/auth/google` → Google → `/api/auth/google/callback` → session cookie → `/api/auth/me`.

## How the code is organised

```text
routes/        every API path, one file per feature, no logic
controllers/   one function per endpoint: read the request, call services, send the response
services/      all business rules; never touches req or res
models/        Mongoose schemas only (fields, validation, indexes)
middleware/    request id, validation, permissions, error handler
infra/         database, logger and other infrastructure wrappers
lib/           small shared helpers (errors, standard responses, permissions)
constants/     fixed lists such as the permission catalogue
validation/    Zod schemas for request input (added per feature)
tests/         one test file per feature
```

To follow an endpoint, read the three files with the same feature name:
`routes/health.routes.js` → `controllers/health.controller.js` → `services/health.service.js`.

## Checking that it works

- `GET /api/health/live` → `{ "data": { "status": "ok" } }` when the process is running.
- `GET /api/health` → 200 when MongoDB answers, 503 with `"mongo": "down"` when it does not.
- Every response carries an `X-Request-Id` header; search the server log for that id to see the request.

## If it does not start

| Message | Cause | Fix |
|---|---|---|
| `Invalid environment configuration … MONGODB_URI` | `.env` is missing or the variable is empty | Fill in `server/.env` from `.env.example` |
| `Server failed to start` with a MongoDB timeout | Wrong URI or password, or the IP address is not allowed in Atlas Network Access | Check the URI and the Atlas access list |
