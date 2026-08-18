import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  budgetPolicies,
  companies,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  heartbeatService,
  isProviderExhaustionFailover,
  messageIndicatesProviderExhaustion,
  parseProviderCascadeOverride,
  providerExhaustionResultJsonPatch,
  readEnabledProviderCascadeEntries,
} from "../services/heartbeat.ts";

const CASCADE_ENV = "PAPERCLIP_PROVIDER_CASCADE";

function withCascadeGateValue(value: string | null) {
  const previous = process.env[CASCADE_ENV];
  if (value === null) {
    delete process.env[CASCADE_ENV];
  } else {
    process.env[CASCADE_ENV] = value;
  }
  return () => {
    if (previous === undefined) delete process.env[CASCADE_ENV];
    else process.env[CASCADE_ENV] = previous;
  };
}

function withCascadeGate(enabled: boolean) {
  return withCascadeGateValue(enabled ? "true" : null);
}

const twoEntryCascade = {
  enabled: true,
  entries: [
    {
      label: "Claude failover",
      enabled: true,
      adapterType: "claude_local",
      adapterConfig: { model: "claude-opus-4-8", command: "claude" },
    },
    {
      label: "DeepSeek failover",
      enabled: true,
      adapterType: "opencode_local",
      adapterConfig: { model: "deepseek/deepseek-v4-pro" },
    },
  ],
};

// ---------------------------------------------------------------------------
// Pure helpers — no database, always run.
// ---------------------------------------------------------------------------

