// Claude SDK sessions do not compact idle context themselves; compact two minutes before cache expiry.
// Measure from the latest request, including fully cached requests and sessions resumed after idle stop.
// Skip expired caches: compaction would cost as much as the next message.
import {
  CommandId,
  MessageId,
  resolveIdleCompaction,
  resolveProjectProviderInstanceEnabled,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import type { ProviderIdleCompaction } from "@t3tools/provider-core/server/driver";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/** How long before the cache expires the compaction starts. */
export const IDLE_COMPACTION_LEAD_MS = 2 * 60_000;
/** The cache lifetime the timing is built for; a thread caching for less is left alone. */
const ONE_HOUR_MS = 60 * 60_000;

/** Runs after which the thread sits idle with its context cached. */
const IDLE_AFTER_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "completed",
  "interrupted",
]);

const TERMINAL_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

/** A thread whose last run left it idle. */
export interface IdleCompactionCandidate {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly completedAtMs: number;
  readonly modelSelection: OrchestrationV2Run["modelSelection"];
  /** When the compaction is due, once the thread's cache expiry has been read. */
  readonly dueAtMs?: number;
}

export function idleCompactionCandidate(
  run: Pick<
    OrchestrationV2Run,
    "id" | "threadId" | "status" | "completedAt" | "modelSelection" | "idleCompactionOfRunId"
  >,
): IdleCompactionCandidate | null {
  if (
    !IDLE_AFTER_STATUSES.has(run.status) ||
    run.completedAt === null ||
    run.idleCompactionOfRunId !== undefined
  ) {
    return null;
  }
  return {
    threadId: run.threadId,
    runId: run.id,
    completedAtMs: DateTime.toEpochMillis(run.completedAt),
    modelSelection: run.modelSelection,
  };
}

export type IdleCompactionThread = Pick<
  OrchestrationV2ThreadShell,
  | "modelSelection"
  | "lineage"
  | "latestRunId"
  | "activeRunId"
  | "activityRunStatus"
  | "pendingRuntimeRequest"
  | "pendingBackgroundTasks"
  | "archivedAt"
  | "settledOverride"
  | "settledAt"
  | "snoozedUntil"
>;

/** Why a due thread is left alone, before anything about its provider is read. */
export function idleCompactionThreadSkip(input: {
  readonly candidate: IdleCompactionCandidate;
  readonly thread: IdleCompactionThread;
  readonly nowMs: number;
}): string | null {
  const { candidate, thread } = input;
  if (thread.archivedAt !== null) return "archived";
  if (thread.settledOverride === "settled" || thread.settledAt !== null) return "settled";
  // A delegated task's thread is almost never continued (1 in 22 in mp's data).
  if (thread.lineage.relationshipToParent === "subagent") return "subagent";
  // A compaction that completes would wake the thread early.
  if (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > input.nowMs) {
    return "snoozed";
  }
  if (
    thread.latestRunId !== candidate.runId ||
    thread.activeRunId !== null ||
    thread.activityRunStatus != null ||
    thread.pendingRuntimeRequest !== null ||
    backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])
  ) {
    return "busy";
  }
  // The cache belongs to the model of the run; another model would read the context uncached.
  if (
    thread.modelSelection.instanceId !== candidate.modelSelection.instanceId ||
    thread.modelSelection.model !== candidate.modelSelection.model
  ) {
    return "model_changed";
  }
  return null;
}

/** The provider's latest report on a thread's context, and when the cache it used expires. */
export interface IdleCompactionContext {
  readonly usedTokens: number;
  readonly promptCacheTtlMs: number | null;
  readonly promptCacheExpiresAtMs: number | null;
}

export function latestIdleCompactionContext(
  turns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "tokenUsage">>,
): IdleCompactionContext | null {
  const reports = turns
    .flatMap((turn) => (turn.tokenUsage === undefined ? [] : [turn.tokenUsage]))
    .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const latest = reports[0];
  if (latest === undefined) return null;
  // A request served wholly from the cache writes nothing and reports no lifetime or expiry, yet
  // its hit restarts the lifetime the latest write reported, from the request's own start.
  const ttl = reports.find((report) => report.promptCacheTtlMs !== undefined)?.promptCacheTtlMs;
  const expiresAtMs =
    latest.promptCacheExpiresAt !== undefined
      ? Date.parse(latest.promptCacheExpiresAt)
      : latest.requestedAt !== undefined && ttl !== undefined
        ? Date.parse(latest.requestedAt) + ttl
        : Number.NaN;
  return {
    usedTokens: latest.usedTokens,
    promptCacheTtlMs: ttl ?? null,
    promptCacheExpiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : null,
  };
}

