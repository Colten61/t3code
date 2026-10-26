// Agent-launched threads nest under their launcher; subagents nest under their lineage parent.
// Forks and mobile navigation keep their existing lineage behavior.
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { isLatestRunSettled } from "../session-logic";
import type { SidebarThreadSummary } from "../types";
import type { SidebarSection, SidebarThreadStatus } from "./Sidebar.logic";

type LaunchThread = Pick<
  SidebarThreadSummary,
  "environmentId" | "id" | "projectId" | "lineage" | "launchedByThreadId"
>;

export function sidebarLaunchThreadKey(
  thread: Pick<SidebarThreadSummary, "environmentId" | "id">,
): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

/** Launchers that are subagents resolve to their nearest non-subagent ancestor. */
export function resolveSidebarLauncherKey(
  thread: LaunchThread,
  threadByKey: ReadonlyMap<string, LaunchThread>,
): string | null {
  const seen = new Set([sidebarLaunchThreadKey(thread)]);
  let launcherId = thread.launchedByThreadId ?? null;
  while (launcherId !== null) {
    const key = sidebarLaunchThreadKey({ environmentId: thread.environmentId, id: launcherId });
    if (seen.has(key)) return null;
    seen.add(key);
    const launcher = threadByKey.get(key);
    if (launcher === undefined) return null;
    if (launcher.lineage.relationshipToParent !== "subagent") return key;
    launcherId = launcher.lineage.parentThreadId;
  }
  return null;
}

// ── Grouping ────────────────────────────────────────────────────────

/** Where a thread sits on its own. The inbox and the Working shelf are one
    place here: a group moves between them as a whole. */
export type SidebarLaunchPlacement = "pinned" | "inbox" | "snoozed" | "shelved" | "settled";

export function sidebarLaunchPlacement(section: SidebarSection): SidebarLaunchPlacement {
  return section === "active" || section === "working" ? "inbox" : section;
}

// Inbox children keep their coordinator when it is pinned or has already settled.
// Settled children follow a shelved parent because shelving settles its working family.
export function canNestSidebarLaunch(
  child: SidebarLaunchPlacement,
  parent: SidebarLaunchPlacement,
): boolean {
  return (
    child === parent ||
    (child === "inbox" && (parent === "pinned" || parent === "settled")) ||
    (child === "settled" && parent === "shelved")
  );
}

export interface SidebarLaunchForest {
  readonly parentKeyByChildKey: ReadonlyMap<string, string>;
  /** Children in creation order (oldest first), so writer 1 stays above writer 2. */
  readonly childKeysByParentKey: ReadonlyMap<string, readonly string[]>;
  /** The nested subagents; every other child is a launched thread. */
  readonly subagentKeys: ReadonlySet<string>;
}

const EMPTY_FOREST: SidebarLaunchForest = {
  parentKeyByChildKey: new Map(),
  childKeysByParentKey: new Map(),
  subagentKeys: new Set(),
};

// Nest within the visible project scope. Subagents without a loaded, unarchived
// ancestor row stay hidden and never become roots.
export function buildSidebarLaunchForest<
  T extends LaunchThread & { readonly createdAt: string },
