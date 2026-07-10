-- Expression + ordering indexes for heartbeat_runs lookups that previously
-- forced full de-TOAST scans of context_snapshot (2026-07-10 incident: the
-- TOAST relation dwarfed the heap and per-issue lookups ran 6s+ each, with
-- enough concurrency to starve every DB-backed route).
-- IF NOT EXISTS: these were created CONCURRENTLY on the incident instance
-- before this migration existed; this is a no-op there and a fast create on
-- fresh databases.
CREATE INDEX IF NOT EXISTS "heartbeat_runs_ctx_issueid_expr_idx" ON "heartbeat_runs" ("company_id", "agent_id", (("context_snapshot"->>'issueId')));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_ctx_taskid_expr_idx" ON "heartbeat_runs" ("company_id", "agent_id", (("context_snapshot"->>'taskId')));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_ctx_taskkey_expr_idx" ON "heartbeat_runs" ("company_id", "agent_id", (("context_snapshot"->>'taskKey')));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_ctx_issueid_expr_idx" ON "heartbeat_runs" ("company_id", (("context_snapshot"->>'issueId')));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_ctx_taskid_expr_idx" ON "heartbeat_runs" ("company_id", (("context_snapshot"->>'taskId')));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_ctx_taskkey_expr_idx" ON "heartbeat_runs" ("company_id", (("context_snapshot"->>'taskKey')));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_created_idx" ON "heartbeat_runs" ("company_id", "created_at" DESC);
