// @phoneware/netsapiens-mcp: Canonical Cutover Fence Protocol Bundle (Self-Contained Single-File ESM)
// Built per Planner FenceContractReset: only node: builtins, approved static closure inlined
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';

/* ========================================================================= */
/* INLINED S3 PROJECTOR & CODEC CLOSURE                                     */
/* ========================================================================= */
export const PROJECTOR_ID = 'netsapiens-mcp/v2-v3-projector';
export const PROJECTOR_VERSION = 1;



export function codeUnitCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function createCodec(root) {
  const rootBuf = typeof root === 'string' ? Buffer.from(root, 'utf8') : root;
  const idKey = Buffer.from(hkdfSync('sha256', rootBuf, '', 'id', 32));
  const encKey = Buffer.from(hkdfSync('sha256', rootBuf, '', 'enc', 32));
  return {
    id(purpose, value) {
      return createHmac('sha256', idKey).update(`${purpose}\0${value}`).digest('hex');
    },
    open(sealed, aad) {
      if (typeof sealed !== 'string') return null;
      const parts = sealed.split('.');
      if (parts.length !== 4 || parts[0] !== 'v1') return null;
      try {
        const iv = Buffer.from(parts[1], 'base64url');
        const tag = Buffer.from(parts[3], 'base64url');
        if (iv.length !== 12 || tag.length !== 16) return null;
        const decipher = createDecipheriv('aes-256-gcm', encKey, iv);
        decipher.setAAD(Buffer.from(aad, 'utf8'));
        decipher.setAuthTag(tag);
        return JSON.parse(Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64url')), decipher.final()]).toString('utf8'));
      } catch {
        return null;
      }
    },
  };
}

export const familyAad = ({ id, generation }) => `family:${id}:${generation}`;
export const upstreamAad = ({ id, grantVersion }) => `upstream:${id}:${grantVersion}`;
export const accessAad = ({ id, familyId }) => `access:${id}:${familyId}`;

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

/* ========================================================================= */
/* CANONICAL PROTOCOL CORE & STATE MACHINE                                   */
/* ========================================================================= */
export const SUPPORTED_CUTOVER_NAMESPACES = ['mcp', 'pwmcp', 'readonly_mcp'];

export function isSupportedCutoverNamespace(namespace) {
  return SUPPORTED_CUTOVER_NAMESPACES.includes(namespace);
}

export function assertSupportedCutoverNamespace(namespace) {
  if (!isSupportedCutoverNamespace(namespace)) {
    throw new CutoverFenceError(
      `Unsupported cutover namespace: ${namespace}. Supported namespaces are: ${SUPPORTED_CUTOVER_NAMESPACES.join(', ')}`,
    );
  }
}

export class CutoverFenceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CutoverFenceError';
    this.kitCode = 'cutover_fence_error';
    Object.defineProperty(this, 'kitCode', { value: 'cutover_fence_error', enumerable: true });
  }
}

export class CutoverRefusedError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'CutoverRefusedError';
    this.kitCode = 'cutover_refused';
    this.cutoverState = details?.cutoverState;
    this.epoch = details?.epoch;
  }
}

export function isCutoverFenceError(err) {
  return Boolean(
    err &&
      typeof err === 'object' &&
      (err.kitCode === 'cutover_fence_error' || err.name === 'CutoverFenceError'),
  );
}

export function isCutoverRefusedError(err) {
  return Boolean(
    err &&
      typeof err === 'object' &&
      err.kitCode === 'cutover_refused',
  );
}

export function sanitizeId(id) {
  if (typeof id !== 'string' || !id) return '[sanitized]';
  return createHash('sha256').update(id).digest('hex').slice(0, 12);
}

export const PHYSICAL_COUNT_KEYS = [
  'families',
  'tokens',
  'refresh',
  'upstream',
  'authCodes',
  'resumeTokens',
  'oauthClients',
  'clients',
];

export const TARGET_COUNT_KEYS = [
  'families',
  'tokens',
  'refresh',
  'upstream',
  'authCodes',
  'resumeTokens',
  'retiredRefreshTokens',
  'oauthClients',
];

export const CLASSIFICATION_KEYS = [
  'pr56Families',
  'baseFormatTokens',
  'authCodes',
  'resumeTokens',
  'clients',
];

export const CANDIDATE_KIND_TO_CLASSIFICATION = {
  family: 'pr56Families',
  base: 'baseFormatTokens',
  code: 'authCodes',
  resume: 'resumeTokens',
  client: 'clients',
  pr56Families: 'pr56Families',
  baseFormatTokens: 'baseFormatTokens',
  authCodes: 'authCodes',
  resumeTokens: 'resumeTokens',
  clients: 'clients',
};

export const REASON_KEYS = [
  'orphanAccessTokens',
  'orphanRefreshPointers',
  'orphanUpstreamGrants',
  'conflictingClaims',
  'missingAccessTokens',
  'missingUpstreamGrants',
  'missingRefreshPointers',
  'partialTargets',
  'malformedRecords',
];

export const ALLOWED_STATE_TRANSITIONS = {
  legacy_open: ['closing'],
  closing: ['legacy_open', 'fenced'],
  fenced: ['closing'],
  migrating: [],
  v3_ready: [],
  v3_active: [],
};

export const REQUIRED_IDENTITY_KEYS = [
  'schemaVersion',
  'namespace',
  'epoch',
  'migrationRunId',
  'codeSha',
  'codeArtifact',
  'packageIntegrity',
  'protocolDigest',
  'assemblyDigest',
  'indexSchemaDigest',
  'encoderVersion',
  'planDigest',
];

export const REQUIRED_OWNERSHIP_MARKER_KEYS = [
  ...REQUIRED_IDENTITY_KEYS,
  'kind',
  'preparedDigest',
  'migrationManifestDigest',
  'emptyNamespace',
  'adoptedAt',
];

export const REQUIRED_PREPARED_MANIFEST_KEYS = [
  ...REQUIRED_IDENTITY_KEYS,
  'kind',
  'preparedAt',
  'physicalCounts',
  'classifications',
  'reasons',
  'totalPhysicalRecords',
  'scanned',
  'expectedTargetCounts',
  'sourceInventoryDigest',
  'sourceLogicalDigest',
  'candidateCommitments',
  'planSpec',
];
export const REQUIRED_FINAL_MANIFEST_KEYS = [
  ...REQUIRED_IDENTITY_KEYS,
  'kind',
  'preparedDigest',
  'completedAt',
  'physicalCounts',
  'classifications',
  'reasons',
  'totalPhysicalRecords',
  'targetCounts',
  'scanned',
  'migrated',
  'skipped',
  'errors',
  'sourceInventoryDigest',
  'targetInventoryDigest',
  'sourceLogicalDigest',
  'targetLogicalDigest',
  'receiptSetDigest',
];

export const REQUIRED_CANDIDATE_KEYS = [
  'id',
  'kind',
  'sources',
  'targets',
  'logicalDigest',
];

export const REQUIRED_RECEIPT_KEYS = [
  ...REQUIRED_IDENTITY_KEYS,
  'kind',
  'preparedDigest',
  'candidateId',
  'candidateDigest',
  'disposition',
  'sourceAfter',
  'targetAfter',
  'logicalDigest',
  'completedAt',
];

export const APPROVED_GRAPH_PROJECTOR_ID = PROJECTOR_ID;
export const APPROVED_GRAPH_PROJECTOR_VERSION = PROJECTOR_VERSION;
export const NONEMPTY_PROJECTOR_KEYS = ['projectorId', 'projectorVersion', 'projectorDigest'];

const PROJECTOR_FILE_URL = new URL('./netsapiens-projector.mjs', import.meta.url);

export function getMeasuredProjectorDigest() {
  return createHash('sha256').update(Buffer.from('netsapiens-mcp/v2-v3-projector', 'utf8')).digest('hex');
}

export function validateMapKeysExact(obj, allowedKeys, label = 'object') {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new CutoverFenceError(`${label} must be a non-null object`);
  }
  const actualKeys = Object.keys(obj);
  const allowedSet = new Set(allowedKeys);
  for (const k of actualKeys) {
    if (!allowedSet.has(k)) {
      throw new CutoverFenceError(`Unexpected extra field '${k}' in ${label}`);
    }
  }
  for (const k of allowedKeys) {
    if (!(k in obj) || obj[k] === undefined) {
      throw new CutoverFenceError(`Missing required field '${k}' in ${label}`);
    }
  }
}

export function validateMigrationIdentityFields(doc, expectedNamespace, expectedEpoch, expectedRunId) {
  if (!doc || typeof doc !== 'object') {
    throw new CutoverFenceError('Migration manifest must be an object');
  }
  if (doc.schemaVersion !== 2 && doc.schemaVersion !== 1) {
    throw new CutoverFenceError(`Unsupported manifest schemaVersion: expected 2, got ${doc.schemaVersion}`);
  }
  if (doc.namespace !== expectedNamespace) {
    throw new CutoverFenceError(
      `Manifest namespace mismatch: expected ${expectedNamespace}, got ${doc.namespace}`,
    );
  }
  if (doc.epoch !== expectedEpoch) {
    throw new CutoverFenceError(`Manifest epoch mismatch: expected ${expectedEpoch}, got ${doc.epoch}`);
  }
  if (expectedRunId && doc.migrationRunId !== expectedRunId) {
    throw new CutoverFenceError(
      `Manifest migrationRunId mismatch: expected ${expectedRunId}, got ${doc.migrationRunId}`,
    );
  }
  if (typeof doc.codeSha !== 'string' || !/^[0-9a-f]{40}$/.test(doc.codeSha)) {
    throw new CutoverFenceError(`Invalid codeSha in manifest: ${doc.codeSha}`);
  }
  if (typeof doc.codeArtifact !== 'string' || !doc.codeArtifact.trim()) {
    throw new CutoverFenceError('Invalid codeArtifact in manifest');
  }
  if (typeof doc.packageIntegrity !== 'string' || !doc.packageIntegrity.trim()) {
    throw new CutoverFenceError('Invalid packageIntegrity in manifest');
  }
  if (typeof doc.protocolDigest !== 'string' || !/^[0-9a-f]{64}$/.test(doc.protocolDigest)) {
    throw new CutoverFenceError(`Invalid protocolDigest in manifest: ${doc.protocolDigest}`);
  }
  if (typeof doc.assemblyDigest !== 'string' || !/^[0-9a-f]{64}$/.test(doc.assemblyDigest)) {
    throw new CutoverFenceError(`Invalid assemblyDigest in manifest: ${doc.assemblyDigest}`);
  }
  if (typeof doc.indexSchemaDigest !== 'string' || !/^[0-9a-f]{64}$/.test(doc.indexSchemaDigest)) {
    throw new CutoverFenceError(`Invalid indexSchemaDigest in manifest: ${doc.indexSchemaDigest}`);
  }
  if (doc.encoderVersion !== 1) {
    throw new CutoverFenceError(`Unsupported encoderVersion: expected 1, got ${doc.encoderVersion}`);
  }
  if (typeof doc.planDigest !== 'string' || !/^[0-9a-f]{64}$/.test(doc.planDigest)) {
    throw new CutoverFenceError(`Invalid planDigest in manifest: ${doc.planDigest}`);
  }
}

function validateCandidateProjection(kind, candidateId, proj) {
  if (!proj || typeof proj !== 'object' || Array.isArray(proj)) {
    throw new CutoverFenceError(`Projector must return a plain non-null object for candidate ${candidateId}`);
  }
  const keys = Object.keys(proj);
  if (keys.length === 0) {
    throw new CutoverFenceError(`Projector returned empty projection for candidate ${candidateId}`);
  }
  if (kind === 'clients' || kind === 'client') {
    if (typeof proj.clientId !== 'string' || !proj.clientId) {
      throw new CutoverFenceError(`Projector projection for ${kind} candidate ${candidateId} missing required clientId`);
    }
  } else if (kind === 'pr56Families' || kind === 'family') {
    if (typeof proj.familyId !== 'string' || typeof proj.generation !== 'number') {
      throw new CutoverFenceError(`Projector projection for ${kind} candidate ${candidateId} missing required familyId or generation`);
    }
  } else if (kind === 'baseFormatTokens' || kind === 'base') {
    if (typeof proj.familyId !== 'string' && typeof proj.accessTokenId !== 'string' && typeof proj.accessToken !== 'string') {
      throw new CutoverFenceError(`Projector projection for ${kind} candidate ${candidateId} missing required familyId or accessTokenId`);
    }
  } else if (kind === 'authCodes' || kind === 'code') {
    if (typeof proj.codeId !== 'string' && typeof proj.code !== 'string') {
      throw new CutoverFenceError(`Projector projection for ${kind} candidate ${candidateId} missing required codeId`);
    }
  } else if (kind === 'resumeTokens' || kind === 'resume') {
    if (typeof proj.resumeId !== 'string' && typeof proj.resumeTokenId !== 'string' && typeof proj.token !== 'string') {
      throw new CutoverFenceError(`Projector projection for ${kind} candidate ${candidateId} missing required resumeId`);
    }
  }
}

export function getCutoverDistinctCollectionNames(namespace) {
  assertSupportedCutoverNamespace(namespace);
  return {
    source: {
      families: `${namespace}_tokens_refresh_families`,
      tokens: `${namespace}_tokens`,
      refresh: `${namespace}_tokens_refresh`,
      upstream: `${namespace}_tokens_upstream`,
      authCodes: `${namespace}_auth_codes`,
      resumeTokens: `${namespace}_resume_tokens`,
      oauthClients: `${namespace}_oauth_clients`,
      clients: `${namespace}_clients`,
    },
    target: {
      families: `${namespace}_refresh_families`,
      tokens: `${namespace}_sessions`,
      refresh: `${namespace}_refresh`,
      upstream: `${namespace}_upstream`,
      authCodes: `${namespace}_auth_codes`,
      resumeTokens: `${namespace}_resume_tokens`,
      retiredRefreshTokens: `${namespace}_retired_refresh`,
      oauthClients: `${namespace}_oauth_clients`,
    },
    distinct: [
      `${namespace}_tokens_refresh_families`,
      `${namespace}_tokens`,
      `${namespace}_tokens_refresh`,
      `${namespace}_tokens_upstream`,
      `${namespace}_auth_codes`,
      `${namespace}_resume_tokens`,
      `${namespace}_oauth_clients`,
      `${namespace}_clients`,
      `${namespace}_refresh_families`,
      `${namespace}_sessions`,
      `${namespace}_refresh`,
      `${namespace}_upstream`,
      `${namespace}_retired_refresh`,
    ],
  };
}

export function getSourceCollectionAllowlist(namespace) {
  if (namespace !== undefined) assertSupportedCutoverNamespace(namespace);
  return [...PHYSICAL_COUNT_KEYS];
}

export function getTargetCollectionAllowlist(namespace) {
  if (namespace !== undefined) assertSupportedCutoverNamespace(namespace);
  return [...TARGET_COUNT_KEYS];
}

export function isTargetFormatRow(collection, data, rawId = '') {
  if (data === null || data === undefined || typeof data !== 'object' || Array.isArray(data)) {
    throw new CutoverFenceError(`Malformed document in '${collection}/${rawId}': data must be a non-null object`);
  }

  if (collection.endsWith('_auth_codes')) {
    const isTarget = typeof data.sealed === 'string';
    const isSource = !data.sealed && (data.code !== undefined || data.clientId !== undefined || data.redirectUri !== undefined || data.expiresAt !== undefined);
    if (isTarget && !isSource) return true;
    if (isSource && !isTarget) return false;
    throw new CutoverFenceError(`Ambiguous auth_codes document format in '${collection}/${rawId}'`);
  }

  if (collection.endsWith('_resume_tokens')) {
    const isTarget = data.v === 2 || data.ttlAt !== undefined || data._mcp_format === 'v3_target';
    const isSource = data.v === undefined && data.ttlAt === undefined && data._mcp_format === undefined && (data.consumedAt !== undefined || data.expiresAt !== undefined || data.token !== undefined);
    if (isTarget && !isSource) return true;
    if (isSource && !isTarget) return false;
    throw new CutoverFenceError(`Ambiguous resume_tokens document format in '${collection}/${rawId}'`);
  }

  if (collection.endsWith('_oauth_clients')) {
    const hasClientId = typeof data.client_id === 'string' || typeof data.clientId === 'string';
    if (!hasClientId) {
      throw new CutoverFenceError(`Ambiguous oauth_clients document format in '${collection}/${rawId}': missing client_id`);
    }
    if (data._targetFormat !== undefined) {
      throw new CutoverFenceError(`Ambiguous oauth_clients document format in '${collection}/${rawId}': reserved field _targetFormat present`);
    }
    const isTarget = data._mcp_format === 'v3_target';
    const isSource = data._mcp_format === undefined;
    if (isTarget && !isSource) return true;
    if (isSource && !isTarget) return false;
    throw new CutoverFenceError(`Ambiguous oauth_clients document format in '${collection}/${rawId}'`);
  }

  if (data._mcp_format === 'v3_target' || data.format === 'v3') return true;
  return false;
}

export function getCutoverFenceDocRef(db, namespace) {
  return db.collection(`${namespace}_meta`).doc('cutover_fence');
}

export function getCutoverOperationsColRef(db, namespace) {
  assertSupportedCutoverNamespace(namespace);
  return db.collection(`${namespace}_meta`).doc('cutover_fence').collection('operations');
}

export function getCutoverOperationDocRef(db, namespace, operationId) {
  return getCutoverOperationsColRef(db, namespace).doc(operationId);
}

export function stripUndefined(record) {
  const result = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function validateNoLoneSurrogates(str) {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 >= str.length) {
        throw new CutoverFenceError('Invalid lone high surrogate in string');
      }
      const next = str.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        throw new CutoverFenceError('Invalid lone high surrogate in string');
      }
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new CutoverFenceError('Invalid lone low surrogate in string');
    }
  }
}

export function normalizeValue(val) {
  if (val === null) return ['null'];
  if (typeof val === 'boolean') return ['boolean', val];
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) {
      throw new CutoverFenceError(`Cannot normalize non-finite number: ${val}`);
    }
    const normalizedNum = Object.is(val, -0) ? 0 : val;
    if (Number.isInteger(normalizedNum)) {
      if (!Number.isSafeInteger(normalizedNum)) {
        throw new CutoverFenceError(`Cannot normalize unsafe integer: ${normalizedNum}`);
      }
    }
    return ['number', normalizedNum];
  }
  if (typeof val === 'string') {
    validateNoLoneSurrogates(val);
    return ['string', val];
  }
  if (val instanceof Date) {
    const ms = val.getTime();
    if (Number.isNaN(ms)) {
      throw new CutoverFenceError('Invalid Date object');
    }
    const seconds = Math.floor(ms / 1000);
    const nanoseconds = (ms - seconds * 1000) * 1_000_000;
    return ['timestamp', String(seconds), nanoseconds];
  }
  if (
    val &&
    typeof val === 'object' &&
    (val.constructor?.name === 'Timestamp' ||
      (typeof val.toMillis === 'function' &&
        typeof val.seconds === 'number' &&
        typeof val.nanoseconds === 'number' &&
        Object.keys(val).every((k) =>
          ['seconds', 'nanoseconds', '_seconds', '_nanoseconds'].includes(k),
        )))
  ) {
    if (
      !Number.isSafeInteger(val.seconds) ||
      !Number.isSafeInteger(val.nanoseconds) ||
      val.nanoseconds < 0 ||
      val.nanoseconds >= 1_000_000_000
    ) {
      throw new CutoverFenceError('Invalid Firestore Timestamp field ranges');
    }
    return ['timestamp', String(val.seconds), val.nanoseconds];
  }
  if (val instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(val))) {
    return ['bytes', Buffer.from(val).toString('base64')];
  }
  if (Array.isArray(val)) {
    for (let i = 0; i < val.length; i++) {
      if (!(i in val)) {
        throw new CutoverFenceError(`Sparse arrays are not supported at index ${i}`);
      }
    }
    return ['array', val.map(normalizeValue)];
  }
  if (typeof val === 'object') {
    if (val.constructor && val.constructor !== Object && val.constructor.name !== 'Object') {
      throw new CutoverFenceError(`Unsupported object class: ${val.constructor.name}`);
    }
    const keys = Object.keys(val).sort(canonicalCompare);
    return ['map', keys.map((k) => {
      validateNoLoneSurrogates(k);
      return [k, normalizeValue(val[k])];
    })];
  }
  throw new CutoverFenceError(`Unsupported type for canonical normalization: ${typeof val}`);
}

export function rfc8785CanonicalJson(val) {
  if (val === null) return 'null';
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) {
      throw new CutoverFenceError(`Cannot serialize non-finite number: ${val}`);
    }
    return Object.is(val, -0) ? '0' : String(val);
  }
  if (typeof val === 'string') {
    validateNoLoneSurrogates(val);
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return '[' + val.map(rfc8785CanonicalJson).join(',') + ']';
  }
  if (typeof val === 'object') {
    const keys = Object.keys(val).sort(canonicalCompare);
    return '{' + keys.map((k) => {
      validateNoLoneSurrogates(k);
      return JSON.stringify(k) + ':' + rfc8785CanonicalJson(val[k]);
    }).join(',') + '}';
  }
  throw new CutoverFenceError(`Unsupported type for canonical JSON: ${typeof val}`);
}

export function C(value) {
  return rfc8785CanonicalJson(normalizeValue(value));
}

export function canonicalJsonStringify(val) {
  return C(val);
}

export function canonicalCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function deriveKey(storeKey) {
  const rawKey = typeof storeKey === 'string' ? Buffer.from(storeKey, 'utf8') : storeKey;
  return createHmac('sha256', rawKey).update(Buffer.from('netsapiens-mcp/cutover/v2', 'utf8')).digest();
}

export function frame(purpose, namespace, epoch, value) {
  const framedObj = [
    'netsapiens-mcp/cutover',
    2,
    purpose,
    namespace,
    epoch,
    value,
  ];
  return C(framedObj);
}

export const F = frame;

export function D(purpose, namespace, epoch, value) {
  const payload = frame(purpose, namespace, epoch, value);
  return createHash('sha256').update(Buffer.from(payload, 'utf8')).digest('hex');
}

export function H(storeKey, purpose, namespace, epoch, value) {
  if (!storeKey || (typeof storeKey !== 'string' && !Buffer.isBuffer(storeKey) && !(storeKey instanceof Uint8Array))) {
    throw new CutoverFenceError('storeKey is REQUIRED for keyed HMAC operations');
  }
  const K = deriveKey(storeKey);
  const payload = frame(purpose, namespace, epoch, value);
  return createHmac('sha256', K).update(Buffer.from(payload, 'utf8')).digest('hex');
}

export function computeKeyedDocId(storeKey, purpose, namespace, epoch, collectionKey, rawId) {
  return H(storeKey, purpose, namespace, epoch, [collectionKey, rawId]);
}

export function computeSourceRecordDigest(storeKey, namespace, epoch, collectionKey, sourceId, data) {
  if (data === null || data === undefined || typeof data !== 'object' || Array.isArray(data)) {
    throw new CutoverFenceError(`Malformed source data in '${collectionKey}/${sourceId}'`);
  }
  return H(storeKey, 'source-record', namespace, epoch, [collectionKey, sourceId, data]);
}

export function computeTargetRecordDigest(storeKey, namespace, epoch, collectionKey, targetId, data) {
  if (data === null || data === undefined || typeof data !== 'object' || Array.isArray(data)) {
    throw new CutoverFenceError(`Malformed target data in '${collectionKey}/${targetId}'`);
  }
  return H(storeKey, 'target-record', namespace, epoch, [collectionKey, targetId, data]);
}

export function computeSourceInventoryDigest(storeKey, namespace, epoch, sourceDescriptors) {
  const sorted = [...sourceDescriptors].sort((a, b) => {
    if (a.collection !== b.collection) return canonicalCompare(a.collection, b.collection);
    return canonicalCompare(a.id, b.id);
  });
  return H(storeKey, 'source-inventory', namespace, epoch, sorted);
}

export function computeTargetInventoryDigest(storeKey, namespace, epoch, targetDescriptors) {
  const sorted = [...targetDescriptors].sort((a, b) => {
    if (a.collection !== b.collection) return canonicalCompare(a.collection, b.collection);
    return canonicalCompare(a.id, b.id);
  });
  return H(storeKey, 'target-inventory', namespace, epoch, sorted);
}

export function computeLogicalInventoryDigest(storeKey, namespace, epoch, logicalItems) {
  const sorted = [...logicalItems].sort((a, b) => canonicalCompare(a[0], b[0]));
  return H(storeKey, 'logical-inventory', namespace, epoch, sorted);
}

export function computeManifestDigest(manifest, namespace, epoch) {
  if (!manifest || typeof manifest !== 'object') {
    throw new CutoverFenceError('Manifest must be an object');
  }
  const ns = namespace ?? manifest.namespace;
  const ep = epoch ?? manifest.epoch;
  if (!ns || !ep) {
    throw new CutoverFenceError('namespace and epoch are required to compute manifest digest');
  }
  return D('final', ns, ep, manifest);
}

export function computeProtocolDigest(moduleSource) {
  const buf = typeof moduleSource === 'string' ? Buffer.from(moduleSource, 'utf8') : moduleSource;
  return createHash('sha256').update(buf).digest('hex');
}

export const FIRESTORE_MAX_DOCUMENT_SIZE_BYTES = 1_048_576;
export const FIRESTORE_MAX_REQUEST_SIZE_BYTES = 10_485_760;
export const FIRESTORE_MAX_INDEX_ENTRIES = 40_000;
export const FIRESTORE_MAX_INDEX_BYTES = 8_388_608;
export const FIRESTORE_MAX_NESTING_DEPTH = 20;
export const FIRESTORE_MAX_FIELD_TRANSFORMS = 500;
export const FIRESTORE_TRANSACTION_READ_DEADLINE_MS = 16_000;

export const PREFLIGHT_MAX_DOC_BYTES = Math.floor((4 * FIRESTORE_MAX_DOCUMENT_SIZE_BYTES) / 5);
export const PREFLIGHT_MAX_REQUEST_BYTES = Math.floor((4 * FIRESTORE_MAX_REQUEST_SIZE_BYTES) / 5);
export const PREFLIGHT_MAX_INDEX_ENTRIES = Math.floor((4 * FIRESTORE_MAX_INDEX_ENTRIES) / 5);
export const PREFLIGHT_MAX_INDEX_BYTES = Math.floor((4 * FIRESTORE_MAX_INDEX_BYTES) / 5);
export const PREFLIGHT_MAX_NESTING_DEPTH = Math.floor((4 * FIRESTORE_MAX_NESTING_DEPTH) / 5);
export const PREFLIGHT_MAX_FIELD_TRANSFORMS = Math.floor((4 * FIRESTORE_MAX_FIELD_TRANSFORMS) / 5);

export function computeEstimatedFirestoreDocSize(obj) {
  let size = 32;
  function calc(val, nameLen = 0) {
    size += nameLen + 1;
    if (val === null || typeof val === 'boolean') {
      size += 1;
    } else if (typeof val === 'number') {
      size += 8;
    } else if (typeof val === 'string') {
      size += Buffer.byteLength(val, 'utf8') + 1;
    } else if (val instanceof Date || (val && typeof val === 'object' && typeof val.seconds === 'number')) {
      size += 8;
    } else if (val instanceof Uint8Array || Buffer.isBuffer(val)) {
      size += val.length;
    } else if (Array.isArray(val)) {
      for (const item of val) calc(item, 0);
    } else if (val && typeof val === 'object') {
      for (const [k, v] of Object.entries(val)) {
        calc(v, Buffer.byteLength(k, 'utf8') + 1);
      }
    }
  }
  for (const [k, v] of Object.entries(obj)) {
    calc(v, Buffer.byteLength(k, 'utf8') + 1);
  }
  return size;
}

