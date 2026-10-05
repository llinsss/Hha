# Houzz Hills API

This is the standalone backend for Houzz Hills, built with Fastify 5, TypeORM 1, PostgreSQL, Redis, JWT and OpenAPI. It replaces the legacy Next.js API routes, which have been removed from `../web`. The web app is now a pure frontend that talks to this API through `web/src/lib/api`. See `docs/PRD.md` §6–§9 for the target architecture.

This package is a **scaffold**. The infrastructure, security and authentication layers are complete and tested. Business modules (reservations, payments, POS, …) still need to be ported from the legacy API, one feature at a time (see [Adding a feature module](#adding-a-feature-module)).

## Requirements

- Node.js **≥ 24.11** (required by TypeORM 1.x; the Docker image already uses it)
- PostgreSQL 14+ and Redis 6.2+ (Redis 7 recommended)

## Quick start

```bash
cp .env.example .env                       # set JWT_ACCESS_SECRET: openssl rand -base64 48
docker compose up -d postgres redis        # or point .env at your own instances
npm ci
npm run db:migrate
npm run dev                                # http://localhost:4000, docs at /docs
```

To run the whole stack in containers:

```bash
JWT_ACCESS_SECRET=$(openssl rand -base64 48) docker compose up --build
```

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Watch mode via tsx, loads `.env` |
| `npm run build` / `npm start` | Compile to `dist/` / run the compiled server |
| `npm run check` | Typecheck, lint and test (run this in CI) |
| `npm test` | Unit tests. Integration tests also run when `TEST_DATABASE_URL` and `TEST_REDIS_URL` are set (**the test database is wiped**). |
| `npm run db:migrate` / `db:migrate:revert` / `db:migrate:status` | Apply, revert the last migration, or check for pending ones (dev, via tsx) |
| `npm run db:migrate:prod` | Apply migrations from compiled `dist/` (release step) |
| `npm run db:migration:create -- src/db/migrations/<name>` | Create an empty migration |

## Layout

```text
src/
  server.ts              process entry: config, listen, graceful shutdown
  app.ts                 buildApp(): plugin and route registration
  config/env.ts          the only reader of process.env; typed, validated, frozen
  plugins/               redis, database, security (helmet/CORS/rate limit/load shedding),
                         error-handler, swagger, auth (JWT + RBAC), idempotency
  modules/<feature>/     routes + schemas + services per feature (auth, health)
  db/entities/           TypeORM EntitySchema definitions
  db/migrations/         ordered, hand-written migrations (registered in index.ts)
  lib/                   errors, permissions, password hashing, crypto, audit
test/unit, test/integration
```

## What is built in

**Configuration.** Every environment variable is validated by a TypeBox schema at boot. On an invalid config the process prints every problem at once and exits. The production rules refuse to start with:
- a placeholder JWT secret
- non-Secure cookies
- empty or non-https CORS origins

**Errors.** Every non-2xx response uses one envelope: `{ statusCode, error, code, message, requestId, details? }`.

| Status | Meaning |
| --- | --- |
| 401 | Unauthenticated |
| 403 | Forbidden |
| 404 | Not found |
| 409 | Conflict or concurrent change. PostgreSQL unique, foreign-key and serialization errors are mapped here. |
| 422 | Validation failed, with per-field `details` |
| 429 | Rate limited |
| 5xx | Server failure. The message is generic and the details are only logged. |

**Authentication.**

Tokens:
- Login returns a 15-minute HS256 access token (`Authorization: Bearer …`).
- It also sets a refresh token as an `HttpOnly; Secure; SameSite=Strict` cookie, scoped to `/api/v1/auth`.
- Refresh tokens rotate on every use. Reusing an old token after the 30-second grace window (meant for parallel tabs) revokes the whole session.

Session checks:
- Sessions live in the `api_sessions` table, and every request re-checks them. A 60-second Redis cache sits in front of that check, and revocation markers take effect immediately.
- So logout, password change and deactivation take effect at once, without waiting for the access token to expire.
- If Redis is down, the session check falls back to PostgreSQL. A Redis outage never lets a revoked session through.

Login protection:
- Password hashes stay compatible with the legacy stack (scrypt `salt:key`), so both stacks can share the `users` table.
- Login has a per-IP rate limit and a lockout per email+IP pair.
- An unknown account takes the same time to reject as a wrong password, so timing doesn't reveal which emails exist.
- The refresh and logout endpoints reject requests from origins that aren't on the allowlist (CSRF protection).

**Authorization.** Use `preHandler: app.authorize("payments:confirm")`. The role table is in `src/lib/permissions.ts` and mirrors the legacy table. Users who still have a temporary password are blocked everywhere except `/auth/session` and `/auth/password`.

**Idempotency.** Use `preHandler: [app.authorize("pos:write"), app.idempotent()]`. This requires an `Idempotency-Key` header and is backed by Redis:

| Situation | Response |
| --- | --- |
| Retry with the same key and same payload | Replays the stored response (`Idempotent-Replayed: true`) |
| Same key, different payload | 409 |
| Duplicate arrives while the first is still running | 409 |
| The first attempt failed with a 5xx | Not stored, so the client can retry |
| Redis is unavailable | Fails closed with 503 |

Keep the database unique constraints on idempotency keys (`payments`, `pos_orders`) as the final guard.

**Security and operations.**
- Helmet headers, plus credentialed CORS limited to `CORS_ORIGINS`
- Redis-backed rate limiting shared across replicas
- Load shedding (503 + `Retry-After`) when the event loop saturates
- Body size limit and request/handler timeouts
- Request IDs: an incoming `X-Request-Id` is reused if well-formed, and the ID is returned on every response
- Structured pino logs, with credentials, cookies and passwords redacted
- Graceful shutdown that drains connections, then closes PostgreSQL and Redis
- `/health/live` and `/health/ready` probes that return no internal details

**OpenAPI.** The spec is generated from the route schemas, so it can't drift from the validation that actually runs. It's served at `/openapi.json`, with Swagger UI at `/docs`. Both are on by default outside production and controlled by `DOCS_ENABLED`.

## Database and migrations

- The API owns the schema. `1791158400000-legacy-baseline` replays the legacy SQL (the old `db/migrations/001-004`). Every statement in it is idempotent, so it is safe on a fresh database and on one the legacy migrator already built. It refuses to be reverted.
- `synchronize` is permanently off. Migrations run as an explicit release step (`npm run db:migrate:prod`), never on boot, so replicas cannot race each other.
- Write migrations by hand with `db:migration:create`, then:
  - change the generated `import { MigrationInterface, QueryRunner }` to `import type { … }`
  - add the class to `src/db/migrations/index.ts`
- `migration:generate` is not recommended: the legacy tables are only partially mapped, so it would produce noisy diffs.
- Entities use `EntitySchema` instead of decorators. That avoids `reflect-metadata` and `emitDecoratorMetadata`, and they behave the same under tsc, tsx and vitest. Always give each column an explicit `type`.
- Money stays integer kobo. Postgres `bigint` columns come back as strings, so don't convert them to `number`.

## Adding a feature module

1. Create `src/modules/<feature>/` containing:
   - `<feature>.schemas.ts`: TypeBox request/response schemas. Response schemas also speed up serialization and stop extra fields leaking.
   - `<feature>.service.ts`
   - `<feature>.routes.ts`
2. Register it in `app.ts` inside the `config.apiPrefix` block.
3. Protect every route with `app.authorize(...)` and add `security: [{ bearerAuth: [] }]` to its schema. Add `app.idempotent()` to money and order writes.
4. Write the domain row, `recordAudit(...)` and any outbox event in the **same** `db.transaction(...)`.
5. Add an integration test under `test/integration/`. Cover each role and the failure cases.

## Production checklist

- Run behind TLS. Set `TRUST_PROXY_HOPS` to the number of proxies in front of the API.
- `NODE_ENV=production`, with a random `JWT_ACCESS_SECRET` of at least 32 bytes held in the host's secret store.
- Set `CORS_ORIGINS` to the exact web origins. Set `COOKIE_DOMAIN` when web and API are on sibling subdomains (`app.` / `api.houzzhills.com`).
- Turn on `DATABASE_SSL` for managed PostgreSQL. Size `DATABASE_POOL_MAX × replicas` below the server's connection limit.
- Redis with persistence (AOF) and `maxmemory-policy noeviction`.
- Run `npm run db:migrate:prod` before rolling out new replicas.

## Not yet done

- Business endpoints (PRD §7) still need porting from the legacy API.
- Payment webhooks, hold-expiry jobs, the outbox publisher and the SSE event stream are not implemented.
- Distributed tracing and metrics export are not wired.
