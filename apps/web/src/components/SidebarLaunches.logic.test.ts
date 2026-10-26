import { EnvironmentId, ProjectId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture, type ThreadFixtureOverrides } from "../test-fixtures";
import type { Thread } from "../types";
import { resolveSidebarThreadStatus } from "./Sidebar.logic";
import {
  flattenSidebarLaunchGroup,
  isSidebarLaunchChildShown,
  isSidebarLaunchGroupExpanded,
  isSidebarMoveUnread,
  liftSidebarMoveState,
  nestSidebarLaunchedThreads,
  nestSidebarSearchResults,
  readSidebarLaunchGroupChoices,
  resolveSidebarFamilyStatus,
  resolveSidebarLaunchGroupDefaults,
  resolveSidebarLauncherKey,
  resolveSidebarMoveRecede,
  resolveSidebarMoveState,
  sidebarLaunchThreadKey,
  sidebarThreadHoldsInbox,
  summarizeSidebarLaunchGroup,
  toggleSidebarLaunchGroup,
  type SidebarLaunchGroupDefault,
  type SidebarLaunchGroupMember,
  type SidebarLaunchSections,
} from "./SidebarLaunches.logic";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-aihub");

function thread(id: string, overrides: ThreadFixtureOverrides = {}): Thread {
  return makeThreadFixture({
    environmentId,
    projectId,
    id: ThreadId.make(id),
    title: id,
    ...overrides,
  });
}

function launched(id: string, by: string, overrides: ThreadFixtureOverrides = {}): Thread {
  return thread(id, { launchedByThreadId: ThreadId.make(by), ...overrides });
}

function subagentOf(id: string, parent: string, overrides: ThreadFixtureOverrides = {}): Thread {
  return thread(id, {
    lineage: {
      rootThreadId: ThreadId.make(parent),
      parentThreadId: ThreadId.make(parent),
      relationshipToParent: "subagent",
    },
    ...overrides,
  });
}

const key = (id: string) => sidebarLaunchThreadKey({ environmentId, id: ThreadId.make(id) });

function byKey(threads: readonly Thread[]) {
  return new Map(threads.map((candidate) => [sidebarLaunchThreadKey(candidate), candidate]));
}

function sections(
  input: Partial<Record<keyof SidebarLaunchSections<Thread>, Thread[]>>,
): SidebarLaunchSections<Thread> {
  return {
    pinned: input.pinned ?? [],
    active: input.active ?? [],
    working: input.working ?? [],
    snoozed: input.snoozed ?? [],
    shelved: input.shelved ?? [],
    settled: input.settled ?? [],
  };
}

function nest(
  input: SidebarLaunchSections<Thread>,
  extra: readonly Thread[] = [],
  subagents?: readonly Thread[],
) {
  const all = [
    ...input.pinned,
    ...input.active,
    ...input.working,
    ...input.snoozed,
    ...input.shelved,
    ...input.settled,
    ...extra,
    ...(subagents ?? []),
  ];
  return nestSidebarLaunchedThreads({
    sections: input,
    threadByKey: byKey(all),
    holdsInbox: sidebarThreadHoldsInbox,
    subagents,
  });
}

const ids = (list: readonly Thread[]) => list.map((candidate) => candidate.id as string);

const runtime = {
  activeRunId: null,
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  providerName: null,
  lastError: null,
  updatedAt: "2026-10-09T10:00:00.000Z",
};

describe("resolveSidebarLauncherKey", () => {
  it("names the launcher, and walks past a hidden subagent that made the call", () => {
    const orchestrator = thread("orchestrator");
    const subagent = thread("subagent", {
      lineage: {
        rootThreadId: ThreadId.make("orchestrator"),
        parentThreadId: ThreadId.make("orchestrator"),
        relationshipToParent: "subagent",
      },
    });
    const writer = launched("writer", "orchestrator");
    const viaSubagent = launched("via-subagent", "subagent");
    const threads = byKey([orchestrator, subagent, writer, viaSubagent]);

    expect(resolveSidebarLauncherKey(writer, threads)).toBe(key("orchestrator"));
    expect(resolveSidebarLauncherKey(viaSubagent, threads)).toBe(key("orchestrator"));
    expect(resolveSidebarLauncherKey(orchestrator, threads)).toBeNull();
    expect(resolveSidebarLauncherKey(launched("orphan", "deleted"), threads)).toBeNull();
  });
});

