import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSshRemoteWorkspaceCapacity,
  estimateLocalDirectoryBytes,
  evaluateRemoteWorkspaceCapacity,
  finalizeSshTerminalWorkspaceRetention,
  resolveSshRemoteWorkspacePolicy,
  terminalWorkspaceMarker,
} from "./remote-workspace-policy.js";

const execFileAsync = promisify(execFile);
const scratchDirs: string[] = [];

async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-workspace-policy-"));
  scratchDirs.push(dir);
  return dir;
}

async function localShell(command: string) {
  // Production retention requires Linux /proc and refuses cleanup otherwise.
  // These scratch-fixture tests run on macOS too; preserve the same cwd/fd loop
  // when /proc exists, but let the isolated fixture exercise the remaining
  // selection/archive/delete path on hosts without /proc.
  const portableCommand = command.replace(
    "if [ ! -d /proc ]; then exit 76; fi",
    "if [ ! -d /proc ]; then :; fi",
  );
  const result = await execFileAsync("sh", ["-c", portableCommand], {
    maxBuffer: 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function makeRun(root: string, runId: string, markerStatus?: string): Promise<string> {
  const runRoot = path.join(root, ".paperclip-runtime", "runs", runId);
  await mkdir(path.join(runRoot, "workspace"), { recursive: true });
  await writeFile(path.join(runRoot, "workspace", "artifact.txt"), `${runId}\n`, "utf8");
  if (markerStatus) {
    await writeFile(
      path.join(runRoot, ".paperclip-terminal"),
      terminalWorkspaceMarker({ runId, status: markerStatus, finalizedAt: new Date() }),
      "utf8",
    );
  }
  return runRoot;
}

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("SSH remote workspace policy", () => {
  it("fails closed when the estimated copy would cross the configured reserve", () => {
    expect(evaluateRemoteWorkspaceCapacity({
      availableBytes: 11_000,
      estimatedWorkspaceBytes: 10_000,
      existingWorkspaceBytes: 0,
      reserveBytes: 2_000,
    })).toMatchObject({ allowed: false, additionalBytes: 10_000, requiredBytes: 12_000 });

    expect(evaluateRemoteWorkspaceCapacity({
      availableBytes: 11_000,
      estimatedWorkspaceBytes: 10_000,
      existingWorkspaceBytes: 4_000,
      reserveBytes: 2_000,
    })).toMatchObject({ allowed: true, additionalBytes: 6_000, requiredBytes: 8_000 });
  });

  it("rejects malformed policy overrides instead of silently disabling the guard", () => {
    expect(() => resolveSshRemoteWorkspacePolicy({
      PAPERCLIP_SSH_WORKSPACE_RESERVE_BYTES: "not-a-number",
    })).toThrow(/must be an integer/);
    expect(() => resolveSshRemoteWorkspacePolicy({
      PAPERCLIP_SSH_TERMINAL_WORKSPACE_KEEP_COUNT: "0",
    })).toThrow(/must be an integer/);
    expect(() => resolveSshRemoteWorkspacePolicy({
      PAPERCLIP_SSH_TERMINAL_WORKSPACE_ARCHIVE_DIR: "relative/archive",
    })).toThrow(/absolute POSIX path/);
  });

  it("estimates only materialized workspace bytes", async () => {
    const root = await scratchDir();
    await mkdir(path.join(root, ".git"), { recursive: true });
    await mkdir(path.join(root, ".paperclip-runtime"), { recursive: true });
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, ".git", "large"), "x".repeat(1000));
    await writeFile(path.join(root, ".paperclip-runtime", "large"), "x".repeat(1000));
    await writeFile(path.join(root, "src", "kept"), "12345");

    await expect(estimateLocalDirectoryBytes({
      localDir: root,
      exclude: [".git", ".paperclip-runtime"],
    })).resolves.toBe(5);
  });

  it("counts dereferenced asset symlinks and honors transfer excludes", async () => {
    const root = await scratchDir();
    const referenced = await scratchDir();
    await writeFile(path.join(referenced, "payload.bin"), "x".repeat(4096));
    await writeFile(path.join(root, "ignored.bin"), "x".repeat(2048));
    await symlink(referenced, path.join(root, "linked-assets"));

    await expect(estimateLocalDirectoryBytes({
      localDir: root,
      exclude: ["ignored.bin"],
      followSymlinks: false,
    })).resolves.toBe(0);
    await expect(estimateLocalDirectoryBytes({
      localDir: root,
      exclude: ["ignored.bin"],
      followSymlinks: true,
    })).resolves.toBe(4096);
  });

  it("runs the reserve probe before materialization and reports a refusal", async () => {
    const root = await scratchDir();
    await writeFile(path.join(root, "payload.bin"), "x".repeat(128));
    await expect(assertSshRemoteWorkspaceCapacity({
      spec: {
        host: "fixture",
        port: 22,
        username: "fixture",
        remoteWorkspacePath: root,
        remoteCwd: root,
        privateKey: null,
        knownHosts: null,
        strictHostKeyChecking: true,
      },
      localDir: root,
      remoteDir: path.join(root, "target"),
      reserveBytes: 1024,
      runCommand: async () => ({ stdout: "capacity\t1000\t0\n", stderr: "" }),
    })).rejects.toThrow(/Refusing remote workspace materialization/);
  });

  it("selects only marked terminal workspaces, excludes current and active paths, and is idempotent", async () => {
    const root = await scratchDir();
    const oldRoot = await makeRun(root, "run-old", "succeeded");
    const activeRoot = await makeRun(root, "run-active");
    const currentRoot = await makeRun(root, "run-current");
    const spec = {
      host: "fixture",
      port: 22,
      username: "fixture",
      remoteWorkspacePath: root,
      remoteCwd: root,
      privateKey: null,
      knownHosts: null,
      strictHostKeyChecking: true,
    } as const;

    const first = await finalizeSshTerminalWorkspaceRetention({
      spec,
      runId: "run-current",
      status: "succeeded",
      finalizedAt: new Date(),
      policy: { reserveBytes: 0, terminalKeepCount: 1, archiveDir: null },
      runCommand: localShell,
    });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ runId: "run-old", sourcePath: oldRoot, archivePath: null });
    await expect(stat(oldRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(activeRoot)).resolves.toBeDefined();
    await expect(stat(currentRoot)).resolves.toBeDefined();

    const second = await finalizeSshTerminalWorkspaceRetention({
      spec,
      runId: "run-current",
      status: "succeeded",
      finalizedAt: new Date(),
      policy: { reserveBytes: 0, terminalKeepCount: 1, archiveDir: null },
      runCommand: localShell,
    });
    expect(second).toEqual([]);
    await expect(stat(activeRoot)).resolves.toBeDefined();
    await expect(stat(currentRoot)).resolves.toBeDefined();
  });

  it("archives exact terminal paths before reclaiming and bounds repeated materialization", async () => {
    const root = await scratchDir();
    const archiveDir = path.join(root, "archive");
    const spec = {
      host: "fixture",
      port: 22,
      username: "fixture",
      remoteWorkspacePath: root,
      remoteCwd: root,
      privateKey: null,
      knownHosts: null,
      strictHostKeyChecking: true,
    } as const;

    for (let index = 1; index <= 5; index += 1) {
      const runId = `run-${index}`;
      await makeRun(root, runId);
      await finalizeSshTerminalWorkspaceRetention({
        spec,
        runId,
        status: "succeeded",
        finalizedAt: new Date(Date.now() + index * 1000),
        policy: { reserveBytes: 0, terminalKeepCount: 1, archiveDir },
        runCommand: localShell,
      });
      const liveRuns = await readdir(path.join(root, ".paperclip-runtime", "runs"));
      expect(liveRuns).toEqual([runId]);
    }

    const archived = (await readdir(archiveDir)).sort();
    expect(archived).toEqual(["run-1", "run-2", "run-3", "run-4"]);
    await expect(readFile(path.join(archiveDir, "run-1", "workspace", "artifact.txt"), "utf8"))
      .resolves.toBe("run-1\n");
  });
});
