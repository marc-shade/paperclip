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

## ARC-5724 injective omitted-key custody repair

Feynman's ARC-5680 re-audit found that ARC-5678 passed an unsafe JavaScript
property-key string directly to Node's SHA-256 update path. Node encodes lone
UTF-16 surrogates as the replacement character U+FFFD, so distinct keys ending
in U+D800 and U+D801 received the same identifier. ARC-5724 replaces that lossy
preimage conversion with an explicitly versioned, domain-separated encoding:

1. UTF-8 bytes of
   `paperclip:heartbeat-omitted-field-key:utf16be:v1` followed by NUL;
2. every property-name UTF-16 code unit, including lone surrogates, encoded as
   one unsigned big-endian 16-bit value;
3. SHA-256 over the concatenation, formatted as `sha256:<lowercase hex>`.

The fixed-width code-unit suffix is injective for all JavaScript strings. The
direct regression independently rebuilds the encoding and proves keys ending in
lone U+D800, U+D801, and U+DC00 produce three distinct identifiers, while also
reproducing the rejected UTF-8 collision for U+D800/U+D801. The selected
embedded-Postgres regression independently rebuilds the same three identifiers,
persists terminal status `succeeded`, and queries raw
`octet_length(result_json::text) <= 65,536`.

The exact 100-NUL-key fixture is unchanged and is now executable-test-bound at
220,813 bytes before compaction and 7,942 bytes after compaction. Focused unit
verification passes 14/14. The selected embedded-Postgres verification passes
2/2 with 3 unrelated tests skipped. `pnpm --filter @paperclipai/server typecheck`
passes. `/Users/marc/ARC-AGI-3/.venv/bin/python
scripts/integration_audit.py --strict` passes with `ORPHAN=0` (`REAL=2`,
`RESEARCH-PENDING=1`, `FALSIFIED=16`, `NON-CANDIDATE=82`). No production
rollout, restart, backfill, database mutation, TOAST reclaim, log truncation,
or service action is authorized by this repair.

## ARC-5678 corrective delta

The ARC-5676 re-audit found that the first correction measured omitted names by
raw UTF-8 bytes. A 253-byte name containing 250 NUL characters costs 1,505 bytes
after JSON escaping, so 100 verbatim identifiers could still overflow the
receipt. ARC-5678 now measures the serialized JSON cost, content-addresses names
that exceed 256 serialized bytes, and never copies content-addressed names back
as PostgreSQL `jsonb` keys. NUL-bearing and unpaired-surrogate names are always
content-addressed because PostgreSQL cannot represent them as `jsonb` strings.

The exact direct reproducer is 220,813 bytes before compaction and 7,942 bytes
after compaction. Its 100 adapter keys are each 253 raw UTF-8 bytes / 1,505 JSON
bytes; the receipt contains `stdout` plus all 100 exact `sha256:<digest>`
identifiers (`omittedFieldCount=101`).

Focused verification on the isolated corrective tree:

- `heartbeat-run-summary.test.ts`: PASS, 14/14.
- Selected embedded-Postgres heartbeat regression: PASS, 1/1 with 3 skipped;
  it asserts raw status `succeeded`, all 100 exact identifiers, and
  `octet_length(result_json::text) <= 65,536`.
- `pnpm --filter @paperclipai/server typecheck`: PASS.
- `/Users/marc/ARC-AGI-3/.venv/bin/python scripts/integration_audit.py --strict`:
  PASS, `ORPHAN=0`.

These checks authorize no rollout. The exact corrective commit/tree and pushed
remote ref are recorded in the ARC-5678 issue handoff and must be independently
re-derived by Feynman before the result can be banked.

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

Omitted field identifiers are themselves bounded: names whose serialized JSON
string costs at most 256 UTF-8 bytes remain readable verbatim, while names with
a larger serialized cost become `sha256:<digest>`. The serialized check is
load-bearing because short raw names can expand sixfold through JSON escaping.
Names containing NUL or unpaired UTF-16 surrogates are content-addressed at any
length because PostgreSQL `jsonb` rejects those otherwise JSON-serializable keys.
The digest preimage is the ARC-5724 domain/version prefix plus the exact UTF-16BE
code-unit sequence, preserving every JavaScript property-key string injectively.
Known stream names are listed separately from up to 100 adapter-controlled names,
and content-addressed names are never copied back as JSONB keys. The 100-key
regression therefore retains the exact content address of every omitted key.
This keeps the receipt size independent of adapter-controlled key shape and
avoids PostgreSQL's rejection of JSON strings containing NUL.

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

A fourth misfire is bounding identifiers by raw UTF-8 length while ignoring JSON
escaping. ARC-5678 reproduces that case with 100 unique 253-byte names, each made
from three ASCII digits plus 250 NUL characters. Each name serializes to 1,505
JSON bytes. Direct and embedded-Postgres regressions require all 100 names to be
content-addressed, require the database run to remain `succeeded`, and measure
`octet_length(result_json::text) <= 65,536` on the raw stored row.

## Blind spots considered

- No production backfill or relation rewrite was run; reclaim timing and WAL
  volume remain unmeasured by design because this issue forbids that mutation.
- No production service restart or canary was run; rollout behavior remains a
  separate confirmation gate.
- PostgreSQL physical TOAST compression means logical JSON bytes do not map
  one-to-one to filesystem bytes. The projection is a conservative logical cap,
  not a physical reclaim claim.
