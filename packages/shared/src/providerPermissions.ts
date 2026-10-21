import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2ProviderThread,
  ProviderInstanceId,
  ProviderReportedPermissions,
  RuntimeMode,
} from "@t3tools/contracts";

const codexRuntimeModePresentation = {
  "approval-required": {
    label: "Read only",
    description: "Read-only sandbox. Ask before running untrusted commands.",
  },
  "auto-accept-edits": {
    label: "Workspace access",
    description: "Edit workspace files. Ask before going outside the sandbox.",
  },
  auto: {
    label: "Auto review",
    description: "Edit workspace files. Let Codex review permission requests.",
  },
  "full-access": {
    label: "Full access",
    description: "Access files and network without approval prompts.",
  },
} satisfies Record<RuntimeMode, { readonly label: string; readonly description: string }>;

/** Codex's sandbox and reviewer choices, named for what its adapter requests. */
export function runtimeModePresentationForProvider(mode: RuntimeMode, providerDriver: string) {
  return providerDriver === "codex" ? codexRuntimeModePresentation[mode] : null;
}

/** A saved report belongs to the active native thread and the selected instance. */
export function threadReportedPermissions(
  projection:
    | {
        readonly thread: Pick<
          OrchestrationV2ThreadProjection["thread"],
          "id" | "activeProviderThreadId"
        >;
        readonly providerThreads: ReadonlyArray<
          Pick<
            OrchestrationV2ProviderThread,
            "id" | "driver" | "providerInstanceId" | "appThreadId" | "nativeMetadata"
          >
        >;
      }
    | null
    | undefined,
  instanceId: ProviderInstanceId | null | undefined,
): ProviderReportedPermissions | null {
  if (projection == null || instanceId == null) return null;
  const providerThread = projection.providerThreads.find(
    (thread) =>
      thread.id === projection.thread.activeProviderThreadId &&
      thread.providerInstanceId === instanceId &&
      thread.appThreadId === projection.thread.id,
  );
  const permissions = providerThread?.nativeMetadata?.permissions;
  return permissions?.source === providerThread?.driver ? (permissions ?? null) : null;
}

/** Describe core settings without implying that native command rules are bypassed. */
export function describeReportedPermissions(permissions: ProviderReportedPermissions | null) {
  if (permissions === null) {
    return {
      label: "Permissions not reported",
      detail: "The provider has not reported its permissions. The selected mode is a request.",
      approvalNotice: null,
    };
  }
  const sandbox = {
    "danger-full-access": "Full access",
    "workspace-write": "Workspace access",
    "read-only": "Read only",
    "external-sandbox": "External sandbox",
  }[permissions.sandbox];
  const policy = permissions.approvalPolicy;
  const promptsOff = policy === "never";
  const rulesOff = typeof policy === "object" && !policy.granular.rules;
  const approvals = promptsOff
    ? "prompts off"
    : permissions.approvalsReviewer !== "user"
      ? "automatic review"
      : typeof policy === "object"
        ? "granular approvals"
        : policy === "untrusted"
          ? "untrusted commands ask"
          : policy === "on-failure"
            ? "ask on failure"
            : "ask on request";
  const label =
    permissions.sandbox === "danger-full-access" && promptsOff
      ? sandbox
      : `${sandbox} · ${approvals}`;
  return {
    label,
    detail: `Last reported by Codex: ${label}.`,
    approvalNotice: rulesOff
      ? "Commands that require approval under a rule are blocked because rule approvals are disabled."
      : null,
  };
}
