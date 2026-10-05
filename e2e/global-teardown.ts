import { clearEverything } from "./support/database.js";
import { removeStaffState } from "./support/staff.js";

/** Leaves the local database and Redis exactly as they were before the run. */
export default async function teardown(): Promise<void> {
  removeStaffState();
  const { redisKeys } = await clearEverything();
  console.log(`e2e cleanup: dropped database and deleted ${redisKeys} Redis keys`);
}
