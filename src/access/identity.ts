/**
 * Identity normalization for the access registry (docs/access-registry.md, "Identity").
 *
 * The registry keys every decision on (platform, tenant, subject). These functions make the same account
 * produce the same key whatever case or padding the sign-in or the portal URL carried.
 */
import { normalizePlatformUrl } from '../auth/platforms.js';
import { nsScopeToTier } from '../auth/roles.js';
import type { AccessIdentity } from './types.js';

export type AccessIdentityErrorCode =
  | 'empty_tenant'
  | 'invalid_tenant'
  | 'empty_user'
  | 'invalid_user'
  | 'invalid_platform';

/** The identity cannot be keyed. A caller must refuse the sign-in or the request. */
export class AccessIdentityError extends Error {
  readonly code: AccessIdentityErrorCode;

  constructor(code: AccessIdentityErrorCode, message: string) {
    super(message);
    this.name = 'AccessIdentityError';
    this.code = code;
  }
}

/** Whitespace, '@' and control characters are never part of a domain or user name. */
const FORBIDDEN_NAME_CHARS = /[\s@\u0000-\u001f\u007f]/;

function normalizeName(raw: string, field: 'tenant' | 'user'): string {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === '') {
    throw new AccessIdentityError(field === 'tenant' ? 'empty_tenant' : 'empty_user', `${field} is empty`);
  }
  if (FORBIDDEN_NAME_CHARS.test(value)) {
    throw new AccessIdentityError(
      field === 'tenant' ? 'invalid_tenant' : 'invalid_user',
      `${field} contains whitespace, "@" or a control character`,
    );
  }
  return value;
}

/** Home domain as the registry keys it: trimmed, lowercased. */
export function normalizeTenant(raw: string): string {
  return normalizeName(raw, 'tenant');
}

/** NetSapiens user name as the registry keys it: trimmed, lowercased, no domain. */
export function normalizeUser(raw: string): string {
  return normalizeName(raw, 'user');
}

/** The subject the registry sees: user@tenant. */
export function subjectOf(user: string, tenant: string): string {
  return `${user}@${tenant}`;
}

export interface IdentityInput {
  /** The NetSapiens API URL the session is bound to. Normalized to its origin. */
  readonly nsApiUrl: string;
  /** Home domain as NetSapiens returns it. */
  readonly domain: string;
  /** NetSapiens user name, without the domain. */
  readonly user: string;
  /** NetSapiens user-scope string, or undefined or null when unknown. */
  readonly scope?: string | null;
}

/** Builds the registry identity for a signed-in account. Throws AccessIdentityError when it cannot be keyed. */
export function normalizeIdentity(input: IdentityInput): AccessIdentity {
  let platform: string;
  try {
    platform = normalizePlatformUrl(input.nsApiUrl);
  } catch {
    throw new AccessIdentityError('invalid_platform', 'NetSapiens API URL is not an http(s) origin');
  }
  const tenant = normalizeTenant(input.domain);
  const user = normalizeUser(input.user);
  const role = input.scope ?? '';
  return {
    platform,
    tenant,
    user,
    subject: subjectOf(user, tenant),
    role,
    tier: nsScopeToTier(role),
  };
}