>(input: {
  readonly visible: readonly { readonly thread: T; readonly placement: SidebarLaunchPlacement }[];
  readonly threadByKey: ReadonlyMap<string, LaunchThread>;
  /** Unarchived subagent threads, kept out of `visible`. */
  readonly subagents?: readonly T[] | undefined;
}): SidebarLaunchForest {
  const visibleByKey = new Map(
    input.visible.map((entry) => [sidebarLaunchThreadKey(entry.thread), entry] as const),
  );
  const parentKeyByChildKey = new Map<string, string>();
  for (const entry of input.visible) {
    if (entry.thread.launchedByThreadId === undefined) continue;
    const parentKey = resolveSidebarLauncherKey(entry.thread, input.threadByKey);
    const parent = parentKey === null ? undefined : visibleByKey.get(parentKey);
    if (
      parentKey !== null &&
      parent !== undefined &&
      parent.thread.projectId === entry.thread.projectId &&
      canNestSidebarLaunch(entry.placement, parent.placement)
    ) {
      parentKeyByChildKey.set(sidebarLaunchThreadKey(entry.thread), parentKey);
    }
  }
  // A launch cycle cannot happen through the tools, but corrupt data must not
  // hide every thread in it: break each cycle at the thread that closes it.
  for (const childKey of parentKeyByChildKey.keys()) {
    const seen = new Set([childKey]);
    let cursor = parentKeyByChildKey.get(childKey);
    while (cursor !== undefined) {
      if (seen.has(cursor)) {
        parentKeyByChildKey.delete(childKey);
        break;
      }
      seen.add(cursor);
      cursor = parentKeyByChildKey.get(cursor);
    }
  }
  const subagentKeys = attachSidebarSubagents({
    subagents: input.subagents ?? [],
    hasRow: (key) => visibleByKey.has(key),
    parentKeyByChildKey,
  });
  if (parentKeyByChildKey.size === 0) return EMPTY_FOREST;
  const createdAtByKey = new Map(
    [...input.visible.map((entry) => entry.thread), ...(input.subagents ?? [])].map(
      (thread) => [sidebarLaunchThreadKey(thread), Date.parse(thread.createdAt) || 0] as const,
    ),
  );
  const childKeysByParentKey = new Map<string, string[]>();
  for (const [childKey, parentKey] of parentKeyByChildKey) {
    const children = childKeysByParentKey.get(parentKey) ?? [];
    children.push(childKey);
    childKeysByParentKey.set(parentKey, children);
  }
  for (const children of childKeysByParentKey.values()) {
    children.sort(
      (left, right) =>
        (createdAtByKey.get(left) ?? 0) - (createdAtByKey.get(right) ?? 0) ||
        left.localeCompare(right),
    );
  }
  return { parentKeyByChildKey, childKeysByParentKey, subagentKeys };
}

/**
 * Add an edge for every subagent whose chain of parents reaches a row. Each
 * thread is walked once (the answer is shared along the path), so this stays
 * linear in the thousands of settled subagents a long-lived install keeps.
 */
function attachSidebarSubagents(input: {
  readonly subagents: readonly LaunchThread[];
  readonly hasRow: (key: string) => boolean;
  readonly parentKeyByChildKey: Map<string, string>;
}): ReadonlySet<string> {
  const subagentKeys = new Set<string>();
  if (input.subagents.length === 0) return subagentKeys;
  const parentKeyOf = new Map<string, string>();
  for (const subagent of input.subagents) {
    if (subagent.lineage.parentThreadId === null) continue;
    parentKeyOf.set(
      sidebarLaunchThreadKey(subagent),
      sidebarLaunchThreadKey({
        environmentId: subagent.environmentId,
        id: subagent.lineage.parentThreadId,
      }),
    );
  }
  const reachesRow = new Map<string, boolean>();
  for (const key of parentKeyOf.keys()) {
    const path: string[] = [];
    let cursor: string | undefined = key;
    let reaches = false;
    while (cursor !== undefined) {
      if (input.hasRow(cursor)) {
        reaches = true;
        break;
      }
      const known = reachesRow.get(cursor);
      if (known !== undefined) {
        reaches = known;
        break;
      }
      // Marked before stepping on, so a lineage cycle reads as unreachable.
      reachesRow.set(cursor, false);
      path.push(cursor);
      cursor = parentKeyOf.get(cursor);
    }
    for (const step of path) reachesRow.set(step, reaches);
  }
  for (const [key, parentKey] of parentKeyOf) {
    if (reachesRow.get(key) !== true) continue;
    input.parentKeyByChildKey.set(key, parentKey);
    subagentKeys.add(key);
  }
  return subagentKeys;
}

export function sidebarLaunchDescendantKeys(
  forest: SidebarLaunchForest,
  parentKey: string,
): string[] {
  const keys: string[] = [];
  const visit = (key: string) => {
    for (const childKey of forest.childKeysByParentKey.get(key) ?? []) {
      keys.push(childKey);
      visit(childKey);
    }
  };
  visit(parentKey);
  return keys;
}

