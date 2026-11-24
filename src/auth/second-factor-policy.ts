import { createHmac, timingSafeEqual } from 'node:crypto';
import type { UserRole } from './roles.js';

export interface SecondFactorPolicy {
 tiers: UserRole[];
 acceptProviderSignIn: boolean;
 acceptPastedToken: boolean;
 applyToExistingSessions: boolean;
}

/** Undefined disables the policy. Any supplied value must be complete. */
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
     new Set(obj.tiers).size !== obj.tiers.length || typeof obj.acceptProviderSignIn !== 'boolean' ||
     typeof obj.acceptPastedToken !== 'boolean' || typeof obj.applyToExistingSessions !== 'boolean') {
  throw new Error('ConfigError: MCP_SECOND_FACTOR_POLICY requires valid tiers and boolean acceptProviderSignIn, acceptPastedToken and applyToExistingSessions');
 }
 return obj as unknown as SecondFactorPolicy;
}

const knownScopes: Record<string, true> = {
 'super user': true, superuser: true, reseller: true, 'office manager': true,
 'site manager': true, 'domain admin': true, 'call center supervisor': true,
 'call center agent': true, 'advanced user': true, 'basic user': true,
 'simple user': true, 'no portal': true,
};
const userScopes: Record<string, true> = {
 'call center agent': true, 'advanced user': true, 'basic user': true, 'simple user': true, 'no portal': true,
};

/** Unknown scope is an availability failure, never an unprivileged classification. */
export function knownScope(scope: unknown): scope is string {
 return typeof scope === 'string' && Object.hasOwn(knownScopes, scope.trim().toLowerCase());
}

export function scopeRequiresSecondFactor(policy: SecondFactorPolicy, scope: string): boolean {
 const normalized = scope.trim().toLowerCase();
 return (normalized === 'office manager' && policy.tiers.includes('domain_admin')) ||
  (normalized === 'reseller' && policy.tiers.includes('reseller')) ||
  ((normalized === 'super user' || normalized === 'superuser') && policy.tiers.includes('system_admin')) ||
  (Object.hasOwn(userScopes, normalized) && policy.tiers.includes('user'));
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

const assuranceFields = ['authMethod', 'authNsTotp', 'authAt', 'authProviderSubjectHash', 'authProviderTenant', 'nsGrantKind'] as const;

function signature(extra: Readonly<Record<string, string>>, username: string, apiUrl: string, secret: string): string {
 return createHmac('sha256', secret).update(JSON.stringify(['ns-assurance-v1', username, apiUrl, assuranceFields.map((key) => extra[key] ?? null)])).digest('base64url');
}

/** Only call after the server has replaced all hook-provided assurance fields. */
export function signServerAssurance(extra: Record<string, string>, username: string, apiUrl: string, secret: string): void {
 extra.authAssuranceSig = signature(extra, username, apiUrl, secret);
}

/** Sessions predating this signature have no trusted assurance, even when fields match. */
export function hasServerAssurance(extra: Readonly<Record<string, string>> | undefined, username: string, apiUrl: string, secret: string): boolean {
 if (!extra || typeof extra.authAssuranceSig !== 'string') return false;
 const actual = Buffer.from(extra.authAssuranceSig);
 const expected = Buffer.from(signature(extra, username, apiUrl, secret));
 return actual.length === expected.length && timingSafeEqual(actual, expected);
}
