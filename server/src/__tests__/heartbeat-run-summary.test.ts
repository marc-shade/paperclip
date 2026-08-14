import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  boundHeartbeatRunResultJsonForStorage,
  summarizeHeartbeatRunResultJson,
  buildHeartbeatRunIssueComment,
  HEARTBEAT_RUN_SAFE_RESULT_JSON_MAX_BYTES,
  mergeHeartbeatRunResultJson,
  planHeartbeatRunResultRetention,
} from "../services/heartbeat-run-summary.js";

const OMITTED_FIELD_HASH_DOMAIN = "paperclip:heartbeat-omitted-field-key:utf16be:v1\0";

function independentlyContentAddressFieldName(field: string) {
  const codeUnits = Buffer.alloc(field.length * 2);
  for (let index = 0; index < field.length; index += 1) {
    codeUnits.writeUInt16BE(field.charCodeAt(index), index * 2);
  }
  return `sha256:${createHash("sha256")
    .update(OMITTED_FIELD_HASH_DOMAIN, "utf8")
    .update(codeUnits)
    .digest("hex")}`;
}

describe("summarizeHeartbeatRunResultJson", () => {
  it("truncates text fields and preserves cost aliases", () => {
    const summary = summarizeHeartbeatRunResultJson({
      summary: "a".repeat(600),
      result: "ok",
      message: "done",
      error: "failed",
      total_cost_usd: 1.23,
      cost_usd: 0.45,
      costUsd: 0.67,
      stopReason: "timeout",
      effectiveTimeoutSec: 30,
      timeoutConfigured: true,
      timeoutFired: true,
      nested: { ignored: true },
    });

    expect(summary).toEqual({
      summary: "a".repeat(500),
      result: "ok",
      message: "done",
      error: "failed",
      total_cost_usd: 1.23,
      cost_usd: 0.45,
      costUsd: 0.67,
      stopReason: "timeout",
      effectiveTimeoutSec: 30,
      timeoutConfigured: true,
      timeoutFired: true,
    });
  });

  it("returns null for non-object and irrelevant payloads", () => {
    expect(summarizeHeartbeatRunResultJson(null)).toBeNull();
    expect(summarizeHeartbeatRunResultJson(["nope"] as unknown as Record<string, unknown>)).toBeNull();
    expect(summarizeHeartbeatRunResultJson({ nested: { only: "ignored" } })).toBeNull();
  });
});

describe("buildHeartbeatRunIssueComment", () => {
  it("uses the final summary text for issue comments on successful runs", () => {
    const comment = buildHeartbeatRunIssueComment({
      summary: "## Summary\n\n- fixed deploy config\n- posted issue update",
    });

    expect(comment).toContain("## Summary");
    expect(comment).toContain("- fixed deploy config");
    expect(comment).not.toContain("Run summary");
  });

  it("falls back to result or message when summary is missing", () => {
    expect(buildHeartbeatRunIssueComment({ result: "done" })).toBe("done");
    expect(buildHeartbeatRunIssueComment({ message: "completed" })).toBe("completed");
  });

  it("returns null when there is no usable final text", () => {
    expect(buildHeartbeatRunIssueComment({ costUsd: 1.2 })).toBeNull();
  });
});

describe("mergeHeartbeatRunResultJson", () => {
  it("adds adapter summaries into stored result json for comment posting", () => {
    const merged = mergeHeartbeatRunResultJson(
      { stdout: "raw stdout", stderr: "" },
      "## Summary\n\n1. first thing\n2. second thing",
    );

    expect(merged).toEqual({
      stdout: "raw stdout",
      stderr: "",
      summary: "## Summary\n\n1. first thing\n2. second thing",
    });
    expect(buildHeartbeatRunIssueComment(merged)).toBe("## Summary\n\n1. first thing\n2. second thing");
  });

  it("creates a result payload when only a summary exists", () => {
    expect(mergeHeartbeatRunResultJson(null, "done")).toEqual({ summary: "done" });
  });

  it("does not overwrite an explicit summary already returned by the adapter", () => {
    expect(
      mergeHeartbeatRunResultJson(
        { summary: "adapter result", stdout: "raw stdout" },
        "fallback summary",
      ),
    ).toEqual({
      summary: "adapter result",
      stdout: "raw stdout",
    });
  });
});