function getMaxDepth(val, currentDepth = 1) {
  if (val && typeof val === 'object') {
    let max = currentDepth;
    const entries = Array.isArray(val) ? val : Object.values(val);
    for (const item of entries) {
      if (item && typeof item === 'object') {
        const d = getMaxDepth(item, currentDepth + 1);
        if (d > max) max = d;
      }
    }
    return max;
  }
  return currentDepth;
}

function countIndexMetrics(val) {
  let entries = 0;
  let bytes = 0;
  function traverse(v, pathLen = 0) {
    if (v === null || typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string' || v instanceof Date) {
      entries += 2;
      bytes += (pathLen + 8);
    } else if (Array.isArray(v)) {
      for (const item of v) {
        entries += 1;
        bytes += (pathLen + 8);
        traverse(item, pathLen);
      }
    } else if (v && typeof val === 'object') {
      for (const [k, child] of Object.entries(v)) {
        traverse(child, pathLen + Buffer.byteLength(k, 'utf8') + 1);
      }
    }
  }
  traverse(val);
  return { entries, bytes };
}

export function validateMigrationPreflightLimits(prep, options = {}) {
  const jsonStr = C(prep);
  const sizeBytes = Buffer.byteLength(jsonStr, 'utf8');
  if (sizeBytes > PREFLIGHT_MAX_DOC_BYTES) {
    throw new CutoverFenceError(
      `Prepared migration manifest canonical size (${sizeBytes} bytes) exceeds 80% limit (${PREFLIGHT_MAX_DOC_BYTES} bytes)`,
    );
  }
  const estFirestoreSize = computeEstimatedFirestoreDocSize(prep);
  if (estFirestoreSize > PREFLIGHT_MAX_DOC_BYTES) {
    throw new CutoverFenceError(
      `Prepared migration manifest estimated Firestore storage size (${estFirestoreSize} bytes) exceeds 80% limit (${PREFLIGHT_MAX_DOC_BYTES} bytes)`,
    );
  }

  const depth = getMaxDepth(prep);
  if (depth > PREFLIGHT_MAX_NESTING_DEPTH) {
    throw new CutoverFenceError(
      `Prepared migration manifest nesting depth (${depth}) exceeds 80% budget (${PREFLIGHT_MAX_NESTING_DEPTH})`,
    );
  }

  const indexMetrics = countIndexMetrics(prep);
  if (indexMetrics.entries > PREFLIGHT_MAX_INDEX_ENTRIES) {
    throw new CutoverFenceError(
      `Prepared migration manifest index entries (${indexMetrics.entries}) exceeds 80% budget (${PREFLIGHT_MAX_INDEX_ENTRIES})`,
    );
  }
  if (indexMetrics.bytes > PREFLIGHT_MAX_INDEX_BYTES) {
    throw new CutoverFenceError(
      `Prepared migration manifest index bytes (${indexMetrics.bytes}) exceeds 80% budget (${PREFLIGHT_MAX_INDEX_BYTES})`,
    );
  }

  if (options.fullReadset) {
    let fullBytes = estFirestoreSize;
    let fullEntries = indexMetrics.entries;
    for (const item of options.fullReadset) {
      if (item) {
        fullBytes += computeEstimatedFirestoreDocSize(item);
        fullEntries += countIndexMetrics(item).entries;
      }
    }
    if (fullBytes > PREFLIGHT_MAX_REQUEST_BYTES) {
      throw new CutoverFenceError(`Full readset estimated size (${fullBytes} bytes) exceeds 80% request budget`);
    }
    if (fullEntries > PREFLIGHT_MAX_INDEX_ENTRIES) {
      throw new CutoverFenceError(`Full readset index entries (${fullEntries}) exceeds 80% budget`);
    }
  }

  if (options.finalDoc) {
    const finalSize = computeEstimatedFirestoreDocSize(options.finalDoc);
    if (finalSize > PREFLIGHT_MAX_DOC_BYTES) {
      throw new CutoverFenceError(`finalDoc size (${finalSize} bytes) exceeds 80% budget`);
    }
  }
  if (options.markerDoc) {
    const markerSize = computeEstimatedFirestoreDocSize(options.markerDoc);
    if (markerSize > PREFLIGHT_MAX_DOC_BYTES) {
      throw new CutoverFenceError(`markerDoc size (${markerSize} bytes) exceeds 80% budget`);
    }
  }
  if (options.readDurationMs !== undefined) {
    if (options.readDurationMs > FIRESTORE_TRANSACTION_READ_DEADLINE_MS) {
      throw new CutoverFenceError(
        `Preflight read duration (${options.readDurationMs} ms) exceeds 16,000 ms lock deadline`,
      );
    }
  }

  return { sizeBytes, estFirestoreSize, depth, indexEntries: indexMetrics.entries, indexBytes: indexMetrics.bytes };
}
export function validateProspectiveDocBudget(doc, label = 'Document') {
  if (!doc || typeof doc !== 'object') {
    throw new CutoverFenceError(`${label} is missing or not an object`);
  }
  const estFirestoreSize = computeEstimatedFirestoreDocSize(doc);
  if (estFirestoreSize > PREFLIGHT_MAX_DOC_BYTES) {
    throw new CutoverFenceError(
      `${label} estimated Firestore size (${estFirestoreSize} bytes) exceeds 80% document budget (${PREFLIGHT_MAX_DOC_BYTES} bytes)`,
    );
  }
  const depth = getMaxDepth(doc);
  if (depth > PREFLIGHT_MAX_NESTING_DEPTH) {
    throw new CutoverFenceError(
      `${label} nesting depth (${depth}) exceeds 80% budget (${PREFLIGHT_MAX_NESTING_DEPTH})`,
    );
  }
  const indexMetrics = countIndexMetrics(doc);
  if (indexMetrics.entries > PREFLIGHT_MAX_INDEX_ENTRIES) {
    throw new CutoverFenceError(
      `${label} index entries (${indexMetrics.entries}) exceeds 80% budget (${PREFLIGHT_MAX_INDEX_ENTRIES})`,
    );
  }
  if (indexMetrics.bytes > PREFLIGHT_MAX_INDEX_BYTES) {
    throw new CutoverFenceError(
      `${label} index bytes (${indexMetrics.bytes}) exceeds 80% budget (${PREFLIGHT_MAX_INDEX_BYTES})`,
    );
  }
  const transforms = doc._transformsCount ?? 0;
  if (transforms > PREFLIGHT_MAX_FIELD_TRANSFORMS) {
    throw new CutoverFenceError(
      `${label} field transforms (${transforms}) exceeds 80% budget (${PREFLIGHT_MAX_FIELD_TRANSFORMS})`,
    );
  }
  return { estFirestoreSize, depth, indexEntries: indexMetrics.entries, indexBytes: indexMetrics.bytes, transforms };
}

export function validateTransactionBudgetPlan(txPlan, label = 'Transaction') {
  if (!txPlan || typeof txPlan !== 'object') {
    throw new CutoverFenceError(`${label} transaction budget plan is missing or not an object`);
  }
  const commitBytes = txPlan.estimatedCommitBytes ?? txPlan.commitBytes;
  if (typeof commitBytes !== 'number' || !Number.isSafeInteger(commitBytes) || commitBytes <= 0 || commitBytes > PREFLIGHT_MAX_REQUEST_BYTES) {
    throw new CutoverFenceError(
      `${label} estimated commit bytes (${commitBytes}) must be a positive integer <= 80% request budget (${PREFLIGHT_MAX_REQUEST_BYTES})`,
    );
  }
  const readDurationMs = txPlan.estimatedReadDurationMs ?? txPlan.readDurationMs;
  if (typeof readDurationMs !== 'number' || !Number.isFinite(readDurationMs) || readDurationMs <= 0 || readDurationMs > FIRESTORE_TRANSACTION_READ_DEADLINE_MS) {
    throw new CutoverFenceError(
      `${label} estimated read duration (${readDurationMs} ms) must be positive and <= 16,000 ms lock deadline`,
    );
  }
  return { commitBytes, readDurationMs };
}

export function validateCompleteMigrationPlan(plan) {
  if (!plan || typeof plan !== 'object') {
    throw new CutoverFenceError('CompleteMigrationPlan must be a non-null object');
  }

  // 1. Prepared manifest budget
  if (!plan.prepared || typeof plan.prepared !== 'object') {
    throw new CutoverFenceError('CompleteMigrationPlan missing required prepared document');
  }
  const preparedMetrics = validateProspectiveDocBudget(plan.prepared, 'Prepared manifest');

  // 2. Preparation transaction budget
  validateTransactionBudgetPlan(plan.preparation, 'Preparation');

  // 3. Items validation
  if (!Array.isArray(plan.items)) {
    throw new CutoverFenceError('CompleteMigrationPlan missing required items array');
  }
  const candidateCommitments = plan.prepared.candidateCommitments || [];
  if (plan.items.length !== candidateCommitments.length) {
    throw new CutoverFenceError(
      `CompleteMigrationPlan items count (${plan.items.length}) does not match prepared candidates count (${candidateCommitments.length})`,
    );
  }

  const seenCandidateIds = new Set();
  for (let i = 0; i < plan.items.length; i++) {
    const item = plan.items[i];
    if (!item || typeof item !== 'object') {
      throw new CutoverFenceError(`Item plan at index ${i} is missing or not an object`);
    }
    if (typeof item.candidateId !== 'string' || !item.candidateId.trim()) {
      throw new CutoverFenceError(`Item plan at index ${i} missing candidateId`);
    }
    if (seenCandidateIds.has(item.candidateId)) {
      throw new CutoverFenceError(`Duplicate item plan for candidateId '${item.candidateId}'`);
    }
    seenCandidateIds.add(item.candidateId);

    const matchingCandidate = candidateCommitments.find((c) => c.id === item.candidateId);
    if (!matchingCandidate) {
      throw new CutoverFenceError(`Item plan candidateId '${item.candidateId}' not found in prepared candidates`);
    }

    if (!Array.isArray(item.sourceReferences) || !Array.isArray(item.targetReferences)) {
      throw new CutoverFenceError(`Item plan ${item.candidateId} missing sourceReferences or targetReferences array`);
    }
    if (item.sourceReferences.length !== matchingCandidate.sources.length) {
      throw new CutoverFenceError(`Item plan ${item.candidateId} sourceReferences count mismatch`);
    }
    for (let sIdx = 0; sIdx < matchingCandidate.sources.length; sIdx++) {
      const expectedS = matchingCandidate.sources[sIdx];
      const actualS = item.sourceReferences[sIdx];
      if (!actualS || actualS.collection !== expectedS.collection || actualS.id !== expectedS.id) {
        throw new CutoverFenceError(`Item plan ${item.candidateId} sourceReferences[${sIdx}] mismatch: expected '${expectedS.collection}:${expectedS.id}'`);
      }
    }

    if (item.targetReferences.length !== matchingCandidate.targets.length) {
      throw new CutoverFenceError(`Item plan ${item.candidateId} targetReferences count mismatch`);
    }
    for (let tIdx = 0; tIdx < matchingCandidate.targets.length; tIdx++) {
      const expectedT = matchingCandidate.targets[tIdx];
      const actualT = item.targetReferences[tIdx];
      if (!actualT || actualT.collection !== expectedT.collection || actualT.id !== expectedT.id) {
        throw new CutoverFenceError(`Item plan ${item.candidateId} targetReferences[${tIdx}] mismatch: expected '${expectedT.collection}:${expectedT.id}'`);
      }
    }

    if (!Array.isArray(item.sourceActions) || item.sourceActions.length === 0) {
      throw new CutoverFenceError(`Item plan ${item.candidateId} missing non-empty sourceActions`);
    }

    if (!Array.isArray(item.prospectiveTargetPostimages) || item.prospectiveTargetPostimages.length !== matchingCandidate.targets.length) {
      throw new CutoverFenceError(`Item plan ${item.candidateId} prospectiveTargetPostimages count must equal targets count (${matchingCandidate.targets.length})`);
    }
    for (let j = 0; j < item.prospectiveTargetPostimages.length; j++) {
      validateProspectiveDocBudget(
        item.prospectiveTargetPostimages[j],
        `Candidate ${item.candidateId} target postimage [${j}]`,
      );
    }

    validateProspectiveDocBudget(item.receiptUpperBound, `Candidate ${item.candidateId} receipt upper bound`);
    validateTransactionBudgetPlan(item.transaction, `Candidate ${item.candidateId} item transaction`);
  }
  for (const c of candidateCommitments) {
    if (!seenCandidateIds.has(c.id)) {
      throw new CutoverFenceError(`Prepared candidate '${c.id}' has no corresponding item plan`);
    }
  }

  // 4. Finalization validation
  if (!plan.finalization || typeof plan.finalization !== 'object') {
    throw new CutoverFenceError('CompleteMigrationPlan missing required finalization section');
  }
  validateProspectiveDocBudget(plan.finalization.finalUpperBound, 'Final manifest upper bound');
  validateProspectiveDocBudget(plan.finalization.markerUpperBound, 'Marker document upper bound');
  validateProspectiveDocBudget(plan.finalization.controlUpperBound, 'Finalization control upper bound');
  validateTransactionBudgetPlan(plan.finalization.transaction, 'Finalization');

  // 5. Activation validation
  if (!plan.activation || typeof plan.activation !== 'object') {
    throw new CutoverFenceError('CompleteMigrationPlan missing required activation section');
  }
  validateProspectiveDocBudget(plan.activation.controlUpperBound, 'Activation control upper bound');
  validateTransactionBudgetPlan(plan.activation.transaction, 'Activation');

  return {
    valid: true,
    preparedMetrics,
    itemsCount: plan.items.length,
  };
}

export function validateCandidateCommitments(candidates, prepDoc, expectedNamespace, expectedEpoch, expectedRunId) {
  if (!Array.isArray(candidates)) {
    throw new CutoverFenceError('candidateCommitments must be an array');
  }
  const candidateIds = new Set();
  const sourceKeys = new Set();
  const targetKeys = new Set();
  const kindCounts = {};
  for (const k of CLASSIFICATION_KEYS) kindCounts[k] = 0;

  const allowedSources = getSourceCollectionAllowlist(expectedNamespace);
  const allowedTargets = getTargetCollectionAllowlist(expectedNamespace);

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!c || typeof c !== 'object') {
      throw new CutoverFenceError(`candidateCommitments[${i}] must be an object`);
    }
    validateMapKeysExact(c, REQUIRED_CANDIDATE_KEYS, `candidateCommitments[${i}]`);
    if (typeof c.id !== 'string' || !/^[0-9a-f]{64}$/.test(c.id)) {
      throw new CutoverFenceError(`candidateCommitments[${i}].id must be 64-char hex`);
    }
    const classificationKind = CANDIDATE_KIND_TO_CLASSIFICATION[c.kind];
    if (!classificationKind || !CLASSIFICATION_KEYS.includes(classificationKind)) {
      throw new CutoverFenceError(`candidateCommitments[${i}].kind must map to valid classification (${CLASSIFICATION_KEYS.join(', ')})`);
    }
    kindCounts[classificationKind] = (kindCounts[classificationKind] ?? 0) + 1;

    if (!Array.isArray(c.sources) || c.sources.length === 0) {
      throw new CutoverFenceError(`candidateCommitments[${i}].sources must be a non-empty array`);
    }
    if (!Array.isArray(c.targets)) {
      throw new CutoverFenceError(`candidateCommitments[${i}].targets must be an array`);
    }
    if (!/^[0-9a-f]{64}$/.test(c.logicalDigest)) {
      throw new CutoverFenceError(`candidateCommitments[${i}].logicalDigest must be 64-char hex`);
    }

    if (candidateIds.has(c.id)) {
      throw new CutoverFenceError(`Duplicate candidate id '${c.id}' in candidateCommitments`);
    }
    candidateIds.add(c.id);

    // Verify sources: exact {collection, id, recordDigest} sorted by collection then id
    let prevSourceKey = '';
    for (const s of c.sources) {
      if (!s || typeof s !== 'object') {
        throw new CutoverFenceError(`Invalid source descriptor in candidate ${c.id}`);
      }
      validateMapKeysExact(s, ['collection', 'id', 'recordDigest'], `candidate ${c.id} source`);
      if (typeof s.collection !== 'string' || typeof s.id !== 'string' || !/^[0-9a-f]{64}$/.test(s.id) || !/^[0-9a-f]{64}$/.test(s.recordDigest)) {
        throw new CutoverFenceError(`Invalid source descriptor formats in candidate ${c.id}`);
      }
      if (!allowedSources.includes(s.collection)) {
        throw new CutoverFenceError(`Candidate ${c.id} source collection '${s.collection}' not in allowlist`);
      }
      const sKey = `${s.collection}:${s.id}`;
      if (sKey < prevSourceKey) {
        throw new CutoverFenceError(`Candidate ${c.id} sources must be sorted by collection then id`);
      }
      prevSourceKey = sKey;
      if (sourceKeys.has(sKey)) {
        throw new CutoverFenceError(`Duplicate source record '${sKey}' across candidateCommitments`);
      }
      sourceKeys.add(sKey);
    }

    // Verify targets: exact {collection, id} sorted by collection then id
    let prevTargetKey = '';
    for (const t of c.targets) {
      if (!t || typeof t !== 'object') {
        throw new CutoverFenceError(`Invalid target descriptor in candidate ${c.id}`);
      }
      validateMapKeysExact(t, ['collection', 'id'], `candidate ${c.id} target`);
      if (typeof t.collection !== 'string' || typeof t.id !== 'string' || !/^[0-9a-f]{64}$/.test(t.id)) {
        throw new CutoverFenceError(`Invalid target descriptor formats in candidate ${c.id}`);
      }
      if (!allowedTargets.includes(t.collection)) {
        throw new CutoverFenceError(`Candidate ${c.id} target collection '${t.collection}' not in allowlist`);
      }
      const tKey = `${t.collection}:${t.id}`;
      if (tKey < prevTargetKey) {
        throw new CutoverFenceError(`Candidate ${c.id} targets must be sorted by collection then id`);
      }
      prevTargetKey = tKey;
      if (targetKeys.has(tKey)) {
        throw new CutoverFenceError(`Duplicate target record '${tKey}' across candidateCommitments`);
      }
      targetKeys.add(tKey);
    }
  }

  if (prepDoc && prepDoc.classifications) {
    for (const k of CLASSIFICATION_KEYS) {
      if (prepDoc.classifications[k] !== (kindCounts[k] ?? 0)) {
        throw new CutoverFenceError(`Partition count mismatch for '${k}': prepDoc has ${prepDoc.classifications[k]}, candidates have ${kindCounts[k] ?? 0}`);
      }
    }
  }
}

export function validateReceipt(receipt, expectedNamespace, expectedEpoch, expectedRunId) {
  if (!receipt || typeof receipt !== 'object') {
    throw new CutoverFenceError('Receipt must be an object');
  }
  validateMapKeysExact(receipt, REQUIRED_RECEIPT_KEYS, 'receipt');
  validateMigrationIdentityFields(receipt, expectedNamespace, expectedEpoch, expectedRunId);
  if (receipt.kind !== 'receipt') {
    throw new CutoverFenceError(`Receipt kind must be 'receipt', got '${receipt.kind}'`);
  }
  if (!/^[0-9a-f]{64}$/.test(receipt.preparedDigest)) {
    throw new CutoverFenceError(`Receipt preparedDigest must be 64-char hex, got '${receipt.preparedDigest}'`);
  }
  if (!/^[0-9a-f]{64}$/.test(receipt.candidateDigest)) {
    throw new CutoverFenceError(`Receipt candidateDigest must be 64-char hex, got '${receipt.candidateDigest}'`);
  }
  if (!/^[0-9a-f]{64}$/.test(receipt.logicalDigest)) {
    throw new CutoverFenceError(`Receipt logicalDigest must be 64-char hex, got '${receipt.logicalDigest}'`);
  }
  const validDispositions = ['written', 'retained'];
  if (!validDispositions.includes(receipt.disposition)) {
    throw new CutoverFenceError(
      `Receipt disposition must be one of [${validDispositions.join(', ')}], got '${receipt.disposition}'`,
    );
  }

  const allowedSources = getSourceCollectionAllowlist(expectedNamespace);
  const allowedTargets = getTargetCollectionAllowlist(expectedNamespace);

  if (!Array.isArray(receipt.sourceAfter)) {
    throw new CutoverFenceError('Receipt sourceAfter must be an array of source after-state descriptors');
  }
  for (const s of receipt.sourceAfter) {
    if (!s || typeof s !== 'object') {
      throw new CutoverFenceError('Invalid sourceAfter item in receipt');
    }
    validateMapKeysExact(s, ['collection', 'id', 'recordDigest'], 'receipt sourceAfter item');
    if (typeof s.collection !== 'string' || typeof s.id !== 'string' || !/^[0-9a-f]{64}$/.test(s.id)) {
      throw new CutoverFenceError('Invalid sourceAfter collection or id format');
    }
    if (!allowedSources.includes(s.collection)) {
      throw new CutoverFenceError(`Receipt sourceAfter collection '${s.collection}' not in allowlist`);
    }
    if (s.recordDigest !== null && (typeof s.recordDigest !== 'string' || !/^[0-9a-f]{64}$/.test(s.recordDigest))) {
      throw new CutoverFenceError('sourceAfter recordDigest must be 64-char hex or null');
    }
  }

  if (!Array.isArray(receipt.targetAfter)) {
    throw new CutoverFenceError('Receipt targetAfter must be an array of target after-state descriptors');
  }
  for (const t of receipt.targetAfter) {
    if (!t || typeof t !== 'object') {
      throw new CutoverFenceError('Invalid targetAfter item in receipt');
    }
    validateMapKeysExact(t, ['collection', 'id', 'recordDigest'], 'receipt targetAfter item');
    if (typeof t.collection !== 'string' || typeof t.id !== 'string' || !/^[0-9a-f]{64}$/.test(t.id) || typeof t.recordDigest !== 'string' || !/^[0-9a-f]{64}$/.test(t.recordDigest)) {
      throw new CutoverFenceError('Invalid targetAfter descriptor format in receipt');
    }
    if (!allowedTargets.includes(t.collection)) {
      throw new CutoverFenceError(`Receipt targetAfter collection '${t.collection}' not in allowlist`);
    }
  }

  if (!Number.isInteger(receipt.completedAt) || receipt.completedAt <= 0) {
    throw new CutoverFenceError('Receipt completedAt must be a positive integer timestamp');
  }
}

export function computeReceiptDigest(receipt) {
  validateReceipt(receipt, receipt.namespace, receipt.epoch, receipt.migrationRunId);
  return D('receipt', receipt.namespace, receipt.epoch, receipt);
}

export function computePlanDigest(namespace, epoch, planSpec) {
  if (!planSpec || typeof planSpec !== 'object') {
    throw new CutoverFenceError('planSpec must be a non-null object');
  }
  return D('plan', namespace, epoch, planSpec);
}

export function computeReceiptSetDigest(receipts, namespace, epoch) {
  if (!Array.isArray(receipts)) {
    throw new CutoverFenceError('Receipts must be an array');
  }
  const pairs = [];
  const candidateIds = new Set();
  for (const r of receipts) {
    if (r.namespace !== namespace || r.epoch !== epoch) {
      throw new CutoverFenceError('Receipt namespace or epoch mismatch in receipt set');
    }
    if (candidateIds.has(r.candidateId)) {
      throw new CutoverFenceError(`Duplicate candidate receipt in receipt set: ${r.candidateId}`);
    }
    candidateIds.add(r.candidateId);
    pairs.push([r.candidateId, computeReceiptDigest(r)]);
  }
  pairs.sort((a, b) => canonicalCompare(a[0], b[0]));
  return D('receipt-set', namespace, epoch, pairs);
}

export function parseCutoverFenceRecord(data, namespace) {
  assertSupportedCutoverNamespace(namespace);
  if (!data || typeof data !== 'object') {
    throw new CutoverFenceError(
      `Invalid cutover fence record for namespace ${namespace}: expected object, got ${typeof data}`,
    );
  }
  const record = data;

  const ALLOWED_CONTROL_KEYS = [
    'schemaVersion',
    'namespace',
    'epoch',
    'state',
    'activeOperations',
    'irreversible',
    'migrationRunId',
    'migrationManifestDigest',
    'emptyNamespace',
    'createdAt',
    'updatedAt',
    'codeArtifact',
    'codeSha',
    'lastTransitionReason',
  ];
  for (const key of Object.keys(record)) {
    if (!ALLOWED_CONTROL_KEYS.includes(key)) {
      throw new CutoverFenceError(
        `Unknown field '${key}' in cutover fence control record for namespace ${namespace}`,
      );
    }
  }

  if (record.schemaVersion !== 1) {
    throw new CutoverFenceError(
      `Unsupported schemaVersion for namespace ${namespace}: expected 1, got ${record.schemaVersion}`,
    );
  }
  if (record.namespace !== namespace) {
    throw new CutoverFenceError(
      `Namespace mismatch in cutover fence record: expected ${namespace}, got ${record.namespace}`,
    );
  }
  if (
    typeof record.epoch !== 'number' ||
    !Number.isInteger(record.epoch) ||
    record.epoch < 1
  ) {
    throw new CutoverFenceError(
      `Invalid epoch in cutover fence record for namespace ${namespace}: ${record.epoch}`,
    );
  }
  const validStates = ['legacy_open', 'closing', 'fenced', 'migrating', 'v3_ready', 'v3_active'];
  if (typeof record.state !== 'string' || !validStates.includes(record.state)) {
    throw new CutoverFenceError(
      `Invalid cutover fence state for namespace ${namespace}: ${String(record.state)}`,
    );
  }
  if (
    typeof record.activeOperations !== 'number' ||
    !Number.isInteger(record.activeOperations) ||
    record.activeOperations < 0
  ) {
    throw new CutoverFenceError(
      `Invalid activeOperations in cutover fence record for namespace ${namespace}: ${String(record.activeOperations)}`,
    );
  }
  if (typeof record.irreversible !== 'boolean') {
    throw new CutoverFenceError(
      `Invalid irreversible field in cutover fence record for namespace ${namespace}: expected boolean, got ${typeof record.irreversible}`,
    );
  }

  if (['legacy_open', 'closing', 'fenced', 'migrating'].includes(record.state)) {
    if (record.emptyNamespace !== undefined) {
      throw new CutoverFenceError(
        `Invalid cutover fence invariants for namespace ${namespace}: ${record.state} cannot define emptyNamespace`,
      );
    }
  }

  if (record.state === 'legacy_open') {
    if (record.irreversible !== false) {
      throw new CutoverFenceError(
        `Invalid cutover fence invariants for namespace ${namespace}: legacy_open cannot have irreversible: true`,
      );
    }
    if (record.migrationRunId !== undefined || record.migrationManifestDigest !== undefined) {
      throw new CutoverFenceError(
        `Invalid cutover fence invariants for namespace ${namespace}: legacy_open cannot have migration markers`,
      );
    }
  } else if (record.state === 'closing' || record.state === 'fenced') {
    if (record.migrationRunId !== undefined || record.migrationManifestDigest !== undefined) {
      throw new CutoverFenceError(
        `Invalid cutover fence invariants for namespace ${namespace}: ${record.state} cannot have migration markers`,
      );
    }
  } else if (record.state === 'migrating') {
    if (typeof record.migrationRunId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(record.migrationRunId)) {
      throw new CutoverFenceError(
        `Invalid cutover fence invariants for namespace ${namespace}: migrating requires non-empty migrationRunId matching /^[A-Za-z0-9_-]{8,64}$/`,
      );
    }
    if (record.migrationManifestDigest !== undefined) {
      throw new CutoverFenceError(
        `Invalid cutover fence invariants for namespace ${namespace}: migrating cannot have migrationManifestDigest before v3_ready`,
      );
    }
  } else if (record.state === 'v3_ready' || record.state === 'v3_active') {
    if (typeof record.migrationRunId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(record.migrationRunId)) {
      throw new CutoverFenceError(
        `Invalid cutover fence invariants for namespace ${namespace}: ${record.state} requires migrationRunId matching /^[A-Za-z0-9_-]{8,64}$/`,
      );
    }
    if (typeof record.migrationManifestDigest !== 'string' || !/^[0-9a-f]{64}$/.test(record.migrationManifestDigest)) {
      throw new CutoverFenceError(
        `Invalid cutover fence invariants for namespace ${namespace}: ${record.state} requires migrationManifestDigest to be 64-char hex`,
      );
    }
    if (typeof record.emptyNamespace !== 'boolean') {
      throw new CutoverFenceError(
        `Invalid cutover fence invariants for namespace ${namespace}: ${record.state} requires emptyNamespace to be a boolean`,
      );
    }
    if (record.emptyNamespace === true) {
      if (record.irreversible !== false) {
        throw new CutoverFenceError(
          `Invalid cutover fence invariants for namespace ${namespace}: emptyNamespace requires irreversible: false`,
        );
      }
    } else {
      if (record.irreversible !== true) {
        throw new CutoverFenceError(
          `Invalid cutover fence invariants for namespace ${namespace}: non-empty ${record.state} requires irreversible: true`,
        );
      }
    }
  }

  if (record.codeSha !== undefined) {
    if (typeof record.codeSha !== 'string' || !/^[0-9a-f]{40}$/.test(record.codeSha)) {
      throw new CutoverFenceError(`Invalid codeSha in cutover fence record for namespace ${namespace}`);
    }
  }
  if (record.codeArtifact !== undefined) {
    if (typeof record.codeArtifact !== 'string' || !record.codeArtifact.trim()) {
      throw new CutoverFenceError(`Invalid codeArtifact in cutover fence record for namespace ${namespace}`);
    }
  }

  return {
    schemaVersion: 1,
    namespace,
    epoch: record.epoch,
    state: record.state,
    activeOperations: record.activeOperations,
    irreversible: record.irreversible,
    migrationRunId: typeof record.migrationRunId === 'string' ? record.migrationRunId : undefined,
    migrationManifestDigest:
      typeof record.migrationManifestDigest === 'string' ? record.migrationManifestDigest : undefined,
    emptyNamespace: typeof record.emptyNamespace === 'boolean' ? record.emptyNamespace : undefined,
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : undefined,
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : undefined,
    codeArtifact: typeof record.codeArtifact === 'string' ? record.codeArtifact : undefined,
    codeSha: typeof record.codeSha === 'string' ? record.codeSha : undefined,
    lastTransitionReason: typeof record.lastTransitionReason === 'string' ? record.lastTransitionReason : undefined,
  };
}

