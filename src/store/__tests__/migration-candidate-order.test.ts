import { describe, expect, it } from 'vitest';
import { extractCandidatesAndPlan } from '../firestore-migration-engine.js';
import {
  H,
  computeKeyedDocId,
  validateCompleteMigrationPlanForIdentity,
  type CompleteMigrationPlan,
  type MigrationIdentityExpectation,
} from '../../cutover/canonical-core.mjs';

// These are synthetic snapshots, not Firestore handles. The fixed identity and clock
// keep the inventory and plan digests comparable across independent extractions.
const key = Buffer.alloc(32, 7);
const now = 1_700_000_000_000;
const identity: MigrationIdentityExpectation = {
  namespace: 'mcp',
  epoch: 1,
  migrationRunId: 'synthetic-order-run',
  codeSha: 'a'.repeat(40),
  codeArtifact: 'synthetic-artifact',
  packageIntegrity: `sha512-${Buffer.alloc(64, 3).toString('base64')}`,
  protocolDigest: 'b'.repeat(64),
  assemblyDigest: 'c'.repeat(64),
  indexSchemaDigest: 'd'.repeat(64),
  encoderVersion: 1 as const,
};

type Snapshot = { id: string; data: () => Record<string, unknown> };
type Inventory = Map<string, Snapshot[]>;
type Kind = 'pr56Families' | 'baseFormatTokens' | 'authCodes' | 'resumeTokens' | 'clients';

type Fixture = { kind: Kind; inventory: Inventory; candidateId: string };
const snapshot = (id: string, value: Record<string, unknown>): Snapshot => ({ id, data: () => value });

function fixture(kind: Kind, n: number): Fixture {
  const id = `${kind}-${n}`;
  const inventory: Inventory = new Map();
  const add = (collection: string, docId: string, value: Record<string, unknown>) => {
    const docs = inventory.get(collection) ?? [];
    docs.push(snapshot(docId, value));
    inventory.set(collection, docs);
  };
  switch (kind) {
    case 'pr56Families': {
      const access = `access-${n}`;
      const refresh = `refresh-${n}`;
      add('families', id, { currentAccessToken: access, currentRefreshToken: refresh });
      add('tokens', access, { accessToken: access, refreshToken: refresh, familyId: id, clientId: 'synthetic-client', expiresAt: now + 60_000 });
      add('refresh', refresh, { refreshToken: refresh, accessToken: access, familyId: id, status: 'active' });
      add('upstream', id, { nsAccessToken: 'synthetic-upstream', nsUsername: 'user@example.test' });
      break;
    }
    case 'baseFormatTokens':
      add('tokens', id, { accessToken: id, refreshToken: `base-refresh-${n}`, clientId: 'synthetic-client', expiresAt: now + 60_000, nsAccessToken: 'synthetic-upstream', nsRefreshToken: 'synthetic-upstream-refresh', nsUsername: 'user@example.test' });
      break;
    case 'authCodes':
      add('authCodes', id, { pending: { clientId: 'synthetic-client', codeChallenge: 'synthetic-challenge', redirectUri: 'https://example.test/callback', createdAt: now }, nsTokens: { access_token: 'synthetic-upstream' }, expiresAt: now + 60_000 });
      break;
    case 'resumeTokens':
      add('resumeTokens', id, { consumedAt: now, expiresAt: now + 60_000 });
      break;
    case 'clients':
      add('clients', id, { client_id: id, redirect_uris: ['https://example.test/callback'], token_endpoint_auth_method: 'none' });
      break;
  }
  const sourceIds = [...inventory].flatMap(([collection, docs]) => docs.map((doc) =>
    computeKeyedDocId(key, 'source-id', identity.namespace, identity.epoch, collection, doc.id),
  )).sort();
  const candidateId = H(key, 'candidate-id', identity.namespace, identity.epoch, [kind, sourceIds]);
  return { kind, inventory, candidateId };
}

function combine(fixtures: Fixture[], reverse = false): Inventory {
  const result: Inventory = new Map();
  const entries = fixtures.flatMap(({ inventory }) => [...inventory.entries()]);
  for (const [collection, docs] of reverse ? entries.reverse() : entries) {
    result.set(collection, [...(result.get(collection) ?? []), ...(reverse ? [...docs].reverse() : docs)]);
  }
  return result;
}

function extract(inventory: Inventory) {
  return extractCandidatesAndPlan({
    sourceDocsByKey: inventory,
    storeKey: key,
    namespace: identity.namespace,
    epoch: identity.epoch,
    runId: identity.migrationRunId,
    codeSha: identity.codeSha,
    codeArtifact: identity.codeArtifact,
    packageIntegrity: identity.packageIntegrity,
    protocolDigest: identity.protocolDigest,
    assemblyDigest: identity.assemblyDigest,
    indexSchemaDigest: identity.indexSchemaDigest,
    subject: null,
    now,
  });
}

function validate(plan: CompleteMigrationPlan) {
  // No protected context, guard substitution, or repair of the returned plan.
  validateCompleteMigrationPlanForIdentity(plan, identity);
}

