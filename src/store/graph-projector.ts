import type { Codec } from './codec.js';
import { accessAad, familyAad, upstreamAad } from './store.js';
import { CutoverFenceError } from '../auth/kit/cutover-fence.js';
import type { AuthCodeData } from './types.js';

export const GRAPH_PROJECTOR_ID = 'netsapiens-mcp/v2-v3-projector' as const;
export const GRAPH_PROJECTOR_VERSION = 1 as const;

export function codeUnitCompare(a: string, b: string): number {
  return a < b ? -1 : (a > b ? 1 : 0);
}

export interface CandidateCommitment {
  id: string;
  kind: string;
  sources: Array<{ collection: string; id: string; recordDigest: string }>;
  targets: Array<{ collection: string; id: string }>;
  logicalDigest: string;
}

export interface GraphProjectorAdapter {
  readonly id: typeof GRAPH_PROJECTOR_ID;
  readonly version: typeof GRAPH_PROJECTOR_VERSION;
  projectSourceLogical(
    candidate: CandidateCommitment,
    sources: Map<string, Record<string, unknown>>,
  ): Record<string, unknown>;
  projectTargetLogical(
    candidate: CandidateCommitment,
    targets: Map<string, Record<string, unknown>>,
  ): Record<string, unknown>;
}

export function projectSourceLogical(
  candidate: CandidateCommitment,
  sources: Map<string, Record<string, unknown>>,
  codec: Codec,
): Record<string, unknown> {
  if (candidate.kind === 'pr56Families') {
    const famDoc = sources.get('families');
    if (!famDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing families source`);
    const famData = famDoc;
    const familyId = famData.id as string;
    const generation = typeof famData.generation === 'number' ? famData.generation : 1;

    const refDoc = sources.get('refresh');
    if (!refDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing active refresh source`);
    const curRefDoc = refDoc;
    const currentRefId = (curRefDoc.id ?? curRefDoc.refreshToken) as string;

    const upDoc = sources.get('upstream');
    if (!upDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing upstream source`);
    const grant = ((upDoc.grant as Record<string, unknown> | undefined) ?? upDoc) as Record<string, unknown>;

    const tokDoc = sources.get('tokens') || {};
    const accessId = (tokDoc.id ?? tokDoc.accessToken ?? famData.currentAccessToken) as string;

    const newAccessId = codec.id('session', accessId);
    const newRefreshId = codec.id('refresh', currentRefId);

    let previousRefresh: Record<string, unknown> | null = null;
    if (famData.previousRefreshToken) {
      const prevId = famData.previousRefreshToken as string;
      const prevDoc = sources.get('prevRefresh') || {};
      const prevRefreshId = codec.id('refresh', prevId);
      previousRefresh = {
        id: prevRefreshId,
        consumedAt: typeof prevDoc.consumedAt === 'number' ? prevDoc.consumedAt : 0,
        generation: Math.max(1, generation - 1),
        successor: {
          accessToken: accessId,
          refreshToken: currentRefId,
        },
      };
    }

    const rawRetired = Array.isArray(famData.retiredRefreshFingerprints)
      ? (famData.retiredRefreshFingerprints as string[])
      : (Array.isArray(famData.retiredTokens) ? (famData.retiredTokens as string[]) : []);
    const retiredFingerprints = Array.from(new Set(rawRetired.filter(fp => typeof fp === 'string' && fp.length > 0))).sort(codeUnitCompare);

    const expiresAt = typeof tokDoc.expiresAt === 'number'
      ? tokDoc.expiresAt
      : (typeof (curRefDoc.token as any)?.expiresAt === 'number' ? (curRefDoc.token as any).expiresAt : (famData.expiresAt ?? 0));

    return {
      familyId,
      generation,
      status: famData.status === 'revoked' ? 'revoked' : 'active',
      clientId: ((curRefDoc.token as any)?.clientId ?? tokDoc.clientId ?? famData.clientId ?? '') as string,
      serverBaseUrl: ((curRefDoc.token as any)?.serverBaseUrl ?? tokDoc.serverBaseUrl ?? famData.serverBaseUrl ?? null) as string | null,
      extra: ((curRefDoc.token as any)?.extra ?? tokDoc.extra ?? {}) as Record<string, string>,
      activeRefreshId: newRefreshId,
      currentAccessTokenId: newAccessId,
      previousRefresh,
      retiredRefreshFingerprints,
      upstream: {
        grantVersion: typeof upDoc.grantVersion === 'number' ? upDoc.grantVersion : 1,
        nsAccessToken: (grant.nsAccessToken ?? grant.access_token ?? tokDoc.nsAccessToken ?? '') as string,
        nsRefreshToken: (grant.nsRefreshToken ?? grant.refresh_token ?? tokDoc.nsRefreshToken ?? null) as string | null,
        nsUsername: (grant.nsUsername ?? grant.username ?? tokDoc.nsUsername ?? '') as string,
        nsUserRole: (grant.nsUserRole ?? grant.user_role ?? tokDoc.nsUserRole ?? null) as string | null,
        nsApiUrl: (grant.nsApiUrl ?? grant.api_url ?? tokDoc.nsApiUrl ?? null) as string | null,
        nsExpiresAt: typeof upDoc.expiresAt === 'number' ? upDoc.expiresAt : (typeof tokDoc.nsExpiresAt === 'number' ? tokDoc.nsExpiresAt : null),
      },
      expiresAt,
      v: 2,
    };
  }

  if (candidate.kind === 'baseFormatTokens') {
    const tokDoc = sources.get('tokens');
    if (!tokDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing tokens source`);
    const refDoc = sources.get('refresh');
    if (!refDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing refresh source`);

    const accessToken = tokDoc.id as string;
    const refreshToken = (tokDoc.refreshToken ?? refDoc.id) as string;
    const familyId = codec.id('family', accessToken);
    const accessId = codec.id('session', accessToken);
    const refreshId = codec.id('refresh', refreshToken);

    const expiresAt = typeof tokDoc.expiresAt === 'number' ? tokDoc.expiresAt : 0;

    return {
      familyId,
      generation: 1,
      status: 'active',
      clientId: (tokDoc.clientId ?? '') as string,
      serverBaseUrl: (tokDoc.serverBaseUrl ?? null) as string | null,
      extra: (tokDoc.extra ?? (tokDoc.seatId ? { seatId: String(tokDoc.seatId) } : {})) as Record<string, string>,
      activeRefreshId: refreshId,
      currentAccessTokenId: accessId,
      upstream: {
        grantVersion: 1,
        nsAccessToken: (tokDoc.nsAccessToken ?? '') as string,
        nsRefreshToken: (tokDoc.nsRefreshToken ?? null) as string | null,
        nsUsername: (tokDoc.nsUsername ?? '') as string,
        nsUserRole: (tokDoc.nsUserRole ?? null) as string | null,
        nsApiUrl: (tokDoc.nsApiUrl ?? null) as string | null,
        nsExpiresAt: typeof tokDoc.nsExpiresAt === 'number' ? tokDoc.nsExpiresAt : null,
      },
      expiresAt,
      v: 2,
    };
  }

  if (candidate.kind === 'authCodes') {
    const codeDoc = sources.get('authCodes');
    if (!codeDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing authCodes source`);
    const rawCode = codeDoc.id as string;
    const hmacId = codec.id('code', rawCode);

    const rawPending = (codeDoc.pending && typeof codeDoc.pending === 'object')
      ? (codeDoc.pending as Record<string, unknown>)
      : codeDoc;
    const rawNsTokens = (codeDoc.nsTokens && typeof codeDoc.nsTokens === 'object')
      ? (codeDoc.nsTokens as Record<string, unknown>)
      : undefined;

    return {
      codeId: hmacId,
      clientId: (rawPending.clientId ?? rawPending.client_id ?? codeDoc.clientId ?? codeDoc.client_id ?? '') as string,
      codeChallenge: (rawPending.codeChallenge ?? rawPending.code_challenge ?? '') as string,
      redirectUri: (rawPending.redirectUri ?? rawPending.redirect_uri ?? '') as string,
      createdAt: typeof rawPending.createdAt === 'number' ? rawPending.createdAt : (typeof rawPending.created_at === 'number' ? rawPending.created_at : 0),
      expiresAt: typeof codeDoc.expiresAt === 'number' ? codeDoc.expiresAt : (typeof codeDoc.expires_at === 'number' ? codeDoc.expires_at : 0),
      state: typeof rawPending.state === 'string' ? rawPending.state : null,
      scopes: Array.isArray(rawPending.scopes) ? [...rawPending.scopes].sort(codeUnitCompare) : [],
      nsAccessToken: (rawNsTokens?.access_token ?? rawNsTokens?.nsAccessToken ?? codeDoc.nsAccessToken ?? '') as string,
      nsRefreshToken: (rawNsTokens?.refresh_token ?? rawNsTokens?.nsRefreshToken ?? codeDoc.nsRefreshToken ?? null) as string | null,
      nsUsername: (rawNsTokens?.username ?? rawNsTokens?.nsUsername ?? codeDoc.nsUsername ?? null) as string | null,
      nsUserRole: (rawNsTokens?.nsUserRole ?? codeDoc.nsUserRole ?? null) as string | null,
      nsApiUrl: (rawNsTokens?.nsApiUrl ?? codeDoc.nsApiUrl ?? null) as string | null,
      serverBaseUrl: (codeDoc.serverBaseUrl ?? null) as string | null,
      extra: (codeDoc.extra ?? {}) as Record<string, string>,
      v: 2,
    };
  }

  if (candidate.kind === 'resumeTokens') {
    const resDoc = sources.get('resumeTokens');
    if (!resDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing resumeTokens source`);
    const resumeId = (resDoc.id as string) ?? '';
    return {
      resumeId,
      consumedAt: typeof resDoc.consumedAt === 'number' ? resDoc.consumedAt : 0,
      expiresAt: typeof resDoc.expiresAt === 'number' ? resDoc.expiresAt : 0,
      v: 2,
    };
  }

  if (candidate.kind === 'clients') {
    const clientDoc = sources.get('clients');
    if (!clientDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing clients source`);
    const clientId = clientDoc.id as string;
    return {
      clientId,
      clientName: typeof clientDoc.client_name === 'string' ? clientDoc.client_name : null,
      clientSecret: typeof clientDoc.client_secret === 'string' ? clientDoc.client_secret : null,
      redirectUris: Array.isArray(clientDoc.redirect_uris) ? [...clientDoc.redirect_uris].sort(codeUnitCompare) : [],
      tokenEndpointAuthMethod: (clientDoc.token_endpoint_auth_method ?? 'none') as string,
      grantTypes: Array.isArray(clientDoc.grant_types) ? [...clientDoc.grant_types].sort(codeUnitCompare) : [],
      responseTypes: Array.isArray(clientDoc.response_types) ? [...clientDoc.response_types].sort(codeUnitCompare) : [],
      clientUri: (clientDoc.client_uri ?? null) as string | null,
      logoUri: (clientDoc.logo_uri ?? null) as string | null,
      scope: (clientDoc.scope ?? null) as string | null,
      clientIdIssuedAt: typeof clientDoc.client_id_issued_at === 'number' ? clientDoc.client_id_issued_at : null,
      v: 2,
    };
  }

  throw new CutoverFenceError(`Unsupported candidate kind for source projection: ${candidate.kind}`);
}

