import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeOperationKey as repoNormalizeOperationKey } from '../netsapiens/operation-key.js';
import {
  startFakeNetSapiens,
  normalizeOperationKey as fakeNormalizeOperationKey,
} from '../../scripts/fake-netsapiens/index.mjs';

const activeFakes: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (activeFakes.length > 0) {
    const fake = activeFakes.pop();
    if (fake) await fake.close();
  }
});

describe('Fake NetSapiens Origin (Contract C4)', () => {
  describe('/version endpoint', () => {
    it('returns configured string version and responds to setVersionStatus and setApiVersion', async () => {
      const fake = await startFakeNetSapiens({ apiVersion: '44.4.10' });
      activeFakes.push(fake);

      // Default status 200 with apiversion
      const res1 = await fetch(`${fake.origin}/ns-api/v2/version`);
      expect(res1.status).toBe(200);
      expect(res1.headers.get('content-type')).toContain('application/json');
      const data1 = (await res1.json()) as { apiversion: string };
      expect(data1).toEqual({ apiversion: '44.4.10' });

      // Override version status
      fake.setVersionStatus(418);
      const res2 = await fetch(`${fake.origin}/ns-api/v2/version`);
      expect(res2.status).toBe(418);
      const data2 = (await res2.json()) as { apiversion: string };
      expect(data2).toEqual({ apiversion: '44.4.10' });

      // Change API version and restore 200 status
      fake.setVersionStatus(200);
      fake.setApiVersion('45.0.0');
      const res3 = await fetch(`${fake.origin}/ns-api/v2/version`);
      expect(res3.status).toBe(200);
      const data3 = (await res3.json()) as { apiversion: string };
      expect(data3).toEqual({ apiversion: '45.0.0' });

      // Setting apiVersion to null yields 500
      fake.setApiVersion(null);
      const res4 = await fetch(`${fake.origin}/ns-api/v2/version`);
      expect(res4.status).toBe(500);
      const data4 = (await res4.json()) as { error: string };
      expect(data4).toEqual({ error: 'Internal Server Error' });
    });

    it('returns 500 when started with apiVersion: null', async () => {
      const fake = await startFakeNetSapiens({ apiVersion: null });
      activeFakes.push(fake);

      const res = await fetch(`${fake.origin}/ns-api/v2/version`);
      expect(res.status).toBe(500);
      const data = (await res.json()) as { error: string };
      expect(data).toEqual({ error: 'Internal Server Error' });
    });
  });

  describe('apidoc endpoint', () => {
    it('handles "missing", "full", and array variants', async () => {
      const fake = await startFakeNetSapiens({ apidoc: 'missing' });
      activeFakes.push(fake);

      // "missing" returns 404
      const res1 = await fetch(`${fake.origin}/ns-api/webroot/apidoc/api_data.json`);
      expect(res1.status).toBe(404);
      const data1 = (await res1.json()) as { message: string };
      expect(data1).toEqual({ message: 'Not Found' });

      // "full" loads reduced apidoc (277 items each having only type and url)
      fake.setApidoc('full');
      const res2 = await fetch(`${fake.origin}/ns-api/webroot/apidoc/api_data.json`);
      expect(res2.status).toBe(200);
      const data2 = (await res2.json()) as Array<{ type: string; url: string }>;
      expect(Array.isArray(data2)).toBe(true);
      expect(data2.length).toBe(277);
      expect(Object.keys(data2[0]).sort()).toEqual(['type', 'url']);
      expect(typeof data2[0].type).toBe('string');
      expect(typeof data2[0].url).toBe('string');

      // array variant returns specified array
      const customDoc = [{ type: 'post', url: '?object=address&action=copyEndpoint' }];
      fake.setApidoc(customDoc);
      const res3 = await fetch(`${fake.origin}/ns-api/webroot/apidoc/api_data.json`);
      expect(res3.status).toBe(200);
      const data3 = (await res3.json()) as typeof customDoc;
      expect(data3).toEqual(customDoc);
    });
  });

  describe('route matching and error responses', () => {
    it('returns 404 {"message":"No Route Found"} for undocumented paths', async () => {
      const fake = await startFakeNetSapiens({ apiVersion: '44.4.10' });
      activeFakes.push(fake);

      // Without auth header
      const res1 = await fetch(`${fake.origin}/ns-api/v2/definitely-not-documented-route-xyz`);
      expect(res1.status).toBe(404);
      const data1 = (await res1.json()) as { message: string };
      expect(data1).toEqual({ message: 'No Route Found' });

      // With auth header
      const res2 = await fetch(`${fake.origin}/ns-api/v2/definitely-not-documented-route-xyz`, {
        headers: { Authorization: 'Bearer some-token' },
      });
      expect(res2.status).toBe(404);
      const data2 = (await res2.json()) as { message: string };
      expect(data2).toEqual({ message: 'No Route Found' });
    });

    it('returns 400 with "missing an access token" for documented path without bearer', async () => {
      const fake = await startFakeNetSapiens({ apiVersion: '44.4.10' });
      activeFakes.push(fake);

      // GET /domains is documented in 44.4
      const res = await fetch(`${fake.origin}/ns-api/v2/domains`);
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toContain('missing an access token');
    });

    it('returns 501 {"message":"fake: no handler"} for documented path with bearer and no handler', async () => {
      const fake = await startFakeNetSapiens({ apiVersion: '44.4.10' });
      activeFakes.push(fake);

      // GET /domains is documented but has no custom routeModule handler
      const res = await fetch(`${fake.origin}/ns-api/v2/domains`, {
        headers: { Authorization: 'Bearer valid-format-token' },
      });
      expect(res.status).toBe(501);
      const data = (await res.json()) as { message: string };
      expect(data).toEqual({ message: 'fake: no handler' });
    });
  });

  describe('token sign-in and role detection lookups', () => {
    it('returns user record for known token, and 401 error for unknown token', async () => {
      const tokensRecord = {
        'token-alice': {
          user: 'alice',
          domain: 'test.example.com',
          'user-scope': 'Basic User',
          login: 'alice@test.example.com',
        },
      };

      const fake = await startFakeNetSapiens({
        apiVersion: '44.4.10',
        tokens: tokensRecord,
      });
      activeFakes.push(fake);

      // Specific domain & user lookup with known token
      const res1 = await fetch(`${fake.origin}/ns-api/v2/domains/test.example.com/users/alice`, {
        headers: { Authorization: 'Bearer token-alice' },
      });
      expect(res1.status).toBe(200);
      const data1 = await res1.json();
      expect(data1).toEqual(tokensRecord['token-alice']);

      // Tilde ~ expansion lookup with known token
      const res2 = await fetch(`${fake.origin}/ns-api/v2/domains/~/users/~`, {
        headers: { Authorization: 'Bearer token-alice' },
      });
      expect(res2.status).toBe(200);
      const data2 = await res2.json();
      expect(data2).toEqual(tokensRecord['token-alice']);

      // Unknown token returns 401
      const res3 = await fetch(`${fake.origin}/ns-api/v2/domains/~/users/~`, {
        headers: { Authorization: 'Bearer unknown-token' },
      });
      expect(res3.status).toBe(401);
      const data3 = (await res3.json()) as { code: number; message: string };
      expect(data3).toEqual({ code: 401, message: 'Unauthorized' });

      // Token lookup without bearer returns 400 missing access token
      const res4 = await fetch(`${fake.origin}/ns-api/v2/domains/~/users/~`);
      expect(res4.status).toBe(400);
      const text4 = await res4.text();
      expect(text4).toContain('missing an access token');

      // Tokens passed as Map
      const tokenMap = new Map([
        ['token-bob', { user: 'bob', domain: 'test.example.com', scope: 'Office Manager' }],
      ]);
      fake.setTokens(tokenMap);

      const res5 = await fetch(`${fake.origin}/ns-api/v2/domains/~/users/~`, {
        headers: { Authorization: 'Bearer token-bob' },
      });
      expect(res5.status).toBe(200);
      const data5 = await res5.json();
      expect(data5).toEqual(tokenMap.get('token-bob'));
    });
  });

  describe('extraPresent and forceAbsent route availability', () => {
    it('correctly modifies route availability', async () => {
      // In 44.4, GET /extra/test/custom/route is NOT documented.
      // GET /domains IS documented.
      const fake = await startFakeNetSapiens({
        apiVersion: '44.4.10',
        extraPresent: ['GET /extra/test/custom/route'],
        forceAbsent: ['GET /domains'],
      });
      activeFakes.push(fake);

      // extraPresent route is now recognized:
      // without bearer -> 400
      const resExtraNoAuth = await fetch(`${fake.origin}/ns-api/v2/extra/test/custom/route`);
      expect(resExtraNoAuth.status).toBe(400);
      // with bearer -> 501 (documented in set, no custom handler)
      const resExtraWithAuth = await fetch(`${fake.origin}/ns-api/v2/extra/test/custom/route`, {
        headers: { Authorization: 'Bearer token123' },
      });
      expect(resExtraWithAuth.status).toBe(501);

      // forceAbsent route is now absent (returns 404 instead of 400/501):
      const resAbsentNoAuth = await fetch(`${fake.origin}/ns-api/v2/domains`);
      expect(resAbsentNoAuth.status).toBe(404);
      expect((await resAbsentNoAuth.json()) as { message: string }).toEqual({ message: 'No Route Found' });

      const resAbsentWithAuth = await fetch(`${fake.origin}/ns-api/v2/domains`, {
        headers: { Authorization: 'Bearer token123' },
      });
      expect(resAbsentWithAuth.status).toBe(404);
      expect((await resAbsentWithAuth.json()) as { message: string }).toEqual({ message: 'No Route Found' });
    });
  });

  describe('custom routeModules', () => {
    it('executes custom route handlers when matching', async () => {
      const fake = await startFakeNetSapiens({
        apiVersion: '44.4.10',
        routeModules: [
          (state: Record<string, unknown>) => [
            {
              method: 'POST',
              path: '/ns-api/v2/domains/:domain/calls/:id/transfer',
              handler: async (req: { params: Record<string, string>; body: { target?: string } }) => {
                state.transferred = true;
                return {
                  status: 200,
                  body: {
                    ok: true,
                    domain: req.params.domain,
                    id: req.params.id,
                    target: req.body?.target,
                  },
                };
              },
            },
          ],
        ],
      });
      activeFakes.push(fake);

      // Without auth -> 400
      const resNoAuth = await fetch(`${fake.origin}/ns-api/v2/domains/test/calls/call-1/transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: '102' }),
      });
      expect(resNoAuth.status).toBe(400);

      // With auth -> 200 custom handler
      const resAuth = await fetch(`${fake.origin}/ns-api/v2/domains/test/calls/call-1/transfer`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer bearer-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ target: '102' }),
      });
      expect(resAuth.status).toBe(200);
      const data = (await resAuth.json()) as { ok: boolean; domain: string; id: string; target: string };
      expect(data).toEqual({
        ok: true,
        domain: 'test',
        id: 'call-1',
        target: '102',
      });
      expect(fake.state.transferred).toBe(true);
    });
  });

  describe('requests logging', () => {
    it('accurately records method, path, query, body, hasAuth, headers', async () => {
      const fake = await startFakeNetSapiens({ apiVersion: '44.4.10' });
      activeFakes.push(fake);

      // Request 1: GET with query, no auth
      await fetch(`${fake.origin}/ns-api/v2/version?format=json&debug=1`);

      // Request 2: POST with JSON body and auth
      await fetch(`${fake.origin}/ns-api/v2/test-post`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-bearer',
          'Content-Type': 'application/json',
          'X-Custom-Header': 'custom-val',
        },
        body: JSON.stringify({ key: 'value', count: 42 }),
      });

      expect(fake.requests.length).toBe(2);

      const r1 = fake.requests[0];
      expect(r1.method).toBe('GET');
      expect(r1.path).toBe('/ns-api/v2/version');
      expect(r1.query).toEqual({ format: 'json', debug: '1' });
      expect(r1.body).toBeNull();
      expect(r1.hasAuth).toBe(false);
      expect(r1.headers).toBeDefined();

      const r2 = fake.requests[1];
      expect(r2.method).toBe('POST');
      expect(r2.path).toBe('/ns-api/v2/test-post');
      expect(r2.query).toEqual({});
      expect(r2.body).toEqual({ key: 'value', count: 42 });
      expect(r2.hasAuth).toBe(true);
      expect(r2.headers['x-custom-header']).toBe('custom-val');
    });
  });

  describe('OperationKey normalization parity across all 4 vendored specs', () => {
    it('matches normalizeOperationKey for every method and path in 44.3, 44.4, 45.0, 46.0', () => {
      const branches = ['44.3', '44.4', '45.0', '46.0'];
      const repoRoot = resolve(__dirname, '../..');
      let totalOpsChecked = 0;

      for (const branch of branches) {
        const specPath = resolve(repoRoot, `spec/v2/${branch}.json`);
        const spec = JSON.parse(readFileSync(specPath, 'utf8')) as {
          paths: Record<string, Record<string, unknown>>;
        };

        for (const [pathStr, operations] of Object.entries(spec.paths)) {
          for (const methodStr of Object.keys(operations)) {
            const m = methodStr.toLowerCase();
            if (!['get', 'post', 'put', 'patch', 'delete'].includes(m)) {
              continue;
            }

            const expected = repoNormalizeOperationKey(methodStr, pathStr);
            const actual = fakeNormalizeOperationKey(methodStr, pathStr);
            expect(actual).toBe(expected);
            totalOpsChecked++;
          }
        }
      }

      // Assert that a non-trivial number of operations were checked (around 2,307)
      expect(totalOpsChecked).toBeGreaterThan(2000);
    });

    it('rejects unsupported methods like HEAD and TRACE', () => {
      expect(() => fakeNormalizeOperationKey('HEAD', '/')).toThrow('Unsupported operation method');
      expect(() => fakeNormalizeOperationKey('TRACE', '/')).toThrow('Unsupported operation method');
    });
  });
});