export function sidebarLaunchAncestorKeys(
  forest: SidebarLaunchForest,
  key: string | null,
): ReadonlySet<string> {
  const ancestors = new Set<string>();
  let cursor = key === null ? undefined : forest.parentKeyByChildKey.get(key);
  while (cursor !== undefined && !ancestors.has(cursor)) {
    ancestors.add(cursor);
    cursor = forest.parentKeyByChildKey.get(cursor);
  }
  return ancestors;
}

export interface SidebarLaunchSections<T> {
  readonly pinned: readonly T[];
  readonly active: readonly T[];
  readonly working: readonly T[];
  readonly snoozed: readonly T[];
  readonly shelved: readonly T[];
  readonly settled: readonly T[];
}

const SIDEBAR_SECTIONS = ["pinned", "active", "working", "snoozed", "shelved", "settled"] as const;

// Sections hold draggable roots; their children render beneath them. A launched thread
// needing the user lifts its group into the inbox; subagent questions surface on their parent.
export function nestSidebarLaunchedThreads<
  T extends LaunchThread & { readonly createdAt: string },
>(input: {
  readonly sections: SidebarLaunchSections<T>;
  readonly threadByKey: ReadonlyMap<string, LaunchThread>;
  readonly holdsInbox: (thread: T) => boolean;
  /** Unarchived subagent threads, kept out of the sections. */
  readonly subagents?: readonly T[] | undefined;
}): {
  readonly sections: SidebarLaunchSections<T>;
  readonly forest: SidebarLaunchForest;
  /** The section each nested thread sits in on its own (a subagent: its
      nearest launched or root ancestor's), for its row's look and actions. */
  readonly nestedSectionByKey: ReadonlyMap<string, SidebarSection>;
  readonly nestedThreadByKey: ReadonlyMap<string, T>;
} {
  const entries = SIDEBAR_SECTIONS.flatMap((section) =>
    input.sections[section].map((thread) => ({
      thread,
      section,
      placement: sidebarLaunchPlacement(section),
    })),
  );
  const forest = buildSidebarLaunchForest({
    visible: entries,
    threadByKey: input.threadByKey,
    subagents: input.subagents,
  });
  if (forest.parentKeyByChildKey.size === 0) {
    return {
      sections: input.sections,
      forest,
      nestedSectionByKey: new Map(),
      nestedThreadByKey: new Map(),
    };
  }
  const entryByKey = new Map(
    entries.map((entry) => [sidebarLaunchThreadKey(entry.thread), entry] as const),
  );
  const subagentByKey = new Map(
    (input.subagents ?? []).map((thread) => [sidebarLaunchThreadKey(thread), thread] as const),
  );
  const nestedSectionByKey = new Map<string, SidebarSection>();
  const nestedThreadByKey = new Map<string, T>();
  for (const childKey of forest.parentKeyByChildKey.keys()) {
    const entry = entryByKey.get(childKey);
    if (entry !== undefined) {
      nestedSectionByKey.set(childKey, entry.section);
      nestedThreadByKey.set(childKey, entry.thread);
      continue;
    }
    const subagent = subagentByKey.get(childKey);
    let placeKey = forest.parentKeyByChildKey.get(childKey);
    while (placeKey !== undefined && !entryByKey.has(placeKey)) {
      placeKey = forest.parentKeyByChildKey.get(placeKey);
    }
    const place = placeKey === undefined ? undefined : entryByKey.get(placeKey);
    if (subagent === undefined || place === undefined) continue;
    nestedSectionByKey.set(childKey, place.section);
    nestedThreadByKey.set(childKey, subagent);
  }
  const roots = (section: (typeof SIDEBAR_SECTIONS)[number]) =>
    input.sections[section].filter(
      (thread) => !forest.parentKeyByChildKey.has(sidebarLaunchThreadKey(thread)),
    );
  const active = roots("active");
  const working: T[] = [];
  const settled: T[] = [];
  for (const thread of roots("settled")) {
    const descendantSections = sidebarLaunchDescendantKeys(forest, sidebarLaunchThreadKey(thread))
      .filter((key) => !forest.subagentKeys.has(key))
      .map((key) => nestedSectionByKey.get(key));
    if (descendantSections.includes("active")) active.push(thread);
    else if (descendantSections.includes("working")) working.push(thread);
    else settled.push(thread);
  }
  for (const thread of roots("working")) {
    const holds = sidebarLaunchDescendantKeys(forest, sidebarLaunchThreadKey(thread)).some(
      (key) => {
        const child = nestedThreadByKey.get(key);
        return child !== undefined && !forest.subagentKeys.has(key) && input.holdsInbox(child);
      },
    );
    (holds ? active : working).push(thread);
  }
  return {
    sections: {
      pinned: roots("pinned"),
      active,
      working,
      snoozed: roots("snoozed"),
      shelved: roots("shelved"),
      settled,
    },
    forest,
    nestedSectionByKey,
    nestedThreadByKey,
  };
}

