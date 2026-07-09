import os from "node:os";
import path from "node:path";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { expect, test } from "vitest";

import { HERMES_CLI } from "../shared/constants.js";
import { resolveHermesCommand } from "./execute.js";
import { testEnvironment } from "./test.js";

test("resolveHermesCommand prefers hermesCommand over command", () => {
  expect(resolveHermesCommand({ hermesCommand: "hermes_maximus", command: "hermes_backup" }))
    .toBe("hermes_maximus");
});

test("resolveHermesCommand falls back to command before default hermes binary", () => {
  expect(resolveHermesCommand({ command: "hermes_maximus" })).toBe("hermes_maximus");
  expect(resolveHermesCommand({})).toBe(HERMES_CLI);
});

// Paperclip keeps adapter_config keys when the adapter type is switched, so a
// leftover `command` from another adapter (e.g. claude_local's "claude") must
// not be spawned with hermes args (KIN-752: `error: unknown option '-q'`).
test("resolveHermesCommand ignores a command leftover from another adapter", () => {
  expect(resolveHermesCommand({ command: "claude" })).toBe(HERMES_CLI);
  expect(resolveHermesCommand({ command: "/usr/local/bin/codex" })).toBe(HERMES_CLI);
  expect(resolveHermesCommand({ command: "Claude" })).toBe(HERMES_CLI);
  // …but an explicit hermesCommand always wins, even if it names another CLI.
  expect(resolveHermesCommand({ hermesCommand: "claude", command: "hermes" })).toBe("claude");
  // Custom hermes wrappers and absolute paths still pass through `command`.
  expect(resolveHermesCommand({ command: "/opt/hermes/bin/hermes" })).toBe("/opt/hermes/bin/hermes");
});

test("testEnvironment accepts config.command when hermesCommand is absent", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hermes-command-resolution-"));
  const cliPath = path.join(tempDir, "fake-hermes");

  try {
    await writeFile(
      cliPath,
      "#!/bin/sh\necho fake-hermes 1.2.3\n",
      "utf8",
    );
    await chmod(cliPath, 0o755);

    const result = await testEnvironment({
      companyId: "company-test",
      adapterType: "hermes_local",
      config: {
        command: cliPath,
      },
    });

    expect(result.status).not.toBe("fail");
    expect(result.checks.some((check) => check.code === "hermes_cli_not_found")).toBe(false);
    expect(result.checks.some(
      (check) => check.code === "hermes_version" && check.message.includes("fake-hermes 1.2.3"),
    )).toBe(true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
