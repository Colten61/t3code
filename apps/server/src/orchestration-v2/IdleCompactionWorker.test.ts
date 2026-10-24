import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ContextTransfer,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import {
  IDLE_COMPACTION_LEAD_MS,
  idleCompactionCandidate,
  idleCompactionContextSkip,
  idleCompactionThreadSkip,
  idleCompactionWindow,
  latestIdleCompactionContext,
  makeIdleCompactionWorker,
  type IdleCompactionCandidate,
  type IdleCompactionThread,
} from "./IdleCompactionWorker.ts";
import { idleCompactionMayStart } from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";

const threadId = ThreadId.make("thread-idle");
const runId = RunId.make("run-1");
const modelSelection = { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus-5-5" };
const HOUR_MS = 60 * 60_000;

const run = (overrides: Partial<OrchestrationV2Run> = {}) =>
  ({
    id: runId,
    threadId,
    status: "completed",
    completedAt: DateTime.makeUnsafe(0),
    modelSelection,
    ...overrides,
  }) as OrchestrationV2Run;

const candidate: IdleCompactionCandidate = {
  threadId,
  runId,
  completedAtMs: 0,
  modelSelection,
};

const idleThread: IdleCompactionThread = {
  modelSelection,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  latestRunId: runId,
  activeRunId: null,
  activityRunStatus: null,
  pendingRuntimeRequest: null,
  pendingBackgroundTasks: [],
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  snoozedUntil: null,
} as unknown as IdleCompactionThread;

/** A report on the request sent at `requestedAtMs`, with the cache it wrote, if any. */
const report = (usedTokens: number, requestedAtMs: number, promptCacheTtlMs?: number) => ({
  tokenUsage: {
    usedTokens,
    requestedAt: DateTime.formatIso(DateTime.makeUnsafe(requestedAtMs)),
    updatedAt: DateTime.formatIso(DateTime.makeUnsafe(requestedAtMs)),
    ...(promptCacheTtlMs === undefined
      ? {}
      : {
          promptCacheTtlMs,
          promptCacheExpiresAt: DateTime.formatIso(
            DateTime.makeUnsafe(requestedAtMs + promptCacheTtlMs),
          ),
        }),
  },
});

const pendingMergeBack = {
  type: "merge_back",
  sourceThreadId: ThreadId.make("child"),
  targetThreadId: threadId,
  status: "pending",
} as OrchestrationV2ContextTransfer;

describe("idle compaction decisions", () => {
  it("makes a thread due when a run leaves it idle, never after a failure or its own compaction", () => {
    assert.deepEqual(idleCompactionCandidate(run()), candidate);
    assert.deepEqual(idleCompactionCandidate(run({ status: "interrupted" }))?.runId, runId);
    assert.isNull(idleCompactionCandidate(run({ status: "failed" })));
    assert.isNull(idleCompactionCandidate(run({ status: "cancelled" })));
    assert.isNull(idleCompactionCandidate(run({ status: "running", completedAt: null })));
    assert.isNull(idleCompactionCandidate(run({ idleCompactionOfRunId: RunId.make("run-0") })));
  });

  it("leaves a thread alone unless it still sits idle where it was", () => {
    const skip = (thread: Partial<IdleCompactionThread>) =>
      idleCompactionThreadSkip({
        candidate,
        thread: { ...idleThread, ...thread },
        nowMs: HOUR_MS - IDLE_COMPACTION_LEAD_MS,
      });
    assert.isNull(skip({}));
    // Shelved threads are compacted: the user comes back to them later.
    assert.isNull(skip({ shelvedAt: DateTime.makeUnsafe(0) } as Partial<IdleCompactionThread>));
    assert.equal(skip({ archivedAt: DateTime.makeUnsafe(0) }), "archived");
    assert.equal(skip({ settledOverride: "settled" }), "settled");
    assert.equal(skip({ settledAt: DateTime.makeUnsafe(0) }), "settled");
    assert.equal(
      skip({
        lineage: {
          parentThreadId: ThreadId.make("parent"),
          relationshipToParent: "subagent",
          rootThreadId: ThreadId.make("parent"),
        },
      } as Partial<IdleCompactionThread>),
      "subagent",
    );
    assert.equal(skip({ snoozedUntil: DateTime.makeUnsafe(2 * HOUR_MS) }), "snoozed");
    assert.isNull(skip({ snoozedUntil: DateTime.makeUnsafe(1) }));
    assert.equal(skip({ latestRunId: RunId.make("run-2") }), "busy");
    assert.equal(skip({ activityRunStatus: "running" }), "busy");
    assert.equal(
      skip({ pendingRuntimeRequest: {} } as unknown as Partial<IdleCompactionThread>),
      "busy",
    );
    assert.equal(
      skip({ modelSelection: { ...modelSelection, model: "claude-sonnet-5-5" } }),
      "model_changed",
    );
  });

  it("times the compaction by the cache the latest request wrote", () => {
    assert.isNull(latestIdleCompactionContext([{}]));
    const context = latestIdleCompactionContext([
      report(100_000, 1, HOUR_MS),
      report(320_000, 3, HOUR_MS),
      {},
    ]);
    assert.deepEqual(context, {
      usedTokens: 320_000,
      promptCacheTtlMs: HOUR_MS,
      promptCacheExpiresAtMs: 3 + HOUR_MS,
    });
    assert.deepEqual(idleCompactionWindow(context), {
      startMs: 3 + HOUR_MS - IDLE_COMPACTION_LEAD_MS,
      endMs: 3 + HOUR_MS,
    });
    assert.isNull(idleCompactionWindow(latestIdleCompactionContext([report(320_000, 3, 300_000)])));
  });

  it("dates a fully cached request's cache from its own start and the latest lifetime written", () => {
    // Served wholly from the cache, the latest request wrote nothing but restarted the hour.
    const refreshed = latestIdleCompactionContext([
      report(100_000, 1, HOUR_MS),
      report(200_000, 2),
      report(320_000, 3),
    ]);
    assert.deepEqual(refreshed, {
      usedTokens: 320_000,
      promptCacheTtlMs: HOUR_MS,
      promptCacheExpiresAtMs: 3 + HOUR_MS,
    });
    assert.deepEqual(idleCompactionWindow(refreshed), {
      startMs: 3 + HOUR_MS - IDLE_COMPACTION_LEAD_MS,
      endMs: 3 + HOUR_MS,
    });
    // A five-minute cache stays left alone, and a request without its start dates nothing.
    assert.isNull(
      idleCompactionWindow(
        latestIdleCompactionContext([report(100_000, 1, 300_000), report(320_000, 3)]),
      ),
    );
    const { requestedAt: _requestedAt, ...undated } = report(320_000, 3).tokenUsage;
    assert.isNull(
      idleCompactionWindow(
        latestIdleCompactionContext([report(100_000, 1, HOUR_MS), { tokenUsage: undated }]),
      ),
    );
  });

  it("compacts only a live one-hour cache holding at least the instance's threshold", () => {
    const policy = { minTokens: 200_000 };
    const context = {
      usedTokens: 320_000,
      promptCacheTtlMs: HOUR_MS,
      promptCacheExpiresAtMs: HOUR_MS,
    };
    const skip = (input: Partial<Parameters<typeof idleCompactionContextSkip>[0]>) =>
      idleCompactionContextSkip({
        policy,
        context,
        mergeBackPending: false,
        nowMs: HOUR_MS - IDLE_COMPACTION_LEAD_MS,
        ...input,
      });
    assert.isNull(skip({}));
    assert.equal(skip({ policy: null }), "provider_off");
    assert.equal(skip({ context: null }), "no_context");
    assert.equal(skip({ context: { ...context, promptCacheTtlMs: 300_000 } }), "short_cache");
    assert.equal(skip({ context: { ...context, promptCacheExpiresAtMs: null } }), "short_cache");
    assert.equal(skip({ nowMs: HOUR_MS }), "late");
    assert.equal(skip({ mergeBackPending: true }), "merge_back");
    assert.equal(skip({ context: { ...context, usedTokens: 150_000 } }), "small");
  });
});

const makeHarness = Effect.gen(function* () {
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const shell = yield* Ref.make<OrchestrationV2ThreadShell | null>(null);
  const lastVisitedAt = yield* Ref.make<DateTime.Utc | null>(null);
  // The run's last request went out five minutes before it completed at 0.
  const requestedAtMs = yield* Ref.make(-5 * 60_000);
  const contextTransfers = yield* Ref.make<ReadonlyArray<OrchestrationV2ContextTransfer>>([]);
  const settings = yield* Ref.make({
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {
      [modelSelection.instanceId]: {
        driver: ProviderDriverKind.make("claudeAgent"),
        enabled: true,
      },
    },
  });
  const layer = Layer.mergeAll(
    Layer.mock(ServerSettings.ServerSettingsService)({ getSettings: Ref.get(settings) }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: () => Ref.get(shell),
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
          return {} as Effect.Success<
            ReturnType<ThreadManagement.ThreadManagementServiceShape["dispatch"]>
          >;
        }),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getShellSnapshot: () =>
        Effect.succeed({
          schemaVersion: 1,
          snapshotSequence: 0,
          threads: [],
          archivedThreads: [],
        } as unknown as Effect.Success<
          ReturnType<ProjectionStore.ProjectionStoreV2Shape["getShellSnapshot"]>
        >),
      getThreadRecords: (_threadId, fields) =>
        Effect.gen(function* () {
          return {
            thread: { lastVisitedAt: yield* Ref.get(lastVisitedAt) },
            providerTurns: fields.includes("providerTurns" as never)
              ? [report(320_000, yield* Ref.get(requestedAtMs), HOUR_MS)]
              : [],
            contextTransfers: yield* Ref.get(contextTransfers),
            runs: [run()],
          } as never;
        }),
    }),
    Layer.succeed(
      ProviderInstanceRegistry,
      ProviderInstanceRegistry.of({
        getInstance: () =>
          Effect.succeed({
            idleCompaction: Effect.succeed({ minTokens: 200_000 }),
          } as unknown as ProviderInstance),
      } as unknown as ProviderInstanceRegistry["Service"]),
    ),
  );
  const worker = yield* makeIdleCompactionWorker.pipe(Effect.provide(layer));
  return { worker, dispatched, shell, lastVisitedAt, contextTransfers, settings };
});

