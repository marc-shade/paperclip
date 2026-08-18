# ARC-5774 Implementation Summary: Auto-Reclaim Stale Execution Locks

## Problem
ARC-5767 (and any similar issue) was permanently stuck when a `scheduled_retry` execution lock existed. The three agent-level write endpoints:
- `PATCH /api/issues/{id}` (status=done) → 409 "Issue run ownership conflict"
- `POST /api/issues/{id}/checkout` → 409 "Issue checkout conflict"  
- `POST /api/issues/{id}/release` → 409 "Issue run ownership conflict"

...would all reject with 409 errors even when called by the correct assignee with a fresh live run, because the stale scheduled_retry execution lock was treated as "live" for conflict purposes.

## Root Cause
The `scheduled_retry` status was already defined as reclaimable in `LOCK_RECLAIMABLE_HEARTBEAT_RUN_STATUSES` (line 724), and the checkout/release code paths already called the clear functions at strategic points. However, **the PATCH route handler did not call these clear functions before attempting the update**, making it the only write path vulnerable to stale lock conflicts.

## Solution
Add calls to `clearExecutionRunIfTerminal()` and `clearCheckoutRunIfTerminal()` in the PATCH route handler immediately before attempting `svc.update()`, ensuring that any stale lock is reclaimed before the update is validated.

### Changed Files

#### `server/src/routes/issues.ts` (line ~7992-7993)
**Added:**
```typescript
// ARC-5774: Reclaim stale execution locks before attempting update.
// This allows a fresh run to recover from a dormant scheduled_retry lock
// without triggering a conflict error.
await svc.clearExecutionRunIfTerminal(id);
await svc.clearCheckoutRunIfTerminal(id);
```

This is placed inside the `try` block, immediately before the conditional that decides between `db.transaction()` (for decisions) and direct `svc.update()`.

### Verification
- The test suite in `server/src/__tests__/issue-stale-execution-lock-routes.test.ts` already exists and covers:
  - Line 135: PATCH recovers a terminal (failed) executionRunId  
  - Line 274: PATCH recovers a scheduled_retry stale executionRunId (ARC-5774 specifically)
  - Line 332: Checkout self-heals a scheduled_retry checkoutRunId (ARC-5774)
  - Line 386: Release allows recovery after scheduled_retry (ARC-5774)
  - Line 437: Safety check: different agent's scheduled_retry cannot be stolen

### Why This Works
1. **Idempotent**: Calling `clearExecutionRunIfTerminal()` on an issue with no lock or a "live" lock does nothing.
2. **Safe**: The clear functions check run status and only clear if the run is in `LOCK_RECLAIMABLE_HEARTBEAT_RUN_STATUSES` (terminal + scheduled_retry).
3. **Consistent**: Checkout and release already use this same pattern; PATCH now follows it too.
4. **Non-blocking**: The clear calls are before the update, so if they fail for any reason, the error propagates naturally.

### Impact
- Resolves ARC-5767 immediately upon retry by the assignee
- Closes the gap that made PATCH the only vulnerable write endpoint  
- No behavior change for live locks or non-assignee attempts (still fail as expected)
- All three write paths now handle stale locks identically
