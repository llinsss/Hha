# Houzz Hills Management — Web

The Next.js 16 staff workspace: owner/manager overview, reservations, rooms, payments, staff, attendance, POS, menu and inventory.

This package is **strictly a frontend**:
- no API routes
- no database access
- no server secrets
- no server-side data fetching

All data flows through one typed client in [`src/lib/api`](src/lib/api). By default that client runs on built-in sample data and makes **zero network requests**.

## Run it

```bash
cp .env.example .env.local   # optional; the defaults run on sample data
npm ci
npm run dev                  # http://localhost:3000/management
```

Sign in with any sample account: `owner@houzzhills.demo`, `manager@…`, `frontdesk@…`, `housekeeping@…`, `cashier@…`, `restaurant@…`, `store@…`, `finance@…` or `auditor@…`. The password for all of them is `houzzhills-demo`. The sign-in screen has one-click buttons for each role, so you can see how the workspace changes per role.

## How the sample data works

- Sample changes are real within the browser tab:
  - bookings, payments and transfer confirmations
  - POS sales, which deduct recipe stock and issue receipts
  - shifts, stock movements, staff onboarding and clocking in/out
- The same rules the backend will enforce apply: permissions, booking overlaps, pending bank transfers, idempotent retries and the forced first-login password change.
- The data persists in `sessionStorage` for that tab, and resets when the tab closes.

## The API client

| File | Purpose |
| --- | --- |
| `src/lib/api/types.ts` | Data contracts shared by the UI and every client |
| `src/lib/api/client.ts` | The `ApiClient` interface and `ApiError` |
| `src/lib/api/sample-client.ts` + `sample-data.ts` | In-browser implementation on sample data (default) |
| `src/lib/api/http.ts` | Implementation for the standalone API in `../api` |
| `src/lib/api/index.ts` | Exports the single `api` instance the UI uses |

Components only ever call `api.<area>.<action>()`, so switching implementations needs no UI changes.

What the HTTP client already handles:
- Bearer access tokens held in memory only.
- Automatic single-flight refresh through the HttpOnly refresh cookie.
- `Idempotency-Key` headers on payment and order writes.
- Timeouts, plus the API's standard error envelope surfaced as `ApiError`.

Paths follow `docs/PRD.md` §7 under `/api/v1`.

### Connecting to the real API

Set `NEXT_PUBLIC_API_BASE_URL` (for example `http://localhost:4000`) and rebuild. Do this only once `../api` serves the endpoints `http.ts` calls. Today only `/api/v1/auth/*` exists there. Until then, leave it empty.

`NEXT_PUBLIC_WEBSITE_URL` controls the link back to the public Houzz Hills website.
