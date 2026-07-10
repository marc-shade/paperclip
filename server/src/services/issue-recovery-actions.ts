import { and, desc, eq, exists, inArray, isNotNull, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueRecoveryActions, issues } from "@paperclipai/db";
import type {
  IssueRecoveryAction,
  IssueRecoveryActionKind,
  IssueRecoveryActionOwnerType,
  IssueRecoveryActionOutcome,
  IssueRecoveryActionStatus,
} from "@paperclipai/shared";

const ACTIVE_RECOVERY_ACTION_STATUSES = ["active", "escalated"] as const satisfies readonly IssueRecoveryActionStatus[];
const TERMINAL_SOURCE_ISSUE_STATUSES = ["done", "cancelled"] as const;
const MAX_UPSERT_RETRIES = 3;

export const TERMINAL_SOURCE_REAP_NOTE =
  "Auto-resolved by recovery reaper: source issue reached a terminal state (done/cancelled), so the recovery action no longer has anything to recover.";
export const TIMED_OUT_REAP_NOTE =
  "Auto-resolved by recovery reaper: recovery action passed its timeoutAt without resolution.";

export type ReapedRecoveryAction = {
  id: string;
  companyId: string;
  sourceIssueId: string;
  kind: IssueRecoveryActionKind;
  reason: "terminal_source_issue" | "timed_out";
};

export type ReapResolvableActionsResult = {
  terminalResolved: number;
  timedOutResolved: number;
  resolved: number;
  reaped: ReapedRecoveryAction[];
};

type IssueRecoveryActionRow = typeof issueRecoveryActions.$inferSelect;
type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbOrTransaction = Db | DbTransaction;

export type UpsertIssueRecoveryActionInput = {
  companyId: string;
  sourceIssueId: string;
  recoveryIssueId?: string | null;
  kind: IssueRecoveryActionKind;
  ownerType?: IssueRecoveryActionOwnerType;
  ownerAgentId?: string | null;
  ownerUserId?: string | null;
  previousOwnerAgentId?: string | null;
  returnOwnerAgentId?: string | null;
  cause: string;
  fingerprint: string;
  evidence?: Record<string, unknown>;
  nextAction: string;
  wakePolicy?: Record<string, unknown> | null;
  monitorPolicy?: Record<string, unknown> | null;
  maxAttempts?: number | null;
  timeoutAt?: Date | null;
  lastAttemptAt?: Date | null;
};

export type ResolveIssueRecoveryActionInput = {
  companyId: string;
  sourceIssueId: string;
  actionId?: string | null;
  kind?: IssueRecoveryActionKind | null;
  cause?: string | null;
  fingerprint?: string | null;
  status: Extract<IssueRecoveryActionStatus, "resolved" | "cancelled">;
  outcome: IssueRecoveryActionOutcome;
  resolutionNote?: string | null;
};

