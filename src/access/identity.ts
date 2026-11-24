/**
 * Identity normalization for the access registry (docs/access-registry.md, "Identity").
 *
 * The registry keys every decision on (platform, tenant, subject). Tenant and user names are NetSapiens domain and
 * user names, which are ASCII. A name is never normalized into a different name: anything outside printable ASCII is
 * refused, so two raw names cannot share a registry key.
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

/** Printable ASCII, 0x21 to 0x7E. The space is excluded: it is trimmed at the ends and refused inside a name. */
const PRINTABLE_ASCII = /^[!-~]+$/;

/**
 * Removes ASCII space and tab from both ends, and nothing else. It is a loop rather than a regular expression, so a
 * long run of blanks costs time linear in its length.
 */
function trimSpaceAndTab(raw: string): string {
  let start = 0;
  let end = raw.length;
  while (start < end && (raw[start] === ' ' || raw[start] === '\t')) start++;
  while (end > start && (raw[end - 1] === ' ' || raw[end - 1] === '\t')) end--;
  return raw.slice(start, end);
}

/**
 * Tenant and user names: trim ASCII space and tab, refuse anything outside printable ASCII or containing "@", then
 * lowercase. The checks run before lowercasing, so no non-ASCII character can lowercase into an ASCII one.
 */
function normalizeName(raw: string, field: 'tenant' | 'user'): string {
  const trimmed = typeof raw === 'string' ? trimSpaceAndTab(raw) : '';
  const isTenant = field === 'tenant';
  if (trimmed === '') {
    throw new AccessIdentityError(isTenant ? 'empty_tenant' : 'empty_user', `${field} is empty`);
  }
  if (!PRINTABLE_ASCII.test(trimmed) || trimmed.includes('@')) {
    throw new AccessIdentityError(
      isTenant ? 'invalid_tenant' : 'invalid_user',
      `${field} must be printable ASCII with no spaces inside and no "@"`,
    );
  }
  return trimmed.toLowerCase();
}

/** Home domain as the registry keys it: ASCII space and tab trimmed, printable ASCII only, lowercased. */
export function normalizeTenant(raw: string): string {
  return normalizeName(raw, 'tenant');
}

/** NetSapiens user name as the registry keys it: the same rules as the tenant, and no domain. */
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
