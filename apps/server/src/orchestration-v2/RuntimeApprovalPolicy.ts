import { CommandId, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import {
  clampRuntimeModeToHardCap,
  providerInstanceHardCapInForce,
} from "../provider/ProviderInstanceHardCap.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as ProviderSessions from "./ProviderSessionManager.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { permitsAutomaticApproval } from "./runtimeApprovalMode.ts";

export class RuntimeApprovalPolicy extends Context.Service<
  RuntimeApprovalPolicy,
  {
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/RuntimeApprovalPolicy") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const sessions = yield* ProviderSessions.ProviderSessionManagerV2;
  const settings = yield* ServerSettings.ServerSettingsService;

  const handle = Effect.fn("RuntimeApprovalPolicy.handle")(
    function* (event: OrchestrationV2DomainEvent) {
      if (
        event.type !== "thread.runtime-mode-updated" &&
        !(event.type === "runtime-request.updated" && event.payload.status === "pending") &&
        !(event.type === "provider-turn.updated" && event.payload.status === "running")
      )
        return;
      const projection = yield* threads.getThreadRecords(event.threadId, [
        "runs",
        "providerThreads",
        "runtimeRequests",
        "nodes",
      ]);
      const override = projection.thread.approvalOverride;
      if (override === undefined) return;
      const run = projection.runs.find((candidate) => candidate.rootNodeId === override.rootNodeId);
      if (run === undefined) return;
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === run.providerThreadId,
      );
      if (providerThread?.driver !== "codex" || providerThread.providerSessionId === null) return;
      const cap = yield* providerInstanceHardCapInForce(settings, override.providerInstanceId);
      const mode = clampRuntimeModeToHardCap(override.runtimeMode, cap);
      const session = yield* sessions.get(providerThread.providerSessionId);
      if (Option.isSome(session) && session.value.updateApprovalMode !== undefined) {
        yield* session.value
          .updateApprovalMode({
            providerThread,
            runId: run.id,
            runtimeMode: mode,
            changeId: override.commandId,
          })
          .pipe(
            Effect.timeout("3 seconds"),
            Effect.catchCause(() =>
              Effect.logWarning("orchestration-v2.live-approval-mode-update-failed", {
                threadId: event.threadId,
                providerInstanceId: override.providerInstanceId,
              }),
            ),
          );
      }
      if (run.status !== "starting" && run.status !== "running" && run.status !== "waiting") return;
      for (const request of projection.runtimeRequests) {
        if (
          request.status !== "pending" ||
          request.responseCapability.type !== "live" ||
          !permitsAutomaticApproval(mode, request.kind) ||
          (request.kind === "file-change" && cap?.declineFileChanges) ||
          !projection.nodes.some(
            (node) => node.id === request.nodeId && node.rootNodeId === override.rootNodeId,
          )
        )
          continue;
        yield* threads
          .dispatch({
            type: "runtime-request.respond",
            commandId: CommandId.make(`approval-mode:${override.commandId}:${request.id}`),
            threadId: event.threadId,
            requestId: request.id,
            decision: "accept",
            approvalOverrideId: override.commandId,
          })
          .pipe(Effect.catchCause(() => Effect.void));
      }
    },
    Effect.catchCause(() => Effect.logWarning("orchestration-v2.live-approval-policy-failed")),
  );
  return RuntimeApprovalPolicy.of({ handle });
});

export const layer = Layer.effect(RuntimeApprovalPolicy, make);

export const layerReactor = Layer.effectDiscard(
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const policy = yield* RuntimeApprovalPolicy;
    yield* forkParked(Stream.runForEach(threads.streamDomainEvents, policy.handle));
  }),
).pipe(Layer.provide(layer));
