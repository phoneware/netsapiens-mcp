import { createCodec } from './codec.js';
import { accessAad, familyAad, upstreamAad, codeUnitCompare } from './row-format.js';
import { CutoverFenceError } from './errors.js';

export { createCodec, accessAad, familyAad, upstreamAad, codeUnitCompare, CutoverFenceError };

export const PROJECTOR_ID = 'netsapiens-mcp/v2-v3-projector';
export const PROJECTOR_VERSION = 1;

export function getTimestampMs(val) {
  if (val instanceof Date) {
    const ms = val.getTime();
    if (!Number.isFinite(ms) || !Number.isSafeInteger(ms)) return null;
    return ms;
  }
  if (val && typeof val === 'object') {
    if (typeof val.toMillis === 'function') {
      const ms = val.toMillis();
      if (typeof ms === 'number' && Number.isFinite(ms) && Number.isSafeInteger(ms)) return ms;
    }
    const sec = val.seconds ?? val._seconds;
    const nsec = val.nanoseconds ?? val._nanoseconds ?? 0;
    if (
      typeof sec === 'number' &&
      Number.isSafeInteger(sec) &&
      typeof nsec === 'number' &&
      Number.isSafeInteger(nsec) &&
      nsec >= 0 &&
      nsec < 1_000_000_000
    ) {
      if (nsec % 1_000_000 !== 0) {
        return null;
      }
      const ms = sec * 1000 + (nsec / 1_000_000);
      if (!Number.isFinite(ms) || !Number.isSafeInteger(ms)) return null;
      return ms;
    }
  }
  return null;
}

