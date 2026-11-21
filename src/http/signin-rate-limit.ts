import rateLimit from 'express-rate-limit';
import type { RequestHandler } from 'express';
import type { McpStore } from '../store/types.js';
import { logger } from '../utils/logger.js';

export const SIGNIN_RATE_LIMIT = Object.freeze({ limit: 10, windowMs: 60_000 });
export const RATE_LIMIT_MESSAGE = { error: 'Too many requests, please try again later' };

export function createSigninRateLimit(store: McpStore): RequestHandler {
  if (typeof store.rateLimits?.hit !== 'function') throw new Error('ConfigError: the store does not implement rateLimits.hit');
  const limiter = rateLimit({
    ...SIGNIN_RATE_LIMIT,
    standardHeaders: true,
    legacyHeaders: false,
    message: RATE_LIMIT_MESSAGE,
    passOnStoreError: false,
    store: {
      localKeys: false,
      prefix: 'signin:',
      async increment(key) {
        const result = await store.rateLimits.hit('signin', key, SIGNIN_RATE_LIMIT);
        return { totalHits: result.totalHits, resetTime: new Date(result.resetAt) };
      },
      async decrement() { throw new Error('Unsupported rate limit decrement'); },
      async resetKey() { throw new Error('Unsupported rate limit reset'); },
    },
  });
  return (req, res, next) => {
    void limiter(req, res, (err?: unknown) => {
      if (!err) { next(); return; }
      logger.warn('Sign-in rate limit unavailable', { reason: err instanceof Error ? err.name : 'unknown' });
      if (res.headersSent) { res.end(); return; }
      res.set('Retry-After', '5').status(503).json({ error: 'temporarily_unavailable', error_description: 'Service temporarily unavailable, please retry' });
    });
  };
}
