import type { Options } from 'express-rate-limit';
import type { ErrorRequestHandler } from 'express';
import type { McpStore } from '../store/types.js';
import { logger } from '../utils/logger.js';

export const SIGNIN_RATE_LIMIT = Object.freeze({ limit: 10, windowMs: 60_000 });
export const RATE_LIMIT_MESSAGE = { error: 'Too many requests, please try again later' };

export function createSigninRateLimitOptions(store: McpStore): Partial<Options> {
  if (typeof store.rateLimits?.hit !== 'function') throw new Error('ConfigError: the store does not implement rateLimits.hit');
  return {
    ...SIGNIN_RATE_LIMIT,
    standardHeaders: true,
    legacyHeaders: false,
    message: RATE_LIMIT_MESSAGE,
    passOnStoreError: false,
    store: {
      localKeys: false,
      prefix: 'signin:',
      async increment(key) {
        try {
          const result = await store.rateLimits.hit('signin', key, SIGNIN_RATE_LIMIT);
          if (!result || !Number.isSafeInteger(result.totalHits) || result.totalHits < 1 ||
              result.totalHits > SIGNIN_RATE_LIMIT.limit + 1 ||
              !Number.isSafeInteger(result.resetAt) || result.resetAt <= Date.now() ||
              !Number.isFinite(new Date(result.resetAt).getTime())) {
            throw new Error('Invalid rate limit decision');
          }
          return { totalHits: result.totalHits, resetTime: new Date(result.resetAt) };
        } catch {
          throw new Error('Sign-in rate limit unavailable');
        }
      },
      async decrement() { throw new Error('Unsupported rate limit decrement'); },
      async resetKey() { throw new Error('Unsupported rate limit reset'); },
    },
  };
}

export const signinLimitError: ErrorRequestHandler = (err, _req, res, _next) => {
  logger.warn('Sign-in rate limit unavailable', { reason: err instanceof Error ? err.name : 'unknown' });
  if (res.headersSent) { res.end(); return; }
  res.set('Retry-After', '5').status(503).json({ error: 'temporarily_unavailable', error_description: 'Service temporarily unavailable, please retry' });
};
