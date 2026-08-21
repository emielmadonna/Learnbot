export type AppAccessMode =
  | "platform_control_plane"
  | "tenant_workspace"
  | "onboarding";

export function resolveAppAccessMode(input: {
  platformAuthorized: boolean;
  selectedTenant: boolean;
}): AppAccessMode {
  if (input.platformAuthorized && !input.selectedTenant) {
    return "platform_control_plane";
  }
  if (input.selectedTenant) return "tenant_workspace";
  return "onboarding";
}