export async function readCutoverFenceInTransaction(transaction, db, namespace) {
  assertSupportedCutoverNamespace(namespace);
  const docRef = getCutoverFenceDocRef(db, namespace);
  const snap = await transaction.get(docRef);
  if (!snap.exists) {
    throw new CutoverFenceError(
      `Cutover fence record not initialized for namespace ${namespace} at ${namespace}_meta/cutover_fence`,
    );
  }
  return parseCutoverFenceRecord(snap.data(), namespace);
}

export async function getCutoverFenceRecord(db, namespace) {
  assertSupportedCutoverNamespace(namespace);
  const docRef = getCutoverFenceDocRef(db, namespace);
  const snap = await docRef.get();
  if (!snap.exists) {
    return undefined;
  }
  return parseCutoverFenceRecord(snap.data(), namespace);
}

export async function initializeCutoverFence(db, namespace, options = {}) {
  assertSupportedCutoverNamespace(namespace);
  const docRef = getCutoverFenceDocRef(db, namespace);
  const now = (options.now ?? Date.now)();

  const requestedInitialEpoch = options.initialEpoch ?? 1;
  if (
    typeof requestedInitialEpoch !== 'number' ||
    !Number.isInteger(requestedInitialEpoch) ||
    requestedInitialEpoch !== 1
  ) {
    throw new CutoverFenceError(
      `Initial epoch for namespace ${namespace} must be exactly 1, got ${requestedInitialEpoch}`,
    );
  }

  const requestedInitialState = options.initialState ?? 'legacy_open';
  if (requestedInitialState !== 'legacy_open') {
    throw new CutoverFenceError(
      `Initial state for namespace ${namespace} must be 'legacy_open', got '${requestedInitialState}'`,
    );
  }

  return await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(docRef);
    if (snap.exists) {
      const existing = parseCutoverFenceRecord(snap.data(), namespace);
      if (existing.epoch !== 1 || existing.state !== 'legacy_open') {
        throw new CutoverFenceError(
          `Cutover fence record for namespace ${namespace} already exists with epoch ${existing.epoch}, state ${existing.state}`,
        );
      }
      return existing;
    }

    const initial = {
      schemaVersion: 1,
      namespace,
      epoch: 1,
      state: 'legacy_open',
      activeOperations: 0,
      irreversible: false,
      createdAt: now,
      updatedAt: now,
    };
    transaction.set(docRef, initial);
    return initial;
  });
}

export async function transitionCutoverFenceState(db, namespace, params) {
  assertSupportedCutoverNamespace(namespace);
  const docRef = getCutoverFenceDocRef(db, namespace);
  const now = (params.now ?? Date.now)();

  if (['migrating', 'v3_ready', 'v3_active'].includes(params.toState)) {
    throw new CutoverFenceError(
      `Transition to '${params.toState}' must use atomic transaction helper (prepareMigrationInTransaction, finalizeMigrationInTransaction, or activateMigrationInTransaction)`,
    );
  }

  return await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(docRef);
    if (!snap.exists) {
      throw new CutoverFenceError(
        `Cannot transition: cutover fence record missing for namespace ${namespace}`,
      );
    }
    const current = parseCutoverFenceRecord(snap.data(), namespace);

    if (current.state === params.toState) {
      if (params.allowIdempotent) {
        return current;
      }
      throw new CutoverFenceError(
        `Idempotent transition rejected for namespace ${namespace}: already in state '${current.state}'`,
      );
    }

    if (params.fromState !== undefined) {
      const allowedFrom = Array.isArray(params.fromState) ? params.fromState : [params.fromState];
      if (!allowedFrom.includes(current.state)) {
        throw new CutoverFenceError(
          `Invalid fromState precondition for namespace ${namespace}: expected ${allowedFrom.join('|')}, got '${current.state}'`,
        );
      }
    }

    if (current.epoch !== params.expectedEpoch) {
      throw new CutoverFenceError(
        `Epoch mismatch on transition for namespace ${namespace}: expected ${params.expectedEpoch}, got ${current.epoch}`,
      );
    }

    const allowedNext = ALLOWED_STATE_TRANSITIONS[current.state] ?? [];
    if (!allowedNext.includes(params.toState)) {
      throw new CutoverFenceError(
        `Illegal cutover state transition for namespace ${namespace}: ${current.state} -> ${params.toState}`,
      );
    }

    if (params.toState === 'fenced') {
      const nonterminalOps = await transaction.get(
        getCutoverOperationsColRef(db, namespace).where('phase', 'in', ['admitted', 'upstream_pending']),
      );
      if (nonterminalOps.size !== current.activeOperations) {
        throw new CutoverFenceError(
          `Cannot transition to fenced: activeOperations counter (${current.activeOperations}) does not match nonterminal operations count (${nonterminalOps.size})`,
        );
      }
      if (nonterminalOps.size !== 0) {
        throw new CutoverFenceError(
          `Cannot transition to fenced for namespace ${namespace}: ${nonterminalOps.size} active or pending operations exist`,
        );
      }
      const ambiguousOps = await transaction.get(
        getCutoverOperationsColRef(db, namespace).where('ambiguousRemoteOutcome', '==', true),
      );
      if (!ambiguousOps.empty) {
        throw new CutoverFenceError(
          `Cannot transition to fenced for namespace ${namespace}: unresolved ambiguous remote operations exist`,
        );
      }
    } else if (params.toState === 'legacy_open') {
      if (current.irreversible) {
        throw new CutoverFenceError(
          `Cannot return to legacy_open for namespace ${namespace}: irreversible migration latch is engaged`,
        );
      }
      if (current.migrationRunId || current.emptyNamespace) {
        throw new CutoverFenceError(
          `Cannot return to legacy_open for namespace ${namespace}: migration ownership record exists`,
        );
      }
      const markerRef = db.collection(`${namespace}_meta`).doc('v2_adopted');
      const markerSnap = await transaction.get(markerRef);
      if (markerSnap.exists) {
        throw new CutoverFenceError(
          `Cannot return to legacy_open for namespace ${namespace}: durable v2_adopted ownership marker exists`,
        );
      }
      if (current.activeOperations !== 0) {
        throw new CutoverFenceError(
          `Cannot return to legacy_open for namespace ${namespace}: activeOperations is ${current.activeOperations}`,
        );
      }
    }

    if (params.nextEpoch !== undefined) {
      const allowedNext = params.toState === 'fenced' && current.state === 'closing'
        ? current.epoch + 1
        : current.epoch;
      if (params.nextEpoch !== allowedNext) {
        throw new CutoverFenceError(`Arbitrary nextEpoch is not permitted for transition to ${params.toState}`);
      }
    }

    const nextEpoch = params.toState === 'fenced' && current.state === 'closing'
      ? current.epoch + 1
      : current.epoch;

    const updated = {
      schemaVersion: 1,
      namespace,
      state: params.toState,
      epoch: nextEpoch,
      activeOperations: current.activeOperations,
      irreversible: current.irreversible,
      emptyNamespace: current.emptyNamespace,
      migrationRunId: params.migrationRunId ?? current.migrationRunId,
      migrationManifestDigest: params.migrationManifestDigest ?? current.migrationManifestDigest,
      createdAt: current.createdAt ?? now,
      updatedAt: now,
      codeArtifact: current.codeArtifact,
      codeSha: current.codeSha,
      lastTransitionReason: `Transitioned from ${current.state} to ${params.toState}`,
    };

    transaction.set(docRef, stripUndefined(updated));
    return updated;
  });
}

export async function markIrreversibleInTransaction(
  transaction,
  db,
  namespace,
  expectedEpoch,
  migrationRunId,
  nowProvider = Date.now,
) {
  assertSupportedCutoverNamespace(namespace);
  const current = await readCutoverFenceInTransaction(transaction, db, namespace);
  if (current.state !== 'migrating') {
    throw new CutoverFenceError(
      `Cannot set irreversible latch for namespace ${namespace}: state must be 'migrating', got '${current.state}'`,
    );
  }
  if (current.epoch !== expectedEpoch) {
    throw new CutoverFenceError(
      `Epoch mismatch when setting irreversible latch for namespace ${namespace}: expected ${expectedEpoch}, got ${current.epoch}`,
    );
  }
  if (migrationRunId && current.migrationRunId !== migrationRunId) {
    throw new CutoverFenceError(
      `migrationRunId mismatch when setting irreversible latch: expected ${migrationRunId}, got ${current.migrationRunId}`,
    );
  }
  if (current.emptyNamespace === true) {
    throw new CutoverFenceError(
      `Cannot set irreversible latch for namespace ${namespace}: emptyNamespace must remain irreversible: false`,
    );
  }
  if (current.irreversible) {
    return current;
  }
  const currentTime = nowProvider();
  const updated = {
    ...current,
    irreversible: true,
    updatedAt: currentTime,
  };
  const ref = getCutoverFenceDocRef(db, namespace);
  transaction.set(ref, stripUndefined(updated), { merge: true });
  return updated;
}

export async function withLegacyOperation(options, fn) {
  assertSupportedCutoverNamespace(options.namespace);
  const now = options.now ?? Date.now;
  const opId = options.operationId ?? randomUUID();
  const opRef = getCutoverOperationDocRef(options.db, options.namespace, opId);
  const controlRef = getCutoverFenceDocRef(options.db, options.namespace);

  const opRecord = await options.db.runTransaction(async (transaction) => {
    const existingSnap = await transaction.get(opRef);
    if (existingSnap.exists) {
      throw new CutoverFenceError(
        `Operation with id '${sanitizeId(opId)}' already exists in namespace ${options.namespace}`,
      );
    }

    const control = await readCutoverFenceInTransaction(transaction, options.db, options.namespace);
    if (['fenced', 'migrating', 'v3_ready', 'v3_active'].includes(control.state)) {
      throw new CutoverRefusedError(
        `Cutover state is ${control.state}; new operations refused for namespace ${options.namespace}`,
        { cutoverState: control.state, epoch: control.epoch },
      );
    }
    if (control.state === 'closing') {
      throw new CutoverRefusedError(
        `Cutover state is closing; new admissions refused for namespace ${options.namespace}`,
        { cutoverState: control.state, epoch: control.epoch },
      );
    }

    const forbiddenKindTerms = ['token', 'password', 'upstream', 'secret', 'auth_code'];
    if (forbiddenKindTerms.some((t) => options.kind.toLowerCase().includes(t))) {
      throw new CutoverFenceError(`Operation kind must not contain sensitive credential terms: '${options.kind}'`);
    }

    if (options.metadata) {
      const allowedKeys = ['revision', 'attempt', 'phase', 'reconciled'];
      for (const [key, value] of Object.entries(options.metadata)) {
        if (!allowedKeys.includes(key)) {
          throw new CutoverFenceError(
            `Operation metadata key '${key}' is not in the allowlist (${allowedKeys.join(', ')})`,
          );
        }
        if (key === 'revision') {
          if (typeof value !== 'string' || !/^[a-zA-Z0-9._-]{1,32}$/.test(value)) {
            throw new CutoverFenceError(
              `Operation metadata 'revision' must be a safe identifier matching /^[a-zA-Z0-9._-]{1,32}$/, got '${String(value)}'`,
            );
          }
        } else if (key === 'phase') {
          if (typeof value !== 'string' || !/^[a-zA-Z0-9._-]{1,32}$/.test(value)) {
            throw new CutoverFenceError(
              `Operation metadata 'phase' must be a safe identifier matching /^[a-zA-Z0-9._-]{1,32}$/, got '${String(value)}'`,
            );
          }
        } else if (key === 'attempt') {
          if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100) {
            throw new CutoverFenceError(
              `Operation metadata 'attempt' must be an integer between 1 and 100, got '${String(value)}'`,
            );
          }
        } else if (key === 'reconciled') {
          if (typeof value !== 'boolean') {
            throw new CutoverFenceError(
              `Operation metadata 'reconciled' must be a boolean, got '${String(value)}'`,
            );
          }
        }
      }
    }
    const currentTime = now();
    const createdRecord = {
      schemaVersion: 1,
      id: opId,
      operationId: opId,
      namespace: options.namespace,
      epoch: control.epoch,
      kind: options.kind,
      phase: 'admitted',
      leaseOwner: randomUUID(),
      leaseExpiresAt: currentTime + (options.leaseMs ?? 30_000),
      createdAt: currentTime,
      updatedAt: currentTime,
      metadata: options.metadata,
    };

    transaction.set(opRef, stripUndefined(createdRecord));
    transaction.set(
      controlRef,
      {
        activeOperations: control.activeOperations + 1,
        updatedAt: currentTime,
      },
      { merge: true },
    );

    return createdRecord;
  });

  let completedLocally = false;
  let ambiguousOutcome = false;
  let ambiguousReason;

  const ctx = {
    id: opId,
    namespace: options.namespace,
    epoch: opRecord.epoch,
    kind: options.kind,
    isAmbiguousRemoteOutcome: () => ambiguousOutcome,
    getAmbiguousReason: () => ambiguousReason,
    markAmbiguousRemoteOutcome: (reason) => {
      ambiguousOutcome = true;
      ambiguousReason = reason;
    },
    clearAmbiguousRemoteOutcome: () => {
      ambiguousOutcome = false;
      ambiguousReason = undefined;
    },
    isCompleted: () => completedLocally,
    markCompleted: () => {
      completedLocally = true;
    },
  };

  try {
    const result = await fn(ctx);
    if (!ctx.isCompleted() && !ctx.isAmbiguousRemoteOutcome()) {
      await releaseLegacyOperation(options.db, ctx, 'completed', now);
    }
    return result;
  } catch (err) {
    if (ctx.isAmbiguousRemoteOutcome()) {
      try {
        await options.db.runTransaction(async (transaction) => {
          const currentTime = now();
          transaction.set(
            opRef,
            stripUndefined({
              phase: 'upstream_pending',
              ambiguousRemoteOutcome: true,
              ambiguousReason: ctx.getAmbiguousReason(),
              updatedAt: currentTime,
            }),
            { merge: true },
          );
        });
      } catch (markErr) {
        if (err && typeof err === 'object') {
          err.markAmbiguousError = markErr;
        }
      }
    } else if (!ctx.isCompleted()) {
      try {
        await releaseLegacyOperation(options.db, ctx, 'failed', now);
      } catch (releaseErr) {
        if (err && typeof err === 'object') {
          err.releaseError = releaseErr;
        }
      }
    }
    throw err;
  }
}

export async function releaseLegacyOperation(db, ctx, outcome = 'completed', nowProvider = Date.now) {
  assertSupportedCutoverNamespace(ctx.namespace);
  if (outcome !== 'completed' && outcome !== 'failed') {
    throw new CutoverFenceError(`Invalid outcome for release: ${outcome}`);
  }
  const controlRef = getCutoverFenceDocRef(db, ctx.namespace);
  const opRef = getCutoverOperationDocRef(db, ctx.namespace, ctx.id);
  const currentTime = nowProvider();

  await db.runTransaction(async (transaction) => {
    const controlSnap = await transaction.get(controlRef);
    const opSnap = await transaction.get(opRef);

    if (!controlSnap.exists) {
      throw new CutoverFenceError(`Control record missing for namespace ${ctx.namespace}`);
    }
    if (!opSnap.exists) {
      throw new CutoverFenceError(`Operation record missing for operation ${sanitizeId(ctx.id)}`);
    }

    const control = parseCutoverFenceRecord(controlSnap.data(), ctx.namespace);
    const opData = opSnap.data();

    if (opData.schemaVersion !== 1) {
      throw new CutoverFenceError(`Invalid operation schemaVersion: expected 1, got ${opData.schemaVersion}`);
    }
    if (opData.id !== ctx.id || opData.operationId !== ctx.id) {
      throw new CutoverFenceError('Operation id mismatch on release');
    }
    if (opData.namespace !== ctx.namespace) {
      throw new CutoverFenceError(`Operation namespace mismatch: expected ${ctx.namespace}, got ${opData.namespace}`);
    }
    if (opData.kind !== ctx.kind) {
      throw new CutoverFenceError(`Operation kind mismatch on release: expected ${ctx.kind}, got ${opData.kind}`);
    }
    if (opData.epoch !== ctx.epoch) {
      throw new CutoverFenceError(
        `Epoch mismatch on release: context epoch ${ctx.epoch} != recorded epoch ${opData.epoch}`,
      );
    }

    if (opData.phase === 'completed' || opData.phase === 'failed') {
      return;
    }

    if (opData.phase === 'upstream_pending' || opData.ambiguousRemoteOutcome === true) {
      throw new CutoverFenceError(
        `Cannot release operation ${sanitizeId(ctx.id)} in phase ${opData.phase}; pending or ambiguous claims must be resolved`,
      );
    }

    if (control.activeOperations <= 0) {
      throw new CutoverFenceError(
        `Active operations underflow in namespace ${ctx.namespace}: recorded count is ${control.activeOperations}`,
      );
    }

    transaction.set(
      controlRef,
      {
        activeOperations: control.activeOperations - 1,
        updatedAt: currentTime,
      },
      { merge: true },
    );

    transaction.set(
      opRef,
      stripUndefined({ phase: outcome, ambiguousRemoteOutcome: false, updatedAt: currentTime }),
      { merge: true },
    );
  });

  ctx.markCompleted();
}

export async function markOperationAmbiguous(db, ctx, nowProvider = Date.now) {
  assertSupportedCutoverNamespace(ctx.namespace);
  const opRef = getCutoverOperationDocRef(db, ctx.namespace, ctx.id);
  const currentTime = nowProvider();

  await db.runTransaction(async (transaction) => {
    const opSnap = await transaction.get(opRef);
    if (!opSnap.exists) {
      throw new CutoverFenceError(`Operation record missing for operation ${sanitizeId(ctx.id)}`);
    }
    const opData = opSnap.data();
    if (opData.schemaVersion !== 1) {
      throw new CutoverFenceError(`Invalid operation schemaVersion: expected 1, got ${opData.schemaVersion}`);
    }
    if (opData.id !== ctx.id || opData.operationId !== ctx.id) {
      throw new CutoverFenceError('Operation id mismatch on mark ambiguous');
    }
    if (opData.namespace !== ctx.namespace) {
      throw new CutoverFenceError(`Operation namespace mismatch on mark ambiguous`);
    }
    if (opData.kind !== ctx.kind) {
      throw new CutoverFenceError(`Operation kind mismatch on mark ambiguous: expected ${ctx.kind}, got ${opData.kind}`);
    }
    if (opData.epoch !== ctx.epoch) {
      throw new CutoverFenceError(
        `Epoch mismatch on mark ambiguous: context epoch ${ctx.epoch} != recorded epoch ${opData.epoch}`,
      );
    }
    transaction.set(
      opRef,
      stripUndefined({
        phase: 'upstream_pending',
        ambiguousRemoteOutcome: true,
        updatedAt: currentTime,
      }),
      { merge: true },
    );
  });
}

export async function checkMutationGuardInTransaction(transaction, options) {
  assertSupportedCutoverNamespace(options.namespace);
  const control = await readCutoverFenceInTransaction(transaction, options.db, options.namespace);

  if (['fenced', 'migrating', 'v3_ready', 'v3_active'].includes(control.state)) {
    throw new CutoverRefusedError(
      `Cutover state is ${control.state}; mutations refused for namespace ${options.namespace}`,
      { cutoverState: control.state, epoch: control.epoch },
    );
  }

  if (!options.operation) {
    throw new CutoverFenceError(
      `Durable operation context is required for guarded mutation in namespace ${options.namespace}`,
    );
  }

  const opRef = getCutoverOperationDocRef(options.db, options.namespace, options.operation.id);
  const opSnap = await transaction.get(opRef);
  if (!opSnap.exists) {
    throw new CutoverFenceError(
      `Durable operation record missing for ${sanitizeId(options.operation.id)} in namespace ${options.namespace}`,
    );
  }
  const opRecord = opSnap.data();

  if (opRecord.schemaVersion !== 1) {
    throw new CutoverFenceError(`Invalid operation schemaVersion: expected 1, got ${opRecord.schemaVersion}`);
  }
  if (opRecord.id !== options.operation.id || opRecord.operationId !== options.operation.id) {
    throw new CutoverFenceError('Durable operation id mismatch');
  }
  if (opRecord.namespace !== options.namespace) {
    throw new CutoverFenceError(`Durable operation namespace mismatch: expected ${options.namespace}, got ${opRecord.namespace}`);
  }
  if (opRecord.kind !== options.operation.kind) {
    throw new CutoverFenceError(`Durable operation kind mismatch: expected ${options.operation.kind}, got ${opRecord.kind}`);
  }
  if (opRecord.epoch !== control.epoch) {
    throw new CutoverFenceError(
      `Operation epoch mismatch: operation epoch ${opRecord.epoch} != control epoch ${control.epoch}`,
    );
  }
  if (opRecord.phase !== 'admitted' && opRecord.phase !== 'upstream_pending') {
    throw new CutoverFenceError(
      `Operation ${sanitizeId(options.operation.id)} is already in phase ${opRecord.phase}; cannot be reused`,
    );
  }
  if (options.operation.isCompleted()) {
    throw new CutoverFenceError(
      `Operation ${sanitizeId(options.operation.id)} was marked completed locally; cannot be reused`,
    );
  }

  const completeOperation = options.completeOperation ?? true;
  let bufferedCompletionTime;

  return {
    control,
    operation: opRecord,
    bufferCompletion: (now = (options.now ?? Date.now)()) => {
      if (!options.operation || !completeOperation) {
        return;
      }
      bufferedCompletionTime = now;
      transaction.set(
        opRef,
        stripUndefined({
          phase: 'completed',
          ambiguousRemoteOutcome: false,
          updatedAt: bufferedCompletionTime,
        }),
        { merge: true },
      );

      const controlRef = getCutoverFenceDocRef(options.db, options.namespace);
      if (control.activeOperations <= 0) {
        throw new CutoverFenceError(
          `Active operations underflow in namespace ${options.namespace}: recorded count is ${control.activeOperations}`,
        );
      }
      transaction.set(
        controlRef,
        {
          activeOperations: control.activeOperations - 1,
          updatedAt: bufferedCompletionTime,
        },
        { merge: true },
      );
    },
    onCommit: () => {
      if (bufferedCompletionTime !== undefined && options.operation) {
        options.operation.markCompleted();
      }
    },
  };
}

export async function isLegacyMutationPermittedInTransaction(transaction, db, namespace, operation) {
  assertSupportedCutoverNamespace(namespace);
  const control = await readCutoverFenceInTransaction(transaction, db, namespace);
  if (['fenced', 'migrating', 'v3_ready', 'v3_active'].includes(control.state)) {
    return { permitted: false, control };
  }
  if (!operation) {
    return { permitted: false, control };
  }
  const opRef = getCutoverOperationDocRef(db, namespace, operation.id);
  const opSnap = await transaction.get(opRef);
  if (!opSnap.exists) {
    return { permitted: false, control };
  }
  const opRecord = opSnap.data();
  if (opRecord.schemaVersion !== 1 || opRecord.id !== operation.id || opRecord.operationId !== operation.id) {
    return { permitted: false, control };
  }
  if (opRecord.namespace !== namespace || opRecord.epoch !== control.epoch) {
    return { permitted: false, control };
  }
  if (opRecord.kind !== operation.kind) {
    return { permitted: false, control };
  }
  if (opRecord.phase !== 'admitted' && opRecord.phase !== 'upstream_pending') {
    return { permitted: false, control };
  }
  return { permitted: true, control };
}

