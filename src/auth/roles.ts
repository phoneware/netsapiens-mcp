/**
 * Role-Based Access Control (RBAC) helpers for the NetSapiens MCP Server.
 *
 * NS itself enforces RBAC server-side based on the bearer token's scope.
 * The client-side tool-to-role map (`TOOL_ROLE_REQUIREMENTS`) was tied to
 * hand-written tool names that no longer exist after the OpenAPI-driven
 * regeneration, so it is kept as an empty placeholder for compatibility.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UserRole = 'system_admin' | 'reseller' | 'domain_admin' | 'user';

// ---------------------------------------------------------------------------
// Role hierarchy (higher number = more privilege)
// ---------------------------------------------------------------------------

export const ROLE_HIERARCHY: Record<UserRole, number> = {
  system_admin: 4,
  reseller: 3,
  domain_admin: 2,
  user: 1,
};

/**
 * @deprecated NS enforces tool-level authorization server-side via the bearer
 * token. This map is intentionally empty; kept exported for backwards
 * compatibility with anyone still importing the symbol.
 */
export const TOOL_ROLE_REQUIREMENTS: Record<string, UserRole> = {};

// ---------------------------------------------------------------------------
// Permission check
// ---------------------------------------------------------------------------

export function hasPermission(userRole: UserRole, requiredRole: UserRole): boolean {
  return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[requiredRole];
}

// ---------------------------------------------------------------------------
// Role detection from NS API response
// ---------------------------------------------------------------------------

/**
 * Maps a NetSapiens user scope string to our internal UserRole.
 * Falls back to 'user' for unrecognised values.
 */
export function mapNsScope(nsScope: string | undefined | null): UserRole {
  if (!nsScope) return 'user';

  const lower = nsScope.toLowerCase().trim();

  if (lower.includes('super') || lower.includes('system')) return 'system_admin';
  if (lower.includes('reseller')) return 'reseller';
  if (lower.includes('office') || lower.includes('admin') || lower.includes('manager') || lower.includes('site')) {
    return 'domain_admin';
  }
  return 'user';
}
