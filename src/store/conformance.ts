import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodec, LeaseLostError, RetryableRefreshError, StoreLockedError } from './codec.js';
import { createStore, REFRESH_RETRY_WINDOW_MS } from './store.js';
import type {
  AccessRow,
  FamilyRow,
  McpStore,
  RefreshPointerRow,
  StoreBackend,
  StoreCapabilities,
  StoredToken,
  UpstreamGrantRow,
} from './types.js';

export type PersistedValue = string | number | boolean | { $timestamp: number } | PersistedValue[] | { [field: string]: PersistedValue };
export interface PersistedRecord { key: string; fields: Record<string, PersistedValue>; }
export interface PersistedSnapshot {
  sessions: PersistedRecord[];
  refreshTokens?: PersistedRecord[];
  refreshFamilies?: PersistedRecord[];
  upstreamGrants?: PersistedRecord[];
  authCodes: PersistedRecord[];
  resumeTokens: PersistedRecord[];
  usage: PersistedRecord[];
  clients: PersistedRecord[];
}
export interface ConformanceTarget {
  readonly name: string;
  readonly capabilities: StoreCapabilities;
  openBackend(namespace: string): Promise<StoreBackend>;
  inspect(handle: StoreBackend): Promise<PersistedSnapshot>;
  dumpRaw(handle: StoreBackend): Promise<string>;
  cleanup(namespace: string): Promise<void>;
}

