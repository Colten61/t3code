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

export const isProviderDriverKind = Schema.is(ProviderDriverKind);

export const ProviderInstanceId = slugSchema.pipe(Schema.brand("ProviderInstanceId"));
export type ProviderInstanceId = typeof ProviderInstanceId.Type;

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
 * Caps apply regardless of who starts the thread or its parent's permissions.
 * Explicitly requesting a higher mode fails; an inherited mode is lowered.
 * Declining file changes also requires approval-required mode.
 * Withheld capabilities never reach this instance's MCP sessions.
 */
export const ProviderInstanceHardCap = Schema.Struct({
  maxRuntimeMode: Schema.optionalKey(RuntimeMode),
  declineFileChanges: Schema.optionalKey(Schema.Boolean),
  withheldCapabilities: Schema.optionalKey(Schema.Array(ProviderInstanceCappedCapability)),
});
export type ProviderInstanceHardCap = typeof ProviderInstanceHardCap.Type;

/** Drivers decode their own config; unknown-driver envelopes round-trip verbatim across versions. */
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

/** Driver-kind ids keep stored selections routable without migration. */
export const defaultInstanceIdForDriver = (driver: ProviderDriverKind): ProviderInstanceId =>
  ProviderInstanceId.make(driver);
