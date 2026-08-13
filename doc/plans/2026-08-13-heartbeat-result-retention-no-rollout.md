# Heartbeat result retention — no-rollout packet

Date: 2026-08-13

Issue: ARC-5666

Incident parent: ARC-5444

Posture: implementation and local verification only; no production mutation or rollout

## Outcome

Bound future `heartbeat_runs.result_json` writes at 64 KiB of compact JSON
without discarding audit custody. The existing run log remains the authoritative
stdout/stderr record and is already exposed through the authenticated heartbeat
run-log API with a relative ref, byte count, and SHA-256.

## Writer and reader map

- Writer: `server/src/services/heartbeat.ts` finalizes the adapter, finalizes the
  run log, merges stop/recovery/model metadata, and writes terminal `resultJson`.
- Storage policy: `server/src/services/heartbeat-run-summary.ts` detects values
  over 64 KiB, removes duplicated streams, and emits
  `paperclipResultRetention`.
- Detail reader: `GET /api/heartbeat-runs/:runId` keeps small objects unchanged
  and retains the pre-existing safe projection for legacy oversized rows.
- Audit reader: `GET /api/heartbeat-runs/:runId/log` returns the redacted run log
  in bounded ranges. Company access is checked before the log ref is resolved.
- Recovery consumers retain `errorFamily`, retry windows, provider exhaustion,
  stop/timeout metadata, unmanaged-background-task evidence, workspace
  validation, config freshness, model profile, and summary fields.

## Retention contract

For a terminal result whose compact JSON encoding is at most 65,536 bytes, store
the object unchanged. For an oversized object:

1. Remove `stdout` and `stderr` from the database copy.
2. Preserve all other fields when the result now fits.
3. If it still does not fit, retain operational fields first, then add remaining
   top-level fields greedily while staying within the byte ceiling.
4. Persist a marker containing policy version, original byte count and SHA-256,
   stdout/stderr byte counts, omitted keys, and the run-log store/ref/bytes/hash.

Omitted field identifiers are themselves bounded: names at most 256 UTF-8 bytes
remain readable verbatim, while longer names become `sha256:<digest>`. This
keeps the receipt size independent of adapter-controlled key length while still
providing a content-addressed identity for every listed key.

The marker is explicit; callers never mistake a compacted object for a complete
legacy result.

## Compatibility and historical migration

No schema migration is required. This is deliberate:

- Current columns already carry the content-addressed log receipt.
- Small result/API behavior is byte-compatible.
- The existing safe SQL projection keeps historical oversized rows readable.
- An automatic migration rewriting approximately sixty thousand run rows would
  create new heap/TOAST tuples and WAL while the Mac Data volume is already under
  ENOSPC pressure.

Historical rows therefore remain unchanged in this patch. A separate exact
maintenance authorization may later compact only terminal rows that have both
`log_ref` and `log_sha256`, using indexed keyset batches, a measured free-space
reserve, per-batch commit, and before/after relation-size receipts. Rows without
hashed log custody must be skipped, not summarized destructively.

## Storage projection

The incident sample measured mean `result_json` size at 138,992 bytes and maximum
at 1,677,773 bytes. The strict 65,536-byte ceiling reduces the sampled logical
mean by at least 52.9% even under the pessimistic assumption that every result
lands exactly at the ceiling:

`1 - 65,536 / 138,992 = 0.5285`.

The common stdout/stderr-only case is substantially smaller because the database
copy becomes structured metadata plus a receipt rather than a 64 KiB blob. At
the observed 60,811 total run rows, the absolute worst-case logical
`result_json` footprint after a complete eligible backfill would be about 3.71
GiB (`60,811 × 65,536`), versus the incident's approximately 8.83 GiB TOAST
relation. This is a ceiling comparison, not a promise of immediately reclaimed
filesystem blocks; PostgreSQL requires separately authorized maintenance to
return dead-tuple space to the filesystem.

## Rollout gate

No rollout is authorized by this packet. A later rollout must:

1. pin the reviewed commit SHA and verify only the intended files differ;
2. run the focused retention tests and server typecheck on the staged bytes;
3. snapshot database and run-log health plus Data-volume free space;
4. deploy the forward-write policy without historical updates;
5. execute one synthetic oversized terminal run and prove:
   - stored `result_json` is at most 65,536 bytes,
   - summary/recovery fields reproduce,
   - the receipt's log ref is readable through the authenticated API,
   - returned log SHA-256 matches the row;
6. observe at least one normal production heartbeat and compare error rate,
   issue-comment behavior, recovery routing, and per-run TOAST growth.

Historical compaction requires a second, destructive-data confirmation after
the forward-write canary. It must not be bundled into the service rollout.

## Rollback

Rollback is code-only for the forward-write policy: restore the prior server
commit. Already compacted rows remain valid because they are ordinary JSONB and
their full streams remain in run-log custody. Do not attempt to inflate compacted
rows back into PostgreSQL. If a compatibility regression appears, keep the
service on the prior code and read the receipt-bound run log while a corrective
parser is prepared.

## Likely misfire

The patch could appear successful by shrinking API projections while still
writing the full value to PostgreSQL. Verification must inspect the raw stored
row, not only `GET /heartbeat-runs/:runId`, because that endpoint already had a
legacy oversized-value projection.

Another misfire is claiming custody from `log_ref` alone. The rollout proof must
require a readable ref and matching `log_sha256`; a missing or unhashed log is
not an auditable receipt.

A third misfire is bounding values but copying arbitrary adapter key names into
the receipt. A key over 65,536 bytes previously made compaction throw during
finalization and converted an otherwise successful run into a failed run. The
regression suite now executes that shape through the heartbeat service, asserts
the run remains `succeeded`, and inspects the raw stored JSON byte count.

## Blind spots considered

- No production backfill or relation rewrite was run; reclaim timing and WAL
  volume remain unmeasured by design because this issue forbids that mutation.
- No production service restart or canary was run; rollout behavior remains a
  separate confirmation gate.
- PostgreSQL physical TOAST compression means logical JSON bytes do not map
  one-to-one to filesystem bytes. The projection is a conservative logical cap,
  not a physical reclaim claim.