function toReadModel(row: IssueRecoveryActionRow): IssueRecoveryAction {
  return {
    id: row.id,
    companyId: row.companyId,
    sourceIssueId: row.sourceIssueId,
    recoveryIssueId: row.recoveryIssueId,
    kind: row.kind as IssueRecoveryAction["kind"],
    status: row.status as IssueRecoveryAction["status"],
    ownerType: row.ownerType as IssueRecoveryAction["ownerType"],
    ownerAgentId: row.ownerAgentId,
    ownerUserId: row.ownerUserId,
    previousOwnerAgentId: row.previousOwnerAgentId,
    returnOwnerAgentId: row.returnOwnerAgentId,
    cause: row.cause,
    fingerprint: row.fingerprint,
    evidence: row.evidence,
    nextAction: row.nextAction,
    wakePolicy: row.wakePolicy,
    monitorPolicy: row.monitorPolicy,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    timeoutAt: row.timeoutAt,
    lastAttemptAt: row.lastAttemptAt,
    outcome: row.outcome as IssueRecoveryAction["outcome"],
    resolutionNote: row.resolutionNote,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isUniqueRecoveryActionConflict(error: unknown) {
  const maybe = error as { code?: string; constraint?: string; message?: string } | null;
  return Boolean(
    maybe &&
      maybe.code === "23505" &&
      (
        maybe.constraint === "issue_recovery_actions_active_source_uq" ||
        maybe.constraint === "issue_recovery_actions_active_fingerprint_uq" ||
        typeof maybe.message === "string" && (
          maybe.message.includes("issue_recovery_actions_active_source_uq") ||
          maybe.message.includes("issue_recovery_actions_active_fingerprint_uq")
        )
      ),
  );
}

export function issueRecoveryActionService(db: Db) {
  const upsertQueues = new Map<string, Promise<void>>();

  async function runExclusiveUpsert<T>(
    input: UpsertIssueRecoveryActionInput,
    task: () => Promise<T>,
  ): Promise<T> {
    const key = `${input.companyId}:${input.sourceIssueId}`;
    const previous = upsertQueues.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.catch(() => undefined).then(() => current);
    upsertQueues.set(key, next);

    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (upsertQueues.get(key) === next) {
        upsertQueues.delete(key);
      }
    }
  }

  async function getActiveForIssue(companyId: string, sourceIssueId: string): Promise<IssueRecoveryAction | null> {
    const row = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, sourceIssueId),
          inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
        ),
      )
      .orderBy(desc(issueRecoveryActions.updatedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return row ? toReadModel(row) : null;
  }

  async function listActiveForIssues(companyId: string, sourceIssueIds: string[]) {
    if (sourceIssueIds.length === 0) return new Map<string, IssueRecoveryAction>();
    const rows = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          inArray(issueRecoveryActions.sourceIssueId, [...new Set(sourceIssueIds)]),
          inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
        ),
      )
      .orderBy(desc(issueRecoveryActions.updatedAt));
    const result = new Map<string, IssueRecoveryAction>();
    for (const row of rows) {
      if (!result.has(row.sourceIssueId)) result.set(row.sourceIssueId, toReadModel(row));
    }
    return result;
  }

  async function retryUpsertSourceScoped(
    input: UpsertIssueRecoveryActionInput,
    retryCount: number,
    error?: unknown,
  ): Promise<IssueRecoveryAction> {
    if (retryCount >= MAX_UPSERT_RETRIES) {
      if (error) throw error;
      throw new Error(
        `Failed to upsert active recovery action for issue ${input.sourceIssueId} after ${MAX_UPSERT_RETRIES} retries`,
      );
    }
    return upsertSourceScopedUnlocked(input, retryCount + 1);
  }

  async function upsertSourceScopedUnlocked(
    input: UpsertIssueRecoveryActionInput,
    retryCount = 0,
  ): Promise<IssueRecoveryAction> {
    const existing = await getActiveForIssue(input.companyId, input.sourceIssueId);
    const now = new Date();
    const ownerType = input.ownerType ?? (input.ownerAgentId ? "agent" : "board");
    if (existing) {
      const [updated] = await db
        .update(issueRecoveryActions)
        .set({
          recoveryIssueId: input.recoveryIssueId ?? null,
          kind: input.kind,
          status: "active",
          ownerType,
          ownerAgentId: input.ownerAgentId ?? null,
          ownerUserId: input.ownerUserId ?? null,
          previousOwnerAgentId: input.previousOwnerAgentId ?? existing.previousOwnerAgentId,
          returnOwnerAgentId: input.returnOwnerAgentId ?? existing.returnOwnerAgentId,
          cause: input.cause,
          fingerprint: input.fingerprint,
          evidence: input.evidence ?? existing.evidence,
          nextAction: input.nextAction,
          wakePolicy: input.wakePolicy ?? null,
          monitorPolicy: input.monitorPolicy ?? null,
          attemptCount: existing.attemptCount + 1,
          maxAttempts: input.maxAttempts ?? null,
          timeoutAt: input.timeoutAt ?? null,
          lastAttemptAt: input.lastAttemptAt ?? now,
          outcome: null,
          resolutionNote: null,
          resolvedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(issueRecoveryActions.id, existing.id),
            inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
          ),
        )
        .returning();
      if (!updated) {
        return retryUpsertSourceScoped(input, retryCount);
      }
      return toReadModel(updated!);
    }

    try {
      const [created] = await db
        .insert(issueRecoveryActions)
        .values({
          companyId: input.companyId,
          sourceIssueId: input.sourceIssueId,
          recoveryIssueId: input.recoveryIssueId ?? null,
          kind: input.kind,
          status: "active",
          ownerType,
          ownerAgentId: input.ownerAgentId ?? null,
          ownerUserId: input.ownerUserId ?? null,
          previousOwnerAgentId: input.previousOwnerAgentId ?? null,
          returnOwnerAgentId: input.returnOwnerAgentId ?? null,
          cause: input.cause,
          fingerprint: input.fingerprint,
          evidence: input.evidence ?? {},
          nextAction: input.nextAction,
          wakePolicy: input.wakePolicy ?? null,
          monitorPolicy: input.monitorPolicy ?? null,
          attemptCount: 1,
          maxAttempts: input.maxAttempts ?? null,
          timeoutAt: input.timeoutAt ?? null,
          lastAttemptAt: input.lastAttemptAt ?? now,
        })
        .returning();
      return toReadModel(created!);
    } catch (error) {
      if (!isUniqueRecoveryActionConflict(error)) throw error;
      return retryUpsertSourceScoped(input, retryCount, error);
    }
  }

  async function upsertSourceScoped(
    input: UpsertIssueRecoveryActionInput,
  ): Promise<IssueRecoveryAction> {
    return runExclusiveUpsert(input, () => upsertSourceScopedUnlocked(input));
  }

  async function resolveActiveForIssue(
    input: ResolveIssueRecoveryActionInput,
    dbOrTx: DbOrTransaction = db,
  ): Promise<IssueRecoveryAction | null> {
    const now = new Date();
    const predicates = [
      eq(issueRecoveryActions.companyId, input.companyId),
      eq(issueRecoveryActions.sourceIssueId, input.sourceIssueId),
      inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
    ];
    if (input.actionId) {
      predicates.push(eq(issueRecoveryActions.id, input.actionId));
    }
    if (input.kind) {
      predicates.push(eq(issueRecoveryActions.kind, input.kind));
    }
    if (input.cause) {
      predicates.push(eq(issueRecoveryActions.cause, input.cause));
    }
    if (input.fingerprint) {
      predicates.push(eq(issueRecoveryActions.fingerprint, input.fingerprint));
    }

    const [updated] = await dbOrTx
      .update(issueRecoveryActions)
      .set({
        status: input.status,
        outcome: input.outcome,
        resolutionNote: input.resolutionNote ?? null,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(and(...predicates))
      .returning();

    return updated ? toReadModel(updated) : null;
  }

  // Closes recovery actions that can never make progress: the source issue is
  // already terminal (done/cancelled), or the action passed an explicit
  // timeoutAt. Without this, a finished/cancelled issue keeps its active
  // recovery action forever — holding the partial unique constraint on the
  // source issue and keeping its owner agent on the hook for wake noise.
  async function reapResolvableActions(
    opts?: { now?: Date },
    dbOrTx: DbOrTransaction = db,
  ): Promise<ReapResolvableActionsResult> {
    const now = opts?.now ?? new Date();

    const terminalRows = await dbOrTx
      .update(issueRecoveryActions)
      .set({
        status: "resolved",
        outcome: "restored",
        resolutionNote: TERMINAL_SOURCE_REAP_NOTE,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
          exists(
            dbOrTx
              .select({ one: sql`1` })
              .from(issues)
              .where(
                and(
                  eq(issues.id, issueRecoveryActions.sourceIssueId),
                  eq(issues.companyId, issueRecoveryActions.companyId),
                  inArray(issues.status, [...TERMINAL_SOURCE_ISSUE_STATUSES]),
                ),
              ),
          ),
        ),
      )
      .returning({
        id: issueRecoveryActions.id,
        companyId: issueRecoveryActions.companyId,
        sourceIssueId: issueRecoveryActions.sourceIssueId,
        kind: issueRecoveryActions.kind,
      });

    const timedOutRows = await dbOrTx
      .update(issueRecoveryActions)
      .set({
        status: "resolved",
        outcome: "restored",
        resolutionNote: TIMED_OUT_REAP_NOTE,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
          isNotNull(issueRecoveryActions.timeoutAt),
          lte(issueRecoveryActions.timeoutAt, now),
        ),
      )
      .returning({
        id: issueRecoveryActions.id,
        companyId: issueRecoveryActions.companyId,
        sourceIssueId: issueRecoveryActions.sourceIssueId,
        kind: issueRecoveryActions.kind,
      });

    const reaped: ReapedRecoveryAction[] = [
      ...terminalRows.map((row) => ({
        id: row.id,
        companyId: row.companyId,
        sourceIssueId: row.sourceIssueId,
        kind: row.kind as IssueRecoveryActionKind,
        reason: "terminal_source_issue" as const,
      })),
      ...timedOutRows.map((row) => ({
        id: row.id,
        companyId: row.companyId,
        sourceIssueId: row.sourceIssueId,
        kind: row.kind as IssueRecoveryActionKind,
        reason: "timed_out" as const,
      })),
    ];

    return {
      terminalResolved: terminalRows.length,
      timedOutResolved: timedOutRows.length,
      resolved: reaped.length,
      reaped,
    };
  }

  return {
    getActiveForIssue,
    listActiveForIssues,
    resolveActiveForIssue,
    reapResolvableActions,
    upsertSourceScoped,
  };
}
