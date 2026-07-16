import type { PermissionSystemExtensionConfig } from "./extension-config";
import type { PermissionState } from "./types";

export interface AskPermissionResolutionOptions {
  config: PermissionSystemExtensionConfig;
  hasUI: boolean;
  isSubagent: boolean;
}

export interface YoloPermissionContext {
  surface?: string | null;
  toolName?: string | null;
  matchedPattern?: string | null;
}

export function isYoloModeEnabled(
  config: PermissionSystemExtensionConfig,
): boolean {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-conversion -- typed as boolean but may be undefined at runtime (untyped callers); Boolean() guards against that
  return Boolean(config.yoloMode);
}

export function shouldAutoApprovePermissionState(
  state: PermissionState,
  config: PermissionSystemExtensionConfig,
  context: YoloPermissionContext = {},
): boolean {
  return (
    state === "ask" &&
    isYoloModeEnabled(config) &&
    isYoloAutoApprovalEligible(context)
  );
}

export function isYoloAutoApprovalEligible(
  context: YoloPermissionContext,
): boolean {
  const surface = (context.surface ?? context.toolName)?.trim();
  return surface !== "bash" || !context.matchedPattern;
}

export function canResolveAskPermissionRequest(
  options: AskPermissionResolutionOptions,
): boolean {
  return (
    options.hasUI || options.isSubagent || isYoloModeEnabled(options.config)
  );
}
