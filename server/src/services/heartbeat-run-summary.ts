import { createHash } from "node:crypto";

export const HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS = 500;
export const HEARTBEAT_RUN_RESULT_OUTPUT_MAX_CHARS = 4_096;
export const HEARTBEAT_RUN_SAFE_RESULT_JSON_MAX_BYTES = 64 * 1024;
export const HEARTBEAT_RUN_RESULT_RETENTION_VERSION = "heartbeat_result_retention.v1";

const HEARTBEAT_RUN_RESULT_RETENTION_FIELD = "paperclipResultRetention";
const HEARTBEAT_RUN_RESULT_STREAM_FIELDS = ["stdout", "stderr"] as const;
const HEARTBEAT_RUN_RESULT_PRIORITY_FIELDS = [
  "summary",
  "result",
  "message",
  "error",
  "nextAction",
  "errorMessage",
  "errorFamily",
  "retryNotBefore",
  "transientRetryNotBefore",
  "providerQuotaRetryNotBefore",
  "providerExhausted",
  "stopReason",
  "timeoutSource",
  "effectiveTimeoutSec",
  "effectiveTimeoutMs",
  "timeoutConfigured",
  "timeoutFired",
  "unmanagedBackgroundTask",
  "workspaceValidation",
  "configFreshness",
  "modelProfile",
] as const;
const HEARTBEAT_RUN_RESULT_PRIORITY_TEXT_FIELDS = new Set([
  "summary",
  "result",
  "message",
  "error",
  "nextAction",
  "errorMessage",
]);
const HEARTBEAT_RUN_RESULT_MAX_RETAINED_TOP_LEVEL_FIELDS = 500;
const HEARTBEAT_RUN_RESULT_MAX_LISTED_OMITTED_TOP_LEVEL_FIELDS = 100;
const HEARTBEAT_RUN_RESULT_MAX_OMITTED_FIELD_IDENTIFIER_JSON_BYTES = 256;
const HEARTBEAT_RUN_RESULT_OMITTED_FIELD_HASH_DOMAIN =
  "paperclip:heartbeat-omitted-field-key:utf16be:v1\0";

export interface HeartbeatRunResultLogReceipt {
  store: string;
  ref: string;
  bytes: number | null;
  sha256: string | null;
  compressed: boolean;
}

export interface HeartbeatRunResultRetentionPlan {
  originalBytes: number;
  originalSha256: string;
  streamBytes: {
    stdout: number;
    stderr: number;
  };
}

function jsonBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function stringBytes(value: unknown) {
  return typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0;
}

export function planHeartbeatRunResultRetention(
  resultJson: Record<string, unknown> | null | undefined,
): HeartbeatRunResultRetentionPlan | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) return null;
  const serialized = JSON.stringify(resultJson);
  const originalBytes = Buffer.byteLength(serialized, "utf8");
  if (originalBytes <= HEARTBEAT_RUN_SAFE_RESULT_JSON_MAX_BYTES) return null;
  return {
    originalBytes,
    originalSha256: createHash("sha256").update(serialized).digest("hex"),
    streamBytes: {
      stdout: stringBytes(resultJson.stdout),
      stderr: stringBytes(resultJson.stderr),
    },
  };
}

function retentionMarker(input: {
  plan: HeartbeatRunResultRetentionPlan;
  receipt: HeartbeatRunResultLogReceipt;
  omittedStreamIdentifiers: string[];
  omittedTopLevelFieldIdentifiers: string[];
}) {
  return {
    version: HEARTBEAT_RUN_RESULT_RETENTION_VERSION,
    truncated: true,
    reason: "oversized_result_json",
    originalBytes: input.plan.originalBytes,
    originalSha256: input.plan.originalSha256,
    streamBytes: input.plan.streamBytes,
    omittedFields: [
      ...input.omittedStreamIdentifiers,
      ...input.omittedTopLevelFieldIdentifiers.slice(
        0,
        HEARTBEAT_RUN_RESULT_MAX_LISTED_OMITTED_TOP_LEVEL_FIELDS,
      ),
    ],
    omittedFieldCount:
      input.omittedStreamIdentifiers.length + input.omittedTopLevelFieldIdentifiers.length,
    custody: {
      kind: "heartbeat_run_log",
      store: input.receipt.store,
      ref: input.receipt.ref,
      bytes: input.receipt.bytes,
      sha256: input.receipt.sha256,
      compressed: input.receipt.compressed,
      apiPath: "log",
    },
  };
}

