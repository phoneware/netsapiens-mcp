import { describe, expect, it } from 'vitest';
import { recordFreshIndexObservation, type FreshIndexObservation } from '../fresh-index-observation.js';

// One observation per handle. A second record for the same handle is refused, so the observation the
// preparation gate checks is the only one that can be authoritative for that handle.

const DIGEST_A = 'a'.repeat(64);
const DIGEST_C = 'c'.repeat(64);
const RUN = `nsm-${'1'.repeat(40)}`;

function observation(): FreshIndexObservation {
  return {
    purpose: 'preparation',
    namespace: 'mcp',
    expectedEpoch: 2,
    migrationRunId: RUN,
    indexPolicyDigest: DIGEST_A,
    sourceInventoryDigest: DIGEST_A,
    requiredFields: {},
    coverage: new Map(),
    completedAtNs: process.hrtime.bigint(),
    accessTokenDigest: DIGEST_C,
  };
}

describe('fresh index observation per handle', () => {
  it('records one observation for a handle and refuses a second', () => {
    const db = {};
    recordFreshIndexObservation(db, observation());
    expect(() => recordFreshIndexObservation(db, observation())).toThrow('already recorded');
  });

  it('records independently for a different handle', () => {
    recordFreshIndexObservation({}, observation());
    expect(() => recordFreshIndexObservation({}, observation())).not.toThrow();
  });
});