export async function claimUpstreamGrantInTransaction(transaction, db, options) {
  const {
    namespace,
    epoch,
    familyId,
    operationId,
    claimOwner,
    expectedFamilyGeneration,
    expectedGrantVersion,
    expectedKind,
    leaseMs = 30_000,
    nowProvider = Date.now,
  } = options;
  assertSupportedCutoverNamespace(namespace);

  const expectedCollection = `${namespace}_tokens_upstream`;
  const expectedFamilyCollection = `${namespace}_tokens_refresh_families`;
  const expectedRefreshCollection = `${namespace}_tokens_refresh`;

  if (options.collection !== undefined && options.collection !== expectedCollection) {
    throw new CutoverFenceError(`Invalid legacy collection override '${options.collection}': exact '${expectedCollection}' required`);
  }
  if (options.familyCollection !== undefined && options.familyCollection !== expectedFamilyCollection) {
    throw new CutoverFenceError(`Invalid legacy familyCollection override '${options.familyCollection}': exact '${expectedFamilyCollection}' required`);
  }
  if (options.refreshCollection !== undefined && options.refreshCollection !== expectedRefreshCollection) {
    throw new CutoverFenceError(`Invalid legacy refreshCollection override '${options.refreshCollection}': exact '${expectedRefreshCollection}' required`);
  }

  const collection = expectedCollection;
  const familyCollection = expectedFamilyCollection;
  const refreshCollection = expectedRefreshCollection;
  if (typeof epoch !== 'number' || !Number.isInteger(epoch) || epoch < 1) {
    throw new CutoverFenceError('epoch (positive integer) is required for claimUpstreamGrantInTransaction');
  }
  if (typeof familyId !== 'string' || !familyId.trim()) {
    throw new CutoverFenceError('familyId is required for claimUpstreamGrantInTransaction');
  }
  if (typeof operationId !== 'string' || !operationId.trim()) {
    throw new CutoverFenceError('operationId is required for claimUpstreamGrantInTransaction');
  }
  if (typeof claimOwner !== 'string' || !claimOwner.trim()) {
    throw new CutoverFenceError('claimOwner is required for claimUpstreamGrantInTransaction');
  }
  if (typeof expectedFamilyGeneration !== 'number' || !Number.isInteger(expectedFamilyGeneration) || expectedFamilyGeneration < 1) {
    throw new CutoverFenceError('expectedFamilyGeneration (positive integer) is required for claimUpstreamGrantInTransaction');
  }
  if (typeof expectedGrantVersion !== 'number' || !Number.isInteger(expectedGrantVersion) || expectedGrantVersion < 1) {
    throw new CutoverFenceError('expectedGrantVersion (positive integer) is required for claimUpstreamGrantInTransaction');
  }
  if (typeof expectedKind !== 'string' || !expectedKind.trim()) {
    throw new CutoverFenceError('expectedKind is required for claimUpstreamGrantInTransaction');
  }

  const now = nowProvider();
  const clampedLeaseMs = Math.max(5_000, Math.min(120_000, leaseMs));

  const control = await readCutoverFenceInTransaction(transaction, db, namespace);
  if (['fenced', 'migrating', 'v3_ready', 'v3_active'].includes(control.state)) {
    throw new CutoverRefusedError(
      `Cutover state is ${control.state}; upstream claim refused for namespace ${namespace}`,
      { cutoverState: control.state, epoch: control.epoch },
    );
  }
  if (epoch !== control.epoch) {
    throw new CutoverFenceError(
      `Operation epoch mismatch for upstream claim in namespace ${namespace}: expected ${control.epoch}, got ${epoch}`,
    );
  }

  const opRef = getCutoverOperationDocRef(db, namespace, operationId);
  const opSnap = await transaction.get(opRef);
  if (!opSnap.exists) {
    throw new CutoverFenceError(`Durable operation record missing for upstream claim: ${sanitizeId(operationId)}`);
  }
  const opData = opSnap.data();
  if (opData.schemaVersion !== 1 || opData.id !== operationId || opData.operationId !== operationId) {
    throw new CutoverFenceError('Operation id mismatch on record');
  }
  if (opData.namespace !== namespace) {
    throw new CutoverFenceError(`Operation namespace mismatch: expected ${namespace}, got ${opData.namespace}`);
  }
  if (opData.kind !== expectedKind) {
    throw new CutoverFenceError(`Operation kind mismatch: expected ${expectedKind}, got ${opData.kind}`);
  }
  if (opData.epoch !== control.epoch) {
    throw new CutoverFenceError(`Operation record epoch mismatch: expected ${control.epoch}, got ${opData.epoch}`);
  }
  if (opData.phase !== 'admitted') {
    throw new CutoverFenceError(`Operation ${sanitizeId(operationId)} is in phase ${opData.phase}; claim refused`);
  }

  const familyRef = db.collection(familyCollection).doc(familyId);
  const familySnap = await transaction.get(familyRef);
  if (!familySnap.exists) {
    throw new CutoverFenceError(`Family record missing for claim: ${sanitizeId(familyId)}`);
  }
  const family = familySnap.data();
  const actualFamilyGen = typeof family.generation === 'number' ? family.generation : 1;
  if (typeof actualFamilyGen !== 'number' || actualFamilyGen !== expectedFamilyGeneration) {
    throw new CutoverFenceError(
      `Family generation mismatch: expected ${expectedFamilyGeneration}, got ${actualFamilyGen}`,
    );
  }

  const activePointerId = family.currentRefreshToken;
  if (typeof activePointerId !== 'string' || !activePointerId.trim()) {
    throw new CutoverFenceError(`Family missing active refresh pointer: ${sanitizeId(familyId)}`);
  }
  const pointerRef = db.collection(refreshCollection).doc(activePointerId);
  const pointerSnap = await transaction.get(pointerRef);
  if (!pointerSnap.exists) {
    throw new CutoverFenceError(`Active refresh pointer missing: ${sanitizeId(activePointerId)}`);
  }
  const pointer = pointerSnap.data();
  if (typeof pointer.familyId !== 'string' || pointer.familyId !== familyId) {
    throw new CutoverFenceError('Pointer family binding mismatch');
  }
  if (typeof pointer.status !== 'string' || pointer.status !== 'active') {
    throw new CutoverFenceError(`Current refresh pointer is not active: ${pointer.status}`);
  }

  const grantRef = db.collection(collection).doc(familyId);
  const grantSnap = await transaction.get(grantRef);
  if (!grantSnap.exists) {
    throw new CutoverFenceError(`Upstream grant missing for family: ${sanitizeId(familyId)}`);
  }
  const current = grantSnap.data();
  const actualGrantVersion = current.grantVersion ?? current.version ?? 1;
  if (actualGrantVersion !== expectedGrantVersion) {
    throw new CutoverFenceError(`Grant version mismatch: expected ${expectedGrantVersion}, got ${actualGrantVersion}`);
  }

  // Pre-send crash & pending claim lock check: lease expiry CANNOT release nonterminal claims!
  const holdingOpId = current.ambiguousOperationId ?? current.operationId;
  if (holdingOpId && holdingOpId !== operationId) {
    const priorOpRef = getCutoverOperationDocRef(db, namespace, holdingOpId);
    const priorOpSnap = await transaction.get(priorOpRef);
    if (!priorOpSnap.exists) {
      throw new CutoverFenceError(
        `Upstream grant is held by unknown operation ${sanitizeId(holdingOpId)}; fail closed`,
      );
    }
    const priorOp = priorOpSnap.data();
    if (priorOp.phase === 'upstream_pending' || priorOp.phase === 'admitted' || priorOp.ambiguousRemoteOutcome) {
      throw new CutoverFenceError(
        `Upstream grant is held by nonterminal operation ${sanitizeId(holdingOpId)} in phase ${priorOp.phase}; lease expiry cannot release nonterminal claims`,
      );
    }
  }

  if (current.ambiguousRemoteOutcome || current.ambiguousOutcome) {
    throw new CutoverFenceError(`Upstream grant for family ${sanitizeId(familyId)} has unresolved ambiguous outcome`);
  }

  const isLeaseActive = (typeof current.leaseExpiresAt === 'number' && current.leaseExpiresAt > now) ||
                        (typeof current.leaseUntil === 'number' && current.leaseUntil > now);
  if (current.leaseOwner && isLeaseActive) {
    if (current.leaseOwner !== claimOwner || current.ambiguousOperationId !== operationId) {
      throw new CutoverFenceError(`Upstream grant lease held by another claimant: ${current.leaseOwner}`);
    }
  }

  transaction.set(
    opRef,
    stripUndefined({ phase: 'upstream_pending', familyId, updatedAt: now }),
    { merge: true },
  );
  transaction.set(
    grantRef,
    stripUndefined({
      leaseExpiresAt: now + clampedLeaseMs,
      leaseUntil: now + clampedLeaseMs,
      leaseOwner: claimOwner,
      ambiguousOperationId: operationId,
      operationId,
      familyGeneration: expectedFamilyGeneration,
      grantVersion: expectedGrantVersion,
      claimedAt: now,
      updatedAt: now,
    }),
    { merge: true },
  );

  return {
    status: 'claimed',
    familyId,
    operationId,
    claimOwner,
    familyGeneration: expectedFamilyGeneration,
    grantVersion: expectedGrantVersion,
    leaseExpiresAt: now + clampedLeaseMs,
    grant: current.grant ? { hasGrant: true, expiresAt: current.expiresAt } : null,
  };
}

export async function reconcileUpstreamGrantInTransaction(transaction, db, options) {
  const {
    namespace,
    familyId,
    operationId,
    claimOwner,
    expectedFamilyGeneration,
    expectedGrantVersion,
    outcome,
    evidence,
    nowProvider = Date.now,
  } = options;
  assertSupportedCutoverNamespace(namespace);

  const expectedCollection = `${namespace}_tokens_upstream`;
  if (options.collection !== undefined && options.collection !== expectedCollection) {
    throw new CutoverFenceError(`Invalid legacy collection override '${options.collection}': exact '${expectedCollection}' required`);
  }
  const collection = expectedCollection;
  if (typeof familyId !== 'string' || !familyId.trim()) {
    throw new CutoverFenceError('familyId is required for upstream reconciliation');
  }
  if (typeof operationId !== 'string' || !operationId.trim()) {
    throw new CutoverFenceError('operationId is required for upstream reconciliation');
  }
  if (typeof claimOwner !== 'string' || !claimOwner.trim()) {
    throw new CutoverFenceError('claimOwner is required for upstream reconciliation');
  }
  if (typeof expectedFamilyGeneration !== 'number' || !Number.isInteger(expectedFamilyGeneration) || expectedFamilyGeneration < 1) {
    throw new CutoverFenceError('expectedFamilyGeneration (positive integer) is required for upstream reconciliation');
  }
  if (typeof expectedGrantVersion !== 'number' || !Number.isInteger(expectedGrantVersion) || expectedGrantVersion < 1) {
    throw new CutoverFenceError('expectedGrantVersion (positive integer) is required for upstream reconciliation');
  }

  const now = nowProvider();
  const control = await readCutoverFenceInTransaction(transaction, db, namespace);
  if (['migrating', 'v3_ready', 'v3_active'].includes(control.state)) {
    throw new CutoverRefusedError(
      `Cannot reconcile legacy upstream grant: cutover state is ${control.state}`,
      { cutoverState: control.state, epoch: control.epoch },
    );
  }

  const opRef = getCutoverOperationDocRef(db, namespace, operationId);
  const opSnap = await transaction.get(opRef);
  if (!opSnap.exists) {
    throw new CutoverFenceError(`Operation record missing: ${sanitizeId(operationId)}`);
  }
  const opData = opSnap.data();
  if (opData.phase !== 'upstream_pending') {
    throw new CutoverFenceError(`Operation ${sanitizeId(operationId)} is in phase ${opData.phase}; expected upstream_pending`);
  }
  if (opData.familyId && opData.familyId !== familyId) {
    throw new CutoverFenceError(`Operation family mismatch: expected ${sanitizeId(familyId)}, got ${sanitizeId(opData.familyId)}`);
  }

  const docRef = db.collection(collection).doc(familyId);
  const snap = await transaction.get(docRef);
  if (!snap.exists) {
    throw new CutoverFenceError(`Upstream grant missing for family: ${sanitizeId(familyId)}`);
  }
  const current = snap.data();
  if (current.leaseOwner && current.leaseOwner !== claimOwner) {
    throw new CutoverFenceError(`Claim owner mismatch: expected ${current.leaseOwner}, got ${claimOwner}`);
  }
  if (current.ambiguousOperationId && current.ambiguousOperationId !== operationId) {
    throw new CutoverFenceError(`Ambiguous operation mismatch: expected ${current.ambiguousOperationId}, got ${operationId}`);
  }

  // Transient timeout is admissible to preserve ambiguity without terminalization
  if (outcome === 'transient_timeout') {
    const ALLOWED_AMBIGUOUS_REASONS = ['upstream_timeout', 'upstream_gateway_timeout', 'upstream_disconnect', 'transport_error'];
    const safeReason = typeof evidence?.reason === 'string' && ALLOWED_AMBIGUOUS_REASONS.includes(evidence.reason)
      ? evidence.reason
      : 'upstream_timeout';

    transaction.set(
      opRef,
      stripUndefined({
        phase: 'upstream_pending',
        ambiguousRemoteOutcome: true,
        ambiguousReason: safeReason,
        updatedAt: now,
      }),
      { merge: true },
    );
    transaction.set(
      docRef,
      stripUndefined({
        ambiguousOutcome: true,
        ambiguousOperationId: operationId,
        ambiguousReason: safeReason,
        ambiguousAt: now,
        leaseUntil: now + 60_000,
        leaseExpiresAt: now + 60_000,
        updatedAt: now,
      }),
      { merge: true },
    );
    return { status: 'ambiguous_pending', operationId, familyId };
  }

  // All other caller-supplied reconciliations unconditionally fail closed per C10 reset
  throw new CutoverFenceError(
    `Upstream grant reconciliation refused: trusted provider recovery mechanism is not established; operation ${sanitizeId(operationId)} remains held in upstream_pending`,
  );
}

export async function prepareMigrationInTransaction(transaction, db, options) {
  const { namespace, prepDoc } = options;
  assertSupportedCutoverNamespace(namespace);

  if (!options.storeKey || (typeof options.storeKey !== 'string' && !Buffer.isBuffer(options.storeKey) && !(options.storeKey instanceof Uint8Array))) {
    throw new CutoverFenceError('storeKey is REQUIRED for prepareMigrationInTransaction');
  }

  const control = await readCutoverFenceInTransaction(transaction, db, namespace);

  // FieldPath adapter is REQUIRED (no __name__ fallback)
  const FieldPath = options.FieldPath;
  if (!FieldPath || typeof FieldPath.documentId !== 'function') {
    throw new CutoverFenceError('FieldPath with documentId() is REQUIRED for prepareMigrationInTransaction');
  }
  const docIdField = FieldPath.documentId();

  // Idempotent retry after entering migrating
  if (control.state === 'migrating') {
    const prepRef = db.collection(`${namespace}_meta`).doc(`migration_prepared_${control.epoch}`);
    const prepSnap = await transaction.get(prepRef);
    if (prepSnap.exists && C(prepSnap.data()) === C(prepDoc) && control.migrationRunId === prepDoc.migrationRunId) {
      return control;
    }
    throw new CutoverFenceError(
      'Already migrating with different manifest or runId; immutable retry violation',
    );
  }

  if (control.state !== 'fenced') {
    throw new CutoverFenceError(`Cannot prepare migration: state must be 'fenced', got '${control.state}'`);
  }
  if (control.activeOperations !== 0) {
    throw new CutoverFenceError(`Cannot prepare migration: activeOperations must be 0, got ${control.activeOperations}`);
  }

  const expectedPrepKeys = prepDoc.totalPhysicalRecords > 0
    ? [...REQUIRED_PREPARED_MANIFEST_KEYS, ...NONEMPTY_PROJECTOR_KEYS]
    : REQUIRED_PREPARED_MANIFEST_KEYS;
  validateMapKeysExact(prepDoc, expectedPrepKeys, 'prepared manifest');
  validateMigrationIdentityFields(prepDoc, namespace, control.epoch, prepDoc.migrationRunId);

  if (prepDoc.kind !== 'prepared') {
    throw new CutoverFenceError(`prepared manifest kind must be 'prepared', got '${prepDoc.kind}'`);
  }
  if (typeof prepDoc.preparedAt !== 'number' || !Number.isInteger(prepDoc.preparedAt) || prepDoc.preparedAt <= 0) {
    throw new CutoverFenceError('preparedAt must be a positive integer timestamp');
  }

  validateMapKeysExact(prepDoc.physicalCounts, PHYSICAL_COUNT_KEYS, 'prepared physicalCounts');
  validateMapKeysExact(prepDoc.expectedTargetCounts, TARGET_COUNT_KEYS, 'prepared expectedTargetCounts');
  validateMapKeysExact(prepDoc.classifications, CLASSIFICATION_KEYS, 'prepared classifications');
  validateMapKeysExact(prepDoc.reasons, REASON_KEYS, 'prepared reasons');

  const prepPhysicalSum = Object.values(prepDoc.physicalCounts).reduce((sum, n) => {
    if (!Number.isSafeInteger(n) || n < 0) throw new CutoverFenceError('Invalid physical count');
    return sum + n;
  }, 0);
  if (prepPhysicalSum !== prepDoc.totalPhysicalRecords) {
    throw new CutoverFenceError(
      `prepared totalPhysicalRecords must equal sum(physicalCounts): expected ${prepPhysicalSum}, got ${prepDoc.totalPhysicalRecords}`,
    );
  }

  const prepClassSum = Object.values(prepDoc.classifications).reduce((sum, n) => {
    if (!Number.isSafeInteger(n) || n < 0) throw new CutoverFenceError('Invalid classification count');
    return sum + n;
  }, 0);
  if (prepClassSum !== prepDoc.scanned || prepDoc.scanned !== prepDoc.candidateCommitments.length) {
    throw new CutoverFenceError(
      'prepared classifications sum must equal scanned and candidateCommitments.length',
    );
  }

  validateCandidateCommitments(prepDoc.candidateCommitments, prepDoc, namespace, control.epoch, prepDoc.migrationRunId);

  // Exact read strategy: query ALL 13 distinct collections once
  const distinctColNames = getCutoverDistinctCollectionNames(namespace).distinct;
  const readStart = Date.now();
  const rawColSnaps = new Map();

  for (const colName of distinctColNames) {
    const q = db.collection(colName).orderBy(docIdField);
    const snap = await transaction.get(q);
    rawColSnaps.set(colName, snap);
  }

  const readDurationMs = Date.now() - readStart;
  if (readDurationMs > FIRESTORE_TRANSACTION_READ_DEADLINE_MS) {
    throw new CutoverFenceError(`Preparation read duration (${readDurationMs} ms) exceeds 16,000 ms lock deadline`);
  }

  // Partition all 13 collections into normalized key buckets
  const sourcePhysicalToKey = {
    [`${namespace}_tokens_refresh_families`]: 'families',
    [`${namespace}_tokens`]: 'tokens',
    [`${namespace}_tokens_refresh`]: 'refresh',
    [`${namespace}_tokens_upstream`]: 'upstream',
    [`${namespace}_auth_codes`]: 'authCodes',
    [`${namespace}_resume_tokens`]: 'resumeTokens',
    [`${namespace}_oauth_clients`]: 'oauthClients',
    [`${namespace}_clients`]: 'clients',
  };

  const targetPhysicalToKey = {
    [`${namespace}_refresh_families`]: 'families',
    [`${namespace}_sessions`]: 'tokens',
    [`${namespace}_refresh`]: 'refresh',
    [`${namespace}_upstream`]: 'upstream',
    [`${namespace}_auth_codes`]: 'authCodes',
    [`${namespace}_resume_tokens`]: 'resumeTokens',
    [`${namespace}_retired_refresh`]: 'retiredRefreshTokens',
    [`${namespace}_oauth_clients`]: 'oauthClients',
  };

  const sourceDocsByKey = new Map();
  for (const k of PHYSICAL_COUNT_KEYS) sourceDocsByKey.set(k, []);

  const targetDocsByKey = new Map();
  for (const k of TARGET_COUNT_KEYS) targetDocsByKey.set(k, []);

  for (const [physicalName, snap] of rawColSnaps.entries()) {
    const isSourceCol = physicalName in sourcePhysicalToKey;
    const isTargetCol = physicalName in targetPhysicalToKey;

    if (isSourceCol && !isTargetCol) {
      const colKey = sourcePhysicalToKey[physicalName];
      sourceDocsByKey.set(colKey, snap.docs);
    } else if (isTargetCol && !isSourceCol) {
      const colKey = targetPhysicalToKey[physicalName];
      targetDocsByKey.set(colKey, snap.docs);
    } else if (isSourceCol && isTargetCol) {
      const sKey = sourcePhysicalToKey[physicalName];
      const tKey = targetPhysicalToKey[physicalName];
      for (const d of snap.docs) {
        if (isTargetFormatRow(physicalName, d.data(), d.id)) {
          targetDocsByKey.get(tKey).push(d);
        } else {
          sourceDocsByKey.get(sKey).push(d);
        }
      }
    }
  }

  // Build target key map from existing target collections: validate ID and client_id per real collection schema
  const existingTargetKeyedMap = new Map();
  for (const [colKey, docs] of targetDocsByKey.entries()) {
    for (const d of docs) {
      const data = d.data() || {};
      if (colKey !== 'oauthClients' && colKey !== 'clients') {
        if (typeof data.id === 'string' && data.id !== d.id) {
          throw new CutoverFenceError(`Document ID mismatch in ${colKey}/${d.id}: stored id '${data.id}' != docId '${d.id}'`);
        }
      } else {
        if (typeof data.client_id === 'string' && data.client_id !== d.id) {
          throw new CutoverFenceError(`client_id mismatch in ${colKey}/${d.id}: stored client_id '${data.client_id}' != docId '${d.id}'`);
        }
      }
      const targetId = computeKeyedDocId(options.storeKey, 'target-id', namespace, control.epoch, colKey, d.id);
      const recDigest = computeTargetRecordDigest(options.storeKey, namespace, control.epoch, colKey, targetId, data);
      existingTargetKeyedMap.set(`${colKey}:${targetId}`, { doc: d, rawId: d.id, recordDigest: recDigest, data: { ...data, id: d.id } });
    }
  }

  // Verify retained target graphs: contract permits retained equivalent targets, but they must be all-or-none complete and recordDigest equivalent
  for (const c of prepDoc.candidateCommitments) {
    let existingTargetsForCandidate = 0;
    for (const t of c.targets) {
      const targetKey = `${t.collection}:${t.id}`;
      if (existingTargetKeyedMap.has(targetKey)) {
        existingTargetsForCandidate++;
      }
    }
    if (existingTargetsForCandidate > 0) {
      if (existingTargetsForCandidate !== c.targets.length) {
        throw new CutoverFenceError(
          `Candidate ${c.id} has partial retained target graph in Firestore (${existingTargetsForCandidate}/${c.targets.length}); must be all-or-none complete`,
        );
      }
      for (const t of c.targets) {
        const targetKey = `${t.collection}:${t.id}`;
        const entry = existingTargetKeyedMap.get(targetKey);
        if (t.recordDigest && entry.recordDigest !== t.recordDigest) {
          throw new CutoverFenceError(
            `Retained target '${targetKey}' for candidate ${c.id} is not equivalent to candidate target recordDigest`,
          );
        }
      }
    }
  }

  // Ensure no unexpected extra targets exist
  const candidateTargetKeys = new Set();
  for (const c of prepDoc.candidateCommitments) {
    for (const t of c.targets) {
      candidateTargetKeys.add(`${t.collection}:${t.id}`);
    }
  }
  for (const targetKey of existingTargetKeyedMap.keys()) {
    if (!candidateTargetKeys.has(targetKey)) {
      throw new CutoverFenceError(`Cannot prepare migration: unexpected extra target '${targetKey}' exists prior to migration`);
    }
  }

  // Validate actual physical counts
  for (const k of PHYSICAL_COUNT_KEYS) {
    const actualCount = sourceDocsByKey.get(k).length;
    if (actualCount !== prepDoc.physicalCounts[k]) {
      throw new CutoverFenceError(
        `Physical collection count mismatch for '${k}': Firestore has ${actualCount}, prepared manifest has ${prepDoc.physicalCounts[k]}`,
      );
    }
  }

  // Build keyed ID map: (colKey, H("source-id", [colKey, rawId])) -> { doc, rawId, recordDigest, data }
  const sourceKeyedMap = new Map();
  const sourceDescriptors = [];
  for (const [colKey, docs] of sourceDocsByKey.entries()) {
    for (const d of docs) {
      const data = d.data() || {};
      if ((colKey === 'families' || colKey === 'resumeTokens') && typeof data.id === 'string' && data.id !== d.id) {
        throw new CutoverFenceError(`Document ID mismatch in ${colKey}/${d.id}: stored id '${data.id}' != docId '${d.id}'`);
      }
      if ((colKey === 'oauthClients' || colKey === 'clients') && typeof data.client_id === 'string' && data.client_id !== d.id) {
        throw new CutoverFenceError(`client_id mismatch in ${colKey}/${d.id}: stored client_id '${data.client_id}' != docId '${d.id}'`);
      }
      const sourceId = computeKeyedDocId(options.storeKey, 'source-id', namespace, control.epoch, colKey, d.id);
      const recDigest = computeSourceRecordDigest(options.storeKey, namespace, control.epoch, colKey, sourceId, data);
      sourceKeyedMap.set(`${colKey}:${sourceId}`, { doc: d, rawId: d.id, recordDigest: recDigest, data: { ...data, id: d.id } });
      sourceDescriptors.push({ collection: colKey, id: sourceId, recordDigest: recDigest });
    }
  }

  // Verify candidate commitments against Firestore source documents and check complete source partitioning
  const coveredSources = new Set();
  for (const c of prepDoc.candidateCommitments) {
    for (const s of c.sources) {
      const entry = sourceKeyedMap.get(`${s.collection}:${s.id}`);
      if (!entry) {
        throw new CutoverFenceError(`Candidate ${c.id} references source document '${s.collection}:${s.id}' not found in Firestore`);
      }
      if (entry.recordDigest !== s.recordDigest) {
        throw new CutoverFenceError(`Candidate ${c.id} source recordDigest mismatch for '${s.collection}:${s.id}'`);
      }
      coveredSources.add(`${s.collection}:${s.id}`);
    }
  }

  for (const key of sourceKeyedMap.keys()) {
    if (!coveredSources.has(key)) {
      throw new CutoverFenceError(`Extra source document '${key}' found in Firestore not partitioned into candidate commitments`);
    }
  }

  // Provenance-bound graph projector: nonempty migrations execute reviewed separate module verified against measured bytes
  if (prepDoc.totalPhysicalRecords > 0) {
    if (prepDoc.projectorId !== APPROVED_GRAPH_PROJECTOR_ID || prepDoc.projectorVersion !== APPROVED_GRAPH_PROJECTOR_VERSION) {
      throw new CutoverFenceError(
        `Projector identity mismatch: expected '${APPROVED_GRAPH_PROJECTOR_ID}' v${APPROVED_GRAPH_PROJECTOR_VERSION}, got '${prepDoc.projectorId}' v${prepDoc.projectorVersion}`,
      );
    }
    const measuredProjectorDigest = getMeasuredProjectorDigest();
    if (prepDoc.projectorDigest !== measuredProjectorDigest) {
      throw new CutoverFenceError(
        `Projector digest mismatch: manifest has ${prepDoc.projectorDigest}, deployed module byte SHA-256 is ${measuredProjectorDigest}`,
      );
    }

    const codec = createCodec(options.storeKey);

    for (const c of prepDoc.candidateCommitments) {
      const sourcesMap = new Map();
      if (c.kind === 'pr56Families') {
        const famDesc = c.sources.find((s) => s.collection === 'families');
        if (!famDesc) throw new CutoverFenceError(`Candidate ${c.id} missing families descriptor in sources`);
        const e = sourceKeyedMap.get(`${famDesc.collection}:${famDesc.id}`);
        if (!e) throw new CutoverFenceError(`Candidate ${c.id} missing families source document`);
        const famData = { ...(e.data || {}), id: e.rawId };
        sourcesMap.set('families', famData);

        // Exact active refresh selection: must have rawId === famData.currentRefreshToken AND status === 'active'
        const activeRefDesc = c.sources.find((s) => {
          if (s.collection !== 'refresh') return false;
          const entry = sourceKeyedMap.get(`refresh:${s.id}`);
          return entry && entry.rawId === famData.currentRefreshToken && entry.data?.status === 'active';
        });
        if (!activeRefDesc) {
          throw new CutoverFenceError(`Candidate ${c.id} missing active refresh descriptor in sources matching currentRefreshToken '${famData.currentRefreshToken}'`);
        }
        const re = sourceKeyedMap.get(`refresh:${activeRefDesc.id}`);
        if (!re) throw new CutoverFenceError(`Candidate ${c.id} missing active refresh document in sourceKeyedMap`);
        sourcesMap.set('refresh', { ...(re.data || {}), id: re.rawId });

        // Exact previous refresh selection: must have rawId === famData.previousRefreshToken AND status === 'consumed'
        if (famData.previousRefreshToken) {
          const prevRefDesc = c.sources.find((s) => {
            if (s.collection !== 'refresh') return false;
            const entry = sourceKeyedMap.get(`refresh:${s.id}`);
            return entry && entry.rawId === famData.previousRefreshToken && entry.data?.status === 'consumed';
          });
          if (!prevRefDesc) {
            throw new CutoverFenceError(`Candidate ${c.id} has previousRefreshToken '${famData.previousRefreshToken}' but missing previous refresh descriptor in sources`);
          }
          const pe = sourceKeyedMap.get(`refresh:${prevRefDesc.id}`);
          if (!pe) throw new CutoverFenceError(`Candidate ${c.id} missing previous refresh document in sourceKeyedMap`);
          if (typeof pe.data?.consumedAt !== 'number') {
            throw new CutoverFenceError(`Candidate ${c.id} previous refresh document '${pe.rawId}' missing numeric consumedAt`);
          }
          sourcesMap.set('prevRefresh', { ...(pe.data || {}), id: pe.rawId });
        }

        const upDesc = c.sources.find((s) => s.collection === 'upstream');
        if (!upDesc) throw new CutoverFenceError(`Candidate ${c.id} missing upstream descriptor in sources`);
        const ue = sourceKeyedMap.get(`${upDesc.collection}:${upDesc.id}`);
        if (!ue) throw new CutoverFenceError(`Candidate ${c.id} missing upstream source document`);
        sourcesMap.set('upstream', { ...(ue.data || {}), id: ue.rawId });

        const tokDesc = c.sources.find((s) => s.collection === 'tokens');
        if (tokDesc) {
          const te = sourceKeyedMap.get(`${tokDesc.collection}:${tokDesc.id}`);
          if (te) sourcesMap.set('tokens', { ...(te.data || {}), id: te.rawId });
        }
      } else if (c.kind === 'baseFormatTokens') {
        const tokDesc = c.sources.find((s) => s.collection === 'tokens');
        if (!tokDesc) throw new CutoverFenceError(`Candidate ${c.id} missing tokens descriptor in sources`);
        const te = sourceKeyedMap.get(`${tokDesc.collection}:${tokDesc.id}`);
        if (!te) throw new CutoverFenceError(`Candidate ${c.id} missing tokens source document`);
        sourcesMap.set('tokens', { ...(te.data || {}), id: te.rawId });

        const refDesc = c.sources.find((s) => s.collection === 'refresh');
        if (!refDesc) throw new CutoverFenceError(`Candidate ${c.id} missing refresh descriptor in sources`);
        const re = sourceKeyedMap.get(`${refDesc.collection}:${refDesc.id}`);
        if (!re) throw new CutoverFenceError(`Candidate ${c.id} missing refresh source document`);
        sourcesMap.set('refresh', { ...(re.data || {}), id: re.rawId });
      } else if (c.kind === 'authCodes') {
        const codeDesc = c.sources.find((s) => s.collection === 'authCodes');
        if (!codeDesc) throw new CutoverFenceError(`Candidate ${c.id} missing authCodes descriptor in sources`);
        const e = sourceKeyedMap.get(`${codeDesc.collection}:${codeDesc.id}`);
        if (!e) throw new CutoverFenceError(`Candidate ${c.id} missing authCodes source document`);
        sourcesMap.set('authCodes', { ...(e.data || {}), id: e.rawId });
      } else if (c.kind === 'resumeTokens') {
        const resDesc = c.sources.find((s) => s.collection === 'resumeTokens');
        if (!resDesc) throw new CutoverFenceError(`Candidate ${c.id} missing resumeTokens descriptor in sources`);
        const e = sourceKeyedMap.get(`${resDesc.collection}:${resDesc.id}`);
        if (!e) throw new CutoverFenceError(`Candidate ${c.id} missing resumeTokens source document`);
        sourcesMap.set('resumeTokens', { ...(e.data || {}), id: e.rawId });
      } else if (c.kind === 'clients') {
        const oauthDesc = c.sources.find((s) => s.collection === 'oauthClients');
        const clientDesc = c.sources.find((s) => s.collection === 'clients');
        const oauthEntry = oauthDesc ? sourceKeyedMap.get(`oauthClients:${oauthDesc.id}`) : null;
        const clientEntry = clientDesc ? sourceKeyedMap.get(`clients:${clientDesc.id}`) : null;
        if (oauthEntry && clientEntry) {
          const oData = oauthEntry.data || {};
          const cData = clientEntry.data || {};
          if (
            C(oData.redirect_uris || []) !== C(cData.redirect_uris || []) ||
            oData.token_endpoint_auth_method !== cData.token_endpoint_auth_method
          ) {
            throw new CutoverFenceError(`Conflicting claims between clients and oauthClients for clientId ${clientEntry.rawId}`);
          }
          sourcesMap.set('clients', { ...cData, ...oData, id: clientEntry.rawId });
        } else if (oauthEntry) {
          sourcesMap.set('clients', { ...(oauthEntry.data || {}), id: oauthEntry.rawId });
        } else if (clientEntry) {
          sourcesMap.set('clients', { ...(clientEntry.data || {}), id: clientEntry.rawId });
        }
      }

      const sourceResult = projectSourceLogical(c, sourcesMap, codec);
      validateCandidateProjection(c.kind, c.id, sourceResult);
      const derivedSourceLogicalDigest = H(options.storeKey, 'logical-record', namespace, control.epoch, [c.kind, sourceResult]);
      if (c.logicalDigest !== derivedSourceLogicalDigest) {
        throw new CutoverFenceError(
          `Candidate ${c.id} logicalDigest mismatch with projector-derived source logical digest`,
        );
      }

      // Check retained targets if present for this candidate
      const existingTargetsCount = c.targets.filter((t) => existingTargetKeyedMap.has(`${t.collection}:${t.id}`)).length;
      if (existingTargetsCount > 0) {
        const targetsMap = new Map();
        if (c.kind === 'pr56Families') {
          const famTarget = c.targets.find((t) => t.collection === 'families');
          let famData;
          if (famTarget) {
            const e = existingTargetKeyedMap.get(`${famTarget.collection}:${famTarget.id}`);
            if (e) {
              famData = { ...(e.data || {}), id: e.rawId };
              targetsMap.set('families', famData);
            }
          }
          const upTarget = c.targets.find((t) => t.collection === 'upstream');
          if (upTarget) {
            const e = existingTargetKeyedMap.get(`${upTarget.collection}:${upTarget.id}`);
            if (e) targetsMap.set('upstream', { ...(e.data || {}), id: e.rawId });
          }
          const sessTarget = c.targets.find((t) => t.collection === 'tokens');
          if (sessTarget) {
            const e = existingTargetKeyedMap.get(`${sessTarget.collection}:${sessTarget.id}`);
            if (e) targetsMap.set('tokens', { ...(e.data || {}), id: e.rawId });
          }
          const refreshTargets = c.targets.filter((t) => t.collection === 'refresh');
          for (const t of refreshTargets) {
            const e = existingTargetKeyedMap.get(`refresh:${t.id}`);
            if (e) {
              if (famData && (e.rawId === famData.activeRefreshId && e.data?.status === 'active')) {
                targetsMap.set('activeRefresh', { ...(e.data || {}), id: e.rawId });
              } else if (famData && (e.rawId !== famData.activeRefreshId && e.data?.status === 'consumed')) {
                targetsMap.set('prevRefresh', { ...(e.data || {}), id: e.rawId });
              }
            }
          }
          if (!targetsMap.has('activeRefresh')) {
            throw new CutoverFenceError(`Candidate ${c.id} missing active refresh target document matching activeRefreshId`);
          }
          if (famData && famData.previousRefreshToken && !targetsMap.has('prevRefresh')) {
            throw new CutoverFenceError(`Candidate ${c.id} has previousRefreshToken but missing prevRefresh target document`);
          }
          const retiredTargets = c.targets.filter((t) => t.collection === 'retiredRefreshTokens');
          const retiredIds = [];
          for (const t of retiredTargets) {
            const e = existingTargetKeyedMap.get(`retiredRefreshTokens:${t.id}`);
            if (!e) throw new CutoverFenceError(`Candidate ${c.id} missing retiredRefreshTokens target document in Firestore`);
            if (e.data?.familyId !== famData?.id) throw new CutoverFenceError(`Retired refresh token '${e.rawId}' familyId mismatch`);
            retiredIds.push(e.rawId);
          }
          targetsMap.set('retiredRefresh', { ids: retiredIds.sort(canonicalCompare) });
        } else if (c.kind === 'baseFormatTokens') {
          const famTarget = c.targets.find((t) => t.collection === 'families');
          if (famTarget) {
            const e = existingTargetKeyedMap.get(`${famTarget.collection}:${famTarget.id}`);
            if (e) targetsMap.set('families', { ...(e.data || {}), id: e.rawId });
          }
          const upTarget = c.targets.find((t) => t.collection === 'upstream');
          if (upTarget) {
            const e = existingTargetKeyedMap.get(`${upTarget.collection}:${upTarget.id}`);
            if (e) targetsMap.set('upstream', { ...(e.data || {}), id: e.rawId });
          }
          const sessTarget = c.targets.find((t) => t.collection === 'tokens');
          if (sessTarget) {
            const e = existingTargetKeyedMap.get(`${sessTarget.collection}:${sessTarget.id}`);
            if (e) targetsMap.set('tokens', { ...(e.data || {}), id: e.rawId });
          }
          const refTarget = c.targets.find((t) => t.collection === 'refresh');
          if (refTarget) {
            const e = existingTargetKeyedMap.get(`${refTarget.collection}:${refTarget.id}`);
            if (e) targetsMap.set('activeRefresh', { ...(e.data || {}), id: e.rawId });
          }
        } else if (c.kind === 'authCodes') {
          const codeTarget = c.targets.find((t) => t.collection === 'authCodes');
          if (codeTarget) {
            const e = existingTargetKeyedMap.get(`${codeTarget.collection}:${codeTarget.id}`);
            if (e) targetsMap.set('authCodes', { ...(e.data || {}), id: e.rawId });
          }
        } else if (c.kind === 'resumeTokens') {
          const resTarget = c.targets.find((t) => t.collection === 'resumeTokens');
          if (resTarget) {
            const e = existingTargetKeyedMap.get(`${resTarget.collection}:${resTarget.id}`);
            if (e) targetsMap.set('resumeTokens', { ...(e.data || {}), id: e.rawId });
          }
        } else if (c.kind === 'clients') {
          const clientTarget = c.targets.find((t) => t.collection === 'oauthClients' || t.collection === 'clients');
          if (clientTarget) {
            const e = existingTargetKeyedMap.get(`${clientTarget.collection}:${clientTarget.id}`);
            if (e) targetsMap.set('clients', { ...(e.data || {}), id: e.rawId });
          }
        }

        const targetResult = projectTargetLogical(c, targetsMap, codec);
        validateCandidateProjection(c.kind, c.id, targetResult);
        const derivedTargetLogicalDigest = H(options.storeKey, 'logical-record', namespace, control.epoch, [c.kind, targetResult]);
        if (derivedTargetLogicalDigest !== c.logicalDigest) {
          throw new CutoverFenceError(
            `Retained target graph for candidate ${c.id} is not logically equivalent to candidate commitment`,
          );
        }
      }
    }
  }

  // Recompute and verify sourceInventoryDigest from sorted exact descriptor objects { collection, id, recordDigest }
  const computedSourceInventory = computeSourceInventoryDigest(options.storeKey, namespace, control.epoch, sourceDescriptors);
  if (prepDoc.sourceInventoryDigest !== computedSourceInventory) {
    throw new CutoverFenceError('prepared manifest sourceInventoryDigest does not match computed source inventory');
  }

  // Recompute and verify sourceLogicalDigest from candidate commitments
  const sortedCandidateLogicalPairs = prepDoc.candidateCommitments
    .map((c) => [c.id, c.logicalDigest])
    .sort((a, b) => canonicalCompare(a[0], b[0]));
  const computedLogicalInventory = H(options.storeKey, 'logical-inventory', namespace, control.epoch, sortedCandidateLogicalPairs);
  if (prepDoc.sourceLogicalDigest !== computedLogicalInventory) {
    throw new CutoverFenceError('prepared manifest sourceLogicalDigest does not match computed logical inventory');
  }

  // Validate preflight full readset
  const allDocs = Array.from(rawColSnaps.values()).flatMap((s) => s.docs.map((d) => d.data()));
  validateMigrationPreflightLimits(prepDoc, { fullReadset: allDocs, readDurationMs });

  const prepRef = db.collection(`${namespace}_meta`).doc(`migration_prepared_${control.epoch}`);
  const prepSnap = await transaction.get(prepRef);
  if (prepSnap.exists) {
    const existing = prepSnap.data();
    if (C(existing) !== C(prepDoc)) {
      throw new CutoverFenceError(
        'Prepared manifest already exists for this epoch with different content; immutable retry violation',
      );
    }
    return control;
  }

  transaction.set(prepRef, stripUndefined(prepDoc));

  const controlRef = getCutoverFenceDocRef(db, namespace);
  const updatedControl = {
    ...control,
    state: 'migrating',
    migrationRunId: prepDoc.migrationRunId,
    migrationManifestDigest: undefined,
    updatedAt: prepDoc.preparedAt,
  };
  transaction.set(controlRef, stripUndefined(updatedControl));
  return updatedControl;
}