// ── Collapsing ──────────────────────────────────────────────────────

/**
 * What a group shows until the user opens or folds it: its launched threads,
 * so every writer's state shows, and only the subagents that work or wait on
 * the user, since most parents keep a long tail of finished ones. A group
 * showing part of itself ("some") reads as folded: its toggle opens the rest.
 */
export type SidebarLaunchGroupDefault = "all" | "some" | "none";

export interface SidebarLaunchGroupDefaults {
  /** Nested subagents that work or wait on the user. */
  readonly busySubagentKeys: ReadonlySet<string>;
  readonly byParentKey: ReadonlyMap<string, SidebarLaunchGroupDefault>;
}

function isSidebarStatusBusy(status: SidebarThreadStatus): boolean {
  return (
    status === "working" ||
    status === "waiting" ||
    status === "approval" ||
    status === "input" ||
    status === "request"
  );
}

export function resolveSidebarLaunchGroupDefaults(input: {
  readonly forest: SidebarLaunchForest;
  /** A nested subagent's status, with the work of the threads under it. */
  readonly subagentStatus: (key: string) => SidebarThreadStatus | null;
}): SidebarLaunchGroupDefaults {
  const { forest } = input;
  const busySubagentKeys = new Set<string>();
  for (const key of forest.subagentKeys) {
    const status = input.subagentStatus(key);
    if (status !== null && isSidebarStatusBusy(status)) busySubagentKeys.add(key);
  }
  const byParentKey = new Map<string, SidebarLaunchGroupDefault>();
  for (const [parentKey, childKeys] of forest.childKeysByParentKey) {
    const shown = childKeys.filter(
      (key) => !forest.subagentKeys.has(key) || busySubagentKeys.has(key),
    ).length;
    byParentKey.set(parentKey, shown === childKeys.length ? "all" : shown === 0 ? "none" : "some");
  }
  return { busySubagentKeys, byParentKey };
}

/** Remembered toggles beyond this many drop the oldest first. */
const SIDEBAR_LAUNCH_TOGGLE_LIMIT = 200;
const OPENED_CHOICE_PREFIX = "+";

/**
 * The groups the user opened or folded. A bare key is a folded group, the
 * only choice stored while every group opened by default; a "+" key an
 * opened one.
 */
export function readSidebarLaunchGroupChoices(
  stored: readonly string[],
): ReadonlyMap<string, boolean> {
  return new Map(
    stored.map((entry) =>
      entry.startsWith(OPENED_CHOICE_PREFIX)
        ? ([entry.slice(OPENED_CHOICE_PREFIX.length), true] as const)
        : ([entry, false] as const),
    ),
  );
}

export function isSidebarLaunchGroupExpanded(input: {
  readonly choice: boolean | undefined;
  readonly byDefault: SidebarLaunchGroupDefault;
}): boolean {
  return input.choice ?? input.byDefault === "all";
}

