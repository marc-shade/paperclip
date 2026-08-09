import { promises as fs } from "node:fs";
import path from "node:path";
import {
  runSshCommand,
  shellQuote,
  type SshCommandResult,
  type SshRemoteExecutionSpec,
} from "./ssh.js";

const TERMINAL_RUN_STATUSES = new Set([
  "succeeded",
  "interrupted",
  "failed",
  "cancelled",
  "timed_out",
]);

export const DEFAULT_SSH_WORKSPACE_RESERVE_BYTES = 1024 ** 3;
export const DEFAULT_SSH_TERMINAL_WORKSPACE_KEEP_COUNT = 1;

export interface SshRemoteWorkspacePolicy {
  reserveBytes: number;
  terminalKeepCount: number;
  archiveDir: string | null;
}

export interface RemoteWorkspaceCapacityDecision {
  allowed: boolean;
  availableBytes: number;
  estimatedWorkspaceBytes: number;
  existingWorkspaceBytes: number;
  additionalBytes: number;
  reserveBytes: number;
  requiredBytes: number;
}

export interface RemoteTerminalWorkspaceEntry {
  runId: string;
  markerRunId: string;
  status: string;
  finalizedAtEpochSec: number;
  measuredBytes: number;
  runRootDir: string;
}

export interface RemoteWorkspaceRetentionReceipt {
  runId: string;
  sourcePath: string;
  archivePath: string | null;
  reclaimedBytes: number;
}

type RemoteCommandRunner = (command: string) => Promise<SshCommandResult>;

function parseUnsignedIntegerEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer >= ${minimum}; received ${JSON.stringify(raw)}`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}; received ${JSON.stringify(raw)}`);
  }
  return parsed;
}

export function resolveSshRemoteWorkspacePolicy(
  env: NodeJS.ProcessEnv = process.env,
): SshRemoteWorkspacePolicy {
  const archiveDir = env.PAPERCLIP_SSH_TERMINAL_WORKSPACE_ARCHIVE_DIR?.trim() || null;
  if (archiveDir && !path.posix.isAbsolute(archiveDir)) {
    throw new Error("PAPERCLIP_SSH_TERMINAL_WORKSPACE_ARCHIVE_DIR must be an absolute POSIX path");
  }
  return {
    reserveBytes: parseUnsignedIntegerEnv(
      env,
      "PAPERCLIP_SSH_WORKSPACE_RESERVE_BYTES",
      DEFAULT_SSH_WORKSPACE_RESERVE_BYTES,
      0,
    ),
    terminalKeepCount: parseUnsignedIntegerEnv(
      env,
      "PAPERCLIP_SSH_TERMINAL_WORKSPACE_KEEP_COUNT",
      DEFAULT_SSH_TERMINAL_WORKSPACE_KEEP_COUNT,
      1,
    ),
    archiveDir,
  };
}

export async function estimateLocalDirectoryBytes(input: {
  localDir: string;
  exclude?: string[];
  followSymlinks?: boolean;
}): Promise<number> {
  const regexes = ["._*", ...(input.exclude ?? [])].map((pattern) => {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]");
    return new RegExp(`^${escaped}$`);
  });
  const isExcluded = (relativePath: string, baseName: string) =>
    regexes.some((regex) => regex.test(relativePath) || regex.test(baseName));
  let total = 0;

  const walk = async (dir: string, relative: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (isExcluded(entryRelative, entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      const stat = await (input.followSymlinks ? fs.stat(fullPath) : fs.lstat(fullPath));
      if (stat.isDirectory()) {
        await walk(fullPath, entryRelative);
      } else if (stat.isFile()) {
        total += stat.size;
      }
    }
  };

  await walk(input.localDir, "");
  return total;
}

