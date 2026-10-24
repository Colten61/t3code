import type { RuntimeMode } from "@t3tools/contracts";
import { runtimeModePresentationForProvider } from "@t3tools/shared/providerPermissions";

export const RUNTIME_MODE_CHOICES: ReadonlyArray<{
  readonly mode: RuntimeMode;
  readonly label: string;
  readonly description: string;
}> = [
  {
    mode: "approval-required",
    label: "Supervised",
    description: "Ask before commands and file changes.",
  },
  {
    mode: "auto-accept-edits",
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
  },
  {
    mode: "auto",
    label: "Auto",
    description: "Supported providers approve routine actions; others still ask.",
  },
  {
    mode: "full-access",
    label: "Full access",
    description:
      "Request unrestricted access with approval prompts disabled. Command rules still apply.",
  },
];

export function runtimeModeChoicesForSupportedModes(
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
  providerDriver?: string,
) {
  const choices =
    supportedRuntimeModes && supportedRuntimeModes.length > 0
      ? RUNTIME_MODE_CHOICES.filter((choice) => supportedRuntimeModes.includes(choice.mode))
      : RUNTIME_MODE_CHOICES;
  return providerDriver === undefined
    ? choices
    : choices.map((choice) => ({
        ...choice,
        ...runtimeModePresentationForProvider(choice.mode, providerDriver),
      }));
}

export function compatibleRuntimeModeForChoices(
  runtimeMode: RuntimeMode,
  choices: ReadonlyArray<{ readonly mode: RuntimeMode }>,
): RuntimeMode {
  return choices.some((choice) => choice.mode === runtimeMode)
    ? runtimeMode
    : (choices[0]?.mode ?? runtimeMode);
}

export { selectableProviderOptionChoices as selectableChoices } from "@t3tools/client-runtime/model-traits";
