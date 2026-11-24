/**
 * Shared shapes for the access registry: the identity a session carries, the view an enforcer returns,
 * and the catalog view the policy compiler reads (implemented by the tool catalog).
 */
import type { UserRole } from '../auth/roles.js';
import type { ContentKind } from '../governance/types.js';
import type { CompiledPolicy } from './policy.js';

/** Tier derived from the NetSapiens user scope. */
export type AccessTier = UserRole;

export interface AccessIdentity {
  /** NetSapiens API origin, from normalizePlatformUrl. */
  readonly platform: string;
  /** Home domain, trimmed and lowercased. */
  readonly tenant: string;
  /** NetSapiens user name, trimmed and lowercased, without the domain. */
  readonly user: string;
  /** user@tenant. */
  readonly subject: string;
  /** NetSapiens user-scope string as NetSapiens returned it, or "" when unknown. */
  readonly role: string;
  readonly tier: AccessTier;
}

export interface ToolCatalogEntry {
  /** The curated name, or the generated registry key. */
  readonly canonical: string;
  /** The name clients see, possibly shortened. */
  readonly exposed: string;
  /** Group names such as "@curated", "@read" or "@content:transcript". */
  readonly groups: readonly string[];
}

/** Content kinds an operation key belongs to. "unreviewed" counts for every kind. */
export type OperationClass = readonly ContentKind[] | 'unreviewed';

export interface ToolCatalogView {
  /** Resolves a canonical or exposed name. Undefined when no tool has that name. */
  lookupTool(name: string): ToolCatalogEntry | undefined;
  /** Classifies a normalized operation key. Undefined when the key is not a content operation. */
  lookupOperation(key: string): OperationClass | undefined;
}

/** A NetSapiens request about to be sent. The key is normalizeOperationKey(method, path) or "v1:<object>:<action>". */
export type OperationRef =
  | { readonly kind: 'v2'; readonly method: string; readonly key: string }
  | { readonly kind: 'v1'; readonly action: string; readonly key: string };

export type AccessView =
  | { readonly kind: 'allow'; readonly policy: CompiledPolicy }
  | { readonly kind: 'deny'; readonly reason: string }
  | { readonly kind: 'unavailable' };

/** Auth-info keys the registry owns. Hook-supplied values under these keys are discarded. */
export const ACCESS_EXTRA_KEYS = ['nsDomain', 'nsUser', 'nsScope', 'authRedirectUri'] as const;
export type AccessExtraKey = (typeof ACCESS_EXTRA_KEYS)[number];

export interface AccessEvaluateOptions {
  /** Set only for a request that explicitly names another domain. Omitted for the subject's home domain. */
  readonly foreignTenant?: string;
}

export interface AccessEnforcer {
  evaluate(identity: AccessIdentity, options?: AccessEvaluateOptions): Promise<AccessView>;
  /** Undefined when the auth info carries no usable identity, such as a session that predates the registry. */
  identityFromAuthInfo(extra: Readonly<Record<string, unknown>> | undefined): AccessIdentity | undefined;
}
