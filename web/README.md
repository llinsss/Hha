# Houzz Hills — Web

The Next.js 16 frontend:

| Path | What it is |
| --- | --- |
| `/management` | The staff and owner workspace |
| `/reserve` | Public booking with hosted checkout |
| `/payment-result` | Where the payment provider returns guests |

It is **strictly a frontend**: there are no API routes and no database access. Every screen reads and writes through the Houzz Hills API (`../api`), using the typed client in `src/lib/api`.

## Run locally

```bash
# 1. Start the API first (see ../api/README.md) on http://localhost:4000
cp .env.example .env.local   # API_INTERNAL_URL=http://localhost:4000
npm ci
npm run dev                  # http://localhost:3000/management
```

The first time, open `/management/setup` and create the owner account with the API's `SETUP_SECRET`.

## How it talks to the API

`next.config.ts` forwards `/api/v1/*` to `API_INTERNAL_URL`. The browser only ever sees the web origin, which has three effects:
- The refresh cookie is first-party: no third-party-cookie blocking, and no CORS.
- The API needs no public domain.
- Payment-provider webhooks use `https://<web-domain>/api/v1/webhooks/payments`, and the raw body reaches the API unchanged.

`API_INTERNAL_URL` is read at build time. To call an API on another origin instead, leave it empty and set `NEXT_PUBLIC_API_BASE_URL`.

| File | Purpose |
| --- | --- |
| `src/lib/api/client.ts` | `ApiClient` interface (every API capability) and `ApiError` |
| `src/lib/api/http.ts` | Implementation: in-memory bearer token, single-flight refresh, `Idempotency-Key` on money writes, full pagination, and a fetch-based live event stream that reconnects with `Last-Event-ID` |
| `src/lib/api/types.ts` | Data contracts |
| `src/lib/permissions.ts` | Role → permission table, mirroring the API (display only; the API enforces it) |
| `src/app/management/workspace/` | The workspace shell and one component per section |

## Workspace sections

Each section appears only for roles with the permission:

| Section | What it covers |
| --- | --- |
| **Overview** | Role-filtered metrics, activity, and stays for today and the next three days |
| **Reservations** | Server-side search, staff bookings, check-in/out, cancellations and no-shows with audited reasons, recording payments |
| **Payments** | Register with settled/pending/failed totals, confirming transfers with a note, CSV export, and the exception queue (owner/manager) |
| **Rooms** | Readiness states, adding rooms, per-room history |
| **Restaurant POS** | Shifts, retry-safe sales, receipts, and creating, editing or archiving menu items with recipes |
| **Inventory** | Items and the stock movement ledger |
| **Team & attendance** | Onboarding (optional server-generated one-time password), employment status, password reset, clock in/out |
| **Settings** (owner only) | Online payment provider (Paystack or Flutterwave) with write-only keys, a key check, the webhook URL to copy, and booking rules |

Live updates refresh the open section whenever anyone commits a change.

## Build

```bash
npm run typecheck && npm run lint && npm run build
```

`output: "standalone"` produces a self-contained server used by the Dockerfile. Production responses carry a CSP, HSTS and anti-framing headers.
