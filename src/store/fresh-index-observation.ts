import { canonicalJson } from '../cutover/dsse-verifier-core.mjs';
import { assertConcreteCoverage, assertDocumentBudget, concreteFieldPaths, type FreshCollectionCoverage, type SignedIndexPolicy } from './index-coverage.js';
import type { ProtectedBinding } from './protected-binding.js';
import { CutoverFenceError, CutoverRefusedError } from './errors.js';

// Fresh authenticated Admin observation. fresh-index-producer.ts records it, reading
// with the handle's authenticated token. Without a recorded observation for this
// handle, every check that needs one refuses. Nothing here assumes coverage.

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

// The authenticated recorded preparation observation for this handle, for the preparation seam. It is the
// same record the preparation gate checked: purpose, namespace, epoch, run, policy digest, admin token
// digest and age are all re-verified against the binding now. It never observes again, so there is one
// observation per handle. A caller cannot supply it; it refuses unless the recorded one matches.
export function recordedPreparationObservation(db: object, binding: ProtectedBinding): FreshIndexObservation {
  return requireObservation(db, 'preparation', binding);
}

// True only when this exact object is the observation recorded for the handle and it is still within the
// freshness window. A structurally identical copy, a fake, another handle's record or a stale record is refused.
// Identity comes from the module's single WeakMap, so no caller can forge it.
export function isRecordedObservation(db: object, observation: unknown): boolean {
  if (observation === undefined || observations.get(db) !== observation) return false;
  const ageNs = process.hrtime.bigint() - (observation as FreshIndexObservation).completedAtNs;
  return ageNs >= 0n && ageNs <= FRESH_INDEX_OBSERVATION_MAX_AGE_NS;
}

// TTL schema for prospective targets. The settled expiry metadata is the row's own
// stored field: sessions carry ttlAt = retainUntil, auth codes and resume tokens
// carry ttlAt = expiresAt. Nothing is recomputed or extended here. A record whose
// group has no TTL rule must carry no ttlAt. The signed policy must agree with the
// rule, so a TTL policy that is absent or on another field refuses.
const TTL_RETENTION_FIELD: Record<'sessions' | 'auth_codes' | 'resume_tokens', 'retainUntil' | 'expiresAt'> = {
  sessions: 'retainUntil',
  auth_codes: 'expiresAt',
  resume_tokens: 'expiresAt',
};

function ttlRuleFor(group: string): 'retainUntil' | 'expiresAt' | null {
  for (const suffix of ['sessions', 'auth_codes', 'resume_tokens'] as const) {
    if (group.endsWith(`_${suffix}`)) return TTL_RETENTION_FIELD[suffix];
  }
  return null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function assertTtlSchema(policy: SignedIndexPolicy, group: string, document: unknown): void {
  const signed = policy.collections.find((entry) => entry.collectionGroup === group)?.ttl ?? [];
  for (const entry of signed as Array<{ fieldPath?: unknown; state?: unknown }>) {
    if (entry.fieldPath !== 'ttlAt' || entry.state !== 'ACTIVE') {
      throw new CutoverRefusedError('Signed TTL policy entry is malformed or not on ttlAt');
    }
  }
  const rule = ttlRuleFor(group);
  const doc = (document !== null && typeof document === 'object' ? document : {}) as Record<string, unknown>;
  if (rule === null) {
    if (signed.length > 0) throw new CutoverRefusedError('Signed TTL policy exists for a group without a TTL rule');
    if (doc.ttlAt !== undefined) throw new CutoverRefusedError('Record in a group without a TTL rule carries ttlAt');
    return;
  }
  if (signed.length !== 1) throw new CutoverRefusedError('Signed TTL policy is missing for a TTL-governed group');
  if (!isPositiveInteger(doc[rule])) throw new CutoverRefusedError(`${rule} must be a positive integer timestamp`);
  if (!(doc.ttlAt instanceof Date) || !Number.isFinite(doc.ttlAt.getTime())) {
    throw new CutoverRefusedError('ttlAt must be a valid timestamp');
  }
  if (doc.ttlAt.getTime() !== doc[rule]) throw new CutoverRefusedError(`ttlAt must equal ${rule}`);
  if (rule === 'retainUntil') {
    if (!isPositiveInteger(doc.expiresAt) || (doc.retainUntil as number) < doc.expiresAt) {
      throw new CutoverRefusedError('retainUntil must be at least expiresAt');
    }
  } else if (group.endsWith('_resume_tokens')) {
    if (typeof doc.consumedAt !== 'number' || !Number.isSafeInteger(doc.consumedAt) || doc.consumedAt < 0) {
      throw new CutoverRefusedError('consumedAt must be a non-negative integer timestamp');
    }
  } else if (typeof doc.used !== 'boolean') {
    throw new CutoverRefusedError('Auth code used flag must be boolean');
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
  readonly subjectRefsGroup?: string;
}): void {
  const { db, binding, inventoryDigest, writes, subjectRefsGroup } = input;
  const observation = requireObservation(db, 'preparation', binding);
  if (subjectRefsGroup !== undefined) {
    // The bound descriptor's runtime query needs the subjectRefs field, required in this group,
    // with a collection array-contains index. Refuse unless the observation shows both.
    const fresh = observation.coverage.get(subjectRefsGroup);
    const field = fresh?.effectiveFields.find((entry) => entry.fieldPath === 'subjectRefs');
    const requiredSubjectRefs = (observation.requiredFields[subjectRefsGroup] ?? []).includes('subjectRefs');
    const arrayContains = field?.indexes.some((index) => canonicalJson(index) === canonicalJson({ queryScope: 'COLLECTION', arrayConfig: 'CONTAINS' })) ?? false;
    if (!fresh || !field || !requiredSubjectRefs || !arrayContains) {
      throw new CutoverRefusedError('Subject reference index is not covered by the fresh observation');
    }
  }
  if (observation.sourceInventoryDigest !== inventoryDigest) {
    throw new CutoverRefusedError('Source inventory digest differs from the observed inventory');
  }
  const schema = binding.indexSchema as { policy: SignedIndexPolicy; provenance: { databaseResource: string } };
  if (subjectRefsGroup !== undefined) {
    // N3: the observed subjectRefs must also resolve to the signed root, not only show a CONTAINS entry.
    const fresh = observation.coverage.get(subjectRefsGroup);
    if (!fresh) throw new CutoverRefusedError('Subject reference index is not covered by the fresh observation');
    assertConcreteCoverage({
      policy: schema.policy,
      databaseResource: schema.provenance.databaseResource,
      collectionGroup: subjectRefsGroup,
      paths: new Map([['subjectRefs', 1]]),
      fresh,
    });
  }
  for (const write of writes) {
    assertDocumentBudget({
      document: write.document,
      policy: schema.policy,
      databaseResource: schema.provenance.databaseResource,
      collectionGroup: write.group,
    });
    assertTtlSchema(schema.policy, write.group, write.document);
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
