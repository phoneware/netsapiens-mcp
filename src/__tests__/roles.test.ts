import { describe, it, expect } from 'vitest';
import {
  hasPermission,
  nsScopeToTier,
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

  describe('TOOL_ROLE_REQUIREMENTS (deprecated)', () => {
    it('is an empty map — RBAC is enforced by NS server-side', () => {
      // The hand-written tool-to-role map was replaced by OpenAPI-driven
      // tool generation; NS enforces authorization via the bearer token.
      expect(TOOL_ROLE_REQUIREMENTS).toEqual({});
    });
  });

  // -----------------------------------------------------------------------
  // nsScopeToTier
  // -----------------------------------------------------------------------

  describe('nsScopeToTier()', () => {
    it('maps Super User to system_admin', () => {
      expect(nsScopeToTier('Super User')).toBe('system_admin');
    });

    it('maps System Admin to system_admin', () => {
      expect(nsScopeToTier('System Admin')).toBe('system_admin');
    });

    it('maps Reseller to reseller', () => {
      expect(nsScopeToTier('Reseller')).toBe('reseller');
    });

    it('maps Office Manager to domain_admin', () => {
      expect(nsScopeToTier('Office Manager')).toBe('domain_admin');
    });

    it('maps Site Manager to domain_admin', () => {
      expect(nsScopeToTier('Site Manager')).toBe('domain_admin');
    });

    it('maps Domain Admin to domain_admin', () => {
      expect(nsScopeToTier('Domain Admin')).toBe('domain_admin');
    });
    it('maps Call Center Supervisor to domain_admin', () => {
      expect(nsScopeToTier('Call Center Supervisor')).toBe('domain_admin');
    });

    it('maps Call Center Agent, Advanced User, Simple User to user', () => {
      expect(nsScopeToTier('Call Center Agent')).toBe('user');
      expect(nsScopeToTier('Advanced User')).toBe('user');
      expect(nsScopeToTier('Simple User')).toBe('user');
    });

    it('maps No Portal to user', () => {
      expect(nsScopeToTier('No Portal')).toBe('user');
    });

    it('maps Basic User to user', () => {
      expect(nsScopeToTier('Basic User')).toBe('user');
    });

    it('maps unknown values to user', () => {
      expect(nsScopeToTier('SomeRandomRole')).toBe('user');
    });

    it('handles null/undefined gracefully', () => {
      expect(nsScopeToTier(null)).toBe('user');
      expect(nsScopeToTier(undefined)).toBe('user');
    });

    it('handles empty string', () => {
      expect(nsScopeToTier('')).toBe('user');
    });

    it('is case-insensitive', () => {
      expect(nsScopeToTier('SUPER USER')).toBe('system_admin');
      expect(nsScopeToTier('reseller')).toBe('reseller');
      expect(nsScopeToTier('office manager')).toBe('domain_admin');
      expect(nsScopeToTier('CALL CENTER SUPERVISOR')).toBe('domain_admin');
    });
  });
});
