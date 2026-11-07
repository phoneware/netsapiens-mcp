import { describe, expect, it } from 'vitest';
import { hkdfSync } from 'node:crypto';
import { createCodec, deriveStoreKey, StoreConfigError } from '../codec.js';

describe('store codec', () => {
  it('derives the specified root and rejects short secrets', () => {
    expect(() => deriveStoreKey('short')).toThrow(StoreConfigError);
    const secret = 'x'.repeat(32);
    expect(deriveStoreKey(secret)).toEqual(Buffer.from(hkdfSync('sha256', secret, 'netsapiens-mcp/store/v1', 'root', 32)));
  });
  it('separates identifiers and authenticates ciphertext and associated data', () => {
    const codec = createCodec(deriveStoreKey('x'.repeat(32)));
    expect(codec.id('session', 'token')).not.toBe(codec.id('refresh', 'token'));
    expect(codec.id('session', 'token')).toMatch(/^[a-f0-9]{64}$/);
    const a = codec.seal({ value: 'private' }, 'session:a');
    expect(a).not.toBe(codec.seal({ value: 'private' }, 'session:a'));
    expect(codec.open(a, 'session:a')).toEqual({ value: 'private' });
    expect(codec.open(a, 'session:b')).toBeUndefined();
    expect(codec.open('invalid', 'session:a')).toBeUndefined();
    expect(createCodec(deriveStoreKey('y'.repeat(32))).open(a, 'session:a')).toBeUndefined();
  });
});
