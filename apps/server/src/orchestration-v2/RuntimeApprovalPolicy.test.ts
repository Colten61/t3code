import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderTurnId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2RuntimeRequest,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Registry from "./ProviderAdapterRegistry.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Replay from "./testkit/ProviderReplayHarness.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as Policy from "./RuntimeApprovalPolicy.ts";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-6.1-sol" };
const adapter = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for approval decisions"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const database = Sqlite.layerMemory;
const settings = ServerSettings.layerTest().pipe(Layer.orDie);
const layerTest = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provide(database)),
  settings,
  Replay.layerWithRegistry({ name: "live-approval" }, Registry.layerSingle(adapter), {
    databaseLayer: database,
    runEffectWorker: false,
    serverSettingsLayer: settings,
  }),
);

const fixture = Effect.fn("TestLiveApproval.fixture")(function* (suffix: string) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sink = yield* EventSink.EventSinkV2;
  const policy = yield* Policy.RuntimeApprovalPolicy.pipe(
    Effect.provide(
      Policy.layer.pipe(
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadRecords: (threadId, fields, filter) =>
              projections.getThreadRecords(threadId, fields, filter).pipe(Effect.orDie),
            dispatch: (command) => orchestrator.dispatch(command),
          }),
        ),
      ),
    ),
  );
  const threadId = ThreadId.make(`live-approval:${suffix}`);
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${suffix}`),
    threadId,
    projectId: ProjectId.make("live-approval-project"),
    title: "Supervised child",
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "agent",
    creationSource: "mcp",
  });
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`start:${suffix}`),
    threadId,
    messageId: MessageId.make(`task:${suffix}`),
    text: "Review changes",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "agent",
    creationSource: "mcp",
  });
  const initial = yield* orchestrator.getThreadProjection(threadId);
  const run = initial.runs[0]!;
  const providerThread = initial.providerThreads.find(
    (thread) => thread.id === run.providerThreadId,
  )!;
  const now = yield* DateTime.now;
  yield* sink.write({
    events: [
      {
        id: EventId.make(`session:${suffix}`),
        type: "provider-session.attached",
        threadId,
        occurredAt: now,
        payload: {
          id: providerThread.providerSessionId!,
          driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: "/repo",
          model: modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
      },
      {
        id: EventId.make(`running:${suffix}`),
        type: "run.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: { ...run, status: "running", startedAt: now },
      },
    ],
  });
  let sequence = 0;
  const select = Effect.fn("TestLiveApproval.select")(function* (
    mode: "full-access" | "auto-accept-edits" | "approval-required" | "auto",
    live = true,
  ) {
    const result = yield* orchestrator.dispatch({
      type: "thread.runtime-mode.set",
      commandId: CommandId.make(`mode:${suffix}:${++sequence}`),
      threadId,
      runtimeMode: mode,
      ...(live ? { applyImmediately: true } : {}),
    });
    const event = result.storedEvents.find(
      ({ event }) => event.type === "thread.runtime-mode-updated",
    )!.event;
    yield* policy.handle(event);
    return event;
  });
  const addRequest = Effect.fn("TestLiveApproval.addRequest")(function* (
    kind: Exclude<OrchestrationV2RuntimeRequest["kind"], "auth_refresh" | "dynamic_tool_call">,
    foreignRoot = false,
  ) {
    const id = `${suffix}:${++sequence}`;
    const requestId = RuntimeRequestId.make(`request:${id}`);
    const nodeId = NodeId.make(`approval:${id}`);
    const itemId = TurnItemId.make(`approval:${id}`);
    const request = {
      id: requestId,
      nodeId,
      providerTurnId: ProviderTurnId.make(`turn:${suffix}`),
      nativeRequestRef: null,
      kind,
      status: "pending" as const,
      responseCapability: {
        type: "live" as const,
        providerSessionId: providerThread.providerSessionId!,
      },
      createdAt: now,
      resolvedAt: null,
    };
    const event = {
      id: EventId.make(`request:${id}`),
      type: "runtime-request.updated" as const,
      threadId,
      providerInstanceId: instanceId,
      occurredAt: now,
      payload: request,
    };
    yield* sink.write({
      events: [
        {
          id: EventId.make(`node:${id}`),
          type: "node.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: nodeId,
            threadId,
            runId: run.id,
            parentNodeId: run.rootNodeId,
            rootNodeId: foreignRoot ? NodeId.make("different-root") : run.rootNodeId!,
            kind: "approval_request",
            status: "waiting",
            countsForRun: false,
            providerThreadId: providerThread.id,
            providerTurnId: request.providerTurnId,
            nativeItemRef: null,
            runtimeRequestId: requestId,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        },
        ...(kind === "user_input"
          ? []
          : [
              {
                id: EventId.make(`item:${id}`),
                type: "turn-item.updated" as const,
                threadId,
                occurredAt: now,
                payload: {
                  id: itemId,
                  threadId,
                  runId: run.id,
                  nodeId,
                  type: "approval_request" as const,
                  status: "waiting" as const,
                  requestId,
                  requestKind: kind,
                  providerThreadId: providerThread.id,
                  providerTurnId: request.providerTurnId,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 100 + sequence,
                  title: null,
                  startedAt: now,
                  completedAt: null,
                  updatedAt: now,
                },
              },
            ]),
        event,
      ],
    });
    yield* policy.handle(event);
    return { requestId, nodeId, itemId, read: projections.getRuntimeRequest(threadId, requestId) };
  });
  return { threadId, run, select, addRequest, orchestrator, projections, policy };
});

it.effect(
  "accepts pending and later commands without cancelling their cards or restarting work",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture("pending");
      const first = yield* f.addRequest("command");
      assert.equal((yield* first.read)?.status, "pending");
      yield* f.select("full-access");
      assert.equal((yield* first.read)?.decision, "accept");
      const second = yield* f.addRequest("command");
      assert.equal((yield* second.read)?.status, "resolved");
      const projection = yield* f.orchestrator.getThreadProjection(f.threadId);
      assert.equal(projection.nodes.find((node) => node.id === first.nodeId)?.status, "completed");
      assert.equal(
        projection.turnItems.find((item) => item.id === first.itemId)?.status,
        "completed",
      );
      assert.equal(projection.runs[0]?.activeAttemptId, f.run.activeAttemptId);
      assert.lengthOf(projection.messages, 1);
      assert.lengthOf(projection.attempts, 1);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("applies edits-only and supervised choices to requests already waiting", () =>
  Effect.gen(function* () {
    const f = yield* fixture("reverse");
    const command = yield* f.addRequest("command");
    const edit = yield* f.addRequest("file-change");
    yield* f.select("auto-accept-edits");
    assert.equal((yield* edit.read)?.status, "resolved");
    assert.equal((yield* command.read)?.status, "pending");
    const previous = yield* f.select("full-access");
    assert.equal((yield* command.read)?.status, "resolved");
    yield* f.select("approval-required");
    const later = yield* f.addRequest("command");
    yield* f.policy.handle(previous);
    assert.equal((yield* later.read)?.status, "pending");
    const stale = yield* f.orchestrator
      .dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make("stale-mode-grant"),
        threadId: f.threadId,
        requestId: later.requestId,
        decision: "accept",
        approvalOverrideId:
          previous.type === "thread.runtime-mode-updated"
            ? previous.payload.approvalOverride!.commandId
            : CommandId.make("invalid"),
      })
      .pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(stale));
    assert.equal((yield* later.read)?.status, "pending");
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "keeps future presets, siblings, unrelated roots, questions and native reviews separate",
  () =>
    Effect.gen(function* () {
      const first = yield* fixture("scope-a");
      const second = yield* fixture("scope-b");
      yield* first.select("full-access", false);
      const queued = yield* first.addRequest("command");
      assert.equal((yield* queued.read)?.status, "pending");
      yield* first.select("full-access");
      assert.equal((yield* queued.read)?.status, "resolved");
      for (const request of [
        yield* second.addRequest("command"),
        yield* first.addRequest("command", true),
        yield* first.addRequest("mcp-elicitation"),
        yield* first.addRequest("user_input"),
      ])
        assert.equal((yield* request.read)?.status, "pending");
      yield* first.select("auto");
      const nativeReview = yield* first.addRequest("command");
      assert.equal((yield* nativeReview.read)?.status, "pending");
    }).pipe(Effect.provide(layerTest)),
);

it.effect("honours instance ceilings and file-change denials when applying a live choice", () =>
  Effect.gen(function* () {
    const f = yield* fixture("cap");
    const service = yield* ServerSettings.ServerSettingsService;
    yield* service.updateSettings({
      providerInstances: {
        [instanceId]: { driver, hardCap: { maxRuntimeMode: "approval-required" } },
      },
    });
    yield* f.select("full-access");
    const command = yield* f.addRequest("command");
    assert.equal((yield* command.read)?.status, "pending");
    yield* service.updateSettings({
      providerInstances: {
        [instanceId]: {
          driver,
          hardCap: { maxRuntimeMode: "full-access", declineFileChanges: true },
        },
      },
    });
    yield* f.select("full-access");
    assert.equal((yield* command.read)?.status, "pending");
    const edit = yield* f.addRequest("file-change");
    assert.equal((yield* edit.read)?.status, "pending");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("does not automatically approve commands after Stop", () =>
  Effect.gen(function* () {
    const f = yield* fixture("stopped");
    yield* f.select("full-access");
    yield* f.orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-live-approvals"),
      threadId: f.threadId,
    });
    const later = yield* f.addRequest("command");
    assert.equal((yield* later.read)?.status, "pending");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("revokes an earlier live grant when a later send changes the saved mode", () =>
  Effect.gen(function* () {
    const f = yield* fixture("send-changes-mode");
    yield* f.select("full-access");
    yield* f.select("approval-required", false);
    const request = yield* f.addRequest("command");
    assert.equal((yield* request.read)?.status, "pending");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("applies the menu choice to the working turn when another message is queued", () =>
  Effect.gen(function* () {
    const f = yield* fixture("queued-message");
    const request = yield* f.addRequest("command");
    yield* f.orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("queue-followup"),
      threadId: f.threadId,
      messageId: MessageId.make("queued-followup"),
      text: "Continue with the next check.",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
    });
    const before = yield* f.orchestrator.getThreadProjection(f.threadId);
    assert.equal(before.runs.at(-1)?.status, "queued");
    yield* f.select("full-access");
    assert.equal((yield* request.read)?.decision, "accept");
    const after = yield* f.orchestrator.getThreadProjection(f.threadId);
    assert.equal(after.thread.approvalOverride?.rootNodeId, f.run.rootNodeId);
    assert.equal(after.runs.at(-1)?.status, "queued");
    assert.deepEqual(after.attempts, before.attempts);
  }).pipe(Effect.provide(layerTest)),
);