export function projectTargetLogical(
  candidate: CandidateCommitment,
  targets: Map<string, Record<string, unknown>>,
  codec: Codec,
): Record<string, unknown> {
  if (candidate.kind === 'pr56Families') {
    const famDoc = targets.get('families');
    if (!famDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing families target document`);
    const famData = famDoc;
    const familyId = famData.id as string;
    const generation = famData.generation;
    if (typeof generation !== 'number' || generation < 1) {
      throw new CutoverFenceError(`Target family ${familyId} malformed generation`);
    }
    const unsealedFam = famData.sealed
      ? codec.open<Record<string, unknown>>(famData.sealed as string, familyAad({ id: familyId, generation }))
      : null;
    if (!unsealedFam) {
      throw new CutoverFenceError(`Target family sealed payload decrypt failed for ${familyId}`);
    }

    const upDoc = targets.get('upstream');
    if (!upDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing upstream target document`);
    const upData = upDoc;
    const grantVersion = upData.grantVersion;
    if (typeof grantVersion !== 'number' || grantVersion < 1) {
      throw new CutoverFenceError(`Target upstream ${familyId} malformed grantVersion`);
    }
    const unsealedUp = upData.sealed
      ? codec.open<Record<string, unknown>>(upData.sealed as string, upstreamAad({ id: familyId, grantVersion }))
      : null;
    if (!unsealedUp) {
      throw new CutoverFenceError(`Target upstream sealed payload decrypt failed for ${familyId}`);
    }

    const sessDoc = targets.get('tokens');
    if (!sessDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing tokens target document`);
    const sessData = sessDoc;
    if (sessData.v !== 2 || typeof sessData.expiresAt !== 'number' || typeof sessData.retainUntil !== 'number') {
      throw new CutoverFenceError(`Target session invalid for family ${familyId}`);
    }
    const unsealedSess = sessData.sealed
      ? codec.open<Record<string, unknown>>(sessData.sealed as string, accessAad({ id: sessData.id as string, familyId }))
      : null;
    if (!unsealedSess) {
      throw new CutoverFenceError(`Target session sealed payload decrypt failed for family ${familyId}`);
    }

    const activeRefDoc = targets.get('activeRefresh');
    if (!activeRefDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing active refresh target document`);
    const activeRefData = activeRefDoc;
    if (
      activeRefData.familyId !== familyId ||
      activeRefData.status !== 'active' ||
      activeRefData.generation !== generation ||
      activeRefData.v !== 2
    ) {
      throw new CutoverFenceError(`Target active refresh token invalid for family ${familyId}`);
    }

    let previousRefresh: Record<string, unknown> | null = null;
    const prevRefDoc = targets.get('prevRefresh');
    if (prevRefDoc) {
      const prevRefData = prevRefDoc;
      if (
        prevRefData.familyId !== familyId ||
        prevRefData.status !== 'consumed' ||
        typeof prevRefData.consumedAt !== 'number' ||
        prevRefData.v !== 2
      ) {
        throw new CutoverFenceError(`Target consumed refresh token invalid for family ${familyId}`);
      }
      const unsealedSuccessor = codec.open<{ accessToken: string; refreshToken: string }>(
        prevRefData.successorSealed as string,
        `successor:${prevRefData.id}`,
      );
      if (!unsealedSuccessor || typeof unsealedSuccessor.accessToken !== 'string' || typeof unsealedSuccessor.refreshToken !== 'string') {
        throw new CutoverFenceError(`Target successor sealed invalid for previous refresh ${prevRefData.id}`);
      }
      previousRefresh = {
        id: prevRefData.id,
        consumedAt: prevRefData.consumedAt,
        generation: prevRefData.generation,
        successor: {
          accessToken: unsealedSuccessor.accessToken,
          refreshToken: unsealedSuccessor.refreshToken,
        },
      };
    }

    const rawRetired = targets.get('retiredRefresh') as { ids: string[] } | undefined;
    const retiredRefreshFingerprints = (rawRetired?.ids || []).sort(codeUnitCompare);

    return {
      familyId,
      generation,
      status: famData.status as string,
      clientId: (unsealedFam.clientId ?? unsealedSess.clientId ?? '') as string,
      serverBaseUrl: (unsealedFam.serverBaseUrl ?? unsealedSess.serverBaseUrl ?? null) as string | null,
      extra: (unsealedFam.extra ?? unsealedSess.extra ?? {}) as Record<string, string>,
      activeRefreshId: famData.activeRefreshId as string,
      currentAccessTokenId: famData.currentAccessTokenId as string,
      previousRefresh,
      retiredRefreshFingerprints,
      upstream: {
        grantVersion,
        nsAccessToken: (unsealedUp.nsAccessToken ?? '') as string,
        nsRefreshToken: (unsealedUp.nsRefreshToken ?? null) as string | null,
        nsUsername: (unsealedUp.nsUsername ?? '') as string,
        nsUserRole: (unsealedUp.nsUserRole ?? null) as string | null,
        nsApiUrl: (unsealedUp.nsApiUrl ?? null) as string | null,
        nsExpiresAt: typeof upData.nsExpiresAt === 'number' ? upData.nsExpiresAt : null,
      },
      expiresAt: sessData.expiresAt as number,
      v: 2,
    };
  }

  if (candidate.kind === 'baseFormatTokens') {
    const famDoc = targets.get('families');
    if (!famDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing families target document`);
    const famData = famDoc;
    const familyId = famData.id as string;
    const unsealedFam = famData.sealed
      ? codec.open<Record<string, unknown>>(famData.sealed as string, familyAad({ id: familyId, generation: 1 }))
      : null;
    if (!unsealedFam) throw new CutoverFenceError(`Target base family decrypt failed for ${familyId}`);

    const upDoc = targets.get('upstream');
    if (!upDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing upstream target document`);
    const upData = upDoc;
    const unsealedUp = upData.sealed
      ? codec.open<Record<string, unknown>>(upData.sealed as string, upstreamAad({ id: familyId, grantVersion: 1 }))
      : null;
    if (!unsealedUp) throw new CutoverFenceError(`Target base upstream decrypt failed for ${familyId}`);

    const sessDoc = targets.get('tokens');
    if (!sessDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing tokens target document`);
    const sessData = sessDoc;
    if (sessData.v !== 2 || typeof sessData.expiresAt !== 'number' || typeof sessData.retainUntil !== 'number') {
      throw new CutoverFenceError(`Target base session invalid for ${sessData.id}`);
    }
    const unsealedSess = sessData.sealed
      ? codec.open<Record<string, unknown>>(sessData.sealed as string, accessAad({ id: sessData.id as string, familyId }))
      : null;
    if (!unsealedSess) throw new CutoverFenceError(`Target base session decrypt failed for ${sessData.id}`);

    const activeRefDoc = targets.get('activeRefresh');
    if (!activeRefDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing active refresh target document`);
    const activeRefData = activeRefDoc;
    if (
      activeRefData.familyId !== familyId ||
      activeRefData.status !== 'active' ||
      activeRefData.generation !== 1 ||
      activeRefData.v !== 2
    ) {
      throw new CutoverFenceError(`Target active refresh token invalid for base family ${familyId}`);
    }

    return {
      familyId,
      generation: 1,
      status: 'active',
      clientId: (unsealedFam.clientId ?? '') as string,
      serverBaseUrl: (unsealedFam.serverBaseUrl ?? null) as string | null,
      extra: (unsealedFam.extra ?? {}) as Record<string, string>,
      activeRefreshId: famData.activeRefreshId as string,
      currentAccessTokenId: famData.currentAccessTokenId as string,
      upstream: {
        grantVersion: 1,
        nsAccessToken: (unsealedUp.nsAccessToken ?? '') as string,
        nsRefreshToken: (unsealedUp.nsRefreshToken ?? null) as string | null,
        nsUsername: (unsealedUp.nsUsername ?? '') as string,
        nsUserRole: (unsealedUp.nsUserRole ?? null) as string | null,
        nsApiUrl: (unsealedUp.nsApiUrl ?? null) as string | null,
        nsExpiresAt: typeof upData.nsExpiresAt === 'number' ? upData.nsExpiresAt : null,
      },
      expiresAt: sessData.expiresAt as number,
      v: 2,
    };
  }

  if (candidate.kind === 'authCodes') {
    const codeDoc = targets.get('authCodes');
    if (!codeDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing authCodes target document`);
    const codeData = codeDoc;
    if (codeData.v !== 2 || typeof codeData.expiresAt !== 'number') {
      throw new CutoverFenceError(`Target auth code ${codeData.id} missing v: 2 or valid expiresAt`);
    }
    const unsealed = codeData.sealed
      ? codec.open<AuthCodeData>(codeData.sealed as string, `code:${codeData.id}`)
      : null;
    if (!unsealed) throw new CutoverFenceError(`Target auth code decrypt failed for ${codeData.id}`);

    return {
      codeId: codeData.id as string,
      clientId: unsealed.clientId,
      codeChallenge: unsealed.pending.codeChallenge,
      redirectUri: unsealed.pending.redirectUri,
      createdAt: unsealed.pending.createdAt,
      expiresAt: codeData.expiresAt,
      state: unsealed.pending.state ?? null,
      scopes: Array.isArray(unsealed.pending.scopes) ? [...unsealed.pending.scopes].sort(codeUnitCompare) : [],
      nsAccessToken: unsealed.nsTokens.access_token,
      nsRefreshToken: unsealed.nsTokens.refresh_token ?? null,
      nsUsername: unsealed.nsTokens.username ?? null,
      nsUserRole: unsealed.nsTokens.nsUserRole ?? null,
      nsApiUrl: unsealed.nsTokens.nsApiUrl ?? null,
      serverBaseUrl: unsealed.serverBaseUrl ?? null,
      extra: unsealed.extra ?? {},
      v: 2,
    };
  }

  if (candidate.kind === 'resumeTokens') {
    const resDoc = targets.get('resumeTokens');
    if (!resDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing resumeTokens target document`);
    const resData = resDoc;
    if (resData._mcp_format !== 'v3_target' || resData.v !== 2) {
      throw new CutoverFenceError(`Target resume token ${resData.id} missing _mcp_format v3_target`);
    }
    return {
      resumeId: resData.id as string,
      consumedAt: typeof resData.consumedAt === 'number' ? resData.consumedAt : 0,
      expiresAt: typeof resData.expiresAt === 'number' ? resData.expiresAt : 0,
      v: 2,
    };
  }

  if (candidate.kind === 'clients') {
    const clientDoc = targets.get('clients');
    if (!clientDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing clients target document`);
    const clientData = clientDoc;
    if (clientData._mcp_format !== 'v3_target' || clientData.v !== 2) {
      throw new CutoverFenceError(`Target oauth client ${clientData.client_id} missing _mcp_format v3_target`);
    }
    return {
      clientId: clientData.client_id as string,
      clientName: typeof clientData.client_name === 'string' ? clientData.client_name : null,
      clientSecret: typeof clientData.client_secret === 'string' ? clientData.client_secret : null,
      redirectUris: Array.isArray(clientData.redirect_uris) ? [...clientData.redirect_uris].sort(codeUnitCompare) : [],
      tokenEndpointAuthMethod: (clientData.token_endpoint_auth_method ?? 'none') as string,
      grantTypes: Array.isArray(clientData.grant_types) ? [...clientData.grant_types].sort(codeUnitCompare) : [],
      responseTypes: Array.isArray(clientData.response_types) ? [...clientData.response_types].sort(codeUnitCompare) : [],
      clientUri: (clientData.client_uri ?? null) as string | null,
      logoUri: (clientData.logo_uri ?? null) as string | null,
      scope: (clientData.scope ?? null) as string | null,
      clientIdIssuedAt: typeof clientData.client_id_issued_at === 'number' ? clientData.client_id_issued_at : null,
      v: 2,
    };
  }

  throw new CutoverFenceError(`Unsupported candidate kind for target projection: ${candidate.kind}`);
}

export function createGraphProjector(codec: Codec): GraphProjectorAdapter {
  return {
    id: GRAPH_PROJECTOR_ID,
    version: GRAPH_PROJECTOR_VERSION,
    projectSourceLogical(candidate, sources) {
      return projectSourceLogical(candidate, sources, codec);
    },
    projectTargetLogical(candidate, targets) {
      return projectTargetLogical(candidate, targets, codec);
    },
  };
}