/** A group the user opened shows every child, finished subagents too. */
export function isSidebarLaunchChildShown(input: {
  readonly choice: boolean | undefined;
  readonly isSubagent: boolean;
  readonly isBusy: boolean;
}): boolean {
  return input.choice ?? (!input.isSubagent || input.isBusy);
}

/**
 * Open or fold a whole group. The choice is remembered and wins over what the
 * group does by itself, except when it is exactly that: then it is dropped,
 * so folding a group back lets it open for its next busy subagent.
 */
export function toggleSidebarLaunchGroup(
  stored: readonly string[],
  parentKey: string,
  byDefault: SidebarLaunchGroupDefault,
): string[] {
  const choice = readSidebarLaunchGroupChoices(stored).get(parentKey);
  const expand = !isSidebarLaunchGroupExpanded({ choice, byDefault });
  const rest = stored.filter(
    (entry) => entry !== parentKey && entry !== `${OPENED_CHOICE_PREFIX}${parentKey}`,
  );
  if (expand ? byDefault === "all" : byDefault === "none") return rest;
  return [...rest, expand ? `${OPENED_CHOICE_PREFIX}${parentKey}` : parentKey].slice(
    -SIDEBAR_LAUNCH_TOGGLE_LIMIT,
  );
}

/**
 * The rows under a group root in render order, depth-first. A collapsed
 * group still shows the open thread and the groups above it, the way the
 * collapsed shelves keep the open thread's row.
 */
export function flattenSidebarLaunchGroup(input: {
  readonly rootKey: string;
  readonly forest: SidebarLaunchForest;
  readonly isShown: (parentKey: string, childKey: string) => boolean;
  readonly routeThreadKey: string | null;
}): { readonly key: string; readonly depth: number }[] {
  const keep = new Set(sidebarLaunchAncestorKeys(input.forest, input.routeThreadKey));
  if (input.routeThreadKey !== null) keep.add(input.routeThreadKey);
  const rows: { key: string; depth: number }[] = [];
  const visit = (key: string, depth: number) => {
    for (const childKey of input.forest.childKeysByParentKey.get(key) ?? []) {
      if (!keep.has(childKey) && !input.isShown(key, childKey)) continue;
      rows.push({ key: childKey, depth });
      visit(childKey, depth + 1);
    }
  };
  visit(input.rootKey, 1);
  return rows;
}

// ── Search ──────────────────────────────────────────────────────────

export interface SidebarSearchRow<T> {
  readonly thread: T;
  /** 0 for a thread with a row of its own, then one more per subagent level. */
  readonly depth: number;
  /** An ancestor that does not match, shown so a matching subagent has its place. */
  readonly isContext: boolean;
}

/**
 * Search results in match order, each matching subagent under its chain of
 * subagent parents up to the thread with a row of its own. A thread that
 * matches keeps its own place, or the earlier one a matching subagent gave it.
 */
export function nestSidebarSearchResults<T extends LaunchThread>(input: {
  readonly matches: readonly T[];
  /** Every searchable thread, to find the ancestors that do not match. */
  readonly threads: readonly T[];
  readonly forest: SidebarLaunchForest;
}): SidebarSearchRow<T>[] {
  const { forest } = input;
  if (!input.matches.some((thread) => forest.subagentKeys.has(sidebarLaunchThreadKey(thread)))) {
    return input.matches.map((thread) => ({ thread, depth: 0, isContext: false }));
  }
  const matchedKeys = new Set(input.matches.map(sidebarLaunchThreadKey));
  const includedKeys = new Set<string>();
  const anchorKeys: string[] = [];
  for (const match of input.matches) {
    let key: string | undefined = sidebarLaunchThreadKey(match);
    while (key !== undefined && forest.subagentKeys.has(key) && !includedKeys.has(key)) {
      includedKeys.add(key);
      key = forest.parentKeyByChildKey.get(key);
    }
    if (key !== undefined && !includedKeys.has(key)) {
      includedKeys.add(key);
      anchorKeys.push(key);
    }
  }
  const threadByKey = new Map(
    input.threads.map((thread) => [sidebarLaunchThreadKey(thread), thread] as const),
  );
  const rows: SidebarSearchRow<T>[] = [];
  const visit = (key: string, depth: number) => {
    const thread = threadByKey.get(key);
    if (thread === undefined) return;
    rows.push({ thread, depth, isContext: !matchedKeys.has(key) });
    for (const childKey of forest.childKeysByParentKey.get(key) ?? []) {
      if (forest.subagentKeys.has(childKey) && includedKeys.has(childKey)) {
        visit(childKey, depth + 1);
      }
    }
  };
  for (const key of anchorKeys) visit(key, 0);
  return rows;
}