function checkPermutation(fixtures: Fixture[]) {
  const forward = extract(combine(fixtures));
  const reverse = extract(combine(fixtures, true));
  const expectedIds = fixtures.map((item) => item.candidateId).sort();
  for (const result of [forward, reverse]) {
    // Boolean comparisons keep failed assertions from printing commitments or plans.
    expect(JSON.stringify(result.candidates.map((candidate) => candidate.id)) === JSON.stringify(expectedIds)).toBe(true);
    validate(result.plan as CompleteMigrationPlan);
    expect(JSON.stringify(result.plan.prepared.candidateCommitments.map((candidate: { id: string }) => candidate.id)) === JSON.stringify(expectedIds)).toBe(true);
  }
  expect(JSON.stringify(forward.plan.prepared.candidateCommitments) === JSON.stringify(reverse.plan.prepared.candidateCommitments)).toBe(true);
  expect(forward.sourceInventoryDigest === reverse.sourceInventoryDigest).toBe(true);
  expect(forward.sourceLogicalDigest === reverse.sourceLogicalDigest).toBe(true);
  expect(forward.planDigest === reverse.planDigest).toBe(true);
}

describe('migration candidate ordering', () => {
  it('accepts an empty inventory', () => checkPermutation([]));
  it.each<Kind>(['pr56Families', 'baseFormatTokens', 'authCodes', 'resumeTokens', 'clients'])(
    'accepts one %s candidate', (kind) => checkPermutation([fixture(kind, 0)]),
  );

  it.each<Kind>(['pr56Families', 'baseFormatTokens', 'authCodes', 'resumeTokens'])(
    'accepts both input orders of two %s candidates', (kind) => {
      const candidates = [fixture(kind, 0), fixture(kind, 1)]
        .sort((a, b) => a.candidateId < b.candidateId ? -1 : 1);
      expect(candidates[0].candidateId < candidates[1].candidateId).toBe(true);
      checkPermutation(candidates);
    },
  );

  it('accepts clients whose raw-ID order reverses their keyed candidate-ID order', () => {
    const clients = Array.from({ length: 128 }, (_, n) => fixture('clients', n))
      .sort((a, b) => a.inventory.get('clients')![0].id < b.inventory.get('clients')![0].id ? -1 : 1);
    let pair: [Fixture, Fixture] | undefined;
    for (let i = 0; i < clients.length && !pair; i++) {
      for (let j = i + 1; j < clients.length; j++) {
        if (clients[i].candidateId > clients[j].candidateId) {
          pair = [clients[i], clients[j]];
          break;
        }
      }
    }
    if (!pair) throw new Error('Synthetic client IDs did not produce the requested inversion');
    expect(pair[0].inventory.get('clients')![0].id < pair[1].inventory.get('clients')![0].id).toBe(true);
    expect(pair[0].candidateId > pair[1].candidateId).toBe(true);
    checkPermutation(pair);
  });

  it('accepts all five kinds with inverted discovery order', () => {
    const families = Array.from({ length: 128 }, (_, n) => fixture('pr56Families', n))
      .sort((a, b) => a.candidateId < b.candidateId ? -1 : 1);
    const bases = Array.from({ length: 128 }, (_, n) => fixture('baseFormatTokens', n))
      .sort((a, b) => a.candidateId < b.candidateId ? -1 : 1);
    const candidates = [
      families[families.length - 1], bases[0], fixture('authCodes', 0),
      fixture('resumeTokens', 0), fixture('clients', 0),
    ];
    expect(candidates[0].candidateId > candidates[1].candidateId).toBe(true);
    checkPermutation(candidates);
  });

  it('rejects a reversed prepared commitment array under the unchanged validator', () => {
    const candidates = [fixture('resumeTokens', 0), fixture('resumeTokens', 1)]
      .sort((a, b) => a.candidateId < b.candidateId ? -1 : 1);
    expect(candidates[0].candidateId < candidates[1].candidateId).toBe(true);
    const result = extract(combine(candidates));
    validate(result.plan as CompleteMigrationPlan);
    const altered = {
      ...result.plan,
      prepared: {
        ...result.plan.prepared,
        candidateCommitments: [...result.plan.prepared.candidateCommitments].reverse(),
      },
    };
    expect(() => validate(altered as CompleteMigrationPlan))
      .toThrow('planSpec candidateId mismatch with prepared commitment id');
  });

  // Different kinds are discovered in fixed phases. Select real keyed IDs for
  // each direction; reversing the input map alone cannot invert those phases.
  const kinds: Kind[] = ['pr56Families', 'baseFormatTokens', 'authCodes', 'resumeTokens', 'clients'];
  for (let first = 0; first < kinds.length; first++) {
    for (let second = first + 1; second < kinds.length; second++) {
      const earlier = kinds[first];
      const later = kinds[second];
      for (const direction of ['ascending', 'descending'] as const) {
        it(`${earlier} plus ${later}: ${direction} discovery IDs and inventory permutations`, () => {
          const ordered = (kind: Kind) => Array.from({ length: 128 }, (_, n) => fixture(kind, n))
            .sort((left, right) => left.candidateId < right.candidateId ? -1 : left.candidateId > right.candidateId ? 1 : 0);
          const earlierCandidates = ordered(earlier);
          const laterCandidates = ordered(later);
          const a = direction === 'ascending' ? earlierCandidates[0] : earlierCandidates[earlierCandidates.length - 1];
          const b = direction === 'ascending' ? laterCandidates[laterCandidates.length - 1] : laterCandidates[0];
          expect(direction === 'ascending' ? a.candidateId < b.candidateId : a.candidateId > b.candidateId).toBe(true);
          checkPermutation([a, b]);
        });
      }
    }
  }
});