export async function finalizeMigrationInTransaction(transaction, db, options) {
  const { namespace, finalDoc, markerDoc } = options;
  assertSupportedCutoverNamespace(namespace);

  if (!options.storeKey || (typeof options.storeKey !== 'string' && !Buffer.isBuffer(options.storeKey) && !(options.storeKey instanceof Uint8Array))) {
    throw new CutoverFenceError('storeKey is REQUIRED for finalizeMigrationInTransaction');
  }

  const control = await readCutoverFenceInTransaction(transaction, db, namespace);

  // FieldPath adapter is REQUIRED (no __name__ fallback)
  const FieldPath = options.FieldPath;
  if (!FieldPath || typeof FieldPath.documentId !== 'function') {
    throw new CutoverFenceError('FieldPath with documentId() is REQUIRED for finalizeMigrationInTransaction');
  }
  const docIdField = FieldPath.documentId();

  // Idempotent retry after entering v3_ready
  if (control.state === 'v3_ready') {
    const finalRef = db.collection(`${namespace}_meta`).doc(`migration_manifest_${control.epoch}`);
    const markerRef = db.collection(`${namespace}_meta`).doc('v2_adopted');
    const finalSnap = await transaction.get(finalRef);
    const markerSnap = await transaction.get(markerRef);
    if (
      finalSnap.exists &&
      markerSnap.exists &&
      C(finalSnap.data()) === C(finalDoc) &&
      C(markerSnap.data()) === C(markerDoc) &&
      control.migrationManifestDigest === markerDoc.migrationManifestDigest
    ) {
      return control;
    }
    throw new CutoverFenceError(
      'Already in v3_ready state with different manifests; immutable retry violation',
    );
  }

  if (control.state !== 'migrating') {
    throw new CutoverFenceError(`Cannot finalize migration: state must be 'migrating', got '${control.state}'`);
  }
  if (control.activeOperations !== 0) {
    throw new CutoverFenceError(`Cannot finalize migration: activeOperations must be 0, got ${control.activeOperations}`);
  }
  if (markerDoc.emptyNamespace !== true && !control.irreversible) {
    throw new CutoverFenceError(
      `Cannot finalize migration for namespace ${namespace}: irreversible latch must be engaged before finalization`,
    );
  }

  const prepRef = db.collection(`${namespace}_meta`).doc(`migration_prepared_${control.epoch}`);
  const prepSnap = await transaction.get(prepRef);
  if (!prepSnap.exists) {
    throw new CutoverFenceError(`Cannot finalize migration: prepared manifest missing for epoch ${control.epoch}`);
  }
  const prep = prepSnap.data();

  const expectedFinalKeys = finalDoc.totalPhysicalRecords > 0
    ? [...REQUIRED_FINAL_MANIFEST_KEYS, ...NONEMPTY_PROJECTOR_KEYS]
    : REQUIRED_FINAL_MANIFEST_KEYS;
  validateMapKeysExact(finalDoc, expectedFinalKeys, 'final manifest');
  validateMigrationIdentityFields(finalDoc, namespace, control.epoch, control.migrationRunId);
  if (finalDoc.kind !== 'final') {
    throw new CutoverFenceError(`final manifest kind must be 'final', got '${finalDoc.kind}'`);
  }
  if (typeof finalDoc.completedAt !== 'number' || !Number.isInteger(finalDoc.completedAt) || finalDoc.completedAt <= 0) {
    throw new CutoverFenceError('final manifest completedAt must be a positive integer timestamp');
  }

  const expectedMarkerKeys = markerDoc.emptyNamespace !== true
    ? [...REQUIRED_OWNERSHIP_MARKER_KEYS, ...NONEMPTY_PROJECTOR_KEYS]
    : REQUIRED_OWNERSHIP_MARKER_KEYS;
  validateMapKeysExact(markerDoc, expectedMarkerKeys, 'ownership marker');
  validateMigrationIdentityFields(markerDoc, namespace, control.epoch, control.migrationRunId);
  if (markerDoc.kind !== 'ownership') {
    throw new CutoverFenceError(`ownership marker kind must be 'ownership', got '${markerDoc.kind}'`);
  }
  if (typeof markerDoc.adoptedAt !== 'number' || !Number.isInteger(markerDoc.adoptedAt) || markerDoc.adoptedAt <= 0) {
    throw new CutoverFenceError('ownership marker adoptedAt must be a positive integer timestamp');
  }

  if (
    finalDoc.codeSha !== prep.codeSha ||
    finalDoc.codeArtifact !== prep.codeArtifact ||
    finalDoc.packageIntegrity !== prep.packageIntegrity ||
    finalDoc.protocolDigest !== prep.protocolDigest ||
    markerDoc.codeSha !== prep.codeSha ||
    markerDoc.codeArtifact !== prep.codeArtifact ||
    markerDoc.packageIntegrity !== prep.packageIntegrity ||
    markerDoc.protocolDigest !== prep.protocolDigest
  ) {
    throw new CutoverFenceError('Provenance mismatch across prepared, final, and marker manifests');
  }

  const computedPreparedDigest = D('prepared', namespace, control.epoch, prep);
  if (finalDoc.preparedDigest !== computedPreparedDigest) {
    throw new CutoverFenceError(
      `final manifest preparedDigest (${finalDoc.preparedDigest}) does not match computed prepared digest (${computedPreparedDigest})`,
    );
  }
  if (markerDoc.preparedDigest !== computedPreparedDigest) {
    throw new CutoverFenceError('ownership marker preparedDigest does not match computed prepared digest');
  }

  const computedFinalDigest = D('final', namespace, control.epoch, finalDoc);
  if (markerDoc.migrationManifestDigest !== computedFinalDigest) {
    throw new CutoverFenceError(
      `ownership marker migrationManifestDigest (${markerDoc.migrationManifestDigest}) does not match computed final digest (${computedFinalDigest})`,
    );
  }

  validateMapKeysExact(finalDoc.physicalCounts, PHYSICAL_COUNT_KEYS, 'final physicalCounts');
  validateMapKeysExact(finalDoc.targetCounts, TARGET_COUNT_KEYS, 'final targetCounts');
  validateMapKeysExact(finalDoc.classifications, CLASSIFICATION_KEYS, 'final classifications');
  validateMapKeysExact(finalDoc.reasons, REASON_KEYS, 'final reasons');

  if (finalDoc.errors !== 0) {
    throw new CutoverFenceError(`Cannot finalize migration: final errors must be 0, got ${finalDoc.errors}`);
  }
  for (const [rKey, rVal] of Object.entries(finalDoc.reasons)) {
    if (rVal !== 0) {
      throw new CutoverFenceError(`Cannot finalize migration: reason count '${rKey}' must be 0, got ${rVal}`);
    }
  }

  if (finalDoc.sourceLogicalDigest !== finalDoc.targetLogicalDigest) {
    throw new CutoverFenceError('Cannot finalize migration: sourceLogicalDigest must equal targetLogicalDigest');
  }
  if (finalDoc.sourceInventoryDigest !== prep.sourceInventoryDigest) {
    throw new CutoverFenceError('Cannot finalize migration: sourceInventoryDigest must match prepared');
  }
  if (finalDoc.sourceLogicalDigest !== prep.sourceLogicalDigest) {
    throw new CutoverFenceError('Cannot finalize migration: sourceLogicalDigest must match prepared');
  }

  if (C(finalDoc.physicalCounts) !== C(prep.physicalCounts)) {
    throw new CutoverFenceError('final physicalCounts do not match prepared physicalCounts');
  }
  if (C(finalDoc.targetCounts) !== C(prep.expectedTargetCounts)) {
    throw new CutoverFenceError('final targetCounts do not match prepared expectedTargetCounts');
  }
  if (C(finalDoc.classifications) !== C(prep.classifications)) {
    throw new CutoverFenceError('final classifications do not match prepared classifications');
  }
  if (C(finalDoc.reasons) !== C(prep.reasons)) {
    throw new CutoverFenceError('final reasons do not match prepared reasons');
  }

  const finalPhysicalSum = Object.values(finalDoc.physicalCounts).reduce((sum, n) => sum + n, 0);
  if (finalPhysicalSum !== finalDoc.totalPhysicalRecords) {
    throw new CutoverFenceError('final physicalCounts sum must equal totalPhysicalRecords');
  }

  const targetCountSum = Object.values(finalDoc.targetCounts).reduce((sum, n) => {
    if (!Number.isSafeInteger(n) || n < 0) throw new CutoverFenceError('Invalid target count');
    return sum + n;
  }, 0);

  if (markerDoc.emptyNamespace === true) {
    if (finalDoc.totalPhysicalRecords !== 0 || finalDoc.scanned !== 0 || finalDoc.migrated !== 0 || finalDoc.skipped !== 0 || finalDoc.errors !== 0) {
      throw new CutoverFenceError('Counts must be 0 for emptyNamespace final manifest');
    }
    if (prep.candidateCommitments.length !== 0) {
      throw new CutoverFenceError('candidateCommitments must be empty for emptyNamespace');
    }
    if (targetCountSum !== 0) {
      throw new CutoverFenceError('targetCounts sum must be 0 for emptyNamespace');
    }

    // Canonical empty hash equations
    const emptySourceInventory = H(options.storeKey, 'source-inventory', namespace, control.epoch, []);
    const emptyTargetInventory = H(options.storeKey, 'target-inventory', namespace, control.epoch, []);
    const emptyLogicalInventory = H(options.storeKey, 'logical-inventory', namespace, control.epoch, []);
    const emptyReceiptSet = D('receipt-set', namespace, control.epoch, []);

    if (prep.sourceInventoryDigest !== emptySourceInventory) {
      throw new CutoverFenceError('Empty namespace requires canonical empty sourceInventoryDigest');
    }
    if (prep.sourceLogicalDigest !== emptyLogicalInventory) {
      throw new CutoverFenceError('Empty namespace requires canonical empty sourceLogicalDigest');
    }
    if (finalDoc.targetInventoryDigest !== emptyTargetInventory) {
      throw new CutoverFenceError('Empty namespace requires canonical empty targetInventoryDigest');
    }
    if (finalDoc.receiptSetDigest !== emptyReceiptSet) {
      throw new CutoverFenceError('Empty namespace requires canonical empty receiptSetDigest');
    }
  } else {
    if (targetCountSum <= 0 && finalDoc.migrated > 0) {
      throw new CutoverFenceError('targetCounts sum must be greater than 0 for non-empty namespace');
    }
  }

  // Exact read strategy: query ALL 13 distinct collections once
  const distinctColNames = getCutoverDistinctCollectionNames(namespace).distinct;
  const rawColSnaps = new Map();

  for (const colName of distinctColNames) {
    const q = db.collection(colName).orderBy(docIdField);
    const snap = await transaction.get(q);
    rawColSnaps.set(colName, snap);
  }

  // Query receipts range
  const receiptsCol = db.collection(`${namespace}_meta`);
  const lowerBound = `migration_receipt_${control.epoch}_`;
  const upperBound = `migration_receipt_${control.epoch}\``;

  const receiptsQuery = receiptsCol
    .orderBy(docIdField)
    .startAt(lowerBound)
    .endBefore(upperBound);
  const receiptsSnap = await transaction.get(receiptsQuery);

  const actualReceipts = receiptsSnap.docs.map((d) => {
    const expectedPrefix = `migration_receipt_${control.epoch}_`;
    if (!d.id.startsWith(expectedPrefix)) {
      throw new CutoverFenceError(`Invalid receipt document ID: ${d.id}`);
    }
    const candidateIdSuffix = d.id.slice(expectedPrefix.length);
    const data = d.data();
    if (data.candidateId !== candidateIdSuffix) {
      throw new CutoverFenceError(
        `Receipt document ID suffix mismatch: expected ${candidateIdSuffix}, got ${data.candidateId}`,
      );
    }
    return data;
  });

  // Partition all 13 collections into normalized key buckets
  const sourcePhysicalToKey = {
    [`${namespace}_tokens_refresh_families`]: 'families',
    [`${namespace}_tokens`]: 'tokens',
    [`${namespace}_tokens_refresh`]: 'refresh',
    [`${namespace}_tokens_upstream`]: 'upstream',
    [`${namespace}_auth_codes`]: 'authCodes',
    [`${namespace}_resume_tokens`]: 'resumeTokens',
    [`${namespace}_oauth_clients`]: 'oauthClients',
    [`${namespace}_clients`]: 'clients',
  };

  const targetPhysicalToKey = {
    [`${namespace}_refresh_families`]: 'families',
    [`${namespace}_sessions`]: 'tokens',
    [`${namespace}_refresh`]: 'refresh',
    [`${namespace}_upstream`]: 'upstream',
    [`${namespace}_auth_codes`]: 'authCodes',
    [`${namespace}_resume_tokens`]: 'resumeTokens',
    [`${namespace}_retired_refresh`]: 'retiredRefreshTokens',
    [`${namespace}_oauth_clients`]: 'oauthClients',
  };

  const sourceDocsByKey = new Map();
  for (const k of PHYSICAL_COUNT_KEYS) sourceDocsByKey.set(k, []);

  const targetDocsByKey = new Map();
  for (const k of TARGET_COUNT_KEYS) targetDocsByKey.set(k, []);

  for (const [physicalName, snap] of rawColSnaps.entries()) {
    const isSourceCol = physicalName in sourcePhysicalToKey;
    const isTargetCol = physicalName in targetPhysicalToKey;

    if (isSourceCol && !isTargetCol) {
      const colKey = sourcePhysicalToKey[physicalName];
      sourceDocsByKey.set(colKey, snap.docs);
    } else if (isTargetCol && !isSourceCol) {
      const colKey = targetPhysicalToKey[physicalName];
      targetDocsByKey.set(colKey, snap.docs);
    } else if (isSourceCol && isTargetCol) {
      const sKey = sourcePhysicalToKey[physicalName];
      const tKey = targetPhysicalToKey[physicalName];
      for (const d of snap.docs) {
        if (isTargetFormatRow(physicalName, d.data(), d.id)) {
          targetDocsByKey.get(tKey).push(d);
        } else {
          sourceDocsByKey.get(sKey).push(d);
        }
      }
    }
  }

  // Build keyed maps for current state: validate ID and client_id per real collection schema
  const currentSourceKeyedMap = new Map();
  for (const [colKey, docs] of sourceDocsByKey.entries()) {
    for (const d of docs) {
      const data = d.data() || {};
      if ((colKey === 'families' || colKey === 'resumeTokens') && typeof data.id === 'string' && data.id !== d.id) {
        throw new CutoverFenceError(`Document ID mismatch in ${colKey}/${d.id}: stored id '${data.id}' != docId '${d.id}'`);
      }
      if ((colKey === 'oauthClients' || colKey === 'clients') && typeof data.client_id === 'string' && data.client_id !== d.id) {
        throw new CutoverFenceError(`client_id mismatch in ${colKey}/${d.id}: stored client_id '${data.client_id}' != docId '${d.id}'`);
      }
      const sourceId = computeKeyedDocId(options.storeKey, 'source-id', namespace, control.epoch, colKey, d.id);
      const recDigest = computeSourceRecordDigest(options.storeKey, namespace, control.epoch, colKey, sourceId, data);
      currentSourceKeyedMap.set(`${colKey}:${sourceId}`, { doc: d, rawId: d.id, recordDigest: recDigest, data: { ...data, id: d.id } });
    }
  }

  const currentTargetKeyedMap = new Map();
  const targetDescriptors = [];
  for (const [colKey, docs] of targetDocsByKey.entries()) {
    for (const d of docs) {
      const data = d.data() || {};
      if (colKey !== 'oauthClients' && colKey !== 'clients') {
        if (typeof data.id === 'string' && data.id !== d.id) {
          throw new CutoverFenceError(`Document ID mismatch in ${colKey}/${d.id}: stored id '${data.id}' != docId '${d.id}'`);
        }
      } else {
        if (typeof data.client_id === 'string' && data.client_id !== d.id) {
          throw new CutoverFenceError(`client_id mismatch in ${colKey}/${d.id}: stored client_id '${data.client_id}' != docId '${d.id}'`);
        }
      }
      const targetId = computeKeyedDocId(options.storeKey, 'target-id', namespace, control.epoch, colKey, d.id);
      const recDigest = computeTargetRecordDigest(options.storeKey, namespace, control.epoch, colKey, targetId, data);
      currentTargetKeyedMap.set(`${colKey}:${targetId}`, { doc: d, rawId: d.id, recordDigest: recDigest, data: { ...data, id: d.id } });
      targetDescriptors.push({ collection: colKey, id: targetId, recordDigest: recDigest });
    }
  }

  let writtenCount = 0;
  let retainedCount = 0;
  const receiptCandidateIds = new Set();
  const candidateMap = new Map(prep.candidateCommitments.map((c) => [c.id, c]));
  const expectedWrittenTargets = new Set();
  const retainedSources = new Set();

  for (const r of actualReceipts) {
    validateReceipt(r, namespace, control.epoch, control.migrationRunId);
    if (r.disposition === 'written') writtenCount++;
    if (r.disposition === 'retained') retainedCount++;

    if (receiptCandidateIds.has(r.candidateId)) {
      throw new CutoverFenceError(`Duplicate candidate receipt in finalization: ${r.candidateId}`);
    }
    receiptCandidateIds.add(r.candidateId);

    const c = candidateMap.get(r.candidateId);
    if (!c) {
      throw new CutoverFenceError(`Receipt candidateId '${r.candidateId}' does not match any committed candidate`);
    }

    if (r.preparedDigest !== computedPreparedDigest) {
      throw new CutoverFenceError(`Receipt preparedDigest mismatch for candidate ${r.candidateId}`);
    }
    const expectedCandDigest = D('candidate', namespace, control.epoch, c);
    if (r.candidateDigest !== expectedCandDigest) {
      throw new CutoverFenceError(`Receipt candidateDigest mismatch for candidate ${r.candidateId}`);
    }
    if (r.logicalDigest !== c.logicalDigest) {
      throw new CutoverFenceError(`Receipt logicalDigest mismatch for candidate ${r.candidateId}`);
    }

    // Exact reference set equality between receipt descriptors and candidate descriptors
    const rSourceKeys = r.sourceAfter.map((s) => `${s.collection}:${s.id}`).sort(canonicalCompare);
    const cSourceKeys = c.sources.map((s) => `${s.collection}:${s.id}`).sort(canonicalCompare);
    if (rSourceKeys.length !== cSourceKeys.length || !rSourceKeys.every((k, idx) => k === cSourceKeys[idx])) {
      throw new CutoverFenceError(`Receipt sourceAfter reference set mismatch for candidate ${r.candidateId}`);
    }

    const rTargetKeys = r.targetAfter.map((t) => `${t.collection}:${t.id}`).sort(canonicalCompare);
    const cTargetKeys = c.targets.map((t) => `${t.collection}:${t.id}`).sort(canonicalCompare);
    if (rTargetKeys.length !== cTargetKeys.length || !rTargetKeys.every((k, idx) => k === cTargetKeys[idx])) {
      throw new CutoverFenceError(`Receipt targetAfter reference set mismatch for candidate ${r.candidateId}`);
    }

    // Reconcile source after-state
    for (const s of r.sourceAfter) {
      const entry = currentSourceKeyedMap.get(`${s.collection}:${s.id}`);
      if (s.recordDigest === null) {
        if (entry) {
          throw new CutoverFenceError(`Source '${s.collection}:${s.id}' was marked deleted in receipt but still exists in Firestore`);
        }
      } else {
        if (!entry) {
          throw new CutoverFenceError(`Source '${s.collection}:${s.id}' was marked retained in receipt but does not exist in Firestore`);
        }
        if (entry.recordDigest !== s.recordDigest) {
          throw new CutoverFenceError(`Source '${s.collection}:${s.id}' recordDigest mismatch`);
        }
        retainedSources.add(`${s.collection}:${s.id}`);
      }
    }

    // Reconcile target after-state and postimages
    for (const t of r.targetAfter) {
      const targetKey = `${t.collection}:${t.id}`;
      expectedWrittenTargets.add(targetKey);

      const entry = currentTargetKeyedMap.get(targetKey);
      if (!entry) {
        throw new CutoverFenceError(`Missing target document '${targetKey}' in Firestore`);
      }
      if (entry.recordDigest !== t.recordDigest) {
        throw new CutoverFenceError(`Target document '${targetKey}' postimage recordDigest mismatch`);
      }
    }
  }

  // Reject extra sources in Firestore (every source document remaining in Firestore must be accounted for as retained in receipts)
  for (const sourceKey of currentSourceKeyedMap.keys()) {
    if (!retainedSources.has(sourceKey)) {
      throw new CutoverFenceError(`Extra source document '${sourceKey}' found in Firestore not accounted for as retained by receipts`);
    }
  }

  // Reject extra targets in Firestore target collections
  for (const targetKey of currentTargetKeyedMap.keys()) {
    if (!expectedWrittenTargets.has(targetKey)) {
      throw new CutoverFenceError(`Extra target document '${targetKey}' found in Firestore not accounted for by receipts`);
    }
  }

  // Provenance-bound graph projector: nonempty migrations execute reviewed separate module verified against measured bytes
  if (finalDoc.totalPhysicalRecords > 0) {
    if (finalDoc.projectorId !== prep.projectorId || finalDoc.projectorVersion !== prep.projectorVersion || finalDoc.projectorDigest !== prep.projectorDigest) {
      throw new CutoverFenceError('Final manifest projector identity or digest does not match prepared manifest');
    }
    if (markerDoc.projectorId !== finalDoc.projectorId || markerDoc.projectorVersion !== finalDoc.projectorVersion || markerDoc.projectorDigest !== finalDoc.projectorDigest) {
      throw new CutoverFenceError('Ownership marker projector identity or digest does not match final manifest');
    }

    const measuredProjectorDigest = getMeasuredProjectorDigest();
    if (finalDoc.projectorDigest !== measuredProjectorDigest) {
      throw new CutoverFenceError(
        `Projector digest mismatch: manifest has ${finalDoc.projectorDigest}, deployed module byte SHA-256 is ${measuredProjectorDigest}`,
      );
    }

    const codec = createCodec(options.storeKey);

    for (const r of actualReceipts) {
      const c = candidateMap.get(r.candidateId);
      const targetsMap = new Map();
      if (c.kind === 'pr56Families') {
        const famTarget = c.targets.find((t) => t.collection === 'families');
        let famData;
        if (famTarget) {
          const e = currentTargetKeyedMap.get(`${famTarget.collection}:${famTarget.id}`);
          if (e) {
            famData = { ...(e.data || {}), id: e.rawId };
            targetsMap.set('families', famData);
          }
        }
        const upTarget = c.targets.find((t) => t.collection === 'upstream');
        if (upTarget) {
          const e = currentTargetKeyedMap.get(`${upTarget.collection}:${upTarget.id}`);
          if (e) targetsMap.set('upstream', { ...(e.data || {}), id: e.rawId });
        }
        const sessTarget = c.targets.find((t) => t.collection === 'tokens');
        if (sessTarget) {
          const e = currentTargetKeyedMap.get(`${sessTarget.collection}:${sessTarget.id}`);
          if (e) targetsMap.set('tokens', { ...(e.data || {}), id: e.rawId });
        }
        const refreshTargets = c.targets.filter((t) => t.collection === 'refresh');
        for (const t of refreshTargets) {
          const e = currentTargetKeyedMap.get(`refresh:${t.id}`);
          if (e) {
            if (famData && (e.rawId === famData.activeRefreshId && e.data?.status === 'active')) {
              targetsMap.set('activeRefresh', { ...(e.data || {}), id: e.rawId });
            } else if (famData && (e.rawId !== famData.activeRefreshId && e.data?.status === 'consumed')) {
              targetsMap.set('prevRefresh', { ...(e.data || {}), id: e.rawId });
            }
          }
        }
        if (!targetsMap.has('activeRefresh')) {
          throw new CutoverFenceError(`Candidate ${c.id} missing active refresh target document matching activeRefreshId`);
        }
        if (famData && famData.previousRefreshToken && !targetsMap.has('prevRefresh')) {
          throw new CutoverFenceError(`Candidate ${c.id} has previousRefreshToken but missing prevRefresh target document`);
        }
        const retiredTargets = c.targets.filter((t) => t.collection === 'retiredRefreshTokens');
        const retiredIds = [];
        for (const t of retiredTargets) {
          const e = currentTargetKeyedMap.get(`retiredRefreshTokens:${t.id}`);
          if (!e) throw new CutoverFenceError(`Candidate ${c.id} missing retiredRefreshTokens target document in Firestore`);
          if (e.data?.familyId !== famData?.id) throw new CutoverFenceError(`Retired refresh token '${e.rawId}' familyId mismatch`);
          retiredIds.push(e.rawId);
        }
        targetsMap.set('retiredRefresh', { ids: retiredIds.sort(canonicalCompare) });
      } else if (c.kind === 'baseFormatTokens') {
        const famTarget = c.targets.find((t) => t.collection === 'families');
        if (famTarget) {
          const e = currentTargetKeyedMap.get(`${famTarget.collection}:${famTarget.id}`);
          if (e) targetsMap.set('families', { ...(e.data || {}), id: e.rawId });
        }
        const upTarget = c.targets.find((t) => t.collection === 'upstream');
        if (upTarget) {
          const e = currentTargetKeyedMap.get(`${upTarget.collection}:${upTarget.id}`);
          if (e) targetsMap.set('upstream', { ...(e.data || {}), id: e.rawId });
        }
        const sessTarget = c.targets.find((t) => t.collection === 'tokens');
        if (sessTarget) {
          const e = currentTargetKeyedMap.get(`${sessTarget.collection}:${sessTarget.id}`);
          if (e) targetsMap.set('tokens', { ...(e.data || {}), id: e.rawId });
        }
        const refTarget = c.targets.find((t) => t.collection === 'refresh');
        if (refTarget) {
          const e = currentTargetKeyedMap.get(`${refTarget.collection}:${refTarget.id}`);
          if (e) targetsMap.set('activeRefresh', { ...(e.data || {}), id: e.rawId });
        }
      } else if (c.kind === 'authCodes') {
        const codeTarget = c.targets.find((t) => t.collection === 'authCodes');
        if (codeTarget) {
          const e = currentTargetKeyedMap.get(`${codeTarget.collection}:${codeTarget.id}`);
          if (e) targetsMap.set('authCodes', { ...(e.data || {}), id: e.rawId });
        }
      } else if (c.kind === 'resumeTokens') {
        const resTarget = c.targets.find((t) => t.collection === 'resumeTokens');
        if (resTarget) {
          const e = currentTargetKeyedMap.get(`${resTarget.collection}:${resTarget.id}`);
          if (e) targetsMap.set('resumeTokens', { ...(e.data || {}), id: e.rawId });
        }
      } else if (c.kind === 'clients') {
        const clientTarget = c.targets.find((t) => t.collection === 'oauthClients' || t.collection === 'clients');
        if (clientTarget) {
          const e = currentTargetKeyedMap.get(`${clientTarget.collection}:${clientTarget.id}`);
          if (e) targetsMap.set('clients', { ...(e.data || {}), id: e.rawId });
        }
      }

      const targetResult = projectTargetLogical(c, targetsMap, codec);
      validateCandidateProjection(c.kind, r.candidateId, targetResult);
      const derivedTargetLogicalDigest = H(options.storeKey, 'logical-record', namespace, control.epoch, [c.kind, targetResult]);
      if (r.logicalDigest !== derivedTargetLogicalDigest) {
        throw new CutoverFenceError(
          `Receipt ${r.candidateId} logicalDigest mismatch with projector-derived target logical digest`,
        );
      }
    }
  }

  // Recompute and verify targetInventoryDigest from sorted exact descriptor objects
  const computedTargetInventory = computeTargetInventoryDigest(options.storeKey, namespace, control.epoch, targetDescriptors);
  if (finalDoc.targetInventoryDigest !== computedTargetInventory) {
    throw new CutoverFenceError('final manifest targetInventoryDigest does not match computed target inventory');
  }

  // Recompute and verify targetLogicalDigest
  const sortedReceiptLogicalPairs = actualReceipts
    .map((r) => [r.candidateId, r.logicalDigest])
    .sort((a, b) => canonicalCompare(a[0], b[0]));
  const computedTargetLogical = H(options.storeKey, 'logical-inventory', namespace, control.epoch, sortedReceiptLogicalPairs);
  if (finalDoc.targetLogicalDigest !== computedTargetLogical) {
    throw new CutoverFenceError('final manifest targetLogicalDigest does not match computed logical inventory');
  }

  // Verify target collection counts match finalDoc
  for (const k of TARGET_COUNT_KEYS) {
    const actualCount = targetDocsByKey.get(k).length;
    if (actualCount !== finalDoc.targetCounts[k]) {
      throw new CutoverFenceError(
        `Target count mismatch on finalization for '${k}': Firestore has ${actualCount}, finalDoc has ${finalDoc.targetCounts[k]}`,
      );
    }
  }

  if (finalDoc.migrated !== writtenCount) {
    throw new CutoverFenceError(`migrated count mismatch: finalDoc has ${finalDoc.migrated}, receipts have ${writtenCount}`);
  }
  if (finalDoc.skipped !== retainedCount) {
    throw new CutoverFenceError(`skipped count mismatch: finalDoc has ${finalDoc.skipped}, receipts have ${retainedCount}`);
  }
  if (finalDoc.scanned !== finalDoc.migrated + finalDoc.skipped) {
    throw new CutoverFenceError('Cannot finalize migration: final scanned must equal migrated + skipped');
  }
  if (actualReceipts.length !== prep.scanned) {
    throw new CutoverFenceError(`receipts count (${actualReceipts.length}) does not equal scanned (${prep.scanned})`);
  }

  const computedReceiptSetDigest = computeReceiptSetDigest(actualReceipts, namespace, control.epoch);
  if (finalDoc.receiptSetDigest !== computedReceiptSetDigest) {
    throw new CutoverFenceError(
      `receiptSetDigest mismatch: expected ${finalDoc.receiptSetDigest}, computed ${computedReceiptSetDigest}`,
    );
  }

  for (const c of prep.candidateCommitments) {
    if (!receiptCandidateIds.has(c.id)) {
      throw new CutoverFenceError(`Missing receipt for committed candidate ${c.id}`);
    }
  }

  const finalRef = db.collection(`${namespace}_meta`).doc(`migration_manifest_${control.epoch}`);
  const markerRef = db.collection(`${namespace}_meta`).doc('v2_adopted');

  const finalSnap = await transaction.get(finalRef);
  if (finalSnap.exists && C(finalSnap.data()) !== C(finalDoc)) {
    throw new CutoverFenceError('Final manifest already exists with different content; immutable retry violation');
  }
  const markerSnap = await transaction.get(markerRef);
  if (markerSnap.exists && C(markerSnap.data()) !== C(markerDoc)) {
    throw new CutoverFenceError('Ownership marker already exists with different content; immutable retry violation');
  }

  transaction.set(finalRef, stripUndefined(finalDoc));
  transaction.set(markerRef, stripUndefined(markerDoc));

  const controlRef = getCutoverFenceDocRef(db, namespace);
  const updatedControl = {
    ...control,
    state: 'v3_ready',
    emptyNamespace: markerDoc.emptyNamespace,
    migrationManifestDigest: markerDoc.migrationManifestDigest,
    irreversible: markerDoc.emptyNamespace === true ? false : control.irreversible,
    updatedAt: markerDoc.adoptedAt,
  };
  transaction.set(controlRef, stripUndefined(updatedControl));
  return updatedControl;
}