describe("nestSidebarLaunchedThreads", () => {
  it("takes launched threads out of the sections and nests them in launch order", () => {
    const orchestrator = thread("orchestrator");
    const second = launched("writer-2", "orchestrator", {
      createdAt: "2026-10-09T10:02:00.000Z",
    });
    const first = launched("writer-1", "orchestrator", {
      createdAt: "2026-10-09T10:01:00.000Z",
    });
    const reviewer = launched("reviewer", "writer-1");
    const human = thread("human");

    const result = nest(sections({ active: [second, orchestrator, human, first, reviewer] }));

    expect(ids(result.sections.active)).toEqual(["orchestrator", "human"]);
    expect(result.forest.childKeysByParentKey.get(key("orchestrator"))).toEqual([
      key("writer-1"),
      key("writer-2"),
    ]);
    expect(result.forest.parentKeyByChildKey.get(key("reviewer"))).toBe(key("writer-1"));
    expect(result.nestedSectionByKey.get(key("writer-2"))).toBe("active");
  });

  it("returns the sections untouched when nothing nests", () => {
    const input = sections({ active: [thread("a"), launched("b", "gone")] });
    expect(nest(input).sections).toBe(input);
  });

  it("keeps a child launched into another project where it is", () => {
    const orchestrator = thread("orchestrator");
    const elsewhere = launched("elsewhere", "orchestrator", {
      projectId: ProjectId.make("project-other"),
    });
    const result = nest(sections({ active: [orchestrator, elsewhere] }));
    expect(ids(result.sections.active)).toEqual(["orchestrator", "elsewhere"]);
  });

  it("nests only within the scope the sidebar shows", () => {
    // The launcher exists but is outside the shown sections (scoped out).
    const outOfScope = thread("orchestrator");
    const writer = launched("writer", "orchestrator");
    const result = nest(sections({ active: [writer] }), [outOfScope]);
    expect(ids(result.sections.active)).toEqual(["writer"]);
  });

  it("nests inbox children under a pinned parent, but keeps pinned, snoozed and settled children in place", () => {
    const pinnedOrchestrator = thread("pinned-orchestrator", {
      pinnedAt: "2026-10-09T09:00:00.000Z",
    });
    const inboxOrchestrator = thread("inbox-orchestrator");
    const live = launched("live", "pinned-orchestrator");
    const pinnedChild = launched("pinned-child", "inbox-orchestrator");
    const settledChild = launched("settled-child", "inbox-orchestrator");
    const snoozedChild = launched("snoozed-child", "inbox-orchestrator");
    const settledParentChild = launched("live-under-settled", "settled-orchestrator");
    const settledOrchestrator = thread("settled-orchestrator");

    const result = nest(
      sections({
        pinned: [pinnedOrchestrator, pinnedChild],
        active: [inboxOrchestrator, live, settledParentChild],
        snoozed: [snoozedChild],
        settled: [settledChild, settledOrchestrator],
      }),
    );

    expect(result.forest.parentKeyByChildKey.get(key("live"))).toBe(key("pinned-orchestrator"));
    expect(result.nestedSectionByKey.get(key("live"))).toBe("active");
    expect(ids(result.sections.pinned)).toEqual(["pinned-orchestrator", "pinned-child"]);
    expect(ids(result.sections.active)).toEqual(["inbox-orchestrator", "live-under-settled"]);
    expect(ids(result.sections.snoozed)).toEqual(["snoozed-child"]);
    expect(ids(result.sections.settled)).toEqual(["settled-child", "settled-orchestrator"]);
  });

  it("puts a shelved thread's finished children on the shelf with it, never its live ones", () => {
    const shelvedOrchestrator = thread("shelved-orchestrator");
    const finished = launched("finished", "shelved-orchestrator");
    const live = launched("live", "shelved-orchestrator");

    const result = nest(
      sections({ active: [live], shelved: [shelvedOrchestrator], settled: [finished] }),
    );

    expect(result.forest.parentKeyByChildKey.get(key("finished"))).toBe(
      key("shelved-orchestrator"),
    );
    expect(result.nestedSectionByKey.get(key("finished"))).toBe("settled");
    expect(ids(result.sections.shelved)).toEqual(["shelved-orchestrator"]);
    expect(ids(result.sections.settled)).toEqual([]);
    expect(ids(result.sections.active)).toEqual(["live"]);
  });

  it("brings a working group back to the inbox while a child needs the user", () => {
    const working = { ...runtime, status: "running" as const };
    const orchestrator = thread("orchestrator", { runtime: working });
    const asking = launched("asking", "orchestrator", { hasPendingUserInput: true });
    const result = nest(sections({ working: [orchestrator], active: [asking] }));
    expect(ids(result.sections.active)).toEqual(["orchestrator"]);
    expect(result.sections.working).toEqual([]);
  });

  it("leaves a working group folded when its children only wait on the orchestrator", () => {
    const working = { ...runtime, status: "running" as const };
    const orchestrator = thread("orchestrator", { runtime: working });
    const finished = launched("finished", "orchestrator", {
      runtime: { ...runtime, status: "completed" },
    });
    const result = nest(sections({ working: [orchestrator], active: [finished] }));
    expect(ids(result.sections.working)).toEqual(["orchestrator"]);
    expect(result.sections.active).toEqual([]);
    expect(result.nestedSectionByKey.get(key("finished"))).toBe("active");
  });

  it("breaks a launch cycle instead of hiding the threads in it", () => {
    const a = launched("a", "b");
    const b = launched("b", "a");
    const result = nest(sections({ active: [a, b] }));
    expect(result.sections.active.length).toBeGreaterThan(0);
  });
});