/** When the compaction starts and when the cache is gone, or null without a known one-hour cache. */
export function idleCompactionWindow(
  context: IdleCompactionContext | null,
): { readonly startMs: number; readonly endMs: number } | null {
  if (context === null) return null;
  const endMs = context.promptCacheExpiresAtMs;
  // Five-minute caches (API key, extra usage) are left alone.
  if (
    endMs === null ||
    context.promptCacheTtlMs === null ||
    context.promptCacheTtlMs < ONE_HOUR_MS
  ) {
    return null;
  }
  return { startMs: endMs - IDLE_COMPACTION_LEAD_MS, endMs };
}

/** Why a due, idle thread is still left alone once its provider and context are known. */
export function idleCompactionContextSkip(input: {
  readonly policy: ProviderIdleCompaction | null;
  readonly context: IdleCompactionContext | null;
  /** A merge-back waiting for the next message; the /compact turn would swallow it. */
  readonly mergeBackPending: boolean;
  readonly nowMs: number;
}): string | null {
  if (input.policy === null) return "provider_off";
  if (input.context === null) return "no_context";
  const window = idleCompactionWindow(input.context);
  if (window === null) return "short_cache";
  if (input.nowMs >= window.endMs) return "late";
  if (input.mergeBackPending) return "merge_back";
  if (input.context.usedTokens < input.policy.minTokens) return "small";
  return null;
}