export async function activateMigrationInTransaction(transaction, db, options) {
  const { namespace, expectedEpoch, migrationRunId, migrationManifestDigest, codeArtifact, protocolDigest } = options;
  assertSupportedCutoverNamespace(namespace);

  if (!options.storeKey || (typeof options.storeKey !== 'string' && !Buffer.isBuffer(options.storeKey) && !(options.storeKey instanceof Uint8Array))) {
    throw new CutoverFenceError('storeKey is REQUIRED for activateMigrationInTransaction');
  }

  const control = await readCutoverFenceInTransaction(transaction, db, namespace);

  // FieldPath adapter is REQUIRED (no __name__ fallback)
  const FieldPath = options.FieldPath;
  if (!FieldPath || typeof FieldPath.documentId !== 'function') {
    throw new CutoverFenceError('FieldPath with documentId() is REQUIRED for activateMigrationInTransaction');
  }
  const docIdField = FieldPath.documentId();

  // Idempotent retry check on full immutable chain only (never mutable data collections)
  if (control.state === 'v3_active') {
    if (control.epoch !== expectedEpoch) {
      throw new CutoverFenceError(`Activation epoch mismatch: expected ${expectedEpoch}, got ${control.epoch}`);
    }
    if (control.migrationRunId !== migrationRunId) {
      throw new CutoverFenceError(
        `Already active control migrationRunId mismatch: expected ${migrationRunId}, got ${control.migrationRunId}`,
      );
    }
    if (control.migrationManifestDigest !== migrationManifestDigest) {
      throw new CutoverFenceError(
        `Already active control migrationManifestDigest mismatch: expected ${migrationManifestDigest}, got ${control.migrationManifestDigest}`,
      );
    }
    if (control.codeArtifact !== codeArtifact) {
      throw new CutoverFenceError(
        `Already active control codeArtifact mismatch: expected ${codeArtifact}, got ${control.codeArtifact}`,
      );
    }

    const markerRef = db.collection(`${namespace}_meta`).doc('v2_adopted');
    const markerSnap = await transaction.get(markerRef);
    if (!markerSnap.exists) {
      throw new CutoverFenceError('Already active but immutable migration marker is missing at v2_adopted');
    }
    const m = markerSnap.data();
    const expectedMarkerKeys = m.emptyNamespace !== true
      ? [...REQUIRED_OWNERSHIP_MARKER_KEYS, ...NONEMPTY_PROJECTOR_KEYS]
      : REQUIRED_OWNERSHIP_MARKER_KEYS;
    validateMapKeysExact(m, expectedMarkerKeys, 'ownership marker');
    validateMigrationIdentityFields(m, namespace, expectedEpoch, migrationRunId);
    if (m.kind !== 'ownership') {
      throw new CutoverFenceError(`Already active marker kind must be 'ownership', got '${m.kind}'`);
    }
    if (m.codeArtifact !== codeArtifact || m.protocolDigest !== protocolDigest || m.migrationManifestDigest !== migrationManifestDigest) {
      throw new CutoverFenceError('Already active immutable marker evidence mismatch');
    }

    const finalRef = db.collection(`${namespace}_meta`).doc(`migration_manifest_${expectedEpoch}`);
    const finalSnap = await transaction.get(finalRef);
    if (!finalSnap.exists) {
      throw new CutoverFenceError(`Already active but immutable final manifest missing at migration_manifest_${expectedEpoch}`);
    }
    const f = finalSnap.data();
    const expectedFinalKeys = f.totalPhysicalRecords > 0
      ? [...REQUIRED_FINAL_MANIFEST_KEYS, ...NONEMPTY_PROJECTOR_KEYS]
      : REQUIRED_FINAL_MANIFEST_KEYS;
    validateMapKeysExact(f, expectedFinalKeys, 'final manifest');
    validateMigrationIdentityFields(f, namespace, expectedEpoch, migrationRunId);
    if (f.kind !== 'final') {
      throw new CutoverFenceError(`Already active final manifest kind must be 'final', got '${f.kind}'`);
    }
    if (f.codeArtifact !== codeArtifact || f.protocolDigest !== protocolDigest || D('final', namespace, expectedEpoch, f) !== migrationManifestDigest) {
      throw new CutoverFenceError('Already active immutable final manifest evidence mismatch');
    }

    const prepRef = db.collection(`${namespace}_meta`).doc(`migration_prepared_${expectedEpoch}`);
    const prepSnap = await transaction.get(prepRef);
    if (!prepSnap.exists) {
      throw new CutoverFenceError(`Already active but immutable prepared manifest missing at migration_prepared_${expectedEpoch}`);
    }
    const p = prepSnap.data();
    const expectedPrepKeys = p.totalPhysicalRecords > 0
      ? [...REQUIRED_PREPARED_MANIFEST_KEYS, ...NONEMPTY_PROJECTOR_KEYS]
      : REQUIRED_PREPARED_MANIFEST_KEYS;
    validateMapKeysExact(p, expectedPrepKeys, 'prepared manifest');
    validateMigrationIdentityFields(p, namespace, expectedEpoch, migrationRunId);
    if (p.kind !== 'prepared') {
      throw new CutoverFenceError(`Already active prep manifest kind must be 'prepared', got '${p.kind}'`);
    }
    if (D('prepared', namespace, expectedEpoch, p) !== f.preparedDigest) {
      throw new CutoverFenceError('Already active immutable prep manifest digest mismatch');
    }

    if (f.totalPhysicalRecords > 0) {
      if (m.projectorId !== f.projectorId || m.projectorVersion !== f.projectorVersion || m.projectorDigest !== f.projectorDigest) {
        throw new CutoverFenceError('Already active marker projector evidence mismatch with final manifest');
      }
      if (p.projectorId !== f.projectorId || p.projectorVersion !== f.projectorVersion || p.projectorDigest !== f.projectorDigest) {
        throw new CutoverFenceError('Already active prep projector evidence mismatch with final manifest');
      }
    }

    // Verify receipts range immutable chain
    const receiptsCol = db.collection(`${namespace}_meta`);
    const lowerBound = `migration_receipt_${expectedEpoch}_`;
    const upperBound = `migration_receipt_${expectedEpoch}\``;
    const receiptsSnap = await transaction.get(receiptsCol.orderBy(docIdField).startAt(lowerBound).endBefore(upperBound));
    if (receiptsSnap.size !== p.scanned) {
      throw new CutoverFenceError(`Already active receipts count (${receiptsSnap.size}) does not equal scanned count (${p.scanned})`);
    }
    const receipts = receiptsSnap.docs.map((d) => {
      const data = d.data();
      validateReceipt(data, namespace, expectedEpoch, migrationRunId);
      return data;
    });
    if (computeReceiptSetDigest(receipts, namespace, expectedEpoch) !== f.receiptSetDigest) {
      throw new CutoverFenceError('Already active immutable receiptSetDigest mismatch');
    }

    return { status: 'already_active', control };
  }

  const markerRef = db.collection(`${namespace}_meta`).doc('v2_adopted');
  const markerSnap = await transaction.get(markerRef);
  if (!markerSnap.exists) {
    throw new CutoverFenceError(`Cannot activate: marker missing at ${namespace}_meta/v2_adopted`);
  }
  const m = markerSnap.data();
  const expectedMarkerKeys = m.emptyNamespace !== true
    ? [...REQUIRED_OWNERSHIP_MARKER_KEYS, ...NONEMPTY_PROJECTOR_KEYS]
    : REQUIRED_OWNERSHIP_MARKER_KEYS;
  validateMapKeysExact(m, expectedMarkerKeys, 'ownership marker');
  validateMigrationIdentityFields(m, namespace, expectedEpoch, migrationRunId);
  if (m.kind !== 'ownership') {
    throw new CutoverFenceError(`marker kind must be 'ownership', got '${m.kind}'`);
  }
  if (m.codeArtifact !== codeArtifact) {
    throw new CutoverFenceError(`Cannot activate: marker codeArtifact mismatch: expected ${codeArtifact}, got ${m.codeArtifact}`);
  }
  if (m.protocolDigest !== protocolDigest) {
    throw new CutoverFenceError(`Cannot activate: marker protocolDigest mismatch: expected ${protocolDigest}, got ${m.protocolDigest}`);
  }
  if (m.migrationManifestDigest !== migrationManifestDigest) {
    throw new CutoverFenceError('Cannot activate: marker migrationManifestDigest mismatch');
  }

  const finalRef = db.collection(`${namespace}_meta`).doc(`migration_manifest_${expectedEpoch}`);
  const finalSnap = await transaction.get(finalRef);
  if (!finalSnap.exists) {
    throw new CutoverFenceError(`Cannot activate: final manifest missing at ${namespace}_meta/migration_manifest_${expectedEpoch}`);
  }
  const f = finalSnap.data();
  const expectedFinalKeys = f.totalPhysicalRecords > 0
    ? [...REQUIRED_FINAL_MANIFEST_KEYS, ...NONEMPTY_PROJECTOR_KEYS]
    : REQUIRED_FINAL_MANIFEST_KEYS;
  validateMapKeysExact(f, expectedFinalKeys, 'final manifest');
  validateMigrationIdentityFields(f, namespace, expectedEpoch, migrationRunId);
  if (f.kind !== 'final') {
    throw new CutoverFenceError(`Final manifest kind must be 'final', got '${f.kind}'`);
  }
  if (f.codeArtifact !== codeArtifact || f.protocolDigest !== protocolDigest) {
    throw new CutoverFenceError('Cannot activate: final manifest codeArtifact or protocolDigest mismatch');
  }
  const computedFinalDigest = D('final', namespace, expectedEpoch, f);
  if (computedFinalDigest !== migrationManifestDigest) {
    throw new CutoverFenceError(
      `Cannot activate: computed final digest (${computedFinalDigest}) does not match expected (${migrationManifestDigest})`,
    );
  }

  const prepRef = db.collection(`${namespace}_meta`).doc(`migration_prepared_${expectedEpoch}`);
  const prepSnap = await transaction.get(prepRef);
  if (!prepSnap.exists) {
    throw new CutoverFenceError(`Cannot activate: prepared manifest missing at ${namespace}_meta/migration_prepared_${expectedEpoch}`);
  }
  const p = prepSnap.data();
  const expectedPrepKeys = p.totalPhysicalRecords > 0
    ? [...REQUIRED_PREPARED_MANIFEST_KEYS, ...NONEMPTY_PROJECTOR_KEYS]
    : REQUIRED_PREPARED_MANIFEST_KEYS;
  validateMapKeysExact(p, expectedPrepKeys, 'prepared manifest');
  validateMigrationIdentityFields(p, namespace, expectedEpoch, migrationRunId);
  if (p.kind !== 'prepared') {
    throw new CutoverFenceError(`Prepared manifest kind must be 'prepared', got '${p.kind}'`);
  }
  const computedPrepDigest = D('prepared', namespace, expectedEpoch, p);
  if (computedPrepDigest !== f.preparedDigest) {
    throw new CutoverFenceError('Cannot activate: prepared digest does not match final manifest preparedDigest');
  }

  if (f.totalPhysicalRecords > 0) {
    if (m.projectorId !== f.projectorId || m.projectorVersion !== f.projectorVersion || m.projectorDigest !== f.projectorDigest) {
      throw new CutoverFenceError('Marker projector evidence mismatch with final manifest');
    }
    if (p.projectorId !== f.projectorId || p.projectorVersion !== f.projectorVersion || p.projectorDigest !== f.projectorDigest) {
      throw new CutoverFenceError('Prepared manifest projector evidence mismatch with final manifest');
    }
  }

  // Reread receipt set range in Firestore to verify readiness before activation
  const receiptsCol = db.collection(`${namespace}_meta`);
  const lowerBound = `migration_receipt_${expectedEpoch}_`;
  const upperBound = `migration_receipt_${expectedEpoch}\``;

  const receiptsQuery = receiptsCol.orderBy(docIdField).startAt(lowerBound).endBefore(upperBound);
  const receiptsSnap = await transaction.get(receiptsQuery);
  if (receiptsSnap.size !== p.scanned) {
    throw new CutoverFenceError(
      `Cannot activate: receipt count (${receiptsSnap.size}) does not equal prepared scanned count (${p.scanned})`,
    );
  }

  // Validate each receipt in range and recompute receiptSetDigest
  const activateReceipts = receiptsSnap.docs.map((d) => {
    const data = d.data();
    validateReceipt(data, namespace, expectedEpoch, migrationRunId);
    return data;
  });
  const computedRSD = computeReceiptSetDigest(activateReceipts, namespace, expectedEpoch);
  if (f.receiptSetDigest !== computedRSD) {
    throw new CutoverFenceError(
      `Cannot activate: receiptSetDigest mismatch in Firestore receipts`,
    );
  }

  // Query ALL 13 distinct collections using FieldPath.documentId()
  const distinctColNames = getCutoverDistinctCollectionNames(namespace).distinct;
  const rawColSnaps = new Map();

  for (const colName of distinctColNames) {
    const q = db.collection(colName).orderBy(docIdField);
    const snap = await transaction.get(q);
    rawColSnaps.set(colName, snap);
  }

  const targetPhysicalToKey = {
    [`${namespace}_refresh_families`]: 'families',
    [`${namespace}_sessions`]: 'tokens',
    [`${namespace}_refresh`]: 'refresh',
    [`${namespace}_upstream`]: 'upstream',
    [`${namespace}_auth_codes`]: 'authCodes',
    [`${namespace}_resume_tokens`]: 'resumeTokens',
    [`${namespace}_retired_refresh`]: 'retiredRefreshTokens',
    [`${namespace}_oauth_clients`]: 'oauthClients',
  };

  const targetDocsByKey = new Map();
  for (const k of TARGET_COUNT_KEYS) targetDocsByKey.set(k, []);

  for (const [physicalName, snap] of rawColSnaps.entries()) {
    if (physicalName in targetPhysicalToKey) {
      const colKey = targetPhysicalToKey[physicalName];
      const isOverlap = physicalName.endsWith('_auth_codes') || physicalName.endsWith('_resume_tokens') || physicalName.endsWith('_oauth_clients');
      if (isOverlap) {
        for (const d of snap.docs) {
          if (isTargetFormatRow(physicalName, d.data(), d.id)) {
            targetDocsByKey.get(colKey).push(d);
          }
        }
      } else {
        targetDocsByKey.set(colKey, snap.docs);
      }
    }
  }

  const currentTargetKeyedMap = new Map();
  for (const [colKey, docs] of targetDocsByKey.entries()) {
    for (const d of docs) {
      const data = d.data() || {};
      if (colKey !== 'oauthClients' && colKey !== 'clients') {
        if (typeof data.id === 'string' && data.id !== d.id) {
          throw new CutoverFenceError(`Document ID mismatch in ${colKey}/${d.id}: stored id '${data.id}' != docId '${d.id}'`);
        }
      } else {
        if (typeof data.client_id === 'string' && data.client_id !== d.id) {
          throw new CutoverFenceError(`client_id mismatch in ${colKey}/${d.id}: stored client_id '${data.client_id}' != docId '${d.id}'`);
        }
      }
      const targetId = computeKeyedDocId(options.storeKey, 'target-id', namespace, expectedEpoch, colKey, d.id);
      const recDigest = computeTargetRecordDigest(options.storeKey, namespace, expectedEpoch, colKey, targetId, data);
      currentTargetKeyedMap.set(`${colKey}:${targetId}`, { doc: d, rawId: d.id, recordDigest: recDigest, data: { ...data, id: d.id } });
    }
  }

  // Verify that all targets from receipts exist in target collections with matching postimage
  const expectedWrittenTargets = new Set();
  for (const r of activateReceipts) {
    for (const t of r.targetAfter) {
      const targetKey = `${t.collection}:${t.id}`;
      expectedWrittenTargets.add(targetKey);
      const entry = currentTargetKeyedMap.get(targetKey);
      if (!entry) {
        throw new CutoverFenceError(`Cannot activate: target document '${targetKey}' missing from Firestore`);
      }
      if (entry.recordDigest !== t.recordDigest) {
        throw new CutoverFenceError(`Cannot activate: target document '${targetKey}' postimage recordDigest mismatch`);
      }
    }
  }

  // Reject extra targets
  for (const targetKey of currentTargetKeyedMap.keys()) {
    if (!expectedWrittenTargets.has(targetKey)) {
      throw new CutoverFenceError(`Cannot activate: extra target document '${targetKey}' found in Firestore`);
    }
  }

  // Check target counts
  for (const k of TARGET_COUNT_KEYS) {
    const actualCount = targetDocsByKey.get(k).length;
    if (actualCount !== f.targetCounts[k]) {
      throw new CutoverFenceError(
        `Cannot activate: target count mismatch for '${k}': Firestore has ${actualCount}, finalDoc has ${f.targetCounts[k]}`,
      );
    }
  }

  // Verify readiness equations
  if (f.errors !== 0) {
    throw new CutoverFenceError('Cannot activate: final manifest errors must be 0');
  }
  for (const [rK, rV] of Object.entries(f.reasons)) {
    if (rV !== 0) {
      throw new CutoverFenceError(`Cannot activate: final manifest reason '${rK}' must be 0, got ${rV}`);
    }
  }
  if (f.sourceLogicalDigest !== f.targetLogicalDigest) {
    throw new CutoverFenceError('Cannot activate: sourceLogicalDigest must equal targetLogicalDigest');
  }
  if (C(f.targetCounts) !== C(p.expectedTargetCounts)) {
    throw new CutoverFenceError('Cannot activate: final targetCounts must match prepared expectedTargetCounts');
  }

  if (control.state !== 'v3_ready') {
    throw new CutoverFenceError(`Cannot activate migration: state must be 'v3_ready', got '${control.state}'`);
  }
  if (control.activeOperations !== 0) {
    throw new CutoverFenceError(`Cannot activate migration: activeOperations must be 0, got ${control.activeOperations}`);
  }
  if (control.emptyNamespace !== true && !control.irreversible) {
    throw new CutoverFenceError('Cannot activate migration: irreversible latch must be true for non-empty namespace');
  }
  if (control.epoch !== expectedEpoch) {
    throw new CutoverFenceError(`Activation epoch mismatch: expected ${expectedEpoch}, got ${control.epoch}`);
  }
  if (control.migrationRunId !== migrationRunId) {
    throw new CutoverFenceError(`Activation runId mismatch: expected ${migrationRunId}, got ${control.migrationRunId}`);
  }
  if (control.migrationManifestDigest !== migrationManifestDigest) {
    throw new CutoverFenceError(
      `Activation digest mismatch: expected ${migrationManifestDigest}, got ${control.migrationManifestDigest}`,
    );
  }

  const controlRef = getCutoverFenceDocRef(db, namespace);
  const updatedControl = {
    ...control,
    state: 'v3_active',
    epoch: control.epoch,
    emptyNamespace: control.emptyNamespace,
    irreversible: control.emptyNamespace === true ? false : control.irreversible,
    codeArtifact,
    codeSha: m.codeSha,
    updatedAt: Date.now(),
  };
  transaction.set(controlRef, stripUndefined(updatedControl));
  return { status: 'activated', control: updatedControl };
}

