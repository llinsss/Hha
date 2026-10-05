# Houzz Hills Management System

This repository contains the Houzz Hills staff management portal and the API/database code it currently depends on. It intentionally excludes the public marketing website. Public availability and booking API endpoints remain included because they feed reservations into the same operations and payment records.

## Modules

- Owner/manager overview, reservations, room status, payments and bank-transfer confirmation
- Role-based staff sign-in, staff onboarding and attendance clock-in/out
- Restaurant POS, cashier shifts and paid receipts
- Menu and recipe-linked inventory movements
- Public booking/availability API, Paystack/Flutterwave hosted checkout, verified payment webhook and payment-hold expiry route
- PostgreSQL migrations, audit events and event stream

## Local setup

Requirements: Node.js 20+, npm and PostgreSQL 14+.

1. Copy `.env.example` to `.env.local` and set `DATABASE_URL`; never commit `.env.local`.
2. Set `PAYMENT_PROVIDER=paystack` and a test `PAYSTACK_SECRET_KEY`, or configure the Flutterwave test secret and webhook hash. Online checkout remains unavailable without a provider secret.
3. Run `npm ci`.
4. Run `npm run db:migrate`.
5. Run `npm run dev` and open `/management/setup` for first owner setup.

The app defaults to same-origin API requests for local development. `NEXT_PUBLIC_API_BASE_URL` can point the management frontend at a separately hosted API, but the backend still needs to be extracted from Next.js and configured for credentialed CORS, cookie domain/SameSite, and CSRF protections before that deployment is production ready. `NEXT_PUBLIC_WEBSITE_URL` controls the link back to the public Houzz Hills website.

## Deployment boundary

This is currently a management-only Next.js full-stack codebase, not a completed separate frontend repository and backend service. The management UI and API routes can be built/deployed from this repository today. See [`docs/PRD.md`](docs/PRD.md) for the planned independent API deployment, endpoint catalog, current implementation status, and backend engineer handoff tasks.

Before accepting live payments, configure merchant credentials, provider webhook URL, live bank settlement details, canonical `APP_URL`, and a host scheduler for `POST /api/cron/expire-payment-holds`. Houzz Hills does not issue refunds.
