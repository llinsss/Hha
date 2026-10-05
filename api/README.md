# Houzz Hills API

This is the backend service for Houzz Hills: authentication, bookings, payments, rooms, staff, attendance, restaurant POS, inventory, the payment register, and live updates. It implements the backend described in [`../docs/PRD.md`](../docs/PRD.md) §5–§10. The frontend in [`../web`](../web) uses it through `web/src/lib/api`.

Stack: Fastify 5, TypeORM 1 (query runners, migrations), PostgreSQL 14+, Redis 6.2+, JWT access tokens with rotating refresh cookies, OpenAPI 3.1 and Prometheus metrics.

## Quick start

```bash
cp .env.example .env                  # set JWT_ACCESS_SECRET and SETTINGS_ENCRYPTION_KEY
docker compose -f ../docker-compose.yml up -d postgres redis   # or your own instances
npm ci
npm run db:migrate
npm run dev                           # http://localhost:4000, docs at /docs
```

Create the first owner account with `POST /api/v1/setup`, sending the `x-setup-secret` header (see [Setup](#first-owner-setup)).

Requires Node.js ≥ 24.11, which TypeORM 1.x needs. The Docker image already uses it.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Watch mode with `.env` |
| `npm run build` / `npm start` | Compile to `dist/` / run the compiled server |
| `npm run check` | Typecheck, lint and all tests. Use this in CI. |
| `npm test` | Unit tests. Integration tests also run when `TEST_DATABASE_URL` and `TEST_REDIS_URL` are set. **Those databases are wiped**, along with a sibling `<name>_setup` database. |
| `npm run db:migrate` / `db:migrate:revert` / `db:migrate:status` | Apply, revert the last migration, or check for pending ones (dev) |
| `npm run db:migrate:prod` | Apply migrations from `dist/` (release step) |
| `npm run db:migration:create -- src/db/migrations/<name>` | New empty migration |

## Endpoints

Everything is under `/api/v1` except the health probes, `/openapi.json`, `/docs` and `/metrics`. The full contract, including request and response schemas, is served at `/openapi.json` and generated from the same schemas that validate requests. Management endpoints need `Authorization: Bearer <access token>`; the permission column shows what each one checks.

| Method and path | Access | Purpose |
| --- | --- | --- |
| `GET /health/live`, `GET /health/ready` | Hosting platform | Liveness; readiness of the database and Redis |
| `POST /auth/login`, `/auth/refresh`, `/auth/logout` | Public / refresh cookie | Sign-in, token rotation, sign-out |
| `GET /auth/session` | Optional bearer | Current user, or `{ user: null }` |
| `POST /auth/password` | Bearer | Change password and clear the temporary-password gate |
| `GET /setup`, `POST /setup` | Public / `x-setup-secret` | One-time owner bootstrap |
| `GET /public/availability` | Public, rate limited | Room types available for a stay |
| `POST /public/reservations` | Public, `Idempotency-Key` | Hold a room and start hosted checkout |
| `GET /public/payments/{reference}` | Public, rate limited | Payment status for the result page (no guest data) |
| `POST /webhooks/payments` | Provider signature | Paystack or Flutterwave payment events |
| `POST /cron/expire-payment-holds` | Bearer `CRON_SECRET` | Release unpaid checkout holds |
| `POST /cron/reconcile-payments` | Bearer `CRON_SECRET` | Settlement reconciliation and stale-transfer queue |
| `GET /management/dashboard` | `dashboard:read` | Role-filtered property snapshot |
| `GET /management/events` | Authenticated | Server-sent events (`Last-Event-ID` / `?cursor=` replay) |
| `GET, POST /management/reservations` | `reservations:read` / `:write` | List (filters, pagination); staff booking |
| `PATCH /management/reservations/{id}` | `reservations:write` | Stay status transitions, with audited reasons |
| `POST /management/reservations/{id}/payments` | `reservations:write`, `Idempotency-Key` | Cash, POS terminal or bank-transfer payment |
| `GET /management/payments`, `GET …/payments/export` | `payments:read` | Payment register with totals; CSV export |
| `PATCH /management/payments/{id}` | `payments:confirm` | Confirm a pending bank transfer |
| `GET, PATCH /management/payment-exceptions[/{id}]` | `payments:confirm` | Exception queue and resolution notes |
| `GET, POST /management/rooms`, `PATCH /…/{id}`, `GET /…/{id}/history` | `rooms:read` / `rooms:create` (add) / `rooms:write` (state) | Rooms, state changes, history |
| `GET, POST /management/staff`, `PATCH /…/{id}`, `POST /…/{id}/temporary-password` | `staff:read` / `:write` | Onboarding, employment status, password reset |
| `GET, POST /management/attendance`, `GET /…/self` | `attendance:read` / authenticated | Team state; your own clock in/out |
| `GET /management/inventory`, `POST /…/items`, `POST /…/movements` | `inventory:read` / `:write` | Stock items and the movement ledger |
| `GET, POST /management/menu`, `PATCH /…/{id}` | `pos:read` / `menu:write` | Menu, recipes, update and archive |
| `GET, POST /management/pos`, `GET /…/{id}`, `GET, POST /…/shift` | `pos:read` / `:write` | Sales, receipts, cashier shifts |
| `GET, PATCH /management/settings`, `POST /…/payments/verify` | `settings:manage` (owner only) | Global settings and payment provider keys |

Changes from the legacy paths in PRD §7:
- Every path gains the `/api/v1` prefix.
- Inventory is split into `/items` and `/movements`, as the PRD asks for the versioned API.
- Lists accept `limit` (at most 200) and `cursor`, and return `nextCursor`.
- Money and order writes require the `Idempotency-Key` header. The legacy `idempotencyKey` body field is still accepted, but it must match the header.

Request and response bodies otherwise keep the legacy shapes.

## Configuration

Every variable is validated at boot by `src/config/env.ts`. An invalid configuration lists every problem at once and the process exits. See [`.env.example`](.env.example) for the full list with defaults.

In production the API refuses to start in any of these cases:
- a placeholder secret is still set
- refresh cookies are not `Secure`
- `CORS_ORIGINS` is empty or uses `http`
- `PUBLIC_WEB_URL` or a provider base URL is not https

| Area | Variables |
| --- | --- |
| Server | `PORT`, `HOST`, `TRUST_PROXY_HOPS`, `CORS_ORIGINS`, `DOCS_ENABLED`, timeouts, `BODY_LIMIT_BYTES` |
| Database / Redis | `DATABASE_URL`, `DATABASE_SSL*`, `DATABASE_POOL_MAX`, `DATABASE_STATEMENT_TIMEOUT_MS`, `REDIS_URL`, `REDIS_KEY_PREFIX` |
| Auth | `JWT_ACCESS_SECRET`, `JWT_*_TTL_*`, `COOKIE_DOMAIN`, `COOKIE_SECURE`, `COOKIE_SAME_SITE`, login limits |
| Payments | `SETTINGS_ENCRYPTION_KEY` (encrypts provider keys stored in settings), `PUBLIC_WEB_URL`, provider base URLs and timeout |
| Booking | `PUBLIC_BOOKING_RATE_LIMIT_MAX` |
| Operations | `CRON_SECRET`, `RECONCILIATION_WINDOW_HOURS`, `SETUP_SECRET`, `METRICS_TOKEN` |

### Owner-managed settings

The payment provider and its keys, and the booking rules, are **global settings** the owner changes from the web app's Settings page. They are not environment variables. Settings live in the `settings` table, seeded with defaults by a migration: online payments off, a 20-minute hold, 90-night maximum stay, 365-day horizon and a 48-hour transfer review window.

| Setting | Notes |
| --- | --- |
| `payments.provider` | `none`, `paystack` or `flutterwave`. Can only be switched on once its keys are saved and `PUBLIC_WEB_URL` is set. |
| `payments.paystack_secret_key` | Secret. Format-checked (`sk_test_…` / `sk_live_…`). Also verifies Paystack webhooks. |
| `payments.flutterwave_secret_key`, `payments.flutterwave_webhook_hash` | Secrets |
| `booking.hold_minutes`, `booking.max_stay_nights`, `booking.horizon_days`, `payments.bank_transfer_review_hours` | Integers, range-checked |

- **Owner only.** `GET`/`PATCH /api/v1/management/settings` and `POST /settings/payments/verify` require `settings:manage`, which only the owner role holds.
- **Secrets are write-only.**
  - They are encrypted with AES-256-GCM using `SETTINGS_ENCRYPTION_KEY`, and each ciphertext is bound to its setting name.
  - Responses show only whether a secret is set and its last four characters.
  - The audit log records that a secret was replaced or cleared, never its value.
  - A value that can't be decrypted (wrong key, or tampering) is reported as unreadable, and the provider stays off until the owner re-enters it.
- **Changes apply immediately on every replica.** Each process caches settings, and a version counter in Redis tells every replica to reload; without Redis they converge within 30 seconds.
- **Verify.** `POST /settings/payments/verify` asks the provider whether it accepts the saved key.

Each environment (dev, staging, production) needs its own database, Redis and provider keys. Keep every secret in the host's secret store, never in the web repository.

## How payments work

**Online booking (PRD §4.1)**

1. `POST /public/reservations` validates the stay against the Africa/Lagos business date, the maximum stay and the booking horizon.
2. It locks one free physical room of the requested type (`FOR UPDATE SKIP LOCKED`), prices the full stay on the server, and creates a `pending_payment` hold with a pending online payment.
3. It then commits, and only afterwards calls the provider. No database lock is held across the network.
4. If checkout cannot be started, the hold is released and the guest receives 502.
5. The `Idempotency-Key` is enforced in Redis and again in the database. A retry returns the same reservation and checkout URL; reusing the key with a different body returns 409.

**Settlement**
- A webhook is only a hint. It must carry a valid signature over the raw body (HMAC-SHA512 for Paystack, `verif-hash` for Flutterwave).
- The API then fetches the transaction from the provider and trusts only that response for status, reference, exact amount and NGN currency.
- Each provider event is processed exactly once, in the same transaction as the ledger change, so duplicates and retries return 2xx with no side effects.
- If the provider cannot be reached, the API returns 502 so the provider retries later.

**Results**

| Situation | What happens |
| --- | --- |
| Payment matches and the hold is still valid | Payment `settled`; reservation `confirmed` and `paid` |
| Payment arrives after the hold lapsed or the stay was cancelled | Money recorded as `settled`; reservation not confirmed against possibly resold inventory; `late_success` exception raised |
| Amount mismatch, currency mismatch, provider does not confirm, unknown reference, overpayment | Nothing settles; matching exception queued |

**Staff payments (PRD §4.2)**
- Cash and POS terminal payments settle immediately.
- Bank transfers stay `pending` until an owner or manager confirms them. Confirmation is conditional on the row still being pending, so two simultaneous confirmations cannot double-settle.
- Online payments can only be settled by the provider.
- Overpayments are rejected.
- Pending amounts never count as revenue.

**Restaurant (PRD §4.3)**
- Orders paid by bank transfer stay `pending_payment` and have no receipt until they are confirmed.

**Refunds**
- There is no refund operation anywhere. Resolving an exception records a person's decision and changes nothing else.

**Jobs.** Run both on a schedule. A platform cron (Railway) runs the job script from the API image directly. Any other scheduler can call the HTTP endpoint with `Authorization: Bearer $CRON_SECRET`.

| Endpoint | How often | What it does |
| --- | --- | --- |
| `node dist/scripts/run-job.js expire-payment-holds` or `POST /api/v1/cron/expire-payment-holds` | Every 2–5 minutes | Expires lapsed holds and fails their online payments. Availability already ignores lapsed holds, so a late run never oversells. |
| `node dist/scripts/run-job.js reconcile-payments` or `POST /api/v1/cron/reconcile-payments` | Hourly | Re-applies every successful provider transaction in the window through the same idempotent path as webhooks, so a missed webhook still settles. Also queues bank transfers still pending after the `payments.bank_transfer_review_hours` setting. |

**Provider setup**
1. Set `PUBLIC_WEB_URL` to the web origin. Guests return to `${PUBLIC_WEB_URL}/payment-result?reference=…`.
2. As the owner, open **Settings**:
   - paste the provider's secret key (and, for Flutterwave, the webhook secret hash)
   - choose the provider
   - save, then click **Check saved key**
3. Copy the webhook URL shown in Settings (`${PUBLIC_WEB_URL}/api/v1/webhooks/payments`) into the provider dashboard. The web app forwards it to the API with the raw body intact, so signatures verify.

## Security model

- **Authentication.**
  - Access tokens are 15-minute HS256 JWTs.
  - Refresh tokens are HttpOnly, Secure, SameSite cookies scoped to `/api/v1/auth`. They rotate on every use; reusing an old one after the 30-second grace window revokes the session.
  - Sessions are re-checked on every request through a 60-second Redis cache with immediate revocation markers. If Redis is down, the check falls back to PostgreSQL.
  - Logout, password change, password reset and deactivation take effect immediately.
  - Login is throttled per IP and locked per email+IP pair. An unknown email takes the same time to reject as a wrong password.
- **Authorisation.**
  - Every protected route declares its permission (`app.authorize(...)`), and all data is scoped to the caller's property.
  - Only the owner can create or manage manager, finance and auditor accounts. Nobody can change their own account through the staff endpoints.
  - Temporary passwords lock the account until changed.
  - Payloads are filtered by role:
    - Housekeeping sees no rates or guest details.
    - Only staff managers see personal contact fields.
    - Dashboard money metrics appear only for payment and report readers.
    - Event-stream contents are filtered by permission.
- **Input.**
  - Every route has a JSON schema with unknown properties stripped.
  - Validation failures return 422 with field details.
  - Request bodies and string lengths are capped.
  - All SQL is parameterised.
  - The CSV export neutralises spreadsheet formulas.
- **Transport and abuse.**
  - Helmet headers and HSTS in production.
  - Credentialed CORS restricted to an exact allowlist.
  - CSRF origin checks on the cookie endpoints.
  - Redis-backed rate limits shared across replicas, with stricter per-route limits on login, booking, payment status, setup, exports and jobs.
  - Load shedding when the event loop saturates.
  - Request, handler and keep-alive timeouts.
- **Secrets.**
  - Provider keys appear only in outbound `Authorization` headers.
  - Every secret comparison is constant-time, done on SHA-256 digests.
  - Logs redact credentials, cookies and tokens.
  - Webhook payloads are stored without customer details.
- **Integrity.**
  - A PostgreSQL exclusion constraint makes overlapping active stays for the same room impossible, even under concurrency.
  - Writes take row locks; multi-row stock updates lock in id order to avoid deadlocks.
  - Serialization failures are retried.
  - Audit and outbox rows commit in the same transaction as each change.

## Data and migrations

- PostgreSQL is authoritative. Money is integer kobo, returned as strings. Timestamps are `timestamptz`, and business dates use Africa/Lagos.
- Migrations live in `src/db/migrations` and are listed in `index.ts`:

| Migration | What it does |
| --- | --- |
| `LegacyBaseline` | The original schema, idempotent and irreversible |
| `CreateSettings` | Owner-managed global settings, seeded with defaults |
| `CreateApiSessions` | Refresh-token sessions |
| `BookingIntegrityAndPaymentExceptions` | Exclusion constraint, online-checkout columns, POS lifecycle, the exception queue, and indexes for every list path |

- Before applying `BookingIntegrityAndPaymentExceptions` to an existing database, resolve any genuinely overlapping active reservations; otherwise the migration stops with a constraint error.
- Migrations run as a release step, never on boot. `synchronize` is permanently off.
- Data access uses TypeORM query runners with hand-written, parameterised SQL (`src/db/sql.ts`). The auth tables also use `EntitySchema` entities.

## Operations runbook

**Deploying**
1. Build the image.
2. Run `node dist/scripts/migrate.js up` once.
3. Roll out the replicas behind TLS.
4. Point the readiness probe at `/health/ready`.

**Monitoring.** Scrape `/metrics` with `Authorization: Bearer $METRICS_TOKEN` and alert on:

| Condition | Likely meaning |
| --- | --- |
| `houzzhills_stale_payment_holds > 0` for 15 minutes | The hold-expiry scheduler is not running |
| `rate(houzzhills_payment_webhooks_total{outcome=~"error\|invalid_signature"}[15m]) > 0` | Webhook processing is failing or being probed |
| `houzzhills_open_payment_exceptions > 0` | People need to act on the exception queue |
| 5xx rate or p95 latency on `houzzhills_http_request_duration_seconds` | API errors or slowness |

Logs are structured JSON with a `reqId` on every line. Clients can supply `X-Request-Id`, and every response echoes it.

**If webhooks were missed**
1. Fix the delivery problem.
2. Call `POST /cron/reconcile-payments`. It is safe to repeat.
3. Work through the exception queue.

**Backups**
- Use managed PostgreSQL with point-in-time recovery, or schedule `pg_dump -Fc` at least daily, with copies kept off-site.
- Run Redis with AOF persistence. Redis holds rate-limit state, idempotency records and session caches; losing it never loses money records, because the database keeps its own unique keys.

**Restore drill (quarterly)**
1. Restore the latest backup into a fresh instance.
2. Run `node dist/scripts/migrate.js status`.
3. Start an API against it and check `/health/ready`.
4. Sign in, open the payment register, and compare its totals with the source.
5. Record how long the restore took.

**Retention.** Audit and outbox rows grow without bound. Archive `outbox_events` older than 90 days and `provider_webhook_events` older than 1 year, once they are no longer needed for reconciliation.

## Not implemented yet

These are later scope in PRD §8 P1/P2, or decisions Houzz Hills still has to make:
- guest and staff notifications (email, SMS or WhatsApp)
- MFA
- deposits and partial online payment
- folios and incidentals
- rate plans, promotions and taxes
- supplier purchase orders
- housekeeping task assignment
- automated owner financial reports
- a multi-property tenancy model (the public endpoints serve the first property)

Settlement reconciliation compares provider transactions with local records. Matching against company bank statements remains a manual task, supported by the CSV export.
