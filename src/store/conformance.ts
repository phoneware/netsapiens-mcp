import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LeaseLostError, RetryableRefreshError, StoreLockedError } from './codec.js';
import { AUTH_CODE_TTL_MS, RESUME_TOKEN_TTL_MS, SESSION_RETENTION_MS } from './store.js';
import type { McpStore, StoreCapabilities, StoredToken } from './types.js';

export interface ConformanceTarget {
  name: string;
  capabilities: StoreCapabilities;
  open(namespace: string): Promise<McpStore>;
  dumpRaw(namespace: string): Promise<string>;
  swapSealed(namespace: string, idA: string, idB: string): Promise<void>;
  cleanup(namespace: string): Promise<void>;
}

export function runStoreConformance(target: ConformanceTarget): void {
  describe(`${target.name} store conformance`, () => {
    const namespaces: string[] = [];
    const open = async () => { const namespace = `t${randomUUID().replaceAll('-', '').slice(0, 24)}`; namespaces.push(namespace); return { namespace, store: await target.open(namespace) }; };
    afterEach(async () => { vi.restoreAllMocks(); for (const namespace of namespaces.splice(0)) await target.cleanup(namespace); });
    const session = (expiresAt = Date.now() + 60_000): StoredToken => ({ clientId: 'client', expiresAt, nsAccessToken: 'ns-access-secret', nsRefreshToken: 'ns-refresh-secret', nsUsername: 'private-user' });
    const codeData = () => ({ pending: { clientId: 'client', codeChallenge: 'challenge', redirectUri: 'https://example.com/callback', createdAt: Date.now() }, nsTokens: { access_token: 'ns-access-secret' }, serverBaseUrl: 'https://example.com', clientId: 'client' });
    it('sessions support both tokens and retain expired bearer sessions', async () => {
      const { store } = await open(); const s = session(Date.now() - 1000);
      await store.sessions.create({ accessToken: 'access-secret', refreshToken: 'refresh-secret' }, s);
      expect(await store.sessions.get('access-secret')).toEqual(s);
      expect(await store.sessions.getByRefreshToken('refresh-secret')).toEqual(s);
      await store.sessions.deleteByRefreshToken('refresh-secret'); expect(await store.sessions.get('access-secret')).toBeUndefined();
      await store.sessions.create({ accessToken: 'access-secret', refreshToken: 'refresh-secret' }, s);
      await store.sessions.delete('access-secret'); expect(await store.sessions.getByRefreshToken('refresh-secret')).toBeUndefined();
      await store.sessions.create({ accessToken: 'access-secret', refreshToken: 'refresh-secret' }, session(Date.now() - SESSION_RETENTION_MS - 1));
      expect(await store.sessions.get('access-secret')).toBeUndefined();
    });
    it('at rest does not reveal credentials or user identities', async () => {
      const { namespace, store } = await open();
      await store.sessions.create({ accessToken: 'access-secret', refreshToken: 'refresh-secret' }, session());
      await store.authCodes.put('auth-code-secret', codeData()); await store.usage.recordCall('usage-user-secret', 'tool');
      const raw = await target.dumpRaw(namespace);
      for (const secret of ['access-secret', 'refresh-secret', 'auth-code-secret', 'ns-access-secret', 'ns-refresh-secret', 'private-user', 'usage-user-secret']) expect(raw).not.toContain(secret);
    });
    it('auth codes allow a challenge and five concurrent redeems yield one result', async () => {
      const { store } = await open(); const expected = { serverBaseUrl: 'https://example.com', clientId: 'client' };
      await store.authCodes.put('code', codeData()); expect(await store.authCodes.getChallenge('code', expected)).toBe('challenge');
      expect(await store.authCodes.getChallenge('code', { ...expected, clientId: 'other' })).toBeUndefined();
      expect(await store.authCodes.redeem('code', { ...expected, serverBaseUrl: 'https://other.example.com' })).toBeUndefined();
      expect((await Promise.all(Array.from({ length: 5 }, () => store.authCodes.redeem('code', expected)))).filter(Boolean)).toHaveLength(1);
      await store.authCodes.put('expired', codeData()); vi.spyOn(Date, 'now').mockReturnValue(Date.now() + AUTH_CODE_TTL_MS + 1);
      expect(await store.authCodes.redeem('expired', expected)).toBeUndefined();
    });
    it('resume tokens enforce single use until expiry', async () => {
      const { store } = await open(); const one = 'a'.repeat(64); const parallel = 'b'.repeat(64);
      expect(await store.resumeTokens.consume(one)).toBe(true); expect(await store.resumeTokens.consume(one)).toBe(false);
      expect((await Promise.all(Array.from({ length: 5 }, () => store.resumeTokens.consume(parallel)))).filter(Boolean)).toHaveLength(1);
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + RESUME_TOKEN_TTL_MS + 1); expect(await store.resumeTokens.consume(one)).toBe(true);
    });
    it('usage counts concurrent calls by user', async () => {
      const { store } = await open(); await Promise.all(Array.from({ length: 20 }, () => store.usage.recordCall('one', 'tool')));
      expect((await store.usage.getUserUsage('one')).get('tool')?.count).toBe(20); expect((await store.usage.getUserUsage('two')).size).toBe(0);
    });
    it('clients register confidential and public clients', async () => {
      const { store } = await open();
      const register = store.clients.registerClient!.bind(store.clients);
      const confidential = await register({ redirect_uris: ['https://example.com/callback'] });
      const publicClient = await register({ redirect_uris: ['https://example.com/callback'], token_endpoint_auth_method: 'none' });
      expect(confidential.client_secret).toBeTruthy(); expect(publicClient.client_secret).toBeUndefined();
      expect(await store.clients.getClient(confidential.client_id)).toEqual(confidential); expect(await store.clients.getClient('missing')).toBeUndefined();
    });
    it('refresh lease provides single flight and skips fresh credentials', async () => {
      const { store } = await open(); const s = { ...session(), nsExpiresAt: Date.now() + 1000 };
      await store.sessions.create({ accessToken: 'access', refreshToken: 'refresh' }, s);
      const refresh = vi.fn(async () => { await delay(10); return { access_token: 'new', expires_in: 3600 }; });
      const values = await Promise.all(Array.from({ length: 5 }, () => store.sessions.refreshUpstream('access', refresh, { pollIntervalMs: 5 })));
      expect(refresh).toHaveBeenCalledTimes(1); expect(values.every(value => value.nsAccessToken === 'new')).toBe(true);
      await store.sessions.refreshUpstream('access', refresh); expect(refresh).toHaveBeenCalledTimes(1);
    });
    it('late completion loses its lease and leaves newer credentials', async () => {
      const { store } = await open();
      await store.sessions.create({ accessToken: 'access', refreshToken: 'refresh' }, { ...session(), nsExpiresAt: Date.now() + 1000 });
      let release!: () => void;
      let started!: () => void;
      const began = new Promise<void>(resolve => { started = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      const first = store.sessions.refreshUpstream('access', async () => { started(); await held; return { access_token: 'old', expires_in: 3600 }; }, { leaseDurationMs: 10 });
      await began;
      await delay(20);
      const second = await store.sessions.refreshUpstream('access', async () => ({ access_token: 'new', expires_in: 3600 }));
      expect(second.nsAccessToken).toBe('new');
      release();
      await expect(first).rejects.toBeInstanceOf(LeaseLostError);
      expect((await store.sessions.get('access'))?.nsAccessToken).toBe('new');
    });
    it('deletion during refresh does not recreate a session', async () => {
      const { store } = await open();
      await store.sessions.create({ accessToken: 'access', refreshToken: 'refresh' }, { ...session(), nsExpiresAt: Date.now() + 1000 });
      await expect(store.sessions.refreshUpstream('access', async () => {
        await store.sessions.delete('access');
        return { access_token: 'new', expires_in: 3600 };
      })).rejects.toThrow();
      expect(await store.sessions.get('access')).toBeUndefined();
    });
    it('refresh wait timeout is retryable', async () => {
      const { store } = await open();
      await store.sessions.create({ accessToken: 'access', refreshToken: 'refresh' }, { ...session(), nsExpiresAt: Date.now() + 1000 });
      let release!: () => void;
      let started!: () => void;
      const began = new Promise<void>(resolve => { started = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      const first = store.sessions.refreshUpstream('access', async () => { started(); await held; return { access_token: 'new', expires_in: 3600 }; });
      await began;
      await expect(store.sessions.refreshUpstream('access', async () => ({ access_token: 'other' }), { maxWaitMs: 10, pollIntervalMs: 2 })).rejects.toBeInstanceOf(RetryableRefreshError);
      release(); await first;
    });
    it('capabilities match actual persistence and handle isolation', async () => {
      const { namespace, store } = await open();
      expect(store.capabilities).toEqual(target.capabilities); expect(store.backend).toBe(target.name);
      await store.sessions.create({ accessToken: 'access', refreshToken: 'refresh' }, session());
      if (target.capabilities.exclusive) {
        await expect(target.open(namespace)).rejects.toBeInstanceOf(StoreLockedError);
      } else {
        const other = await target.open(namespace);
        expect(Boolean(await other.sessions.get('access'))).toBe(target.capabilities.multiInstance);
        await other.close();
      }
      await store.close();
      const reopened = await target.open(namespace);
      expect(Boolean(await reopened.sessions.get('access'))).toBe(target.capabilities.persistent);
      await reopened.close();
    });
    it('namespaces isolate records', async () => {
      const a = await open(); const b = await open(); await a.store.sessions.create({ accessToken: 'access', refreshToken: 'refresh' }, session());
      expect(await b.store.sessions.get('access')).toBeUndefined();
    });
  });
}