// ── Whose move it is ────────────────────────────────────────────────

type InboxHoldInput = Pick<
  SidebarThreadSummary,
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "hasActionableProposedPlan"
  | "interactionMode"
  | "latestRun"
  | "runtime"
> &
  Partial<Pick<SidebarThreadSummary, "pendingGuestMessageCount">>;

export function hasSidebarPlanPrompt(thread: InboxHoldInput): boolean {
  return (
    !thread.hasPendingUserInput &&
    thread.interactionMode === "plan" &&
    thread.hasActionableProposedPlan &&
    isLatestRunSettled(thread.latestRun, thread.runtime)
  );
}

/**
 * What keeps a group out of the Working shelf: a nested approval, question,
 * plan or failure stays in the inbox, the way the same thread on its own
 * would. A child that finished and waits on its orchestrator does not.
 */
export function sidebarThreadHoldsInbox(thread: InboxHoldInput): boolean {
  return (
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    (thread.pendingGuestMessageCount ?? 0) > 0 ||
    thread.runtime?.status === "failed" ||
    hasSidebarPlanPrompt(thread)
  );
}

/**
 * Today a never-opened thread counts as read, so switching sidebars does not
 * light up history. A launched thread is one nobody but its orchestrator has
 * opened, and that rule would hide the state of every writer, so for it a
 * completion counts as unread until someone opens it afterwards.
 */
export function isSidebarMoveUnread(input: {
  readonly isUnread: boolean;
  readonly isLaunched: boolean;
  readonly lastVisitedAt: string | null | undefined;
  readonly latestRun: Pick<NonNullable<SidebarThreadSummary["latestRun"]>, "completedAt"> | null;
}): boolean {
  if (input.isUnread) return true;
  return input.isLaunched && !input.lastVisitedAt && Boolean(input.latestRun?.completedAt);
}

export type SidebarMoveKind = "working" | "needs-you" | "with-orchestrator" | "done";
export type SidebarMoveReason =
  | "running"
  | "goal"
  | "background"
  | "approval"
  | "input"
  | "plan"
  | "finished"
  | "launcher-busy"
  | "launcher-finished"
  | "family";

export interface SidebarMoveState {
  readonly kind: SidebarMoveKind;
  readonly reason: SidebarMoveReason;
  readonly tooltip: string;
}

export const SIDEBAR_MOVE_LABEL: Record<SidebarMoveKind, string> = {
  working: "Working",
  "needs-you": "Needs you",
  "with-orchestrator": "With orchestrator",
  done: "Done",
};

export interface SidebarMoveLauncher {
  readonly title: string;
  readonly status: SidebarThreadStatus;
}