describe("collapsed launch groups", () => {
  const orchestrator = thread("orchestrator");
  const writer = launched("writer", "orchestrator");
  const reviewer = launched("reviewer", "writer");
  const other = launched("other", "orchestrator", { createdAt: "2026-10-09T11:00:00.000Z" });
  const { forest } = nest(sections({ active: [orchestrator, writer, reviewer, other] }));

  it("opens launch groups by default and remembers only a fold", () => {
    const folded = toggleSidebarLaunchGroup([], key("orchestrator"), "all");
    expect(folded).toEqual([key("orchestrator")]);
    const choices = readSidebarLaunchGroupChoices(folded);
    expect(
      isSidebarLaunchGroupExpanded({ choice: choices.get(key("orchestrator")), byDefault: "all" }),
    ).toBe(false);
    expect(
      isSidebarLaunchGroupExpanded({ choice: choices.get(key("writer")), byDefault: "all" }),
    ).toBe(true);
    // Opening it again is what it does by itself, so the choice is dropped.
    expect(toggleSidebarLaunchGroup(folded, key("orchestrator"), "all")).toEqual([]);
  });

  it("lists an expanded group depth-first with depths", () => {
    expect(
      flattenSidebarLaunchGroup({
        rootKey: key("orchestrator"),
        forest,
        isShown: () => true,
        routeThreadKey: null,
      }),
    ).toEqual([
      { key: key("writer"), depth: 1 },
      { key: key("reviewer"), depth: 2 },
      { key: key("other"), depth: 1 },
    ]);
  });

  it("hides a collapsed group's rows but keeps the open thread and its path", () => {
    expect(
      flattenSidebarLaunchGroup({
        rootKey: key("orchestrator"),
        forest,
        isShown: () => false,
        routeThreadKey: null,
      }),
    ).toEqual([]);
    expect(
      flattenSidebarLaunchGroup({
        rootKey: key("orchestrator"),
        forest,
        isShown: () => false,
        routeThreadKey: key("reviewer"),
      }),
    ).toEqual([
      { key: key("writer"), depth: 1 },
      { key: key("reviewer"), depth: 2 },
    ]);
  });
});

