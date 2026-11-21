import { createHmac, timingSafeEqual } from 'node:crypto';
import type { UserRole } from './roles.js';
import { nsScopeToTier } from './roles.js';

export interface SecondFactorPolicy {
 tiers: UserRole[];
 acceptProviderSignIn: boolean;
 acceptPastedToken: boolean;
 applyToExistingSessions: boolean;
}

/** Undefined disables the policy. Any supplied value must be a complete policy. */
export function parseSecondFactorPolicy(raw: string | undefined): SecondFactorPolicy | undefined {
 if (raw === undefined) return undefined;
 let value: unknown;
 try { value = JSON.parse(raw); } catch { throw new Error('ConfigError: MCP_SECOND_FACTOR_POLICY must be a JSON object'); }
 if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ConfigError: MCP_SECOND_FACTOR_POLICY must be a JSON object');
 const obj = value as Record<string, unknown>;
 const keys = ['tiers', 'acceptProviderSignIn', 'acceptPastedToken', 'applyToExistingSessions'];
 const roles = ['system_admin', 'reseller', 'domain_admin', 'user'];
 if (Object.keys(obj).some((key) => !keys.includes(key)) || !Array.isArray(obj.tiers) ||
     obj.tiers.length === 0 || obj.tiers.some((role) => typeof role !== 'string' || !roles.includes(role)) ||
     new Set(obj.tiers).size !== obj.tiers.length ||
     typeof obj.acceptProviderSignIn !== 'boolean' || typeof obj.acceptPastedToken !== 'boolean' ||
     typeof obj.applyToExistingSessions !== 'boolean') {
  throw new Error('ConfigError: MCP_SECOND_FACTOR_POLICY requires valid tiers and boolean acceptProviderSignIn, acceptPastedToken and applyToExistingSessions');
 }
 return obj as unknown as SecondFactorPolicy;
}

/** Do not classify an absent or unrecognized upstream scope as an unprivileged user. */
export function knownScopeTier(scope: unknown): UserRole | undefined {
 if (typeof scope !== 'string') return undefined;
 const normalized = scope.trim().toLowerCase();
 const known = ['super user', 'reseller', 'office manager', 'site manager',
  'domain admin', 'call center supervisor', 'call center agent', 'advanced user',
  'basic user', 'simple user', 'no portal'];
 return known.includes(normalized) ? nsScopeToTier(normalized) : undefined;
}

export function satisfiesSecondFactorPolicy(policy: SecondFactorPolicy, extra: { readonly authMethod?: string; readonly authNsTotp?: string } | undefined): boolean {
 switch (extra?.authMethod) {
  case 'password': return extra.authNsTotp === 'true';
  case 'ns_token': return policy.acceptPastedToken;
  case 'sso_google':
  case 'sso_office': return policy.acceptProviderSignIn;
  default: return false;
 }
}
/** A domain-admin tier is broader than Office Manager, so do not apply it to its other scopes. */
export function scopeRequiresSecondFactor(policy: SecondFactorPolicy, scope: string): boolean {
 const normalized = scope.trim().toLowerCase();
 return (normalized === 'office manager' && policy.tiers.includes('domain_admin')) ||
  (normalized === 'reseller' && policy.tiers.includes('reseller')) ||
  ((normalized === 'super user' || normalized === 'superuser') && policy.tiers.includes('system_admin')) ||
  (knownScopeTier(normalized) === 'user' && policy.tiers.includes('user'));
}


export const ASSURANCE_KEYS = ['authMethod', 'authNsTotp', 'authAt', 'authProviderSubjectHash', 'authProviderTenant', 'nsGrantKind', 'authAssuranceSig'] as const;
export type AuthMethod = 'password' | 'ns_token' | 'sso_google' | 'sso_office';
export type Assurance = { authMethod: AuthMethod; authNsTotp: 'true' | 'false'; authAt: string; nsGrantKind: 'oauth' | 'jwt'; authProviderSubjectHash?: string; authProviderTenant?: string };

function assuranceSignature(extra: Readonly<Record<string, string>>, username: string, apiUrl: string, secret: string): string {
 const values = ASSURANCE_KEYS.filter((key) => key !== 'authAssuranceSig').map((key) => extra[key] ?? null);
 return createHmac('sha256', secret).update(JSON.stringify(['ns-assurance-v1', username, apiUrl, values])).digest('base64url');
}

/** Hook and resume data never get to author or overwrite assurance. */
export function withAssurance(extra: Record<string, string> | undefined, assurance: Assurance, username: string, apiUrl: string, secret: string): Record<string, string> {
 const result = { ...extra };
 for (const key of ASSURANCE_KEYS) delete result[key];
 Object.assign(result, assurance, assurance.authMethod === 'password' ? {} : { authNsTotp: 'false' });
 result.authAssuranceSig = assuranceSignature(result, username, apiUrl, secret);
 return result;
}

/** Legacy hook-owned fields are not evidence, even if they use a reserved name. */
export function hasServerAssurance(extra: Readonly<Record<string, string>> | undefined, username: string, apiUrl: string, secret: string): boolean {
 if (!extra || typeof extra.authAssuranceSig !== 'string') return false;
 const actual = Buffer.from(extra.authAssuranceSig);
 const expected = Buffer.from(assuranceSignature(extra, username, apiUrl, secret));
 return actual.length === expected.length && timingSafeEqual(actual, expected);
}