export function evaluateRemoteWorkspaceCapacity(input: {
  availableBytes: number;
  estimatedWorkspaceBytes: number;
  existingWorkspaceBytes: number;
  reserveBytes: number;
}): RemoteWorkspaceCapacityDecision {
  for (const [name, value] of Object.entries(input)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name} must be a non-negative safe integer`);
    }
  }
  const additionalBytes = Math.max(0, input.estimatedWorkspaceBytes - input.existingWorkspaceBytes);
  const requiredBytes = additionalBytes + input.reserveBytes;
  return {
    allowed: input.availableBytes >= requiredBytes,
    ...input,
    additionalBytes,
    requiredBytes,
  };
}

function parseCapacityProbe(stdout: string): { availableBytes: number; existingWorkspaceBytes: number } {
  const line = stdout.trim().split(/\r?\n/).at(-1) ?? "";
  const match = /^capacity\t(\d+)\t(\d+)$/.exec(line);
  if (!match) {
    throw new Error(`Remote workspace capacity probe returned an invalid receipt: ${JSON.stringify(line)}`);
  }
  const availableBytes = Number(match[1]);
  const existingWorkspaceBytes = Number(match[2]);
  if (!Number.isSafeInteger(availableBytes) || !Number.isSafeInteger(existingWorkspaceBytes)) {
    throw new Error("Remote workspace capacity probe exceeded safe integer range");
  }
  return { availableBytes, existingWorkspaceBytes };
}

export async function assertSshRemoteWorkspaceCapacity(input: {
  spec: SshRemoteExecutionSpec;
  localDir: string;
  remoteDir: string;
  reserveBytes: number;
  exclude?: string[];
  followSymlinks?: boolean;
  runCommand?: RemoteCommandRunner;
}): Promise<RemoteWorkspaceCapacityDecision> {
  const estimatedWorkspaceBytes = await estimateLocalDirectoryBytes({
    localDir: input.localDir,
    // Git-backed SSH materialization sends history as a bundle before the
    // workspace overlay. Counting .git may overestimate compressed transfer
    // bytes, but it keeps the admission decision fail-closed for the extracted
    // remote footprint.
    exclude: [".paperclip-runtime", ...(input.exclude ?? [])],
    followSymlinks: input.followSymlinks,
  });
  const command = [
    "set -eu",
    `target=${shellQuote(input.remoteDir)}`,
    'anchor="$target"',
    'while [ ! -e "$anchor" ]; do next=$(dirname "$anchor"); [ "$next" != "$anchor" ] || exit 71; anchor="$next"; done',
    'available_kib=$(df -Pk "$anchor" | awk \'NR == 2 { print $4 }\')',
    '[ -n "$available_kib" ] || exit 72',
    'existing_kib=0',
    '[ ! -e "$target" ] || existing_kib=$(du -sk "$target" | awk \'{ print $1 }\')',
    'printf "capacity\\t%s\\t%s\\n" "$((available_kib * 1024))" "$((existing_kib * 1024))"',
  ].join("\n");
  const result = await (input.runCommand ?? ((remoteCommand) => runSshCommand(input.spec, remoteCommand, {
    timeoutMs: 30_000,
    maxBuffer: 16 * 1024,
  })))(command);
  const probe = parseCapacityProbe(result.stdout);
  const decision = evaluateRemoteWorkspaceCapacity({
    ...probe,
    estimatedWorkspaceBytes,
    reserveBytes: input.reserveBytes,
  });
  if (!decision.allowed) {
    throw new Error(
      `Refusing remote workspace materialization at ${input.remoteDir}: ` +
      `${decision.availableBytes} bytes available, ${decision.additionalBytes} additional bytes estimated, ` +
      `${decision.reserveBytes} bytes reserved (need ${decision.requiredBytes})`,
    );
  }
  return decision;
}

function assertSafeRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) {
    throw new Error(`Unsafe remote workspace run id: ${JSON.stringify(runId)}`);
  }
}

export function terminalWorkspaceMarker(input: {
  runId: string;
  status: string;
  finalizedAt: Date;
}): string {
  assertSafeRunId(input.runId);
  if (!TERMINAL_RUN_STATUSES.has(input.status)) {
    throw new Error(`Cannot mark nonterminal run status ${JSON.stringify(input.status)}`);
  }
  return [
    `run_id=${input.runId}`,
    `status=${input.status}`,
    `finalized_at=${input.finalizedAt.toISOString()}`,
    "",
  ].join("\n");
}

export function buildRemoteTerminalWorkspaceInventoryCommand(runsRootDir: string): string {
  return [
    "set -eu",
    `runs_root=${shellQuote(runsRootDir)}`,
    '[ -d "$runs_root" ] || exit 0',
    'for run_root in "$runs_root"/*; do',
    '  [ -d "$run_root" ] || continue',
    '  marker="$run_root/.paperclip-terminal"',
    '  [ -f "$marker" ] || continue',
    '  run_id=${run_root##*/}',
    '  marker_run_id=$(sed -n \'s/^run_id=//p\' "$marker" | head -n 1)',
    '  marker_status=$(sed -n \'s/^status=//p\' "$marker" | head -n 1)',
    '  finalized_epoch=$(stat -c %Y "$marker" 2>/dev/null || stat -f %m "$marker")',
    '  measured_bytes=$(du -sb "$run_root" 2>/dev/null | awk \'{ print $1 }\' || true)',
    '  if [ -z "$measured_bytes" ]; then measured_bytes=$(( $(du -sk "$run_root" | awk \'{ print $1 }\') * 1024 )); fi',
    '  printf "workspace\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "$run_id" "$marker_run_id" "$marker_status" "$finalized_epoch" "$measured_bytes" "$run_root"',
    'done',
  ].join("\n");
}

export function parseRemoteTerminalWorkspaceInventory(stdout: string): RemoteTerminalWorkspaceEntry[] {
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const fields = line.split("\t");
      if (fields.length !== 7 || fields[0] !== "workspace") {
        throw new Error(`Invalid remote workspace inventory receipt: ${JSON.stringify(line)}`);
      }
      const finalizedAtEpochSec = Number(fields[4]);
      const measuredBytes = Number(fields[5]);
      if (!Number.isSafeInteger(finalizedAtEpochSec) || !Number.isSafeInteger(measuredBytes)) {
        throw new Error(`Invalid numeric remote workspace inventory receipt: ${JSON.stringify(line)}`);
      }
      return {
        runId: fields[1]!,
        markerRunId: fields[2]!,
        status: fields[3]!,
        finalizedAtEpochSec,
        measuredBytes,
        runRootDir: fields[6]!,
      };
    });
}

export function selectTerminalWorkspacePruneCandidates(input: {
  entries: RemoteTerminalWorkspaceEntry[];
  currentRunId: string;
  keepCount: number;
  runsRootDir: string;
}): RemoteTerminalWorkspaceEntry[] {
  if (!Number.isSafeInteger(input.keepCount) || input.keepCount < 1) {
    throw new Error("Remote terminal workspace keep count must be >= 1");
  }
  const rootPrefix = input.runsRootDir.endsWith("/") ? input.runsRootDir : `${input.runsRootDir}/`;
  const eligible = input.entries.filter((entry) =>
    entry.runId !== input.currentRunId &&
    entry.markerRunId === entry.runId &&
    TERMINAL_RUN_STATUSES.has(entry.status) &&
    entry.runRootDir === path.posix.join(input.runsRootDir, entry.runId) &&
    entry.runRootDir.startsWith(rootPrefix),
  );
  const terminalCount = input.entries.filter((entry) =>
    entry.markerRunId === entry.runId &&
    TERMINAL_RUN_STATUSES.has(entry.status) &&
    entry.runRootDir === path.posix.join(input.runsRootDir, entry.runId),
  ).length;
  const pruneCount = Math.max(0, terminalCount - input.keepCount);
  return eligible
    .sort((a, b) => a.finalizedAtEpochSec - b.finalizedAtEpochSec || a.runId.localeCompare(b.runId))
    .slice(0, pruneCount);
}

function buildRemoteWorkspacePruneCommand(input: {
  entry: RemoteTerminalWorkspaceEntry;
  runsRootDir: string;
  archiveDir: string | null;
}): string {
  const source = input.entry.runRootDir;
  const marker = path.posix.join(source, ".paperclip-terminal");
  const archivePath = input.archiveDir ? path.posix.join(input.archiveDir, input.entry.runId) : null;
  if (archivePath && (archivePath === input.runsRootDir || archivePath.startsWith(`${input.runsRootDir}/`))) {
    throw new Error("Remote terminal workspace archive directory must be outside the managed runs root");
  }
  return [
    "set -eu",
    `source_root=${shellQuote(source)}`,
    `marker=${shellQuote(marker)}`,
    `expected_run_id=${shellQuote(input.entry.runId)}`,
    `expected_status=${shellQuote(input.entry.status)}`,
    '[ -d "$source_root" ] && [ -f "$marker" ] || exit 73',
    'actual_run_id=$(sed -n \'s/^run_id=//p\' "$marker" | head -n 1)',
    'actual_status=$(sed -n \'s/^status=//p\' "$marker" | head -n 1)',
    '[ "$actual_run_id" = "$expected_run_id" ] && [ "$actual_status" = "$expected_status" ] || exit 74',
    'busy=0',
    'if [ ! -d /proc ]; then exit 76; fi',
    'for proc_root in /proc/[0-9]*; do',
    '  proc_cwd=$(readlink "$proc_root/cwd" 2>/dev/null || true)',
    '  case "$proc_cwd" in "$source_root"|"$source_root"/*) busy=1; break ;; esac',
    '  open_fd=$(find "$proc_root/fd" -maxdepth 1 -lname "$source_root/*" -print -quit 2>/dev/null || true)',
    '  [ -z "$open_fd" ] || { busy=1; break; }',
    'done',
    '[ "$busy" -eq 0 ] || exit 75',
    'measured_bytes=$(du -sb "$source_root" 2>/dev/null | awk \'{ print $1 }\' || true)',
    'if [ -z "$measured_bytes" ]; then measured_bytes=$(( $(du -sk "$source_root" | awk \'{ print $1 }\') * 1024 )); fi',
    ...(archivePath
      ? [
          `archive_path=${shellQuote(archivePath)}`,
          `archive_root=${shellQuote(input.archiveDir!)}`,
          'mkdir -p "$archive_root"',
          '[ ! -e "$archive_path" ] || exit 77',
          'archive_tmp="$archive_root/.paperclip-archive-$expected_run_id-$$"',
          'trap \'rm -rf "$archive_tmp"\' EXIT',
          'cp -a "$source_root" "$archive_tmp"',
          'diff -qr "$source_root" "$archive_tmp" >/dev/null',
          'mv "$archive_tmp" "$archive_path"',
          'rm -rf "$source_root"',
          'trap - EXIT',
          'printf "reclaimed\\t%s\\t%s\\t%s\\t%s\\n" "$expected_run_id" "$source_root" "$measured_bytes" "$archive_path"',
        ]
      : [
          'rm -rf "$source_root"',
          'printf "reclaimed\\t%s\\t%s\\t%s\\t-\\n" "$expected_run_id" "$source_root" "$measured_bytes"',
        ]),
  ].join("\n");
}

function parseRetentionReceipt(stdout: string): RemoteWorkspaceRetentionReceipt {
  const line = stdout.trim().split(/\r?\n/).at(-1) ?? "";
  const fields = line.split("\t");
  if (fields.length !== 5 || fields[0] !== "reclaimed") {
    throw new Error(`Invalid remote workspace retention receipt: ${JSON.stringify(line)}`);
  }
  const reclaimedBytes = Number(fields[3]);
  if (!Number.isSafeInteger(reclaimedBytes) || reclaimedBytes < 0) {
    throw new Error(`Invalid reclaimed byte count: ${JSON.stringify(fields[3])}`);
  }
  return {
    runId: fields[1]!,
    sourcePath: fields[2]!,
    reclaimedBytes,
    archivePath: fields[4] === "-" ? null : fields[4]!,
  };
}

export async function finalizeSshTerminalWorkspaceRetention(input: {
  spec: SshRemoteExecutionSpec;
  runId: string;
  status: string;
  finalizedAt: Date;
  policy?: SshRemoteWorkspacePolicy;
  runCommand?: RemoteCommandRunner;
}): Promise<RemoteWorkspaceRetentionReceipt[]> {
  assertSafeRunId(input.runId);
  const markerBody = terminalWorkspaceMarker(input);
  const policy = input.policy ?? resolveSshRemoteWorkspacePolicy();
  const runsRootDir = path.posix.join(input.spec.remoteCwd, ".paperclip-runtime", "runs");
  const currentRunRoot = path.posix.join(runsRootDir, input.runId);
  const markerPath = path.posix.join(currentRunRoot, ".paperclip-terminal");
  const runner = input.runCommand ?? ((remoteCommand) => runSshCommand(input.spec, remoteCommand, {
    timeoutMs: 120_000,
    maxBuffer: 1024 * 1024,
  }));

  await runner([
    "set -eu",
    `run_root=${shellQuote(currentRunRoot)}`,
    `marker=${shellQuote(markerPath)}`,
    '[ -d "$run_root" ] || exit 73',
    'marker_tmp="$marker.tmp-$$"',
    'trap \'rm -f "$marker_tmp"\' EXIT',
    `printf %s ${shellQuote(markerBody)} > "$marker_tmp"`,
    'mv "$marker_tmp" "$marker"',
    'trap - EXIT',
  ].join("\n"));

  const inventoryResult = await runner(buildRemoteTerminalWorkspaceInventoryCommand(runsRootDir));
  const candidates = selectTerminalWorkspacePruneCandidates({
    entries: parseRemoteTerminalWorkspaceInventory(inventoryResult.stdout),
    currentRunId: input.runId,
    keepCount: policy.terminalKeepCount,
    runsRootDir,
  });

  const receipts: RemoteWorkspaceRetentionReceipt[] = [];
  for (const entry of candidates) {
    const result = await runner(buildRemoteWorkspacePruneCommand({
      entry,
      runsRootDir,
      archiveDir: policy.archiveDir,
    }));
    receipts.push(parseRetentionReceipt(result.stdout));
  }
  return receipts;
}
