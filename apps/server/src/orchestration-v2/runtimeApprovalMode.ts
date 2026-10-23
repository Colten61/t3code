import type { OrchestrationV2RuntimeRequest, RuntimeMode } from "@t3tools/contracts";

export function permitsAutomaticApproval(
  mode: RuntimeMode,
  kind: OrchestrationV2RuntimeRequest["kind"],
): boolean {
  if (mode === "auto-accept-edits") return kind === "file-change";
  return (
    mode === "full-access" &&
    (kind === "command" || kind === "file-change" || kind === "file-read" || kind === "permission")
  );
}
