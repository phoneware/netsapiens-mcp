import { createCipheriv, createDecipheriv, createHmac, hkdfSync } from 'node:crypto';

export const PROJECTOR_ID = 'netsapiens-mcp/v2-v3-projector';
export const PROJECTOR_VERSION = 1;

export class CutoverFenceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CutoverFenceError';
    this.kitCode = 'cutover_fence_error';
  }
}

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

export function projectSourceLogical(candidate, sources, codec) {
  if (candidate.kind === 'pr56Families') {
    const famDoc = sources.get('families');
    if (!famDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing families source`);
    const famData = famDoc;
    const familyId = famData.id;
    const generation = typeof famData.generation === 'number' ? famData.generation : 1;

    const refDoc = sources.get('refresh');
    if (!refDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing active refresh source`);
    const curRefDoc = refDoc;
    const currentRefId = (curRefDoc.id ?? curRefDoc.refreshToken);

    const upDoc = sources.get('upstream');
    if (!upDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing upstream source`);
    const grant = ((upDoc.grant && typeof upDoc.grant === 'object') ? upDoc.grant : upDoc);

    const tokDoc = sources.get('tokens') || {};
    const accessId = (tokDoc.id ?? tokDoc.accessToken ?? famData.currentAccessToken);

    const newAccessId = codec.id('session', accessId);
    const newRefreshId = codec.id('refresh', currentRefId);

    let previousRefresh = null;
    if (famData.previousRefreshToken) {
      const prevId = famData.previousRefreshToken;
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
      ? famData.retiredRefreshFingerprints
      : (Array.isArray(famData.retiredTokens) ? famData.retiredTokens : []);
    const retiredFingerprints = Array.from(new Set(rawRetired.filter((fp) => typeof fp === 'string' && fp.length > 0))).sort(codeUnitCompare);

    const expiresAt = typeof tokDoc.expiresAt === 'number'
      ? tokDoc.expiresAt
      : (typeof curRefDoc.token?.expiresAt === 'number' ? curRefDoc.token.expiresAt : (famData.expiresAt ?? 0));

    return {
      familyId,
      generation,
      status: famData.status === 'revoked' ? 'revoked' : 'active',
      clientId: (curRefDoc.token?.clientId ?? tokDoc.clientId ?? famData.clientId ?? ''),
      serverBaseUrl: (curRefDoc.token?.serverBaseUrl ?? tokDoc.serverBaseUrl ?? famData.serverBaseUrl ?? null),
      extra: (curRefDoc.token?.extra ?? tokDoc.extra ?? {}),
      activeRefreshId: newRefreshId,
      currentAccessTokenId: newAccessId,
      previousRefresh,
      retiredRefreshFingerprints,
      upstream: {
        grantVersion: typeof upDoc.grantVersion === 'number' ? upDoc.grantVersion : 1,
        nsAccessToken: (grant.nsAccessToken ?? grant.access_token ?? tokDoc.nsAccessToken ?? ''),
        nsRefreshToken: (grant.nsRefreshToken ?? grant.refresh_token ?? tokDoc.nsRefreshToken ?? null),
        nsUsername: (grant.nsUsername ?? grant.username ?? tokDoc.nsUsername ?? ''),
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

    const expiresAt = typeof tokDoc.expiresAt === 'number' ? tokDoc.expiresAt : 0;

    return {
      familyId,
      generation: 1,
      status: 'active',
      clientId: (tokDoc.clientId ?? ''),
      serverBaseUrl: (tokDoc.serverBaseUrl ?? null),
      extra: (tokDoc.extra ?? (tokDoc.seatId ? { seatId: String(tokDoc.seatId) } : {})),
      activeRefreshId: refreshId,
      currentAccessTokenId: accessId,
      upstream: {
        grantVersion: 1,
        nsAccessToken: (tokDoc.nsAccessToken ?? ''),
        nsRefreshToken: (tokDoc.nsRefreshToken ?? null),
        nsUsername: (tokDoc.nsUsername ?? ''),
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

    return {
      codeId: hmacId,
      clientId: (rawPending.clientId ?? rawPending.client_id ?? codeDoc.clientId ?? codeDoc.client_id ?? ''),
      codeChallenge: (rawPending.codeChallenge ?? rawPending.code_challenge ?? ''),
      redirectUri: (rawPending.redirectUri ?? rawPending.redirect_uri ?? ''),
      createdAt: typeof rawPending.createdAt === 'number' ? rawPending.createdAt : (typeof rawPending.created_at === 'number' ? rawPending.created_at : 0),
      expiresAt: typeof codeDoc.expiresAt === 'number' ? codeDoc.expiresAt : (typeof codeDoc.expires_at === 'number' ? codeDoc.expires_at : 0),
      state: typeof rawPending.state === 'string' ? rawPending.state : null,
      scopes: Array.isArray(rawPending.scopes) ? [...rawPending.scopes].sort(codeUnitCompare) : [],
      nsAccessToken: (rawNsTokens?.access_token ?? rawNsTokens?.nsAccessToken ?? codeDoc.nsAccessToken ?? ''),
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
    const resumeId = (resDoc.id ?? '');
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
    const clientId = clientDoc.client_id ?? clientDoc.id;
    return {
      clientId,
      clientName: typeof clientDoc.client_name === 'string' ? clientDoc.client_name : null,
      clientSecret: typeof clientDoc.client_secret === 'string' ? clientDoc.client_secret : null,
      redirectUris: Array.isArray(clientDoc.redirect_uris) ? [...clientDoc.redirect_uris].sort(codeUnitCompare) : [],
      tokenEndpointAuthMethod: (clientDoc.token_endpoint_auth_method ?? 'none'),
      grantTypes: Array.isArray(clientDoc.grant_types) ? [...clientDoc.grant_types].sort(codeUnitCompare) : [],
      responseTypes: Array.isArray(clientDoc.response_types) ? [...clientDoc.response_types].sort(codeUnitCompare) : [],
      clientUri: (clientDoc.client_uri ?? null),
      logoUri: (clientDoc.logo_uri ?? null),
      scope: (clientDoc.scope ?? null),
      clientIdIssuedAt: typeof clientDoc.client_id_issued_at === 'number' ? clientDoc.client_id_issued_at : null,
      v: 2,
    };
  }

  throw new CutoverFenceError(`Unsupported candidate kind for source projection: ${candidate.kind}`);
}

export function projectTargetLogical(candidate, targets, codec) {
  if (candidate.kind === 'pr56Families') {
    const famDoc = targets.get('families');
    if (!famDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing families target document`);
    const famData = famDoc;
    const familyId = famData.id;
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
    const unsealedUp = upData.sealed
      ? codec.open(upData.sealed, upstreamAad({ id: familyId, grantVersion }))
      : null;
    if (!unsealedUp) {
      throw new CutoverFenceError(`Target upstream sealed payload decrypt failed for ${familyId}`);
    }

    const sessDoc = targets.get('tokens');
    if (!sessDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing tokens target document`);
    const sessData = sessDoc;
    if (sessData.v !== 2 || typeof sessData.expiresAt !== 'number') {
      throw new CutoverFenceError(`Target session invalid for family ${familyId}`);
    }
    const unsealedSess = sessData.sealed
      ? codec.open(sessData.sealed, accessAad({ id: sessData.id, familyId }))
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
      clientId: (unsealedFam.clientId ?? unsealedSess.clientId ?? ''),
      serverBaseUrl: (unsealedFam.serverBaseUrl ?? unsealedSess.serverBaseUrl ?? null),
      extra: (unsealedFam.extra ?? unsealedSess.extra ?? {}),
      activeRefreshId: famData.activeRefreshId,
      currentAccessTokenId: famData.currentAccessTokenId,
      previousRefresh,
      retiredRefreshFingerprints,
      upstream: {
        grantVersion,
        nsAccessToken: (unsealedUp.nsAccessToken ?? ''),
        nsRefreshToken: (unsealedUp.nsRefreshToken ?? null),
        nsUsername: (unsealedUp.nsUsername ?? ''),
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
    const unsealedFam = famData.sealed
      ? codec.open(famData.sealed, familyAad({ id: familyId, generation: 1 }))
      : null;
    if (!unsealedFam) throw new CutoverFenceError(`Target base family decrypt failed for ${familyId}`);

    const upDoc = targets.get('upstream');
    if (!upDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing upstream target document`);
    const upData = upDoc;
    const unsealedUp = upData.sealed
      ? codec.open(upData.sealed, upstreamAad({ id: familyId, grantVersion: 1 }))
      : null;
    if (!unsealedUp) throw new CutoverFenceError(`Target base upstream decrypt failed for ${familyId}`);

    const sessDoc = targets.get('tokens');
    if (!sessDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing tokens target document`);
    const sessData = sessDoc;
    if (sessData.v !== 2 || typeof sessData.expiresAt !== 'number') {
      throw new CutoverFenceError(`Target base session invalid for ${sessData.id}`);
    }
    const unsealedSess = sessData.sealed
      ? codec.open(sessData.sealed, accessAad({ id: sessData.id, familyId }))
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
      clientId: (unsealedFam.clientId ?? ''),
      serverBaseUrl: (unsealedFam.serverBaseUrl ?? null),
      extra: (unsealedFam.extra ?? {}),
      activeRefreshId: famData.activeRefreshId,
      currentAccessTokenId: famData.currentAccessTokenId,
      upstream: {
        grantVersion: 1,
        nsAccessToken: (unsealedUp.nsAccessToken ?? ''),
        nsRefreshToken: (unsealedUp.nsRefreshToken ?? null),
        nsUsername: (unsealedUp.nsUsername ?? ''),
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
    if (codeData.v !== 2 || typeof codeData.expiresAt !== 'number') {
      throw new CutoverFenceError(`Target auth code ${codeData.id} missing v: 2 or valid expiresAt`);
    }
    const unsealed = codeData.sealed
      ? codec.open(codeData.sealed, `code:${codeData.id}`)
      : null;
    if (!unsealed) throw new CutoverFenceError(`Target auth code decrypt failed for ${codeData.id}`);

    const rawPending = unsealed.pending || {};
    const rawNsTokens = unsealed.nsTokens || {};

    return {
      codeId: codeData.id,
      clientId: unsealed.clientId,
      codeChallenge: rawPending.codeChallenge,
      redirectUri: rawPending.redirectUri,
      createdAt: rawPending.createdAt,
      expiresAt: codeData.expiresAt,
      state: rawPending.state ?? null,
      scopes: Array.isArray(rawPending.scopes) ? [...rawPending.scopes].sort(codeUnitCompare) : [],
      nsAccessToken: rawNsTokens.access_token,
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
    if (resData._mcp_format !== 'v3_target' || resData.v !== 2) {
      throw new CutoverFenceError(`Target resume token ${resData.id} missing _mcp_format v3_target`);
    }
    return {
      resumeId: resData.id,
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
      throw new CutoverFenceError(`Target oauth client ${clientData.client_id ?? clientData.id} missing _mcp_format v3_target`);
    }
    return {
      clientId: clientData.client_id ?? clientData.id,
      clientName: typeof clientData.client_name === 'string' ? clientData.client_name : null,
      clientSecret: typeof clientData.client_secret === 'string' ? clientData.client_secret : null,
      redirectUris: Array.isArray(clientData.redirect_uris) ? [...clientData.redirect_uris].sort(codeUnitCompare) : [],
      tokenEndpointAuthMethod: (clientData.token_endpoint_auth_method ?? 'none'),
      grantTypes: Array.isArray(clientData.grant_types) ? [...clientData.grant_types].sort(codeUnitCompare) : [],
      responseTypes: Array.isArray(clientData.response_types) ? [...clientData.response_types].sort(codeUnitCompare) : [],
      clientUri: (clientData.client_uri ?? null),
      logoUri: (clientData.logo_uri ?? null),
      scope: (clientData.scope ?? null),
      clientIdIssuedAt: typeof clientData.client_id_issued_at === 'number' ? clientData.client_id_issued_at : null,
      v: 2,
    };
  }

  throw new CutoverFenceError(`Unsupported candidate kind for target projection: ${candidate.kind}`);
}
