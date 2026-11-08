import { describe, expect, it } from 'vitest';
import { parseNsRefreshResponse } from '../auth/ns-refresh-response.js';
import { kitCodeOf, UpstreamRequestRejectedError, UpstreamRevokedError } from '../auth/kit/errors.js';

describe('NetSapiens refresh response validation', () => {
  it('accepts a valid response, with optional refresh-token rotation', () => {
    expect(parseNsRefreshResponse({ access_token: 'access', expires_in: 3600, refresh_token: 'refresh' }))
      .toEqual({ access_token: 'access', expires_in: 3600, refresh_token: 'refresh' });
    expect(parseNsRefreshResponse({ access_token: 'access', expires_in: 1, refresh_token: null, extra: true }))
      .toEqual({ access_token: 'access', expires_in: 1 });
  });

  it.each([
    '<html>maintenance</html>', [], {}, { error: 'invalid_grant' },
    { access_token: '', expires_in: 3600 }, { access_token: ' ', expires_in: 3600 },
    { access_token: 42, expires_in: 3600 }, { access_token: 'access' },
    ...['3600', 0, -1, 1.5, NaN, Infinity].map(expires_in => ({ access_token: 'access', expires_in })),
    { access_token: 'access', expires_in: 3600, refresh_token: '' },
    { access_token: 'access', expires_in: 3600, refresh_token: 42 },
  ])('rejects malformed responses without disclosing them', (body) => {
    try {
      parseNsRefreshResponse(body);
      expect.fail('malformed response was accepted');
    } catch (error) {
      expect(kitCodeOf(error)).toBe('upstream_unavailable');
      expect(error).not.toBeInstanceOf(UpstreamRequestRejectedError);
      expect(error).not.toBeInstanceOf(UpstreamRevokedError);
      expect((error as Error).message).toBe('Upstream refresh returned an invalid token response');
    }
  });
});