/** Due two minutes before the cache of the run's last request, sent at -5 minutes, expires. */
const DUE_MS = -5 * 60_000 + HOUR_MS - IDLE_COMPACTION_LEAD_MS;

const setIdleShell = (harness: Effect.Success<typeof makeHarness>) =>
  Ref.set(harness.shell, {
    ...idleThread,
    id: threadId,
    providerInstanceId: modelSelection.instanceId,
  } as unknown as OrchestrationV2ThreadShell);

const runEvent = (
  type: "run.created" | "run.updated",
  payload: OrchestrationV2Run,
): OrchestrationV2DomainEvent =>
  ({ type, threadId: payload.threadId, payload }) as unknown as OrchestrationV2DomainEvent;

describe("IdleCompactionWorker", () => {
  it.effect("honors the current global mode when an idle compaction becomes due", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* setIdleShell(harness);
      yield* harness.worker.onEvent(runEvent("run.updated", run()));
      yield* Ref.update(harness.settings, (settings) => ({
        ...settings,
        idleCompaction: "off" as const,
      }));
      yield* TestClock.adjust(DUE_MS);
      yield* harness.worker.runDueWork;
      assert.lengthOf(harness.dispatched, 0);
    }),
  );

  it.effect("compacts a thread two minutes before its cache expires and keeps it seen", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* setIdleShell(harness);
      yield* harness.worker.onEvent(runEvent("run.updated", run()));

      yield* TestClock.adjust(DUE_MS - 60_000);
      yield* harness.worker.runDueWork;
      assert.lengthOf(harness.dispatched, 0);

      yield* TestClock.adjust(60_000);
      yield* harness.worker.runDueWork;
      const compact = harness.dispatched[0];
      assert.equal(compact?.type, "message.dispatch");
      if (compact?.type !== "message.dispatch") return;
      assert.equal(compact.text, "/compact");
      assert.equal(compact.idleCompactionOfRunId, runId);
      assert.equal(compact.createdBy, "system");
      assert.deepEqual(compact.dispatchMode, { type: "start_immediately" });

      // Once due, a thread is not compacted twice for the same turn.
      yield* harness.worker.runDueWork;
      assert.lengthOf(harness.dispatched, 1);

      // The user had seen the thread before it went idle, so the compaction stays seen.
      yield* Ref.set(harness.lastVisitedAt, DateTime.makeUnsafe(1));
      const compactedAt = DateTime.makeUnsafe(DUE_MS + 90_000);
      yield* harness.worker.onEvent(
        runEvent(
          "run.updated",
          run({
            id: RunId.make("run-compact"),
            idleCompactionOfRunId: runId,
            completedAt: compactedAt,
          }),
        ),
      );
      const visit = harness.dispatched[1];
      assert.equal(visit?.type, "thread.visit");
      if (visit?.type !== "thread.visit") return;
      assert.equal(visit.visitedAt, DateTime.formatIso(compactedAt));
    }),
  );

  it.effect("drops a thread that started another run before it was due", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* harness.worker.onEvent(runEvent("run.updated", run()));
      yield* harness.worker.onEvent(runEvent("run.created", run({ id: RunId.make("run-2") })));
      yield* TestClock.adjust(DUE_MS);
      yield* harness.worker.runDueWork;
      assert.lengthOf(harness.dispatched, 0);
    }),
  );

  it.effect("leaves a thread with a pending merge-back to the user's next message", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* setIdleShell(harness);
      yield* Ref.set(harness.contextTransfers, [pendingMergeBack]);
      yield* harness.worker.onEvent(runEvent("run.updated", run()));
      yield* TestClock.adjust(DUE_MS);
      yield* harness.worker.runDueWork;
      assert.lengthOf(harness.dispatched, 0);

      // The orchestrator's own check before the /compact starts holds it back as well.
      const mayStart = (contextTransfers: ReadonlyArray<OrchestrationV2ContextTransfer>) =>
        idleCompactionMayStart({
          projection: {
            thread: { id: threadId, archivedAt: null, deletedAt: null, settledAt: null },
            runs: [run()],
            runtimeRequests: [],
            contextTransfers,
          } as unknown as Pick<
            OrchestrationV2ThreadProjection,
            "thread" | "runs" | "runtimeRequests" | "contextTransfers"
          >,
          command: {
            createdBy: "system",
            creationSource: "server",
            text: "/compact",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
          },
          runId,
          nowMs: DUE_MS,
        });
      assert.isTrue(mayStart([]));
      assert.isFalse(mayStart([pendingMergeBack]));
      assert.isTrue(mayStart([{ ...pendingMergeBack, status: "consumed" }]));
    }),
  );

  it.effect("leaves an unseen thread unseen after its compaction", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      // Visited before the turn it went idle after ended.
      yield* Ref.set(harness.lastVisitedAt, DateTime.makeUnsafe(-1));
      yield* harness.worker.onEvent(
        runEvent(
          "run.updated",
          run({
            id: RunId.make("run-compact"),
            idleCompactionOfRunId: runId,
            completedAt: DateTime.makeUnsafe(DUE_MS),
          }),
        ),
      );
      assert.lengthOf(harness.dispatched, 0);
    }),
  );
});
