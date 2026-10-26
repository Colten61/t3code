import type { ProviderInteractionMode } from "@t3tools/contracts";

/** A project that starts in Plan overrides the carried mode; null keeps the draft default. */
export function resolveNewThreadInteractionMode(input: {
  startsInPlan: boolean;
  carried: ProviderInteractionMode | null;
}): ProviderInteractionMode | null {
  return input.startsInPlan ? "plan" : input.carried;
}

/** Plan controls stay available when the project starts in Plan, so the user can leave it. */
export function resolvePlanModeAvailable(input: {
  legacyPlanModeEnabled: boolean;
  projectStartsInPlan: boolean;
}): boolean {
  return input.legacyPlanModeEnabled || input.projectStartsInPlan;
}
