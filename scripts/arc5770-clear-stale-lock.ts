import { createDb } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import { issueService } from "../server/src/services/issues.js";

// One-off remediation, same pattern as scripts/arc5774-clear-stale-locks.ts
// (ARC-5774). Clears the dormant scheduled_retry execution lock
// (runId 7ec80244-3ee3-402f-a093-1631650c018e) that is blocking every
// agent-level write on ARC-5770, confirmed stuck via repeated 409s in the
// ARC-5774 thread (comments 2026-08-16T03:28Z / 05:28Z). Uses the same
// tested clearExecutionRunIfTerminal / clearCheckoutRunIfTerminal guard
// functions the PATCH/checkout/release routes rely on (only clears if the
// lock-holding run's status is terminal or scheduled_retry). Scoped to this
// single issue ID only -- no bulk operation.

const TARGET_ISSUE_IDS = [
  "a329efe9-3f6e-4366-9217-647734b439cf", // ARC-5770
];

async function main() {
  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;

  const db = createDb(dbUrl);
  const issues = issueService(db);

  for (const issueId of TARGET_ISSUE_IDS) {
    const clearedExecution = await issues.clearExecutionRunIfTerminal(issueId);
    const clearedCheckout = await issues.clearCheckoutRunIfTerminal(issueId);
    console.log(JSON.stringify({ issueId, clearedExecution, clearedCheckout }));
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`ARC-5770 lock clear failed: ${message}`);
  process.exitCode = 1;
});