describe("boundHeartbeatRunResultJsonForStorage", () => {
  const receipt = {
    store: "local_file",
    ref: "company/agent/run.ndjson",
    bytes: 2_000_000,
    sha256: "a".repeat(64),
    compressed: false,
  };

  it("leaves small result payloads on the compatibility path", () => {
    expect(planHeartbeatRunResultRetention({ summary: "done", structured: { ok: true } })).toBeNull();
  });

  it("removes duplicated streams while preserving operational metadata and log custody", () => {
    const resultJson = {
      stdout: "stdout-line\n".repeat(20_000),
      stderr: "stderr-line\n".repeat(10_000),
      summary: "completed",
      errorFamily: "provider_quota",
      providerExhausted: true,
      retryNotBefore: "2026-08-14T00:00:00.000Z",
      configFreshness: { version: 1, session: { reset: false } },
    };
    const plan = planHeartbeatRunResultRetention(resultJson);
    expect(plan).not.toBeNull();

    const bounded = boundHeartbeatRunResultJsonForStorage({ resultJson, plan: plan!, receipt });
    const marker = bounded.paperclipResultRetention as Record<string, unknown>;

    expect(bounded).toMatchObject({
      summary: "completed",
      errorFamily: "provider_quota",
      providerExhausted: true,
      retryNotBefore: "2026-08-14T00:00:00.000Z",
      configFreshness: { version: 1, session: { reset: false } },
    });
    expect(bounded).not.toHaveProperty("stdout");
    expect(bounded).not.toHaveProperty("stderr");
    expect(marker).toMatchObject({
      version: "heartbeat_result_retention.v1",
      truncated: true,
      reason: "oversized_result_json",
      omittedFields: ["stdout", "stderr"],
      omittedFieldCount: 2,
      custody: {
        kind: "heartbeat_run_log",
        store: "local_file",
        ref: "company/agent/run.ndjson",
        bytes: 2_000_000,
        sha256: "a".repeat(64),
        compressed: false,
        apiPath: "log",
      },
    });
    expect(marker.originalBytes).toBe(plan?.originalBytes);
    expect(marker.originalSha256).toBe(plan?.originalSha256);
    expect(Buffer.byteLength(JSON.stringify(bounded), "utf8")).toBeLessThanOrEqual(
      HEARTBEAT_RUN_SAFE_RESULT_JSON_MAX_BYTES,
    );
  });

  it("falls back to priority metadata when non-stream fields exceed the byte budget", () => {
    const resultJson = {
      stdout: "x".repeat(80_000),
      summary: "s".repeat(80_000),
      stopReason: "completed",
      timeoutConfigured: false,
      nestedHuge: { payload: "n".repeat(120_000) },
      smallStructured: { kept: true },
    };
    const plan = planHeartbeatRunResultRetention(resultJson)!;
    const bounded = boundHeartbeatRunResultJsonForStorage({ resultJson, plan, receipt });
    const marker = bounded.paperclipResultRetention as Record<string, unknown>;

    expect(bounded.summary).toBe("s".repeat(500));
    expect(bounded.stopReason).toBe("completed");
    expect(bounded.timeoutConfigured).toBe(false);
    expect(bounded).not.toHaveProperty("nestedHuge");
    expect(marker.omittedFields).toEqual(expect.arrayContaining(["stdout", "nestedHuge"]));
    expect(Buffer.byteLength(JSON.stringify(bounded), "utf8")).toBeLessThanOrEqual(
      HEARTBEAT_RUN_SAFE_RESULT_JSON_MAX_BYTES,
    );
  });

  it("content-addresses oversized field names so the retention receipt always fits", () => {
    const oversizedKey = "K".repeat(70_000);
    const resultJson = {
      stdout: "x".repeat(70_000),
      [oversizedKey]: 1,
    };
    const plan = planHeartbeatRunResultRetention(resultJson)!;

    const bounded = boundHeartbeatRunResultJsonForStorage({ resultJson, plan, receipt });
    const marker = bounded.paperclipResultRetention as Record<string, unknown>;
    const expectedIdentifier = independentlyContentAddressFieldName(oversizedKey);

    expect(marker.omittedFields).toEqual(["stdout", expectedIdentifier]);
    expect(JSON.stringify(bounded)).not.toContain(oversizedKey);
    expect(Buffer.byteLength(JSON.stringify(bounded), "utf8")).toBeLessThanOrEqual(
      HEARTBEAT_RUN_SAFE_RESULT_JSON_MAX_BYTES,
    );
  });

  it("bounds omitted identifiers by serialized bytes for JSON-escaped field names", () => {
    const escapedKeys = Array.from(
      { length: 100 },
      (_, index) => `${String(index).padStart(3, "0")}${"\0".repeat(250)}`,
    );
    const resultJson = Object.fromEntries([
      ["stdout", "x".repeat(70_000)],
      ...escapedKeys.map((key) => [key, 1] as const),
    ]);
    expect(Buffer.byteLength(escapedKeys[0]!, "utf8")).toBe(253);
    expect(Buffer.byteLength(JSON.stringify(escapedKeys[0]), "utf8")).toBe(1_505);
    const plan = planHeartbeatRunResultRetention(resultJson)!;
    expect(plan.originalBytes).toBe(220_813);

    const bounded = boundHeartbeatRunResultJsonForStorage({ resultJson, plan, receipt });
    const marker = bounded.paperclipResultRetention as Record<string, unknown>;
    const expectedIdentifiers = escapedKeys.map(independentlyContentAddressFieldName);

    expect(marker.omittedFields).toEqual(["stdout", ...expectedIdentifiers]);
    expect(marker.omittedFieldCount).toBe(101);
    expect(escapedKeys.every((key) => !(key in bounded))).toBe(true);
    expect(marker.originalSha256).toBe(
      createHash("sha256").update(JSON.stringify(resultJson)).digest("hex"),
    );
    expect(Buffer.byteLength(JSON.stringify(bounded), "utf8")).toBe(7_942);
  });

  it("content-addresses every JavaScript key injectively before hashing", () => {
    const unsafeKeys = ["lone-high-\ud800", "lone-high-\ud801", "lone-low-\udc00"];
    const resultJson = Object.fromEntries([
      ["stdout", "x".repeat(70_000)],
      ...unsafeKeys.map((key) => [key, 1] as const),
    ]);
    const plan = planHeartbeatRunResultRetention(resultJson)!;

    const bounded = boundHeartbeatRunResultJsonForStorage({ resultJson, plan, receipt });
    const marker = bounded.paperclipResultRetention as Record<string, unknown>;
    const expectedIdentifiers = unsafeKeys.map(independentlyContentAddressFieldName);

    expect(marker.omittedFields).toEqual(["stdout", ...expectedIdentifiers]);
    expect(new Set(expectedIdentifiers).size).toBe(unsafeKeys.length);
    expect(createHash("sha256").update(unsafeKeys[0]!).digest("hex")).toBe(
      createHash("sha256").update(unsafeKeys[1]!).digest("hex"),
    );
    expect(unsafeKeys.every((key) => !(key in bounded))).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(bounded), "utf8")).toBeLessThanOrEqual(
      HEARTBEAT_RUN_SAFE_RESULT_JSON_MAX_BYTES,
    );
  });
});
