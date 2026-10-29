import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodec, LeaseLostError, RetryableRefreshError, StoreLockedError } from './codec.js';
import { createStore } from './store.js';
import type { McpStore, StoreBackend, StoreCapabilities } from './types.js';

export type PersistedValue = string | number | boolean | { $timestamp: number } | PersistedValue[] | { [field: string]: PersistedValue };
export interface PersistedRecord { key: string; fields: Record<string, PersistedValue>; }
export interface PersistedSnapshot { sessions: PersistedRecord[]; authCodes: PersistedRecord[]; resumeTokens: PersistedRecord[]; usage: PersistedRecord[]; clients: PersistedRecord[]; }
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
    const session = () => ({ clientId: 'client', expiresAt: Date.now() + 60_000, nsAccessToken: secret(), nsRefreshToken: secret(), nsUsername: secret(), nsExpiresAt: Date.now() + 3_600_000 });
    const codeData = () => ({ pending: { clientId: 'client', codeChallenge: 'challenge', redirectUri: 'https://example.com/callback', createdAt: Date.now() }, nsTokens: { access_token: secret() }, serverBaseUrl: 'https://example.com', clientId: 'client' });
    const expected = { serverBaseUrl: 'https://example.com', clientId: 'client' };
    const leaseOpts = { maxWaitMs: 2000, pollIntervalMs: 20, leaseDurationMs: 500 };
    it('sessions read and delete by either token and enforce retention', async () => {
      const { store, handle } = await open(); const t = tokens(); const s = session(); const id = codec.id('session', t.accessToken);
      await store.sessions.create(t, s); expect(await store.sessions.get(t.accessToken)).toEqual(s); expect(await store.sessions.getByRefreshToken(t.refreshToken)).toEqual(s);
      await handle.updateSession(id, row => ({ ...row, expiresAt: Date.now() - 3_600_000 }));
      expect(await store.sessions.get(t.accessToken)).toEqual(s);
      await handle.updateSession(id, row => ({ ...row, expiresAt: Date.now() - 31 * 86400000, retainUntil: Date.now() - 1 }));
      expect(await store.sessions.get(t.accessToken)).toBeUndefined(); expect(await store.sessions.getByRefreshToken(t.refreshToken)).toBeUndefined();
      await store.sessions.create(t, s); await store.sessions.delete(t.accessToken); expect(await store.sessions.getByRefreshToken(t.refreshToken)).toBeUndefined();
      await store.sessions.create(t, s); await store.sessions.deleteByRefreshToken(t.refreshToken); expect(await store.sessions.get(t.accessToken)).toBeUndefined();
    });
    it('at rest hides all secrets and conforms to persisted shape', async () => {
      const { store, handle } = await open(); const t = tokens(); const s = session(); const code = secret(); const user = secret(); const resume = randomBytes(32).toString('hex');
      await store.sessions.create(t, s); await store.authCodes.put(code, codeData()); await store.resumeTokens.consume(resume); await store.usage.recordCall(user, 'tool');
      const raw = await target.dumpRaw(handle);
      for (const value of [t.accessToken, t.refreshToken, code, s.nsAccessToken, s.nsRefreshToken, s.nsUsername, user]) expect(raw).not.toContain(value);
      const snapshot = await target.inspect(handle);
      expect(snapshot.sessions[0].key).toMatch(/^[0-9a-f]{64}$/); expect(snapshot.authCodes[0].key).toMatch(/^[0-9a-f]{64}$/); expect(snapshot.resumeTokens[0].key).toBe(resume);
      const allowed: Record<keyof PersistedSnapshot, string[]> = { sessions: ['refreshId', 'expiresAt', 'retainUntil', 'nsExpiresAt', 'leaseOwner', 'leaseUntil', 'sealed', 'ttlAt', 'v'], authCodes: ['expiresAt', 'sealed', 'ttlAt', 'v'], resumeTokens: ['consumedAt', 'expiresAt', 'ttlAt'], usage: ['userHash', 'toolName', 'count', 'lastUsed'], clients: [] };
      for (const kind of ['sessions', 'authCodes', 'resumeTokens', 'usage'] as const) for (const row of snapshot[kind]) for (const field of Object.keys(row.fields)) expect(allowed[kind]).toContain(field);
      expect(snapshot.sessions[0].fields.sealed).toMatch(/^v1\./); expect(snapshot.authCodes[0].fields.sealed).toMatch(/^v1\./);
    });
    it('wrong key reads nothing and AAD rejects swaps and tampering', async () => {
      const { namespace, store, handle } = await open(); const a = tokens(), b = tokens(), c = tokens(); const code = secret(), user = secret();
      for (const t of [a, b, c]) await store.sessions.create(t, session());
      await store.authCodes.put(code, codeData()); await store.usage.recordCall(user, 'tool');
      const wrong = createStore(handle, { namespace, key: randomBytes(32) });
      expect(await wrong.sessions.get(a.accessToken)).toBeUndefined(); expect(await wrong.sessions.getByRefreshToken(a.refreshToken)).toBeUndefined();
      expect(await wrong.authCodes.getChallenge(code, expected)).toBeUndefined(); expect(await wrong.authCodes.redeem(code, expected)).toBeUndefined(); expect((await wrong.usage.getUserUsage(user)).size).toBe(0);
      const idA = codec.id('session', a.accessToken), idB = codec.id('session', b.accessToken), idC = codec.id('session', c.accessToken);
      const rowA = (await handle.getSession(idA))!, rowB = (await handle.getSession(idB))!;
      await handle.updateSession(idA, row => ({ ...row, sealed: rowB.sealed })); await handle.updateSession(idB, row => ({ ...row, sealed: rowA.sealed }));
      await handle.updateSession(idC, row => ({ ...row, sealed: 'v1.AAAA.AAAA.AAAA' }));
      for (const t of [a, b, c]) expect(await store.sessions.get(t.accessToken)).toBeUndefined();
      const snapshot = await target.inspect(handle); expect(snapshot.sessions.find(row => row.key === idA)?.fields.sealed).toBe(rowB.sealed); expect(snapshot.sessions.find(row => row.key === idB)?.fields.sealed).toBe(rowA.sealed);
    });
    it('auth codes check bindings, expiry, and five concurrent redeems', async () => {
      const { store, handle } = await open(); const code = secret();
      await store.authCodes.put(code, codeData()); expect(await store.authCodes.getChallenge(code, expected)).toBe('challenge');
      expect(await store.authCodes.redeem(code, { ...expected, clientId: 'other' })).toBeUndefined(); expect(await store.authCodes.getChallenge(code, { ...expected, serverBaseUrl: 'https://other.example.com' })).toBeUndefined();
      expect((await Promise.all(Array.from({ length: 5 }, () => store.authCodes.redeem(code, expected)))).filter(Boolean)).toHaveLength(1);
      await store.authCodes.put(code, codeData()); const row = (await handle.getAuthCode(codec.id('code', code)))!; await handle.putAuthCode({ ...row, expiresAt: Date.now() - 1 });
      expect(await store.authCodes.getChallenge(code, expected)).toBeUndefined(); expect(await store.authCodes.redeem(code, expected)).toBeUndefined();
    });
    it('resume tokens enforce atomic single use and expiry', async () => {
      const { store, handle } = await open(); const first = randomBytes(32).toString('hex'), parallel = randomBytes(32).toString('hex'), expired = randomBytes(32).toString('hex');
      expect(await store.resumeTokens.consume(first)).toBe(true); expect(await store.resumeTokens.consume(first)).toBe(false);
      expect((await Promise.all(Array.from({ length: 5 }, () => store.resumeTokens.consume(parallel)))).filter(Boolean)).toHaveLength(1);
      const now = Date.now(); await handle.insertResumeIfAbsent({ id: expired, consumedAt: now - 10800000, expiresAt: now - 1 }, now); expect(await store.resumeTokens.consume(expired)).toBe(true);
    });
    it('usage counts concurrent calls by user', async () => {
      const { store } = await open(); const user = secret(); await Promise.all(Array.from({ length: 20 }, () => store.usage.recordCall(user, 'tool')));
      expect((await store.usage.getUserUsage(user)).get('tool')?.count).toBe(20); expect((await store.usage.getUserUsage(secret())).size).toBe(0);
    });
    it('clients register confidential and public clients', async () => {
      const { store } = await open(); const register = store.clients.registerClient!.bind(store.clients);
      const confidential = await register({ redirect_uris: ['https://example.com/callback'] }); const publicClient = await register({ redirect_uris: ['https://example.com/callback'], token_endpoint_auth_method: 'none' });
      expect(confidential.client_secret).toBeTruthy(); expect(publicClient.client_secret).toBeUndefined(); expect(await store.clients.getClient(confidential.client_id)).toEqual(confidential); expect(await store.clients.getClient('missing')).toBeUndefined();
    });
    const leaseCases = async (store: McpStore, handle: StoreBackend, peer: McpStore) => {
      const t = tokens(); const id = codec.id('session', t.accessToken); const original = session(); await store.sessions.create(t, original);
      await handle.updateSession(id, row => ({ ...row, nsExpiresAt: Date.now() - 1 }));
      const refresh = vi.fn(async () => { await delay(40); return { access_token: secret(), expires_in: 3600 }; });
      const values = await Promise.all(Array.from({ length: 5 }, (_, i) => (i % 2 ? peer : store).sessions.refreshUpstream(t.accessToken, refresh, leaseOpts)));
      expect(refresh).toHaveBeenCalledTimes(1); expect(values.every(value => value.nsAccessToken === values[0].nsAccessToken)).toBe(true);
      await peer.sessions.refreshUpstream(t.accessToken, refresh, leaseOpts); expect(refresh).toHaveBeenCalledTimes(1);
      await handle.updateSession(id, row => ({ ...row, nsExpiresAt: Date.now() - 1, leaseOwner: 'abandoned', leaseUntil: Date.now() - 1 }));
      await peer.sessions.refreshUpstream(t.accessToken, refresh, leaseOpts); expect(refresh).toHaveBeenCalledTimes(2);
      const before = (await store.sessions.get(t.accessToken))!;
      await handle.updateSession(id, row => ({ ...row, nsExpiresAt: Date.now() - 1 }));
      await expect(store.sessions.refreshUpstream(t.accessToken, async () => { await handle.updateSession(id, row => ({ ...row, leaseOwner: 'thief', leaseUntil: Date.now() + 60000 })); return { access_token: secret(), expires_in: 3600 }; }, leaseOpts)).rejects.toBeInstanceOf(LeaseLostError);
      expect((await store.sessions.get(t.accessToken))?.nsAccessToken).toBe(before.nsAccessToken);
      await expect(peer.sessions.refreshUpstream(t.accessToken, refresh, leaseOpts)).rejects.toBeInstanceOf(RetryableRefreshError);
      await handle.updateSession(id, row => ({ ...row, leaseUntil: Date.now() - 1 }));
      await expect(store.sessions.refreshUpstream(t.accessToken, async () => { await peer.sessions.delete(t.accessToken); return { access_token: secret() }; }, leaseOpts)).rejects.toThrow();
      expect(await store.sessions.get(t.accessToken)).toBeUndefined();
    };
    it('refresh lease handles abandoned, late completion, deletion and timeout', async () => { const { store, handle } = await open(); await leaseCases(store, handle, store); }, 15000);
    it('capabilities cover handles, persistence, expiry and metadata', async () => {
      const { namespace, store, handle } = await open(); const t = tokens(); await store.sessions.create(t, session());
      if (target.capabilities.exclusive) await expect(target.openBackend(namespace)).rejects.toBeInstanceOf(StoreLockedError);
      else {
        const other = await open(namespace);
        expect(Boolean(await other.store.sessions.get(t.accessToken))).toBe(target.capabilities.multiInstance);
        if (target.capabilities.multiInstance) await leaseCases(store, handle, other.store);
      }
      const code = secret(), resume = randomBytes(32).toString('hex'), now = Date.now();
      await store.authCodes.put(code, codeData()); await store.resumeTokens.consume(resume);
      const id = codec.id('session', t.accessToken); await handle.updateSession(id, row => ({ ...row, retainUntil: row.retainUntil + 5000 }));
      let snapshot = await target.inspect(handle);
      if (target.capabilities.expiry === 'ttl-policy') {
        for (const row of snapshot.sessions) expect(row.fields.ttlAt).toEqual({ $timestamp: row.fields.retainUntil });
        for (const row of [...snapshot.authCodes, ...snapshot.resumeTokens]) expect(row.fields.ttlAt).toEqual({ $timestamp: row.fields.expiresAt });
        expect(await handle.sweep(now)).toBe(0); expect(await target.inspect(handle)).toEqual(snapshot);
      } else {
        const expiredT = tokens(), expiredCode = secret(), expiredResume = randomBytes(32).toString('hex');
        await store.sessions.create(expiredT, session()); await handle.updateSession(codec.id('session', expiredT.accessToken), row => ({ ...row, expiresAt: now - 31 * 86400000, retainUntil: now - 1 }));
        await store.authCodes.put(expiredCode, codeData()); const expiredRow = (await handle.getAuthCode(codec.id('code', expiredCode)))!; await handle.putAuthCode({ ...expiredRow, expiresAt: now - 1 });
        await handle.insertResumeIfAbsent({ id: expiredResume, consumedAt: now - 10800000, expiresAt: now - 1 }, now);
        expect(await handle.sweep(now)).toBeGreaterThanOrEqual(3); snapshot = await target.inspect(handle);
        expect(snapshot.sessions.map(row => row.key)).not.toContain(codec.id('session', expiredT.accessToken)); expect(snapshot.authCodes.map(row => row.key)).not.toContain(codec.id('code', expiredCode)); expect(snapshot.resumeTokens.map(row => row.key)).not.toContain(expiredResume);
        expect(snapshot.sessions.map(row => row.key)).toContain(id); expect(snapshot.authCodes.map(row => row.key)).toContain(codec.id('code', code)); expect(snapshot.resumeTokens.map(row => row.key)).toContain(resume);
      }
      await handle.close(); const reopened = await open(namespace); expect(Boolean(await reopened.store.sessions.get(t.accessToken))).toBe(target.capabilities.persistent);
    }, 15000);
    it('namespaces isolate records', async () => {
      const a = await open(), b = await open(); const t = tokens(); await a.store.sessions.create(t, session()); expect(await b.store.sessions.get(t.accessToken)).toBeUndefined();
    });
  });
}
