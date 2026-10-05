# Houzz Hills Management System

The staff management system for Houzz Hills serviced apartments (Kaduna, Nigeria), split into a frontend and a backend as described in [`docs/PRD.md`](docs/PRD.md) §6.

| Folder | What | Stack |
| --- | --- | --- |
| [`web/`](web) | Staff workspace UI, strictly frontend. Runs on built-in sample data until it is pointed at the API; no API routes or database code. | Next.js 16, React 19, Tailwind 4 |
| [`api/`](api) | The backend from `docs/PRD.md`: auth, bookings and hosted checkout, verified payment webhooks, payment register and exceptions, rooms, staff, attendance, POS, inventory, live events, jobs, metrics. | Fastify 5, TypeORM 1, PostgreSQL, Redis, JWT, OpenAPI |
| [`docs/`](docs) | Product requirements and backend handoff (`PRD.md`) | |

Each folder is an independent npm package with its own lockfile, so it can be deployed (or moved into its own repository) separately.

## Getting started

```bash
# Backend
cd api && cp .env.example .env    # set JWT_ACCESS_SECRET
docker compose up -d postgres redis
npm ci && npm run db:migrate && npm run dev     # http://localhost:4000/docs

# Frontend (separate terminal) — runs on sample data, no backend needed
cd web && npm ci && npm run dev                 # http://localhost:3000/management
```

See [`api/README.md`](api/README.md) and [`web/README.md`](web/README.md) for details. Path references in `docs/PRD.md` predate the split: the legacy `src/app/api` routes and `src/lib/server` code have been removed, and their behaviour is being rebuilt in `api/`.
