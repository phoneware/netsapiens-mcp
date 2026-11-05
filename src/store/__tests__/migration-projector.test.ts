import { describe, expect, it } from 'vitest';
import { createCodec, deriveStoreKey } from '../codec.js';
import { projectSourceLogical } from '../netsapiens-projector.mjs';

const codec = createCodec(deriveStoreKey('test secret with at least thirty two characters'));
const candidate = { id: 'candidate', kind: 'baseFormatTokens', subject: null };

describe('legacy credential projection', () => {
  it('refuses to turn an access credential into a missing refresh credential', () => {
    const sources = new Map([['tokens', { accessToken: 'access-only' }]]);
    expect(() => projectSourceLogical(candidate, sources, codec, candidate.subject)).toThrow(/missing raw access or refresh credential/);
  });

  it('derives the target refresh identity from the original refresh credential', () => {
    const sources = new Map([['tokens', {
      accessToken: 'access-original', refreshToken: 'refresh-original', clientId: 'client',
      expiresAt: 4102444800000, nsAccessToken: 'upstream-access', nsUsername: 'user@example.test',
    }]]);
    const projected = projectSourceLogical(candidate, sources, codec, candidate.subject);
    expect(projected.activeRefreshId).toBe(codec.id('refresh', 'refresh-original'));
    expect(projected.activeRefreshId).not.toBe(codec.id('refresh', 'access-original'));
  });

  it('projects and sorts PR56 retired fingerprints without inventing an identifier', () => {
    const sources = new Map<string, Record<string, unknown>>([
      ['families', { id: 'fam', currentRefreshToken: 'refresh', currentAccessToken: 'access', retiredRefreshFingerprints: ['z', 'a'] }],
      ['refresh', { id: 'refresh', status: 'active', token: { clientId: 'client', expiresAt: 4102444800000 } }],
      ['upstream', { nsAccessToken: 'upstream', nsUsername: 'user@example.test' }],
      ['tokens', { accessToken: 'access' }],
    ]);
    const projected = projectSourceLogical({ id: 'family', kind: 'pr56Families' }, sources, codec, null);
    expect(projected.retiredRefreshFingerprints).toEqual(['a', 'z']);
  });
});