/** What the layer runs: `onEvent` for every domain event, `runDueWork` on the scheduler's clock. */
export const makeIdleCompactionWorker = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const registry = yield* ProviderInstanceRegistry;
  const settings = yield* ServerSettings.ServerSettingsService;

  const due = new Map<ThreadId, IdleCompactionCandidate>();
  let seeded = false;

  /** Threads left idle before this server started; later ones arrive as events. */
  const seed = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const snapshot = yield* projections.getShellSnapshot({
      location: "active",
      unsettledOnly: true,
    });
    for (const thread of snapshot.threads) {
      if (
        thread.latestRunId === null ||
        thread.latestRunCompletedAt == null ||
        (thread.status !== "completed" && thread.status !== "interrupted") ||
        due.has(thread.id)
      ) {
        continue;
      }
      const completedAtMs = DateTime.toEpochMillis(thread.latestRunCompletedAt);
      // The cache expires at most an hour after the run's last request, which preceded its end.
      if (nowMs >= completedAtMs + ONE_HOUR_MS) continue;
      due.set(thread.id, {
        threadId: thread.id,
        runId: thread.latestRunId,
        completedAtMs,
        modelSelection: thread.modelSelection,
      });
    }
  });

  const compact = Effect.fn("IdleCompactionWorker.compact")(function* (
    candidate: IdleCompactionCandidate,
    nowMs: number,
  ) {
    const thread = yield* threads.getThreadShell(candidate.threadId);
    if (thread === null) return;
    const threadSkip = idleCompactionThreadSkip({ candidate, thread, nowMs });
    if (threadSkip !== null) return;
    const currentSettings = yield* settings.getSettings;
    if (
      resolveIdleCompaction(currentSettings, thread.providerInstanceId) !== "beforeCacheExpires" ||
      !resolveProjectProviderInstanceEnabled(
        currentSettings,
        thread.projectId,
        thread.providerInstanceId,
      )
    )
      return;
    const instance = yield* registry.getInstance(thread.providerInstanceId);
    const policy = instance?.idleCompaction === undefined ? null : yield* instance.idleCompaction;
    const records = yield* projections.getThreadRecords(candidate.threadId, [
      "providerTurns",
      "contextTransfers",
    ]);
    const context = latestIdleCompactionContext(records.providerTurns);
    const mergeBackPending = records.contextTransfers.some(
      (transfer) =>
        transfer.type === "merge_back" &&
        transfer.targetThreadId === candidate.threadId &&
        transfer.status === "pending",
    );
    const skip = idleCompactionContextSkip({ policy, context, mergeBackPending, nowMs });
    if (skip !== null) {
      if (skip !== "provider_off") {
        yield* Effect.logDebug("orchestration-v2.idle-compaction.skipped", {
          threadId: candidate.threadId,
          reason: skip,
        });
      }
      return;
    }
    const id = `idle-compact:${candidate.threadId}:${candidate.runId}`;
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(id),
      messageId: MessageId.make(id),
      threadId: candidate.threadId,
      idleCompactionOfRunId: candidate.runId,
      text: "/compact",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "system",
      creationSource: "server",
    });
    yield* Effect.logInfo("orchestration-v2.idle-compaction.started", {
      threadId: candidate.threadId,
      contextTokens: context?.usedTokens,
    });
  });

  /**
   * A thread the user had seen before it went idle stays seen: the compaction's run would
   * otherwise show as an unseen completion on every client.
   */
  const keepSeen = Effect.fn("IdleCompactionWorker.keepSeen")(function* (
    run: OrchestrationV2Run,
    previousRunId: RunId,
  ) {
    if (run.completedAt === null) return;
    const records = yield* projections.getThreadRecords(run.threadId, ["runs"], {
      runIds: [previousRunId],
    });
    const previousCompletedAt = records.runs.find(
      (candidate) => candidate.id === previousRunId,
    )?.completedAt;
    const visitedAt = records.thread.lastVisitedAt;
    if (
      previousCompletedAt == null ||
      visitedAt === null ||
      DateTime.toEpochMillis(visitedAt) < DateTime.toEpochMillis(previousCompletedAt)
    ) {
      return;
    }
    yield* threads.dispatch({
      type: "thread.visit",
      commandId: CommandId.make(`idle-compact-seen:${run.threadId}:${run.id}`),
      threadId: run.threadId,
      visitedAt: DateTime.formatIso(run.completedAt),
    });
  });

  const onEvent = (event: OrchestrationV2DomainEvent): Effect.Effect<void> => {
    switch (event.type) {
      case "run.created":
        due.delete(event.threadId);
        return Effect.void;
      case "run.updated": {
        const run = event.payload;
        const candidate = idleCompactionCandidate(run);
        // A late update of an earlier run must not replace the thread's latest one.
        const current = candidate === null ? undefined : due.get(candidate.threadId);
        if (
          candidate !== null &&
          (current === undefined || current.completedAtMs <= candidate.completedAtMs)
        ) {
          due.set(candidate.threadId, candidate);
        }
        if (run.idleCompactionOfRunId === undefined || !TERMINAL_RUN_STATUSES.has(run.status)) {
          return Effect.void;
        }
        return keepSeen(run, run.idleCompactionOfRunId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.idle-compaction.keep-seen-failed", {
              threadId: run.threadId,
              cause,
            }),
          ),
        );
      }
      default:
        return Effect.void;
    }
  };

  /** When a newly idle thread's compaction is due, or null when it never will be. */
  const readDueAt = Effect.fn("IdleCompactionWorker.readDueAt")(function* (
    candidate: IdleCompactionCandidate,
  ) {
    // Only drivers that compact idle threads pay for reading the thread's turns.
    const instance = yield* registry.getInstance(candidate.modelSelection.instanceId);
    if (instance?.idleCompaction === undefined) return null;
    const records = yield* projections.getThreadRecords(candidate.threadId, ["providerTurns"]);
    return (
      idleCompactionWindow(latestIdleCompactionContext(records.providerTurns))?.startMs ?? null
    );
  });

  const runDueWork = Effect.gen(function* () {
    if (!seeded) {
      yield* seed;
      seeded = true;
    }
    const nowMs = yield* Clock.currentTimeMillis;
    // Deleting the entry being visited, or adding or replacing one, is safe while a Map iterates.
    for (const candidate of due.values()) {
      let dueAtMs = candidate.dueAtMs;
      if (dueAtMs === undefined) {
        const read = yield* readDueAt(candidate).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.idle-compaction.failed", {
              threadId: candidate.threadId,
              cause,
            }).pipe(Effect.as(null)),
          ),
        );
        // A run event may have replaced or dropped the thread meanwhile.
        if (due.get(candidate.threadId) !== candidate) continue;
        if (read === null) {
          due.delete(candidate.threadId);
          continue;
        }
        dueAtMs = read;
        due.set(candidate.threadId, { ...candidate, dueAtMs });
      }
      if (nowMs < dueAtMs) continue;
      due.delete(candidate.threadId);
      yield* compact(candidate, nowMs).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.idle-compaction.failed", {
            threadId: candidate.threadId,
            cause,
          }),
        ),
      );
    }
  });

  return { onEvent, runDueWork };
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const worker = yield* makeIdleCompactionWorker;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const scheduler = yield* Scheduler.Scheduler;
    yield* forkParked(Stream.runForEach(threads.streamDomainEvents, worker.onEvent));
    yield* scheduler.register("idle-compaction", worker.runDueWork);
  }),
);
