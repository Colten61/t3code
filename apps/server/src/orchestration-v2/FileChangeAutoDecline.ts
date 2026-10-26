import { CommandId, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import {
  providerInstanceHardCapInForce,
  shouldAutoDeclineRuntimeRequest,
} from "../provider/ProviderInstanceHardCap.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

// Use the normal Decline command with a request-derived id so replay cannot answer twice.
// This worker answers requests; refusesFileChangeResponse enforces the cap against racing or stale Accepts.
export const declineCommandFor = (
  event: Extract<OrchestrationV2DomainEvent, { readonly type: "runtime-request.updated" }>,
) =>
  ({
    type: "runtime-request.respond",
    commandId: CommandId.make(`hard-cap-decline:${event.payload.id}`),
    threadId: event.threadId,
    requestId: event.payload.id,
    decision: "decline",
  }) as const;

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  const declineIfCapped = (event: OrchestrationV2DomainEvent) =>
    event.type !== "runtime-request.updated" ||
    event.payload.status !== "pending" ||
    event.payload.kind !== "file-change"
      ? Effect.void
      : Effect.gen(function* () {
          const instanceId =
            event.providerInstanceId ??
            (yield* threads.getThreadShell(event.threadId))?.modelSelection.instanceId;
          if (instanceId === undefined) return;
          const cap = yield* providerInstanceHardCapInForce(serverSettings, instanceId);
          if (!shouldAutoDeclineRuntimeRequest(cap, event.payload)) return;
          yield* threads.dispatch(declineCommandFor(event));
          yield* Effect.logInfo("orchestration-v2.hard-cap.file-change-declined", {
            threadId: event.threadId,
            requestId: event.payload.id,
            instanceId,
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.hard-cap.file-change-decline-failed", {
              threadId: event.threadId,
              requestId: event.payload.id,
              cause,
            }),
          ),
        );

  return { declineIfCapped };
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const { declineIfCapped } = yield* make;
    yield* forkParked(Stream.runForEach(threads.streamDomainEvents, declineIfCapped));
  }),
);
