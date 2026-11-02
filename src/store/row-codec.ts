import type { Codec } from './codec.js';
import {
  ACCESS_RETENTION_MS,
  accessAad,
  familyAad,
  upstreamAad,
} from './row-format.js';
import type {
  AccessRow,
  AccessSealedData,
  AuthCodeRow,
  FamilyRow,
  FamilySealedData,
  RefreshPointerRow,
  ResumeRow,
  UpstreamGrantRow,
  UpstreamSealedData,
} from './types.js';

export function encodeSessionsRow(
  codec: Codec,
  accessId: string,
  familyId: string,
  session: {
    expiresAt: number;
    clientId: string;
    serverBaseUrl?: string;
    extra?: Record<string, string>;
  },
  now: number,
): AccessRow & { v: 2; ttlAt: Date; updatedAt: number } {
  const expiresAt = session.expiresAt;
  const retainUntil = expiresAt + ACCESS_RETENTION_MS;
  const sealed = codec.seal(
    {
      familyId,
      clientId: session.clientId,
      serverBaseUrl: session.serverBaseUrl,
      extra: session.extra,
    } satisfies AccessSealedData,
    accessAad({ id: accessId, familyId }),
  );
  return {
    id: accessId,
    familyId,
    expiresAt,
    retainUntil,
    ttlAt: new Date(retainUntil),
    sealed,
    v: 2,
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
  session: {
    clientId: string;
    serverBaseUrl?: string;
    extra?: Record<string, string>;
  },
  retiredFingerprints: string[],
  status: 'active' | 'revoked',
  now: number,
): FamilyRow & { v: 2 } {
  const sealed = codec.seal(
    {
      clientId: session.clientId,
      serverBaseUrl: session.serverBaseUrl,
      extra: session.extra,
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
  upstream: {
    nsAccessToken: string;
    nsRefreshToken?: string;
    nsUsername: string;
    nsUserRole?: string;
    nsApiUrl?: string;
    nsExpiresAt?: number;
  },
  now: number,
): UpstreamGrantRow & { v: 2 } {
  const sealed = codec.seal(
    {
      nsAccessToken: upstream.nsAccessToken,
      nsRefreshToken: upstream.nsRefreshToken,
      nsUsername: upstream.nsUsername,
      nsUserRole: upstream.nsUserRole,
      nsApiUrl: upstream.nsApiUrl,
    } satisfies UpstreamSealedData,
    upstreamAad({ id: familyId, grantVersion }),
  );
  return {
    id: familyId,
    grantVersion,
    nsExpiresAt: upstream.nsExpiresAt,
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
): RefreshPointerRow & { v: 2; createdAt: number; updatedAt: number } {
  return {
    id: refreshId,
    familyId,
    generation,
    status: 'active',
    v: 2,
    createdAt: now,
    updatedAt: now,
  };
}

export function encodeAuthCodesRow(
  codec: Codec,
  code: string,
  data: {
    pending: {
      clientId: string;
      codeChallenge?: string;
      redirectUri: string;
      createdAt: number;
      state?: string | null;
      scopes?: string[];
    };
    nsTokens: {
      access_token: string;
      refresh_token?: string | null;
      username?: string | null;
      nsUserRole?: string | null;
      nsApiUrl?: string | null;
    };
    clientId: string;
    serverBaseUrl?: string | null;
    extra?: Record<string, unknown>;
  },
  expiresAt: number,
  now: number,
): AuthCodeRow & { v: 2; ttlAt: Date } {
  const id = codec.id('code', code);
  const sealed = codec.seal(data, `code:${id}`);
  return {
    id,
    expiresAt,
    ttlAt: new Date(expiresAt),
    sealed,
    v: 2,
  };
}

export function encodeResumeTokensRow(
  id: string,
  consumedAt: number,
  expiresAt: number,
  now: number,
): ResumeRow & { v: 2; ttlAt: Date; _mcp_format: 'v3_target' } {
  return {
    id,
    consumedAt,
    expiresAt,
    ttlAt: new Date(expiresAt),
    _mcp_format: 'v3_target',
    v: 2,
  };
}

export function encodeOAuthClientsRow(
  clientId: string,
  clientData: {
    client_name?: string | null;
    redirect_uris: string[];
    token_endpoint_auth_method?: string;
    client_secret?: string | null;
    grant_types?: string[];
    response_types?: string[];
    client_uri?: string | null;
    logo_uri?: string | null;
    scope?: string | null;
    client_id_issued_at?: number | null;
  },
  now: number,
): Record<string, unknown> {
  return {
    client_id: clientId,
    client_name: clientData.client_name ?? null,
    redirect_uris: clientData.redirect_uris,
    token_endpoint_auth_method: clientData.token_endpoint_auth_method ?? 'client_secret_basic',
    client_secret: clientData.client_secret ?? null,
    grant_types: clientData.grant_types ?? ['authorization_code', 'refresh_token'],
    response_types: clientData.response_types ?? ['code'],
    client_uri: clientData.client_uri ?? null,
    logo_uri: clientData.logo_uri ?? null,
    scope: clientData.scope ?? null,
    client_id_issued_at: clientData.client_id_issued_at ?? Math.floor(now / 1000),
    _mcp_format: 'v3_target',
    v: 2,
  };
}
