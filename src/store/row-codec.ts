import type { Codec } from './codec.js';
import {
  ACCESS_RETENTION_MS,
  accessAad,
  familyAad,
  upstreamAad,
} from './row-format.js';
import { CutoverFenceError } from './errors.js';
import type {
  AccessRow,
  AccessSealedData,
  AuthCodeData,
  FamilyRow,
  FamilySealedData,
  RefreshPointerRow,
  UpstreamGrantRow,
  UpstreamSealedData,
} from './types.js';

export function encodeSessionsRow(
  codec: Codec,
  accessId: string,
  familyId: string,
  logicalProjection: {
    expiresAt: number;
    nsAccessToken: string;
    nsUsername: string;
    extra?: Record<string, unknown>;
  },
  now: number,
): AccessRow {
  const expiresAt = logicalProjection.expiresAt;
  const retainUntil = expiresAt + ACCESS_RETENTION_MS;
  const sealed = codec.seal(
    {
      nsAccessToken: logicalProjection.nsAccessToken,
      nsUsername: logicalProjection.nsUsername,
      extra: logicalProjection.extra,
    } satisfies AccessSealedData,
    accessAad({ id: accessId, familyId }),
  );
  return {
    id: accessId,
    familyId,
    expiresAt,
    retainUntil,
    ttlAt: retainUntil,
    sealed,
    updatedAt: now,
  };
}

export function decodeSessionsRow(
  codec: Codec,
  row: AccessRow,
): AccessSealedData | undefined {
  return codec.open<AccessSealedData>(
    row.sealed,
    accessAad({ id: row.id, familyId: row.familyId }),
  );
}

export function encodeRefreshFamiliesRow(
  codec: Codec,
  familyId: string,
  generation: number,
  activeRefreshId: string,
  currentAccessTokenId: string,
  logicalProjection: {
    clientId: string;
    serverBaseUrl: string;
    extra?: Record<string, unknown>;
  },
  retiredFingerprints: string[],
  status: 'active' | 'revoked',
  now: number,
): FamilyRow {
  const sealed = codec.seal(
    {
      clientId: logicalProjection.clientId,
      serverBaseUrl: logicalProjection.serverBaseUrl,
      extra: logicalProjection.extra,
      retiredRefreshIds: retiredFingerprints,
    } satisfies FamilySealedData,
    familyAad({ id: familyId, generation }),
  );
  return {
    id: familyId,
    generation,
    status: status === 'revoked' ? 'revoked' : 'active',
    activeRefreshId,
    currentAccessTokenId,
    updatedAt: now,
    sealed,
    v: 2,
  };
}

export function decodeRefreshFamiliesRow(
  codec: Codec,
  row: FamilyRow,
): FamilySealedData | undefined {
  return codec.open<FamilySealedData>(
    row.sealed,
    familyAad({ id: row.id, generation: row.generation }),
  );
}

export function encodeUpstreamRow(
  codec: Codec,
  familyId: string,
  grantVersion: number,
  logicalProjection: {
    upstream: {
      nsRefreshToken?: string;
      nsExpiresAt?: number;
      nsApiUrl?: string;
    };
  },
  now: number,
): UpstreamGrantRow {
  const sealed = codec.seal(
    {
      nsRefreshToken: logicalProjection.upstream.nsRefreshToken,
      nsApiUrl: logicalProjection.upstream.nsApiUrl,
    } satisfies UpstreamSealedData,
    upstreamAad({ id: familyId, grantVersion }),
  );
  return {
    id: familyId,
    grantVersion,
    nsExpiresAt: logicalProjection.upstream.nsExpiresAt,
    updatedAt: now,
    sealed,
    v: 2,
  };
}

export function decodeUpstreamRow(
  codec: Codec,
  row: UpstreamGrantRow,
): UpstreamSealedData | undefined {
  return codec.open<UpstreamSealedData>(
    row.sealed,
    upstreamAad({ id: row.id, grantVersion: row.grantVersion }),
  );
}

export function encodeRefreshRow(
  refreshId: string,
  familyId: string,
  generation: number,
  now: number,
): RefreshPointerRow {
  return {
    id: refreshId,
    familyId,
    generation,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
}

export function encodeAuthCodesRow(
  docId: string,
  logicalProjection: {
    clientId: string;
    redirectUri: string;
    codeChallenge?: string;
    codeChallengeMethod?: string;
    scope?: string;
    expiresAt: number;
    extra?: Record<string, unknown>;
  },
  now: number,
): AuthCodeData {
  return {
    code: docId,
    clientId: logicalProjection.clientId,
    redirectUri: logicalProjection.redirectUri,
    codeChallenge: logicalProjection.codeChallenge,
    codeChallengeMethod: logicalProjection.codeChallengeMethod,
    scope: logicalProjection.scope,
    expiresAt: logicalProjection.expiresAt,
    ttlAt: logicalProjection.expiresAt,
    extra: logicalProjection.extra,
    used: false,
    createdAt: now,
  };
}

export function encodeResumeTokensRow(
  docId: string,
  logicalProjection: {
    clientId: string;
    expiresAt: number;
    consumedAt: number;
  },
  now: number,
): Record<string, unknown> {
  return {
    id: docId,
    clientId: logicalProjection.clientId,
    expiresAt: logicalProjection.expiresAt,
    ttlAt: logicalProjection.expiresAt,
    consumedAt: logicalProjection.consumedAt,
    createdAt: now,
  };
}

export function encodeOAuthClientsRow(
  docId: string,
  logicalProjection: {
    clientName?: string;
    redirectUris: string[];
    tokenEndpointAuthMethod?: string;
    clientSecretHash?: string;
  },
  now: number,
): Record<string, unknown> {
  return {
    client_id: docId,
    client_name: logicalProjection.clientName,
    redirect_uris: logicalProjection.redirectUris,
    token_endpoint_auth_method: logicalProjection.tokenEndpointAuthMethod,
    client_secret_hash: logicalProjection.clientSecretHash,
    updatedAt: now,
  };
}