describe("subagents in the forest", () => {
  const working = { ...runtime, status: "running" as const };

  it("nests each subagent under its parent wherever that sits, its own subagents one level deeper", () => {
    const orchestrator = thread("orchestrator");
    const writer = launched("writer", "orchestrator");
    const settledParent = thread("settled-parent");
    const explore = subagentOf("explore", "orchestrator");
    const nested = subagentOf("nested", "explore");
    const writerHelper = subagentOf("writer-helper", "writer");
    const busyUnderSettled = subagentOf("busy-under-settled", "settled-parent", {
      runtime: working,
    });

    const result = nest(
      sections({ active: [orchestrator, writer], settled: [settledParent] }),
      [],
      [explore, nested, writerHelper, busyUnderSettled],
    );

    expect(ids(result.sections.active)).toEqual(["orchestrator"]);
    expect(ids(result.sections.settled)).toEqual(["settled-parent"]);
    expect(result.forest.parentKeyByChildKey.get(key("explore"))).toBe(key("orchestrator"));
    expect(result.forest.parentKeyByChildKey.get(key("nested"))).toBe(key("explore"));
    expect(result.forest.parentKeyByChildKey.get(key("writer-helper"))).toBe(key("writer"));
    expect(result.forest.subagentKeys).toEqual(
      new Set([key("explore"), key("nested"), key("writer-helper"), key("busy-under-settled")]),
    );
    expect(result.forest.subagentKeys.has(key("writer"))).toBe(false);
    // A subagent takes its parent's place, not one of its own.
    expect(result.nestedSectionByKey.get(key("nested"))).toBe("active");
    expect(result.nestedSectionByKey.get(key("busy-under-settled"))).toBe("settled");
    expect(result.nestedThreadByKey.get(key("nested"))).toBe(nested);
  });

  it("never makes a subagent a root: without a parent row it stays hidden", () => {
    const visible = thread("visible");
    const outOfScope = thread("out-of-scope");
    const result = nest(
      sections({ active: [visible] }),
      [outOfScope],
      [
        subagentOf("scoped-out", "out-of-scope"),
        subagentOf("orphan", "deleted"),
        subagentOf("orphan-child", "orphan"),
        subagentOf("loop-a", "loop-b"),
        subagentOf("loop-b", "loop-a"),
      ],
    );
    expect(ids(result.sections.active)).toEqual(["visible"]);
    expect(result.forest.parentKeyByChildKey.size).toBe(0);
    expect(result.nestedThreadByKey.size).toBe(0);
  });

  it("does not pull a working parent back into the inbox for its subagent's question", () => {
    const parent = thread("parent", { runtime: working });
    const asking = subagentOf("asking", "parent", { hasPendingUserInput: true });
    const result = nest(sections({ working: [parent] }), [], [asking]);
    expect(ids(result.sections.working)).toEqual(["parent"]);
  });
});