describe("provider cascade pure helpers", () => {
  describe("readEnabledProviderCascadeEntries", () => {
    it("returns enabled entries in order with sequential indices", () => {
      const entries = readEnabledProviderCascadeEntries({ runtimeConfig: { providerCascade: twoEntryCascade } });
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({ index: 0, adapterType: "claude_local" });
      expect(entries[0].adapterConfig).toEqual({ model: "claude-opus-4-8", command: "claude" });
      expect(entries[1]).toMatchObject({ index: 1, adapterType: "opencode_local" });
    });

    it("skips disabled entries and re-indexes the survivors", () => {
      const entries = readEnabledProviderCascadeEntries({
        runtimeConfig: {
          providerCascade: {
            enabled: true,
            entries: [
              { enabled: false, adapterType: "claude_local", adapterConfig: {} },
              { enabled: true, adapterType: "opencode_local", adapterConfig: {} },
            ],
          },
        },
      });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ index: 0, adapterType: "opencode_local" });
    });

    it("skips entries missing an adapterType", () => {
      const entries = readEnabledProviderCascadeEntries({
        runtimeConfig: {
          providerCascade: {
            enabled: true,
            entries: [
              { adapterType: "", adapterConfig: {} },
              { adapterConfig: {} },
              { adapterType: "claude_local", adapterConfig: {} },
            ],
          },
        },
      });
      expect(entries).toHaveLength(1);
      expect(entries[0].adapterType).toBe("claude_local");
    });

    it("returns [] when the cascade is not explicitly enabled", () => {
      expect(
        readEnabledProviderCascadeEntries({
          runtimeConfig: { providerCascade: { entries: twoEntryCascade.entries } },
        }),
      ).toEqual([]);
      expect(
        readEnabledProviderCascadeEntries({
          runtimeConfig: { providerCascade: { enabled: false, entries: twoEntryCascade.entries } },
        }),
      ).toEqual([]);
    });

    it("returns [] when there is no providerCascade", () => {
      expect(readEnabledProviderCascadeEntries({ runtimeConfig: {} })).toEqual([]);
      expect(readEnabledProviderCascadeEntries({ runtimeConfig: null })).toEqual([]);
    });
  });

  describe("isProviderExhaustionFailover", () => {
    it("is true for a usage/credit limit (transient_upstream WITH a reset window)", () => {
      expect(
        isProviderExhaustionFailover({
          errorCode: "codex_transient_upstream",
          resultJson: { errorFamily: "transient_upstream", retryNotBefore: "2026-06-27T18:00:00.000Z" },
        }),
      ).toBe(true);
    });

    it("is false for a transient blip (transient_upstream WITHOUT a reset window)", () => {
      expect(
        isProviderExhaustionFailover({
          errorCode: "codex_transient_upstream",
          resultJson: { errorFamily: "transient_upstream" },
        }),
      ).toBe(false);
    });

    it("is true for a usage-limit wall with NO reset window via the error message", () => {
      // The real codex_local failure: transient_upstream, no retryNotBefore, the
      // usage-limit text only present on the error string.
      expect(
        isProviderExhaustionFailover({
          errorCode: "codex_transient_upstream",
          resultJson: { errorFamily: "transient_upstream" },
          error:
            "You've hit your usage limit. Upgrade to Pro or purchase more credits.",
        }),
      ).toBe(true);
    });

    it("is true for a persisted exhaustion marker even when the error is absent", () => {
      // Layer-2: the finalize decision cannot rely on the in-memory `.error`, so
      // the durable resultJson marker must be sufficient on its own.
      expect(
        isProviderExhaustionFailover({
          errorCode: "codex_transient_upstream",
          resultJson: { errorFamily: "transient_upstream", providerExhausted: true },
          error: null,
        }),
      ).toBe(true);
    });

    it("stays false for a brief 429 blip whose message is not an exhaustion", () => {
      expect(
        isProviderExhaustionFailover({
          errorCode: "codex_transient_upstream",
          resultJson: { errorFamily: "transient_upstream" },
          error: "Upstream returned 429 (server busy); please retry.",
        }),
      ).toBe(false);
    });

    it("does not treat a marker on a non-transient family as exhaustion", () => {
      // The marker only means exhaustion within the transient_upstream family;
      // a stray flag on an unrelated failure must not trigger a provider switch.
      expect(
        isProviderExhaustionFailover({
          errorCode: "adapter_failed",
          resultJson: { providerExhausted: true },
          error: "purchase more credits",
        }),
      ).toBe(false);
    });

    it("is true for an auth wall (claude_auth_required)", () => {
      expect(isProviderExhaustionFailover({ errorCode: "claude_auth_required", resultJson: {} })).toBe(true);
    });

    it("is false for ordinary / non-provider failures", () => {
      expect(isProviderExhaustionFailover({ errorCode: "adapter_failed", resultJson: {} })).toBe(false);
      expect(isProviderExhaustionFailover({ errorCode: "max_turns_exhausted", resultJson: {} })).toBe(false);
      expect(isProviderExhaustionFailover({ errorCode: "timeout", resultJson: {} })).toBe(false);
      expect(isProviderExhaustionFailover({ errorCode: null, resultJson: null })).toBe(false);
    });
  });

  describe("parseProviderCascadeOverride", () => {
    it("parses a well-formed override", () => {
      expect(
        parseProviderCascadeOverride({
          entryIndex: 1,
          adapterType: "claude_local",
          adapterConfig: { model: "claude-opus-4-8" },
        }),
      ).toEqual({ entryIndex: 1, adapterType: "claude_local", adapterConfig: { model: "claude-opus-4-8" } });
    });

    it("fails closed on malformed input", () => {
      expect(parseProviderCascadeOverride(null)).toBeNull();
      expect(parseProviderCascadeOverride({})).toBeNull();
      expect(parseProviderCascadeOverride({ entryIndex: 0 })).toBeNull(); // no adapterType
      expect(parseProviderCascadeOverride({ adapterType: "claude_local", entryIndex: -1 })).toBeNull();
      expect(parseProviderCascadeOverride({ adapterType: "claude_local", entryIndex: "x" })).toBeNull();
    });
  });

  describe("messageIndicatesProviderExhaustion", () => {
    it("matches genuine usage/credit/quota exhaustion messages", () => {
      for (const message of [
        "You've hit your usage limit. Upgrade to Pro or purchase more credits.",
        "You have hit your usage limit.",
        "Out of credits — please add more.",
        "Quota exceeded for this billing period.",
        "insufficient balance to complete the request",
        "Upgrade to Pro to continue.",
      ]) {
        expect(messageIndicatesProviderExhaustion(message)).toBe(true);
      }
    });

    it("does not match brief transient/other failures", () => {
      for (const message of [
        "Upstream returned 429 (server busy); please retry.",
        "connection reset by peer",
        "The model produced no output.",
        "",
        null,
        undefined,
      ]) {
        expect(messageIndicatesProviderExhaustion(message)).toBe(false);
      }
    });
  });

  describe("providerExhaustionResultJsonPatch", () => {
    it("marks a codex usage-limit wall (transient_upstream family from errorCode)", () => {
      expect(
        providerExhaustionResultJsonPatch({
          errorCode: "codex_transient_upstream",
          errorMessage: "You've hit your usage limit. purchase more credits.",
          resultJson: null,
        }),
      ).toEqual({ providerExhausted: true });
    });

    it("marks when the transient family comes from persisted resultJson", () => {
      expect(
        providerExhaustionResultJsonPatch({
          errorCode: "claude_transient_upstream",
          errorMessage: "quota reached for your plan",
          resultJson: { errorFamily: "transient_upstream" },
        }),
      ).toEqual({ providerExhausted: true });
    });

    it("returns null for a transient blip with no exhaustion signature", () => {
      expect(
        providerExhaustionResultJsonPatch({
          errorCode: "codex_transient_upstream",
          errorMessage: "Upstream returned 429 (server busy); please retry.",
          resultJson: null,
        }),
      ).toBeNull();
    });

    it("returns null for a non-transient failure even with an exhaustion-looking message", () => {
      expect(
        providerExhaustionResultJsonPatch({
          errorCode: "adapter_failed",
          errorMessage: "purchase more credits",
          resultJson: null,
        }),
      ).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Engine path — requires embedded Postgres.
// ---------------------------------------------------------------------------

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres provider-cascade tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat provider cascade failover", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let restoreGate: (() => void) | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-provider-cascade-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    restoreGate?.();
    restoreGate = null;
    await db.delete(heartbeatRunEvents);
    await db.delete(environmentLeases);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCascadeFixture(input: {
    runId: string;
    companyId: string;
    agentId: string;
    now: Date;
    errorCode: string;
    error?: string;
    resultJson?: Record<string, unknown> | null;
    cascade?: unknown;
    contextSnapshot?: Record<string, unknown>;
  }) {
    await db.insert(companies).values({
      id: input.companyId,
      name: "Paperclip",
      issuePrefix: `T${input.companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "local-board",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: input.agentId,
      companyId: input.companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.5" },
      runtimeConfig: {
        heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
        ...(input.cascade !== undefined ? { providerCascade: input.cascade } : {}),
      },
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: input.runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      responsibleUserId: "local-board",
      status: "failed",
      error: input.error ?? "usage limit reached",
      errorCode: input.errorCode,
      finishedAt: input.now,
      scheduledRetryAttempt: 0,
      resultJson: input.resultJson ?? {},
      contextSnapshot: input.contextSnapshot ?? { issueId: randomUUID(), wakeReason: "issue_assigned" },
      updatedAt: input.now,
      createdAt: input.now,
    });
  }

  const exhaustionResultJson = {
    errorFamily: "transient_upstream",
    retryNotBefore: "2026-06-27T18:00:00.000Z",
    transientRetryNotBefore: "2026-06-27T18:00:00.000Z",
  };

  async function findEnqueuedCascadeRun(sourceRunId: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, sourceRunId))
      .then((rows) => rows[0] ?? null);
  }

  it("fails over the exhausted primary to the first cascade entry", async () => {
    restoreGate = withCascadeGate(true);
    const runId = randomUUID();
    const issueId = randomUUID();
    await seedCascadeFixture({
      runId,
      companyId: randomUUID(),
      agentId: randomUUID(),
      now: new Date(),
      errorCode: "codex_transient_upstream",
      resultJson: exhaustionResultJson,
      cascade: twoEntryCascade,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });

    const result = await heartbeat.evaluateProviderCascadeFailover(runId);
    expect(result).toEqual({ outcome: "scheduled", entryIndex: 0, adapterType: "claude_local" });

    const enqueued = await findEnqueuedCascadeRun(runId);
    expect(enqueued).toMatchObject({
      status: "scheduled_retry",
      retryOfRunId: runId,
      scheduledRetryReason: "provider_cascade",
    });
    const ctx = enqueued?.contextSnapshot as Record<string, unknown>;
    expect(ctx.providerCascadeOverride).toEqual({
      entryIndex: 0,
      adapterType: "claude_local",
      adapterConfig: { model: "claude-opus-4-8", command: "claude" },
    });
    expect(ctx.forceFreshSession).toBe(true);
    expect(ctx.issueId).toBe(issueId); // carried forward

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.runId, enqueued!.id))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.reason).toBe("provider_cascade_retry");
  });

  it("advances to the next cascade entry when the current fallback also exhausts", async () => {
    restoreGate = withCascadeGate(true);
    const runId = randomUUID();
    await seedCascadeFixture({
      runId,
      companyId: randomUUID(),
      agentId: randomUUID(),
      now: new Date(),
      errorCode: "claude_auth_required",
      resultJson: {},
      cascade: twoEntryCascade,
      contextSnapshot: {
        issueId: randomUUID(),
        wakeReason: "provider_cascade_retry",
        providerCascadeOverride: {
          entryIndex: 0,
          adapterType: "claude_local",
          adapterConfig: { model: "claude-opus-4-8", command: "claude" },
        },
      },
    });

    const result = await heartbeat.evaluateProviderCascadeFailover(runId);
    expect(result).toEqual({ outcome: "scheduled", entryIndex: 1, adapterType: "opencode_local" });

    const enqueued = await findEnqueuedCascadeRun(runId);
    const ctx = enqueued?.contextSnapshot as Record<string, unknown>;
    expect(ctx.providerCascadeOverride).toMatchObject({ entryIndex: 1, adapterType: "opencode_local" });
  });

  it("reports exhausted (and enqueues nothing) once the last entry is reached", async () => {
    restoreGate = withCascadeGate(true);
    const runId = randomUUID();
    await seedCascadeFixture({
      runId,
      companyId: randomUUID(),
      agentId: randomUUID(),
      now: new Date(),
      errorCode: "codex_transient_upstream",
      resultJson: exhaustionResultJson,
      cascade: twoEntryCascade,
      contextSnapshot: {
        issueId: randomUUID(),
        providerCascadeOverride: {
          entryIndex: 1,
          adapterType: "opencode_local",
          adapterConfig: { model: "deepseek/deepseek-v4-pro" },
        },
      },
    });

    const result = await heartbeat.evaluateProviderCascadeFailover(runId);
    expect(result).toEqual({ outcome: "exhausted" });
    expect(await findEnqueuedCascadeRun(runId)).toBeNull();
  });

  it("is a no-op when the gate is off (unchanged engine behavior)", async () => {
    restoreGate = withCascadeGate(false);
    const runId = randomUUID();
    await seedCascadeFixture({
      runId,
      companyId: randomUUID(),
      agentId: randomUUID(),
      now: new Date(),
      errorCode: "codex_transient_upstream",
      resultJson: exhaustionResultJson,
      cascade: twoEntryCascade,
    });

    const result = await heartbeat.evaluateProviderCascadeFailover(runId);
    expect(result).toEqual({ outcome: "not_eligible" });
    expect(await findEnqueuedCascadeRun(runId)).toBeNull();
  });

  it("arms only the listed agent when the gate is an allowlist (test-before-live)", async () => {
    const armedAgentId = randomUUID();
    restoreGate = withCascadeGateValue(armedAgentId);
    const runId = randomUUID();
    await seedCascadeFixture({
      runId,
      companyId: randomUUID(),
      agentId: armedAgentId,
      now: new Date(),
      errorCode: "codex_transient_upstream",
      resultJson: exhaustionResultJson,
      cascade: twoEntryCascade,
    });

    const result = await heartbeat.evaluateProviderCascadeFailover(runId);
    expect(result).toEqual({ outcome: "scheduled", entryIndex: 0, adapterType: "claude_local" });
    expect(await findEnqueuedCascadeRun(runId)).not.toBeNull();
  });

  it("does not arm an agent absent from the allowlist", async () => {
    restoreGate = withCascadeGateValue(randomUUID()); // some other agent id
    const runId = randomUUID();
    await seedCascadeFixture({
      runId,
      companyId: randomUUID(),
      agentId: randomUUID(),
      now: new Date(),
      errorCode: "codex_transient_upstream",
      resultJson: exhaustionResultJson,
      cascade: twoEntryCascade,
    });

    const result = await heartbeat.evaluateProviderCascadeFailover(runId);
    expect(result).toEqual({ outcome: "not_eligible" });
    expect(await findEnqueuedCascadeRun(runId)).toBeNull();
  });

  it("does not fail over a non-exhaustion failure", async () => {
    restoreGate = withCascadeGate(true);
    const runId = randomUUID();
    await seedCascadeFixture({
      runId,
      companyId: randomUUID(),
      agentId: randomUUID(),
      now: new Date(),
      errorCode: "adapter_failed",
      resultJson: {},
      cascade: twoEntryCascade,
    });

    const result = await heartbeat.evaluateProviderCascadeFailover(runId);
    expect(result).toEqual({ outcome: "not_eligible" });
    expect(await findEnqueuedCascadeRun(runId)).toBeNull();
  });

  it("does not fail over an exhausted agent that has no cascade configured", async () => {
    restoreGate = withCascadeGate(true);
    const runId = randomUUID();
    await seedCascadeFixture({
      runId,
      companyId: randomUUID(),
      agentId: randomUUID(),
      now: new Date(),
      errorCode: "codex_transient_upstream",
      resultJson: exhaustionResultJson,
      // no cascade
    });

    const result = await heartbeat.evaluateProviderCascadeFailover(runId);
    expect(result).toEqual({ outcome: "not_eligible" });
    expect(await findEnqueuedCascadeRun(runId)).toBeNull();
  });

  // The regression this fix targets: a real codex usage-limit wall arrives as a
  // transient_upstream failure with the "purchase more credits" text on the error
  // and NO retryNotBefore reset window. Before the fix this fell through to a
  // same-provider transient_failure retry; it must now fail over to claude_local.
  it("fails over a codex usage-limit wall (transient_upstream, NO reset window) to claude_local", async () => {
    restoreGate = withCascadeGate(true);
    const runId = randomUUID();
    const issueId = randomUUID();
    await seedCascadeFixture({
      runId,
      companyId: randomUUID(),
      agentId: randomUUID(),
      now: new Date(),
      errorCode: "codex_transient_upstream",
      error:
        "You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or purchase more credits.",
      // transient_upstream family, but NO retryNotBefore — the codex adapter never
      // populates a reset window on a usage/credit wall.
      resultJson: { errorFamily: "transient_upstream" },
      cascade: twoEntryCascade,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });

    const result = await heartbeat.evaluateProviderCascadeFailover(runId);
    expect(result).toEqual({ outcome: "scheduled", entryIndex: 0, adapterType: "claude_local" });

    const enqueued = await findEnqueuedCascadeRun(runId);
    expect(enqueued).toMatchObject({
      status: "scheduled_retry",
      retryOfRunId: runId,
      scheduledRetryReason: "provider_cascade",
    });
    const ctx = enqueued?.contextSnapshot as Record<string, unknown>;
    expect(ctx.providerCascadeOverride).toEqual({
      entryIndex: 0,
      adapterType: "claude_local",
      adapterConfig: { model: "claude-opus-4-8", command: "claude" },
    });
    expect(ctx.issueId).toBe(issueId);

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.runId, enqueued!.id))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.reason).toBe("provider_cascade_retry");
  });

  // Layer-2 proof: the durable resultJson marker persisted at finalize drives the
  // failover even when the in-memory `.error` is absent at the decision site.
  it("fails over on a persisted exhaustion marker even when the run error is empty", async () => {
    restoreGate = withCascadeGate(true);
    const runId = randomUUID();
    await seedCascadeFixture({
      runId,
      companyId: randomUUID(),
      agentId: randomUUID(),
      now: new Date(),
      errorCode: "codex_transient_upstream",
      error: "", // decision must not depend on .error
      resultJson: { errorFamily: "transient_upstream", providerExhausted: true },
      cascade: twoEntryCascade,
      contextSnapshot: { issueId: randomUUID(), wakeReason: "issue_assigned" },
    });

    const result = await heartbeat.evaluateProviderCascadeFailover(runId);
    expect(result).toEqual({ outcome: "scheduled", entryIndex: 0, adapterType: "claude_local" });
    expect(await findEnqueuedCascadeRun(runId)).not.toBeNull();
  });

  // A brief 429 blip (transient_upstream, no reset window, no exhaustion text) must
  // still take the quick same-provider retry, NOT a full provider switch.
  it("does not fail over a brief transient blip (no reset window, no exhaustion signature)", async () => {
    restoreGate = withCascadeGate(true);
    const runId = randomUUID();
    await seedCascadeFixture({
      runId,
      companyId: randomUUID(),
      agentId: randomUUID(),
      now: new Date(),
      errorCode: "codex_transient_upstream",
      error: "Upstream provider returned 429 (server busy); please retry.",
      resultJson: { errorFamily: "transient_upstream" },
      cascade: twoEntryCascade,
    });

    const result = await heartbeat.evaluateProviderCascadeFailover(runId);
    expect(result).toEqual({ outcome: "not_eligible" });
    expect(await findEnqueuedCascadeRun(runId)).toBeNull();
  });
});
