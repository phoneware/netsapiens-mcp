import { describe, it, expect } from 'vitest';
import {
  hasPermission,
  mapNsScope,
  ROLE_HIERARCHY,
  TOOL_ROLE_REQUIREMENTS,
} from '../auth/roles.js';
import type { UserRole } from '../auth/roles.js';

describe('RBAC roles', () => {
  // -----------------------------------------------------------------------
  // ROLE_HIERARCHY
  // -----------------------------------------------------------------------

  describe('ROLE_HIERARCHY', () => {
    it('system_admin > reseller > domain_admin > user', () => {
      expect(ROLE_HIERARCHY.system_admin).toBeGreaterThan(ROLE_HIERARCHY.reseller);
      expect(ROLE_HIERARCHY.reseller).toBeGreaterThan(ROLE_HIERARCHY.domain_admin);
      expect(ROLE_HIERARCHY.domain_admin).toBeGreaterThan(ROLE_HIERARCHY.user);
    });
  });

  // -----------------------------------------------------------------------
  // hasPermission
  // -----------------------------------------------------------------------

  describe('hasPermission()', () => {
    it('user can access user-level tools', () => {
      expect(hasPermission('user', 'user')).toBe(true);
    });

    it('user cannot access domain_admin tools', () => {
      expect(hasPermission('user', 'domain_admin')).toBe(false);
    });

    it('domain_admin can access user-level tools', () => {
      expect(hasPermission('domain_admin', 'user')).toBe(true);
    });

    it('domain_admin can access domain_admin tools', () => {
      expect(hasPermission('domain_admin', 'domain_admin')).toBe(true);
    });

    it('domain_admin cannot access reseller tools', () => {
      expect(hasPermission('domain_admin', 'reseller')).toBe(false);
    });

    it('reseller can access domain_admin tools', () => {
      expect(hasPermission('reseller', 'domain_admin')).toBe(true);
    });

    it('system_admin can access everything', () => {
      const roles: UserRole[] = ['user', 'domain_admin', 'reseller', 'system_admin'];
      for (const role of roles) {
        expect(hasPermission('system_admin', role)).toBe(true);
      }
    });

    it('user can only access user-level', () => {
      expect(hasPermission('user', 'user')).toBe(true);
      expect(hasPermission('user', 'domain_admin')).toBe(false);
      expect(hasPermission('user', 'reseller')).toBe(false);
      expect(hasPermission('user', 'system_admin')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // TOOL_ROLE_REQUIREMENTS
  // -----------------------------------------------------------------------

  describe('TOOL_ROLE_REQUIREMENTS', () => {
    it('maps known user-level tools to user', () => {
      expect(TOOL_ROLE_REQUIREMENTS.search_users).toBe('user');
      expect(TOOL_ROLE_REQUIREMENTS.get_user).toBe('user');
      expect(TOOL_ROLE_REQUIREMENTS.test_connection).toBe('user');
    });

    it('maps domain admin tools to domain_admin', () => {
      expect(TOOL_ROLE_REQUIREMENTS.get_phone_numbers).toBe('domain_admin');
      expect(TOOL_ROLE_REQUIREMENTS.get_call_queues).toBe('domain_admin');
      expect(TOOL_ROLE_REQUIREMENTS.login_agent).toBe('domain_admin');
    });

    it('maps reseller tools to reseller', () => {
      expect(TOOL_ROLE_REQUIREMENTS.create_domain).toBe('reseller');
      expect(TOOL_ROLE_REQUIREMENTS.list_resellers).toBe('reseller');
    });

    it('maps system admin tools to system_admin', () => {
      expect(TOOL_ROLE_REQUIREMENTS.backup_system).toBe('system_admin');
      expect(TOOL_ROLE_REQUIREMENTS.get_audit_log).toBe('system_admin');
    });
  });

  // -----------------------------------------------------------------------
  // mapNsScope
  // -----------------------------------------------------------------------

  describe('mapNsScope()', () => {
    it('maps Super User to system_admin', () => {
      expect(mapNsScope('Super User')).toBe('system_admin');
    });

    it('maps System Admin to system_admin', () => {
      expect(mapNsScope('System Admin')).toBe('system_admin');
    });

    it('maps Reseller to reseller', () => {
      expect(mapNsScope('Reseller')).toBe('reseller');
    });

    it('maps Office Manager to domain_admin', () => {
      expect(mapNsScope('Office Manager')).toBe('domain_admin');
    });

    it('maps Site Manager to domain_admin', () => {
      expect(mapNsScope('Site Manager')).toBe('domain_admin');
    });

    it('maps Domain Admin to domain_admin', () => {
      expect(mapNsScope('Domain Admin')).toBe('domain_admin');
    });

    it('maps Basic User to user', () => {
      expect(mapNsScope('Basic User')).toBe('user');
    });

    it('maps unknown values to user', () => {
      expect(mapNsScope('SomeRandomRole')).toBe('user');
    });

    it('handles null/undefined gracefully', () => {
      expect(mapNsScope(null)).toBe('user');
      expect(mapNsScope(undefined)).toBe('user');
    });

    it('handles empty string', () => {
      expect(mapNsScope('')).toBe('user');
    });

    it('is case-insensitive', () => {
      expect(mapNsScope('SUPER USER')).toBe('system_admin');
      expect(mapNsScope('reseller')).toBe('reseller');
      expect(mapNsScope('office manager')).toBe('domain_admin');
    });
  });
});