describe("subagent groups", () => {
  const working = { ...runtime, status: "running" as const };
  const parentIds = ["idle", "busy", "asking", "mixed", "mixed-busy", "launcher"];
  const children = [
    subagentOf("idle-1", "idle"),
    subagentOf("idle-2", "idle"),
    subagentOf("busy-1", "busy"),
    subagentOf("busy-2", "busy", { runtime: working }),
    subagentOf("asking-1", "asking", { hasPendingApprovals: true }),
    subagentOf("mixed-1", "mixed"),
    launched("mixed-writer", "mixed"),
    subagentOf("mixed-busy-1", "mixed-busy", { hasPendingUserInput: true }),
    launched("mixed-busy-writer", "mixed-busy"),
    launched("writer", "launcher"),
  ];
  const isSubagent = (candidate: Thread) => candidate.lineage.relationshipToParent === "subagent";
  const { forest } = nest(
    sections({
      active: [...parentIds.map((id) => thread(id)), ...children.filter((c) => !isSubagent(c))],
    }),
    [],
    children.filter(isSubagent),
  );
  const childByKey = byKey(children);
  const defaults = resolveSidebarLaunchGroupDefaults({
    forest,
    subagentStatus: (childKey) => {
      const child = childByKey.get(childKey);
      return child === undefined ? null : resolveSidebarThreadStatus(child);
    },
  });
  const byDefault = (parent: string): SidebarLaunchGroupDefault =>
    defaults.byParentKey.get(key(parent)) ?? "all";
  const shown = (child: string, choice?: boolean) =>
    isSidebarLaunchChildShown({
      choice,
      isSubagent: forest.subagentKeys.has(key(child)),
      isBusy: defaults.busySubagentKeys.has(key(child)),
    });

  it("shows only busy subagents by itself; launched threads stay open", () => {
    expect(Object.fromEntries(parentIds.map((id) => [id, byDefault(id)]))).toEqual({
      idle: "none",
      busy: "some",
      asking: "all",
      mixed: "some",
      "mixed-busy": "all",
      launcher: "all",
    });
    expect(shown("idle-1")).toBe(false);
    expect(shown("busy-2")).toBe(true);
    expect(shown("busy-1")).toBe(false);
    expect(shown("asking-1")).toBe(true);
    expect(shown("mixed-writer")).toBe(true);
    expect(shown("mixed-1")).toBe(false);
    // A group showing part of itself reads as folded, so its toggle opens the rest.
    expect(isSidebarLaunchGroupExpanded({ choice: undefined, byDefault: "some" })).toBe(false);
    expect(isSidebarLaunchGroupExpanded({ choice: undefined, byDefault: "all" })).toBe(true);
    expect(isSidebarLaunchGroupExpanded({ choice: undefined, byDefault: "none" })).toBe(false);
  });

  it("shows every subagent, finished ones too, in a group opened by hand", () => {
    expect(shown("busy-1", true)).toBe(true);
    expect(shown("idle-1", true)).toBe(true);
    expect(shown("busy-2", false)).toBe(false);
    expect(shown("mixed-writer", false)).toBe(false);
  });

  it("remembers a manual toggle over the automatic state, until it is the automatic state", () => {
    const parent = key("parent");
    // Opening a folded or partly shown group by hand is remembered.
    for (const state of ["none", "some"] as const) {
      expect(toggleSidebarLaunchGroup([], parent, state)).toEqual([`+${parent}`]);
    }
    const opened = [`+${parent}`];
    const openedChoice = readSidebarLaunchGroupChoices(opened).get(parent);
    for (const state of ["none", "some", "all"] as const) {
      expect(isSidebarLaunchGroupExpanded({ choice: openedChoice, byDefault: state })).toBe(true);
    }
    // Folding it while a subagent works sticks, for the next busy one too.
    expect(toggleSidebarLaunchGroup(opened, parent, "some")).toEqual([parent]);
    // Folding it back while its subagents are idle hands it back to them.
    expect(toggleSidebarLaunchGroup(opened, parent, "none")).toEqual([]);

    // A fully shown group (launched threads only, or every subagent busy) folds
    // by hand and opens again to the automatic state.
    const folded = toggleSidebarLaunchGroup([], parent, "all");
    expect(folded).toEqual([parent]);
    const foldedChoice = readSidebarLaunchGroupChoices(folded).get(parent);
    expect(isSidebarLaunchGroupExpanded({ choice: foldedChoice, byDefault: "all" })).toBe(false);
    expect(toggleSidebarLaunchGroup(folded, parent, "all")).toEqual([]);
  });

  it("keeps the open subagent and its path in a folded group", () => {
    const parent = thread("parent");
    const { forest: own } = nest(
      sections({ active: [parent] }),
      [],
      [subagentOf("first", "parent"), subagentOf("second", "parent"), subagentOf("deep", "second")],
    );
    expect(
      flattenSidebarLaunchGroup({
        rootKey: key("parent"),
        forest: own,
        isShown: () => false,
        routeThreadKey: key("deep"),
      }),
    ).toEqual([
      { key: key("second"), depth: 1 },
      { key: key("deep"), depth: 2 },
    ]);
  });
});

