# Houzz Hills Management System

The operations system for Houzz Hills serviced apartments (Kaduna, Nigeria): public booking with online payment, plus the staff and owner workspace. Built to [`docs/PRD.md`](docs/PRD.md).

| Folder | What | Stack |
| --- | --- | --- |
| [`api/`](api) | Backend: auth, bookings, Paystack/Flutterwave checkout and webhooks, payment register and exceptions, rooms, staff, attendance, POS, inventory, owner settings, live events, jobs, metrics | Fastify 5, TypeORM 1, PostgreSQL 16, Redis 7, JWT, OpenAPI |
| [`web/`](web) | Frontend: staff/owner workspace, public booking and payment result pages | Next.js 16, React 19 |
| [`.railway/`](.railway) | Railway infrastructure as code | `railway/iac` |
| [`docs/`](docs) | Product requirements (`PRD.md`) | |

## Run the whole stack locally

```bash
export JWT_ACCESS_SECRET=$(openssl rand -base64 48)
export SETTINGS_ENCRYPTION_KEY=$(openssl rand -base64 32)
export SETUP_SECRET=$(openssl rand -hex 24)
docker compose up --build
```

1. Open <http://localhost:3000/management/setup> and create the owner account with `SETUP_SECRET`.
2. Sign in, then use **Settings** to add Paystack or Flutterwave test keys.
3. Add rooms; public booking is at <http://localhost:3000/reserve>.

To develop each app separately, see [`api/README.md`](api/README.md) and [`web/README.md`](web/README.md).

## Architecture

```text
browser / payment provider ──HTTPS──▶ web (Next.js, public domain)
                                        │  /api/v1/*  forwarded over Railway's private network
                                        ▼
                                      api (Fastify, private only) ──▶ PostgreSQL
                                        ▲                          └─▶ Redis
              cron: expire-payment-holds (every 5 min), reconcile-payments (hourly)
```

The API is never exposed publicly. The browser and the payment provider only talk to the web origin, which keeps the refresh cookie first-party and the API's attack surface minimal.

## Deploying to Railway

You need a Railway account, the repository connected to Railway's GitHub app, and Railway CLI **5.42.1 or newer**.

### 1. Create the project and apply the infrastructure

```bash
npm ci                      # installs the railway/iac types used by .railway/railway.ts
npm run railway:check       # type-checks the infrastructure definition
railway login
railway init                # or: railway link (an existing project)
npm run railway:plan        # preview
npm run railway:apply       # create Postgres, Redis, api, web and the two cron jobs
```

`.railway/railway.ts` declares:

| Resource | What it is |
| --- | --- |
| `postgres`, `redis` | Railway databases |
| `api` | Built from `api/Dockerfile`. Runs migrations as a pre-deploy step, health check `/health/ready`, private networking only. |
| `web` | Built from `web/Dockerfile`. `API_INTERNAL_URL` points at the API's private domain; health check `/management`. |
| `expire-payment-holds` | Cron, `*/5 * * * *`, runs `node dist/scripts/run-job.js expire-payment-holds` |
| `reconcile-payments` | Cron, hourly, runs the reconciliation job |

Change `REPOSITORY` in `.railway/railway.ts` if you deploy from a fork.

### 2. Give the web service a public domain

In the dashboard: **web → Settings → Networking → Generate Domain**, or add a custom domain such as `app.houzzhills.com`. The API's `PUBLIC_WEB_URL` and `CORS_ORIGINS` resolve from it (`https://${{web.RAILWAY_PUBLIC_DOMAIN}}`). Give the API **no** public domain.

### 3. Set the secrets (once per environment)

These are never stored in the repository:

```bash
railway variables --service api \
  --set "JWT_ACCESS_SECRET=$(openssl rand -base64 48)" \
  --set "SETTINGS_ENCRYPTION_KEY=$(openssl rand -base64 32)" \
  --set "SETUP_SECRET=$(openssl rand -hex 24)" \
  --set "METRICS_TOKEN=$(openssl rand -hex 24)"
```

- Keep `SETTINGS_ENCRYPTION_KEY` stable and backed up. If it changes, saved payment keys become unreadable and must be re-entered.
- Redeploy `api` and `web` after setting the variables. The web image bakes `API_INTERNAL_URL` in at build time.

### 4. Go live

1. Open `https://<web-domain>/management/setup` and create the owner with `SETUP_SECRET`. Then remove `SETUP_SECRET` from the API's variables.
2. Sign in as the owner and open **Settings**:
   - Paste the Paystack secret key, or the Flutterwave secret key and webhook hash. Start with test keys.
   - Choose the provider and save, then click **Check saved key**.
   - Copy the webhook URL shown (`https://<web-domain>/api/v1/webhooks/payments`) into the provider dashboard.
3. Add rooms, staff, stock and menu items.
4. Make a test booking at `/reserve`, pay with a provider test card, and confirm that the reservation becomes **confirmed** and the payment appears in the register.
5. Switch to live keys in **Settings** when ready.

**Operations**
- Enable Railway backups for Postgres.
- Scrape `/metrics` through Railway's private network with `METRICS_TOKEN`, and set up the alerts in [`api/README.md`](api/README.md#operations-runbook).

### Without infrastructure as code

Railway marks IaC as beta. The same setup can be done in the dashboard:
1. Add PostgreSQL and Redis.
2. Create services from this repository:
   - **api**: root directory `api`, Dockerfile builder, pre-deploy command `node dist/scripts/migrate.js up`, health check `/health/ready`.
   - **web**: root directory `web`, health check `/management`.
   - Two cron services from `api`, with start commands `node dist/scripts/run-job.js expire-payment-holds` (schedule `*/5 * * * *`) and `node dist/scripts/run-job.js reconcile-payments` (schedule `17 * * * *`).
3. Copy the variables listed in `.railway/railway.ts`.
