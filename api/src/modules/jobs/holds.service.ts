import type { FastifyInstance } from "fastify";
import { withTransaction } from "../../db/sql.js";
import { expireLapsedHolds } from "../payments/ledger.js";

const BATCH_SIZE = 500;
const MAX_BATCHES = 20;

/** Expires every lapsed checkout hold, in bounded batches so no transaction grows large. */
export async function expireAllLapsedHolds(app: FastifyInstance): Promise<number> {
  let expired = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const count = await withTransaction(app.db, (tx) => expireLapsedHolds(tx, { limit: BATCH_SIZE }));
    expired += count;
    if (count < BATCH_SIZE) break;
  }
  return expired;
}
