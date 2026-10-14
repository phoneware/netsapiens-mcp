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
 * Maps an exact NetSapiens user scope string to our internal UserRole tier.
 *
 * Exact NetSapiens user-scope mapping:
 * - Super User -> system_admin
 * - Reseller -> reseller
 * - Office Manager, Site Manager, Domain Admin, Call Center Supervisor -> domain_admin
 * - Call Center Agent, Advanced User, Basic User, Simple User -> user
 * - No Portal or anything unrecognized -> user
 */
export function nsScopeToTier(nsScope: string | undefined | null): UserRole {
 if (!nsScope) return 'user';

 const clean = nsScope.toLowerCase().trim();

 if (clean === 'super user' || clean === 'superuser' || clean === 'system admin' || clean === 'system_admin') {
  return 'system_admin';
 }
 if (clean === 'reseller') {
  return 'reseller';
 }
 if (
  clean === 'office manager' ||
  clean === 'site manager' ||
  clean === 'domain admin' ||
  clean === 'domain_admin' ||
  clean === 'call center supervisor'
 ) {
  return 'domain_admin';
 }
 if (
  clean === 'call center agent' ||
  clean === 'advanced user' ||
  clean === 'basic user' ||
  clean === 'simple user' ||
  clean === 'user'
 ) {
  return 'user';
 }
 return 'user';
}