// Failed and limited rows keep their own pills. Finished rows show whose move is next
// while unread; a plan the user must review takes precedence over its launcher.
export function resolveSidebarMoveState(input: {
  readonly status: SidebarThreadStatus;
  readonly isUnread: boolean;
  readonly hasPlanPrompt: boolean;
  readonly goalActive: boolean;
  /** The thread that launched this one; null for top-level threads. */
  readonly launcher: SidebarMoveLauncher | null;
  /** Titles of the threads working for this one when that, not its own turn, keeps it working. */
  readonly workingFamily?: readonly string[];
}): SidebarMoveState | null {
  switch (input.status) {
    case "working":
      if (input.workingFamily !== undefined && input.workingFamily.length > 0) {
        return {
          kind: "working",
          reason: "family",
          tooltip: sidebarWorkingFamilyTooltip(input.workingFamily),
        };
      }
      return input.goalActive
        ? { kind: "working", reason: "goal", tooltip: "Working toward its /goal" }
        : { kind: "working", reason: "running", tooltip: "Running a turn" };
    case "waiting":
      return {
        kind: "working",
        reason: "background",
        tooltip: "Paused until its background work (subagents, monitors) wakes it",
      };
    case "approval":
      return { kind: "needs-you", reason: "approval", tooltip: "Waiting for your approval" };
    case "request":
      return { kind: "needs-you", reason: "input", tooltip: "Waiting for your reply to a guest" };
    case "input":
      return { kind: "needs-you", reason: "input", tooltip: "Asked you a question" };
    case "failed":
    case "limited":
      return null;
    case "ready":
      break;
  }
  if (!input.isUnread) return null;
  if (input.hasPlanPrompt) {
    return { kind: "needs-you", reason: "plan", tooltip: "Proposed a plan for you to review" };
  }
  if (input.launcher === null) {
    return { kind: "needs-you", reason: "finished", tooltip: "Finished its turn" };
  }
  const launcherTitle = `«${input.launcher.title}»`;
  if (isSidebarStatusBusy(input.launcher.status)) {
    return {
      kind: "with-orchestrator",
      reason: "launcher-busy",
      tooltip: `Finished its turn. ${launcherTitle} has the next step`,
    };
  }
  return {
    kind: "done",
    reason: "launcher-finished",
    tooltip:
      input.launcher.status === "failed" || input.launcher.status === "limited"
        ? `Finished its turn. ${launcherTitle} stopped too`
        : `Finished its turn. ${launcherTitle} has finished too`,
  };
}

/**
 * FORK: a thread whose own turn ended reads as working while threads working
 * for it (its subagents and the threads it launched) still do. Waiting on its
 * own background work turns into working too; a thread that needs the user,
 * failed or hit a limit keeps its own state.
 */
export function resolveSidebarFamilyStatus(
  status: SidebarThreadStatus,
  familyWorking: boolean,
): SidebarThreadStatus {
  return familyWorking && (status === "ready" || status === "waiting") ? "working" : status;
}

/** FORK: who a thread waits on while its own turn is over, for the pill's hover card. */
export function sidebarWorkingFamilyTooltip(titles: readonly string[]): string {
  const named = titles
    .slice(0, 3)
    .map((title) => `«${title}»`)
    .join(", ");
  const more = titles.length > 3 ? ` and ${titles.length - 3} more` : "";
  return `Its subagents and writers are working: ${named}${more}`;
}

// ── The parent row: child count and the most urgent child state ─────
export type SidebarLaunchGroupState = SidebarMoveKind | "failed";

const GROUP_STATE_PRIORITY: Record<SidebarLaunchGroupState, number> = {
  "needs-you": 4,
  failed: 3,
  working: 2,
  "with-orchestrator": 1,
  done: 0,
};

export const SIDEBAR_LAUNCH_GROUP_STATE_LABEL: Record<SidebarLaunchGroupState, string> = {
  ...SIDEBAR_MOVE_LABEL,
  failed: "Failed",
};

export interface SidebarLaunchGroupMember {
  readonly title: string;
  readonly status: SidebarThreadStatus;
  readonly isUnread: boolean;
  readonly hasPlanPrompt: boolean;
  readonly goalActive: boolean;
  readonly launcher: SidebarMoveLauncher | null;
  readonly subagent?: boolean;
}

// Finished children keep waiting on their launcher after being read; only unread plans lift.
// Subagents lift only while working or asking, since their parent owns their results.
export function resolveSidebarLaunchMemberState(member: SidebarLaunchGroupMember): {
  readonly state: SidebarLaunchGroupState | null;
  readonly move: SidebarMoveState | null;
} {
  if (member.subagent === true) {
    const state =
      member.status === "approval" || member.status === "input" || member.status === "request"
        ? "needs-you"
        : member.status === "working" || member.status === "waiting"
          ? "working"
          : null;
    return { state, move: null };
  }
  if (member.status === "failed" || member.status === "limited") {
    return { state: "failed", move: null };
  }
  const move = resolveSidebarMoveState({
    ...member,
    isUnread: true,
    hasPlanPrompt: member.hasPlanPrompt && member.isUnread,
  });
  return { state: move?.kind ?? null, move };
}

