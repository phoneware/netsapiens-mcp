/**
 * A controllable AccessEnforcer for tests. It answers from the views a test sets and records each evaluation. Identity
 * comes from the reserved auth-info keys and is normalized by the same function the registry enforcer uses, so a test
 * sees the same tenant and subject keys production does.
 */
import type { AccessPolicyV1 } from '../../access/contract.js';
import { normalizeIdentity } from '../../access/identity.js';
import { getToolCatalogView } from '../../access/groups.js';
import { compilePolicy } from '../../access/policy.js';
import type { AccessEnforcer, AccessView } from '../../access/types.js';

export interface FakeEnforcer extends AccessEnforcer {
  /** Replaces the view for the signed-in person's own domain. */
  setHome(view: AccessView): void;
  /** Sets the view for one foreign tenant. A tenant that was never set answers tenant_not_enrolled. */
  setForeign(tenant: string, view: AccessView): void;
  /** Every evaluation, in order: the home tenant, and the foreign tenant when the request named one. */
  readonly evaluations: Array<{ readonly tenant: string; readonly foreignTenant: string | undefined }>;
}

/** An allow view for a policy, compiled against the real tool catalog. */
export function allowView(policy: AccessPolicyV1, revision: string): AccessView {
  return { kind: 'allow', policy: compilePolicy(policy, getToolCatalogView(), revision) };
}

export function createFakeEnforcer(initialHome: AccessView): FakeEnforcer {
  let home = initialHome;
  const foreign = new Map<string, AccessView>();
  const evaluations: Array<{ readonly tenant: string; readonly foreignTenant: string | undefined }> = [];
  return {
    evaluations,
    setHome(view: AccessView): void {
      home = view;
    },
    setForeign(tenant: string, view: AccessView): void {
      foreign.set(tenant, view);
    },
    identityFromAuthInfo(extra) {
      if (extra === undefined) return undefined;
      const domain = extra.nsDomain;
      const user = extra.nsUser;
      if (typeof domain !== 'string' || typeof user !== 'string') return undefined;
      const apiUrl = typeof extra.nsApiUrl === 'string' ? extra.nsApiUrl : 'https://pbx.example.com';
      const scope = typeof extra.nsScope === 'string' ? extra.nsScope : '';
      try {
        return normalizeIdentity({ nsApiUrl: apiUrl, domain, user, scope });
      } catch {
        return undefined;
      }
    },
    async evaluate(identity, options) {
      evaluations.push({ tenant: identity.tenant, foreignTenant: options?.foreignTenant });
      if (options?.foreignTenant === undefined) return home;
      return foreign.get(options.foreignTenant) ?? { kind: 'deny', reason: 'tenant_not_enrolled' };
    },
  };
}