describe("nestSidebarSearchResults", () => {
  const orchestrator = thread("orchestrator");
  const other = thread("other");
  const explore = subagentOf("explore", "orchestrator");
  const deep = subagentOf("deep", "explore");
  const sibling = subagentOf("sibling", "orchestrator");
  const all = [orchestrator, other, explore, deep, sibling];
  const { forest } = nest(
    sections({ active: [orchestrator, other] }),
    [],
    [explore, deep, sibling],
  );
  const search = (matches: readonly Thread[]) =>
    nestSidebarSearchResults({ matches, threads: all, forest }).map(
      (row) => `${row.thread.id}:${row.depth}${row.isContext ? ":context" : ""}`,
    );

  it("keeps results as they are when no subagent matches", () => {
    expect(search([other, orchestrator])).toEqual(["other:0", "orchestrator:0"]);
  });

  it("shows a matching subagent under its parents, which come along as context", () => {
    expect(search([other, deep])).toEqual([
      "other:0",
      "orchestrator:0:context",
      "explore:1:context",
      "deep:2",
    ]);
  });

  it("lets a matching parent keep the place its subagent gave it, once", () => {
    expect(search([sibling, deep, other, orchestrator])).toEqual([
      "orchestrator:0",
      "explore:1:context",
      "deep:2",
      "sibling:1",
      "other:0",
    ]);
  });
});

describe("resolveSidebarMoveState", () => {
  const base = { isUnread: false, hasPlanPrompt: false, goalActive: false, launcher: null };
  const busyLauncher = { title: "Orchestrator", status: "working" as const };
  const doneLauncher = { title: "Orchestrator", status: "ready" as const };

  it("reads a running thread, and one waiting on its background work, as Working", () => {
    expect(resolveSidebarMoveState({ ...base, status: "working" })?.kind).toBe("working");
    expect(resolveSidebarMoveState({ ...base, status: "working", goalActive: true })).toEqual({
      kind: "working",
      reason: "goal",
      tooltip: "Working toward its /goal",
    });
    expect(resolveSidebarMoveState({ ...base, status: "waiting" })).toMatchObject({
      kind: "working",
      reason: "background",
    });
  });

  // FORK: a thread whose own turn ended, while threads working for it still do.
  it("reads a thread waiting on its subagents and writers as Working, naming them", () => {
    expect(
      resolveSidebarMoveState({
        ...base,
        status: "working",
        workingFamily: ["Card writer", "Card review"],
      }),
    ).toEqual({
      kind: "working",
      reason: "family",
      tooltip: "Its subagents and writers are working: «Card writer», «Card review»",
    });
    expect(
      resolveSidebarMoveState({
        ...base,
        status: "working",
        workingFamily: ["A", "B", "C", "D", "E"],
      })?.tooltip,
    ).toBe("Its subagents and writers are working: «A», «B», «C» and 2 more");
  });

  it("lets working threads under a stopped thread make it working, but not past the user", () => {
    expect(resolveSidebarFamilyStatus("ready", true)).toBe("working");
    expect(resolveSidebarFamilyStatus("waiting", true)).toBe("working");
    expect(resolveSidebarFamilyStatus("ready", false)).toBe("ready");
    for (const status of [
      "approval",
      "input",
      "request",
      "failed",
      "limited",
      "working",
    ] as const) {
      expect(resolveSidebarFamilyStatus(status, true)).toBe(status);
    }
  });

  it("names the user for approvals, questions, plans and finished top-level threads", () => {
    expect(resolveSidebarMoveState({ ...base, status: "approval" })).toMatchObject({
      kind: "needs-you",
      tooltip: "Waiting for your approval",
    });
    expect(
      resolveSidebarMoveState({ ...base, status: "input", launcher: busyLauncher }),
    ).toMatchObject({ kind: "needs-you", tooltip: "Asked you a question" });
    expect(
      resolveSidebarMoveState({ ...base, status: "request", launcher: busyLauncher }),
    ).toMatchObject({ kind: "needs-you", tooltip: "Waiting for your reply to a guest" });
    expect(
      resolveSidebarMoveState({
        ...base,
        status: "ready",
        isUnread: true,
        hasPlanPrompt: true,
        launcher: busyLauncher,
      }),
    ).toMatchObject({ kind: "needs-you", reason: "plan" });
    expect(resolveSidebarMoveState({ ...base, status: "ready", isUnread: true })).toMatchObject({
      kind: "needs-you",
      reason: "finished",
    });
  });

  it("hands a finished launched thread to its orchestrator, then calls it Done", () => {
    expect(
      resolveSidebarMoveState({ ...base, status: "ready", isUnread: true, launcher: busyLauncher }),
    ).toEqual({
      kind: "with-orchestrator",
      reason: "launcher-busy",
      tooltip: "Finished its turn. «Orchestrator» has the next step",
    });
    expect(
      resolveSidebarMoveState({
        ...base,
        status: "ready",
        isUnread: true,
        launcher: { title: "Orchestrator", status: "waiting" },
      })?.kind,
    ).toBe("with-orchestrator");
    expect(
      resolveSidebarMoveState({ ...base, status: "ready", isUnread: true, launcher: doneLauncher }),
    ).toMatchObject({
      kind: "done",
      tooltip: "Finished its turn. «Orchestrator» has finished too",
    });
  });

  it("keeps today's timing: no pill once read, and failures keep their own pill", () => {
    expect(resolveSidebarMoveState({ ...base, status: "ready" })).toBeNull();
    expect(
      resolveSidebarMoveState({ ...base, status: "ready", launcher: busyLauncher }),
    ).toBeNull();
    expect(resolveSidebarMoveState({ ...base, status: "failed", isUnread: true })).toBeNull();
    expect(resolveSidebarMoveState({ ...base, status: "limited", isUnread: true })).toBeNull();
  });
});

