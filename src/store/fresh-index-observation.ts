import { CutoverFenceError, CutoverRefusedError } from './errors.js';
import { assertConcreteCoverage, assertDocumentBudget, concreteFieldPaths, type FreshCollectionCoverage, type SignedIndexPolicy } from './index-coverage.js';
import type { ProtectedBinding } from './protected-binding.js';

// Fresh authenticated Admin observation. The producer is the shared index
// policy reader; until it is handed over, no observation can be recorded and
// every migration check that needs one refuses. Nothing here assumes coverage.

export const FRESH_INDEX_OBSERVATION_MAX_AGE_NS = 120_000n * 1_000_000n;

export interface FreshIndexObservation {
  readonly purpose: 'preparation' | 'activation';
  readonly namespace: string;
  readonly expectedEpoch: number;
  readonly migrationRunId: string;
  readonly indexPolicyDigest: string;
  readonly sourceInventoryDigest: string | null;
  readonly requiredFields: Readonly<Record<string, readonly string[]>>;
  readonly coverage: ReadonlyMap<string, FreshCollectionCoverage>;
  readonly completedAtNs: bigint;
  // SHA-256 of the Admin read token the STS exchange produced for the handle.
  readonly accessTokenDigest: string;
}

const observations = new WeakMap<object, FreshIndexObservation>();

// Records the one observation this handle may use. A second record refuses.
export function recordFreshIndexObservation(db: object, observation: FreshIndexObservation): void {
  if (observations.has(db)) throw new CutoverFenceError('A fresh index observation is already recorded for this handle');
  observations.set(db, observation);
}

function requireObservation(db: object, purpose: FreshIndexObservation['purpose'], binding: ProtectedBinding): FreshIndexObservation {
  const observation = observations.get(db);
  if (!observation) throw new CutoverRefusedError('Fresh authenticated index observation is required');
  if (observation.purpose !== purpose) throw new CutoverRefusedError('Fresh index observation has the wrong purpose');
  if (observation.namespace !== binding.namespace ||
    observation.expectedEpoch !== binding.expectedEpoch ||
    observation.migrationRunId !== binding.migrationRunId ||
    observation.indexPolicyDigest !== binding.indexPolicyDigest) {
    throw new CutoverRefusedError('Fresh index observation does not match the authenticated binding');
  }
  if (observation.accessTokenDigest !== binding.adminTokenDigest) {
    throw new CutoverRefusedError('Fresh index observation was not read with the authenticated exchange token');
  }
  const ageNs = process.hrtime.bigint() - observation.completedAtNs;
  if (ageNs < 0n || ageNs > FRESH_INDEX_OBSERVATION_MAX_AGE_NS) {
    throw new CutoverRefusedError('Fresh index observation is outside the allowed age window');
  }
  return observation;
}

// Conservative TTL hold. Firestore TTL deletes documents on its own clock, and
// an IAM freeze does not stop them. A prospective document whose TTL timestamp
// falls inside this window could expire while the protected interval runs, so
// preparation refuses it. A malformed TTL value also refuses. The window is a
// planner-owned value pending approval.
export const TTL_HOLD_WINDOW_MS = 24 * 60 * 60 * 1000;

function valueAtPath(document: unknown, fieldPath: string): unknown {
  let current: unknown = document;
  for (const segment of fieldPath.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function timestampMillis(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime();
  const toMillis = (value as { toMillis?: unknown } | null)?.toMillis;
  if (typeof toMillis === 'function') return (toMillis as () => number).call(value);
  return undefined;
}

export function assertTtlHold(policy: SignedIndexPolicy, group: string, document: unknown, nowMs: number): void {
  const collection = policy.collections.find((entry) => entry.collectionGroup === group);
  for (const entry of (collection?.ttl ?? []) as Array<{ fieldPath?: unknown; state?: unknown }>) {
    if (typeof entry.fieldPath !== 'string' || entry.state !== 'ACTIVE') {
      throw new CutoverRefusedError('Signed TTL policy entry is malformed');
    }
    const value = valueAtPath(document, entry.fieldPath);
    if (value === undefined || value === null) continue;
    const ms = timestampMillis(value);
    if (ms === undefined || !Number.isFinite(ms)) throw new CutoverRefusedError('TTL-governed field is not a timestamp');
    if (ms <= nowMs + TTL_HOLD_WINDOW_MS) {
      throw new CutoverRefusedError('Prospective document could expire under TTL during the protected interval');
    }
  }
}

// Preparation: runs inside the preparation transaction and in the dry run.
// Every prospective write must fit the budgets, sit in a signed group, and have
// its concrete paths covered by the fresh observation and the signed policy.
export function assertPreparationObservation(input: {
  readonly db: object;
  readonly binding: ProtectedBinding;
  readonly inventoryDigest: string;
  readonly writes: ReadonlyArray<{ readonly group: string; readonly document: unknown }>;
}): void {
  const { db, binding, inventoryDigest, writes } = input;
  const observation = requireObservation(db, 'preparation', binding);
  if (observation.sourceInventoryDigest !== inventoryDigest) {
    throw new CutoverRefusedError('Source inventory digest differs from the observed inventory');
  }
  const schema = binding.indexSchema as { policy: SignedIndexPolicy; provenance: { databaseResource: string } };
  for (const write of writes) {
    assertDocumentBudget({
      document: write.document,
      policy: schema.policy,
      databaseResource: schema.provenance.databaseResource,
      collectionGroup: write.group,
    });
    assertTtlHold(schema.policy, write.group, write.document, Date.now());
    const fresh = observation.coverage.get(write.group);
    const required = observation.requiredFields[write.group];
    if (!fresh || !required) throw new CutoverRefusedError('Prospective collection group is not in the observation');
    const paths = concreteFieldPaths(write.document).multiplicity;
    for (const path of paths.keys()) {
      if (!required.includes(path)) throw new CutoverRefusedError('Concrete field is not in the observed required set');
    }
    assertConcreteCoverage({
      policy: schema.policy,
      databaseResource: schema.provenance.databaseResource,
      collectionGroup: write.group,
      paths,
      fresh,
    });
  }
}

// Activation: runs only when control is v3_ready. Requires an activation
// observation with the same policy digest and a fresh age.
export function assertActivationObservation(db: object, binding: ProtectedBinding): void {
  requireObservation(db, 'activation', binding);
}
