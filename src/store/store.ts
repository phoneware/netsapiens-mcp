import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { createCodec, LeaseLostError, RetryableRefreshError } from './codec.js';
import type { AuthCodeData, McpStore, SessionRow, StoreBackend, StoredToken } from './types.js';
import { logger } from '../utils/logger.js';

export const SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
export const RESUME_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
export const REFRESH_WAIT_MS = 15_000;
export const REFRESH_POLL_MS = 150;
export const REFRESH_LEASE_MS = 15_000;
export const REFRESH_SKEW_MS = 60_000;

export function createStore(backend: StoreBackend, { namespace, key }: { namespace: string; key: Uint8Array }): McpStore {
  const codec = createCodec(key);
  const decodeSession = (row?: SessionRow): StoredToken | undefined => row && row.retainUntil > Date.now() ? codec.open<StoredToken>(row.sealed, `session:${row.id}`) : undefined;
  const decodeCode = (row: { id: string; expiresAt: number; sealed: string } | undefined, expected: { serverBaseUrl?: string; clientId?: string }): AuthCodeData | undefined => {
    if (!row || row.expiresAt <= Date.now()) return undefined;
    const data = codec.open<AuthCodeData>(row.sealed, `code:${row.id}`);
    if (!data) return undefined;
    if ((data.serverBaseUrl || expected.serverBaseUrl) && (!data.serverBaseUrl || !expected.serverBaseUrl || data.serverBaseUrl.toLowerCase() !== expected.serverBaseUrl.toLowerCase())) return undefined;
    if (expected.clientId && (data.clientId ?? data.pending.clientId) !== expected.clientId) return undefined;
    return data;
  };
  return {
    backend: backend.name, namespace, capabilities: backend.capabilities,
    sessions: {
      async create(tokens, session) {
        const id = codec.id('session', tokens.accessToken);
        await backend.putSession({ id, refreshId: codec.id('refresh', tokens.refreshToken), expiresAt: session.expiresAt, retainUntil: session.expiresAt + SESSION_RETENTION_MS, ...(session.nsExpiresAt === undefined ? {} : { nsExpiresAt: session.nsExpiresAt }), sealed: codec.seal(session, `session:${id}`) });
      },
      async get(token) { return decodeSession(await backend.getSession(codec.id('session', token))); },
      async getByRefreshToken(token) { return decodeSession(await backend.findSessionByRefreshId(codec.id('refresh', token))); },
      async delete(token) { await backend.deleteSession(codec.id('session', token)); },
      async deleteByRefreshToken(token) { const row = await backend.findSessionByRefreshId(codec.id('refresh', token)); if (row) await backend.deleteSession(row.id); },
      async refreshUpstream(token, doRefresh, opts) {
        const id = codec.id('session', token);
        const start = Date.now();
        const maxWait = opts?.maxWaitMs ?? REFRESH_WAIT_MS;
        while (Date.now() - start < maxWait) {
          const owner = randomUUID();
          const now = Date.now();
          const row = await backend.updateSession(id, row => {
            const value = row.retainUntil > now ? codec.open<StoredToken>(row.sealed, `session:${id}`) : undefined;
            if (!value || !row.nsExpiresAt || now <= row.nsExpiresAt - REFRESH_SKEW_MS) return undefined;
            if (row.leaseOwner && row.leaseUntil && row.leaseUntil > now) return undefined;
            return { ...row, leaseOwner: owner, leaseUntil: now + (opts?.leaseDurationMs ?? REFRESH_LEASE_MS) };
          });
          const current = decodeSession(row);
          if (!current) throw new Error('Token document not found');
          if (row?.leaseOwner !== owner) {
            if (!row?.nsExpiresAt || Date.now() <= row.nsExpiresAt - REFRESH_SKEW_MS) return current;
            await delay(opts?.pollIntervalMs ?? REFRESH_POLL_MS);
            continue;
          }
          try {
            const refreshed = await doRefresh(current);
            const updated: StoredToken = { ...current, nsAccessToken: refreshed.access_token, nsRefreshToken: refreshed.refresh_token ?? current.nsRefreshToken, nsExpiresAt: refreshed.expires_in ? Date.now() + refreshed.expires_in * 1000 : undefined };
            const sealed = codec.seal(updated, `session:${id}`);
            const finished = await backend.updateSession(id, row => {
              if (row.leaseOwner !== owner) return undefined;
              const { leaseOwner: _owner, leaseUntil: _until, nsExpiresAt: _oldExpiry, ...rest } = row;
              return { ...rest, ...(updated.nsExpiresAt === undefined ? {} : { nsExpiresAt: updated.nsExpiresAt }), sealed };
            });
            if (!finished) throw new Error('Token document was deleted/revoked during refresh');
            if (finished.sealed !== sealed) throw new LeaseLostError();
            return updated;
          } catch (error) {
            await backend.updateSession(id, row => {
              if (row.leaseOwner !== owner) return undefined;
              const { leaseOwner: _owner, leaseUntil: _until, ...rest } = row;
              return rest;
            }).catch(() => { });
            throw error;
          }
        }
        const latestRow = await backend.getSession(id);
        const latest = decodeSession(latestRow);
        if (latest && (!latestRow?.nsExpiresAt || Date.now() <= latestRow.nsExpiresAt - REFRESH_SKEW_MS)) return latest;
        throw new RetryableRefreshError();
      },
    },
    authCodes: {
      async put(code, data) { const id = codec.id('code', code); await backend.putAuthCode({ id, expiresAt: Date.now() + AUTH_CODE_TTL_MS, sealed: codec.seal(data, `code:${id}`) }); },
      async getChallenge(code, expected) { return decodeCode(await backend.getAuthCode(codec.id('code', code)), expected)?.pending.codeChallenge; },
      async redeem(code, expected) {
        const id = codec.id('code', code);
        if (!decodeCode(await backend.getAuthCode(id), expected)) return undefined;
        return decodeCode(await backend.takeAuthCode(id), expected);
      },
    },
    resumeTokens: { async consume(id) { const now = Date.now(); return backend.insertResumeIfAbsent({ id, consumedAt: now, expiresAt: now + RESUME_TOKEN_TTL_MS }, now); } },
    usage: {
      async recordCall(userKey, toolName) { try { await backend.incrementUsage(codec.id('user', userKey), toolName, Date.now()); } catch (error) { logger.warn('Failed to record usage', { error: String(error) }); } },
      async getUserUsage(userKey) { try { return new Map((await backend.listUsage(codec.id('user', userKey))).map(({ toolName, count, lastUsed }) => [toolName, { count, lastUsed }])); } catch (error) { logger.warn('Failed to read usage', { error: String(error) }); return new Map(); } },
    },
    clients: {
      async getClient(id) { return backend.getClient(id); },
      async registerClient(client) {
        const full: OAuthClientInformationFull = { ...client, client_id: randomUUID(), client_id_issued_at: Math.floor(Date.now() / 1000) };
        if (client.token_endpoint_auth_method !== 'none') full.client_secret = randomBytes(32).toString('hex');
        else delete full.client_secret;
        await backend.putClient(full);
        return full;
      },
    },
    close: () => backend.close(),
  };
}