describe("isSidebarMoveUnread", () => {
  const latestRun = { completedAt: "2026-10-09T10:00:00.000Z" };
  it("counts a never-opened launched thread's completion as unread, and no one else's", () => {
    expect(
      isSidebarMoveUnread({
        isUnread: false,
        isLaunched: true,
        lastVisitedAt: undefined,
        latestRun,
      }),
    ).toBe(true);
    expect(
      isSidebarMoveUnread({
        isUnread: false,
        isLaunched: false,
        lastVisitedAt: undefined,
        latestRun,
      }),
    ).toBe(false);
    expect(
      isSidebarMoveUnread({
        isUnread: false,
        isLaunched: true,
        lastVisitedAt: "2026-10-09T11:00:00.000Z",
        latestRun,
      }),
    ).toBe(false);
    expect(
      isSidebarMoveUnread({
        isUnread: false,
        isLaunched: true,
        lastVisitedAt: undefined,
        latestRun: null,
      }),
    ).toBe(false);
  });
});

describe("launch group summary and the lift to the parent", () => {
  const launcher = { title: "Orchestrator", status: "working" as const };
  const member = (overrides: Partial<SidebarLaunchGroupMember>): SidebarLaunchGroupMember => ({
    title: "Writer",
    status: "ready",
    isUnread: false,
    hasPlanPrompt: false,
    goalActive: false,
    launcher,
    ...overrides,
  });

  it("counts every nested thread and names the most urgent state", () => {
    const summary = summarizeSidebarLaunchGroup([
      member({ title: "Writer 1", status: "working" }),
      member({ title: "Writer 2" }),
      member({ title: "Writer 3", status: "failed" }),
      member({ title: "Writer 4", status: "input" }),
    ]);
    expect(summary).toMatchObject({
      count: 4,
      mostUrgent: "needs-you",
      tooltip: "4 launched threads: 1 needs you, 1 failed, 1 working, 1 with orchestrator",
    });
    expect(summary?.needsYou.map((entry) => entry.title)).toEqual(["Writer 4"]);
  });

  it("keeps a read finished child as with-orchestrator, but lets a read plan stop lifting", () => {
    expect(summarizeSidebarLaunchGroup([member({})])?.mostUrgent).toBe("with-orchestrator");
    expect(
      summarizeSidebarLaunchGroup([member({ hasPlanPrompt: true, isUnread: false })])?.mostUrgent,
    ).toBe("with-orchestrator");
    expect(
      summarizeSidebarLaunchGroup([member({ hasPlanPrompt: true, isUnread: true })])?.mostUrgent,
    ).toBe("needs-you");
    expect(summarizeSidebarLaunchGroup([])).toBeNull();
  });

  it("lifts a child's Needs you over the parent's own state", () => {
    const group = summarizeSidebarLaunchGroup([
      member({ title: "Writer 1", status: "approval" }),
      member({ title: "Writer 2", status: "input" }),
    ]);
    const working = resolveSidebarMoveState({
      status: "working",
      isUnread: false,
      hasPlanPrompt: false,
      goalActive: false,
      launcher: null,
    });
    expect(liftSidebarMoveState(working, group)).toEqual({
      kind: "needs-you",
      reason: "approval",
      tooltip: "«Writer 1»: Waiting for your approval (+1 more)",
    });
    expect(liftSidebarMoveState(null, group)?.kind).toBe("needs-you");
    const own = { kind: "needs-you" as const, reason: "input" as const, tooltip: "Asked you" };
    expect(liftSidebarMoveState(own, group)?.tooltip).toBe(
      "Asked you. Also «Writer 1»: Waiting for your approval (+1 more)",
    );
    const calm = summarizeSidebarLaunchGroup([member({ status: "working" })]);
    expect(liftSidebarMoveState(working, calm)).toBe(working);
  });

  it("counts subagents only while they work or ask, and lifts none of them", () => {
    const summary = summarizeSidebarLaunchGroup([
      member({ title: "Writer" }),
      member({ title: "Explore", status: "working", subagent: true }),
      member({ title: "Finished", isUnread: true, subagent: true }),
      member({ title: "Broke", status: "failed", subagent: true }),
      member({ title: "Asks", status: "approval", subagent: true }),
    ]);
    expect(summary).toMatchObject({
      count: 5,
      mostUrgent: "needs-you",
      tooltip: "1 launched thread and 4 subagents: 1 needs you, 1 working, 1 with orchestrator",
    });
    expect(summary?.needsYou).toEqual([]);
    expect(
      summarizeSidebarLaunchGroup([
        member({ subagent: true }),
        member({ status: "failed", subagent: true }),
      ]),
    ).toMatchObject({ count: 2, mostUrgent: null, tooltip: "2 subagents" });
  });

  it("recedes rows waiting on another agent, never a row that needs the user", () => {
    const withOrchestrator = {
      kind: "with-orchestrator" as const,
      reason: "launcher-busy" as const,
      tooltip: "",
    };
    const needsYou = { kind: "needs-you" as const, reason: "input" as const, tooltip: "" };
    expect(resolveSidebarMoveRecede({ move: withOrchestrator, recedeToday: false })).toBe(true);
    expect(resolveSidebarMoveRecede({ move: needsYou, recedeToday: true })).toBe(false);
    expect(resolveSidebarMoveRecede({ move: null, recedeToday: true })).toBe(true);
  });
});