export function projectSourceLogical(candidate, sources, codec) {
  if (candidate.kind === 'pr56Families') {
    const famDoc = sources.get('families');
    if (!famDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing families source`);
    const famData = famDoc;
    const familyId = famData.id;
    if (!familyId || typeof familyId !== 'string') throw new CutoverFenceError('pr56Families missing required familyId');
    // Legacy PR56 source omits generation; default to 1 as documented in legacy schema
    const generation = typeof famData.generation === 'number' ? famData.generation : 1;

    const refDoc = sources.get('refresh');
    if (!refDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing active refresh source`);
    const curRefDoc = refDoc;
    if (curRefDoc.id !== famData.currentRefreshToken || curRefDoc.status !== 'active') {
      throw new CutoverFenceError(`Active refresh token '${curRefDoc.id}' mismatch with currentRefreshToken '${famData.currentRefreshToken}' or not active`);
    }
    const currentRefId = curRefDoc.id;

    const upDoc = sources.get('upstream');
    if (!upDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing upstream source`);
    const grant = ((upDoc.grant && typeof upDoc.grant === 'object') ? upDoc.grant : upDoc);

    const tokDoc = sources.get('tokens');
    if (!tokDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing tokens source`);
    const accessId = (tokDoc.id ?? tokDoc.accessToken ?? famData.currentAccessToken);
    if (!accessId || typeof accessId !== 'string') throw new CutoverFenceError('pr56Families missing accessId');

    const newAccessId = codec.id('session', accessId);
    const newRefreshId = codec.id('refresh', currentRefId);

    let previousRefresh = null;
    if (famData.previousRefreshToken) {
      const prevId = famData.previousRefreshToken;
      const prevDoc = sources.get('prevRefresh');
      if (!prevDoc) {
        throw new CutoverFenceError(`Candidate ${candidate.id} has previousRefreshToken '${prevId}' but missing prevRefresh source`);
      }
      if (prevDoc.id !== prevId || prevDoc.status !== 'consumed') {
        throw new CutoverFenceError(`Previous refresh token '${prevDoc.id}' mismatch with previousRefreshToken '${prevId}' or not consumed`);
      }
      if (typeof prevDoc.consumedAt !== 'number') {
        throw new CutoverFenceError(`Candidate ${candidate.id} previous refresh missing numeric consumedAt`);
      }
      const prevRefreshId = codec.id('refresh', prevId);
      previousRefresh = {
        id: prevRefreshId,
        consumedAt: prevDoc.consumedAt,
        generation: Math.max(1, generation - 1),
        successor: {
          accessToken: accessId,
          refreshToken: currentRefId,
        },
      };
    }

    const rawRetired = Array.isArray(famData.retiredRefreshFingerprints)
      ? famData.retiredRefreshFingerprints
      : (Array.isArray(famData.retiredTokens) ? famData.retiredTokens : []);
    const retiredFingerprints = Array.from(new Set(rawRetired.filter((fp) => typeof fp === 'string' && fp.length > 0))).sort(codeUnitCompare);

    const expiresAt = typeof tokDoc.expiresAt === 'number'
      ? tokDoc.expiresAt
      : (typeof curRefDoc.token?.expiresAt === 'number' ? curRefDoc.token.expiresAt : famData.expiresAt);
    if (typeof expiresAt !== 'number' || expiresAt <= 0) {
      throw new CutoverFenceError('pr56Families missing required positive expiresAt');
    }

    const clientId = curRefDoc.token?.clientId ?? tokDoc.clientId ?? famData.clientId;
    if (!clientId || typeof clientId !== 'string') {
      throw new CutoverFenceError('pr56Families missing required clientId');
    }

    const nsAccessToken = grant.nsAccessToken ?? grant.access_token ?? tokDoc.nsAccessToken;
    if (!nsAccessToken || typeof nsAccessToken !== 'string') {
      throw new CutoverFenceError('pr56Families missing required nsAccessToken');
    }

    const nsUsername = grant.nsUsername ?? grant.username ?? tokDoc.nsUsername;
    if (!nsUsername || typeof nsUsername !== 'string') {
      throw new CutoverFenceError('pr56Families missing required nsUsername');
    }

    return {
      familyId,
      generation,
      status: famData.status === 'revoked' ? 'revoked' : 'active',
      clientId,
      serverBaseUrl: (curRefDoc.token?.serverBaseUrl ?? tokDoc.serverBaseUrl ?? famData.serverBaseUrl ?? null),
      extra: (curRefDoc.token?.extra ?? tokDoc.extra ?? {}),
      activeRefreshId: newRefreshId,
      currentAccessTokenId: newAccessId,
      previousRefresh,
      retiredRefreshFingerprints,
      upstream: {
        grantVersion: typeof upDoc.grantVersion === 'number' ? upDoc.grantVersion : 1,
        nsAccessToken,
        nsRefreshToken: (grant.nsRefreshToken ?? grant.refresh_token ?? tokDoc.nsRefreshToken ?? null),
        nsUsername,
        nsUserRole: (grant.nsUserRole ?? grant.user_role ?? tokDoc.nsUserRole ?? null),
        nsApiUrl: (grant.nsApiUrl ?? grant.api_url ?? tokDoc.nsApiUrl ?? null),
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

    const accessToken = tokDoc.id;
    const refreshToken = (tokDoc.refreshToken ?? refDoc.id);
    const familyId = codec.id('family', accessToken);
    const accessId = codec.id('session', accessToken);
    const refreshId = codec.id('refresh', refreshToken);

    const expiresAt = tokDoc.expiresAt;
    if (typeof expiresAt !== 'number' || expiresAt <= 0) {
      throw new CutoverFenceError('baseFormatTokens missing required positive expiresAt');
    }

    const clientId = tokDoc.clientId;
    if (!clientId || typeof clientId !== 'string') {
      throw new CutoverFenceError('baseFormatTokens missing required clientId');
    }

    const nsAccessToken = tokDoc.nsAccessToken;
    if (!nsAccessToken || typeof nsAccessToken !== 'string') {
      throw new CutoverFenceError('baseFormatTokens missing required nsAccessToken');
    }

    const nsUsername = tokDoc.nsUsername;
    if (!nsUsername || typeof nsUsername !== 'string') {
      throw new CutoverFenceError('baseFormatTokens missing required nsUsername');
    }

    return {
      familyId,
      generation: 1,
      status: 'active',
      clientId,
      serverBaseUrl: (tokDoc.serverBaseUrl ?? null),
      extra: (tokDoc.extra ?? (tokDoc.seatId ? { seatId: String(tokDoc.seatId) } : {})),
      activeRefreshId: refreshId,
      currentAccessTokenId: accessId,
      upstream: {
        grantVersion: 1,
        nsAccessToken,
        nsRefreshToken: (tokDoc.nsRefreshToken ?? null),
        nsUsername,
        nsUserRole: (tokDoc.nsUserRole ?? null),
        nsApiUrl: (tokDoc.nsApiUrl ?? null),
        nsExpiresAt: typeof tokDoc.nsExpiresAt === 'number' ? tokDoc.nsExpiresAt : null,
      },
      expiresAt,
      v: 2,
    };
  }

  if (candidate.kind === 'authCodes') {
    const codeDoc = sources.get('authCodes');
    if (!codeDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing authCodes source`);
    const rawCode = codeDoc.id;
    const hmacId = codec.id('code', rawCode);

    const rawPending = (codeDoc.pending && typeof codeDoc.pending === 'object')
      ? codeDoc.pending
      : codeDoc;
    const rawNsTokens = (codeDoc.nsTokens && typeof codeDoc.nsTokens === 'object')
      ? codeDoc.nsTokens
      : undefined;

    const clientId = rawPending.clientId ?? rawPending.client_id ?? codeDoc.clientId ?? codeDoc.client_id;
    if (!clientId || typeof clientId !== 'string' || !clientId.trim()) {
      throw new CutoverFenceError('authCodes missing required clientId');
    }
    const codeChallenge = rawPending.codeChallenge ?? rawPending.code_challenge;
    if (!codeChallenge || typeof codeChallenge !== 'string' || !codeChallenge.trim()) {
      throw new CutoverFenceError('authCodes missing required codeChallenge');
    }
    const redirectUri = rawPending.redirectUri ?? rawPending.redirect_uri;
    if (!redirectUri || typeof redirectUri !== 'string' || !redirectUri.trim()) {
      throw new CutoverFenceError('authCodes missing required redirectUri');
    }
    const createdAt = rawPending.createdAt ?? rawPending.created_at;
    if (typeof createdAt !== 'number' || createdAt <= 0) {
      throw new CutoverFenceError('authCodes missing required positive createdAt');
    }
    const expiresAt = typeof codeDoc.expiresAt === 'number' ? codeDoc.expiresAt : (typeof codeDoc.expires_at === 'number' ? codeDoc.expires_at : null);
    if (typeof expiresAt !== 'number' || expiresAt <= 0) {
      throw new CutoverFenceError('authCodes missing required positive expiresAt');
    }
    const nsAccessToken = rawNsTokens?.access_token ?? rawNsTokens?.nsAccessToken ?? codeDoc.nsAccessToken;
    if (!nsAccessToken || typeof nsAccessToken !== 'string' || !nsAccessToken.trim()) {
      throw new CutoverFenceError('authCodes missing required nsAccessToken');
    }

    return {
      codeId: hmacId,
      clientId,
      codeChallenge,
      redirectUri,
      createdAt,
      expiresAt,
      state: typeof rawPending.state === 'string' ? rawPending.state : null,
      scopes: Array.isArray(rawPending.scopes) ? [...rawPending.scopes].sort(codeUnitCompare) : [],
      nsAccessToken,
      nsRefreshToken: (rawNsTokens?.refresh_token ?? rawNsTokens?.nsRefreshToken ?? codeDoc.nsRefreshToken ?? null),
      nsUsername: (rawNsTokens?.username ?? rawNsTokens?.nsUsername ?? codeDoc.nsUsername ?? null),
      nsUserRole: (rawNsTokens?.nsUserRole ?? codeDoc.nsUserRole ?? null),
      nsApiUrl: (rawNsTokens?.nsApiUrl ?? codeDoc.nsApiUrl ?? null),
      serverBaseUrl: (codeDoc.serverBaseUrl ?? null),
      extra: (codeDoc.extra ?? {}),
      v: 2,
    };
  }

  if (candidate.kind === 'resumeTokens') {
    const resDoc = sources.get('resumeTokens');
    if (!resDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing resumeTokens source`);
    const resumeId = resDoc.id;
    if (!resumeId || typeof resumeId !== 'string') throw new CutoverFenceError('resumeTokens missing required id');
    if (typeof resDoc.consumedAt !== 'number') throw new CutoverFenceError('resumeTokens missing required consumedAt');
    if (typeof resDoc.expiresAt !== 'number' || resDoc.expiresAt <= 0) throw new CutoverFenceError('resumeTokens missing required positive expiresAt');

    return {
      resumeId,
      consumedAt: resDoc.consumedAt,
      expiresAt: resDoc.expiresAt,
      v: 2,
    };
  }

  if (candidate.kind === 'clients') {
    const clientDoc = sources.get('clients');
    if (!clientDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing clients source`);
    const clientId = clientDoc.client_id ?? clientDoc.id;
    if (!clientId || typeof clientId !== 'string') throw new CutoverFenceError('clients missing required clientId');
    if (!Array.isArray(clientDoc.redirect_uris) || clientDoc.redirect_uris.length === 0) {
      throw new CutoverFenceError('clients missing required non-empty redirect_uris');
    }
    // In legacy DCR, token_endpoint_auth_method may be omitted by public clients, defaulting to 'none' or 'client_secret_basic'
    const tokenEndpointAuthMethod = typeof clientDoc.token_endpoint_auth_method === 'string'
      ? clientDoc.token_endpoint_auth_method
      : (clientDoc.client_secret ? 'client_secret_basic' : 'none');

    return {
      clientId,
      clientName: typeof clientDoc.client_name === 'string' ? clientDoc.client_name : null,
      clientSecret: typeof clientDoc.client_secret === 'string' ? clientDoc.client_secret : null,
      redirectUris: [...clientDoc.redirect_uris].sort(codeUnitCompare),
      tokenEndpointAuthMethod,
      grantTypes: Array.isArray(clientDoc.grant_types) ? [...clientDoc.grant_types].sort(codeUnitCompare) : [],
      responseTypes: Array.isArray(clientDoc.response_types) ? [...clientDoc.response_types].sort(codeUnitCompare) : [],
      clientUri: (clientDoc.client_uri ?? null),
      logoUri: (clientDoc.logo_uri ?? null),
      scope: (clientDoc.scope ?? null),
      clientIdIssuedAt: typeof clientDoc.client_id_issued_at === 'number' ? clientDoc.client_id_issued_at : null,
      v: 2,
    };
  }

  throw new CutoverFenceError(`Unsupported candidate kind for source projection: ${kind}`);
}

export function projectTargetLogical(candidate, targets, codec) {
  if (candidate.kind === 'pr56Families') {
    const famDoc = targets.get('families');
    if (!famDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing families target document`);
    const famData = famDoc;
    const familyId = famData.id;
    if (!familyId || typeof familyId !== 'string') throw new CutoverFenceError('Target family missing id');
    const generation = famData.generation;
    if (typeof generation !== 'number' || generation < 1) {
      throw new CutoverFenceError(`Target family ${familyId} malformed generation`);
    }
    const unsealedFam = famData.sealed
      ? codec.open(famData.sealed, familyAad({ id: familyId, generation }))
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
    if (upData.familyId !== familyId && upData.id !== familyId) {
      throw new CutoverFenceError(`Target upstream family binding mismatch for ${familyId}`);
    }
    const unsealedUp = upData.sealed
      ? codec.open(upData.sealed, upstreamAad({ id: familyId, grantVersion }))
      : null;
    if (!unsealedUp) {
      throw new CutoverFenceError(`Target upstream sealed payload decrypt failed for ${familyId}`);
    }

    const sessDoc = targets.get('tokens');
    if (!sessDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing tokens target document`);
    const sessData = sessDoc;
    if (sessData.v !== 2 || typeof sessData.expiresAt !== 'number' || typeof sessData.retainUntil !== 'number' || !sessData.ttlAt) {
      throw new CutoverFenceError(`Target session invalid for family ${familyId}: missing v: 2, expiresAt, retainUntil, or ttlAt`);
    }
    if (sessData.familyId !== familyId) {
      throw new CutoverFenceError(`Target session family binding mismatch: expected ${familyId}, got ${sessData.familyId}`);
    }
    if (sessData.retainUntil !== sessData.expiresAt + 30 * 24 * 60 * 60 * 1000) {
      throw new CutoverFenceError(`Target session retainUntil must equal expiresAt + 30 days for family ${familyId}`);
    }
    const ttlMs = getTimestampMs(sessData.ttlAt);
    if (ttlMs === null || ttlMs !== sessData.retainUntil) {
      throw new CutoverFenceError(`Target session ttlAt must equal retainUntil for family ${familyId}`);
    }

    const unsealedSess = codec.open(sessData.sealed, accessAad({ id: sessData.id, familyId }));
    if (!unsealedSess) {
      throw new CutoverFenceError(`Target session sealed payload decrypt failed for family ${familyId}`);
    }

    const clientId = unsealedFam.clientId ?? unsealedSess.clientId;
    if (!clientId || typeof clientId !== 'string') {
      throw new CutoverFenceError(`Target family missing decrypted clientId for ${familyId}`);
    }
    const nsAccessToken = unsealedUp.nsAccessToken;
    if (!nsAccessToken || typeof nsAccessToken !== 'string') {
      throw new CutoverFenceError(`Target upstream missing decrypted nsAccessToken for ${familyId}`);
    }
    const nsUsername = unsealedUp.nsUsername;
    if (!nsUsername || typeof nsUsername !== 'string') {
      throw new CutoverFenceError(`Target upstream missing decrypted nsUsername for ${familyId}`);
    }

    const activeRefDoc = targets.get('activeRefresh');
    if (!activeRefDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing active refresh target document`);
    const activeRefData = activeRefDoc;
    if (
      activeRefData.id !== famData.activeRefreshId ||
      activeRefData.familyId !== familyId ||
      activeRefData.status !== 'active' ||
      activeRefData.generation !== generation ||
      activeRefData.v !== 2
    ) {
      throw new CutoverFenceError(`Target active refresh token invalid for family ${familyId}`);
    }

    let previousRefresh = null;
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
      const unsealedSuccessor = codec.open(
        prevRefData.successorSealed,
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

    const rawRetired = targets.get('retiredRefresh');
    const retiredRefreshFingerprints = (rawRetired?.ids || []).sort(codeUnitCompare);

    return {
      familyId,
      generation,
      status: famData.status,
      clientId,
      serverBaseUrl: (unsealedFam.serverBaseUrl ?? unsealedSess.serverBaseUrl ?? null),
      extra: (unsealedFam.extra ?? unsealedSess.extra ?? {}),
      activeRefreshId: famData.activeRefreshId,
      currentAccessTokenId: famData.currentAccessTokenId,
      previousRefresh,
      retiredRefreshFingerprints,
      upstream: {
        grantVersion,
        nsAccessToken,
        nsRefreshToken: (unsealedUp.nsRefreshToken ?? null),
        nsUsername,
        nsUserRole: (unsealedUp.nsUserRole ?? null),
        nsApiUrl: (unsealedUp.nsApiUrl ?? null),
        nsExpiresAt: typeof upData.nsExpiresAt === 'number' ? upData.nsExpiresAt : null,
      },
      expiresAt: sessData.expiresAt,
      v: 2,
    };
  }

  if (candidate.kind === 'baseFormatTokens') {
    const famDoc = targets.get('families');
    if (!famDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing families target document`);
    const famData = famDoc;
    const familyId = famData.id;
    const unsealedFam = codec.open(famData.sealed, familyAad({ id: familyId, generation: 1 }));
    if (!unsealedFam) throw new CutoverFenceError(`Target base family decrypt failed for ${familyId}`);

    const upDoc = targets.get('upstream');
    if (!upDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing upstream target document`);
    const upData = upDoc;
    if (upData.familyId !== familyId && upData.id !== familyId) {
      throw new CutoverFenceError(`Target base upstream family binding mismatch for ${familyId}`);
    }
    const unsealedUp = codec.open(upData.sealed, upstreamAad({ id: familyId, grantVersion: 1 }));
    if (!unsealedUp) throw new CutoverFenceError(`Target base upstream decrypt failed for ${familyId}`);

    const sessDoc = targets.get('tokens');
    if (!sessDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing tokens target document`);
    const sessData = sessDoc;
    if (sessData.v !== 2 || typeof sessData.expiresAt !== 'number' || typeof sessData.retainUntil !== 'number' || !sessData.ttlAt) {
      throw new CutoverFenceError(`Target base session invalid for ${sessData.id}: missing v: 2, expiresAt, retainUntil, or ttlAt`);
    }
    if (sessData.familyId !== familyId) {
      throw new CutoverFenceError(`Target base session family binding mismatch for ${sessData.id}`);
    }
    if (sessData.retainUntil !== sessData.expiresAt + 30 * 24 * 60 * 60 * 1000) {
      throw new CutoverFenceError(`Target session retainUntil must equal expiresAt + 30 days for base session ${sessData.id}`);
    }
    const ttlMs = getTimestampMs(sessData.ttlAt);
    if (ttlMs === null || ttlMs !== sessData.retainUntil) {
      throw new CutoverFenceError(`Target session ttlAt must equal retainUntil for base session ${sessData.id}`);
    }

    const unsealedSess = codec.open(sessData.sealed, accessAad({ id: sessData.id, familyId }));
    if (!unsealedSess) throw new CutoverFenceError(`Target base session decrypt failed for ${sessData.id}`);

    const clientId = unsealedFam.clientId;
    if (!clientId || typeof clientId !== 'string') {
      throw new CutoverFenceError(`Target base family missing decrypted clientId for ${familyId}`);
    }
    const nsAccessToken = unsealedUp.nsAccessToken;
    if (!nsAccessToken || typeof nsAccessToken !== 'string') {
      throw new CutoverFenceError(`Target base upstream missing decrypted nsAccessToken for ${familyId}`);
    }
    const nsUsername = unsealedUp.nsUsername;
    if (!nsUsername || typeof nsUsername !== 'string') {
      throw new CutoverFenceError(`Target base upstream missing decrypted nsUsername for ${familyId}`);
    }

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
      clientId,
      serverBaseUrl: (unsealedFam.serverBaseUrl ?? null),
      extra: (unsealedFam.extra ?? {}),
      activeRefreshId: famData.activeRefreshId,
      currentAccessTokenId: famData.currentAccessTokenId,
      upstream: {
        grantVersion: 1,
        nsAccessToken,
        nsRefreshToken: (unsealedUp.nsRefreshToken ?? null),
        nsUsername,
        nsUserRole: (unsealedUp.nsUserRole ?? null),
        nsApiUrl: (unsealedUp.nsApiUrl ?? null),
        nsExpiresAt: typeof upData.nsExpiresAt === 'number' ? upData.nsExpiresAt : null,
      },
      expiresAt: sessData.expiresAt,
      v: 2,
    };
  }

  if (candidate.kind === 'authCodes') {
    const codeDoc = targets.get('authCodes');
    if (!codeDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing authCodes target document`);
    const codeData = codeDoc;
    if (codeData.v !== 2 || typeof codeData.expiresAt !== 'number' || codeData.expiresAt <= 0 || !codeData.ttlAt) {
      throw new CutoverFenceError(`Target auth code ${codeData.id} missing v: 2, valid positive expiresAt, or ttlAt`);
    }
    const ttlMs = getTimestampMs(codeData.ttlAt);
    if (ttlMs === null || ttlMs !== codeData.expiresAt) {
      throw new CutoverFenceError(`Target auth code ${codeData.id} ttlAt must equal expiresAt`);
    }

    const unsealed = codeData.sealed
      ? codec.open(codeData.sealed, `code:${codeData.id}`)
      : null;
    if (!unsealed) throw new CutoverFenceError(`Target auth code decrypt failed for ${codeData.id}`);

    const rawPending = unsealed.pending || {};
    const rawNsTokens = unsealed.nsTokens || {};

    const clientId = unsealed.clientId;
    if (!clientId || typeof clientId !== 'string') {
      throw new CutoverFenceError(`Target auth code ${codeData.id} missing decrypted clientId`);
    }
    const nsAccessToken = rawNsTokens.access_token;
    if (!nsAccessToken || typeof nsAccessToken !== 'string') {
      throw new CutoverFenceError(`Target auth code ${codeData.id} missing decrypted nsTokens.access_token`);
    }

    return {
      codeId: codeData.id,
      clientId,
      codeChallenge: rawPending.codeChallenge,
      redirectUri: rawPending.redirectUri,
      createdAt: rawPending.createdAt,
      expiresAt: codeData.expiresAt,
      state: rawPending.state ?? null,
      scopes: Array.isArray(rawPending.scopes) ? [...rawPending.scopes].sort(codeUnitCompare) : [],
      nsAccessToken,
      nsRefreshToken: rawNsTokens.refresh_token ?? null,
      nsUsername: rawNsTokens.username ?? null,
      nsUserRole: rawNsTokens.nsUserRole ?? null,
      nsApiUrl: rawNsTokens.nsApiUrl ?? null,
      serverBaseUrl: unsealed.serverBaseUrl ?? null,
      extra: unsealed.extra ?? {},
      v: 2,
    };
  }

  if (candidate.kind === 'resumeTokens') {
    const resDoc = targets.get('resumeTokens');
    if (!resDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing resumeTokens target document`);
    const resData = resDoc;
    if (resData._mcp_format !== 'v3_target' || resData.v !== 2 || typeof resData.expiresAt !== 'number' || resData.expiresAt <= 0 || !resData.ttlAt) {
      throw new CutoverFenceError(`Target resume token ${resData.id} missing _mcp_format v3_target, v: 2, positive expiresAt, or ttlAt`);
    }
    if (typeof resData.consumedAt !== 'number') {
      throw new CutoverFenceError(`Target resume token ${resData.id} missing numeric consumedAt`);
    }
    const ttlMs = getTimestampMs(resData.ttlAt);
    if (ttlMs === null || ttlMs !== resData.expiresAt) {
      throw new CutoverFenceError(`Target resume token ${resData.id} ttlAt must equal expiresAt`);
    }

    return {
      resumeId: resData.id,
      consumedAt: resData.consumedAt,
      expiresAt: resData.expiresAt,
      v: 2,
    };
  }

  if (candidate.kind === 'clients') {
    const clientDoc = targets.get('clients');
    if (!clientDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing clients target document`);
    const clientData = clientDoc;
    if (clientData._mcp_format !== 'v3_target' || clientData.v !== 2) {
      throw new CutoverFenceError(`Target oauth client ${clientData.client_id ?? clientData.id} missing _mcp_format v3_target`);
    }
    const clientId = clientData.client_id ?? clientData.id;
    if (!clientId || typeof clientId !== 'string') {
      throw new CutoverFenceError('Target oauth client missing clientId');
    }
    if (!Array.isArray(clientData.redirect_uris) || clientData.redirect_uris.length === 0) {
      throw new CutoverFenceError('Target oauth client missing non-empty redirect_uris');
    }
    const tokenEndpointAuthMethod = typeof clientData.token_endpoint_auth_method === 'string'
      ? clientData.token_endpoint_auth_method
      : (clientData.client_secret ? 'client_secret_basic' : 'none');

    return {
      clientId,
      clientName: typeof clientData.client_name === 'string' ? clientData.client_name : null,
      clientSecret: typeof clientData.client_secret === 'string' ? clientData.client_secret : null,
      redirectUris: [...clientData.redirect_uris].sort(codeUnitCompare),
      tokenEndpointAuthMethod,
      grantTypes: Array.isArray(clientData.grant_types) ? [...clientData.grant_types].sort(codeUnitCompare) : [],
      responseTypes: Array.isArray(clientData.response_types) ? [...clientData.response_types].sort(codeUnitCompare) : [],
      clientUri: (clientData.client_uri ?? null),
      logoUri: (clientData.logo_uri ?? null),
      scope: (clientData.scope ?? null),
      clientIdIssuedAt: typeof clientData.client_id_issued_at === 'number' ? clientData.client_id_issued_at : null,
      v: 2,
    };
  }

  throw new CutoverFenceError(`Unsupported candidate kind for target projection: ${kind}`);
}
