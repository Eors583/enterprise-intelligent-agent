/**
 * Role Agents are distinguished from legacy personal Agents by the immutable
 * assignment identity captured when their instance is created. Legacy Agents
 * keep their historical owner/tenant visibility rules; Role Agents must prove
 * a currently effective assignment at every access and execution boundary.
 */
export function roleAgentAssignmentId(settings: unknown): string | null {
  if (
    typeof settings !== 'object' ||
    settings === null ||
    Array.isArray(settings) ||
    !('roleAssignmentId' in settings)
  ) {
    return null;
  }
  const value = settings.roleAssignmentId;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/**
 * A malformed assignment marker must still classify the instance as a Role
 * Agent. Otherwise corrupting the marker could silently restore the legacy
 * owner visibility path.
 */
export function hasRoleAgentAssignmentMarker(settings: unknown): boolean {
  return (
    typeof settings === 'object' &&
    settings !== null &&
    !Array.isArray(settings) &&
    'roleAssignmentId' in settings
  );
}
