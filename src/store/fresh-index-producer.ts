import { createHash } from 'node:crypto';
import { canonicalJson } from '../cutover/dsse-verifier-core.mjs';
import { projectIndexObservation, readFirestoreAdminIndexes } from '../cutover/index-policy-core.mjs';
import { CutoverRefusedError } from './errors.js';
import { recordFreshIndexObservation, type FreshIndexObservation } from './fresh-index-observation.js';
import type { FreshCollectionCoverage, SignedIndexPolicy } from './index-coverage.js';
import { assertCredentialUnchanged, getProtectedBinding } from './protected-binding.js';

// The fresh authenticated Admin producer. It reads the live index policy with
// the reviewed shared reader, projects it with the reviewed projection, and
// records the observation for the one handle it was given. It reads with the
// exact token the STS exchange produced for that handle (same-token), and it
// refuses unless the live effective policy digests to the signed policy.

const DEFAULT_DATABASE_RESOURCE = /^projects\/([a-z][a-z0-9-]{4,61}[a-z0-9])\/databases\/\(default\)$/;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export async function observeFreshIndexes(input: {
  readonly db: object;
  readonly purpose: FreshIndexObservation['purpose'];
  // Fields each collection group must cover beyond the signed policy. Groups
  // with no extra fields pass an empty list. Every group in the signed policy
  // must appear in the signed policy; unknown names refuse.
  readonly requiredFields: Readonly<Record<string, readonly string[]>>;
  readonly sourceInventoryDigest: string | null;
}): Promise<void> {
  const binding = getProtectedBinding(input.db);
  if (!binding) throw new CutoverRefusedError('Protected migration context required for a fresh index observation');
  assertCredentialUnchanged(input.db);

  const access = binding.adminAccess;
  if (!access || binding.adminTokenDigest === null) {
    throw new CutoverRefusedError('No Admin read token was authenticated for this handle');
  }
  const schema = binding.indexSchema as { policy: SignedIndexPolicy; provenance: { databaseResource: string } };
  const match = DEFAULT_DATABASE_RESOURCE.exec(schema.provenance.databaseResource);
  if (!match) throw new CutoverRefusedError('Index schema does not name a default database');

  // Same-token: the Admin read must use the exact token the exchange produced.
  const token = await access.getAccessToken();
  if (typeof token !== 'string' || !token) throw new CutoverRefusedError('Admin read token is not available');
  if (sha256Hex(token) !== binding.adminTokenDigest) {
    throw new CutoverRefusedError('Admin read token differs from the authenticated exchange token');
  }

  const groups = schema.policy.collections.map((entry) => entry.collectionGroup);
  for (const name of Object.keys(input.requiredFields)) {
    if (!groups.includes(name)) throw new CutoverRefusedError('Required field list names a group outside the signed policy');
  }
  const requiredFields: Record<string, string[]> = {};
  for (const group of groups) requiredFields[group] = [...(input.requiredFields[group] ?? [])];

  const raw = await readFirestoreAdminIndexes({
    project: match[1],
    database: '(default)',
    collectionGroups: groups,
    requiredFields,
    accessToken: token,
    fetchFn: access.fetchFn,
  });
  const projected = projectIndexObservation({
    databaseResource: schema.provenance.databaseResource,
    collectionGroups: groups,
    observation: raw,
  }) as { policy: unknown; coverage: ReadonlyArray<FreshCollectionCoverage & { requiredFields: readonly string[] }> };

  if (sha256Hex(canonicalJson(projected.policy)) !== binding.indexPolicyDigest) {
    throw new CutoverRefusedError('Fresh index policy differs from the signed index policy');
  }

  const coverage = new Map<string, FreshCollectionCoverage>();
  for (const entry of projected.coverage) {
    coverage.set(entry.collectionGroup, { collectionGroup: entry.collectionGroup, effectiveFields: entry.effectiveFields });
  }
  recordFreshIndexObservation(input.db, {
    purpose: input.purpose,
    namespace: binding.namespace,
    expectedEpoch: binding.expectedEpoch,
    migrationRunId: binding.migrationRunId,
    indexPolicyDigest: binding.indexPolicyDigest,
    sourceInventoryDigest: input.sourceInventoryDigest,
    requiredFields,
    coverage,
    completedAtNs: process.hrtime.bigint(),
    accessTokenDigest: binding.adminTokenDigest,
  });
}
