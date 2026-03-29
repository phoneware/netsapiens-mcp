/**
 * Role-Based Access Control (RBAC) for the NetSapiens MCP Server.
 *
 * Maps tool names to the minimum role required to use them, and provides
 * a hierarchy check so that higher-privilege roles inherit lower ones.
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

// ---------------------------------------------------------------------------
// Tool → minimum role mapping
// ---------------------------------------------------------------------------

export const TOOL_ROLE_REQUIREMENTS: Record<string, UserRole> = {
  // User-level tools — accessible to all authenticated users
  search_users: 'user',
  get_user: 'user',
  get_domains: 'user',
  get_domain: 'user',
  get_cdr_records: 'user',
  get_user_devices: 'user',
  get_user_answer_rules: 'user',
  get_user_answer_rule: 'user',
  get_user_greetings: 'user',
  get_user_voicemails: 'user',
  test_connection: 'user',

  // Domain admin tools
  get_phone_numbers: 'domain_admin',
  get_phone_number: 'domain_admin',
  get_call_queues: 'domain_admin',
  get_call_queue: 'domain_admin',
  get_call_queue_agents: 'domain_admin',
  get_agents: 'domain_admin',
  login_agent: 'domain_admin',
  logout_agent: 'domain_admin',
  get_auto_attendants: 'domain_admin',
  get_music_on_hold: 'domain_admin',
  get_billing: 'domain_admin',
  get_agent_statistics: 'domain_admin',
  manage_call_queues: 'domain_admin',
  manage_auto_attendants: 'domain_admin',
  manage_phone_numbers: 'domain_admin',
  manage_dial_plans: 'domain_admin',
  create_user: 'domain_admin',
  update_user: 'domain_admin',
  delete_user: 'domain_admin',

  // Reseller tools
  list_resellers: 'reseller',
  get_reseller: 'reseller',
  create_domain: 'reseller',
  update_domain: 'reseller',
  delete_domain: 'reseller',

  // System admin tools
  create_reseller: 'system_admin',
  update_reseller: 'system_admin',
  delete_reseller: 'system_admin',
  get_api_version: 'system_admin',
  get_access_log: 'system_admin',
  get_audit_log: 'system_admin',
  backup_system: 'system_admin',
  restore_system: 'system_admin',
  manage_certificates: 'system_admin',
  manage_routes: 'system_admin',
  manage_system_connections: 'system_admin',
  manage_system_dial_plans: 'system_admin',
  manage_system_dial_policy: 'system_admin',
  manage_system_subscriptions: 'system_admin',
};

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
