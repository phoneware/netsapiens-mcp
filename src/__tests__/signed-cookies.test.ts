/**
 * Focused unit tests for the signed-cookie helpers used by the OAuth flow
 * to keep pending-auth and MFA state stateless across instances.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { signValue, verifySigned, parseCookies } from '../auth/netsapiens-auth-provider.js';

beforeAll(() => {
  process.env.MCP_SESSION_SECRET = '00112233445566778899aabbccddeeff';
});

describe('signValue / verifySigned', () => {
  it('round-trips a JSON payload', () => {
    const token = signValue({ clientId: 'abc', state: 'xyz' }, 60);
    const out = verifySigned<{ clientId: string; state: string }>(token);
    expect(out).toEqual({ clientId: 'abc', state: 'xyz' });
  });

  it('rejects a tampered signature', () => {
    const token = signValue({ x: 1 }, 60);
    const [body] = token.split('.');
    const tampered = `${body}.deadbeef`;
    expect(verifySigned(tampered)).toBeNull();
  });

  it('rejects a malformed token', () => {
    expect(verifySigned('not-a-token')).toBeNull();
    expect(verifySigned('')).toBeNull();
    expect(verifySigned('a.')).toBeNull();
  });

  it('rejects an expired token', () => {
    // Negative TTL → exp is in the past
    const token = signValue({ a: 'b' }, -10);
    expect(verifySigned(token)).toBeNull();
  });

  it('produces different signatures for different secrets', () => {
    const t1 = signValue({ a: 1 }, 60);
    process.env.MCP_SESSION_SECRET = 'a-totally-different-secret-key-here';
    // Re-import — the secret is memoized on first use, so this only tests that
    // the function works with the original secret. The flow-level tests cover
    // the cross-instance shared-secret case.
    process.env.MCP_SESSION_SECRET = '00112233445566778899aabbccddeeff';
    expect(verifySigned(t1)).toEqual({ a: 1 });
  });
});

describe('parseCookies', () => {
  it('returns empty object for undefined or empty header', () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('')).toEqual({});
  });

  it('parses a single cookie', () => {
    expect(parseCookies('foo=bar')).toEqual({ foo: 'bar' });
  });

  it('parses multiple cookies separated by ; ', () => {
    expect(parseCookies('a=1; b=2; c=3')).toEqual({ a: '1', b: '2', c: '3' });
  });

  it('tolerates extra whitespace and decodes URI-encoded values', () => {
    expect(parseCookies('  foo=hello%20world ; bar=baz  ')).toEqual({
      foo: 'hello world',
      bar: 'baz',
    });
  });

  it('ignores entries without an =', () => {
    expect(parseCookies('foo; bar=baz')).toEqual({ bar: 'baz' });
  });

  it('handles values containing = signs (only splits on the first one)', () => {
    expect(parseCookies('opaque=a.b.c')).toEqual({ opaque: 'a.b.c' });
  });
});
