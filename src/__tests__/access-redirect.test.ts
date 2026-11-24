import { describe, expect, it } from 'vitest';
import { buildRedirectMatcher, isValidPlatformEntry, parsePlatformEntry } from '../access/redirect.js';

/** A matcher over the given registry entries. Every entry must be valid, or the test setup is wrong. */
function matcher(...entries: string[]) {
  return buildRedirectMatcher(
    entries.map((entry) => {
      const parsed = parsePlatformEntry(entry);
      if (parsed === undefined) throw new Error(`test setup: ${JSON.stringify(entry)} is not a valid platform entry`);
      return parsed;
    }),
  );
}

const CALLBACK = 'https://ai.example.com/oauth/callback';

describe('https platform entries', () => {
  const cases: Array<[string, string, boolean]> = [
    [CALLBACK, CALLBACK, true],
    [CALLBACK, `${CALLBACK}/`, true],
    [`${CALLBACK}/`, CALLBACK, true],
    [CALLBACK, 'https://AI.Example.COM/oauth/callback', true],
    [CALLBACK, 'https://ai.example.com:443/oauth/callback', true],
    [CALLBACK, 'https://ai.example.com:8443/oauth/callback', false],
    [CALLBACK, 'https://ai.example.com/oauth/callback2', false],
    [CALLBACK, 'https://ai.example.com/oauth', false],
    [CALLBACK, 'https://evil.example.com/oauth/callback', false],
    [CALLBACK, 'https://sub.ai.example.com/oauth/callback', false],
    [CALLBACK, 'http://ai.example.com/oauth/callback', false],
    [CALLBACK, `${CALLBACK}?code=1`, true],
    [CALLBACK, `${CALLBACK}#fragment`, false],
    [CALLBACK, `${CALLBACK}#`, false],
    [CALLBACK, 'https://user@ai.example.com/oauth/callback', false],
    [CALLBACK, 'https://user:secret@ai.example.com/oauth/callback', false],
    [CALLBACK, 'https://@ai.example.com/oauth/callback', false],
    [CALLBACK, `${CALLBACK}\n`, false],
    [CALLBACK, 'https://ai.example.com/oauth /callback', false],
    [CALLBACK, 'https:\\\\ai.example.com\\oauth\\callback', false],
    [CALLBACK, '/oauth/callback', false],
    [CALLBACK, '', false],
    [CALLBACK, 'not a uri', false],
    [CALLBACK, 'javascript:alert(1)', false],
    ['https://ai.example.com', 'https://ai.example.com/', true],
    ['https://ai.example.com', 'https://ai.example.com/anything', false],
  ];

  for (const [entry, candidate, expected] of cases) {
    it(`entry ${entry} ${expected ? 'accepts' : 'refuses'} ${JSON.stringify(candidate)}`, () => {
      expect(matcher(entry).allows(candidate)).toBe(expected);
    });
  }
});

describe('loopback', () => {
  it('accepts http and https on the loopback hosts, on any port and path, when listed', () => {
    const loopback = matcher('loopback');
    expect(loopback.allows('http://127.0.0.1:53682/callback')).toBe(true);
    expect(loopback.allows('http://localhost/cb')).toBe(true);
    expect(loopback.allows('https://localhost:9999/')).toBe(true);
    expect(loopback.allows('http://[::1]:8080/x/y')).toBe(true);
  });

  it('refuses other hosts, other schemes, userinfo and fragments even on a loopback address', () => {
    const loopback = matcher('loopback');
    expect(loopback.allows('http://127.0.0.2/cb')).toBe(false);
    expect(loopback.allows('http://evil.example/cb')).toBe(false);
    expect(loopback.allows('ftp://localhost/cb')).toBe(false);
    expect(loopback.allows('http://user@localhost/cb')).toBe(false);
    expect(loopback.allows('http://localhost/cb#f')).toBe(false);
  });

  it('refuses loopback when the registry does not list it', () => {
    expect(matcher(CALLBACK).allows('http://127.0.0.1:1/cb')).toBe(false);
  });
});

describe('star', () => {
  it('accepts any valid URI, including a custom scheme', () => {
    const any = matcher('*');
    expect(any.allows('https://anything.example/cb')).toBe(true);
    expect(any.allows('myapp://callback')).toBe(true);
    expect(any.allows('http://localhost:1/x')).toBe(true);
  });

  it('still refuses what is not a valid URI, userinfo, a fragment or a raw forbidden character', () => {
    const any = matcher('*');
    expect(any.allows('not a uri')).toBe(false);
    expect(any.allows('https://user@anything.example/cb')).toBe(false);
    expect(any.allows('https://anything.example/cb#f')).toBe(false);
    expect(any.allows('https://anything.example/a\\b')).toBe(false);
  });
});

describe('platform entry forms', () => {
  it('parses the three forms', () => {
    expect(parsePlatformEntry('loopback')).toEqual({ kind: 'loopback' });
    expect(parsePlatformEntry('*')).toEqual({ kind: 'any' });
    expect(parsePlatformEntry('https://AI.example.com/cb/')).toEqual({
      kind: 'https',
      host: 'ai.example.com',
      path: '/cb',
    });
  });

  it('refuses everything else', () => {
    const invalid = [
      'http://ai.example.com/cb',
      'https://u@ai.example.com/cb',
      'https://ai.example.com/cb#f',
      'https://ai.example.com/cb?x=1',
      'javascript:alert(1)',
      '',
      ' https://ai.example.com/cb',
      'https://ai.example.com/cb\n',
      'LOOPBACK',
      'loop back',
    ];
    for (const entry of invalid) {
      expect(isValidPlatformEntry(entry), JSON.stringify(entry)).toBe(false);
    }
    expect(isValidPlatformEntry(5 as unknown as string)).toBe(false);
  });
});
