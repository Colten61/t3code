import type { ThreadId } from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

import { threadRuntimeIsActive, type EnvironmentThreadShell } from "./models.ts";
import { toSortableTimestamp } from "./threadSort.ts";

type WorkingThreadInput = Pick<
  EnvironmentThreadShell,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "interactionMode"
  | "latestRun"
  | "runtime"
> & {
  readonly pendingBackgroundTasks?: EnvironmentThreadShell["pendingBackgroundTasks"];
};

export function isThreadWorking(thread: WorkingThreadInput): boolean {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false;
  if (thread.pendingSubagentRequest != null) return false;
  const waitingOnBackgroundWork =
    thread.runtime?.status === "idle" &&
    backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? []);
  if (!threadRuntimeIsActive(thread.runtime) && !waitingOnBackgroundWork) return false;
  // A plan prompt outranks lingering background work: the user has to act on it.
  const run = thread.latestRun;
  const runSettled =
    run !== null &&
    run.status !== "preparing" &&
    run.status !== "queued" &&
    run.status !== "starting" &&
    run.status !== "running" &&
    run.status !== "waiting" &&
    thread.runtime?.activeRunId !== run.runId;
  return !(thread.interactionMode === "plan" && thread.hasActionableProposedPlan && runSettled);
}

type FamilyThreadInput = Pick<
  EnvironmentThreadShell,
  "environmentId" | "id" | "lineage" | "launchedByThreadId"
>;

/** FORK: the thread this one works for: a subagent's parent, or the thread that
    launched it. A fork is the user's own thread and works for no one. */
export function threadFamilyParentId(thread: FamilyThreadInput): ThreadId | null {
  if (thread.lineage.relationshipToParent === "subagent") return thread.lineage.parentThreadId;
  if (thread.lineage.relationshipToParent === null) return thread.launchedByThreadId ?? null;
  return null;
}

/** FORK: for each thread, the threads at work for it at any depth (its subagents
    and the threads it launched), keyed by `keyOf`. A thread whose own turn
    ended still reads as working while they do. */
export function workingFamilyByThread<T extends FamilyThreadInput>(
  threads: readonly T[],
  isWorking: (thread: T) => boolean,
  keyOf: (thread: Pick<T, "environmentId" | "id">) => string,
): ReadonlyMap<string, readonly T[]> {
  const byKey = new Map(threads.map((thread) => [keyOf(thread), thread] as const));
  const family = new Map<string, T[]>();
  for (const thread of threads) {
    if (!isWorking(thread)) continue;
    const seen = new Set([keyOf(thread)]);
    let parentId = threadFamilyParentId(thread);
    while (parentId !== null) {
      const key = keyOf({ environmentId: thread.environmentId, id: parentId });
      // A launch cycle cannot happen through the tools; corrupt data must not hang here.
      if (seen.has(key)) break;
      seen.add(key);
      const members = family.get(key);
      if (members === undefined) family.set(key, [thread]);
      else members.push(thread);
      const parent = byKey.get(key);
      if (parent === undefined) break;
      parentId = threadFamilyParentId(parent);
    }
  }
  return family;
}

type InboxThreadInput = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "createdAt" | "unsettledAt" | "latestRun"
>;

export function sortInboxThreadsByReturn<T extends InboxThreadInput>(
  threads: readonly T[],
  observedReturnAt?: (thread: T) => number | undefined,
): T[] {
  const timestamps = new Map(
    threads.map((thread) => [
      thread,
      Math.max(
        toSortableTimestamp(thread.createdAt) ?? 0,
        toSortableTimestamp(thread.unsettledAt ?? undefined) ?? 0,
        toSortableTimestamp(thread.latestRun?.requestedAt ?? undefined) ?? 0,
        toSortableTimestamp(thread.latestRun?.completedAt ?? undefined) ?? 0,
        observedReturnAt?.(thread) ?? 0,
      ),
    ]),
  );
  return sortNewestFirst(threads, timestamps);
}

type WorkingSortInput = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "createdAt" | "latestRun" | "latestUserAuthoredMessageAt"
>;

export function sortWorkingThreadsBySend<T extends WorkingSortInput>(threads: readonly T[]): T[] {
  const timestamps = new Map(
    threads.map((thread) => [
      thread,
      Math.max(
        toSortableTimestamp(thread.createdAt) ?? 0,
        toSortableTimestamp(
          (thread.latestUserAuthoredMessageAt === undefined
            ? thread.latestRun?.requestedAt
            : thread.latestUserAuthoredMessageAt) ?? undefined,
        ) ?? 0,
      ),
    ]),
  );
  return sortNewestFirst(threads, timestamps);
}

function sortNewestFirst<T extends Pick<EnvironmentThreadShell, "id" | "environmentId">>(
  threads: readonly T[],
  timestamps: ReadonlyMap<T, number>,
): T[] {
  return [...threads].sort(
    (left, right) =>
      timestamps.get(right)! - timestamps.get(left)! ||
      left.id.localeCompare(right.id) ||
      left.environmentId.localeCompare(right.environmentId),
  );
}

/**
 * Keep one at module scope so the inbox order survives routes that unmount the
 * list. Call `observe` with every thread shell on each list rebuild, or with
 * null to reset while the beta is off.
 */
export function createInboxReturnTracker() {
  const keyOf = (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) =>
    `${thread.environmentId}:${thread.id}`;
  let lastWorkingKeys: ReadonlySet<string> | null = null;
  const returns = new Map<string, number>();
  return {
    observe(threads: ReadonlyArray<WorkingThreadInput & InboxThreadInput> | null): void {
      if (threads === null) {
        lastWorkingKeys = null;
        returns.clear();
        return;
      }
      const working = new Set<string>();
      const present = new Set<string>();
      for (const thread of threads) {
        const key = keyOf(thread);
        present.add(key);
        if (isThreadWorking(thread)) working.add(key);
      }
      for (const key of returns.keys()) {
        if (!present.has(key)) returns.delete(key);
      }
      // @effect-diagnostics-next-line globalDate:off
      const at = Date.now();
      for (const key of lastWorkingKeys ?? []) {
        if (present.has(key) && !working.has(key)) returns.set(key, at);
      }
      lastWorkingKeys = working;
    },
    returnedAt: (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) =>
      returns.get(keyOf(thread)),
  };
}