describe("sidebarThreadHoldsInbox", () => {
  it("holds for approvals, questions, plans and failures, not for a finished turn", () => {
    const runId = RunId.make("run-1");
    const settledRun = {
      runId,
      status: "completed" as const,
      requestedAt: null,
      startedAt: null,
      completedAt: "2026-10-09T10:00:00.000Z",
      assistantMessageId: null,
    };
    expect(sidebarThreadHoldsInbox(thread("a", { hasPendingApprovals: true }))).toBe(true);
    expect(sidebarThreadHoldsInbox(thread("b", { hasPendingUserInput: true }))).toBe(true);
    expect(sidebarThreadHoldsInbox(thread("guest", { pendingGuestMessageCount: 1 }))).toBe(true);
    expect(
      sidebarThreadHoldsInbox(
        thread("c", { runtime: { ...runtime, status: "failed", lastError: "boom" } }),
      ),
    ).toBe(true);
    expect(
      sidebarThreadHoldsInbox(
        thread("d", {
          interactionMode: "plan",
          hasActionableProposedPlan: true,
          latestRun: settledRun,
          runtime: { ...runtime, status: "completed" },
        }),
      ),
    ).toBe(true);
    expect(
      sidebarThreadHoldsInbox(
        thread("e", { latestRun: settledRun, runtime: { ...runtime, status: "completed" } }),
      ),
    ).toBe(false);
  });
});