function isPostgresJsonbFieldNameSafe(field: string) {
  for (let index = 0; index < field.length; index += 1) {
    const codeUnit = field.charCodeAt(index);
    if (codeUnit === 0) return false;
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = field.charCodeAt(index + 1);
      if (!(nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function contentAddressUnsafeOrOversizedFieldName(field: string) {
  if (
    isPostgresJsonbFieldNameSafe(field) &&
    jsonBytes(field) <= HEARTBEAT_RUN_RESULT_MAX_OMITTED_FIELD_IDENTIFIER_JSON_BYTES
  ) {
    return field;
  }
  // Node's default string-to-UTF-8 conversion replaces every lone UTF-16
  // surrogate with U+FFFD. Hash the original code-unit sequence instead so
  // every JavaScript property-key string has one independently reproducible,
  // injective preimage encoding before SHA-256.
  const codeUnits = Buffer.allocUnsafe(field.length * 2);
  for (let index = 0; index < field.length; index += 1) {
    codeUnits.writeUInt16BE(field.charCodeAt(index), index * 2);
  }
  const digest = createHash("sha256")
    .update(HEARTBEAT_RUN_RESULT_OMITTED_FIELD_HASH_DOMAIN, "utf8")
    .update(codeUnits)
    .digest("hex");
  return `sha256:${digest}`;
}

function fitsResultJsonLimit(value: Record<string, unknown>) {
  return jsonBytes(value) <= HEARTBEAT_RUN_SAFE_RESULT_JSON_MAX_BYTES;
}

/**
 * Remove terminal stdout/stderr duplication from an oversized result payload.
 * The complete redacted streams remain under the run's authenticated log API;
 * its ref, byte count, and SHA-256 are embedded in the compacted row.
 *
 * If non-stream adapter metadata is itself oversized, preserve operational
 * fields first and then greedily retain remaining top-level fields while the
 * hard JSON byte budget permits. The receipt identifies every omitted field.
 */
export function boundHeartbeatRunResultJsonForStorage(input: {
  resultJson: Record<string, unknown>;
  plan: HeartbeatRunResultRetentionPlan;
  receipt: HeartbeatRunResultLogReceipt;
}): Record<string, unknown> {
  const withoutStreams: Record<string, unknown> = { ...input.resultJson };
  const omittedStreams: string[] = [];
  for (const field of HEARTBEAT_RUN_RESULT_STREAM_FIELDS) {
    if (field in withoutStreams) {
      delete withoutStreams[field];
      omittedStreams.push(field);
    }
  }
  const omittedUnsafeTopLevelFieldIdentifiers: string[] = [];
  for (const key of Object.keys(withoutStreams)) {
    if (isPostgresJsonbFieldNameSafe(key)) continue;
    delete withoutStreams[key];
    omittedUnsafeTopLevelFieldIdentifiers.push(contentAddressUnsafeOrOversizedFieldName(key));
  }

  const streamOnlyMarker = retentionMarker({
    plan: input.plan,
    receipt: input.receipt,
    omittedStreamIdentifiers: omittedStreams,
    omittedTopLevelFieldIdentifiers: omittedUnsafeTopLevelFieldIdentifiers,
  });
  const streamCompacted = {
    ...withoutStreams,
    [HEARTBEAT_RUN_RESULT_RETENTION_FIELD]: streamOnlyMarker,
  };
  if (fitsResultJsonLimit(streamCompacted)) return streamCompacted;

  const retained: Record<string, unknown> = {};
  const retainedKeys = new Set<string>();
  const sourceEntries = Object.entries(withoutStreams);
  const sourceKeys = sourceEntries.map(([key]) => key);
  const sourceFieldIdentifiers = new Map(
    sourceKeys.map((key) => [key, contentAddressUnsafeOrOversizedFieldName(key)]),
  );
  const worstCaseOmittedTopLevelFieldIdentifiers = [
    ...omittedUnsafeTopLevelFieldIdentifiers,
    ...sourceKeys.map((key) => sourceFieldIdentifiers.get(key)!),
  ];

  const tryRetain = (key: string, value: unknown) => {
    if (retainedKeys.has(key)) return;
    // A content-addressed name is not safe to copy into the JSONB row. Besides
    // its serialized size, PostgreSQL rejects some otherwise valid JSON key
    // shapes (notably strings containing NUL) during jsonb input conversion.
    if (sourceFieldIdentifiers.get(key) !== key) return;
    const nextRetained = { ...retained, [key]: value };
    const candidate = {
      ...nextRetained,
      [HEARTBEAT_RUN_RESULT_RETENTION_FIELD]: retentionMarker({
        plan: input.plan,
        receipt: input.receipt,
        omittedStreamIdentifiers: omittedStreams,
        omittedTopLevelFieldIdentifiers: worstCaseOmittedTopLevelFieldIdentifiers,
      }),
    };
    if (!fitsResultJsonLimit(candidate)) return;
    retained[key] = value;
    retainedKeys.add(key);
  };

  for (const key of HEARTBEAT_RUN_RESULT_PRIORITY_FIELDS) {
    if (!(key in withoutStreams)) continue;
    const value = HEARTBEAT_RUN_RESULT_PRIORITY_TEXT_FIELDS.has(key)
      ? truncateSummaryText(withoutStreams[key])
      : withoutStreams[key];
    if (value !== null) tryRetain(key, value);
  }
  for (const [key, value] of sourceEntries.slice(
    0,
    HEARTBEAT_RUN_RESULT_MAX_RETAINED_TOP_LEVEL_FIELDS,
  )) {
    tryRetain(key, value);
  }

  const omittedTopLevelFieldIdentifiers = [
    ...omittedUnsafeTopLevelFieldIdentifiers,
    ...sourceKeys
      .filter((key) => !retainedKeys.has(key))
      .map((key) => sourceFieldIdentifiers.get(key)!),
  ];
  const bounded = {
    ...retained,
    [HEARTBEAT_RUN_RESULT_RETENTION_FIELD]: retentionMarker({
      plan: input.plan,
      receipt: input.receipt,
      omittedStreamIdentifiers: omittedStreams,
      omittedTopLevelFieldIdentifiers,
    }),
  };

  // The marker is deliberately bounded independently of adapter payload shape;
  // this is a final invariant check, not an expected branch.
  if (!fitsResultJsonLimit(bounded)) {
    throw new Error("Unable to compact heartbeat result JSON within the persistence limit");
  }
  return bounded;
}

function truncateSummaryText(value: unknown, maxLength = HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS) {
  if (typeof value !== "string") return null;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function readNumericField(record: Record<string, unknown>, key: string) {
  return key in record ? record[key] ?? null : undefined;
}

function readCommentText(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function mergeHeartbeatRunResultJson(
  resultJson: Record<string, unknown> | null | undefined,
  summary: string | null | undefined,
): Record<string, unknown> | null {
  const normalizedSummary = readCommentText(summary);
  const baseResult =
    resultJson && typeof resultJson === "object" && !Array.isArray(resultJson)
      ? resultJson
      : null;

  if (!baseResult) {
    return normalizedSummary ? { summary: normalizedSummary } : null;
  }

  if (!normalizedSummary) {
    return baseResult;
  }

  if (readCommentText(baseResult.summary)) {
    return baseResult;
  }

  return {
    ...baseResult,
    summary: normalizedSummary,
  };
}

export function summarizeHeartbeatRunResultJson(
  resultJson: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) {
    return null;
  }

  const summary: Record<string, unknown> = {};
  const textFields = ["summary", "result", "message", "error"] as const;
  for (const key of textFields) {
    const value = truncateSummaryText(resultJson[key]);
    if (value !== null) {
      summary[key] = value;
    }
  }

  const numericFieldAliases = ["total_cost_usd", "cost_usd", "costUsd"] as const;
  for (const key of numericFieldAliases) {
    const value = readNumericField(resultJson, key);
    if (value !== undefined && value !== null) {
      summary[key] = value;
    }
  }

  for (const key of ["stopReason", "timeoutSource"] as const) {
    const value = readCommentText(resultJson[key]);
    if (value !== null) {
      summary[key] = value;
    }
  }

  for (const key of ["effectiveTimeoutSec", "effectiveTimeoutMs"] as const) {
    const value = readNumericField(resultJson, key);
    if (value !== undefined && value !== null) {
      summary[key] = value;
    }
  }

  for (const key of ["timeoutConfigured", "timeoutFired"] as const) {
    if (typeof resultJson[key] === "boolean") {
      summary[key] = resultJson[key];
    }
  }

  return Object.keys(summary).length > 0 ? summary : null;
}

export function buildHeartbeatRunIssueComment(
  resultJson: Record<string, unknown> | null | undefined,
): string | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) {
    return null;
  }

  return (
    readCommentText(resultJson.summary)
    ?? readCommentText(resultJson.result)
    ?? readCommentText(resultJson.message)
    ?? null
  );
}
