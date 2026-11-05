import { describe, expect, it } from 'vitest';
import { assertTtlHold, TTL_HOLD_WINDOW_MS } from '../fresh-index-observation.js';
import type { SignedIndexPolicy } from '../index-coverage.js';

// Boundary checks for the TTL hold. Preparation runs the same check for every
// prospective document; these tests pin the rule itself.

const policy = {
  default: { source: 'default', indexes: [] },
  collections: [{
    collectionGroup: 'sessions',
    overrides: [],
    composites: [],
    ttl: [{ fieldPath: 'ttlAt', state: 'ACTIVE' }],
  }],
} as unknown as SignedIndexPolicy;

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);

describe('TTL hold', () => {
  it('refuses a document whose TTL timestamp falls inside the hold window', () => {
    expect(() => assertTtlHold(policy, 'sessions', { ttlAt: new Date(NOW + TTL_HOLD_WINDOW_MS - 1) }, NOW))
      .toThrow(/could expire under TTL/);
    expect(() => assertTtlHold(policy, 'sessions', { ttlAt: new Date(NOW - 1000) }, NOW))
      .toThrow(/could expire under TTL/);
  });

  it('accepts a document whose TTL timestamp is beyond the hold window', () => {
    expect(() => assertTtlHold(policy, 'sessions', { ttlAt: new Date(NOW + TTL_HOLD_WINDOW_MS + 1) }, NOW)).not.toThrow();
  });

  it('accepts a document without the TTL field, and accepts Firestore-style timestamps', () => {
    expect(() => assertTtlHold(policy, 'sessions', {}, NOW)).not.toThrow();
    expect(() => assertTtlHold(policy, 'sessions', { ttlAt: { toMillis: () => NOW + 3 * TTL_HOLD_WINDOW_MS } }, NOW)).not.toThrow();
  });

  it('refuses a TTL value that is not a timestamp', () => {
    expect(() => assertTtlHold(policy, 'sessions', { ttlAt: 'soon' }, NOW)).toThrow(/not a timestamp/);
  });

  it('refuses a signed TTL entry that is not ACTIVE', () => {
    const bad = {
      ...policy,
      collections: [{ ...policy.collections[0], ttl: [{ fieldPath: 'ttlAt', state: 'CREATING' }] }],
    } as unknown as SignedIndexPolicy;
    expect(() => assertTtlHold(bad, 'sessions', { ttlAt: new Date(NOW + 10 * TTL_HOLD_WINDOW_MS) }, NOW))
      .toThrow(/malformed/);
  });
});