export function runStoreConformance(target: ConformanceTarget): void {
  describe(`${target.name} store conformance`, () => {
    const handles: StoreBackend[] = [];
    const namespaces = new Set<string>();
    const key = randomBytes(32);
    const codec = createCodec(key);
    const secret = () => randomBytes(24).toString('hex');

    const open = async (namespace = `t_${randomBytes(8).toString('hex')}`) => {
      namespaces.add(namespace);
      const handle = await target.openBackend(namespace);
      handles.push(handle);
      expect(handle.capabilities).toEqual(target.capabilities);
      return { namespace, handle, store: createStore(handle, { namespace, key }) };
    };

    afterEach(async () => {
      for (const handle of handles.splice(0)) await handle.close();
      for (const namespace of namespaces) await target.cleanup(namespace);
      namespaces.clear();
    });

    const tokens = () => ({ accessToken: secret(), refreshToken: secret() });
    const session = (): StoredToken => ({
      clientId: 'client-1',
      expiresAt: Date.now() + 60_000,
      nsAccessToken: secret(),
      nsRefreshToken: secret(),
      nsUsername: 'user@domain.com',
      nsExpiresAt: Date.now() + 3_600_000,
      serverBaseUrl: 'https://example.com',
      extra: { seatId: 'seat-1' },
    });
    const codeData = () => ({
      pending: { clientId: 'client-1', codeChallenge: 'challenge', redirectUri: 'https://example.com/callback', createdAt: Date.now() },
      nsTokens: { access_token: secret() },
      serverBaseUrl: 'https://example.com',
      clientId: 'client-1',
    });
    const expected = { serverBaseUrl: 'https://example.com', clientId: 'client-1' };
    const leaseOpts = { maxWaitMs: 6000, pollIntervalMs: 20, leaseDurationMs: 500 };

    it('sessions create permanent refresh family and access record with retention', async () => {
      const { store, handle } = await open();
      const t = tokens();
      const s = session();
      const stored = await store.sessions.create(t, s);

      expect(stored.refreshFamilyId).toBeDefined();
      expect(await store.sessions.get(t.accessToken)).toEqual(expect.objectContaining({
        clientId: s.clientId,
        nsUsername: s.nsUsername,
        refreshFamilyId: stored.refreshFamilyId,
      }));
      expect(await store.sessions.getByRefreshToken(t.refreshToken)).toEqual(expect.objectContaining({
        clientId: s.clientId,
        nsUsername: s.nsUsername,
        refreshFamilyId: stored.refreshFamilyId,
      }));

      // Access row expiration does not delete refresh family
      const accessId = codec.id('session', t.accessToken);
      const acc = await handle.getAccess(accessId);
      expect(acc).toBeDefined();

      // Mutate access row retainUntil to the past
      await handle.putAccess({ ...acc!, expiresAt: Date.now() - 10000, retainUntil: Date.now() - 1 });
      expect(await store.sessions.get(t.accessToken)).toBeUndefined();
      // Refresh token remains readable!
      expect(await store.sessions.getByRefreshToken(t.refreshToken)).toBeDefined();
    });

    it('lookupRefresh validates client, returns active, and handles retry and replay', async () => {
      const { store, handle } = await open();
      const t = tokens();
      const s = session();
      const stored = await store.sessions.create(t, s);

      // 1. Active lookup
      const activeLookup = await store.sessions.lookupRefresh(t.refreshToken, 'client-1', Date.now());
      expect(activeLookup.status).toBe('active');
      if (activeLookup.status === 'active') {
        expect(activeLookup.familyId).toBe(stored.refreshFamilyId);
        expect(activeLookup.generation).toBe(1);
      }

      // 2. Client ID mismatch returns missing without revoking
      const wrongClientLookup = await store.sessions.lookupRefresh(t.refreshToken, 'wrong-client', Date.now());
      expect(wrongClientLookup.status).toBe('missing');
      // Family must still be active!
      const stillActive = await store.sessions.lookupRefresh(t.refreshToken, 'client-1', Date.now());
      expect(stillActive.status).toBe('active');

      // 3. Rotate tokens
      const t2 = tokens();
      const rotateRes = await store.sessions.rotate(t.refreshToken, { tokens: t2, session: s }, 'client-1', Date.now());
      expect(rotateRes.status).toBe('claimed');

      // 4. Retry inside 30-second window returns successor tokens
      const retryLookup = await store.sessions.lookupRefresh(t.refreshToken, 'client-1', Date.now() + 5000);
      expect(retryLookup.status).toBe('retry');
      if (retryLookup.status === 'retry') {
        expect(retryLookup.tokens.accessToken).toBe(t2.accessToken);
        expect(retryLookup.tokens.refreshToken).toBe(t2.refreshToken);
      }

      // 5. Replay outside 30-second window revokes family
      const replayLookup = await store.sessions.lookupRefresh(t.refreshToken, 'client-1', Date.now() + REFRESH_RETRY_WINDOW_MS + 5000);
      expect(replayLookup.status).toBe('replay');

      // Subsequent lookup with rotated token should now be missing (revoked)
      const afterRevoke = await store.sessions.lookupRefresh(t2.refreshToken, 'client-1', Date.now());
      expect(afterRevoke.status).toBe('missing');
    });

    it('rotate commits atomic rotation and allows concurrent retries', async () => {
      const { store } = await open();
      const t = tokens();
      const s = session();
      await store.sessions.create(t, s);

      const next1 = tokens();
      const next2 = tokens();

      // First rotation succeeds (claimed)
      const r1 = await store.sessions.rotate(t.refreshToken, { tokens: next1, session: s }, 'client-1', Date.now());
      expect(r1.status).toBe('claimed');

      // Concurrent rotation with same old token inside retry window returns retry with r1 tokens
      const r2 = await store.sessions.rotate(t.refreshToken, { tokens: next2, session: s }, 'client-1', Date.now() + 100);
      expect(r2.status).toBe('retry');
      if (r2.status === 'retry') {
        expect(r2.tokens.accessToken).toBe(next1.accessToken);
        expect(r2.tokens.refreshToken).toBe(next1.refreshToken);
      }
    });

    it('conditional revokeFamily enforces generation checks', async () => {
      const { store } = await open();
      const t = tokens();
      const s = session();
      const created = await store.sessions.create(t, s);
      const familyId = created.refreshFamilyId;

      // Stale generation check
      const staleRes = await store.sessions.revokeFamily(familyId, { expectedFamilyGeneration: 99 });
      expect(staleRes).toBe('stale');
      expect(await store.sessions.getByRefreshToken(t.refreshToken)).toBeDefined();

      // Matching generation check succeeds
      const revokeRes = await store.sessions.revokeFamily(familyId, { expectedFamilyGeneration: 1 });
      expect(revokeRes).toBe('revoked');
      expect(await store.sessions.getByRefreshToken(t.refreshToken)).toBeUndefined();
      expect(await store.sessions.get(t.accessToken)).toBeUndefined();
    });

    it('at rest hides all secrets and never puts ttlAt on refresh or family records', async () => {
      const { store, handle } = await open();
      const t = tokens();
      const s = session();
      const code = secret();
      const user = secret();
      const resume = randomBytes(32).toString('hex');
      const authData = codeData();

      await store.sessions.create(t, s);
      await store.authCodes.put(code, authData);
      await store.resumeTokens.consume(resume);
      await store.usage.recordCall(user, 'tool');

      const raw = await target.dumpRaw(handle);
      for (const value of [t.accessToken, t.refreshToken, code, s.nsAccessToken, s.nsRefreshToken, s.nsUsername, user, authData.nsTokens.access_token]) {
        expect(raw).not.toContain(value);
      }

      const snapshot = await target.inspect(handle);
      if (target.capabilities.expiry === 'ttl-policy') {
        // Access records carry ttlAt
        expect(snapshot.sessions[0].fields.ttlAt).toBeDefined();
        // Refresh, family, and upstream records MUST NOT carry ttlAt
        if (snapshot.refreshTokens && snapshot.refreshTokens.length > 0) {
          expect(snapshot.refreshTokens[0].fields.ttlAt).toBeUndefined();
        }
        if (snapshot.refreshFamilies && snapshot.refreshFamilies.length > 0) {
          expect(snapshot.refreshFamilies[0].fields.ttlAt).toBeUndefined();
        }
        if (snapshot.upstreamGrants && snapshot.upstreamGrants.length > 0) {
          expect(snapshot.upstreamGrants[0].fields.ttlAt).toBeUndefined();
        }
      }
    });

    it('auth codes check bindings, expiry, and five concurrent redeems', async () => {
      const { store, handle } = await open();
      const code = secret();
      await store.authCodes.put(code, codeData());
      expect(await store.authCodes.getChallenge(code, expected)).toBe('challenge');
      expect(await store.authCodes.redeem(code, { ...expected, clientId: 'other' })).toBeUndefined();
      expect(await store.authCodes.getChallenge(code, { ...expected, serverBaseUrl: 'https://other.example.com' })).toBeUndefined();
      expect((await Promise.all(Array.from({ length: 5 }, () => store.authCodes.redeem(code, expected)))).filter(Boolean)).toHaveLength(1);
      await store.authCodes.put(code, codeData());
      const row = (await handle.getAuthCode(codec.id('code', code)))!;
      await handle.putAuthCode({ ...row, expiresAt: Date.now() - 1 });
      expect(await store.authCodes.getChallenge(code, expected)).toBeUndefined();
      expect(await store.authCodes.redeem(code, expected)).toBeUndefined();
    });

    it('resume tokens enforce atomic single use and expiry', async () => {
      const { store, handle } = await open();
      const first = randomBytes(32).toString('hex');
      const parallel = randomBytes(32).toString('hex');
      const expired = randomBytes(32).toString('hex');
      expect(await store.resumeTokens.consume(first)).toBe(true);
      expect(await store.resumeTokens.consume(first)).toBe(false);
      expect((await Promise.all(Array.from({ length: 5 }, () => store.resumeTokens.consume(parallel)))).filter(Boolean)).toHaveLength(1);
      const now = Date.now();
      await handle.insertResumeIfAbsent({ id: expired, consumedAt: now - 10800000, expiresAt: now - 1 }, now);
      expect(await store.resumeTokens.consume(expired)).toBe(true);
    });

    it('usage counts concurrent calls by user', async () => {
      const { store } = await open();
      const user = secret();
      await Promise.all(Array.from({ length: 20 }, () => store.usage.recordCall(user, 'tool')));
      expect((await store.usage.getUserUsage(user)).get('tool')?.count).toBe(20);
      expect((await store.usage.getUserUsage(secret())).size).toBe(0);
    });

    it('clients register confidential and public clients', async () => {
      const { store } = await open();
      const register = store.clients.registerClient!.bind(store.clients);
      const confidential = await register({ redirect_uris: ['https://example.com/callback'] });
      const publicClient = await register({ redirect_uris: ['https://example.com/callback'], token_endpoint_auth_method: 'none' });
      expect(confidential.client_secret).toBeTruthy();
      expect(publicClient.client_secret).toBeUndefined();
      expect(await store.clients.getClient(confidential.client_id)).toEqual(confidential);
      expect(await store.clients.getClient('missing')).toBeUndefined();
    });

    it('refreshUpstream leases coordinate across concurrent calls and multi-instance', async () => {
      const { store, handle } = await open();
      const t = tokens();
      const s = session();
      const created = await store.sessions.create(t, s);
      const familyId = created.refreshFamilyId;

      await handle.updateUpstream(familyId, (cur) => ({ ...cur, nsExpiresAt: Date.now() - 1 }));
      const refresh = vi.fn(async () => {
        await delay(40);
        return { access_token: secret(), expires_in: 3600 };
      });

      // 5 concurrent calls share 1 upstream refresh
      const values = await Promise.all(Array.from({ length: 5 }, () =>
        store.sessions.refreshUpstream(familyId, refresh, leaseOpts),
      ));

      expect(refresh).toHaveBeenCalledTimes(1);
      expect(values.every((v) => v.nsAccessToken === values[0].nsAccessToken)).toBe(true);

      // Lease timeout handles abandoned lease
      await handle.updateUpstream(familyId, (cur) => ({ ...cur, leaseOwner: 'abandoned', leaseUntil: Date.now() - 1 }));
      await store.sessions.refreshUpstream(familyId, refresh, { ...leaseOpts, force: true });
      expect(refresh).toHaveBeenCalledTimes(2);
    });
  });
}
