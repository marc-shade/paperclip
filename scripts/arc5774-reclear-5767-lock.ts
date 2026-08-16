import { createDb } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import { issueService } from "../server/src/services/issues.js";

// Follow-up remediation for ARC-5774: ARC-5767's dormant scheduled_retry
// lock (d3ef4c5e-e2af-4cf4-a4c8-72fac063c085) re-latched after the first
// clear (documented in the ARC-5774 thread, 2026-08-16T01:18Z: "it was
// clear once before too, then re-latched onto the same dormant run within
// ~30s"). Re-running the same vetted, safety-guarded clear -- if it
// re-latches again, that is itself evidence the durable fix requires the
// live server restart tracked in ARC-5782, not another one-off DB clear.

const TARGET_ISSUE_IDS = [
  "4247a58d-9d76-4e46-9a03-f5a6aeeb03b9", // ARC-5767
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
  console.error(`ARC-5767 re-clear failed: ${message}`);
  process.exitCode = 1;
});
