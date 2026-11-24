import { describe, expect, it } from 'vitest';
import {
  AccessIdentityError,
  normalizeIdentity,
  normalizeTenant,
  normalizeUser,
  subjectOf,
} from '../access/identity.js';

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof AccessIdentityError ? error.code : `unexpected: ${String(error)}`;
  }
}

describe('tenant and user normalization', () => {
  it.each([
    ['  Practice.Example ', 'practice.example'],
    ['practice.example', 'practice.example'],
    ['PRACTICE', 'practice'],
  ])('tenant %j normalizes to %j', (raw, expected) => {
    expect(normalizeTenant(raw)).toBe(expected);
  });

  it.each([
    ['  Alice.Smith ', 'alice.smith'],
    ['1001', '1001'],
    ['ALICE', 'alice'],
  ])('user %j normalizes to %j', (raw, expected) => {
    expect(normalizeUser(raw)).toBe(expected);
  });

  it('builds the subject as user@tenant', () => {
    expect(subjectOf('alice', 'practice.example')).toBe('alice@practice.example');
  });

  it('refuses an empty or blank tenant and user', () => {
    expect(codeOf(() => normalizeTenant(''))).toBe('empty_tenant');
    expect(codeOf(() => normalizeTenant('   '))).toBe('empty_tenant');
    expect(codeOf(() => normalizeUser(''))).toBe('empty_user');
    expect(codeOf(() => normalizeUser('   '))).toBe('empty_user');
  });

  it('refuses an embedded "@" in a user', () => {
    expect(codeOf(() => normalizeUser('alice@practice.example'))).toBe('invalid_user');
  });

  it('refuses whitespace inside a user', () => {
    expect(codeOf(() => normalizeUser('alice smith'))).toBe('invalid_user');
    expect(codeOf(() => normalizeUser('alice\tsmith'))).toBe('invalid_user');
  });

  it('refuses control characters in a user', () => {
    expect(codeOf(() => normalizeUser('alice\u0000'))).toBe('invalid_user');
  });

  it('refuses an embedded "@" or whitespace in a tenant', () => {
    expect(codeOf(() => normalizeTenant('a@b'))).toBe('invalid_tenant');
    expect(codeOf(() => normalizeTenant('practice example'))).toBe('invalid_tenant');
  });
});

describe('identity normalization', () => {
  it('derives the platform origin, the tenant, the user, the subject, the scope and the tier', () => {
    expect(
      normalizeIdentity({
        nsApiUrl: 'https://PBX.Example.com:443/ns-api/v2',
        domain: ' Practice.Example ',
        user: ' Alice ',
        scope: 'Office Manager',
      }),
    ).toEqual({
      platform: 'https://pbx.example.com',
      tenant: 'practice.example',
      user: 'alice',
      subject: 'alice@practice.example',
      role: 'Office Manager',
      tier: 'domain_admin',
    });
  });

  it('gives an unknown scope an empty role and the user tier', () => {
    expect(
      normalizeIdentity({ nsApiUrl: 'https://pbx.example.com', domain: 'practice.example', user: 'alice' }),
    ).toMatchObject({ role: '', tier: 'user' });
    expect(
      normalizeIdentity({ nsApiUrl: 'https://pbx.example.com', domain: 'practice.example', user: 'alice', scope: null }),
    ).toMatchObject({ role: '', tier: 'user' });
  });

  it('maps a super user scope to the system tier and keeps the scope string as returned', () => {
    expect(
      normalizeIdentity({
        nsApiUrl: 'https://pbx.example.com',
        domain: 'practice.example',
        user: 'root',
        scope: 'Super User',
      }),
    ).toMatchObject({ role: 'Super User', tier: 'system_admin' });
  });

  it('gives mixed-case input exactly the identity of its lowercase form', () => {
    const mixed = normalizeIdentity({
      nsApiUrl: 'https://PBX.Example.COM/',
      domain: 'Practice.Example',
      user: 'Alice.Smith',
      scope: 'Office Manager',
    });
    const lower = normalizeIdentity({
      nsApiUrl: 'https://pbx.example.com/',
      domain: 'practice.example',
      user: 'alice.smith',
      scope: 'Office Manager',
    });
    expect(mixed).toEqual(lower);
    expect(mixed.subject).toBe('alice.smith@practice.example');
  });

  it('refuses a NetSapiens URL that is not an http(s) origin', () => {
    expect(
      codeOf(() => normalizeIdentity({ nsApiUrl: 'ftp://pbx.example.com', domain: 'practice.example', user: 'alice' })),
    ).toBe('invalid_platform');
    expect(codeOf(() => normalizeIdentity({ nsApiUrl: '', domain: 'practice.example', user: 'alice' }))).toBe(
      'invalid_platform',
    );
  });

  it('refuses an identity whose user or tenant cannot be keyed', () => {
    expect(
      codeOf(() => normalizeIdentity({ nsApiUrl: 'https://pbx.example.com', domain: 'practice.example', user: 'a@b' })),
    ).toBe('invalid_user');
    expect(
      codeOf(() => normalizeIdentity({ nsApiUrl: 'https://pbx.example.com', domain: '', user: 'alice' })),
    ).toBe('empty_tenant');
  });
});

describe('names outside printable ASCII are refused, never normalized', () => {
  // Each of these trims or lowercases onto a different name, or looks like an ASCII name it is not.
  const OUTSIDE_PRINTABLE_ASCII: Array<[string, string]> = [
    ['\u212Aexample', 'Kelvin sign, which lowercases to k'],
    ['\u00A0acme', 'no break space'],
    ['\uFEFFacme', 'byte order mark'],
    ['acme\u3000', 'ideographic space'],
    ['acme\u2028', 'line separator'],
    ['\uFF41\uFF43\uFF4D\uFF45', 'fullwidth letters'],
    ['ac\u200Bme', 'zero width space'],
    ['stra\u1E9Ee', 'capital sharp s'],
  ];

  it.each(OUTSIDE_PRINTABLE_ASCII)('refuses the tenant %j (%s)', (raw) => {
    expect(codeOf(() => normalizeTenant(raw))).toBe('invalid_tenant');
  });

  it.each(OUTSIDE_PRINTABLE_ASCII)('refuses the user %j (%s)', (raw) => {
    expect(codeOf(() => normalizeUser(raw))).toBe('invalid_user');
  });

  it('trims ASCII space and tab at both ends, and only those', () => {
    expect(normalizeTenant(' \tPractice.Example\t ')).toBe('practice.example');
    expect(normalizeUser('\t alice \t')).toBe('alice');
  });

  it.each(['ac me', 'ac\tme', 'ac\u0001me', 'ac\u007Fme', 'ac\nme'])(
    'refuses %j, which has a blank or control character inside it',
    (raw) => {
      expect(codeOf(() => normalizeTenant(raw))).toBe('invalid_tenant');
      expect(codeOf(() => normalizeUser(raw))).toBe('invalid_user');
    },
  );

  it('accepts every printable ASCII character except the at sign, and lowercases only letters', () => {
    let text = '';
    for (let code = 0x21; code <= 0x7e; code++) {
      if (code !== 0x40) text += String.fromCharCode(code);
    }
    expect(normalizeTenant(text)).toBe(text.toLowerCase());
    expect(normalizeUser(text)).toBe(text.toLowerCase());
  });

  it('keeps the raw name out of the error message', () => {
    let message = '';
    try {
      normalizeTenant('ac\nSECRET@example');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('SECRET');
    expect(message).not.toContain('\n');
  });
});