export interface SidebarLaunchGroupSummary {
  readonly count: number;
  readonly mostUrgent: SidebarLaunchGroupState | null;
  readonly countByState: Readonly<Record<SidebarLaunchGroupState, number>>;
  /** Nested threads that need the user, in launch order, for the lifted pill. */
  readonly needsYou: readonly {
    readonly title: string;
    readonly move: SidebarMoveState;
  }[];
  readonly tooltip: string;
}

export function summarizeSidebarLaunchGroup(
  members: readonly SidebarLaunchGroupMember[],
): SidebarLaunchGroupSummary | null {
  if (members.length === 0) return null;
  const countByState: Record<SidebarLaunchGroupState, number> = {
    "needs-you": 0,
    failed: 0,
    working: 0,
    "with-orchestrator": 0,
    done: 0,
  };
  const needsYou: { title: string; move: SidebarMoveState }[] = [];
  let mostUrgent: SidebarLaunchGroupState | null = null;
  for (const member of members) {
    const { state, move } = resolveSidebarLaunchMemberState(member);
    if (state === null) continue;
    countByState[state] += 1;
    if (state === "needs-you" && move !== null) needsYou.push({ title: member.title, move });
    if (mostUrgent === null || GROUP_STATE_PRIORITY[state] > GROUP_STATE_PRIORITY[mostUrgent]) {
      mostUrgent = state;
    }
  }
  const parts = (Object.keys(GROUP_STATE_PRIORITY) as SidebarLaunchGroupState[])
    .toSorted((left, right) => GROUP_STATE_PRIORITY[right] - GROUP_STATE_PRIORITY[left])
    .filter((state) => countByState[state] > 0)
    .map(
      (state) => `${countByState[state]} ${SIDEBAR_LAUNCH_GROUP_STATE_LABEL[state].toLowerCase()}`,
    );
  const subagents = members.filter((member) => member.subagent === true).length;
  const launched = members.length - subagents;
  const nouns = [
    launched === 0
      ? null
      : `${launched} ${launched === 1 ? "launched thread" : "launched threads"}`,
    subagents === 0 ? null : `${subagents} ${subagents === 1 ? "subagent" : "subagents"}`,
  ].filter((noun) => noun !== null);
  return {
    count: members.length,
    mostUrgent,
    countByState,
    needsYou,
    tooltip: `${nouns.join(" and ")}${parts.length > 0 ? `: ${parts.join(", ")}` : ""}`,
  };
}

/**
 * A nested thread's "Needs you" lifts to its parent's row, so a collapsed
 * group, or a parent that is itself still working, cannot hide a question.
 */
export function liftSidebarMoveState(
  own: SidebarMoveState | null,
  group: SidebarLaunchGroupSummary | null,
): SidebarMoveState | null {
  const first = group?.needsYou[0];
  if (group == null || first === undefined) return own;
  const more = group.needsYou.length - 1;
  const childReason = `«${first.title}»: ${first.move.tooltip}${more > 0 ? ` (+${more} more)` : ""}`;
  if (own?.kind === "needs-you") {
    return { ...own, tooltip: `${own.tooltip}. Also ${childReason}` };
  }
  return { kind: "needs-you", reason: first.move.reason, tooltip: childReason };
}

/** Rows whose next step is another agent's recede like working rows; a lifted
    "Needs you" never recedes. */
export function resolveSidebarMoveRecede(input: {
  readonly move: SidebarMoveState | null;
  readonly recedeToday: boolean;
}): boolean {
  if (input.move?.kind === "needs-you") return false;
  if (input.move?.kind === "with-orchestrator") return true;
  return input.recedeToday;
}
