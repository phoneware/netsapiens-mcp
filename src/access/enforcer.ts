/**
 * The access enforcer: the registry's decision for a signed-in identity, compiled into the policy each surface enforces
 * (docs/access-registry.md, "Effective policy"). It combines the registry client, the policy compiler and the tool
 * catalog. It never throws. Any failure to decide is `unavailable`, which callers treat as closed for new access and
 * as a pass for sessions already signed in. The view says why it is unavailable.
 */
import type { EnabledAccessRegistryConfig } from './config.js';
import type { AccessPolicyV1 } from './contract.js';
import { normalizeIdentity } from './identity.js';
import { getToolCatalogView } from './groups.js';
import { compilePolicy, type CompiledPolicy } from './policy.js';
import {
  createAccessRegistryClient,
  type AccessRegistryClientDeps,
  type RegistryClient,
  type RegistryErrorClass,
  type RegistryResult,
} from './registry-client.js';
import type { AccessEnforcer, AccessEvaluateOptions, AccessIdentity, AccessView, ToolCatalogView } from './types.js';

/**
 * Why the registry could not decide. A value comes from the client's error class or from the policy compiler, never
 * from message text. `outage` is the fallback when the client reported no class, or when its call threw.
 */
export type AccessUnavailableCause =
  | 'outage'
  | 'policy_invalid'
  | 'contract'
  | 'critical'
  | 'http_status'
  | 'auth'
  | 'timeout'
  | 'network';

/** An unavailable view that says why. It is still an AccessView, so a consumer that ignores the cause is unaffected. */
export interface AccessUnavailableView {
  readonly kind: 'unavailable';
  readonly cause?: AccessUnavailableCause;
}

/** What this module's enforcer returns: an AccessView whose unavailable members carry the cause. */
export type CausedAccessView = Exclude<AccessView, { readonly kind: 'unavailable' }> | AccessUnavailableView;

/** An AccessEnforcer whose views say why they are unavailable. Every enforcer this module builds is of this kind. */
export interface CausedAccessEnforcer extends AccessEnforcer {
  evaluate(identity: AccessIdentity, options?: AccessEvaluateOptions): Promise<CausedAccessView>;
}

export interface AccessEnforcerDeps extends AccessRegistryClientDeps {
  /** Replaces the registry client that the configuration would build. Only decide is used. */
  readonly client?: Pick<RegistryClient, 'decide'>;
  /** Replaces the tool catalog. Defaults to the catalog this package ships. */
  readonly catalog?: ToolCatalogView;
}

/** The cause of each client error class. The record is exhaustive by type, so a new class must be mapped here too. */
const CAUSE_BY_ERROR_CLASS: Readonly<Record<RegistryErrorClass, AccessUnavailableCause>> = {
  timeout: 'timeout',
  network: 'network',
  http_status: 'http_status',
  auth: 'auth',
  contract: 'contract',
  invalid_json: 'contract',
  oversize: 'contract',
  critical: 'critical',
};

/** Compiled policies held at once. The least recently used revision is dropped first. */
const COMPILED_CAPACITY = 256;

interface CompiledEntry {
  /** The policy as the registry sent it, serialized. A revision that comes back with other content is compiled again. */
  readonly content: string;
  readonly compiled: CompiledPolicy;
}

function unavailable(cause: AccessUnavailableCause): AccessUnavailableView {
  const view: AccessUnavailableView = { kind: 'unavailable', cause };
  return Object.freeze(view);
}

/** Builds the enforcer an enabled registry configuration describes. Nothing is fetched until a decision is asked for. */
export function createAccessEnforcer(config: EnabledAccessRegistryConfig, deps: AccessEnforcerDeps = {}): CausedAccessEnforcer {
  const client = deps.client ?? createAccessRegistryClient(config, deps);
  const catalog = deps.catalog ?? getToolCatalogView();
  const compiled = new Map<string, CompiledEntry>();

  /** Compiles a policy once per revision. Throws AccessPolicyError when the policy cannot be enforced as written. */
  function compile(policy: AccessPolicyV1, revision: string): CompiledPolicy {
    const content = JSON.stringify(policy);
    const held = compiled.get(revision);
    if (held !== undefined && held.content === content) {
      compiled.delete(revision);
      compiled.set(revision, held);
      return held.compiled;
    }
    const next = compilePolicy(policy, catalog, revision);
    compiled.delete(revision);
    compiled.set(revision, { content, compiled: next });
    while (compiled.size > COMPILED_CAPACITY) {
      const oldest = compiled.keys().next();
      if (oldest.done) break;
      compiled.delete(oldest.value);
    }
    return next;
  }

  /** The client's answer for a query, or undefined when the client call itself threw. */
  async function askRegistry(identity: AccessIdentity, foreignTenant: string | undefined): Promise<RegistryResult | undefined> {
    try {
      return await client.decide({
        platform: identity.platform,
        tenant: foreignTenant ?? identity.tenant,
        subject: identity.subject,
        role: identity.role,
        tier: identity.tier,
      });
    } catch {
      return undefined;
    }
  }

  async function evaluate(identity: AccessIdentity, options: AccessEvaluateOptions = {}): Promise<CausedAccessView> {
    const answer = await askRegistry(identity, options.foreignTenant);
    if (answer === undefined) return unavailable('outage');
    const decision = answer.decision;
    if (answer.source === 'unavailable' || decision === undefined) {
      return unavailable(answer.errorClass === undefined ? 'outage' : CAUSE_BY_ERROR_CLASS[answer.errorClass]);
    }
    if (decision.decision === 'deny') return { kind: 'deny', reason: decision.reason };
    try {
      return { kind: 'allow', policy: compile(decision.policy, decision.revision) };
    } catch {
      // Any failure to compile is a policy the enforcer cannot apply as written, whichever error the compiler raised.
      return unavailable('policy_invalid');
    }
  }

  function identityFromAuthInfo(extra: Readonly<Record<string, unknown>> | undefined): AccessIdentity | undefined {
    if (extra === undefined) return undefined;
    const { nsDomain, nsUser, nsScope, nsApiUrl } = extra;
    if (typeof nsDomain !== 'string' || typeof nsUser !== 'string' || typeof nsScope !== 'string' || typeof nsApiUrl !== 'string') {
      return undefined;
    }
    try {
      return normalizeIdentity({ nsApiUrl, domain: nsDomain, user: nsUser, scope: nsScope });
    } catch {
      return undefined;
    }
  }

  return { evaluate, identityFromAuthInfo };
}
