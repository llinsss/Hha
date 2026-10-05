/**
 * Runs one scheduled job in-process and exits, for platform cron services
 * (Railway cron, Kubernetes CronJob):
 *   node dist/scripts/run-job.js expire-payment-holds
 *   node dist/scripts/run-job.js reconcile-payments
 * Exit code 0 on success, 1 on failure so the scheduler can alert.
 */
import { buildApp } from "../app.js";
import { ConfigError, loadConfig } from "../config/env.js";
import { expireAllLapsedHolds } from "../modules/jobs/holds.service.js";
import { reconcilePayments } from "../modules/jobs/reconciliation.service.js";

const JOBS = {
  "expire-payment-holds": async (app: ReturnType<typeof buildApp>) => ({ expired: await expireAllLapsedHolds(app) }),
  "reconcile-payments": (app: ReturnType<typeof buildApp>) => reconcilePayments(app),
} as const;

async function main(): Promise<void> {
  const name = process.argv[2];
  if (!name || !(name in JOBS)) throw new Error(`Usage: run-job <${Object.keys(JOBS).join("|")}>`);
  const app = buildApp(loadConfig());
  await app.ready();
  try {
    const result = await JOBS[name as keyof typeof JOBS](app);
    app.log.info({ job: name, result }, "job completed");
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
});