export function assertValidMigrationContext(options) {
  if (!options || typeof options !== 'object') {
    throw new CutoverFenceError('MigrationContext must be a non-null object');
  }
  const REQUIRED_CONTEXT_FIELDS = [
    'db',
    'FieldPath',
    'key',
    'namespace',
    'expectedEpoch',
    'migrationRunId',
    'codeSha',
    'codeArtifact',
    'packageIntegrity',
    'protocolDigest',
  ];
  for (const field of REQUIRED_CONTEXT_FIELDS) {
    if (options[field] === undefined || options[field] === null) {
      throw new CutoverFenceError(`MigrationContext missing required field: ${field}`);
    }
  }
  if (typeof options.db !== 'object' || typeof options.db.collection !== 'function' || typeof options.db.runTransaction !== 'function') {
    throw new CutoverFenceError('MigrationContext db must be a Firestore-like object with collection and runTransaction methods');
  }
  if (typeof options.FieldPath !== 'object' || typeof options.FieldPath.documentId !== 'function') {
    throw new CutoverFenceError('MigrationContext FieldPath must be an adapter object with documentId() method');
  }
  if (!Buffer.isBuffer(options.key) && !(options.key instanceof Uint8Array)) {
    throw new CutoverFenceError('MigrationContext key must be a Uint8Array or Buffer');
  }
  if (options.key.length < 16) {
    throw new CutoverFenceError('MigrationContext key must be at least 16 bytes');
  }
  assertSupportedCutoverNamespace(options.namespace);
  if (typeof options.expectedEpoch !== 'number' || !Number.isInteger(options.expectedEpoch) || options.expectedEpoch < 1) {
    throw new CutoverFenceError('MigrationContext expectedEpoch must be a positive integer');
  }
  if (typeof options.migrationRunId !== 'string' || !options.migrationRunId.trim()) {
    throw new CutoverFenceError('MigrationContext migrationRunId must be a non-empty string');
  }
  if (typeof options.codeSha !== 'string' || !/^[0-9a-f]{40}$/.test(options.codeSha)) {
    throw new CutoverFenceError('MigrationContext codeSha must be a 40-character lowercase hex string');
  }
  if (typeof options.codeArtifact !== 'string' || !options.codeArtifact.trim()) {
    throw new CutoverFenceError('MigrationContext codeArtifact must be a non-empty string');
  }
  if (typeof options.packageIntegrity !== 'string' || !options.packageIntegrity.trim()) {
    throw new CutoverFenceError('MigrationContext packageIntegrity must be a non-empty string');
  }
  if (typeof options.protocolDigest !== 'string' || !/^[0-9a-f]{64}$/.test(options.protocolDigest)) {
    throw new CutoverFenceError('MigrationContext protocolDigest must be a 64-character lowercase hex string');
  }
}


/* ========================================================================= */
/* S3 CANONICAL MIGRATION ENGINE & ROW ENCODERS                             */
/* ========================================================================= */

const ACCESS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function safeDocEntry(id, data) {
  return { ...(data || {}), id };
}

function compareDescriptors(a, b) {
  if (a.collection !== b.collection) return a.collection < b.collection ? -1 : 1;
  return codeUnitCompare(a.id, b.id);
}

function computeDocDepth(obj, currentDepth = 1) {
  if (!obj || typeof obj !== 'object' || obj instanceof Date) return currentDepth;
  let maxDepth = currentDepth;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      maxDepth = Math.max(maxDepth, computeDocDepth(item, currentDepth + 1));
    }
  } else {
    for (const val of Object.values(obj)) {
      maxDepth = Math.max(maxDepth, computeDocDepth(val, currentDepth + 1));
    }
  }
  return maxDepth;
}

function encodeSessionsRow(codec, accessId, familyId, rawData, logicalProjection, now) {
  const expiresAt = logicalProjection.expiresAt;
  const retainUntil = expiresAt + ACCESS_RETENTION_MS;
  const sealed = codec.seal({
    nsAccessToken: logicalProjection.nsAccessToken,
    nsUsername: logicalProjection.nsUsername,
  }, accessAad({ id: accessId, familyId }));
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

function encodeRefreshFamiliesRow(codec, familyId, generation, activeRefreshId, currentAccessTokenId, logicalProjection, retiredFingerprints, status, now) {
  const sealed = codec.seal({
    clientId: logicalProjection.clientId,
    serverBaseUrl: logicalProjection.serverBaseUrl,
    extra: logicalProjection.extra,
    retiredRefreshIds: retiredFingerprints,
  }, familyAad({ id: familyId, generation }));
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

function encodeUpstreamRow(codec, familyId, grantVersion, logicalProjection, now) {
  const sealed = codec.seal({
    nsRefreshToken: logicalProjection.upstream.nsRefreshToken,
  }, upstreamAad({ id: familyId, grantVersion }));
  return {
    id: familyId,
    grantVersion,
    nsExpiresAt: logicalProjection.upstream.nsExpiresAt,
    updatedAt: now,
    sealed,
    v: 2,
  };
}

function encodeRefreshRow(refreshId, familyId, generation, now) {
  return {
    id: refreshId,
    familyId,
    generation,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
}

function encodeAuthCodesRow(docId, rawData, logicalProjection, now) {
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

function encodeResumeTokensRow(docId, rawData, logicalProjection, now) {
  return {
    id: docId,
    clientId: logicalProjection.clientId,
    expiresAt: logicalProjection.expiresAt,
    ttlAt: logicalProjection.expiresAt,
    consumedAt: logicalProjection.consumedAt,
    createdAt: now,
  };
}

function encodeOAuthClientsRow(docId, rawData, logicalProjection, now) {
  return {
    client_id: docId,
    client_name: logicalProjection.clientName,
    redirect_uris: logicalProjection.redirectUris,
    token_endpoint_auth_method: logicalProjection.tokenEndpointAuthMethod,
    client_secret_hash: logicalProjection.clientSecretHash,
    updatedAt: now,
  };
}

export function extractCandidatesAndPlan(params) {
  const {
    sourceDocsByKey,
    storeKey,
    namespace,
    epoch,
    runId,
    codeSha,
    codeArtifact,
    packageIntegrity,
    protocolDigest,
    now,
  } = params;

  const codec = createCodec(storeKey);

  const physicalCounts = {};
  for (const k of PHYSICAL_COUNT_KEYS) physicalCounts[k] = 0;
  const classifications = {};
  for (const k of CLASSIFICATION_KEYS) classifications[k] = 0;
  const reasons = {};
  for (const k of REASON_KEYS) reasons[k] = 0;
  const expectedTargetCounts = {};
  for (const k of TARGET_COUNT_KEYS) expectedTargetCounts[k] = 0;

  for (const k of PHYSICAL_COUNT_KEYS) {
    physicalCounts[k] = (sourceDocsByKey.get(k) || []).length;
  }

  const familiesDocs = sourceDocsByKey.get('families') || [];
  const tokensDocs = sourceDocsByKey.get('tokens') || [];
  const refreshDocs = sourceDocsByKey.get('refresh') || [];
  const upstreamDocs = sourceDocsByKey.get('upstream') || [];
  const authCodesDocs = sourceDocsByKey.get('authCodes') || [];
  const resumeDocs = sourceDocsByKey.get('resumeTokens') || [];
  const oauthClientsDocs = sourceDocsByKey.get('oauthClients') || [];
  const clientsDocs = sourceDocsByKey.get('clients') || [];

  const familiesById = new Map();
  for (const d of familiesDocs) familiesById.set(d.id, d.data() || {});
  const tokensById = new Map();
  for (const d of tokensDocs) tokensById.set(d.id, d.data() || {});
  const refreshById = new Map();
  for (const d of refreshDocs) refreshById.set(d.id, d.data() || {});
  const upstreamById = new Map();
  for (const d of upstreamDocs) upstreamById.set(d.id, d.data() || {});

  const candidates = [];
  const candidateCommitments = [];
  const claimedAccessIds = new Set();
  const claimedRefreshIds = new Set();
  const claimedRetiredFingerprints = new Set();

  // 1. Process families
  for (const famDoc of familiesDocs) {
    const familyId = famDoc.id;
    const famData = famDoc.data() || {};

    if (!upstreamById.has(familyId)) {
      reasons.missingUpstreamGrants++;
      continue;
    }
    const currentRefId = famData.currentRefreshToken;
    if (!currentRefId || !refreshById.has(currentRefId)) {
      reasons.missingRefreshPointers++;
      continue;
    }
    const curRefDoc = refreshById.get(currentRefId) || {};
    const curRefFamId = curRefDoc.familyId ?? curRefDoc.family_id;
    if (curRefFamId !== familyId || curRefDoc.status !== 'active') {
      reasons.malformedRecords++;
      continue;
    }
    if (claimedRefreshIds.has(currentRefId)) {
      reasons.conflictingClaims++;
      continue;
    }
    claimedRefreshIds.add(currentRefId);

    const accessId = famData.currentAccessToken ?? curRefDoc.token?.accessToken;
    if (!accessId || typeof accessId !== 'string' || !accessId.trim()) {
      reasons.missingAccessTokens++;
      continue;
    }
    if (claimedAccessIds.has(accessId)) {
      reasons.conflictingClaims++;
      continue;
    }
    claimedAccessIds.add(accessId);

    if (famData.previousRefreshToken) {
      const prevRefId = famData.previousRefreshToken;
      if (prevRefId === currentRefId || claimedRefreshIds.has(prevRefId)) {
        reasons.conflictingClaims++;
        continue;
      }
      claimedRefreshIds.add(prevRefId);
    }

    const rawRetired = Array.isArray(famData.retiredRefreshFingerprints)
      ? famData.retiredRefreshFingerprints
      : (Array.isArray(famData.retiredTokens) ? famData.retiredTokens : []);
    const retiredFingerprints = Array.from(new Set(rawRetired.filter((fp) => typeof fp === 'string' && fp.length > 0)));

    let retiredConflict = false;
    for (const fp of retiredFingerprints) {
      if (claimedRetiredFingerprints.has(fp)) {
        reasons.conflictingClaims++;
        retiredConflict = true;
        break;
      }
      claimedRetiredFingerprints.add(fp);
    }
    if (retiredConflict) continue;

    const newAccessId = codec.id('session', accessId);
    const newRefreshId = codec.id('refresh', currentRefId);

    const candSources = [
      {
        collection: 'families',
        id: computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'families', familyId),
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, 'families', computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'families', familyId), famData),
      },
      {
        collection: 'refresh',
        id: computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'refresh', currentRefId),
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, 'refresh', computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'refresh', currentRefId), curRefDoc),
      },
      {
        collection: 'upstream',
        id: computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'upstream', familyId),
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, 'upstream', computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'upstream', familyId), upstreamById.get(familyId)),
      },
      {
        collection: 'tokens',
        id: computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'tokens', accessId),
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, 'tokens', computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'tokens', accessId), tokensById.get(accessId) || {}),
      },
    ];

    if (famData.previousRefreshToken) {
      const prevId = famData.previousRefreshToken;
      const prevDoc = refreshById.get(prevId) || {};
      candSources.push({
        collection: 'refresh',
        id: computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'refresh', prevId),
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, 'refresh', computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'refresh', prevId), prevDoc),
      });
    }

    candSources.sort(compareDescriptors);

    const candTargets = [
      { collection: 'families', id: computeKeyedDocId(storeKey, 'target-id', namespace, epoch, 'families', familyId) },
      { collection: 'tokens', id: computeKeyedDocId(storeKey, 'target-id', namespace, epoch, 'tokens', newAccessId) },
      { collection: 'refresh', id: computeKeyedDocId(storeKey, 'target-id', namespace, epoch, 'refresh', newRefreshId) },
      { collection: 'upstream', id: computeKeyedDocId(storeKey, 'target-id', namespace, epoch, 'upstream', familyId) },
    ];
    if (famData.previousRefreshToken) {
      const prevRefTargetId = codec.id('refresh', famData.previousRefreshToken);
      candTargets.push({ collection: 'refresh', id: computeKeyedDocId(storeKey, 'target-id', namespace, epoch, 'refresh', prevRefTargetId) });
    }
    for (const fp of retiredFingerprints) {
      candTargets.push({ collection: 'retiredRefreshTokens', id: computeKeyedDocId(storeKey, 'target-id', namespace, epoch, 'retiredRefreshTokens', fp) });
    }
    candTargets.sort(compareDescriptors);

    const sortedSourceIds = candSources.map((s) => s.id).sort(codeUnitCompare);
    const candidateId = computeCandidateId(storeKey, namespace, epoch, 'pr56Families', sortedSourceIds);

    const sourcesMap = new Map();
    sourcesMap.set('families', safeDocEntry(familyId, famData));
    sourcesMap.set('refresh', safeDocEntry(currentRefId, curRefDoc));
    sourcesMap.set('upstream', safeDocEntry(familyId, upstreamById.get(familyId)));
    sourcesMap.set('tokens', safeDocEntry(accessId, tokensById.get(accessId) || {}));
    if (famData.previousRefreshToken) {
      const prevId = famData.previousRefreshToken;
      sourcesMap.set('prevRefresh', safeDocEntry(prevId, refreshById.get(prevId) || {}));
    }

    const logicalProjection = projectSourceLogical(
      { id: candidateId, kind: 'pr56Families', sources: candSources, targets: candTargets, logicalDigest: '' },
      sourcesMap,
      codec,
    );
    const logicalDigest = computeCandidateLogicalDigest(storeKey, namespace, epoch, 'pr56Families', logicalProjection);

    const generation = typeof famData.generation === 'number' ? famData.generation : 1;
    const grantVersion = typeof upstreamById.get(familyId)?.grantVersion === 'number' ? upstreamById.get(familyId).grantVersion : 1;

    const famRow = encodeRefreshFamiliesRow(codec, familyId, generation, newRefreshId, newAccessId, logicalProjection, retiredFingerprints, famData.status, now);
    const upRow = encodeUpstreamRow(codec, familyId, grantVersion, logicalProjection, now);
    const refRow = encodeRefreshRow(newRefreshId, familyId, generation, now);
    const accRow = encodeSessionsRow(codec, newAccessId, familyId, famData, logicalProjection, now);

    const targetDocsMap = new Map();
    targetDocsMap.set('refreshFamilies', famRow);
    targetDocsMap.set('upstreamGrants', upRow);
    targetDocsMap.set('refreshTokens', refRow);
    targetDocsMap.set('sessions', accRow);

    const targetPostimageByTargetId = new Map();
    targetPostimageByTargetId.set(candTargets[0].id, famRow);
    targetPostimageByTargetId.set(candTargets[1].id, accRow);
    targetPostimageByTargetId.set(candTargets[2].id, refRow);
    targetPostimageByTargetId.set(candTargets[3].id, upRow);

    if (famData.previousRefreshToken) {
      const prevRefreshId = codec.id('refresh', famData.previousRefreshToken);
      const prevRefDoc = refreshById.get(famData.previousRefreshToken) || {};
      const prevRefreshRow = {
        id: prevRefreshId,
        familyId,
        status: 'consumed',
        generation: Math.max(1, generation - 1),
        consumedAt: prevRefDoc.consumedAt || now,
        successorSealed: codec.seal({ accessToken: accessId, refreshToken: currentRefId }, `successor:${prevRefreshId}`),
      };
      targetDocsMap.set('prevRefreshTokens', prevRefreshRow);
      const prevTgtId = computeKeyedDocId(storeKey, 'target-id', namespace, epoch, 'refresh', prevRefreshId);
      targetPostimageByTargetId.set(prevTgtId, prevRefreshRow);
    }

    for (const fp of retiredFingerprints) {
      const retRow = {
        fingerprint: fp,
        familyId,
        retiredAt: now,
      };
      const retTgtId = computeKeyedDocId(storeKey, 'target-id', namespace, epoch, 'retiredRefreshTokens', fp);
      targetPostimageByTargetId.set(retTgtId, retRow);
    }

    // Verify logical projection equivalence
    const targetLogicalProjection = projectTargetLogical(
      { id: candidateId, kind: 'pr56Families', sources: candSources, targets: candTargets, logicalDigest: '' },
      targetDocsMap,
      codec,
    );
    if (C(logicalProjection) !== C(targetLogicalProjection)) {
      throw new CutoverFenceError(`Logical projection equivalence check failed for candidate ${candidateId}`);
    }

    // Order postimages strictly matching candTargets order
    const prospectiveTargetPostimages = candTargets.map((t) => {
      const post = targetPostimageByTargetId.get(t.id);
      if (!post) throw new CutoverFenceError(`Missing prospective target postimage for target ${t.collection}:${t.id}`);
      return post;
    });

    expectedTargetCounts.families++;
    expectedTargetCounts.tokens++;
    expectedTargetCounts.refresh++;
    expectedTargetCounts.upstream++;
    if (famData.previousRefreshToken) expectedTargetCounts.refresh++;
    expectedTargetCounts.retiredRefreshTokens += retiredFingerprints.length;

    classifications.pr56Families++;

    const candCommitment = {
      id: candidateId,
      kind: 'pr56Families',
      sources: candSources,
      targets: candTargets,
      logicalDigest,
    };
    candidateCommitments.push(candCommitment);

    candidates.push({
      id: candidateId,
      kind: 'pr56Families',
      sources: candSources,
      targets: candTargets,
      logicalDigest,
      prospectiveTargetPostimages,
      sourceActions: candSources.map((s) => ({ collection: s.collection, id: s.id, action: 'delete' })),
      targetRows: {
        refreshFamilies: famRow,
        upstreamGrants: upRow,
        refreshTokens: refRow,
        sessions: accRow,
      },
    });
  }

  // 2. Process auth_codes
  for (const codeDoc of authCodesDocs) {
    const codeId = codeDoc.id;
    const cData = codeDoc.data() || {};
    const candSources = [
      {
        collection: 'authCodes',
        id: computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'authCodes', codeId),
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, 'authCodes', computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'authCodes', codeId), cData),
      },
    ];
    const candTargets = [
      { collection: 'authCodes', id: computeKeyedDocId(storeKey, 'target-id', namespace, epoch, 'authCodes', codeId) },
    ];
    const sortedSourceIds = candSources.map((s) => s.id).sort(codeUnitCompare);
    const candidateId = computeCandidateId(storeKey, namespace, epoch, 'authCodes', sortedSourceIds);

    const sourcesMap = new Map();
    sourcesMap.set('authCodes', safeDocEntry(codeId, cData));

    const logicalProjection = projectSourceLogical(
      { id: candidateId, kind: 'authCodes', sources: candSources, targets: candTargets, logicalDigest: '' },
      sourcesMap,
      codec,
    );
    const logicalDigest = computeCandidateLogicalDigest(storeKey, namespace, epoch, 'authCodes', logicalProjection);

    const codeRow = encodeAuthCodesRow(codeId, cData, logicalProjection, now);
    const prospectiveTargetPostimages = [codeRow];

    const targetDocsMap = new Map();
    targetDocsMap.set('authCodes', codeRow);
    const targetLogicalProjection = projectTargetLogical(
      { id: candidateId, kind: 'authCodes', sources: candSources, targets: candTargets, logicalDigest: '' },
      targetDocsMap,
      codec,
    );
    if (C(logicalProjection) !== C(targetLogicalProjection)) {
      throw new CutoverFenceError(`Logical projection equivalence check failed for authCode ${candidateId}`);
    }

    expectedTargetCounts.authCodes++;
    classifications.authCodes++;

    candidateCommitments.push({
      id: candidateId,
      kind: 'authCodes',
      sources: candSources,
      targets: candTargets,
      logicalDigest,
    });

    candidates.push({
      id: candidateId,
      kind: 'authCodes',
      sources: candSources,
      targets: candTargets,
      logicalDigest,
      prospectiveTargetPostimages,
      sourceActions: [{ collection: 'authCodes', id: candSources[0].id, action: 'replace' }],
      targetRows: { authCodes: codeRow },
    });
  }

  // 3. Process resume_tokens
  for (const resDoc of resumeDocs) {
    const resId = resDoc.id;
    const rData = resDoc.data() || {};
    const candSources = [
      {
        collection: 'resumeTokens',
        id: computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'resumeTokens', resId),
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, 'resumeTokens', computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'resumeTokens', resId), rData),
      },
    ];
    const candTargets = [
      { collection: 'resumeTokens', id: computeKeyedDocId(storeKey, 'target-id', namespace, epoch, 'resumeTokens', resId) },
    ];
    const sortedSourceIds = candSources.map((s) => s.id).sort(codeUnitCompare);
    const candidateId = computeCandidateId(storeKey, namespace, epoch, 'resumeTokens', sortedSourceIds);

    const sourcesMap = new Map();
    sourcesMap.set('resumeTokens', safeDocEntry(resId, rData));

    const logicalProjection = projectSourceLogical(
      { id: candidateId, kind: 'resumeTokens', sources: candSources, targets: candTargets, logicalDigest: '' },
      sourcesMap,
      codec,
    );
    const logicalDigest = computeCandidateLogicalDigest(storeKey, namespace, epoch, 'resumeTokens', logicalProjection);

    const resRow = encodeResumeTokensRow(resId, rData, logicalProjection, now);
    const prospectiveTargetPostimages = [resRow];

    const targetDocsMap = new Map();
    targetDocsMap.set('resumeTokens', resRow);
    const targetLogicalProjection = projectTargetLogical(
      { id: candidateId, kind: 'resumeTokens', sources: candSources, targets: candTargets, logicalDigest: '' },
      targetDocsMap,
      codec,
    );
    if (C(logicalProjection) !== C(targetLogicalProjection)) {
      throw new CutoverFenceError(`Logical projection equivalence check failed for resumeToken ${candidateId}`);
    }

    expectedTargetCounts.resumeTokens++;
    classifications.resumeTokens++;

    candidateCommitments.push({
      id: candidateId,
      kind: 'resumeTokens',
      sources: candSources,
      targets: candTargets,
      logicalDigest,
    });

    candidates.push({
      id: candidateId,
      kind: 'resumeTokens',
      sources: candSources,
      targets: candTargets,
      logicalDigest,
      prospectiveTargetPostimages,
      sourceActions: [{ collection: 'resumeTokens', id: candSources[0].id, action: 'replace' }],
      targetRows: { resumeTokens: resRow },
    });
  }

  // 4. Process oauth_clients / clients
  const clientDocsMap = new Map();
  for (const doc of clientsDocs) clientDocsMap.set(doc.id, doc.data() || {});
  for (const doc of oauthClientsDocs) clientDocsMap.set(doc.id, doc.data() || {});

  for (const [clientId, cData] of clientDocsMap.entries()) {
    const candSources = [
      {
        collection: 'oauthClients',
        id: computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'oauthClients', clientId),
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, 'oauthClients', computeKeyedDocId(storeKey, 'source-id', namespace, epoch, 'oauthClients', clientId), cData),
      },
    ];
    const candTargets = [
      { collection: 'oauthClients', id: computeKeyedDocId(storeKey, 'target-id', namespace, epoch, 'oauthClients', clientId) },
    ];
    const sortedSourceIds = candSources.map((s) => s.id).sort(codeUnitCompare);
    const candidateId = computeCandidateId(storeKey, namespace, epoch, 'clients', sortedSourceIds);

    const sourcesMap = new Map();
    sourcesMap.set('clients', safeDocEntry(clientId, cData));

    const logicalProjection = projectSourceLogical(
      { id: candidateId, kind: 'clients', sources: candSources, targets: candTargets, logicalDigest: '' },
      sourcesMap,
      codec,
    );
    const logicalDigest = computeCandidateLogicalDigest(storeKey, namespace, epoch, 'clients', logicalProjection);

    const clientRow = encodeOAuthClientsRow(clientId, cData, logicalProjection, now);
    const prospectiveTargetPostimages = [clientRow];

    const targetDocsMap = new Map();
    targetDocsMap.set('oauthClients', clientRow);
    const targetLogicalProjection = projectTargetLogical(
      { id: candidateId, kind: 'clients', sources: candSources, targets: candTargets, logicalDigest: '' },
      targetDocsMap,
      codec,
    );
    if (C(logicalProjection) !== C(targetLogicalProjection)) {
      throw new CutoverFenceError(`Logical projection equivalence check failed for client ${candidateId}`);
    }

    expectedTargetCounts.oauthClients++;
    classifications.clients++;

    candidateCommitments.push({
      id: candidateId,
      kind: 'clients',
      sources: candSources,
      targets: candTargets,
      logicalDigest,
    });

    candidates.push({
      id: candidateId,
      kind: 'clients',
      sources: candSources,
      targets: candTargets,
      logicalDigest,
      prospectiveTargetPostimages,
      sourceActions: [{ collection: 'oauthClients', id: candSources[0].id, action: 'replace' }],
      targetRows: { oauthClients: clientRow },
    });
  }

  // Source logical digest
  candidateCommitments.sort((a, b) => codeUnitCompare(a.id, b.id));
  const sourceLogicalItems = candidateCommitments.map((c) => [c.id, c.logicalDigest]);
  const sourceLogicalDigest = computeLogicalInventoryDigest(storeKey, namespace, epoch, sourceLogicalItems);

  // Source descriptors
  const allSourceDescriptors = [];
  for (const [colKey, docs] of sourceDocsByKey.entries()) {
    for (const d of docs) {
      const sourceId = computeKeyedDocId(storeKey, 'source-id', namespace, epoch, colKey, d.id);
      const recDigest = computeSourceRecordDigest(storeKey, namespace, epoch, colKey, sourceId, d.data() || {});
      allSourceDescriptors.push({ collection: colKey, id: sourceId, recordDigest: recDigest });
    }
  }
  allSourceDescriptors.sort(compareDescriptors);
  const sourceInventoryDigest = computeSourceInventoryDigest(storeKey, namespace, epoch, allSourceDescriptors);

  // Construct CompleteMigrationPlan
  const totalPhysicalRecords = Object.values(physicalCounts).reduce((a, b) => a + b, 0);

  const prepared = {
    schemaVersion: 2,
    namespace,
    epoch,
    migrationRunId: runId,
    codeSha,
    codeArtifact,
    packageIntegrity,
    protocolDigest,
    kind: 'prepared',
    preparedAt: now,
    physicalCounts,
    classifications,
    reasons,
    totalPhysicalRecords,
    scanned: candidateCommitments.length,
    expectedTargetCounts,
    sourceInventoryDigest,
    sourceLogicalDigest,
    candidateCommitments,
    ...(totalPhysicalRecords > 0 ? {
      projectorId: PROJECTOR_ID,
      projectorVersion: PROJECTOR_VERSION,
      projectorDigest: protocolDigest,
    } : {}),
  };

  const preparation = {
    estimatedCommitBytes: Math.max(100, computeEstimatedFirestoreDocSize(prepared) + 200),
    estimatedReadDurationMs: 100,
  };

  const items = candidates.map((c) => {
    const receiptUpperBound = {
      schemaVersion: 2,
      namespace,
      epoch,
      migrationRunId: runId,
      codeSha,
      codeArtifact,
      packageIntegrity,
      protocolDigest,
      kind: 'receipt',
      preparedDigest: '0'.repeat(64),
      candidateId: c.id,
      candidateDigest: '0'.repeat(64),
      disposition: 'written',
      sourceAfter: c.sources.map((s) => ({ collection: s.collection, id: s.id, recordDigest: s.recordDigest })),
      targetAfter: c.targets.map((t) => ({ collection: t.collection, id: t.id, recordDigest: '0'.repeat(64) })),
      logicalDigest: c.logicalDigest,
      completedAt: now,
    };

    const targetPostimages = c.prospectiveTargetPostimages || [];
    let itemCommitBytes = computeEstimatedFirestoreDocSize(receiptUpperBound);
    for (const post of targetPostimages) {
      itemCommitBytes += computeEstimatedFirestoreDocSize(post);
    }

    return {
      candidateId: c.id,
      sourceReferences: c.sources.map((s) => ({ collection: s.collection, id: s.id })),
      targetReferences: c.targets.map((t) => ({ collection: t.collection, id: t.id })),
      prospectiveTargetPostimages: targetPostimages,
      sourceActions: c.sourceActions,
      receiptUpperBound,
      transaction: {
        estimatedCommitBytes: Math.max(100, itemCommitBytes),
        estimatedReadDurationMs: 50,
      },
    };
  });

  const finalUpperBound = {
    ...prepared,
    kind: 'final',
    completedAt: now,
    targetCounts: expectedTargetCounts,
    migrated: candidateCommitments.length,
    skipped: 0,
    errors: 0,
    targetInventoryDigest: '0'.repeat(64),
    targetLogicalDigest: sourceLogicalDigest,
    receiptSetDigest: '0'.repeat(64),
  };

  const markerUpperBound = {
    schemaVersion: 2,
    namespace,
    epoch,
    migrationRunId: runId,
    codeSha,
    codeArtifact,
    packageIntegrity,
    protocolDigest,
    kind: 'ownership',
    adoptedAt: now,
    migrationManifestDigest: '0'.repeat(64),
    sourceInventoryDigest,
    targetInventoryDigest: '0'.repeat(64),
    scanned: candidateCommitments.length,
    migrated: candidateCommitments.length,
    skipped: 0,
    errors: 0,
    targetCounts: expectedTargetCounts,
    ...(totalPhysicalRecords > 0 ? {
      projectorId: PROJECTOR_ID,
      projectorVersion: PROJECTOR_VERSION,
      projectorDigest: protocolDigest,
    } : {}),
  };

  const controlUpperBound = {
    schemaVersion: 2,
    namespace,
    epoch,
    state: 'v3_ready',
    activeOperations: 0,
    irreversible: totalPhysicalRecords > 0,
    emptyNamespace: totalPhysicalRecords === 0,
    migrationRunId: runId,
    migrationManifestDigest: '0'.repeat(64),
    codeSha,
    codeArtifact,
    updatedAt: now,
  };

  const finalization = {
    finalUpperBound,
    markerUpperBound,
    controlUpperBound,
    transaction: {
      estimatedCommitBytes: Math.max(100, computeEstimatedFirestoreDocSize(finalUpperBound) + computeEstimatedFirestoreDocSize(markerUpperBound) + computeEstimatedFirestoreDocSize(controlUpperBound)),
      estimatedReadDurationMs: 200,
    },
  };

  const activationControlUpperBound = {
    ...controlUpperBound,
    state: 'v3_active',
  };

  const activation = {
    controlUpperBound: activationControlUpperBound,
    transaction: {
      estimatedCommitBytes: Math.max(100, computeEstimatedFirestoreDocSize(activationControlUpperBound)),
      estimatedReadDurationMs: 100,
    },
  };

  const plan = {
    prepared,
    preparation,
    items,
    finalization,
    activation,
  };

  // Validate complete plan against 80% limits!
  validateCompleteMigrationPlan(plan);

  return {
    candidates,
    candidateCommitments,
    sourceInventoryDigest,
    sourceLogicalDigest,
    physicalCounts,
    expectedTargetCounts,
    plan,
  };
}

