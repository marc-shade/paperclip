import { describe, it, expect } from "vitest";
import { parseHermesOutput, stripUnraisableShutdownBlocks } from "./execute.js";

// Verbatim stderr shape from failed KineticArc runs (e.g. d72ee4d0, eeb97e0b on
// 2026-07-09): hermes exits 0 but Python prints unraisable-exception blocks for
// parked MCP reconnect coroutines during interpreter shutdown.
const SHUTDOWN_NOISE = `Exception ignored in: <coroutine object MCPServerTask.run at 0x10aa18540>
Traceback (most recent call last):
  File "/Users/marc/.hermes/hermes-agent/tools/mcp_tool.py", line 2590, in run
    parked = await self._wait_for_reconnect_or_shutdown(
             ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/Users/marc/.hermes/hermes-agent/tools/mcp_tool.py", line 1884, in _wait_for_reconnect_or_shutdown
    t.cancel()
  File "/Users/marc/.local/share/uv/python/cpython-3.11.15-macos-aarch64-none/lib/python3.11/asyncio/base_events.py", line 762, in call_soon
    self._check_closed()
  File "/Users/marc/.local/share/uv/python/cpython-3.11.15-macos-aarch64-none/lib/python3.11/asyncio/base_events.py", line 520, in _check_closed
    raise RuntimeError('Event loop is closed')
RuntimeError: Event loop is closed
Exception ignored in: <coroutine object MCPServerTask.run at 0x10aa18680>
Traceback (most recent call last):
  File "/Users/marc/.hermes/hermes-agent/tools/mcp_tool.py", line 2590, in run
    parked = await self._wait_for_reconnect_or_shutdown(
RuntimeError: Event loop is closed
`;

describe("stripUnraisableShutdownBlocks", () => {
  it("removes whole 'Exception ignored in:' blocks", () => {
    expect(stripUnraisableShutdownBlocks(SHUTDOWN_NOISE).trim()).toBe("");
  });

  it("keeps real error lines outside the blocks", () => {
    const mixed = `${SHUTDOWN_NOISE}error: MiniMax API request failed with status 401\n`;
    const stripped = stripUnraisableShutdownBlocks(mixed);
    expect(stripped).toContain("error: MiniMax API request failed with status 401");
    expect(stripped).not.toContain("Event loop is closed");
  });

  it("leaves stderr without such blocks untouched", () => {
    const plain = "some INFO line\nerror: real failure\n";
    expect(stripUnraisableShutdownBlocks(plain)).toBe(plain);
  });
});

describe("parseHermesOutput", () => {
  it("does not flag a successful run whose stderr is only shutdown noise", () => {
    const parsed = parseHermesOutput("All done.\n\nsession_id: abc123def456\n", SHUTDOWN_NOISE);
    expect(parsed.errorMessage).toBeUndefined();
    expect(parsed.sessionId).toBe("abc123def456");
  });

  it("still surfaces genuine stderr errors", () => {
    const parsed = parseHermesOutput("", "error: unknown option '-q'\n");
    expect(parsed.errorMessage).toContain("unknown option '-q'");
  });
});
