import { describe, expect, it } from 'vitest';
import { redirectForLog } from '../auth/netsapiens-auth-provider.js';

/** The expression this function replaced. It is the oracle for ordinary input. */
function legacy(uri: string): string {
  return uri.replace(/[?#].*$/, '').replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1');
}

describe('redirectForLog', () => {
  it.each([
    'https://ai.example.com/oauth/callback',
    'https://ai.example.com/oauth/callback?code=abc&state=def',
    'https://ai.example.com/oauth/callback#fragment',
    'https://ai.example.com/cb?x=1#y',
    'https://user:secret@ai.example.com/cb',
    'https://user@ai.example.com/cb?token=abc',
    'HTTP://Host.Example.com:8443/path',
    'http://127.0.0.1:33418/callback',
    'custom-scheme+v1.0://app/callback',
    'https://ai.example.com',
    'https://ai.example.com/',
    'not a uri',
    '',
  ])('matches the expression it replaced on %j', (uri) => {
    expect(redirectForLog(uri)).toBe(legacy(uri));
  });

  it('removes everything before the last at sign in the authority, so userinfo containing an at sign cannot survive', () => {
    expect(redirectForLog('https://alice@evil@ai.example.com/cb')).toBe('https://ai.example.com/cb');
  });

  it('never keeps a query, a fragment or userinfo', () => {
    const out = redirectForLog('https://u:p@ai.example.com/a/b?c=d#e');
    expect(out).toBe('https://ai.example.com/a/b');
    expect(out).not.toMatch(/[?#@]/);
  });

  it('leaves a value with no scheme separator alone apart from the query and fragment', () => {
    expect(redirectForLog('ai.example.com/cb?x=1')).toBe('ai.example.com/cb');
  });

  it('finishes quickly on the repetitive inputs that make a backtracking pattern slow', () => {
    for (const unit of ['#', '?', '/', '@', ':', 'a']) {
      const input = `https://${unit.repeat(200_000)}`;
      const start = performance.now();
      redirectForLog(input);
      expect(performance.now() - start).toBeLessThan(250);
    }
  });
});
