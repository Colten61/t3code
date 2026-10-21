import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { RuntimeMode } from "./providerPolicy.ts";

const PROVIDER_SLUG_MAX_CHARS = 64;
const PROVIDER_SLUG_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const ENVIRONMENT_VARIABLE_NAME_MAX_CHARS = 128;
const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const slugSchema = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROVIDER_SLUG_MAX_CHARS),
  Schema.isPattern(PROVIDER_SLUG_PATTERN),
);

export const ProviderDriverKind = slugSchema.pipe(Schema.brand("ProviderDriverKind"));
export type ProviderDriverKind = typeof ProviderDriverKind.Type;

const isProviderDriverKindValue = Schema.is(ProviderDriverKind);
export const isProviderDriverKind = (value: unknown): value is ProviderDriverKind =>
  isProviderDriverKindValue(value);

export const ProviderInstanceId = slugSchema.pipe(Schema.brand("ProviderInstanceId"));
export type ProviderInstanceId = typeof ProviderInstanceId.Type;

export const ProviderInstanceRef = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
});
export type ProviderInstanceRef = typeof ProviderInstanceRef.Type;

export const ProviderInstanceEnvironmentVariableName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(ENVIRONMENT_VARIABLE_NAME_MAX_CHARS),
  Schema.isPattern(ENVIRONMENT_VARIABLE_NAME_PATTERN),
);
export type ProviderInstanceEnvironmentVariableName =
  typeof ProviderInstanceEnvironmentVariableName.Type;

export const ProviderInstanceEnvironmentVariable = Schema.Struct({
  name: ProviderInstanceEnvironmentVariableName,
  value: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  sensitive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  valueRedacted: Schema.optionalKey(Schema.Boolean),
});
export type ProviderInstanceEnvironmentVariable = typeof ProviderInstanceEnvironmentVariable.Type;

export const ProviderInstanceEnvironment = Schema.Array(ProviderInstanceEnvironmentVariable);
export type ProviderInstanceEnvironment = typeof ProviderInstanceEnvironment.Type;

/**
 * T3 MCP capabilities a provider instance's hard cap can withhold. Mirrors the
 * server's `McpCapability`; the server checks the two stay in step.
 */
export const ProviderInstanceCappedCapability = Schema.Literals([
  "orchestration",
  "pull-requests",
  "worktree",
  "preview",
  "device",
]);
export type ProviderInstanceCappedCapability = typeof ProviderInstanceCappedCapability.Type;

/**
 * The most any thread on this instance may be granted, whoever starts it and
 * whatever its parent's own mode. Every field is optional and an absent cap
 * changes nothing.
 *
 *   - `maxRuntimeMode`: threads on the instance run at most this mode; a
 *     delegation that asks for more is refused, one that inherits more is
 *     lowered.
 *   - `declineFileChanges`: file-change approvals are declined without asking
 *     the user. Only Supervised asks before edits, so it also caps the mode
 *     at `approval-required`.
 *   - `withheldCapabilities`: T3 MCP capabilities the instance's sessions
 *     never get (e.g. `orchestration`: no `delegate_task` or thread control).
 */
export const ProviderInstanceHardCap = Schema.Struct({
  maxRuntimeMode: Schema.optionalKey(RuntimeMode),
  declineFileChanges: Schema.optionalKey(Schema.Boolean),
  withheldCapabilities: Schema.optionalKey(Schema.Array(ProviderInstanceCappedCapability)),
});
export type ProviderInstanceHardCap = typeof ProviderInstanceHardCap.Type;

/**
 * The driver-specific config payload is left as `Schema.Unknown`; each driver
 * registers its own decoder with the runtime registry, and envelopes for
 * unknown drivers are preserved verbatim so they round-trip across version
 * changes without data loss.
 */
export const ProviderInstanceConfig = Schema.Struct({
  driver: ProviderDriverKind,
  displayName: Schema.optional(TrimmedNonEmptyString),
  accentColor: Schema.optional(TrimmedNonEmptyString),
  environment: Schema.optionalKey(ProviderInstanceEnvironment),
  enabled: Schema.optionalKey(Schema.Boolean),
  config: Schema.optionalKey(Schema.Unknown),
  hardCap: Schema.optionalKey(ProviderInstanceHardCap),
});
export type ProviderInstanceConfig = typeof ProviderInstanceConfig.Type;

export const ProviderInstanceMutation = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("create"),
    instanceId: ProviderInstanceId,
    instance: ProviderInstanceConfig,
  }),
  Schema.Struct({
    operation: Schema.Literal("upsert"),
    instanceId: ProviderInstanceId,
    instance: ProviderInstanceConfig,
  }),
  Schema.Struct({
    operation: Schema.Literal("remove"),
    instanceId: ProviderInstanceId,
  }),
]);
export type ProviderInstanceMutation = typeof ProviderInstanceMutation.Type;

export const ProviderInstanceConfigMap = Schema.Record(ProviderInstanceId, ProviderInstanceConfig);
export type ProviderInstanceConfigMap = typeof ProviderInstanceConfigMap.Type;

/**
 * The legacy single-instance-per-driver world used the driver kind itself as
 * the instance id; preserving that mapping keeps existing persisted threads,
 * bindings, and cache files routable across the migration without rewriting
 * their stored selection payloads.
 */
export const defaultInstanceIdForDriver = (driver: ProviderDriverKind): ProviderInstanceId =>
  ProviderInstanceId.make(driver);
