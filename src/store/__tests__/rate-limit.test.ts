import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createRateLimitId, nextRateLimitWindow } from '../rate-limit.js';
import { createMemoryBackend } from '../memory.js';
import { StoreUnavailableError } from '../errors.js';

const params = { id: 'a'.repeat(64), now: 100_000, limit: 3, windowMs: 60_000 };

describe('rate limit windows', () => {
  it('increments atomically, resets expired windows and never writes refusals', () => {
    const first = nextRateLimitWindow(undefined, params);
    expect(first).toEqual({ result: { count: 1, windowEndsAt: 160_000 }, write: { count: 1, windowEndsAt: 160_000 }, fresh: true });
    expect(nextRateLimitWindow(first.result, params).result.count).toBe(2);
    expect(nextRateLimitWindow({ count: 3, windowEndsAt: 160_000 }, params)).toEqual({ result: { count: 4, windowEndsAt: 160_000 }, write: null, fresh: false });
    expect(nextRateLimitWindow({ count: 3, windowEndsAt: 100_000 }, params).result.count).toBe(1);
    expect(nextRateLimitWindow({ count: 3, windowEndsAt: 220_001 }, params).result.count).toBe(1);
  });
  it('rejects malformed rows and invalid parameters', () => {
    expect(() => nextRateLimitWindow({ count: 0, windowEndsAt: 160_000 }, params)).toThrow(StoreUnavailableError);
    expect(() => nextRateLimitWindow({ count: 1, windowEndsAt: NaN }, params)).toThrow(StoreUnavailableError);
    for (const invalid of [{ limit: 0 }, { limit: 1_000_001 }, { windowMs: 999 }, { windowMs: 86_400_001 }, { now: NaN }, { id: 'x' }]) {
      expect(() => nextRateLimitWindow(undefined, { ...params, ...invalid })).toThrow(RangeError);
    }
  });
  it('uses keyed, domain-separated, non-plaintext identifiers', () => {
    const root = randomBytes(32);
    const id = createRateLimitId(root);
    expect(id('signin', '198.51.100.1')).toMatch(/^[a-f0-9]{64}$/);
    expect(id('signin', '198.51.100.1')).not.toBe(id('signin', '198.51.100.2'));
    expect(id('signin', '198.51.100.1')).not.toBe(createRateLimitId(randomBytes(32))('signin', '198.51.100.1'));
  });
  it('evicts expired in-memory windows and sweeps remaining rows', async () => {
    const backend = createMemoryBackend();
    await backend.hitRateLimit(params);
    await backend.hitRateLimit({ ...params, id: 'b'.repeat(64), now: 160_000 });
    expect(backend.state.rateLimits.has(params.id)).toBe(false);
    expect(await backend.sweep(220_000)).toBe(1);
  });
});
