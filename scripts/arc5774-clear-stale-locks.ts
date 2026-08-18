import { createDb } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import { issueService } from "../server/src/services/issues.js";

// One-off remediation for ARC-5774: clears dormant scheduled_retry execution
// locks for the specific issues confirmed stuck in the ARC-5774 thread.
// Uses the same clearExecutionRunIfTerminal / clearCheckoutRunIfTerminal
// logic the PATCH/checkout/release routes already rely on (safety-guarded:
// only clears if the lock-holding run's status is terminal or
// scheduled_retry). Scoped to named issue IDs only -- no bulk operation.

const TARGET_ISSUE_IDS = [
  "4247a58d-9d76-4e46-9a03-f5a6aeeb03b9", // ARC-5767
  "67a5839a-be4a-4cfc-bb5f-c51e5dc1f89b", // ARC-5772
  "6ace47df-6265-4289-b919-e202149b8fb3", // ARC-5773
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
  console.error(`ARC-5774 lock clear failed: ${message}`);
  process.exitCode = 1;
});
