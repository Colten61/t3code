import {
  type OrchestrationV2RuntimeRequest,
  type ProviderApprovalDecision,
  type ProviderInstanceCappedCapability,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ProviderInstanceHardCap,
  type ProviderInstanceId,
  type RuntimeMode,
  type ServerSettings,
  type ServerSettingsError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { McpCapability } from "../mcp/McpInvocationContext.ts";
import type { ServerSettingsService } from "../serverSettings.ts";

// Instance caps bound every thread, regardless of its parent's access or who starts it.
// Without this bound a full-access parent could delegate full access to a weaker agent.

const RUNTIME_MODE_RANK: Record<RuntimeMode, number> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};

export function readProviderInstanceHardCap(
  providerInstances: ProviderInstanceConfigMap,
  instanceId: ProviderInstanceId,
): ProviderInstanceHardCap | undefined {
  return providerInstances[instanceId]?.hardCap;
}

/**
 * The broadest runtime mode the cap allows. Declining file changes needs the
 * provider to ask before edits, which only Supervised does, so it caps the
 * mode at `approval-required` as well.
 */
export function hardCapRuntimeModeCeiling(
  cap: ProviderInstanceHardCap | undefined,
): RuntimeMode | undefined {
  if (cap === undefined) return undefined;
  if (cap.declineFileChanges === true) return "approval-required";
  return cap.maxRuntimeMode;
}

export function clampRuntimeModeToHardCap(
  runtimeMode: RuntimeMode,
  cap: ProviderInstanceHardCap | undefined,
): RuntimeMode {
  const ceiling = hardCapRuntimeModeCeiling(cap);
  return ceiling !== undefined && RUNTIME_MODE_RANK[runtimeMode] > RUNTIME_MODE_RANK[ceiling]
    ? ceiling
    : runtimeMode;
}

export type HardCappedChildRuntimeMode =
  | { readonly _tag: "allowed"; readonly runtimeMode: RuntimeMode }
  | { readonly _tag: "refused"; readonly runtimeMode: RuntimeMode; readonly ceiling: RuntimeMode };

/**
 * The mode a thread an agent starts on a capped instance gets. `resolved` is
 * the mode after the parent's own ceiling. An inherited mode above the cap is
 * lowered to it; a mode the caller asked for by name is refused, as one above
 * the parent's mode is, so the caller learns the child will not run as asked.
 */
export function resolveHardCappedChildRuntimeMode(input: {
  readonly resolved: RuntimeMode;
  readonly explicit: boolean;
  readonly cap: ProviderInstanceHardCap | undefined;
}): HardCappedChildRuntimeMode {
  const ceiling = hardCapRuntimeModeCeiling(input.cap);
  if (ceiling === undefined || RUNTIME_MODE_RANK[input.resolved] <= RUNTIME_MODE_RANK[ceiling]) {
    return { _tag: "allowed", runtimeMode: input.resolved };
  }
  return input.explicit
    ? { _tag: "refused", runtimeMode: input.resolved, ceiling }
    : { _tag: "allowed", runtimeMode: ceiling };
}

// Typed as the server's capabilities, so a contract value the server does not
// know fails to compile here.
export function hardCapWithheldCapabilities(
  cap: ProviderInstanceHardCap | undefined,
): ReadonlyArray<McpCapability> {
  const withheld: ReadonlyArray<ProviderInstanceCappedCapability> = cap?.withheldCapabilities ?? [];
  return withheld;
}

/** Whether T3 declines this runtime request for the user, without asking. */
export function shouldAutoDeclineRuntimeRequest(
  cap: ProviderInstanceHardCap | undefined,
  request: Pick<OrchestrationV2RuntimeRequest, "kind" | "status" | "responseCapability">,
): boolean {
  return (
    cap?.declineFileChanges === true &&
    request.kind === "file-change" &&
    request.status === "pending" &&
    request.responseCapability.type !== "not_resumable"
  );
}

/**
 * Whether a response to a runtime request would let a file change through on
 * an instance that declines them. Only a decline or a cancel answers one.
 */
export function refusesFileChangeResponse(
  cap: ProviderInstanceHardCap | undefined,
  request: Pick<OrchestrationV2RuntimeRequest, "kind">,
  decision: ProviderApprovalDecision | undefined,
): boolean {
  return (
    cap?.declineFileChanges === true &&
    request.kind === "file-change" &&
    decision !== "decline" &&
    decision !== "cancel"
  );
}

const CAPPED_CAPABILITIES: Record<ProviderInstanceCappedCapability, true> = {
  orchestration: true,
  "pull-requests": true,
  worktree: true,
  preview: true,
  device: true,
};

/**
 * The cap an instance runs under when its own cannot be known (settings and
 * the remembered caps both unreadable): the most a cap can take away.
 */
export const UNKNOWN_HARD_CAP: ProviderInstanceHardCap = {
  maxRuntimeMode: "approval-required",
  declineFileChanges: true,
  withheldCapabilities: Object.keys(CAPPED_CAPABILITIES) as Array<ProviderInstanceCappedCapability>,
};

// Valid settings cap only listed instances. Remembered settings retain known uncapped instances as {},
// while unknown instances receive the strictest cap when settings cannot be read.
export interface ProviderInstanceHardCaps {
  readonly byInstance: Readonly<Record<string, ProviderInstanceHardCap>>;
  /** The cap of an instance `byInstance` does not name. */
  readonly otherwise: ProviderInstanceHardCap | undefined;
}

