import { describe, expect, it } from 'vitest';
import { assertTtlSchema } from '../fresh-index-observation.js';
import type { SignedIndexPolicy } from '../index-coverage.js';

// TTL schema for prospective targets. The stored expiry fields are the source of
// truth and are never recomputed, extended or rewritten. No time window applies:
// a short-lived auth code is valid for the migration exactly as it is stored.

const ttlGroup = (name: string) => ({ collectionGroup: name, overrides: [], composites: [], ttl: [{ fieldPath: 'ttlAt', state: 'ACTIVE' }] });
const policy = {
  default: { source: 'default', indexes: [] },
  collections: [
    ttlGroup('mcp_sessions'),
    ttlGroup('mcp_auth_codes'),
    ttlGroup('mcp_resume_tokens'),
    { collectionGroup: 'mcp_tokens_refresh', overrides: [], composites: [], ttl: [] },
  ],
} as unknown as SignedIndexPolicy;

const at = 1_800_000_000_000;
const session = { expiresAt: at, retainUntil: at + 30 * 24 * 3600_000, ttlAt: new Date(at + 30 * 24 * 3600_000) };

describe('TTL schema for prospective targets', () => {
  it('accepts a session whose ttlAt equals its stored retainUntil, however soon it expires', () => {
    expect(() => assertTtlSchema(policy, 'mcp_sessions', session)).not.toThrow();
    const shortLived = { expiresAt: at, retainUntil: at, ttlAt: new Date(at) };
    expect(() => assertTtlSchema(policy, 'mcp_sessions', shortLived)).not.toThrow();
  });

  it('refuses a session whose ttlAt differs from retainUntil, rather than rewriting it', () => {
    expect(() => assertTtlSchema(policy, 'mcp_sessions', { ...session, ttlAt: new Date(at + 1) }))
      .toThrow(/ttlAt must equal retainUntil/);
  });

  it('accepts a short-lived auth code and resume token exactly as stored', () => {
    const code = { id: 'c', expiresAt: at + 5 * 60_000, used: false, sealed: 's', ttlAt: new Date(at + 5 * 60_000) };
    expect(() => assertTtlSchema(policy, 'mcp_auth_codes', code)).not.toThrow();
    const resume = { id: 'r', consumedAt: at, expiresAt: at + 2 * 3600_000, ttlAt: new Date(at + 2 * 3600_000) };
    expect(() => assertTtlSchema(policy, 'mcp_resume_tokens', resume)).not.toThrow();
  });

  it('refuses a resume token without a stored consumedAt, and an auth code without a boolean used flag', () => {
    expect(() => assertTtlSchema(policy, 'mcp_resume_tokens', { expiresAt: at, ttlAt: new Date(at) })).toThrow(/consumedAt/);
    expect(() => assertTtlSchema(policy, 'mcp_auth_codes', { expiresAt: at, ttlAt: new Date(at) })).toThrow(/used flag/);
  });

  it('refuses a non-timestamp ttlAt and a retainUntil earlier than expiresAt', () => {
    expect(() => assertTtlSchema(policy, 'mcp_sessions', { ...session, ttlAt: 'soon' })).toThrow(/valid timestamp/);
    expect(() => assertTtlSchema(policy, 'mcp_sessions', { ...session, retainUntil: at - 1, ttlAt: new Date(at - 1) }))
      .toThrow(/positive integer|at least expiresAt/);
  });

  it('refuses ttlAt on a group without a TTL rule, and a TTL policy on such a group', () => {
    expect(() => assertTtlSchema(policy, 'mcp_tokens_refresh', { ttlAt: new Date(at) })).toThrow(/without a TTL rule/);
    expect(() => assertTtlSchema(policy, 'mcp_tokens_refresh', {})).not.toThrow();
  });

  it('refuses a signed TTL entry that is not ACTIVE on ttlAt', () => {
    const bad = {
      ...policy,
      collections: [{ ...ttlGroup('mcp_sessions'), ttl: [{ fieldPath: 'ttlAt', state: 'CREATING' }] }],
    } as unknown as SignedIndexPolicy;
    expect(() => assertTtlSchema(bad, 'mcp_sessions', session)).toThrow(/malformed|not on ttlAt/);
  });
});
