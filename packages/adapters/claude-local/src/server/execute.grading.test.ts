import { afterEach, describe, expect, it, vi } from "vitest";

const { runChildProcess, ensureCommandResolvable, resolveCommandForLogs } = vi.hoisted(() => ({
  runChildProcess: vi.fn(),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "claude"),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    ensureCommandResolvable,
    resolveCommandForLogs,
    runChildProcess,
  };
});

import { execute } from "./execute.js";

function procResult(input: { exitCode: number; stdout: string; stderr?: string }) {
  return {
    exitCode: input.exitCode,
    signal: null,
    timedOut: false,
    stdout: input.stdout,
    stderr: input.stderr ?? "",
    pid: 123,
    startedAt: new Date().toISOString(),
  };
}

function successResultEvent(extra: Record<string, unknown> = {}) {
  return [
    JSON.stringify({ type: "system", subtype: "init", session_id: "s-1", model: "claude-sonnet" }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "s-1",
      result: "Monitor armed. Issue is in_progress with the fallback wakeup.",
      usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
      ...extra,
    }),
  ].join("\n");
}

async function runExecute() {
  return execute({
    runId: "run-grading-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Grading Fixture",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { command: "claude" },
    context: {},
    onLog: async () => {},
  });
}

describe("claude run grading vs process exit code", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("trusts a subtype=success result event over a non-zero process exit code", async () => {
    // Sessions that leave background children behind (armed monitors, orphaned
    // pipes) can make `claude --print` exit non-zero AFTER emitting its final
    // successful result event. The turn's work is complete; grading it failed
    // re-runs the tick and pollutes failure metrics.
    runChildProcess.mockResolvedValueOnce(procResult({ exitCode: 1, stdout: successResultEvent() }));

    const result = await runExecute();

    expect(result.errorMessage).toBeNull();
    expect(result.errorCode ?? null).toBeNull();
    expect(result.exitCode).toBe(0);
    expect((result.resultJson as Record<string, unknown>)?.processExitCode).toBe(1);
  });

  it("still fails when the result event carries is_error=true", async () => {
    runChildProcess.mockResolvedValueOnce(
      procResult({ exitCode: 1, stdout: successResultEvent({ is_error: true }) }),
    );

    const result = await runExecute();

    expect(result.errorMessage).toBeTruthy();
    expect(result.exitCode).toBe(1);
  });

  it("still fails on non-zero exit when no result event was emitted", async () => {
    runChildProcess.mockResolvedValueOnce(
      procResult({ exitCode: 1, stdout: "", stderr: "claude blew up before any result" }),
    );

    const result = await runExecute();

    expect(result.errorMessage).toBeTruthy();
    expect(result.exitCode).toBe(1);
  });

  it("keeps grading zero-exit successful runs as succeeded", async () => {
    runChildProcess.mockResolvedValueOnce(procResult({ exitCode: 0, stdout: successResultEvent() }));

    const result = await runExecute();

    expect(result.errorMessage).toBeNull();
    expect(result.exitCode).toBe(0);
    expect((result.resultJson as Record<string, unknown>)?.processExitCode).toBeUndefined();
  });
});
