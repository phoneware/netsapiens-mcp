/**
 * The access enforcer: the registry's decision for a signed-in identity, compiled into the policy each surface enforces
 * (docs/access-registry.md, "Effective policy"). It combines the registry client, the policy compiler and the tool
 * catalog. It never throws. Any failure to decide is `unavailable`, which callers treat as closed.
 */
import type { EnabledAccessRegistryConfig } from './config.js';
import type { AccessPolicyV1 } from './contract.js';
import { normalizeIdentity } from './identity.js';
import { getToolCatalogView } from './groups.js';
import { compilePolicy, type CompiledPolicy } from './policy.js';
import { createAccessRegistryClient, type AccessRegistryClientDeps, type RegistryClient } from './registry-client.js';
import type { AccessEnforcer, AccessEvaluateOptions, AccessIdentity, AccessView, ToolCatalogView } from './types.js';

export interface AccessEnforcerDeps extends AccessRegistryClientDeps {
  /** Replaces the registry client that the configuration would build. */
  readonly client?: RegistryClient;
  /** Replaces the tool catalog. Defaults to the catalog this package ships. */
  readonly catalog?: ToolCatalogView;
}

/** Compiled policies held at once. The least recently used revision is dropped first. */
const COMPILED_CAPACITY = 256;

const UNAVAILABLE: AccessView = Object.freeze({ kind: 'unavailable' as const });

interface CompiledEntry {
  /** The policy as the registry sent it, serialized. A revision that comes back with other content is compiled again. */
  readonly content: string;
  readonly compiled: CompiledPolicy;
}

/** Builds the enforcer an enabled registry configuration describes. Nothing is fetched until a decision is asked for. */
export function createAccessEnforcer(config: EnabledAccessRegistryConfig, deps: AccessEnforcerDeps = {}): AccessEnforcer {
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

  async function evaluate(identity: AccessIdentity, options: AccessEvaluateOptions = {}): Promise<AccessView> {
    try {
      const answer = await client.decide({
        platform: identity.platform,
        tenant: options.foreignTenant ?? identity.tenant,
        subject: identity.subject,
        role: identity.role,
        tier: identity.tier,
      });
      const decision = answer.decision;
      if (answer.source === 'unavailable' || decision === undefined) return UNAVAILABLE;
      if (decision.decision === 'deny') return { kind: 'deny', reason: decision.reason };
      return { kind: 'allow', policy: compile(decision.policy, decision.revision) };
    } catch {
      return UNAVAILABLE;
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
