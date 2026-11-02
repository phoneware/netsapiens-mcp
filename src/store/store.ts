import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { createCodec, type Codec, LeaseLostError, RetryableRefreshError } from './codec.js';
import type {
  AccessRow,
  AtomicIssueParams,
  AuthCodeData,
  FamilyRow,
  McpStore,
  OAuthTokenPair,
  RefreshLookupResult,
  RefreshPointerRow,
  RefreshRotationResult,
  RevokeCondition,
  SessionRow,
  StoreBackend,
  StoredSession,
  StoredToken,
  UpstreamGrantRow,
  UpstreamTokens,
} from './types.js';
import { logger } from '../utils/logger.js';

export {
  ACCESS_RETENTION_MS,
  SESSION_RETENTION_MS,
  REFRESH_RETRY_WINDOW_MS,
  MAX_RETIRED_REFRESH_FINGERPRINTS,
  AUTH_CODE_TTL_MS,
  RESUME_TOKEN_TTL_MS,
  REFRESH_WAIT_MS,
  REFRESH_POLL_MS,
  REFRESH_LEASE_MS,
  REFRESH_SKEW_MS,
  accessAad,
  refreshAad,
  familyAad,
  upstreamAad,
  sessionAad,
} from './row-format.js';

export function createRegisteredClient(client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>): OAuthClientInformationFull {
  if ('_mcp_format' in (client as Record<string, unknown>)) {
    throw new Error("Invalid client metadata: reserved field '_mcp_format' cannot be set by client");
  }
  if ('_targetFormat' in (client as Record<string, unknown>)) {
    throw new Error("Invalid client metadata: reserved field '_targetFormat' cannot be set by client");
  }
  const full: OAuthClientInformationFull = { ...client, client_id: randomUUID(), client_id_issued_at: Math.floor(Date.now() / 1000) };
  if (client.token_endpoint_auth_method !== 'none') full.client_secret = randomBytes(32).toString('hex');
  else delete full.client_secret;
  return full;
}

interface FamilySealedData {
  clientId: string;
  serverBaseUrl?: string;
  extra?: Record<string, string>;
  retiredRefreshIds?: string[];
}

interface UpstreamSealedData {
  nsAccessToken: string;
  nsRefreshToken?: string;
  nsUsername: string;
  nsUserRole?: string;
  nsApiUrl?: string;
}

interface AccessSealedData {
  familyId: string;
  clientId: string;
  serverBaseUrl?: string;
  extra?: Record<string, string>;
}
async function decodeCurrentSession(
  family: FamilyRow,
  familyData: FamilySealedData,
  backend: StoreBackend,
  codec: Codec,
): Promise<StoredSession | undefined> {
  const access = await backend.getAccess(family.currentAccessTokenId);
  const upstream = await backend.getUpstream(family.id);
  if (!upstream) return undefined;

  const upstreamData = codec.open<UpstreamSealedData>(
    upstream.sealed,
    upstreamAad({ id: upstream.id, grantVersion: upstream.grantVersion }),
  );
  if (!upstreamData) return undefined;

  return {
    clientId: familyData.clientId,
    expiresAt: access?.expiresAt ?? 0,
    serverBaseUrl: familyData.serverBaseUrl,
    extra: familyData.extra,
    nsAccessToken: upstreamData.nsAccessToken,
    nsRefreshToken: upstreamData.nsRefreshToken,
    nsExpiresAt: upstream.nsExpiresAt,
    nsUsername: upstreamData.nsUsername,
    nsUserRole: upstreamData.nsUserRole,
    nsApiUrl: upstreamData.nsApiUrl,
    refreshFamilyId: family.id,
  };
}

