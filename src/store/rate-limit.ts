import { createHmac, hkdfSync } from 'node:crypto';
import { StoreUnavailableError } from './errors.js';
import type { RateLimitBucket, RateLimitHitParams, RateLimitWindow } from './types.js';

export function createRateLimitId(root: Uint8Array): (bucket: RateLimitBucket, clientKey: string) => string {
  const key = Buffer.from(hkdfSync('sha256', root, '', 'netsapiens-mcp/rate-limit/v1', 32));
  return (bucket, clientKey) => createHmac('sha256', key).update(bucket).update('\0').update(clientKey).digest('hex');
}

export function nextRateLimitWindow(stored: RateLimitWindow | undefined, params: RateLimitHitParams): { result: RateLimitWindow; write: RateLimitWindow | null; fresh: boolean } {
  const { now, limit, windowMs, id } = params;
  if (!/^[a-f0-9]{64}$/.test(id) || !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000_000 || !Number.isSafeInteger(windowMs) || windowMs < 1_000 || windowMs > 86_400_000 || !Number.isSafeInteger(now + windowMs)) throw new RangeError('Invalid rate limit parameters');
  if (stored && (!Number.isSafeInteger(stored.count) || stored.count < 1 || !Number.isSafeInteger(stored.windowEndsAt))) throw new StoreUnavailableError('Malformed rate limit record');
  if (!stored || stored.windowEndsAt <= now || stored.windowEndsAt - now > 2 * windowMs) {
    const result = { count: 1, windowEndsAt: now + windowMs };
    return { result, write: result, fresh: true };
  }
  if (stored.count >= limit) return { result: { count: limit + 1, windowEndsAt: stored.windowEndsAt }, write: null, fresh: false };
  const result = { count: stored.count + 1, windowEndsAt: stored.windowEndsAt };
  return { result, write: result, fresh: false };
}