export function hardCapFor(
  caps: ProviderInstanceHardCaps,
  instanceId: ProviderInstanceId,
): ProviderInstanceHardCap | undefined {
  return Object.hasOwn(caps.byInstance, instanceId) ? caps.byInstance[instanceId] : caps.otherwise;
}

/** The caps valid settings set. */
export function providerInstanceHardCaps(
  providerInstances: ProviderInstanceConfigMap,
): ProviderInstanceHardCaps {
  const byInstance: Record<string, ProviderInstanceHardCap> = {};
  for (const [instanceId, instance] of Object.entries(providerInstances)) {
    if (instance.hardCap !== undefined) byInstance[instanceId] = instance.hardCap;
  }
  return { byInstance, otherwise: undefined };
}

/**
 * The hard caps in force. Settings that fail to decode or cannot be read fall
 * back to the caps that last loaded from valid ones
 * (`ServerSettingsService.getHardCaps`); this fails when neither is known.
 */
export const readProviderInstanceHardCaps = (
  serverSettings: ServerSettingsService["Service"],
): Effect.Effect<ProviderInstanceHardCaps, ServerSettingsError> =>
  // An own property, not `?.`: a `Layer.mock` stub answers every property
  // with a dying effect, so only a service that defines it supplies it.
  Object.hasOwn(serverSettings, "getHardCaps") && serverSettings.getHardCaps !== undefined
    ? serverSettings.getHardCaps
    : serverSettings.getSettings.pipe(
        Effect.map((settings) => providerInstanceHardCaps(settings.providerInstances)),
      );

/**
 * One instance's hard cap in force, {@link UNKNOWN_HARD_CAP} when the caps
 * cannot be known: a cap that cannot be read fails closed, never open.
 */
export const providerInstanceHardCapInForce = (
  serverSettings: ServerSettingsService["Service"],
  instanceId: ProviderInstanceId,
): Effect.Effect<ProviderInstanceHardCap | undefined> =>
  readProviderInstanceHardCaps(serverSettings).pipe(
    Effect.map((caps) => hardCapFor(caps, instanceId)),
    Effect.catch((cause) =>
      Effect.logWarning("Could not read the provider instances' hard caps; failing closed.", {
        instanceId,
        cause,
      }).pipe(Effect.as(UNKNOWN_HARD_CAP)),
    ),
  );

// Persist caps before saves and after valid loads so broken settings cannot remove restrictions.
// Record every known instance and driver, including built-in defaults: known uncapped instances stay
// uncapped; unknown instances receive the strictest cap.
export const RememberedHardCaps = Schema.Struct({
  instances: Schema.Record(
    Schema.String,
    Schema.Struct({
      driver: ProviderDriverKind,
      hardCap: Schema.optionalKey(ProviderInstanceHardCap),
    }),
  ),
});
export type RememberedHardCaps = typeof RememberedHardCaps.Type;

/**
 * The built-in drivers whose default instance (id = driver) the registry builds
 * when no entry names it (`deriveProviderInstanceConfigMap`). Listed here
 * because the registry's driver list would pull every provider into the
 * settings module; a test keeps the two in step.
 */
export const DEFAULT_INSTANCE_DRIVERS: ReadonlyArray<ProviderDriverKind> = [
  "codex",
  "claudeAgent",
  "cursor",
  "grok",
  "fx",
  "opencode",
  "antigravity",
  "pi",
  "muse",
].map((driver) => ProviderDriverKind.make(driver));

/**
 * Every instance the registry builds from these settings: each entry, and a
 * built-in driver's default instance when no entry names it.
 */
export function rememberedHardCapsOf(settings: ServerSettings): RememberedHardCaps {
  const instances: Record<string, RememberedHardCaps["instances"][string]> = {};
  for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
    instances[instanceId] =
      instance.hardCap === undefined
        ? { driver: instance.driver }
        : { driver: instance.driver, hardCap: instance.hardCap };
  }
  for (const driver of DEFAULT_INSTANCE_DRIVERS) {
    const instanceId = defaultInstanceIdForDriver(driver);
    if (!Object.hasOwn(instances, instanceId)) instances[instanceId] = { driver };
  }
  return { instances };
}

/** The caps in force from remembered ones: by id, the strictest for the rest. */
export function rememberedHardCapsInForce(
  remembered: RememberedHardCaps,
): ProviderInstanceHardCaps {
  const byInstance: Record<string, ProviderInstanceHardCap> = {};
  for (const [instanceId, entry] of Object.entries(remembered.instances)) {
    byInstance[instanceId] = entry.hardCap ?? {};
  }
  return { byInstance, otherwise: UNKNOWN_HARD_CAP };
}

// Restore remembered caps to listed and default built-in instances so Settings shows and preserves them.
// Do not recreate other instances; rememberedHardCapsInForce still enforces their caps by id.
export function withRememberedHardCaps(
  settings: ServerSettings,
  remembered: RememberedHardCaps,
): ServerSettings {
  const providerInstances: Record<string, ProviderInstanceConfig> = {
    ...settings.providerInstances,
  };
  for (const [instanceId, { driver, hardCap }] of Object.entries(remembered.instances)) {
    if (hardCap === undefined) continue;
    const existing = providerInstances[instanceId];
    if (existing !== undefined) {
      providerInstances[instanceId] = { ...existing, hardCap };
    } else if (
      instanceId === defaultInstanceIdForDriver(driver) &&
      DEFAULT_INSTANCE_DRIVERS.includes(driver)
    ) {
      providerInstances[instanceId] = { driver, hardCap };
    }
  }
  return {
    ...settings,
    providerInstances: providerInstances as ServerSettings["providerInstances"],
  };
}
