import { describe, expect, it } from 'vitest';
import {
  FRESH_INDEX_OBSERVATION_MAX_AGE_NS,
  isRecordedObservation,
  recordFreshIndexObservation,
  recordedPreparationObservation,
  type FreshIndexObservation,
} from '../fresh-index-observation.js';
import type { ProtectedBinding } from '../protected-binding.js';

// The recorded observation is identified by the module's single WeakMap. These tests prove that a copy,
// a fake, another handle's record, a stale record, or a second record cannot pass as the recorded one.

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const DIGEST_C = 'c'.repeat(64);
const RUN = `nsm-${'1'.repeat(40)}`;

function observation(overrides: Partial<FreshIndexObservation> = {}): FreshIndexObservation {
  return {
    purpose: 'preparation',
    namespace: 'mcp',
    expectedEpoch: 2,
    migrationRunId: RUN,
    indexPolicyDigest: DIGEST_A,
    sourceInventoryDigest: DIGEST_B,
    requiredFields: {},
    coverage: new Map(),
    completedAtNs: process.hrtime.bigint(),
    accessTokenDigest: DIGEST_C,
    ...overrides,
  };
}

const binding = {
  namespace: 'mcp',
  expectedEpoch: 2,
  migrationRunId: RUN,
  indexPolicyDigest: DIGEST_A,
  adminTokenDigest: DIGEST_C,
} as unknown as ProtectedBinding;

describe('isRecordedObservation identity', () => {
  it('accepts the exact object recorded for the handle', () => {
    const db = {};
    const recorded = observation();
    recordFreshIndexObservation(db, recorded);
    expect(isRecordedObservation(db, recorded)).toBe(true);
  });

  it('rejects a structurally identical copy of the recorded object', () => {
    const db = {};
    const recorded = observation();
    recordFreshIndexObservation(db, recorded);
    expect(isRecordedObservation(db, { ...recorded })).toBe(false);
  });

  it('rejects a fake that carries the right fields but was never recorded', () => {
    const db = {};
    recordFreshIndexObservation(db, observation());
    expect(isRecordedObservation(db, observation())).toBe(false);
  });

  it('rejects the recorded object when presented for another handle', () => {
    const db = {};
    const other = {};
    const recorded = observation();
    recordFreshIndexObservation(db, recorded);
    expect(isRecordedObservation(other, recorded)).toBe(false);
  });

  it('rejects undefined, and any object for a handle with no record', () => {
    const db = {};
    expect(isRecordedObservation(db, undefined)).toBe(false);
    expect(isRecordedObservation(db, observation())).toBe(false);
  });

  it('rejects a stale record even when it is the recorded object', () => {
    const db = {};
    const stale = observation({ completedAtNs: process.hrtime.bigint() - FRESH_INDEX_OBSERVATION_MAX_AGE_NS - 1n });
    recordFreshIndexObservation(db, stale);
    expect(isRecordedObservation(db, stale)).toBe(false);
  });

  it('refuses a second record for the same handle, so one observation is ever authoritative', () => {
    const db = {};
    const first = observation();
    recordFreshIndexObservation(db, first);
    expect(() => recordFreshIndexObservation(db, observation())).toThrow('already recorded');
    expect(isRecordedObservation(db, first)).toBe(true);
  });
});

describe('recordedPreparationObservation getter', () => {
  it('returns the stored reference, so the identity check holds for what the seam receives', () => {
    const db = {};
    const recorded = observation();
    recordFreshIndexObservation(db, recorded);
    const received = recordedPreparationObservation(db, binding);
    expect(received).toBe(recorded);
    expect(isRecordedObservation(db, received)).toBe(true);
  });

  it('refuses a binding that does not match the recorded run, without observing again', () => {
    const db = {};
    recordFreshIndexObservation(db, observation());
    expect(() => recordedPreparationObservation(db, { ...binding, migrationRunId: `nsm-${'2'.repeat(40)}` } as ProtectedBinding))
      .toThrow('does not match the authenticated binding');
  });

  it('refuses when no observation was recorded for the handle', () => {
    expect(() => recordedPreparationObservation({}, binding)).toThrow('Fresh authenticated index observation is required');
  });
});