export function createStore(backend: StoreBackend, { namespace, key }: { namespace: string; key: Uint8Array }): McpStore {
  const codec = createCodec(key);

  const decodeCode = (row: { id: string; expiresAt: number; sealed: string } | undefined, expected: { serverBaseUrl?: string; clientId?: string }): AuthCodeData | undefined => {
    if (!row || row.expiresAt <= Date.now()) return undefined;
    const data = codec.open<AuthCodeData>(row.sealed, `code:${row.id}`);
    if (!data) return undefined;
    if ((data.serverBaseUrl || expected.serverBaseUrl) && (!data.serverBaseUrl || !expected.serverBaseUrl || data.serverBaseUrl.toLowerCase() !== expected.serverBaseUrl.toLowerCase())) return undefined;
    if (expected.clientId && (data.clientId ?? data.pending.clientId) !== expected.clientId) return undefined;
    return data;
  };

  return {
    backend: backend.name,
    namespace,
    capabilities: backend.capabilities,
    sessions: {
      async create(tokens: OAuthTokenPair, session: StoredToken): Promise<StoredSession> {
        const familyId = (session as any).refreshFamilyId ?? randomUUID();
        const accessId = codec.id('session', tokens.accessToken);
        const refreshId = codec.id('refresh', tokens.refreshToken);
        const generation = 1;
        const grantVersion = 1;
        const now = Date.now();

        const accessRow: AccessRow = {
          id: accessId,
          familyId,
          expiresAt: session.expiresAt,
          retainUntil: session.expiresAt + ACCESS_RETENTION_MS,
          sealed: codec.seal({
            familyId,
            clientId: session.clientId,
            serverBaseUrl: session.serverBaseUrl,
            extra: session.extra,
          } satisfies AccessSealedData, accessAad({ id: accessId, familyId })),
        };

        const refreshRow: RefreshPointerRow = {
          id: refreshId,
          familyId,
          status: 'active',
          generation,
        };

        const familyRow: FamilyRow = {
          id: familyId,
          generation,
          status: 'active',
          activeRefreshId: refreshId,
          currentAccessTokenId: accessId,
          updatedAt: now,
          sealed: codec.seal({
            clientId: session.clientId,
            serverBaseUrl: session.serverBaseUrl,
            extra: session.extra,
            retiredRefreshIds: [],
          } satisfies FamilySealedData, familyAad({ id: familyId, generation })),
        };

        const upstreamRow: UpstreamGrantRow = {
          id: familyId,
          grantVersion,
          nsExpiresAt: session.nsExpiresAt,
          updatedAt: now,
          sealed: codec.seal({
            nsAccessToken: session.nsAccessToken,
            nsRefreshToken: session.nsRefreshToken,
            nsUsername: session.nsUsername,
            nsUserRole: session.nsUserRole,
            nsApiUrl: session.nsApiUrl,
          } satisfies UpstreamSealedData, upstreamAad({ id: familyId, grantVersion })),
        };

        await backend.atomicIssue({ accessRow, refreshRow, familyRow, upstreamRow });
        return {
          ...session,
          refreshFamilyId: familyId,
        };
      },

      async get(accessToken: string): Promise<StoredSession | undefined> {
        const id = codec.id('session', accessToken);
        const access = await backend.getAccess(id, accessToken);
        if (!access) {
          if (backend.getSession) {
            const v1Row = await backend.getSession(id);
            if (v1Row && v1Row.retainUntil > Date.now()) {
              const legacy = codec.open<StoredToken>(v1Row.sealed, sessionAad(v1Row));
              if (legacy) return { ...legacy, refreshFamilyId: 'legacy' };
            }
          }
          return undefined;
        }

        if (access.retainUntil <= Date.now()) return undefined;

        const accessData = codec.open<AccessSealedData>(
          access.sealed,
          accessAad({ id, familyId: access.familyId }),
        );
        if (!accessData) return undefined;

        const family = await backend.getFamily(access.familyId);
        if (!family || family.status !== 'active') return undefined;

        const familyData = codec.open<FamilySealedData>(
          family.sealed,
          familyAad({ id: family.id, generation: family.generation }),
        );
        if (!familyData) return undefined;

        const upstream = await backend.getUpstream(access.familyId);
        if (!upstream) return undefined;

        const upstreamData = codec.open<UpstreamSealedData>(
          upstream.sealed,
          upstreamAad({ id: upstream.id, grantVersion: upstream.grantVersion }),
        );
        if (!upstreamData) return undefined;

        return {
          clientId: familyData.clientId,
          expiresAt: access.expiresAt,
          serverBaseUrl: familyData.serverBaseUrl,
          extra: familyData.extra,
          nsAccessToken: upstreamData.nsAccessToken,
          nsRefreshToken: upstreamData.nsRefreshToken,
          nsExpiresAt: upstream.nsExpiresAt,
          nsUsername: upstreamData.nsUsername,
          nsUserRole: upstreamData.nsUserRole,
          nsApiUrl: upstreamData.nsApiUrl,
          refreshFamilyId: family.id,
        };
      },

      async getByRefreshToken(refreshToken: string): Promise<StoredSession | undefined> {
        const id = codec.id('refresh', refreshToken);
        const refresh = await backend.getRefresh(id, refreshToken);
        if (!refresh) {
          if (backend.findSessionByRefreshId) {
            const v1Row = await backend.findSessionByRefreshId(id);
            if (v1Row && v1Row.retainUntil > Date.now()) {
              const legacy = codec.open<StoredToken>(v1Row.sealed, sessionAad(v1Row));
              if (legacy) return { ...legacy, refreshFamilyId: 'legacy' };
            }
          }
          return undefined;
        }

        if (refresh.status !== 'active') return undefined;

        const family = await backend.getFamily(refresh.familyId);
        if (!family || family.status !== 'active') return undefined;

        const familyData = codec.open<FamilySealedData>(
          family.sealed,
          familyAad({ id: family.id, generation: family.generation }),
        );
        if (!familyData) return undefined;

        return await decodeCurrentSession(family, familyData, backend, codec);
      },

      async lookupRefresh(refreshToken: string, expectedClientId: string, now: number): Promise<RefreshLookupResult> {
        const id = codec.id('refresh', refreshToken);
        const refresh = await backend.getRefresh(id, refreshToken);
        if (!refresh) {
          if (backend.findFamilyByRetiredId) {
            let family = await backend.findFamilyByRetiredId(id);
            if (!family) {
              const legacyFp = createHash('sha256').update(refreshToken).digest('base64url');
              family = await backend.findFamilyByRetiredId(legacyFp);
            }
            if (family) {
              await backend.atomicRevokeFamily(family.id);
              return { status: 'replay', familyId: family.id };
            }
          }
          return { status: 'missing' };
        }

        const family = await backend.getFamily(refresh.familyId);
        if (!family || family.status !== 'active') {
          return { status: 'missing' };
        }

        const familyData = codec.open<FamilySealedData>(
          family.sealed,
          familyAad({ id: family.id, generation: family.generation }),
        );
        if (!familyData) return { status: 'missing' };

        if (expectedClientId && familyData.clientId !== expectedClientId) {
          return { status: 'missing' };
        }

        if (refresh.status === 'consumed') {
          const withinRetry = refresh.consumedAt !== undefined && now - refresh.consumedAt <= REFRESH_RETRY_WINDOW_MS;
          if (withinRetry && refresh.successorSealed) {
            const tokens = codec.open<OAuthTokenPair>(
              refresh.successorSealed,
              `successor:${refresh.id}`,
            );
            if (tokens) {
              const session = await decodeCurrentSession(family, familyData, backend, codec);
              if (session) {
                return { status: 'retry', familyId: family.id, generation: family.generation, session, tokens };
              }
            }
          }
          // Outside retry window -> replay! Revoke family
          await backend.atomicRevokeFamily(family.id);
          return { status: 'replay', familyId: family.id };
        }

        const session = await decodeCurrentSession(family, familyData, backend, codec);
        if (!session) return { status: 'missing' };

        const upstream = await backend.getUpstream(family.id);
        return { status: 'active', familyId: family.id, generation: family.generation, grantVersion: upstream?.grantVersion, session };
      },

      async rotate(
        oldRefreshToken: string,
        replacement: { tokens: OAuthTokenPair; session: StoredToken },
        expectedClientId: string,
        now: number,
      ): Promise<RefreshRotationResult> {
        const oldRefreshId = codec.id('refresh', oldRefreshToken);
        const newAccessId = codec.id('session', replacement.tokens.accessToken);
        const newRefreshId = codec.id('refresh', replacement.tokens.refreshToken);

        const oldRef = await backend.getRefresh(oldRefreshId, oldRefreshToken);
        const family = oldRef ? await backend.getFamily(oldRef.familyId) : undefined;
        const familyData = family
          ? codec.open<FamilySealedData>(family.sealed, familyAad({ id: family.id, generation: family.generation }))
          : undefined;

        const nextGen = (family?.generation ?? 0) + 1;
        const familyId = family?.id ?? randomUUID();

        const retiredList = [...(familyData?.retiredRefreshIds ?? [])];
        retiredList.push(oldRefreshId);
        while (retiredList.length > MAX_RETIRED_REFRESH_FINGERPRINTS) {
          retiredList.shift();
        }

        const newAccessRow: AccessRow = {
          id: newAccessId,
          familyId,
          expiresAt: replacement.session.expiresAt,
          retainUntil: replacement.session.expiresAt + ACCESS_RETENTION_MS,
          sealed: codec.seal({
            familyId,
            clientId: replacement.session.clientId,
            serverBaseUrl: replacement.session.serverBaseUrl,
            extra: replacement.session.extra,
          } satisfies AccessSealedData, accessAad({ id: newAccessId, familyId })),
        };

        const newRefreshRow: RefreshPointerRow = {
          id: newRefreshId,
          familyId,
          status: 'active',
          generation: nextGen,
        };

        const newFamilySealed = codec.seal({
          clientId: replacement.session.clientId,
          serverBaseUrl: replacement.session.serverBaseUrl,
          extra: replacement.session.extra,
          retiredRefreshIds: retiredList,
        } satisfies FamilySealedData, familyAad({ id: familyId, generation: nextGen }));

        const newSuccessorSealed = codec.seal(replacement.tokens, `successor:${oldRefreshId}`);

        const upstream = family ? await backend.getUpstream(family.id) : undefined;
        const nextGrantVersion = (upstream?.grantVersion ?? 0) + 1;
        const newUpstreamSealed = replacement.session.nsAccessToken
          ? codec.seal({
              nsAccessToken: replacement.session.nsAccessToken,
              nsRefreshToken: replacement.session.nsRefreshToken,
              nsUsername: replacement.session.nsUsername,
              nsUserRole: replacement.session.nsUserRole,
              nsApiUrl: replacement.session.nsApiUrl,
            } satisfies UpstreamSealedData, upstreamAad({ id: familyId, grantVersion: nextGrantVersion }))
          : undefined;

        const rotateResult = await backend.atomicRotate({
          oldRefreshId,
          expectedClientId,
          now,
          newAccessRow,
          newRefreshRow,
          newSuccessorSealed,
          newFamilySealed,
          newUpstreamSealed,
          newNsExpiresAt: replacement.session.nsExpiresAt,
          retiredFingerprint: oldRefreshId,
          legacyFingerprint: createHash('sha256').update(oldRefreshToken).digest('base64url'),
        });

        if (rotateResult.status === 'claimed') {
          return {
            status: 'claimed',
            familyId: rotateResult.familyId,
            session: {
              ...replacement.session,
              refreshFamilyId: rotateResult.familyId,
            },
            tokens: replacement.tokens,
          };
        }

        if (rotateResult.status === 'retry') {
          const tokens = codec.open<OAuthTokenPair>(rotateResult.successorSealed, `successor:${oldRefreshId}`);
          const curFamily = await backend.getFamily(rotateResult.familyId);
          const curData = curFamily
            ? codec.open<FamilySealedData>(curFamily.sealed, familyAad({ id: curFamily.id, generation: curFamily.generation }))
            : undefined;
          const session = curFamily && curData ? await decodeCurrentSession(curFamily, curData, backend, codec) : undefined;
          return {
            status: 'retry',
            familyId: rotateResult.familyId,
            session: session!,
            tokens: tokens!,
          };
        }

        if (rotateResult.status === 'replay') {
          return { status: 'replay' };
        }

        return { status: 'missing' };
      },

      async revokeFamily(familyId: string, condition?: RevokeCondition): Promise<'revoked' | 'stale' | 'missing'> {
        return await backend.atomicRevokeFamily(familyId, condition);
      },

      async revokeByToken(token: string): Promise<void> {
        const accessId = codec.id('session', token);
        const access = await backend.getAccess(accessId);
        if (access) {
          await backend.atomicRevokeFamily(access.familyId);
          return;
        }

        const refreshId = codec.id('refresh', token);
        const refresh = await backend.getRefresh(refreshId);
        if (refresh) {
          await backend.atomicRevokeFamily(refresh.familyId);
          return;
        }

        if (backend.findFamilyByRetiredId) {
          const family = await backend.findFamilyByRetiredId(refreshId);
          if (family) {
            await backend.atomicRevokeFamily(family.id);
            return;
          }
        }

        // Compatibility fallback
        if (backend.deleteSession) {
          await backend.deleteSession(accessId).catch(() => {});
        }
      },

      async delete(token: string): Promise<void> {
        await this.revokeByToken(token);
      },

      async deleteByRefreshToken(token: string): Promise<void> {
        await this.revokeByToken(token);
      },

      async refreshUpstream(
        familyIdOrToken: string,
        doRefresh: (session: StoredSession) => Promise<UpstreamTokens>,
        options?: {
          force?: boolean;
          maxWaitMs?: number;
          pollIntervalMs?: number;
          leaseDurationMs?: number;
        },
      ): Promise<StoredSession> {
        let familyId = familyIdOrToken;
        const accessId = codec.id('session', familyIdOrToken);
        const access = await backend.getAccess(accessId);
        if (access) {
          familyId = access.familyId;
        }
        const initialUpstream = await backend.getUpstream(familyId);
        const startGrantVersion = initialUpstream?.grantVersion ?? 0;
        const start = Date.now();
        const maxWait = options?.maxWaitMs ?? REFRESH_WAIT_MS;
        const owner = randomUUID();

        while (Date.now() - start < maxWait) {
          const now = Date.now();
          const upstream = await backend.getUpstream(familyId);
          if (!upstream) {
            // Compatibility check for v1 getSession
            if (backend.getSession && access) {
              const v1Row = await backend.getSession(accessId);
              if (v1Row) {
                // v1 refresh flow
                const legacy = codec.open<StoredToken>(v1Row.sealed, sessionAad(v1Row));
                if (legacy) {
                  const refreshed = await doRefresh({ ...legacy, refreshFamilyId: 'legacy' });
                  return { ...legacy, ...refreshed, refreshFamilyId: 'legacy' };
                }
              }
            }
            throw new Error('Token document not found');
          }

          if (upstream.leaseOwner && upstream.leaseUntil && upstream.leaseUntil > now) {
            await delay(options?.pollIntervalMs ?? REFRESH_POLL_MS);
            continue;
          }

          const peerRefreshed = upstream.grantVersion > startGrantVersion;
          const stillValid = !options?.force && upstream.nsExpiresAt && now <= upstream.nsExpiresAt - REFRESH_SKEW_MS;
          if (peerRefreshed || stillValid) {
            const family = await backend.getFamily(familyId);
            if (family && family.status === 'active') {
              const familyData = codec.open<FamilySealedData>(family.sealed, familyAad({ id: family.id, generation: family.generation }));
              if (familyData) {
                const s = await decodeCurrentSession(family, familyData, backend, codec);
                if (s) return s;
              }
            }
          }

          const updated = await backend.updateUpstream(familyId, (cur) => {
            if (cur.grantVersion > startGrantVersion) return undefined;
            if (cur.leaseOwner && cur.leaseUntil && cur.leaseUntil > Date.now()) return undefined;
            return {
              ...cur,
              leaseOwner: owner,
              leaseUntil: Date.now() + (options?.leaseDurationMs ?? REFRESH_LEASE_MS),
            };
          });

          if (!updated || updated.leaseOwner !== owner) {
            await delay(options?.pollIntervalMs ?? REFRESH_POLL_MS);
            continue;
          }

          try {
            const family = await backend.getFamily(familyId);
            if (!family || family.status !== 'active') throw new Error('Family revoked during refresh');
            const familyData = codec.open<FamilySealedData>(family.sealed, familyAad({ id: family.id, generation: family.generation }));
            if (!familyData) throw new Error('Failed to open family data');
            const session = await decodeCurrentSession(family, familyData, backend, codec);
            if (!session) throw new Error('Token document not found');

            const refreshed = await doRefresh(session);
            const newNsExpiresAt = refreshed.expires_in ? Date.now() + refreshed.expires_in * 1000 : undefined;
            const newGrantVersion = updated.grantVersion + 1;
            const newSealed = codec.seal({
              nsAccessToken: refreshed.access_token,
              nsRefreshToken: refreshed.refresh_token ?? session.nsRefreshToken,
              nsUsername: session.nsUsername,
              nsUserRole: session.nsUserRole,
              nsApiUrl: session.nsApiUrl,
            } satisfies UpstreamSealedData, upstreamAad({ id: familyId, grantVersion: newGrantVersion }));

            const finished = await backend.updateUpstream(familyId, (cur) => {
              if (cur.leaseOwner !== owner) return undefined;
              return {
                ...cur,
                grantVersion: newGrantVersion,
                nsExpiresAt: newNsExpiresAt,
                leaseOwner: undefined,
                leaseUntil: undefined,
                updatedAt: Date.now(),
                sealed: newSealed,
              };
            });

            if (!finished) throw new LeaseLostError();

            return {
              ...session,
              nsAccessToken: refreshed.access_token,
              nsRefreshToken: refreshed.refresh_token ?? session.nsRefreshToken,
              nsExpiresAt: newNsExpiresAt,
            };
          } catch (error: any) {
            if (error?.name === 'UpstreamGrantRejectedError' || error?.isDefinitive === true) {
              const fam = await backend.getFamily(familyId).catch(() => undefined);
              if (fam) {
                await backend.atomicRevokeFamily(familyId, {
                  expectedFamilyGeneration: fam.generation,
                  expectedUpstreamGrantVersion: updated.grantVersion,
                  expectedLeaseOwner: owner,
                }).catch(() => {});
              }
            }
            await backend.updateUpstream(familyId, (cur) => {
              if (cur.leaseOwner !== owner) return undefined;
              return { ...cur, leaseOwner: undefined, leaseUntil: undefined };
            }).catch(() => {});
            throw error;
          }
        }

        const latestUpstream = await backend.getUpstream(familyId);
        if (latestUpstream && (!latestUpstream.nsExpiresAt || Date.now() <= latestUpstream.nsExpiresAt - REFRESH_SKEW_MS)) {
          const family = await backend.getFamily(familyId);
          if (family && family.status === 'active') {
            const familyData = codec.open<FamilySealedData>(family.sealed, familyAad({ id: family.id, generation: family.generation }));
            if (familyData) {
              const s = await decodeCurrentSession(family, familyData, backend, codec);
              if (s) return s;
            }
          }
        }
        throw new RetryableRefreshError();
      },
    },

    authCodes: {
      async put(code: string, data: AuthCodeData): Promise<void> {
        const id = codec.id('code', code);
        await backend.putAuthCode({ id, expiresAt: Date.now() + AUTH_CODE_TTL_MS, sealed: codec.seal(data, `code:${id}`) });
      },
      async getChallenge(code: string, expected: { serverBaseUrl?: string; clientId?: string }): Promise<string | undefined> {
        return decodeCode(await backend.getAuthCode(codec.id('code', code)), expected)?.pending.codeChallenge;
      },
      async getEntry(code: string, expected: { serverBaseUrl?: string; clientId?: string }): Promise<{ data: AuthCodeData; sealed: string } | undefined> {
        const id = codec.id('code', code);
        const row = await backend.getAuthCode(id);
        const decoded = decodeCode(row, expected);
        if (!decoded || !row) return undefined;
        return { data: decoded, sealed: row.sealed };
      },
      async redeem(code: string, expected: { serverBaseUrl?: string; clientId?: string }): Promise<AuthCodeData | undefined> {
        const id = codec.id('code', code);
        if (!decodeCode(await backend.getAuthCode(id), expected)) return undefined;
        return decodeCode(await backend.takeAuthCode(id), expected);
      },
      async redeemAndIssue(
        code: string,
        expected: { serverBaseUrl?: string; clientId?: string },
        tokens: { accessToken: string; refreshToken: string },
        stored: StoredToken,
        expectedSealed?: string,
      ): Promise<AuthCodeData | undefined> {
        const codeId = codec.id('code', code);
        const row = await backend.getAuthCode(codeId);
        const existing = decodeCode(row, expected);
        if (!existing || !row) return undefined;

        const accessId = codec.id('session', tokens.accessToken);
        const refreshId = codec.id('refresh', tokens.refreshToken);
        const familyId = randomUUID();
        const generation = 1;
        const grantVersion = 1;
        const now = Date.now();
        const retainUntil = stored.expiresAt + ACCESS_RETENTION_MS;

        const issueParams: AtomicIssueParams = {
          accessRow: {
            id: accessId,
            familyId,
            expiresAt: stored.expiresAt,
            retainUntil,
            sealed: codec.seal({
              familyId,
              clientId: stored.clientId,
              serverBaseUrl: stored.serverBaseUrl,
              extra: stored.extra,
            }, accessAad({ id: accessId, familyId })),
          },
          refreshRow: {
            id: refreshId,
            familyId,
            status: 'active',
            generation,
          },
          familyRow: {
            id: familyId,
            generation,
            status: 'active',
            activeRefreshId: refreshId,
            currentAccessTokenId: accessId,
            updatedAt: now,
            sealed: codec.seal({
              clientId: stored.clientId,
              serverBaseUrl: stored.serverBaseUrl,
              extra: stored.extra,
              retiredRefreshIds: [],
            }, familyAad({ id: familyId, generation })),
          },
          upstreamRow: {
            id: familyId,
            grantVersion,
            nsExpiresAt: stored.nsExpiresAt,
            updatedAt: now,
            sealed: codec.seal({
              nsAccessToken: stored.nsAccessToken,
              nsRefreshToken: stored.nsRefreshToken,
              nsUsername: stored.nsUsername,
              nsUserRole: stored.nsUserRole,
              nsApiUrl: stored.nsApiUrl,
            }, upstreamAad({ id: familyId, grantVersion })),
          },
        };

        if (backend.atomicRedeemCodeAndIssue) {
          const redeemedRow = await backend.atomicRedeemCodeAndIssue({
            codeId,
            expectedSealed: expectedSealed ?? row.sealed,
            now,
            issue: issueParams,
          });
          return redeemedRow ? decodeCode(redeemedRow, expected) : undefined;
        }

        const redeemed = decodeCode(await backend.takeAuthCode(codeId), expected);
        if (!redeemed) return undefined;
        await backend.atomicIssue(issueParams);
        return redeemed;
      },
    },

    resumeTokens: {
      async consume(id: string): Promise<boolean> {
        const now = Date.now();
        return backend.insertResumeIfAbsent({ id, consumedAt: now, expiresAt: now + RESUME_TOKEN_TTL_MS }, now);
      },
    },

    usage: {
      async recordCall(userKey: string, toolName: string): Promise<void> {
        try {
          await backend.incrementUsage(codec.id('user', userKey), toolName, Date.now());
        } catch (error) {
          logger.warn('Failed to record usage', { error: String(error) });
        }
      },
      async getUserUsage(userKey: string): Promise<Map<string, { count: number; lastUsed: number }>> {
        try {
          return new Map((await backend.listUsage(codec.id('user', userKey))).map(({ toolName, count, lastUsed }) => [toolName, { count, lastUsed }]));
        } catch (error) {
          logger.warn('Failed to read usage', { error: String(error) });
          return new Map();
        }
      },
    },

    clients: {
      async getClient(id: string): Promise<OAuthClientInformationFull | undefined> {
        return backend.getClient(id);
      },
      async registerClient(client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>): Promise<OAuthClientInformationFull> {
        const full = createRegisteredClient(client);
        await backend.putClient(full);
        return full;
      },
    },

    sweep: (now: number) => backend.sweep(now),
    close: () => backend.close(),
  };
}