function computePreflightSummaryFromPlan(plan, sourceInventoryDigest) {
  let estimatedFirestoreSize = computeEstimatedFirestoreDocSize(plan.prepared);
  let depth = computeDocDepth(plan.prepared);
  let indexEntries = countIndexMetrics(plan.prepared).entries;
  let indexBytes = countIndexMetrics(plan.prepared).bytes;

  for (const item of plan.items) {
    estimatedFirestoreSize += computeEstimatedFirestoreDocSize(item.receiptUpperBound);
    depth = Math.max(depth, computeDocDepth(item.receiptUpperBound));
    indexEntries += countIndexMetrics(item.receiptUpperBound).entries;
    indexBytes += countIndexMetrics(item.receiptUpperBound).bytes;

    for (const post of item.prospectiveTargetPostimages) {
      estimatedFirestoreSize += computeEstimatedFirestoreDocSize(post);
      depth = Math.max(depth, computeDocDepth(post));
      indexEntries += countIndexMetrics(post).entries;
      indexBytes += countIndexMetrics(post).bytes;
    }
  }

  estimatedFirestoreSize += computeEstimatedFirestoreDocSize(plan.finalization.finalUpperBound);
  estimatedFirestoreSize += computeEstimatedFirestoreDocSize(plan.finalization.markerUpperBound);
  depth = Math.max(depth, computeDocDepth(plan.finalization.finalUpperBound), computeDocDepth(plan.finalization.markerUpperBound));
  indexEntries += countIndexMetrics(plan.finalization.finalUpperBound).entries + countIndexMetrics(plan.finalization.markerUpperBound).entries;
  indexBytes += countIndexMetrics(plan.finalization.finalUpperBound).bytes + countIndexMetrics(plan.finalization.markerUpperBound).bytes;

  return {
    scanned: plan.items.length,
    sourceInventoryDigest,
    estimatedFirestoreSize,
    depth,
    indexEntries,
    indexBytes,
    readDeadlineMs: 16000,
  };
}

export async function inspectFirestoreLegacyMigration(options) {
  assertValidMigrationContext(options);
  const allowedKeys = new Set([
    'db',
    'FieldPath',
    'key',
    'namespace',
    'expectedEpoch',
    'migrationRunId',
    'codeSha',
    'codeArtifact',
    'packageIntegrity',
    'protocolDigest',
  ]);
  for (const k of Object.keys(options)) {
    if (!allowedKeys.has(k)) {
      throw new CutoverFenceError(`Unknown option '${k}' passed to inspectFirestoreLegacyMigration`);
    }
  }

  const { db, FieldPath, key, namespace, expectedEpoch, migrationRunId, codeSha, codeArtifact, packageIntegrity, protocolDigest } = options;
  const storeKey = key;
  const docIdField = FieldPath.documentId();

  return await db.runTransaction(async (transaction) => {
    const control = await readCutoverFenceInTransaction(transaction, db, namespace);
    if (control.epoch !== expectedEpoch) {
      throw new CutoverFenceError(`Epoch mismatch in inspect: expected ${expectedEpoch}, got ${control.epoch}`);
    }

    const { source: sourceNames, target: targetNames } = getCutoverDistinctCollectionNames(namespace);
    const distinctColNames = Array.from(new Set([...Object.values(sourceNames), ...Object.values(targetNames)])).sort();

    const sourceDocsByKey = new Map();
    for (const k of PHYSICAL_COUNT_KEYS) sourceDocsByKey.set(k, []);
    const targetDocsByKey = new Map();
    for (const k of TARGET_COUNT_KEYS) targetDocsByKey.set(k, []);

    const sourcePhysicalToKey = {};
    for (const [k, name] of Object.entries(sourceNames)) sourcePhysicalToKey[name] = k;
    const targetPhysicalToKey = {};
    for (const [k, name] of Object.entries(targetNames)) targetPhysicalToKey[name] = k;

    for (const colName of distinctColNames) {
      const q = db.collection(colName).orderBy(docIdField);
      const snap = await transaction.get(q);
      const isSourceCol = colName in sourcePhysicalToKey;
      const isTargetCol = colName in targetPhysicalToKey;

      if (isSourceCol && !isTargetCol) {
        const colKey = sourcePhysicalToKey[colName];
        sourceDocsByKey.set(colKey, snap.docs);
      } else if (isTargetCol && !isSourceCol) {
        const colKey = targetPhysicalToKey[colName];
        targetDocsByKey.set(colKey, snap.docs);
      } else if (isSourceCol && isTargetCol) {
        const srcKey = sourcePhysicalToKey[colName];
        const tgtKey = targetPhysicalToKey[colName];
        const sDocs = [];
        const tDocs = [];
        for (const doc of snap.docs) {
          const data = doc.data() || {};
          if (isTargetFormatRow(tgtKey, data, doc.id)) {
            tDocs.push(doc);
          } else {
            sDocs.push(doc);
          }
        }
        sourceDocsByKey.set(srcKey, sDocs);
        targetDocsByKey.set(tgtKey, tDocs);
      }
    }

    const { candidates, sourceInventoryDigest, expectedTargetCounts, plan } = extractCandidatesAndPlan({
      sourceDocsByKey,
      storeKey,
      namespace,
      epoch: control.epoch,
      runId: migrationRunId,
      codeSha,
      codeArtifact,
      packageIntegrity,
      protocolDigest,
      now: Date.now(),
    });

    const preflight = computePreflightSummaryFromPlan(plan, sourceInventoryDigest);
    const prospectiveWritten = Object.values(expectedTargetCounts).reduce((a, b) => a + b, 0);

    return {
      sourceInventoryDigest,
      scanned: candidates.length,
      prospectiveWritten,
      prospectiveRetained: 0,
      preflight,
    };
  });
}

export async function adoptFirestoreLegacyTokens(options) {
  assertValidMigrationContext(options);
  const allowedKeys = new Set([
    'db',
    'FieldPath',
    'key',
    'namespace',
    'expectedEpoch',
    'migrationRunId',
    'codeSha',
    'codeArtifact',
    'packageIntegrity',
    'protocolDigest',
    'dryRun',
    'expectedSourceInventoryDigest',
  ]);
  for (const k of Object.keys(options)) {
    if (!allowedKeys.has(k)) {
      throw new CutoverFenceError(`Unknown option '${k}' passed to adoptFirestoreLegacyTokens`);
    }
  }

  if (typeof options.dryRun !== 'boolean') {
    throw new CutoverFenceError('adoptFirestoreLegacyTokens requires boolean dryRun option');
  }
  if (typeof options.expectedSourceInventoryDigest !== 'string' || !/^[0-9a-f]{64}$/.test(options.expectedSourceInventoryDigest)) {
    throw new CutoverFenceError('adoptFirestoreLegacyTokens requires 64-character lowercase hex expectedSourceInventoryDigest');
  }

  const { db, FieldPath, key, namespace, expectedEpoch, migrationRunId, codeSha, codeArtifact, packageIntegrity, protocolDigest, dryRun, expectedSourceInventoryDigest } = options;
  const storeKey = key;
  const docIdField = FieldPath.documentId();

  // Phase 1: Preparation in transaction
  const prepResult = await db.runTransaction(async (transaction) => {
    const control = await readCutoverFenceInTransaction(transaction, db, namespace);
    if (control.epoch !== expectedEpoch) {
      throw new CutoverFenceError(`Epoch mismatch in adopt: expected ${expectedEpoch}, got ${control.epoch}`);
    }
    if (control.state !== 'fenced') {
      throw new CutoverRefusedError(`Cannot adopt: cutover state is '${control.state}', expected 'fenced'`, {
        cutoverState: control.state,
        epoch: control.epoch,
      });
    }

    const { source: sourceNames, target: targetNames } = getCutoverDistinctCollectionNames(namespace);
    const distinctColNames = Array.from(new Set([...Object.values(sourceNames), ...Object.values(targetNames)])).sort();

    const sourceDocsByKey = new Map();
    for (const k of PHYSICAL_COUNT_KEYS) sourceDocsByKey.set(k, []);

    const sourcePhysicalToKey = {};
    for (const [k, name] of Object.entries(sourceNames)) sourcePhysicalToKey[name] = k;
    const targetPhysicalToKey = {};
    for (const [k, name] of Object.entries(targetNames)) targetPhysicalToKey[name] = k;

    for (const colName of distinctColNames) {
      const q = db.collection(colName).orderBy(docIdField);
      const snap = await transaction.get(q);
      const isSourceCol = colName in sourcePhysicalToKey;
      const isTargetCol = colName in targetPhysicalToKey;

      if (isSourceCol && !isTargetCol) {
        const colKey = sourcePhysicalToKey[colName];
        sourceDocsByKey.set(colKey, snap.docs);
      } else if (isSourceCol && isTargetCol) {
        const srcKey = sourcePhysicalToKey[colName];
        const tgtKey = targetPhysicalToKey[colName];
        const sDocs = [];
        for (const doc of snap.docs) {
          const data = doc.data() || {};
          if (!isTargetFormatRow(tgtKey, data, doc.id)) {
            sDocs.push(doc);
          }
        }
        sourceDocsByKey.set(srcKey, sDocs);
      }
    }

    const { candidates, sourceInventoryDigest, plan } = extractCandidatesAndPlan({
      sourceDocsByKey,
      storeKey,
      namespace,
      epoch: control.epoch,
      runId: migrationRunId,
      codeSha,
      codeArtifact,
      packageIntegrity,
      protocolDigest,
      now: Date.now(),
    });

    if (sourceInventoryDigest !== expectedSourceInventoryDigest) {
      throw new CutoverFenceError(
        `Source inventory digest mismatch: expected ${expectedSourceInventoryDigest}, observed ${sourceInventoryDigest}`,
      );
    }

    if (dryRun) {
      return {
        dryRun: true,
        scanned: candidates.length,
        migrated: 0,
        skipped: 0,
        errors: 0,
      };
    }

    // Write prepared manifest + transition control to migrating
    await prepareMigrationInTransaction(transaction, db, {
      namespace,
      prepDoc: plan.prepared,
      storeKey,
      FieldPath,
    });

    return {
      dryRun: false,
      candidates,
      plan,
    };
  });

  if (prepResult.dryRun) {
    return {
      scanned: prepResult.scanned,
      migrated: prepResult.migrated,
      skipped: prepResult.skipped,
      errors: prepResult.errors,
    };
  }

  const { candidates, plan } = prepResult;
  const now = Date.now();

  // Phase 2: Execute each item in its own transaction with receipt
  for (const itemPlan of plan.items) {
    const candidate = candidates.find((c) => c.id === itemPlan.candidateId);
    if (!candidate) throw new CutoverFenceError(`Candidate ${itemPlan.candidateId} missing from execution plan`);

    await db.runTransaction(async (transaction) => {
      const control = await readCutoverFenceInTransaction(transaction, db, namespace);
      if (control.state !== 'migrating') {
        throw new CutoverFenceError(`Cannot execute item: state must be 'migrating', got '${control.state}'`);
      }
      if (control.migrationRunId !== migrationRunId) {
        throw new CutoverFenceError('migrationRunId mismatch during item transaction');
      }

      // Write target documents
      if (candidate.kind === 'pr56Families') {
        const rows = candidate.targetRows;
        transaction.set(db.collection(`${namespace}_refresh_families`).doc(rows.refreshFamilies.id), rows.refreshFamilies);
        transaction.set(db.collection(`${namespace}_upstream`).doc(rows.upstreamGrants.id), rows.upstreamGrants);
        transaction.set(db.collection(`${namespace}_refresh`).doc(rows.refreshTokens.id), rows.refreshTokens);
        transaction.set(db.collection(`${namespace}_sessions`).doc(rows.sessions.id), rows.sessions);
      } else if (candidate.kind === 'authCodes') {
        transaction.set(db.collection(`${namespace}_auth_codes`).doc(candidate.targetRows.authCodes.code), candidate.targetRows.authCodes);
      } else if (candidate.kind === 'resumeTokens') {
        transaction.set(db.collection(`${namespace}_resume_tokens`).doc(candidate.targetRows.resumeTokens.id), candidate.targetRows.resumeTokens);
      } else if (candidate.kind === 'clients') {
        transaction.set(db.collection(`${namespace}_oauth_clients`).doc(candidate.targetRows.oauthClients.client_id), candidate.targetRows.oauthClients);
      }

      // Write receipt
      const receiptDoc = {
        schemaVersion: 2,
        namespace,
        epoch: control.epoch,
        migrationRunId,
        codeSha,
        codeArtifact,
        packageIntegrity,
        protocolDigest,
        kind: 'receipt',
        preparedDigest: D('manifest', namespace, control.epoch, plan.prepared),
        candidateId: candidate.id,
        candidateDigest: D('candidate', namespace, control.epoch, candidate),
        disposition: 'written',
        sourceAfter: candidate.sources.map((s) => ({ collection: s.collection, id: s.id, recordDigest: s.recordDigest })),
        targetAfter: candidate.targets.map((t) => ({ collection: t.collection, id: t.id, recordDigest: '0'.repeat(64) })),
        logicalDigest: candidate.logicalDigest,
        completedAt: now,
      };

      const receiptRef = db.collection(`${namespace}_meta`).doc('cutover_fence').collection('operations').doc(`receipt_${candidate.id}`);
      transaction.set(receiptRef, receiptDoc);
    });
  }

  // Phase 3: Finalization transaction
  await db.runTransaction(async (transaction) => {
    const finalDoc = {
      ...plan.prepared,
      kind: 'final',
      completedAt: Date.now(),
      targetCounts: plan.prepared.expectedTargetCounts,
      migrated: candidates.length,
      skipped: 0,
      errors: 0,
      targetInventoryDigest: '0'.repeat(64),
      targetLogicalDigest: plan.prepared.sourceLogicalDigest,
      receiptSetDigest: '0'.repeat(64),
    };

    const finalManifestDigest = D('manifest', namespace, expectedEpoch, finalDoc);

    const markerDoc = {
      schemaVersion: 2,
      namespace,
      epoch: expectedEpoch,
      migrationRunId,
      codeSha,
      codeArtifact,
      packageIntegrity,
      protocolDigest,
      kind: 'ownership',
      adoptedAt: Date.now(),
      migrationManifestDigest: finalManifestDigest,
      sourceInventoryDigest: plan.prepared.sourceInventoryDigest,
      targetInventoryDigest: '0'.repeat(64),
      scanned: candidates.length,
      migrated: candidates.length,
      skipped: 0,
      errors: 0,
      targetCounts: plan.prepared.expectedTargetCounts,
      ...(plan.prepared.totalPhysicalRecords > 0 ? {
        projectorId: PROJECTOR_ID,
        projectorVersion: PROJECTOR_VERSION,
        projectorDigest: protocolDigest,
      } : {}),
    };

    await finalizeMigrationInTransaction(transaction, db, {
      namespace,
      finalDoc,
      markerDoc,
      storeKey,
      FieldPath,
    });
  });

  return {
    scanned: candidates.length,
    migrated: candidates.length,
    skipped: 0,
    errors: 0,
  };
}

export async function activateFirestoreMigration(options) {
  assertValidMigrationContext(options);
  const allowedKeys = new Set([
    'db',
    'FieldPath',
    'key',
    'namespace',
    'expectedEpoch',
    'migrationRunId',
    'codeSha',
    'codeArtifact',
    'packageIntegrity',
    'protocolDigest',
    'migrationManifestDigest',
  ]);
  for (const k of Object.keys(options)) {
    if (!allowedKeys.has(k)) {
      throw new CutoverFenceError(`Unknown option '${k}' passed to activateFirestoreMigration`);
    }
  }

  if (typeof options.migrationManifestDigest !== 'string' || !/^[0-9a-f]{64}$/.test(options.migrationManifestDigest)) {
    throw new CutoverFenceError('activateFirestoreMigration requires 64-character lowercase hex migrationManifestDigest');
  }

  return await options.db.runTransaction(async (transaction) => {
    const res = await activateMigrationInTransaction(transaction, options.db, {
      ...options,
      storeKey: options.key,
    });
    return { status: res.status };
  });
}

