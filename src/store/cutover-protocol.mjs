var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/store/errors.ts
var StoreConfigError = class extends Error {
  static {
    __name(this, "StoreConfigError");
  }
  constructor(message) {
    super(message);
    this.name = "StoreConfigError";
  }
};
var StoreLockedError = class extends Error {
  static {
    __name(this, "StoreLockedError");
  }
  constructor(message) {
    super(message);
    this.name = "StoreLockedError";
  }
};
var RetryableRefreshError = class extends Error {
  static {
    __name(this, "RetryableRefreshError");
  }
  constructor(message = "Timed out waiting for upstream token refresh") {
    super(message);
    this.name = "RetryableRefreshError";
  }
};
var LeaseLostError = class extends Error {
  static {
    __name(this, "LeaseLostError");
  }
  constructor(message = "Refresh lease expired or owned by another instance") {
    super(message);
    this.name = "LeaseLostError";
  }
};
var StoreUnavailableError = class extends Error {
  static {
    __name(this, "StoreUnavailableError");
  }
  constructor(message, options) {
    super(message, options);
    this.name = "StoreUnavailableError";
  }
};
var CutoverFenceError = class extends Error {
  static {
    __name(this, "CutoverFenceError");
  }
  kitCode = "cutover_fence_error";
  constructor(message, options) {
    super(message, options);
    this.name = "CutoverFenceError";
  }
};
var CutoverRefusedError = class extends Error {
  static {
    __name(this, "CutoverRefusedError");
  }
  kitCode = "cutover_refused";
  retryAfterSeconds;
  cutoverState;
  epoch;
  constructor(message = "Cutover in progress; operation temporarily unavailable", options) {
    super(message, options);
    this.name = "CutoverRefusedError";
    this.retryAfterSeconds = options?.retryAfterSeconds ?? 30;
    this.cutoverState = options?.cutoverState;
    this.epoch = options?.epoch;
  }
};
function isCutoverFenceError(err) {
  return Boolean(
    err && typeof err === "object" && (err.kitCode === "cutover_fence_error" || err.name === "CutoverFenceError")
  );
}
__name(isCutoverFenceError, "isCutoverFenceError");
function isCutoverRefusedError(err) {
  return Boolean(
    err && typeof err === "object" && err.kitCode === "cutover_refused"
  );
}
__name(isCutoverRefusedError, "isCutoverRefusedError");

// src/store/row-format.ts
var ACCESS_RETENTION_MS = 30 * 24 * 60 * 60 * 1e3;
var SESSION_RETENTION_MS = ACCESS_RETENTION_MS;
var REFRESH_RETRY_WINDOW_MS = 3e4;
var MAX_RETIRED_REFRESH_FINGERPRINTS = 64;
var AUTH_CODE_TTL_MS = 5 * 60 * 1e3;
var RESUME_TOKEN_TTL_MS = 2 * 60 * 60 * 1e3;
var REFRESH_WAIT_MS = 15e3;
var REFRESH_POLL_MS = 150;
var REFRESH_LEASE_MS = 15e3;
var REFRESH_SKEW_MS = 6e4;
function accessAad(row) {
  return `access:${row.id}:${row.familyId}`;
}
__name(accessAad, "accessAad");
function refreshAad(row) {
  return `refresh:${row.id}:${row.familyId}:${row.generation}`;
}
__name(refreshAad, "refreshAad");
function familyAad(row) {
  return `family:${row.id}:${row.generation}`;
}
__name(familyAad, "familyAad");
function upstreamAad(row) {
  return `upstream:${row.id}:${row.grantVersion}`;
}
__name(upstreamAad, "upstreamAad");
function sessionAad(row) {
  return `session:${row.id}:${row.refreshId}`;
}
__name(sessionAad, "sessionAad");
function codeUnitCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
__name(codeUnitCompare, "codeUnitCompare");
function compareDescriptors(a, b) {
  if (a.collection !== b.collection) return a.collection < b.collection ? -1 : 1;
  return codeUnitCompare(a.id, b.id);
}
__name(compareDescriptors, "compareDescriptors");
function safeDocEntry(id, data) {
  return { ...data || {}, id };
}
__name(safeDocEntry, "safeDocEntry");

// src/store/codec.ts
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
function deriveStoreKey(sessionSecret) {
  if (sessionSecret.length < 32) throw new StoreConfigError("MCP_SESSION_SECRET must be at least 32 characters");
  return Buffer.from(hkdfSync("sha256", Buffer.from(sessionSecret), Buffer.from("netsapiens-mcp/store/v1"), Buffer.from("root"), 32));
}
__name(deriveStoreKey, "deriveStoreKey");
function createCodec(root) {
  const rootBuf = typeof root === "string" ? Buffer.from(root, "utf8") : root;
  const idKey = Buffer.from(hkdfSync("sha256", rootBuf, "", "id", 32));
  const encKey = Buffer.from(hkdfSync("sha256", rootBuf, "", "enc", 32));
  return {
    id(purpose, value) {
      return createHmac("sha256", idKey).update(`${purpose}\0${value}`).digest("hex");
    },
    seal(value, aad) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", encKey, iv);
      cipher.setAAD(Buffer.from(aad, "utf8"));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
      return ["v1", iv.toString("base64url"), ciphertext.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
    },
    open(sealed, aad) {
      if (typeof sealed !== "string") return void 0;
      const parts = sealed.split(".");
      if (parts.length !== 4 || parts[0] !== "v1") return void 0;
      try {
        const iv = Buffer.from(parts[1], "base64url");
        const tag = Buffer.from(parts[3], "base64url");
        if (iv.length !== 12 || tag.length !== 16) return void 0;
        const decipher = createDecipheriv("aes-256-gcm", encKey, iv);
        decipher.setAAD(Buffer.from(aad, "utf8"));
        decipher.setAuthTag(tag);
        return JSON.parse(Buffer.concat([decipher.update(Buffer.from(parts[2], "base64url")), decipher.final()]).toString("utf8"));
      } catch {
        return void 0;
      }
    }
  };
}
__name(createCodec, "createCodec");

// src/store/row-codec.ts
function encodeSessionsRow(codec, accessId, familyId, session, now) {
  const expiresAt = session.expiresAt;
  const retainUntil = expiresAt + ACCESS_RETENTION_MS;
  const sealed = codec.seal(
    {
      familyId,
      clientId: session.clientId,
      serverBaseUrl: session.serverBaseUrl,
      extra: session.extra
    },
    accessAad({ id: accessId, familyId })
  );
  return {
    id: accessId,
    familyId,
    expiresAt,
    retainUntil,
    ttlAt: new Date(retainUntil),
    sealed,
    v: 2,
    updatedAt: now
  };
}
__name(encodeSessionsRow, "encodeSessionsRow");
function decodeSessionsRow(codec, row) {
  return codec.open(
    row.sealed,
    accessAad({ id: row.id, familyId: row.familyId })
  );
}
__name(decodeSessionsRow, "decodeSessionsRow");
function encodeRefreshFamiliesRow(codec, familyId, generation, activeRefreshId, currentAccessTokenId, session, retiredFingerprints, status, now) {
  const sealed = codec.seal(
    {
      clientId: session.clientId,
      serverBaseUrl: session.serverBaseUrl,
      extra: session.extra,
      retiredRefreshIds: retiredFingerprints
    },
    familyAad({ id: familyId, generation })
  );
  return {
    id: familyId,
    generation,
    status: status === "revoked" ? "revoked" : "active",
    activeRefreshId,
    currentAccessTokenId,
    updatedAt: now,
    sealed,
    v: 2
  };
}
__name(encodeRefreshFamiliesRow, "encodeRefreshFamiliesRow");
function decodeRefreshFamiliesRow(codec, row) {
  return codec.open(
    row.sealed,
    familyAad({ id: row.id, generation: row.generation })
  );
}
__name(decodeRefreshFamiliesRow, "decodeRefreshFamiliesRow");
function encodeUpstreamRow(codec, familyId, grantVersion, upstream, now) {
  const sealed = codec.seal(
    {
      nsAccessToken: upstream.nsAccessToken,
      nsRefreshToken: upstream.nsRefreshToken,
      nsUsername: upstream.nsUsername,
      nsUserRole: upstream.nsUserRole,
      nsApiUrl: upstream.nsApiUrl
    },
    upstreamAad({ id: familyId, grantVersion })
  );
  return {
    id: familyId,
    grantVersion,
    nsExpiresAt: upstream.nsExpiresAt,
    updatedAt: now,
    sealed,
    v: 2
  };
}
__name(encodeUpstreamRow, "encodeUpstreamRow");
function decodeUpstreamRow(codec, row) {
  return codec.open(
    row.sealed,
    upstreamAad({ id: row.id, grantVersion: row.grantVersion })
  );
}
__name(decodeUpstreamRow, "decodeUpstreamRow");
function encodeRefreshRow(refreshId, familyId, generation, now) {
  return {
    id: refreshId,
    familyId,
    generation,
    status: "active",
    v: 2,
    createdAt: now,
    updatedAt: now
  };
}
__name(encodeRefreshRow, "encodeRefreshRow");
function encodeAuthCodesRow(codec, code, data, expiresAt, now) {
  const id = codec.id("code", code);
  const sealed = codec.seal(data, `code:${id}`);
  return {
    id,
    expiresAt,
    ttlAt: new Date(expiresAt),
    sealed,
    v: 2
  };
}
__name(encodeAuthCodesRow, "encodeAuthCodesRow");
function encodeResumeTokensRow(id, consumedAt, expiresAt, now) {
  return {
    id,
    consumedAt,
    expiresAt,
    ttlAt: new Date(expiresAt),
    _mcp_format: "v3_target",
    v: 2
  };
}
__name(encodeResumeTokensRow, "encodeResumeTokensRow");
function encodeOAuthClientsRow(clientId, clientData, now) {
  return {
    client_id: clientId,
    client_name: clientData.client_name ?? null,
    redirect_uris: clientData.redirect_uris,
    token_endpoint_auth_method: clientData.token_endpoint_auth_method ?? "client_secret_basic",
    client_secret: clientData.client_secret ?? null,
    grant_types: clientData.grant_types ?? ["authorization_code", "refresh_token"],
    response_types: clientData.response_types ?? ["code"],
    client_uri: clientData.client_uri ?? null,
    logo_uri: clientData.logo_uri ?? null,
    scope: clientData.scope ?? null,
    client_id_issued_at: clientData.client_id_issued_at ?? Math.floor(now / 1e3),
    _mcp_format: "v3_target",
    v: 2
  };
}
__name(encodeOAuthClientsRow, "encodeOAuthClientsRow");

// src/store/netsapiens-projector.mjs
var PROJECTOR_ID = "netsapiens-mcp/v2-v3-projector";
var PROJECTOR_VERSION = 1;
function getTimestampMs(val) {
  if (val instanceof Date) {
    const ms = val.getTime();
    if (!Number.isFinite(ms) || !Number.isSafeInteger(ms)) return null;
    return ms;
  }
  if (val && typeof val === "object") {
    if (typeof val.toMillis === "function") {
      const ms = val.toMillis();
      if (typeof ms === "number" && Number.isFinite(ms) && Number.isSafeInteger(ms)) return ms;
    }
    const sec = val.seconds ?? val._seconds;
    const nsec = val.nanoseconds ?? val._nanoseconds ?? 0;
    if (typeof sec === "number" && Number.isSafeInteger(sec) && typeof nsec === "number" && Number.isSafeInteger(nsec) && nsec >= 0 && nsec < 1e9) {
      if (nsec % 1e6 !== 0) {
        return null;
      }
      const ms = sec * 1e3 + nsec / 1e6;
      if (!Number.isFinite(ms) || !Number.isSafeInteger(ms)) return null;
      return ms;
    }
  }
  return null;
}
__name(getTimestampMs, "getTimestampMs");
function projectSourceLogical(candidate, sources, codec) {
  if (candidate.kind === "pr56Families") {
    const famDoc = sources.get("families");
    if (!famDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing families source`);
    const famData = famDoc;
    const familyId = famData.id;
    if (!familyId || typeof familyId !== "string") throw new CutoverFenceError("pr56Families missing required familyId");
    const generation = typeof famData.generation === "number" ? famData.generation : 1;
    const refDoc = sources.get("refresh");
    if (!refDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing active refresh source`);
    const curRefDoc = refDoc;
    if (curRefDoc.id !== famData.currentRefreshToken || curRefDoc.status !== "active") {
      throw new CutoverFenceError(`Active refresh token '${curRefDoc.id}' mismatch with currentRefreshToken '${famData.currentRefreshToken}' or not active`);
    }
    const currentRefId = curRefDoc.id;
    const upDoc = sources.get("upstream");
    if (!upDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing upstream source`);
    const grant = upDoc.grant && typeof upDoc.grant === "object" ? upDoc.grant : upDoc;
    const tokDoc = sources.get("tokens");
    if (!tokDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing tokens source`);
    const accessId = tokDoc.id ?? tokDoc.accessToken ?? famData.currentAccessToken;
    if (!accessId || typeof accessId !== "string") throw new CutoverFenceError("pr56Families missing accessId");
    const newAccessId = codec.id("session", accessId);
    const newRefreshId = codec.id("refresh", currentRefId);
    let previousRefresh = null;
    if (famData.previousRefreshToken) {
      const prevId = famData.previousRefreshToken;
      const prevDoc = sources.get("prevRefresh");
      if (!prevDoc) {
        throw new CutoverFenceError(`Candidate ${candidate.id} has previousRefreshToken '${prevId}' but missing prevRefresh source`);
      }
      if (prevDoc.id !== prevId || prevDoc.status !== "consumed") {
        throw new CutoverFenceError(`Previous refresh token '${prevDoc.id}' mismatch with previousRefreshToken '${prevId}' or not consumed`);
      }
      if (typeof prevDoc.consumedAt !== "number") {
        throw new CutoverFenceError(`Candidate ${candidate.id} previous refresh missing numeric consumedAt`);
      }
      const prevRefreshId = codec.id("refresh", prevId);
      previousRefresh = {
        id: prevRefreshId,
        consumedAt: prevDoc.consumedAt,
        generation: Math.max(1, generation - 1),
        successor: {
          accessToken: accessId,
          refreshToken: currentRefId
        }
      };
    }
    const rawRetired = Array.isArray(famData.retiredRefreshFingerprints) ? famData.retiredRefreshFingerprints : Array.isArray(famData.retiredTokens) ? famData.retiredTokens : [];
    const retiredFingerprints = Array.from(new Set(rawRetired.filter((fp) => typeof fp === "string" && fp.length > 0))).sort(codeUnitCompare);
    const expiresAt = typeof tokDoc.expiresAt === "number" ? tokDoc.expiresAt : typeof curRefDoc.token?.expiresAt === "number" ? curRefDoc.token.expiresAt : famData.expiresAt;
    if (typeof expiresAt !== "number" || expiresAt <= 0) {
      throw new CutoverFenceError("pr56Families missing required positive expiresAt");
    }
    const clientId = curRefDoc.token?.clientId ?? tokDoc.clientId ?? famData.clientId;
    if (!clientId || typeof clientId !== "string") {
      throw new CutoverFenceError("pr56Families missing required clientId");
    }
    const nsAccessToken = grant.nsAccessToken ?? grant.access_token ?? tokDoc.nsAccessToken;
    if (!nsAccessToken || typeof nsAccessToken !== "string") {
      throw new CutoverFenceError("pr56Families missing required nsAccessToken");
    }
    const nsUsername = grant.nsUsername ?? grant.username ?? tokDoc.nsUsername;
    if (!nsUsername || typeof nsUsername !== "string") {
      throw new CutoverFenceError("pr56Families missing required nsUsername");
    }
    return {
      familyId,
      generation,
      status: famData.status === "revoked" ? "revoked" : "active",
      clientId,
      serverBaseUrl: curRefDoc.token?.serverBaseUrl ?? tokDoc.serverBaseUrl ?? famData.serverBaseUrl ?? null,
      extra: curRefDoc.token?.extra ?? tokDoc.extra ?? {},
      activeRefreshId: newRefreshId,
      currentAccessTokenId: newAccessId,
      previousRefresh,
      retiredRefreshFingerprints,
      upstream: {
        grantVersion: typeof upDoc.grantVersion === "number" ? upDoc.grantVersion : 1,
        nsAccessToken,
        nsRefreshToken: grant.nsRefreshToken ?? grant.refresh_token ?? tokDoc.nsRefreshToken ?? null,
        nsUsername,
        nsUserRole: grant.nsUserRole ?? grant.user_role ?? tokDoc.nsUserRole ?? null,
        nsApiUrl: grant.nsApiUrl ?? grant.api_url ?? tokDoc.nsApiUrl ?? null,
        nsExpiresAt: typeof upDoc.expiresAt === "number" ? upDoc.expiresAt : typeof tokDoc.nsExpiresAt === "number" ? tokDoc.nsExpiresAt : null
      },
      expiresAt,
      v: 2
    };
  }
  if (candidate.kind === "baseFormatTokens") {
    const tokDoc = sources.get("tokens");
    if (!tokDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing tokens source`);
    const refDoc = sources.get("refresh");
    if (!refDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing refresh source`);
    const accessToken = tokDoc.id;
    const refreshToken = tokDoc.refreshToken ?? refDoc.id;
    const familyId = codec.id("family", accessToken);
    const accessId = codec.id("session", accessToken);
    const refreshId = codec.id("refresh", refreshToken);
    const expiresAt = tokDoc.expiresAt;
    if (typeof expiresAt !== "number" || expiresAt <= 0) {
      throw new CutoverFenceError("baseFormatTokens missing required positive expiresAt");
    }
    const clientId = tokDoc.clientId;
    if (!clientId || typeof clientId !== "string") {
      throw new CutoverFenceError("baseFormatTokens missing required clientId");
    }
    const nsAccessToken = tokDoc.nsAccessToken;
    if (!nsAccessToken || typeof nsAccessToken !== "string") {
      throw new CutoverFenceError("baseFormatTokens missing required nsAccessToken");
    }
    const nsUsername = tokDoc.nsUsername;
    if (!nsUsername || typeof nsUsername !== "string") {
      throw new CutoverFenceError("baseFormatTokens missing required nsUsername");
    }
    return {
      familyId,
      generation: 1,
      status: "active",
      clientId,
      serverBaseUrl: tokDoc.serverBaseUrl ?? null,
      extra: tokDoc.extra ?? (tokDoc.seatId ? { seatId: String(tokDoc.seatId) } : {}),
      activeRefreshId: refreshId,
      currentAccessTokenId: accessId,
      upstream: {
        grantVersion: 1,
        nsAccessToken,
        nsRefreshToken: tokDoc.nsRefreshToken ?? null,
        nsUsername,
        nsUserRole: tokDoc.nsUserRole ?? null,
        nsApiUrl: tokDoc.nsApiUrl ?? null,
        nsExpiresAt: typeof tokDoc.nsExpiresAt === "number" ? tokDoc.nsExpiresAt : null
      },
      expiresAt,
      v: 2
    };
  }
  if (candidate.kind === "authCodes") {
    const codeDoc = sources.get("authCodes");
    if (!codeDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing authCodes source`);
    const rawCode = codeDoc.id;
    const hmacId = codec.id("code", rawCode);
    const rawPending = codeDoc.pending && typeof codeDoc.pending === "object" ? codeDoc.pending : codeDoc;
    const rawNsTokens = codeDoc.nsTokens && typeof codeDoc.nsTokens === "object" ? codeDoc.nsTokens : void 0;
    const clientId = rawPending.clientId ?? rawPending.client_id ?? codeDoc.clientId ?? codeDoc.client_id;
    if (!clientId || typeof clientId !== "string" || !clientId.trim()) {
      throw new CutoverFenceError("authCodes missing required clientId");
    }
    const codeChallenge = rawPending.codeChallenge ?? rawPending.code_challenge;
    if (!codeChallenge || typeof codeChallenge !== "string" || !codeChallenge.trim()) {
      throw new CutoverFenceError("authCodes missing required codeChallenge");
    }
    const redirectUri = rawPending.redirectUri ?? rawPending.redirect_uri;
    if (!redirectUri || typeof redirectUri !== "string" || !redirectUri.trim()) {
      throw new CutoverFenceError("authCodes missing required redirectUri");
    }
    const createdAt = rawPending.createdAt ?? rawPending.created_at;
    if (typeof createdAt !== "number" || createdAt <= 0) {
      throw new CutoverFenceError("authCodes missing required positive createdAt");
    }
    const expiresAt = typeof codeDoc.expiresAt === "number" ? codeDoc.expiresAt : typeof codeDoc.expires_at === "number" ? codeDoc.expires_at : null;
    if (typeof expiresAt !== "number" || expiresAt <= 0) {
      throw new CutoverFenceError("authCodes missing required positive expiresAt");
    }
    const nsAccessToken = rawNsTokens?.access_token ?? rawNsTokens?.nsAccessToken ?? codeDoc.nsAccessToken;
    if (!nsAccessToken || typeof nsAccessToken !== "string" || !nsAccessToken.trim()) {
      throw new CutoverFenceError("authCodes missing required nsAccessToken");
    }
    return {
      codeId: hmacId,
      clientId,
      codeChallenge,
      redirectUri,
      createdAt,
      expiresAt,
      state: typeof rawPending.state === "string" ? rawPending.state : null,
      scopes: Array.isArray(rawPending.scopes) ? [...rawPending.scopes].sort(codeUnitCompare) : [],
      nsAccessToken,
      nsRefreshToken: rawNsTokens?.refresh_token ?? rawNsTokens?.nsRefreshToken ?? codeDoc.nsRefreshToken ?? null,
      nsUsername: rawNsTokens?.username ?? rawNsTokens?.nsUsername ?? codeDoc.nsUsername ?? null,
      nsUserRole: rawNsTokens?.nsUserRole ?? codeDoc.nsUserRole ?? null,
      nsApiUrl: rawNsTokens?.nsApiUrl ?? codeDoc.nsApiUrl ?? null,
      serverBaseUrl: codeDoc.serverBaseUrl ?? null,
      extra: codeDoc.extra ?? {},
      v: 2
    };
  }
  if (candidate.kind === "resumeTokens") {
    const resDoc = sources.get("resumeTokens");
    if (!resDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing resumeTokens source`);
    const resumeId = resDoc.id;
    if (!resumeId || typeof resumeId !== "string") throw new CutoverFenceError("resumeTokens missing required id");
    if (typeof resDoc.consumedAt !== "number") throw new CutoverFenceError("resumeTokens missing required consumedAt");
    if (typeof resDoc.expiresAt !== "number" || resDoc.expiresAt <= 0) throw new CutoverFenceError("resumeTokens missing required positive expiresAt");
    return {
      resumeId,
      consumedAt: resDoc.consumedAt,
      expiresAt: resDoc.expiresAt,
      v: 2
    };
  }
  if (candidate.kind === "clients") {
    const clientDoc = sources.get("clients");
    if (!clientDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing clients source`);
    const clientId = clientDoc.client_id ?? clientDoc.id;
    if (!clientId || typeof clientId !== "string") throw new CutoverFenceError("clients missing required clientId");
    if (!Array.isArray(clientDoc.redirect_uris) || clientDoc.redirect_uris.length === 0) {
      throw new CutoverFenceError("clients missing required non-empty redirect_uris");
    }
    const tokenEndpointAuthMethod = typeof clientDoc.token_endpoint_auth_method === "string" ? clientDoc.token_endpoint_auth_method : clientDoc.client_secret ? "client_secret_basic" : "none";
    return {
      clientId,
      clientName: typeof clientDoc.client_name === "string" ? clientDoc.client_name : null,
      clientSecret: typeof clientDoc.client_secret === "string" ? clientDoc.client_secret : null,
      redirectUris: [...clientDoc.redirect_uris].sort(codeUnitCompare),
      tokenEndpointAuthMethod,
      grantTypes: Array.isArray(clientDoc.grant_types) ? [...clientDoc.grant_types].sort(codeUnitCompare) : [],
      responseTypes: Array.isArray(clientDoc.response_types) ? [...clientDoc.response_types].sort(codeUnitCompare) : [],
      clientUri: clientDoc.client_uri ?? null,
      logoUri: clientDoc.logo_uri ?? null,
      scope: clientDoc.scope ?? null,
      clientIdIssuedAt: typeof clientDoc.client_id_issued_at === "number" ? clientDoc.client_id_issued_at : null,
      v: 2
    };
  }
  throw new CutoverFenceError(`Unsupported candidate kind for source projection: ${kind}`);
}
__name(projectSourceLogical, "projectSourceLogical");
function projectTargetLogical(candidate, targets, codec) {
  if (candidate.kind === "pr56Families") {
    const famDoc = targets.get("families");
    if (!famDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing families target document`);
    const famData = famDoc;
    const familyId = famData.id;
    if (!familyId || typeof familyId !== "string") throw new CutoverFenceError("Target family missing id");
    const generation = famData.generation;
    if (typeof generation !== "number" || generation < 1) {
      throw new CutoverFenceError(`Target family ${familyId} malformed generation`);
    }
    const unsealedFam = famData.sealed ? codec.open(famData.sealed, familyAad({ id: familyId, generation })) : null;
    if (!unsealedFam) {
      throw new CutoverFenceError(`Target family sealed payload decrypt failed for ${familyId}`);
    }
    const upDoc = targets.get("upstream");
    if (!upDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing upstream target document`);
    const upData = upDoc;
    const grantVersion = upData.grantVersion;
    if (typeof grantVersion !== "number" || grantVersion < 1) {
      throw new CutoverFenceError(`Target upstream ${familyId} malformed grantVersion`);
    }
    if (upData.familyId !== familyId && upData.id !== familyId) {
      throw new CutoverFenceError(`Target upstream family binding mismatch for ${familyId}`);
    }
    const unsealedUp = upData.sealed ? codec.open(upData.sealed, upstreamAad({ id: familyId, grantVersion })) : null;
    if (!unsealedUp) {
      throw new CutoverFenceError(`Target upstream sealed payload decrypt failed for ${familyId}`);
    }
    const sessDoc = targets.get("tokens");
    if (!sessDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing tokens target document`);
    const sessData = sessDoc;
    if (sessData.v !== 2 || typeof sessData.expiresAt !== "number" || typeof sessData.retainUntil !== "number" || !sessData.ttlAt) {
      throw new CutoverFenceError(`Target session invalid for family ${familyId}: missing v: 2, expiresAt, retainUntil, or ttlAt`);
    }
    if (sessData.familyId !== familyId) {
      throw new CutoverFenceError(`Target session family binding mismatch: expected ${familyId}, got ${sessData.familyId}`);
    }
    if (sessData.retainUntil !== sessData.expiresAt + 30 * 24 * 60 * 60 * 1e3) {
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
    if (!clientId || typeof clientId !== "string") {
      throw new CutoverFenceError(`Target family missing decrypted clientId for ${familyId}`);
    }
    const nsAccessToken = unsealedUp.nsAccessToken;
    if (!nsAccessToken || typeof nsAccessToken !== "string") {
      throw new CutoverFenceError(`Target upstream missing decrypted nsAccessToken for ${familyId}`);
    }
    const nsUsername = unsealedUp.nsUsername;
    if (!nsUsername || typeof nsUsername !== "string") {
      throw new CutoverFenceError(`Target upstream missing decrypted nsUsername for ${familyId}`);
    }
    const activeRefDoc = targets.get("activeRefresh");
    if (!activeRefDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing active refresh target document`);
    const activeRefData = activeRefDoc;
    if (activeRefData.id !== famData.activeRefreshId || activeRefData.familyId !== familyId || activeRefData.status !== "active" || activeRefData.generation !== generation || activeRefData.v !== 2) {
      throw new CutoverFenceError(`Target active refresh token invalid for family ${familyId}`);
    }
    let previousRefresh = null;
    const prevRefDoc = targets.get("prevRefresh");
    if (prevRefDoc) {
      const prevRefData = prevRefDoc;
      if (prevRefData.familyId !== familyId || prevRefData.status !== "consumed" || typeof prevRefData.consumedAt !== "number" || prevRefData.v !== 2) {
        throw new CutoverFenceError(`Target consumed refresh token invalid for family ${familyId}`);
      }
      const unsealedSuccessor = codec.open(
        prevRefData.successorSealed,
        `successor:${prevRefData.id}`
      );
      if (!unsealedSuccessor || typeof unsealedSuccessor.accessToken !== "string" || typeof unsealedSuccessor.refreshToken !== "string") {
        throw new CutoverFenceError(`Target successor sealed invalid for previous refresh ${prevRefData.id}`);
      }
      previousRefresh = {
        id: prevRefData.id,
        consumedAt: prevRefData.consumedAt,
        generation: prevRefData.generation,
        successor: {
          accessToken: unsealedSuccessor.accessToken,
          refreshToken: unsealedSuccessor.refreshToken
        }
      };
    }
    const rawRetired = targets.get("retiredRefresh");
    const retiredRefreshFingerprints2 = (rawRetired?.ids || []).sort(codeUnitCompare);
    return {
      familyId,
      generation,
      status: famData.status,
      clientId,
      serverBaseUrl: unsealedFam.serverBaseUrl ?? unsealedSess.serverBaseUrl ?? null,
      extra: unsealedFam.extra ?? unsealedSess.extra ?? {},
      activeRefreshId: famData.activeRefreshId,
      currentAccessTokenId: famData.currentAccessTokenId,
      previousRefresh,
      retiredRefreshFingerprints: retiredRefreshFingerprints2,
      upstream: {
        grantVersion,
        nsAccessToken,
        nsRefreshToken: unsealedUp.nsRefreshToken ?? null,
        nsUsername,
        nsUserRole: unsealedUp.nsUserRole ?? null,
        nsApiUrl: unsealedUp.nsApiUrl ?? null,
        nsExpiresAt: typeof upData.nsExpiresAt === "number" ? upData.nsExpiresAt : null
      },
      expiresAt: sessData.expiresAt,
      v: 2
    };
  }
  if (candidate.kind === "baseFormatTokens") {
    const famDoc = targets.get("families");
    if (!famDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing families target document`);
    const famData = famDoc;
    const familyId = famData.id;
    const unsealedFam = codec.open(famData.sealed, familyAad({ id: familyId, generation: 1 }));
    if (!unsealedFam) throw new CutoverFenceError(`Target base family decrypt failed for ${familyId}`);
    const upDoc = targets.get("upstream");
    if (!upDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing upstream target document`);
    const upData = upDoc;
    if (upData.familyId !== familyId && upData.id !== familyId) {
      throw new CutoverFenceError(`Target base upstream family binding mismatch for ${familyId}`);
    }
    const unsealedUp = codec.open(upData.sealed, upstreamAad({ id: familyId, grantVersion: 1 }));
    if (!unsealedUp) throw new CutoverFenceError(`Target base upstream decrypt failed for ${familyId}`);
    const sessDoc = targets.get("tokens");
    if (!sessDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing tokens target document`);
    const sessData = sessDoc;
    if (sessData.v !== 2 || typeof sessData.expiresAt !== "number" || typeof sessData.retainUntil !== "number" || !sessData.ttlAt) {
      throw new CutoverFenceError(`Target base session invalid for ${sessData.id}: missing v: 2, expiresAt, retainUntil, or ttlAt`);
    }
    if (sessData.familyId !== familyId) {
      throw new CutoverFenceError(`Target base session family binding mismatch for ${sessData.id}`);
    }
    if (sessData.retainUntil !== sessData.expiresAt + 30 * 24 * 60 * 60 * 1e3) {
      throw new CutoverFenceError(`Target session retainUntil must equal expiresAt + 30 days for base session ${sessData.id}`);
    }
    const ttlMs = getTimestampMs(sessData.ttlAt);
    if (ttlMs === null || ttlMs !== sessData.retainUntil) {
      throw new CutoverFenceError(`Target session ttlAt must equal retainUntil for base session ${sessData.id}`);
    }
    const unsealedSess = codec.open(sessData.sealed, accessAad({ id: sessData.id, familyId }));
    if (!unsealedSess) throw new CutoverFenceError(`Target base session decrypt failed for ${sessData.id}`);
    const clientId = unsealedFam.clientId;
    if (!clientId || typeof clientId !== "string") {
      throw new CutoverFenceError(`Target base family missing decrypted clientId for ${familyId}`);
    }
    const nsAccessToken = unsealedUp.nsAccessToken;
    if (!nsAccessToken || typeof nsAccessToken !== "string") {
      throw new CutoverFenceError(`Target base upstream missing decrypted nsAccessToken for ${familyId}`);
    }
    const nsUsername = unsealedUp.nsUsername;
    if (!nsUsername || typeof nsUsername !== "string") {
      throw new CutoverFenceError(`Target base upstream missing decrypted nsUsername for ${familyId}`);
    }
    const activeRefDoc = targets.get("activeRefresh");
    if (!activeRefDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing active refresh target document`);
    const activeRefData = activeRefDoc;
    if (activeRefData.familyId !== familyId || activeRefData.status !== "active" || activeRefData.generation !== 1 || activeRefData.v !== 2) {
      throw new CutoverFenceError(`Target active refresh token invalid for base family ${familyId}`);
    }
    return {
      familyId,
      generation: 1,
      status: "active",
      clientId,
      serverBaseUrl: unsealedFam.serverBaseUrl ?? null,
      extra: unsealedFam.extra ?? {},
      activeRefreshId: famData.activeRefreshId,
      currentAccessTokenId: famData.currentAccessTokenId,
      upstream: {
        grantVersion: 1,
        nsAccessToken,
        nsRefreshToken: unsealedUp.nsRefreshToken ?? null,
        nsUsername,
        nsUserRole: unsealedUp.nsUserRole ?? null,
        nsApiUrl: unsealedUp.nsApiUrl ?? null,
        nsExpiresAt: typeof upData.nsExpiresAt === "number" ? upData.nsExpiresAt : null
      },
      expiresAt: sessData.expiresAt,
      v: 2
    };
  }
  if (candidate.kind === "authCodes") {
    const codeDoc = targets.get("authCodes");
    if (!codeDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing authCodes target document`);
    const codeData = codeDoc;
    if (codeData.v !== 2 || typeof codeData.expiresAt !== "number" || codeData.expiresAt <= 0 || !codeData.ttlAt) {
      throw new CutoverFenceError(`Target auth code ${codeData.id} missing v: 2, valid positive expiresAt, or ttlAt`);
    }
    const ttlMs = getTimestampMs(codeData.ttlAt);
    if (ttlMs === null || ttlMs !== codeData.expiresAt) {
      throw new CutoverFenceError(`Target auth code ${codeData.id} ttlAt must equal expiresAt`);
    }
    const unsealed = codeData.sealed ? codec.open(codeData.sealed, `code:${codeData.id}`) : null;
    if (!unsealed) throw new CutoverFenceError(`Target auth code decrypt failed for ${codeData.id}`);
    const rawPending = unsealed.pending || {};
    const rawNsTokens = unsealed.nsTokens || {};
    const clientId = unsealed.clientId;
    if (!clientId || typeof clientId !== "string") {
      throw new CutoverFenceError(`Target auth code ${codeData.id} missing decrypted clientId`);
    }
    const nsAccessToken = rawNsTokens.access_token;
    if (!nsAccessToken || typeof nsAccessToken !== "string") {
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
      v: 2
    };
  }
  if (candidate.kind === "resumeTokens") {
    const resDoc = targets.get("resumeTokens");
    if (!resDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing resumeTokens target document`);
    const resData = resDoc;
    if (resData._mcp_format !== "v3_target" || resData.v !== 2 || typeof resData.expiresAt !== "number" || resData.expiresAt <= 0 || !resData.ttlAt) {
      throw new CutoverFenceError(`Target resume token ${resData.id} missing _mcp_format v3_target, v: 2, positive expiresAt, or ttlAt`);
    }
    if (typeof resData.consumedAt !== "number") {
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
      v: 2
    };
  }
  if (candidate.kind === "clients") {
    const clientDoc = targets.get("clients");
    if (!clientDoc) throw new CutoverFenceError(`Candidate ${candidate.id} missing clients target document`);
    const clientData = clientDoc;
    if (clientData._mcp_format !== "v3_target" || clientData.v !== 2) {
      throw new CutoverFenceError(`Target oauth client ${clientData.client_id ?? clientData.id} missing _mcp_format v3_target`);
    }
    const clientId = clientData.client_id ?? clientData.id;
    if (!clientId || typeof clientId !== "string") {
      throw new CutoverFenceError("Target oauth client missing clientId");
    }
    if (!Array.isArray(clientData.redirect_uris) || clientData.redirect_uris.length === 0) {
      throw new CutoverFenceError("Target oauth client missing non-empty redirect_uris");
    }
    const tokenEndpointAuthMethod = typeof clientData.token_endpoint_auth_method === "string" ? clientData.token_endpoint_auth_method : clientData.client_secret ? "client_secret_basic" : "none";
    return {
      clientId,
      clientName: typeof clientData.client_name === "string" ? clientData.client_name : null,
      clientSecret: typeof clientData.client_secret === "string" ? clientData.client_secret : null,
      redirectUris: [...clientData.redirect_uris].sort(codeUnitCompare),
      tokenEndpointAuthMethod,
      grantTypes: Array.isArray(clientData.grant_types) ? [...clientData.grant_types].sort(codeUnitCompare) : [],
      responseTypes: Array.isArray(clientData.response_types) ? [...clientData.response_types].sort(codeUnitCompare) : [],
      clientUri: clientData.client_uri ?? null,
      logoUri: clientData.logo_uri ?? null,
      scope: clientData.scope ?? null,
      clientIdIssuedAt: typeof clientData.client_id_issued_at === "number" ? clientData.client_id_issued_at : null,
      v: 2
    };
  }
  throw new CutoverFenceError(`Unsupported candidate kind for target projection: ${kind}`);
}
__name(projectTargetLogical, "projectTargetLogical");

// src/cutover/canonical-core.mjs
import { createHash, createHmac as createHmac2, randomUUID } from "node:crypto";
var SUPPORTED_CUTOVER_NAMESPACES = ["mcp", "pwmcp", "readonly_mcp"];
function isSupportedCutoverNamespace(namespace) {
  return SUPPORTED_CUTOVER_NAMESPACES.includes(namespace);
}
__name(isSupportedCutoverNamespace, "isSupportedCutoverNamespace");
function assertSupportedCutoverNamespace(namespace) {
  if (!isSupportedCutoverNamespace(namespace)) {
    throw new CutoverFenceError2(
      `Unsupported cutover namespace: ${namespace}. Supported namespaces are: ${SUPPORTED_CUTOVER_NAMESPACES.join(", ")}`
    );
  }
}
__name(assertSupportedCutoverNamespace, "assertSupportedCutoverNamespace");
var CutoverFenceError2 = class extends Error {
  static {
    __name(this, "CutoverFenceError");
  }
  constructor(message) {
    super(message);
    this.name = "CutoverFenceError";
    this.kitCode = "cutover_fence_error";
    Object.defineProperty(this, "kitCode", { value: "cutover_fence_error", enumerable: true });
  }
};
var CutoverRefusedError2 = class extends Error {
  static {
    __name(this, "CutoverRefusedError");
  }
  constructor(message, details) {
    super(message);
    this.name = "CutoverRefusedError";
    this.kitCode = "cutover_refused";
    this.cutoverState = details?.cutoverState;
    this.epoch = details?.epoch;
  }
};
function isCutoverFenceError2(err) {
  return Boolean(
    err && typeof err === "object" && (err.kitCode === "cutover_fence_error" || err.name === "CutoverFenceError")
  );
}
__name(isCutoverFenceError2, "isCutoverFenceError");
function isCutoverRefusedError2(err) {
  return Boolean(
    err && typeof err === "object" && err.kitCode === "cutover_refused"
  );
}
__name(isCutoverRefusedError2, "isCutoverRefusedError");
function sanitizeId(id) {
  if (typeof id !== "string" || !id) return "[sanitized]";
  return createHash("sha256").update(id).digest("hex").slice(0, 12);
}
__name(sanitizeId, "sanitizeId");
var PHYSICAL_COUNT_KEYS = [
  "families",
  "tokens",
  "refresh",
  "upstream",
  "authCodes",
  "resumeTokens",
  "oauthClients",
  "clients"
];
var TARGET_COUNT_KEYS = [
  "families",
  "tokens",
  "refresh",
  "upstream",
  "authCodes",
  "resumeTokens",
  "retiredRefreshTokens",
  "oauthClients"
];
var CLASSIFICATION_KEYS = [
  "pr56Families",
  "baseFormatTokens",
  "authCodes",
  "resumeTokens",
  "clients"
];
var CANDIDATE_KIND_TO_CLASSIFICATION = {
  family: "pr56Families",
  base: "baseFormatTokens",
  code: "authCodes",
  resume: "resumeTokens",
  client: "clients",
  pr56Families: "pr56Families",
  baseFormatTokens: "baseFormatTokens",
  authCodes: "authCodes",
  resumeTokens: "resumeTokens",
  clients: "clients"
};
var REASON_KEYS = [
  "orphanAccessTokens",
  "orphanRefreshPointers",
  "orphanUpstreamGrants",
  "conflictingClaims",
  "missingAccessTokens",
  "missingUpstreamGrants",
  "missingRefreshPointers",
  "partialTargets",
  "malformedRecords"
];
var ALLOWED_STATE_TRANSITIONS = {
  legacy_open: ["closing"],
  closing: ["legacy_open", "fenced"],
  fenced: ["closing"],
  migrating: [],
  v3_ready: [],
  v3_active: []
};
var REQUIRED_IDENTITY_KEYS = [
  "schemaVersion",
  "namespace",
  "epoch",
  "migrationRunId",
  "codeSha",
  "codeArtifact",
  "packageIntegrity",
  "protocolDigest",
  "assemblyDigest",
  "indexSchemaDigest",
  "encoderVersion",
  "planDigest"
];
var REQUIRED_OWNERSHIP_MARKER_KEYS = [
  ...REQUIRED_IDENTITY_KEYS,
  "kind",
  "preparedDigest",
  "migrationManifestDigest",
  "emptyNamespace",
  "adoptedAt"
];
var REQUIRED_PREPARED_MANIFEST_KEYS = [
  ...REQUIRED_IDENTITY_KEYS,
  "kind",
  "preparedAt",
  "physicalCounts",
  "classifications",
  "reasons",
  "totalPhysicalRecords",
  "scanned",
  "expectedTargetCounts",
  "sourceInventoryDigest",
  "sourceLogicalDigest",
  "candidateCommitments",
  "planSpec"
];
var REQUIRED_FINAL_MANIFEST_KEYS = [
  ...REQUIRED_IDENTITY_KEYS,
  "kind",
  "preparedDigest",
  "completedAt",
  "physicalCounts",
  "classifications",
  "reasons",
  "totalPhysicalRecords",
  "targetCounts",
  "scanned",
  "migrated",
  "skipped",
  "errors",
  "sourceInventoryDigest",
  "targetInventoryDigest",
  "sourceLogicalDigest",
  "targetLogicalDigest",
  "receiptSetDigest"
];
var REQUIRED_CANDIDATE_KEYS = [
  "id",
  "kind",
  "sources",
  "targets",
  "logicalDigest"
];
var REQUIRED_RECEIPT_KEYS = [
  ...REQUIRED_IDENTITY_KEYS,
  "kind",
  "preparedDigest",
  "candidateId",
  "candidateDigest",
  "disposition",
  "sourceAfter",
  "targetAfter",
  "logicalDigest",
  "completedAt"
];
var APPROVED_GRAPH_PROJECTOR_ID = PROJECTOR_ID;
var APPROVED_GRAPH_PROJECTOR_VERSION = PROJECTOR_VERSION;
var NONEMPTY_PROJECTOR_KEYS = ["projectorId", "projectorVersion", "projectorDigest"];
var APPROVED_PROJECTOR_SHA256 = "51892d399b95546bdc247cd5e07a20db90677353e208b6124763ea57549a8da0";
function getMeasuredProjectorDigest() {
  return APPROVED_PROJECTOR_SHA256;
}
__name(getMeasuredProjectorDigest, "getMeasuredProjectorDigest");
function validateMapKeysExact(obj, allowedKeys, label = "object") {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new CutoverFenceError2(`${label} must be a non-null object`);
  }
  const actualKeys = Object.keys(obj);
  const allowedSet = new Set(allowedKeys);
  for (const k of actualKeys) {
    if (!allowedSet.has(k)) {
      throw new CutoverFenceError2(`Unexpected extra field '${k}' in ${label}`);
    }
  }
  for (const k of allowedKeys) {
    if (!(k in obj) || obj[k] === void 0) {
      throw new CutoverFenceError2(`Missing required field '${k}' in ${label}`);
    }
  }
}
__name(validateMapKeysExact, "validateMapKeysExact");
function validateMigrationIdentityFields(doc, expectedNamespace, expectedEpoch, expectedRunId) {
  if (!doc || typeof doc !== "object") {
    throw new CutoverFenceError2("Migration manifest must be an object");
  }
  if (doc.schemaVersion !== 2 && doc.schemaVersion !== 1) {
    throw new CutoverFenceError2(`Unsupported manifest schemaVersion: expected 2, got ${doc.schemaVersion}`);
  }
  if (doc.namespace !== expectedNamespace) {
    throw new CutoverFenceError2(
      `Manifest namespace mismatch: expected ${expectedNamespace}, got ${doc.namespace}`
    );
  }
  if (doc.epoch !== expectedEpoch) {
    throw new CutoverFenceError2(`Manifest epoch mismatch: expected ${expectedEpoch}, got ${doc.epoch}`);
  }
  if (expectedRunId && doc.migrationRunId !== expectedRunId) {
    throw new CutoverFenceError2(
      `Manifest migrationRunId mismatch: expected ${expectedRunId}, got ${doc.migrationRunId}`
    );
  }
  if (typeof doc.codeSha !== "string" || !/^[0-9a-f]{40}$/.test(doc.codeSha)) {
    throw new CutoverFenceError2(`Invalid codeSha in manifest: ${doc.codeSha}`);
  }
  if (typeof doc.codeArtifact !== "string" || !doc.codeArtifact.trim()) {
    throw new CutoverFenceError2("Invalid codeArtifact in manifest");
  }
  if (typeof doc.packageIntegrity !== "string" || !doc.packageIntegrity.trim()) {
    throw new CutoverFenceError2("Invalid packageIntegrity in manifest");
  }
  if (typeof doc.protocolDigest !== "string" || !/^[0-9a-f]{64}$/.test(doc.protocolDigest)) {
    throw new CutoverFenceError2(`Invalid protocolDigest in manifest: ${doc.protocolDigest}`);
  }
  if (typeof doc.assemblyDigest !== "string" || !/^[0-9a-f]{64}$/.test(doc.assemblyDigest)) {
    throw new CutoverFenceError2(`Invalid assemblyDigest in manifest: ${doc.assemblyDigest}`);
  }
  if (typeof doc.indexSchemaDigest !== "string" || !/^[0-9a-f]{64}$/.test(doc.indexSchemaDigest)) {
    throw new CutoverFenceError2(`Invalid indexSchemaDigest in manifest: ${doc.indexSchemaDigest}`);
  }
  if (doc.encoderVersion !== 1) {
    throw new CutoverFenceError2(`Unsupported encoderVersion: expected 1, got ${doc.encoderVersion}`);
  }
  if (typeof doc.planDigest !== "string" || !/^[0-9a-f]{64}$/.test(doc.planDigest)) {
    throw new CutoverFenceError2(`Invalid planDigest in manifest: ${doc.planDigest}`);
  }
}
__name(validateMigrationIdentityFields, "validateMigrationIdentityFields");
function validateCandidateProjection(kind2, candidateId, proj) {
  if (!proj || typeof proj !== "object" || Array.isArray(proj)) {
    throw new CutoverFenceError2(`Projector must return a plain non-null object for candidate ${candidateId}`);
  }
  const keys = Object.keys(proj);
  if (keys.length === 0) {
    throw new CutoverFenceError2(`Projector returned empty projection for candidate ${candidateId}`);
  }
  if (kind2 === "clients" || kind2 === "client") {
    if (typeof proj.clientId !== "string" || !proj.clientId) {
      throw new CutoverFenceError2(`Projector projection for ${kind2} candidate ${candidateId} missing required clientId`);
    }
  } else if (kind2 === "pr56Families" || kind2 === "family") {
    if (typeof proj.familyId !== "string" || typeof proj.generation !== "number") {
      throw new CutoverFenceError2(`Projector projection for ${kind2} candidate ${candidateId} missing required familyId or generation`);
    }
  } else if (kind2 === "baseFormatTokens" || kind2 === "base") {
    if (typeof proj.familyId !== "string" && typeof proj.accessTokenId !== "string" && typeof proj.accessToken !== "string") {
      throw new CutoverFenceError2(`Projector projection for ${kind2} candidate ${candidateId} missing required familyId or accessTokenId`);
    }
  } else if (kind2 === "authCodes" || kind2 === "code") {
    if (typeof proj.codeId !== "string" && typeof proj.code !== "string") {
      throw new CutoverFenceError2(`Projector projection for ${kind2} candidate ${candidateId} missing required codeId`);
    }
  } else if (kind2 === "resumeTokens" || kind2 === "resume") {
    if (typeof proj.resumeId !== "string" && typeof proj.resumeTokenId !== "string" && typeof proj.token !== "string") {
      throw new CutoverFenceError2(`Projector projection for ${kind2} candidate ${candidateId} missing required resumeId`);
    }
  }
}
__name(validateCandidateProjection, "validateCandidateProjection");
function getCutoverDistinctCollectionNames(namespace) {
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
      clients: `${namespace}_clients`
    },
    target: {
      families: `${namespace}_refresh_families`,
      tokens: `${namespace}_sessions`,
      refresh: `${namespace}_refresh`,
      upstream: `${namespace}_upstream`,
      authCodes: `${namespace}_auth_codes`,
      resumeTokens: `${namespace}_resume_tokens`,
      retiredRefreshTokens: `${namespace}_retired_refresh`,
      oauthClients: `${namespace}_oauth_clients`
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
      `${namespace}_retired_refresh`
    ]
  };
}
__name(getCutoverDistinctCollectionNames, "getCutoverDistinctCollectionNames");
function getSourceCollectionAllowlist(namespace) {
  if (namespace !== void 0) assertSupportedCutoverNamespace(namespace);
  return [...PHYSICAL_COUNT_KEYS];
}
__name(getSourceCollectionAllowlist, "getSourceCollectionAllowlist");
function getTargetCollectionAllowlist(namespace) {
  if (namespace !== void 0) assertSupportedCutoverNamespace(namespace);
  return [...TARGET_COUNT_KEYS];
}
__name(getTargetCollectionAllowlist, "getTargetCollectionAllowlist");
function isTargetFormatRow(collection, data, rawId = "") {
  if (data === null || data === void 0 || typeof data !== "object" || Array.isArray(data)) {
    throw new CutoverFenceError2(`Malformed document in '${collection}/${rawId}': data must be a non-null object`);
  }
  if (collection.endsWith("_auth_codes")) {
    const isTarget = typeof data.sealed === "string";
    const isSource = !data.sealed && (data.code !== void 0 || data.clientId !== void 0 || data.redirectUri !== void 0 || data.expiresAt !== void 0);
    if (isTarget && !isSource) return true;
    if (isSource && !isTarget) return false;
    throw new CutoverFenceError2(`Ambiguous auth_codes document format in '${collection}/${rawId}'`);
  }
  if (collection.endsWith("_resume_tokens")) {
    const isTarget = data.v === 2 || data.ttlAt !== void 0 || data._mcp_format === "v3_target";
    const isSource = data.v === void 0 && data.ttlAt === void 0 && data._mcp_format === void 0 && (data.consumedAt !== void 0 || data.expiresAt !== void 0 || data.token !== void 0);
    if (isTarget && !isSource) return true;
    if (isSource && !isTarget) return false;
    throw new CutoverFenceError2(`Ambiguous resume_tokens document format in '${collection}/${rawId}'`);
  }
  if (collection.endsWith("_oauth_clients")) {
    const hasClientId = typeof data.client_id === "string" || typeof data.clientId === "string";
    if (!hasClientId) {
      throw new CutoverFenceError2(`Ambiguous oauth_clients document format in '${collection}/${rawId}': missing client_id`);
    }
    if (data._targetFormat !== void 0) {
      throw new CutoverFenceError2(`Ambiguous oauth_clients document format in '${collection}/${rawId}': reserved field _targetFormat present`);
    }
    const isTarget = data._mcp_format === "v3_target";
    const isSource = data._mcp_format === void 0;
    if (isTarget && !isSource) return true;
    if (isSource && !isTarget) return false;
    throw new CutoverFenceError2(`Ambiguous oauth_clients document format in '${collection}/${rawId}'`);
  }
  if (data._mcp_format === "v3_target" || data.format === "v3") return true;
  return false;
}
__name(isTargetFormatRow, "isTargetFormatRow");
function getCutoverFenceDocRef(db, namespace) {
  return db.collection(`${namespace}_meta`).doc("cutover_fence");
}
__name(getCutoverFenceDocRef, "getCutoverFenceDocRef");
function getCutoverOperationsColRef(db, namespace) {
  assertSupportedCutoverNamespace(namespace);
  return db.collection(`${namespace}_meta`).doc("cutover_fence").collection("operations");
}
__name(getCutoverOperationsColRef, "getCutoverOperationsColRef");
function getCutoverOperationDocRef(db, namespace, operationId) {
  return getCutoverOperationsColRef(db, namespace).doc(operationId);
}
__name(getCutoverOperationDocRef, "getCutoverOperationDocRef");
function stripUndefined(record) {
  const result = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== void 0) {
      result[key] = value;
    }
  }
  return result;
}
__name(stripUndefined, "stripUndefined");
function validateNoLoneSurrogates(str) {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 55296 && code <= 56319) {
      if (i + 1 >= str.length) {
        throw new CutoverFenceError2("Invalid lone high surrogate in string");
      }
      const next = str.charCodeAt(i + 1);
      if (next < 56320 || next > 57343) {
        throw new CutoverFenceError2("Invalid lone high surrogate in string");
      }
      i++;
    } else if (code >= 56320 && code <= 57343) {
      throw new CutoverFenceError2("Invalid lone low surrogate in string");
    }
  }
}
__name(validateNoLoneSurrogates, "validateNoLoneSurrogates");
function normalizeValue(val) {
  if (val === null) return ["null"];
  if (typeof val === "boolean") return ["boolean", val];
  if (typeof val === "number") {
    if (!Number.isFinite(val)) {
      throw new CutoverFenceError2(`Cannot normalize non-finite number: ${val}`);
    }
    const normalizedNum = Object.is(val, -0) ? 0 : val;
    if (Number.isInteger(normalizedNum)) {
      if (!Number.isSafeInteger(normalizedNum)) {
        throw new CutoverFenceError2(`Cannot normalize unsafe integer: ${normalizedNum}`);
      }
    }
    return ["number", normalizedNum];
  }
  if (typeof val === "string") {
    validateNoLoneSurrogates(val);
    return ["string", val];
  }
  if (val instanceof Date) {
    const ms = val.getTime();
    if (Number.isNaN(ms)) {
      throw new CutoverFenceError2("Invalid Date object");
    }
    const seconds = Math.floor(ms / 1e3);
    const nanoseconds = (ms - seconds * 1e3) * 1e6;
    return ["timestamp", String(seconds), nanoseconds];
  }
  if (val && typeof val === "object" && (val.constructor?.name === "Timestamp" || typeof val.toMillis === "function" && typeof val.seconds === "number" && typeof val.nanoseconds === "number" && Object.keys(val).every(
    (k) => ["seconds", "nanoseconds", "_seconds", "_nanoseconds"].includes(k)
  ))) {
    if (!Number.isSafeInteger(val.seconds) || !Number.isSafeInteger(val.nanoseconds) || val.nanoseconds < 0 || val.nanoseconds >= 1e9) {
      throw new CutoverFenceError2("Invalid Firestore Timestamp field ranges");
    }
    return ["timestamp", String(val.seconds), val.nanoseconds];
  }
  if (val instanceof Uint8Array || typeof Buffer !== "undefined" && Buffer.isBuffer(val)) {
    return ["bytes", Buffer.from(val).toString("base64")];
  }
  if (Array.isArray(val)) {
    for (let i = 0; i < val.length; i++) {
      if (!(i in val)) {
        throw new CutoverFenceError2(`Sparse arrays are not supported at index ${i}`);
      }
    }
    return ["array", val.map(normalizeValue)];
  }
  if (typeof val === "object") {
    if (val.constructor && val.constructor !== Object && val.constructor.name !== "Object") {
      throw new CutoverFenceError2(`Unsupported object class: ${val.constructor.name}`);
    }
    const keys = Object.keys(val).sort(canonicalCompare);
    return ["map", keys.map((k) => {
      validateNoLoneSurrogates(k);
      return [k, normalizeValue(val[k])];
    })];
  }
  throw new CutoverFenceError2(`Unsupported type for canonical normalization: ${typeof val}`);
}
__name(normalizeValue, "normalizeValue");
function rfc8785CanonicalJson(val) {
  if (val === null) return "null";
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") {
    if (!Number.isFinite(val)) {
      throw new CutoverFenceError2(`Cannot serialize non-finite number: ${val}`);
    }
    return Object.is(val, -0) ? "0" : String(val);
  }
  if (typeof val === "string") {
    validateNoLoneSurrogates(val);
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return "[" + val.map(rfc8785CanonicalJson).join(",") + "]";
  }
  if (typeof val === "object") {
    const keys = Object.keys(val).sort(canonicalCompare);
    return "{" + keys.map((k) => {
      validateNoLoneSurrogates(k);
      return JSON.stringify(k) + ":" + rfc8785CanonicalJson(val[k]);
    }).join(",") + "}";
  }
  throw new CutoverFenceError2(`Unsupported type for canonical JSON: ${typeof val}`);
}
__name(rfc8785CanonicalJson, "rfc8785CanonicalJson");
function C(value) {
  return rfc8785CanonicalJson(normalizeValue(value));
}
__name(C, "C");
function canonicalJsonStringify(val) {
  return C(val);
}
__name(canonicalJsonStringify, "canonicalJsonStringify");
function canonicalCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
__name(canonicalCompare, "canonicalCompare");
function deriveKey(storeKey) {
  const rawKey = typeof storeKey === "string" ? Buffer.from(storeKey, "utf8") : storeKey;
  return createHmac2("sha256", rawKey).update(Buffer.from("netsapiens-mcp/cutover/v2", "utf8")).digest();
}
__name(deriveKey, "deriveKey");
function frame(purpose, namespace, epoch, value) {
  const framedObj = [
    "netsapiens-mcp/cutover",
    2,
    purpose,
    namespace,
    epoch,
    value
  ];
  return C(framedObj);
}
__name(frame, "frame");
var F = frame;
function D(purpose, namespace, epoch, value) {
  const payload = frame(purpose, namespace, epoch, value);
  return createHash("sha256").update(Buffer.from(payload, "utf8")).digest("hex");
}
__name(D, "D");
function H(storeKey, purpose, namespace, epoch, value) {
  if (!storeKey || typeof storeKey !== "string" && !Buffer.isBuffer(storeKey) && !(storeKey instanceof Uint8Array)) {
    throw new CutoverFenceError2("storeKey is REQUIRED for keyed HMAC operations");
  }
  const K = deriveKey(storeKey);
  const payload = frame(purpose, namespace, epoch, value);
  return createHmac2("sha256", K).update(Buffer.from(payload, "utf8")).digest("hex");
}
__name(H, "H");
function computeKeyedDocId(storeKey, purpose, namespace, epoch, collectionKey, rawId) {
  return H(storeKey, purpose, namespace, epoch, [collectionKey, rawId]);
}
__name(computeKeyedDocId, "computeKeyedDocId");
function computeSourceRecordDigest(storeKey, namespace, epoch, collectionKey, sourceId, data) {
  if (data === null || data === void 0 || typeof data !== "object" || Array.isArray(data)) {
    throw new CutoverFenceError2(`Malformed source data in '${collectionKey}/${sourceId}'`);
  }
  return H(storeKey, "source-record", namespace, epoch, [collectionKey, sourceId, data]);
}
__name(computeSourceRecordDigest, "computeSourceRecordDigest");
function computeTargetRecordDigest(storeKey, namespace, epoch, collectionKey, targetId, data) {
  if (data === null || data === void 0 || typeof data !== "object" || Array.isArray(data)) {
    throw new CutoverFenceError2(`Malformed target data in '${collectionKey}/${targetId}'`);
  }
  return H(storeKey, "target-record", namespace, epoch, [collectionKey, targetId, data]);
}
__name(computeTargetRecordDigest, "computeTargetRecordDigest");
function computeSourceInventoryDigest(storeKey, namespace, epoch, sourceDescriptors) {
  const sorted = [...sourceDescriptors].sort((a, b) => {
    if (a.collection !== b.collection) return canonicalCompare(a.collection, b.collection);
    return canonicalCompare(a.id, b.id);
  });
  return H(storeKey, "source-inventory", namespace, epoch, sorted);
}
__name(computeSourceInventoryDigest, "computeSourceInventoryDigest");
function computeTargetInventoryDigest(storeKey, namespace, epoch, targetDescriptors) {
  const sorted = [...targetDescriptors].sort((a, b) => {
    if (a.collection !== b.collection) return canonicalCompare(a.collection, b.collection);
    return canonicalCompare(a.id, b.id);
  });
  return H(storeKey, "target-inventory", namespace, epoch, sorted);
}
__name(computeTargetInventoryDigest, "computeTargetInventoryDigest");
function computeLogicalInventoryDigest(storeKey, namespace, epoch, logicalItems) {
  const sorted = [...logicalItems].sort((a, b) => canonicalCompare(a[0], b[0]));
  return H(storeKey, "logical-inventory", namespace, epoch, sorted);
}
__name(computeLogicalInventoryDigest, "computeLogicalInventoryDigest");
function computeManifestDigest(manifest, namespace, epoch) {
  if (!manifest || typeof manifest !== "object") {
    throw new CutoverFenceError2("Manifest must be an object");
  }
  const ns = namespace ?? manifest.namespace;
  const ep = epoch ?? manifest.epoch;
  if (!ns || !ep) {
    throw new CutoverFenceError2("namespace and epoch are required to compute manifest digest");
  }
  return D("final", ns, ep, manifest);
}
__name(computeManifestDigest, "computeManifestDigest");
function computeProtocolDigest(moduleSource) {
  const buf = typeof moduleSource === "string" ? Buffer.from(moduleSource, "utf8") : moduleSource;
  return createHash("sha256").update(buf).digest("hex");
}
__name(computeProtocolDigest, "computeProtocolDigest");
var FIRESTORE_MAX_DOCUMENT_SIZE_BYTES = 1048576;
var FIRESTORE_MAX_REQUEST_SIZE_BYTES = 10485760;
var FIRESTORE_MAX_INDEX_ENTRIES = 4e4;
var FIRESTORE_MAX_INDEX_BYTES = 8388608;
var FIRESTORE_MAX_NESTING_DEPTH = 20;
var FIRESTORE_MAX_FIELD_TRANSFORMS = 500;
var FIRESTORE_TRANSACTION_READ_DEADLINE_MS = 16e3;
function startMonotonicTimer() {
  const start = process.hrtime.bigint();
  return {
    elapsedMs() {
      return Number(process.hrtime.bigint() - start) / 1e6;
    },
    assertUnderDeadline(label = "Transaction callback") {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      if (ms > FIRESTORE_TRANSACTION_READ_DEADLINE_MS) {
        throw new CutoverFenceError2(
          `${label} elapsed duration (${Math.round(ms)} ms) exceeds 16,000 ms lock deadline`
        );
      }
    }
  };
}
__name(startMonotonicTimer, "startMonotonicTimer");
var PREFLIGHT_MAX_DOC_BYTES = Math.floor(4 * FIRESTORE_MAX_DOCUMENT_SIZE_BYTES / 5);
var PREFLIGHT_MAX_REQUEST_BYTES = Math.floor(4 * FIRESTORE_MAX_REQUEST_SIZE_BYTES / 5);
var PREFLIGHT_MAX_INDEX_ENTRIES = Math.floor(4 * FIRESTORE_MAX_INDEX_ENTRIES / 5);
var PREFLIGHT_MAX_INDEX_BYTES = Math.floor(4 * FIRESTORE_MAX_INDEX_BYTES / 5);
var PREFLIGHT_MAX_NESTING_DEPTH = Math.floor(4 * FIRESTORE_MAX_NESTING_DEPTH / 5);
var PREFLIGHT_MAX_FIELD_TRANSFORMS = Math.floor(4 * FIRESTORE_MAX_FIELD_TRANSFORMS / 5);
function computeEstimatedFirestoreDocSize(obj) {
  let size = 32;
  function calc(val, nameLen = 0) {
    size += nameLen + 1;
    if (val === null || typeof val === "boolean") {
      size += 1;
    } else if (typeof val === "number") {
      size += 8;
    } else if (typeof val === "string") {
      size += Buffer.byteLength(val, "utf8") + 1;
    } else if (val instanceof Date || val && typeof val === "object" && typeof val.seconds === "number") {
      size += 8;
    } else if (val instanceof Uint8Array || Buffer.isBuffer(val)) {
      size += val.length;
    } else if (Array.isArray(val)) {
      for (const item of val) calc(item, 0);
    } else if (val && typeof val === "object") {
      for (const [k, v] of Object.entries(val)) {
        calc(v, Buffer.byteLength(k, "utf8") + 1);
      }
    }
  }
  __name(calc, "calc");
  for (const [k, v] of Object.entries(obj)) {
    calc(v, Buffer.byteLength(k, "utf8") + 1);
  }
  return size;
}
__name(computeEstimatedFirestoreDocSize, "computeEstimatedFirestoreDocSize");
function getMaxDepth(val, currentDepth = 1) {
  if (val && typeof val === "object") {
    let max = currentDepth;
    const entries = Array.isArray(val) ? val : Object.values(val);
    for (const item of entries) {
      if (item && typeof item === "object") {
        const d = getMaxDepth(item, currentDepth + 1);
        if (d > max) max = d;
      }
    }
    return max;
  }
  return currentDepth;
}
__name(getMaxDepth, "getMaxDepth");
function countIndexMetrics(val) {
  let entries = 0;
  let bytes = 0;
  function traverse(v, pathLen = 0) {
    if (v === null || typeof v === "boolean" || typeof v === "number" || typeof v === "string" || v instanceof Date) {
      entries += 2;
      bytes += pathLen + 8;
    } else if (Array.isArray(v)) {
      for (const item of v) {
        entries += 1;
        bytes += pathLen + 8;
        traverse(item, pathLen);
      }
    } else if (v && typeof val === "object") {
      for (const [k, child] of Object.entries(v)) {
        traverse(child, pathLen + Buffer.byteLength(k, "utf8") + 1);
      }
    }
  }
  __name(traverse, "traverse");
  traverse(val);
  return { entries, bytes };
}
__name(countIndexMetrics, "countIndexMetrics");
function validateMigrationPreflightLimits(prep, options = {}) {
  const jsonStr = C(prep);
  const sizeBytes = Buffer.byteLength(jsonStr, "utf8");
  if (sizeBytes > PREFLIGHT_MAX_DOC_BYTES) {
    throw new CutoverFenceError2(
      `Prepared migration manifest canonical size (${sizeBytes} bytes) exceeds 80% limit (${PREFLIGHT_MAX_DOC_BYTES} bytes)`
    );
  }
  const estFirestoreSize = computeEstimatedFirestoreDocSize(prep);
  if (estFirestoreSize > PREFLIGHT_MAX_DOC_BYTES) {
    throw new CutoverFenceError2(
      `Prepared migration manifest estimated Firestore storage size (${estFirestoreSize} bytes) exceeds 80% limit (${PREFLIGHT_MAX_DOC_BYTES} bytes)`
    );
  }
  const depth = getMaxDepth(prep);
  if (depth > PREFLIGHT_MAX_NESTING_DEPTH) {
    throw new CutoverFenceError2(
      `Prepared migration manifest nesting depth (${depth}) exceeds 80% budget (${PREFLIGHT_MAX_NESTING_DEPTH})`
    );
  }
  const indexMetrics = countIndexMetrics(prep);
  if (indexMetrics.entries > PREFLIGHT_MAX_INDEX_ENTRIES) {
    throw new CutoverFenceError2(
      `Prepared migration manifest index entries (${indexMetrics.entries}) exceeds 80% budget (${PREFLIGHT_MAX_INDEX_ENTRIES})`
    );
  }
  if (indexMetrics.bytes > PREFLIGHT_MAX_INDEX_BYTES) {
    throw new CutoverFenceError2(
      `Prepared migration manifest index bytes (${indexMetrics.bytes}) exceeds 80% budget (${PREFLIGHT_MAX_INDEX_BYTES})`
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
      throw new CutoverFenceError2(`Full readset estimated size (${fullBytes} bytes) exceeds 80% request budget`);
    }
    if (fullEntries > PREFLIGHT_MAX_INDEX_ENTRIES) {
      throw new CutoverFenceError2(`Full readset index entries (${fullEntries}) exceeds 80% budget`);
    }
  }
  if (options.finalDoc) {
    const finalSize = computeEstimatedFirestoreDocSize(options.finalDoc);
    if (finalSize > PREFLIGHT_MAX_DOC_BYTES) {
      throw new CutoverFenceError2(`finalDoc size (${finalSize} bytes) exceeds 80% budget`);
    }
  }
  if (options.markerDoc) {
    const markerSize = computeEstimatedFirestoreDocSize(options.markerDoc);
    if (markerSize > PREFLIGHT_MAX_DOC_BYTES) {
      throw new CutoverFenceError2(`markerDoc size (${markerSize} bytes) exceeds 80% budget`);
    }
  }
  if (options.readDurationMs !== void 0) {
    if (options.readDurationMs > FIRESTORE_TRANSACTION_READ_DEADLINE_MS) {
      throw new CutoverFenceError2(
        `Preflight read duration (${options.readDurationMs} ms) exceeds 16,000 ms lock deadline`
      );
    }
  }
  return { sizeBytes, estFirestoreSize, depth, indexEntries: indexMetrics.entries, indexBytes: indexMetrics.bytes };
}
__name(validateMigrationPreflightLimits, "validateMigrationPreflightLimits");
function validateProspectiveDocBudget(doc, label = "Document") {
  if (!doc || typeof doc !== "object") {
    throw new CutoverFenceError2(`${label} is missing or not an object`);
  }
  const estFirestoreSize = computeEstimatedFirestoreDocSize(doc);
  if (estFirestoreSize > PREFLIGHT_MAX_DOC_BYTES) {
    throw new CutoverFenceError2(
      `${label} estimated Firestore size (${estFirestoreSize} bytes) exceeds 80% document budget (${PREFLIGHT_MAX_DOC_BYTES} bytes)`
    );
  }
  const depth = getMaxDepth(doc);
  if (depth > PREFLIGHT_MAX_NESTING_DEPTH) {
    throw new CutoverFenceError2(
      `${label} nesting depth (${depth}) exceeds 80% budget (${PREFLIGHT_MAX_NESTING_DEPTH})`
    );
  }
  const indexMetrics = countIndexMetrics(doc);
  if (indexMetrics.entries > PREFLIGHT_MAX_INDEX_ENTRIES) {
    throw new CutoverFenceError2(
      `${label} index entries (${indexMetrics.entries}) exceeds 80% budget (${PREFLIGHT_MAX_INDEX_ENTRIES})`
    );
  }
  if (indexMetrics.bytes > PREFLIGHT_MAX_INDEX_BYTES) {
    throw new CutoverFenceError2(
      `${label} index bytes (${indexMetrics.bytes}) exceeds 80% budget (${PREFLIGHT_MAX_INDEX_BYTES})`
    );
  }
  const transforms = doc._transformsCount ?? 0;
  if (transforms > PREFLIGHT_MAX_FIELD_TRANSFORMS) {
    throw new CutoverFenceError2(
      `${label} field transforms (${transforms}) exceeds 80% budget (${PREFLIGHT_MAX_FIELD_TRANSFORMS})`
    );
  }
  return { estFirestoreSize, depth, indexEntries: indexMetrics.entries, indexBytes: indexMetrics.bytes, transforms };
}
__name(validateProspectiveDocBudget, "validateProspectiveDocBudget");
function validateTransactionBudgetPlan(txPlan, label = "Transaction") {
  if (!txPlan || typeof txPlan !== "object") {
    throw new CutoverFenceError2(`${label} transaction budget plan is missing or not an object`);
  }
  const commitBytes = txPlan.estimatedCommitBytes ?? txPlan.commitBytes;
  if (typeof commitBytes !== "number" || !Number.isSafeInteger(commitBytes) || commitBytes <= 0 || commitBytes > PREFLIGHT_MAX_REQUEST_BYTES) {
    throw new CutoverFenceError2(
      `${label} estimated commit bytes (${commitBytes}) must be a positive integer <= 80% request budget (${PREFLIGHT_MAX_REQUEST_BYTES})`
    );
  }
  const readDurationMs = txPlan.estimatedReadDurationMs ?? txPlan.readDurationMs;
  if (typeof readDurationMs !== "number" || !Number.isFinite(readDurationMs) || readDurationMs <= 0 || readDurationMs > FIRESTORE_TRANSACTION_READ_DEADLINE_MS) {
    throw new CutoverFenceError2(
      `${label} estimated read duration (${readDurationMs} ms) must be positive and <= 16,000 ms lock deadline`
    );
  }
  return { commitBytes, readDurationMs };
}
__name(validateTransactionBudgetPlan, "validateTransactionBudgetPlan");
function validateCompleteMigrationPlan(plan) {
  if (!plan || typeof plan !== "object") {
    throw new CutoverFenceError2("CompleteMigrationPlan must be a non-null object");
  }
  if (!plan.prepared || typeof plan.prepared !== "object") {
    throw new CutoverFenceError2("CompleteMigrationPlan missing required prepared document");
  }
  const preparedMetrics = validateProspectiveDocBudget(plan.prepared, "Prepared manifest");
  validateTransactionBudgetPlan(plan.preparation, "Preparation");
  if (!Array.isArray(plan.items)) {
    throw new CutoverFenceError2("CompleteMigrationPlan missing required items array");
  }
  const candidateCommitments = plan.prepared.candidateCommitments || [];
  if (plan.items.length !== candidateCommitments.length) {
    throw new CutoverFenceError2(
      `CompleteMigrationPlan items count (${plan.items.length}) does not match prepared candidates count (${candidateCommitments.length})`
    );
  }
  const seenCandidateIds = /* @__PURE__ */ new Set();
  for (let i = 0; i < plan.items.length; i++) {
    const item = plan.items[i];
    if (!item || typeof item !== "object") {
      throw new CutoverFenceError2(`Item plan at index ${i} is missing or not an object`);
    }
    if (typeof item.candidateId !== "string" || !item.candidateId.trim()) {
      throw new CutoverFenceError2(`Item plan at index ${i} missing candidateId`);
    }
    if (seenCandidateIds.has(item.candidateId)) {
      throw new CutoverFenceError2(`Duplicate item plan for candidateId '${item.candidateId}'`);
    }
    seenCandidateIds.add(item.candidateId);
    const matchingCandidate = candidateCommitments.find((c) => c.id === item.candidateId);
    if (!matchingCandidate) {
      throw new CutoverFenceError2(`Item plan candidateId '${item.candidateId}' not found in prepared candidates`);
    }
    if (!Array.isArray(item.sourceReferences) || !Array.isArray(item.targetReferences)) {
      throw new CutoverFenceError2(`Item plan ${item.candidateId} missing sourceReferences or targetReferences array`);
    }
    if (item.sourceReferences.length !== matchingCandidate.sources.length) {
      throw new CutoverFenceError2(`Item plan ${item.candidateId} sourceReferences count mismatch`);
    }
    for (let sIdx = 0; sIdx < matchingCandidate.sources.length; sIdx++) {
      const expectedS = matchingCandidate.sources[sIdx];
      const actualS = item.sourceReferences[sIdx];
      if (!actualS || actualS.collection !== expectedS.collection || actualS.id !== expectedS.id) {
        throw new CutoverFenceError2(`Item plan ${item.candidateId} sourceReferences[${sIdx}] mismatch: expected '${expectedS.collection}:${expectedS.id}'`);
      }
    }
    if (item.targetReferences.length !== matchingCandidate.targets.length) {
      throw new CutoverFenceError2(`Item plan ${item.candidateId} targetReferences count mismatch`);
    }
    for (let tIdx = 0; tIdx < matchingCandidate.targets.length; tIdx++) {
      const expectedT = matchingCandidate.targets[tIdx];
      const actualT = item.targetReferences[tIdx];
      if (!actualT || actualT.collection !== expectedT.collection || actualT.id !== expectedT.id) {
        throw new CutoverFenceError2(`Item plan ${item.candidateId} targetReferences[${tIdx}] mismatch: expected '${expectedT.collection}:${expectedT.id}'`);
      }
    }
    if (!Array.isArray(item.sourceActions) || item.sourceActions.length === 0) {
      throw new CutoverFenceError2(`Item plan ${item.candidateId} missing non-empty sourceActions`);
    }
    if (!Array.isArray(item.prospectiveTargetPostimages) || item.prospectiveTargetPostimages.length !== matchingCandidate.targets.length) {
      throw new CutoverFenceError2(`Item plan ${item.candidateId} prospectiveTargetPostimages count must equal targets count (${matchingCandidate.targets.length})`);
    }
    for (let j = 0; j < item.prospectiveTargetPostimages.length; j++) {
      validateProspectiveDocBudget(
        item.prospectiveTargetPostimages[j],
        `Candidate ${item.candidateId} target postimage [${j}]`
      );
    }
    validateProspectiveDocBudget(item.receiptUpperBound, `Candidate ${item.candidateId} receipt upper bound`);
    validateTransactionBudgetPlan(item.transaction, `Candidate ${item.candidateId} item transaction`);
  }
  for (const c of candidateCommitments) {
    if (!seenCandidateIds.has(c.id)) {
      throw new CutoverFenceError2(`Prepared candidate '${c.id}' has no corresponding item plan`);
    }
  }
  if (!plan.finalization || typeof plan.finalization !== "object") {
    throw new CutoverFenceError2("CompleteMigrationPlan missing required finalization section");
  }
  validateProspectiveDocBudget(plan.finalization.finalUpperBound, "Final manifest upper bound");
  validateProspectiveDocBudget(plan.finalization.markerUpperBound, "Marker document upper bound");
  validateProspectiveDocBudget(plan.finalization.controlUpperBound, "Finalization control upper bound");
  validateTransactionBudgetPlan(plan.finalization.transaction, "Finalization");
  if (!plan.activation || typeof plan.activation !== "object") {
    throw new CutoverFenceError2("CompleteMigrationPlan missing required activation section");
  }
  validateProspectiveDocBudget(plan.activation.controlUpperBound, "Activation control upper bound");
  validateTransactionBudgetPlan(plan.activation.transaction, "Activation");
  return {
    valid: true,
    preparedMetrics,
    itemsCount: plan.items.length
  };
}
__name(validateCompleteMigrationPlan, "validateCompleteMigrationPlan");
function validateCandidateCommitments(candidates, prepDoc, expectedNamespace, expectedEpoch, expectedRunId) {
  if (!Array.isArray(candidates)) {
    throw new CutoverFenceError2("candidateCommitments must be an array");
  }
  const candidateIds = /* @__PURE__ */ new Set();
  const sourceKeys = /* @__PURE__ */ new Set();
  const targetKeys = /* @__PURE__ */ new Set();
  const kindCounts = {};
  for (const k of CLASSIFICATION_KEYS) kindCounts[k] = 0;
  const allowedSources = getSourceCollectionAllowlist(expectedNamespace);
  const allowedTargets = getTargetCollectionAllowlist(expectedNamespace);
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!c || typeof c !== "object") {
      throw new CutoverFenceError2(`candidateCommitments[${i}] must be an object`);
    }
    validateMapKeysExact(c, REQUIRED_CANDIDATE_KEYS, `candidateCommitments[${i}]`);
    if (typeof c.id !== "string" || !/^[0-9a-f]{64}$/.test(c.id)) {
      throw new CutoverFenceError2(`candidateCommitments[${i}].id must be 64-char hex`);
    }
    const classificationKind = CANDIDATE_KIND_TO_CLASSIFICATION[c.kind];
    if (!classificationKind || !CLASSIFICATION_KEYS.includes(classificationKind)) {
      throw new CutoverFenceError2(`candidateCommitments[${i}].kind must map to valid classification (${CLASSIFICATION_KEYS.join(", ")})`);
    }
    kindCounts[classificationKind] = (kindCounts[classificationKind] ?? 0) + 1;
    if (!Array.isArray(c.sources) || c.sources.length === 0) {
      throw new CutoverFenceError2(`candidateCommitments[${i}].sources must be a non-empty array`);
    }
    if (!Array.isArray(c.targets)) {
      throw new CutoverFenceError2(`candidateCommitments[${i}].targets must be an array`);
    }
    if (!/^[0-9a-f]{64}$/.test(c.logicalDigest)) {
      throw new CutoverFenceError2(`candidateCommitments[${i}].logicalDigest must be 64-char hex`);
    }
    if (candidateIds.has(c.id)) {
      throw new CutoverFenceError2(`Duplicate candidate id '${c.id}' in candidateCommitments`);
    }
    candidateIds.add(c.id);
    let prevSourceKey = "";
    for (const s of c.sources) {
      if (!s || typeof s !== "object") {
        throw new CutoverFenceError2(`Invalid source descriptor in candidate ${c.id}`);
      }
      validateMapKeysExact(s, ["collection", "id", "recordDigest"], `candidate ${c.id} source`);
      if (typeof s.collection !== "string" || typeof s.id !== "string" || !/^[0-9a-f]{64}$/.test(s.id) || !/^[0-9a-f]{64}$/.test(s.recordDigest)) {
        throw new CutoverFenceError2(`Invalid source descriptor formats in candidate ${c.id}`);
      }
      if (!allowedSources.includes(s.collection)) {
        throw new CutoverFenceError2(`Candidate ${c.id} source collection '${s.collection}' not in allowlist`);
      }
      const sKey = `${s.collection}:${s.id}`;
      if (sKey < prevSourceKey) {
        throw new CutoverFenceError2(`Candidate ${c.id} sources must be sorted by collection then id`);
      }
      prevSourceKey = sKey;
      if (sourceKeys.has(sKey)) {
        throw new CutoverFenceError2(`Duplicate source record '${sKey}' across candidateCommitments`);
      }
      sourceKeys.add(sKey);
    }
    let prevTargetKey = "";
    for (const t of c.targets) {
      if (!t || typeof t !== "object") {
        throw new CutoverFenceError2(`Invalid target descriptor in candidate ${c.id}`);
      }
      validateMapKeysExact(t, ["collection", "id"], `candidate ${c.id} target`);
      if (typeof t.collection !== "string" || typeof t.id !== "string" || !/^[0-9a-f]{64}$/.test(t.id)) {
        throw new CutoverFenceError2(`Invalid target descriptor formats in candidate ${c.id}`);
      }
      if (!allowedTargets.includes(t.collection)) {
        throw new CutoverFenceError2(`Candidate ${c.id} target collection '${t.collection}' not in allowlist`);
      }
      const tKey = `${t.collection}:${t.id}`;
      if (tKey < prevTargetKey) {
        throw new CutoverFenceError2(`Candidate ${c.id} targets must be sorted by collection then id`);
      }
      prevTargetKey = tKey;
      if (targetKeys.has(tKey)) {
        throw new CutoverFenceError2(`Duplicate target record '${tKey}' across candidateCommitments`);
      }
      targetKeys.add(tKey);
    }
  }
  if (prepDoc && prepDoc.classifications) {
    for (const k of CLASSIFICATION_KEYS) {
      if (prepDoc.classifications[k] !== (kindCounts[k] ?? 0)) {
        throw new CutoverFenceError2(`Partition count mismatch for '${k}': prepDoc has ${prepDoc.classifications[k]}, candidates have ${kindCounts[k] ?? 0}`);
      }
    }
  }
}
__name(validateCandidateCommitments, "validateCandidateCommitments");
function validateReceipt(receipt, expectedNamespace, expectedEpoch, expectedRunId) {
  if (!receipt || typeof receipt !== "object") {
    throw new CutoverFenceError2("Receipt must be an object");
  }
  validateMapKeysExact(receipt, REQUIRED_RECEIPT_KEYS, "receipt");
  validateMigrationIdentityFields(receipt, expectedNamespace, expectedEpoch, expectedRunId);
  if (receipt.kind !== "receipt") {
    throw new CutoverFenceError2(`Receipt kind must be 'receipt', got '${receipt.kind}'`);
  }
  if (!/^[0-9a-f]{64}$/.test(receipt.preparedDigest)) {
    throw new CutoverFenceError2(`Receipt preparedDigest must be 64-char hex, got '${receipt.preparedDigest}'`);
  }
  if (!/^[0-9a-f]{64}$/.test(receipt.candidateDigest)) {
    throw new CutoverFenceError2(`Receipt candidateDigest must be 64-char hex, got '${receipt.candidateDigest}'`);
  }
  if (!/^[0-9a-f]{64}$/.test(receipt.logicalDigest)) {
    throw new CutoverFenceError2(`Receipt logicalDigest must be 64-char hex, got '${receipt.logicalDigest}'`);
  }
  const validDispositions = ["written", "retained"];
  if (!validDispositions.includes(receipt.disposition)) {
    throw new CutoverFenceError2(
      `Receipt disposition must be one of [${validDispositions.join(", ")}], got '${receipt.disposition}'`
    );
  }
  const allowedSources = getSourceCollectionAllowlist(expectedNamespace);
  const allowedTargets = getTargetCollectionAllowlist(expectedNamespace);
  if (!Array.isArray(receipt.sourceAfter)) {
    throw new CutoverFenceError2("Receipt sourceAfter must be an array of source after-state descriptors");
  }
  for (const s of receipt.sourceAfter) {
    if (!s || typeof s !== "object") {
      throw new CutoverFenceError2("Invalid sourceAfter item in receipt");
    }
    validateMapKeysExact(s, ["collection", "id", "recordDigest"], "receipt sourceAfter item");
    if (typeof s.collection !== "string" || typeof s.id !== "string" || !/^[0-9a-f]{64}$/.test(s.id)) {
      throw new CutoverFenceError2("Invalid sourceAfter collection or id format");
    }
    if (!allowedSources.includes(s.collection)) {
      throw new CutoverFenceError2(`Receipt sourceAfter collection '${s.collection}' not in allowlist`);
    }
    if (s.recordDigest !== null && (typeof s.recordDigest !== "string" || !/^[0-9a-f]{64}$/.test(s.recordDigest))) {
      throw new CutoverFenceError2("sourceAfter recordDigest must be 64-char hex or null");
    }
  }
  if (!Array.isArray(receipt.targetAfter)) {
    throw new CutoverFenceError2("Receipt targetAfter must be an array of target after-state descriptors");
  }
  for (const t of receipt.targetAfter) {
    if (!t || typeof t !== "object") {
      throw new CutoverFenceError2("Invalid targetAfter item in receipt");
    }
    validateMapKeysExact(t, ["collection", "id", "recordDigest"], "receipt targetAfter item");
    if (typeof t.collection !== "string" || typeof t.id !== "string" || !/^[0-9a-f]{64}$/.test(t.id) || typeof t.recordDigest !== "string" || !/^[0-9a-f]{64}$/.test(t.recordDigest)) {
      throw new CutoverFenceError2("Invalid targetAfter descriptor format in receipt");
    }
    if (!allowedTargets.includes(t.collection)) {
      throw new CutoverFenceError2(`Receipt targetAfter collection '${t.collection}' not in allowlist`);
    }
  }
  if (!Number.isInteger(receipt.completedAt) || receipt.completedAt <= 0) {
    throw new CutoverFenceError2("Receipt completedAt must be a positive integer timestamp");
  }
}
__name(validateReceipt, "validateReceipt");
function computeReceiptDigest(receipt) {
  validateReceipt(receipt, receipt.namespace, receipt.epoch, receipt.migrationRunId);
  return D("receipt", receipt.namespace, receipt.epoch, receipt);
}
__name(computeReceiptDigest, "computeReceiptDigest");
function computePlanDigest(namespace, epoch, planSpec) {
  if (!planSpec || typeof planSpec !== "object") {
    throw new CutoverFenceError2("planSpec must be a non-null object");
  }
  return D("plan", namespace, epoch, planSpec);
}
__name(computePlanDigest, "computePlanDigest");
function computeReceiptSetDigest(receipts, namespace, epoch) {
  if (!Array.isArray(receipts)) {
    throw new CutoverFenceError2("Receipts must be an array");
  }
  const pairs = [];
  const candidateIds = /* @__PURE__ */ new Set();
  for (const r of receipts) {
    if (r.namespace !== namespace || r.epoch !== epoch) {
      throw new CutoverFenceError2("Receipt namespace or epoch mismatch in receipt set");
    }
    if (candidateIds.has(r.candidateId)) {
      throw new CutoverFenceError2(`Duplicate candidate receipt in receipt set: ${r.candidateId}`);
    }
    candidateIds.add(r.candidateId);
    pairs.push([r.candidateId, computeReceiptDigest(r)]);
  }
  pairs.sort((a, b) => canonicalCompare(a[0], b[0]));
  return D("receipt-set", namespace, epoch, pairs);
}
__name(computeReceiptSetDigest, "computeReceiptSetDigest");
function parseCutoverFenceRecord(data, namespace) {
  assertSupportedCutoverNamespace(namespace);
  if (!data || typeof data !== "object") {
    throw new CutoverFenceError2(
      `Invalid cutover fence record for namespace ${namespace}: expected object, got ${typeof data}`
    );
  }
  const record = data;
  const ALLOWED_CONTROL_KEYS = [
    "schemaVersion",
    "namespace",
    "epoch",
    "state",
    "activeOperations",
    "irreversible",
    "migrationRunId",
    "migrationManifestDigest",
    "emptyNamespace",
    "createdAt",
    "updatedAt",
    "codeArtifact",
    "codeSha",
    "lastTransitionReason"
  ];
  for (const key of Object.keys(record)) {
    if (!ALLOWED_CONTROL_KEYS.includes(key)) {
      throw new CutoverFenceError2(
        `Unknown field '${key}' in cutover fence control record for namespace ${namespace}`
      );
    }
  }
  if (record.schemaVersion !== 1) {
    throw new CutoverFenceError2(
      `Unsupported schemaVersion for namespace ${namespace}: expected 1, got ${record.schemaVersion}`
    );
  }
  if (record.namespace !== namespace) {
    throw new CutoverFenceError2(
      `Namespace mismatch in cutover fence record: expected ${namespace}, got ${record.namespace}`
    );
  }
  if (typeof record.epoch !== "number" || !Number.isInteger(record.epoch) || record.epoch < 1) {
    throw new CutoverFenceError2(
      `Invalid epoch in cutover fence record for namespace ${namespace}: ${record.epoch}`
    );
  }
  const validStates = ["legacy_open", "closing", "fenced", "migrating", "v3_ready", "v3_active"];
  if (typeof record.state !== "string" || !validStates.includes(record.state)) {
    throw new CutoverFenceError2(
      `Invalid cutover fence state for namespace ${namespace}: ${String(record.state)}`
    );
  }
  if (typeof record.activeOperations !== "number" || !Number.isInteger(record.activeOperations) || record.activeOperations < 0) {
    throw new CutoverFenceError2(
      `Invalid activeOperations in cutover fence record for namespace ${namespace}: ${String(record.activeOperations)}`
    );
  }
  if (typeof record.irreversible !== "boolean") {
    throw new CutoverFenceError2(
      `Invalid irreversible field in cutover fence record for namespace ${namespace}: expected boolean, got ${typeof record.irreversible}`
    );
  }
  if (["legacy_open", "closing", "fenced", "migrating"].includes(record.state)) {
    if (record.emptyNamespace !== void 0) {
      throw new CutoverFenceError2(
        `Invalid cutover fence invariants for namespace ${namespace}: ${record.state} cannot define emptyNamespace`
      );
    }
  }
  if (record.state === "legacy_open") {
    if (record.irreversible !== false) {
      throw new CutoverFenceError2(
        `Invalid cutover fence invariants for namespace ${namespace}: legacy_open cannot have irreversible: true`
      );
    }
    if (record.migrationRunId !== void 0 || record.migrationManifestDigest !== void 0) {
      throw new CutoverFenceError2(
        `Invalid cutover fence invariants for namespace ${namespace}: legacy_open cannot have migration markers`
      );
    }
  } else if (record.state === "closing" || record.state === "fenced") {
    if (record.migrationRunId !== void 0 || record.migrationManifestDigest !== void 0) {
      throw new CutoverFenceError2(
        `Invalid cutover fence invariants for namespace ${namespace}: ${record.state} cannot have migration markers`
      );
    }
  } else if (record.state === "migrating") {
    if (typeof record.migrationRunId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(record.migrationRunId)) {
      throw new CutoverFenceError2(
        `Invalid cutover fence invariants for namespace ${namespace}: migrating requires non-empty migrationRunId matching /^[A-Za-z0-9_-]{8,64}$/`
      );
    }
    if (record.migrationManifestDigest !== void 0) {
      throw new CutoverFenceError2(
        `Invalid cutover fence invariants for namespace ${namespace}: migrating cannot have migrationManifestDigest before v3_ready`
      );
    }
  } else if (record.state === "v3_ready" || record.state === "v3_active") {
    if (typeof record.migrationRunId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(record.migrationRunId)) {
      throw new CutoverFenceError2(
        `Invalid cutover fence invariants for namespace ${namespace}: ${record.state} requires migrationRunId matching /^[A-Za-z0-9_-]{8,64}$/`
      );
    }
    if (typeof record.migrationManifestDigest !== "string" || !/^[0-9a-f]{64}$/.test(record.migrationManifestDigest)) {
      throw new CutoverFenceError2(
        `Invalid cutover fence invariants for namespace ${namespace}: ${record.state} requires migrationManifestDigest to be 64-char hex`
      );
    }
    if (typeof record.emptyNamespace !== "boolean") {
      throw new CutoverFenceError2(
        `Invalid cutover fence invariants for namespace ${namespace}: ${record.state} requires emptyNamespace to be a boolean`
      );
    }
    if (record.emptyNamespace === true) {
      if (record.irreversible !== false) {
        throw new CutoverFenceError2(
          `Invalid cutover fence invariants for namespace ${namespace}: emptyNamespace requires irreversible: false`
        );
      }
    } else {
      if (record.irreversible !== true) {
        throw new CutoverFenceError2(
          `Invalid cutover fence invariants for namespace ${namespace}: non-empty ${record.state} requires irreversible: true`
        );
      }
    }
  }
  if (record.codeSha !== void 0) {
    if (typeof record.codeSha !== "string" || !/^[0-9a-f]{40}$/.test(record.codeSha)) {
      throw new CutoverFenceError2(`Invalid codeSha in cutover fence record for namespace ${namespace}`);
    }
  }
  if (record.codeArtifact !== void 0) {
    if (typeof record.codeArtifact !== "string" || !record.codeArtifact.trim()) {
      throw new CutoverFenceError2(`Invalid codeArtifact in cutover fence record for namespace ${namespace}`);
    }
  }
  return {
    schemaVersion: 1,
    namespace,
    epoch: record.epoch,
    state: record.state,
    activeOperations: record.activeOperations,
    irreversible: record.irreversible,
    migrationRunId: typeof record.migrationRunId === "string" ? record.migrationRunId : void 0,
    migrationManifestDigest: typeof record.migrationManifestDigest === "string" ? record.migrationManifestDigest : void 0,
    emptyNamespace: typeof record.emptyNamespace === "boolean" ? record.emptyNamespace : void 0,
    createdAt: typeof record.createdAt === "number" ? record.createdAt : void 0,
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : void 0,
    codeArtifact: typeof record.codeArtifact === "string" ? record.codeArtifact : void 0,
    codeSha: typeof record.codeSha === "string" ? record.codeSha : void 0,
    lastTransitionReason: typeof record.lastTransitionReason === "string" ? record.lastTransitionReason : void 0
  };
}
__name(parseCutoverFenceRecord, "parseCutoverFenceRecord");
async function readCutoverFenceInTransaction(transaction, db, namespace) {
  assertSupportedCutoverNamespace(namespace);
  const docRef = getCutoverFenceDocRef(db, namespace);
  const snap = await transaction.get(docRef);
  if (!snap.exists) {
    throw new CutoverFenceError2(
      `Cutover fence record not initialized for namespace ${namespace} at ${namespace}_meta/cutover_fence`
    );
  }
  return parseCutoverFenceRecord(snap.data(), namespace);
}
__name(readCutoverFenceInTransaction, "readCutoverFenceInTransaction");
async function getCutoverFenceRecord(db, namespace) {
  assertSupportedCutoverNamespace(namespace);
  const docRef = getCutoverFenceDocRef(db, namespace);
  const snap = await docRef.get();
  if (!snap.exists) {
    return void 0;
  }
  return parseCutoverFenceRecord(snap.data(), namespace);
}
__name(getCutoverFenceRecord, "getCutoverFenceRecord");
async function initializeCutoverFence(db, namespace, options = {}) {
  assertSupportedCutoverNamespace(namespace);
  const docRef = getCutoverFenceDocRef(db, namespace);
  const now = (options.now ?? Date.now)();
  const requestedInitialEpoch = options.initialEpoch ?? 1;
  if (typeof requestedInitialEpoch !== "number" || !Number.isInteger(requestedInitialEpoch) || requestedInitialEpoch !== 1) {
    throw new CutoverFenceError2(
      `Initial epoch for namespace ${namespace} must be exactly 1, got ${requestedInitialEpoch}`
    );
  }
  const requestedInitialState = options.initialState ?? "legacy_open";
  if (requestedInitialState !== "legacy_open") {
    throw new CutoverFenceError2(
      `Initial state for namespace ${namespace} must be 'legacy_open', got '${requestedInitialState}'`
    );
  }
  return await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(docRef);
    if (snap.exists) {
      const existing = parseCutoverFenceRecord(snap.data(), namespace);
      if (existing.epoch !== 1 || existing.state !== "legacy_open") {
        throw new CutoverFenceError2(
          `Cutover fence record for namespace ${namespace} already exists with epoch ${existing.epoch}, state ${existing.state}`
        );
      }
      return existing;
    }
    const initial = {
      schemaVersion: 1,
      namespace,
      epoch: 1,
      state: "legacy_open",
      activeOperations: 0,
      irreversible: false,
      createdAt: now,
      updatedAt: now
    };
    transaction.set(docRef, initial);
    return initial;
  });
}
__name(initializeCutoverFence, "initializeCutoverFence");
async function transitionCutoverFenceState(db, namespace, params) {
  assertSupportedCutoverNamespace(namespace);
  const docRef = getCutoverFenceDocRef(db, namespace);
  const now = (params.now ?? Date.now)();
  if (["migrating", "v3_ready", "v3_active"].includes(params.toState)) {
    throw new CutoverFenceError2(
      `Transition to '${params.toState}' must use atomic transaction helper (prepareMigrationInTransaction, finalizeMigrationInTransaction, or activateMigrationInTransaction)`
    );
  }
  return await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(docRef);
    if (!snap.exists) {
      throw new CutoverFenceError2(
        `Cannot transition: cutover fence record missing for namespace ${namespace}`
      );
    }
    const current = parseCutoverFenceRecord(snap.data(), namespace);
    if (current.state === params.toState) {
      if (params.allowIdempotent) {
        return current;
      }
      throw new CutoverFenceError2(
        `Idempotent transition rejected for namespace ${namespace}: already in state '${current.state}'`
      );
    }
    if (params.fromState !== void 0) {
      const allowedFrom = Array.isArray(params.fromState) ? params.fromState : [params.fromState];
      if (!allowedFrom.includes(current.state)) {
        throw new CutoverFenceError2(
          `Invalid fromState precondition for namespace ${namespace}: expected ${allowedFrom.join("|")}, got '${current.state}'`
        );
      }
    }
    if (current.epoch !== params.expectedEpoch) {
      throw new CutoverFenceError2(
        `Epoch mismatch on transition for namespace ${namespace}: expected ${params.expectedEpoch}, got ${current.epoch}`
      );
    }
    const allowedNext = ALLOWED_STATE_TRANSITIONS[current.state] ?? [];
    if (!allowedNext.includes(params.toState)) {
      throw new CutoverFenceError2(
        `Illegal cutover state transition for namespace ${namespace}: ${current.state} -> ${params.toState}`
      );
    }
    if (params.toState === "fenced") {
      const nonterminalOps = await transaction.get(
        getCutoverOperationsColRef(db, namespace).where("phase", "in", ["admitted", "upstream_pending"])
      );
      if (nonterminalOps.size !== current.activeOperations) {
        throw new CutoverFenceError2(
          `Cannot transition to fenced: activeOperations counter (${current.activeOperations}) does not match nonterminal operations count (${nonterminalOps.size})`
        );
      }
      if (nonterminalOps.size !== 0) {
        throw new CutoverFenceError2(
          `Cannot transition to fenced for namespace ${namespace}: ${nonterminalOps.size} active or pending operations exist`
        );
      }
      const ambiguousOps = await transaction.get(
        getCutoverOperationsColRef(db, namespace).where("ambiguousRemoteOutcome", "==", true)
      );
      if (!ambiguousOps.empty) {
        throw new CutoverFenceError2(
          `Cannot transition to fenced for namespace ${namespace}: unresolved ambiguous remote operations exist`
        );
      }
    } else if (params.toState === "legacy_open") {
      if (current.irreversible) {
        throw new CutoverFenceError2(
          `Cannot return to legacy_open for namespace ${namespace}: irreversible migration latch is engaged`
        );
      }
      if (current.migrationRunId || current.emptyNamespace) {
        throw new CutoverFenceError2(
          `Cannot return to legacy_open for namespace ${namespace}: migration ownership record exists`
        );
      }
      const markerRef = db.collection(`${namespace}_meta`).doc("v2_adopted");
      const markerSnap = await transaction.get(markerRef);
      if (markerSnap.exists) {
        throw new CutoverFenceError2(
          `Cannot return to legacy_open for namespace ${namespace}: durable v2_adopted ownership marker exists`
        );
      }
      if (current.activeOperations !== 0) {
        throw new CutoverFenceError2(
          `Cannot return to legacy_open for namespace ${namespace}: activeOperations is ${current.activeOperations}`
        );
      }
    }
    if (params.nextEpoch !== void 0) {
      const allowedNext2 = params.toState === "fenced" && current.state === "closing" ? current.epoch + 1 : current.epoch;
      if (params.nextEpoch !== allowedNext2) {
        throw new CutoverFenceError2(`Arbitrary nextEpoch is not permitted for transition to ${params.toState}`);
      }
    }
    const nextEpoch = params.toState === "fenced" && current.state === "closing" ? current.epoch + 1 : current.epoch;
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
      lastTransitionReason: `Transitioned from ${current.state} to ${params.toState}`
    };
    transaction.set(docRef, stripUndefined(updated));
    return updated;
  });
}
__name(transitionCutoverFenceState, "transitionCutoverFenceState");
async function markIrreversibleInTransaction(transaction, db, namespace, expectedEpoch, migrationRunId, nowProvider = Date.now) {
  assertSupportedCutoverNamespace(namespace);
  const current = await readCutoverFenceInTransaction(transaction, db, namespace);
  if (current.state !== "migrating") {
    throw new CutoverFenceError2(
      `Cannot set irreversible latch for namespace ${namespace}: state must be 'migrating', got '${current.state}'`
    );
  }
  if (current.epoch !== expectedEpoch) {
    throw new CutoverFenceError2(
      `Epoch mismatch when setting irreversible latch for namespace ${namespace}: expected ${expectedEpoch}, got ${current.epoch}`
    );
  }
  if (migrationRunId && current.migrationRunId !== migrationRunId) {
    throw new CutoverFenceError2(
      `migrationRunId mismatch when setting irreversible latch: expected ${migrationRunId}, got ${current.migrationRunId}`
    );
  }
  if (current.emptyNamespace === true) {
    throw new CutoverFenceError2(
      `Cannot set irreversible latch for namespace ${namespace}: emptyNamespace must remain irreversible: false`
    );
  }
  if (current.irreversible) {
    return current;
  }
  const currentTime = nowProvider();
  const updated = {
    ...current,
    irreversible: true,
    updatedAt: currentTime
  };
  const ref = getCutoverFenceDocRef(db, namespace);
  transaction.set(ref, stripUndefined(updated), { merge: true });
  return updated;
}
__name(markIrreversibleInTransaction, "markIrreversibleInTransaction");
async function withLegacyOperation(options, fn) {
  assertSupportedCutoverNamespace(options.namespace);
  const now = options.now ?? Date.now;
  const opId = options.operationId ?? randomUUID();
  const opRef = getCutoverOperationDocRef(options.db, options.namespace, opId);
  const controlRef = getCutoverFenceDocRef(options.db, options.namespace);
  const opRecord = await options.db.runTransaction(async (transaction) => {
    const timer = startMonotonicTimer();
    const existingSnap = await transaction.get(opRef);
    if (existingSnap.exists) {
      throw new CutoverFenceError2(
        `Operation with id '${sanitizeId(opId)}' already exists in namespace ${options.namespace}`
      );
    }
    const control = await readCutoverFenceInTransaction(transaction, options.db, options.namespace);
    if (["fenced", "migrating", "v3_ready", "v3_active"].includes(control.state)) {
      throw new CutoverRefusedError2(
        `Cutover state is ${control.state}; new operations refused for namespace ${options.namespace}`,
        { cutoverState: control.state, epoch: control.epoch }
      );
    }
    if (control.state === "closing") {
      throw new CutoverRefusedError2(
        `Cutover state is closing; new admissions refused for namespace ${options.namespace}`,
        { cutoverState: control.state, epoch: control.epoch }
      );
    }
    const forbiddenKindTerms = ["token", "password", "upstream", "secret", "auth_code"];
    if (forbiddenKindTerms.some((t) => options.kind.toLowerCase().includes(t))) {
      throw new CutoverFenceError2(`Operation kind must not contain sensitive credential terms: '${options.kind}'`);
    }
    if (options.metadata) {
      const allowedKeys = ["revision", "attempt", "phase", "reconciled"];
      for (const [key, value] of Object.entries(options.metadata)) {
        if (!allowedKeys.includes(key)) {
          throw new CutoverFenceError2(
            `Operation metadata key '${key}' is not in the allowlist (${allowedKeys.join(", ")})`
          );
        }
        if (key === "revision") {
          if (typeof value !== "string" || !/^[a-zA-Z0-9._-]{1,32}$/.test(value)) {
            throw new CutoverFenceError2(
              `Operation metadata 'revision' must be a safe identifier matching /^[a-zA-Z0-9._-]{1,32}$/, got '${String(value)}'`
            );
          }
        } else if (key === "phase") {
          if (typeof value !== "string" || !/^[a-zA-Z0-9._-]{1,32}$/.test(value)) {
            throw new CutoverFenceError2(
              `Operation metadata 'phase' must be a safe identifier matching /^[a-zA-Z0-9._-]{1,32}$/, got '${String(value)}'`
            );
          }
        } else if (key === "attempt") {
          if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100) {
            throw new CutoverFenceError2(
              `Operation metadata 'attempt' must be an integer between 1 and 100, got '${String(value)}'`
            );
          }
        } else if (key === "reconciled") {
          if (typeof value !== "boolean") {
            throw new CutoverFenceError2(
              `Operation metadata 'reconciled' must be a boolean, got '${String(value)}'`
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
      phase: "admitted",
      leaseOwner: randomUUID(),
      leaseExpiresAt: currentTime + (options.leaseMs ?? 3e4),
      createdAt: currentTime,
      updatedAt: currentTime,
      metadata: options.metadata
    };
    timer.assertUnderDeadline("withLegacyOperation admission reads");
    transaction.set(opRef, stripUndefined(createdRecord));
    transaction.set(
      controlRef,
      {
        activeOperations: control.activeOperations + 1,
        updatedAt: currentTime
      },
      { merge: true }
    );
    timer.assertUnderDeadline("withLegacyOperation complete");
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
    isAmbiguousRemoteOutcome: /* @__PURE__ */ __name(() => ambiguousOutcome, "isAmbiguousRemoteOutcome"),
    getAmbiguousReason: /* @__PURE__ */ __name(() => ambiguousReason, "getAmbiguousReason"),
    markAmbiguousRemoteOutcome: /* @__PURE__ */ __name((reason) => {
      ambiguousOutcome = true;
      ambiguousReason = reason;
    }, "markAmbiguousRemoteOutcome"),
    clearAmbiguousRemoteOutcome: /* @__PURE__ */ __name(() => {
      ambiguousOutcome = false;
      ambiguousReason = void 0;
    }, "clearAmbiguousRemoteOutcome"),
    isCompleted: /* @__PURE__ */ __name(() => completedLocally, "isCompleted"),
    markCompleted: /* @__PURE__ */ __name(() => {
      completedLocally = true;
    }, "markCompleted")
  };
  try {
    const result = await fn(ctx);
    if (!ctx.isCompleted() && !ctx.isAmbiguousRemoteOutcome()) {
      await releaseLegacyOperation(options.db, ctx, "completed", now);
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
              phase: "upstream_pending",
              ambiguousRemoteOutcome: true,
              ambiguousReason: ctx.getAmbiguousReason(),
              updatedAt: currentTime
            }),
            { merge: true }
          );
        });
      } catch (markErr) {
        if (err && typeof err === "object") {
          err.markAmbiguousError = markErr;
        }
      }
    } else if (!ctx.isCompleted()) {
      try {
        await releaseLegacyOperation(options.db, ctx, "failed", now);
      } catch (releaseErr) {
        if (err && typeof err === "object") {
          err.releaseError = releaseErr;
        }
      }
    }
    throw err;
  }
}
__name(withLegacyOperation, "withLegacyOperation");
async function releaseLegacyOperation(db, ctx, outcome = "completed", nowProvider = Date.now) {
  assertSupportedCutoverNamespace(ctx.namespace);
  if (outcome !== "completed" && outcome !== "failed") {
    throw new CutoverFenceError2(`Invalid outcome for release: ${outcome}`);
  }
  const controlRef = getCutoverFenceDocRef(db, ctx.namespace);
  const opRef = getCutoverOperationDocRef(db, ctx.namespace, ctx.id);
  const currentTime = nowProvider();
  await db.runTransaction(async (transaction) => {
    const timer = startMonotonicTimer();
    const controlSnap = await transaction.get(controlRef);
    const opSnap = await transaction.get(opRef);
    if (!controlSnap.exists) {
      throw new CutoverFenceError2(`Control record missing for namespace ${ctx.namespace}`);
    }
    if (!opSnap.exists) {
      throw new CutoverFenceError2(`Operation record missing for operation ${sanitizeId(ctx.id)}`);
    }
    const control = parseCutoverFenceRecord(controlSnap.data(), ctx.namespace);
    const opData = opSnap.data();
    if (opData.schemaVersion !== 1) {
      throw new CutoverFenceError2(`Invalid operation schemaVersion: expected 1, got ${opData.schemaVersion}`);
    }
    if (opData.id !== ctx.id || opData.operationId !== ctx.id) {
      throw new CutoverFenceError2("Operation id mismatch on release");
    }
    if (opData.namespace !== ctx.namespace) {
      throw new CutoverFenceError2(`Operation namespace mismatch: expected ${ctx.namespace}, got ${opData.namespace}`);
    }
    if (opData.kind !== ctx.kind) {
      throw new CutoverFenceError2(`Operation kind mismatch on release: expected ${ctx.kind}, got ${opData.kind}`);
    }
    if (opData.epoch !== ctx.epoch) {
      throw new CutoverFenceError2(
        `Epoch mismatch on release: context epoch ${ctx.epoch} != recorded epoch ${opData.epoch}`
      );
    }
    if (opData.phase === "completed" || opData.phase === "failed") {
      return;
    }
    if (opData.phase === "upstream_pending" || opData.ambiguousRemoteOutcome === true) {
      throw new CutoverFenceError2(
        `Cannot release operation ${sanitizeId(ctx.id)} in phase ${opData.phase}; pending or ambiguous claims must be resolved`
      );
    }
    if (control.activeOperations <= 0) {
      throw new CutoverFenceError2(
        `Active operations underflow in namespace ${ctx.namespace}: recorded count is ${control.activeOperations}`
      );
    }
    timer.assertUnderDeadline("releaseLegacyOperation reads");
    transaction.set(
      controlRef,
      {
        activeOperations: control.activeOperations - 1,
        updatedAt: currentTime
      },
      { merge: true }
    );
    transaction.set(
      opRef,
      stripUndefined({ phase: outcome, ambiguousRemoteOutcome: false, updatedAt: currentTime }),
      { merge: true }
    );
    timer.assertUnderDeadline("releaseLegacyOperation complete");
  });
  ctx.markCompleted();
}
__name(releaseLegacyOperation, "releaseLegacyOperation");
async function markOperationAmbiguous(db, ctx, nowProvider = Date.now) {
  assertSupportedCutoverNamespace(ctx.namespace);
  const opRef = getCutoverOperationDocRef(db, ctx.namespace, ctx.id);
  const currentTime = nowProvider();
  await db.runTransaction(async (transaction) => {
    const timer = startMonotonicTimer();
    const opSnap = await transaction.get(opRef);
    if (!opSnap.exists) {
      throw new CutoverFenceError2(`Operation record missing for operation ${sanitizeId(ctx.id)}`);
    }
    const opData = opSnap.data();
    if (opData.schemaVersion !== 1) {
      throw new CutoverFenceError2(`Invalid operation schemaVersion: expected 1, got ${opData.schemaVersion}`);
    }
    if (opData.id !== ctx.id || opData.operationId !== ctx.id) {
      throw new CutoverFenceError2("Operation id mismatch on mark ambiguous");
    }
    if (opData.namespace !== ctx.namespace) {
      throw new CutoverFenceError2(`Operation namespace mismatch on mark ambiguous`);
    }
    if (opData.kind !== ctx.kind) {
      throw new CutoverFenceError2(`Operation kind mismatch on mark ambiguous: expected ${ctx.kind}, got ${opData.kind}`);
    }
    if (opData.epoch !== ctx.epoch) {
      throw new CutoverFenceError2(
        `Epoch mismatch on mark ambiguous: context epoch ${ctx.epoch} != recorded epoch ${opData.epoch}`
      );
    }
    timer.assertUnderDeadline("markOperationAmbiguous reads");
    transaction.set(
      opRef,
      stripUndefined({
        phase: "upstream_pending",
        ambiguousRemoteOutcome: true,
        updatedAt: currentTime
      }),
      { merge: true }
    );
    timer.assertUnderDeadline("markOperationAmbiguous complete");
  });
}
__name(markOperationAmbiguous, "markOperationAmbiguous");
async function checkMutationGuardInTransaction(transaction, options) {
  const timer = startMonotonicTimer();
  assertSupportedCutoverNamespace(options.namespace);
  const control = await readCutoverFenceInTransaction(transaction, options.db, options.namespace);
  if (["fenced", "migrating", "v3_ready", "v3_active"].includes(control.state)) {
    throw new CutoverRefusedError2(
      `Cutover state is ${control.state}; mutations refused for namespace ${options.namespace}`,
      { cutoverState: control.state, epoch: control.epoch }
    );
  }
  if (!options.operation) {
    throw new CutoverFenceError2(
      `Durable operation context is required for guarded mutation in namespace ${options.namespace}`
    );
  }
  const opRef = getCutoverOperationDocRef(options.db, options.namespace, options.operation.id);
  const opSnap = await transaction.get(opRef);
  if (!opSnap.exists) {
    throw new CutoverFenceError2(
      `Durable operation record missing for ${sanitizeId(options.operation.id)} in namespace ${options.namespace}`
    );
  }
  const opRecord = opSnap.data();
  if (opRecord.schemaVersion !== 1) {
    throw new CutoverFenceError2(`Invalid operation schemaVersion: expected 1, got ${opRecord.schemaVersion}`);
  }
  if (opRecord.id !== options.operation.id || opRecord.operationId !== options.operation.id) {
    throw new CutoverFenceError2("Durable operation id mismatch");
  }
  if (opRecord.namespace !== options.namespace) {
    throw new CutoverFenceError2(`Durable operation namespace mismatch: expected ${options.namespace}, got ${opRecord.namespace}`);
  }
  if (opRecord.kind !== options.operation.kind) {
    throw new CutoverFenceError2(`Durable operation kind mismatch: expected ${options.operation.kind}, got ${opRecord.kind}`);
  }
  if (opRecord.epoch !== control.epoch) {
    throw new CutoverFenceError2(
      `Operation epoch mismatch: operation epoch ${opRecord.epoch} != control epoch ${control.epoch}`
    );
  }
  if (opRecord.phase !== "admitted" && opRecord.phase !== "upstream_pending") {
    throw new CutoverFenceError2(
      `Operation ${sanitizeId(options.operation.id)} is already in phase ${opRecord.phase}; cannot be reused`
    );
  }
  if (options.operation.isCompleted()) {
    throw new CutoverFenceError2(
      `Operation ${sanitizeId(options.operation.id)} was marked completed locally; cannot be reused`
    );
  }
  const completeOperation = options.completeOperation ?? true;
  let bufferedCompletionTime;
  return {
    control,
    operation: opRecord,
    bufferCompletion: /* @__PURE__ */ __name((now = (options.now ?? Date.now)()) => {
      timer.assertUnderDeadline("checkMutationGuardInTransaction bufferCompletion");
      if (!options.operation || !completeOperation) {
        return;
      }
      bufferedCompletionTime = now;
      transaction.set(
        opRef,
        stripUndefined({
          phase: "completed",
          ambiguousRemoteOutcome: false,
          updatedAt: bufferedCompletionTime
        }),
        { merge: true }
      );
      const controlRef = getCutoverFenceDocRef(options.db, options.namespace);
      if (control.activeOperations <= 0) {
        throw new CutoverFenceError2(
          `Active operations underflow in namespace ${options.namespace}: recorded count is ${control.activeOperations}`
        );
      }
      transaction.set(
        controlRef,
        {
          activeOperations: control.activeOperations - 1,
          updatedAt: bufferedCompletionTime
        },
        { merge: true }
      );
    }, "bufferCompletion"),
    onCommit: /* @__PURE__ */ __name(() => {
      if (bufferedCompletionTime !== void 0 && options.operation) {
        options.operation.markCompleted();
      }
    }, "onCommit")
  };
}
__name(checkMutationGuardInTransaction, "checkMutationGuardInTransaction");
async function isLegacyMutationPermittedInTransaction(transaction, db, namespace, operation) {
  const timer = startMonotonicTimer();
  assertSupportedCutoverNamespace(namespace);
  const control = await readCutoverFenceInTransaction(transaction, db, namespace);
  if (["fenced", "migrating", "v3_ready", "v3_active"].includes(control.state)) {
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
  if (opRecord.phase !== "admitted" && opRecord.phase !== "upstream_pending") {
    return { permitted: false, control };
  }
  timer.assertUnderDeadline("isLegacyMutationPermittedInTransaction");
  return { permitted: true, control };
}
__name(isLegacyMutationPermittedInTransaction, "isLegacyMutationPermittedInTransaction");
async function claimUpstreamGrantInTransaction(transaction, db, options) {
  const timer = startMonotonicTimer();
  const {
    namespace,
    epoch,
    familyId,
    operationId,
    claimOwner,
    expectedFamilyGeneration,
    expectedGrantVersion,
    expectedKind,
    leaseMs = 3e4,
    nowProvider = Date.now
  } = options;
  assertSupportedCutoverNamespace(namespace);
  const expectedCollection = `${namespace}_tokens_upstream`;
  const expectedFamilyCollection = `${namespace}_tokens_refresh_families`;
  const expectedRefreshCollection = `${namespace}_tokens_refresh`;
  if (options.collection !== void 0 && options.collection !== expectedCollection) {
    throw new CutoverFenceError2(`Invalid legacy collection override '${options.collection}': exact '${expectedCollection}' required`);
  }
  if (options.familyCollection !== void 0 && options.familyCollection !== expectedFamilyCollection) {
    throw new CutoverFenceError2(`Invalid legacy familyCollection override '${options.familyCollection}': exact '${expectedFamilyCollection}' required`);
  }
  if (options.refreshCollection !== void 0 && options.refreshCollection !== expectedRefreshCollection) {
    throw new CutoverFenceError2(`Invalid legacy refreshCollection override '${options.refreshCollection}': exact '${expectedRefreshCollection}' required`);
  }
  const collection = expectedCollection;
  const familyCollection = expectedFamilyCollection;
  const refreshCollection = expectedRefreshCollection;
  if (typeof epoch !== "number" || !Number.isInteger(epoch) || epoch < 1) {
    throw new CutoverFenceError2("epoch (positive integer) is required for claimUpstreamGrantInTransaction");
  }
  if (typeof familyId !== "string" || !familyId.trim()) {
    throw new CutoverFenceError2("familyId is required for claimUpstreamGrantInTransaction");
  }
  if (typeof operationId !== "string" || !operationId.trim()) {
    throw new CutoverFenceError2("operationId is required for claimUpstreamGrantInTransaction");
  }
  if (typeof claimOwner !== "string" || !claimOwner.trim()) {
    throw new CutoverFenceError2("claimOwner is required for claimUpstreamGrantInTransaction");
  }
  if (typeof expectedFamilyGeneration !== "number" || !Number.isInteger(expectedFamilyGeneration) || expectedFamilyGeneration < 1) {
    throw new CutoverFenceError2("expectedFamilyGeneration (positive integer) is required for claimUpstreamGrantInTransaction");
  }
  if (typeof expectedGrantVersion !== "number" || !Number.isInteger(expectedGrantVersion) || expectedGrantVersion < 1) {
    throw new CutoverFenceError2("expectedGrantVersion (positive integer) is required for claimUpstreamGrantInTransaction");
  }
  if (typeof expectedKind !== "string" || !expectedKind.trim()) {
    throw new CutoverFenceError2("expectedKind is required for claimUpstreamGrantInTransaction");
  }
  const now = nowProvider();
  const clampedLeaseMs = Math.max(5e3, Math.min(12e4, leaseMs));
  const control = await readCutoverFenceInTransaction(transaction, db, namespace);
  if (["fenced", "migrating", "v3_ready", "v3_active"].includes(control.state)) {
    throw new CutoverRefusedError2(
      `Cutover state is ${control.state}; upstream claim refused for namespace ${namespace}`,
      { cutoverState: control.state, epoch: control.epoch }
    );
  }
  if (epoch !== control.epoch) {
    throw new CutoverFenceError2(
      `Operation epoch mismatch for upstream claim in namespace ${namespace}: expected ${control.epoch}, got ${epoch}`
    );
  }
  const opRef = getCutoverOperationDocRef(db, namespace, operationId);
  const opSnap = await transaction.get(opRef);
  if (!opSnap.exists) {
    throw new CutoverFenceError2(`Durable operation record missing for upstream claim: ${sanitizeId(operationId)}`);
  }
  const opData = opSnap.data();
  if (opData.schemaVersion !== 1 || opData.id !== operationId || opData.operationId !== operationId) {
    throw new CutoverFenceError2("Operation id mismatch on record");
  }
  if (opData.namespace !== namespace) {
    throw new CutoverFenceError2(`Operation namespace mismatch: expected ${namespace}, got ${opData.namespace}`);
  }
  if (opData.kind !== expectedKind) {
    throw new CutoverFenceError2(`Operation kind mismatch: expected ${expectedKind}, got ${opData.kind}`);
  }
  if (opData.epoch !== control.epoch) {
    throw new CutoverFenceError2(`Operation record epoch mismatch: expected ${control.epoch}, got ${opData.epoch}`);
  }
  if (opData.phase !== "admitted") {
    throw new CutoverFenceError2(`Operation ${sanitizeId(operationId)} is in phase ${opData.phase}; claim refused`);
  }
  const familyRef = db.collection(familyCollection).doc(familyId);
  const familySnap = await transaction.get(familyRef);
  if (!familySnap.exists) {
    throw new CutoverFenceError2(`Family record missing for claim: ${sanitizeId(familyId)}`);
  }
  const family = familySnap.data();
  const actualFamilyGen = typeof family.generation === "number" ? family.generation : 1;
  if (typeof actualFamilyGen !== "number" || actualFamilyGen !== expectedFamilyGeneration) {
    throw new CutoverFenceError2(
      `Family generation mismatch: expected ${expectedFamilyGeneration}, got ${actualFamilyGen}`
    );
  }
  const activePointerId = family.currentRefreshToken;
  if (typeof activePointerId !== "string" || !activePointerId.trim()) {
    throw new CutoverFenceError2(`Family missing active refresh pointer: ${sanitizeId(familyId)}`);
  }
  const pointerRef = db.collection(refreshCollection).doc(activePointerId);
  const pointerSnap = await transaction.get(pointerRef);
  if (!pointerSnap.exists) {
    throw new CutoverFenceError2(`Active refresh pointer missing: ${sanitizeId(activePointerId)}`);
  }
  const pointer = pointerSnap.data();
  if (typeof pointer.familyId !== "string" || pointer.familyId !== familyId) {
    throw new CutoverFenceError2("Pointer family binding mismatch");
  }
  if (typeof pointer.status !== "string" || pointer.status !== "active") {
    throw new CutoverFenceError2(`Current refresh pointer is not active: ${pointer.status}`);
  }
  const grantRef = db.collection(collection).doc(familyId);
  const grantSnap = await transaction.get(grantRef);
  if (!grantSnap.exists) {
    throw new CutoverFenceError2(`Upstream grant missing for family: ${sanitizeId(familyId)}`);
  }
  const current = grantSnap.data();
  const actualGrantVersion = current.grantVersion ?? current.version ?? 1;
  if (actualGrantVersion !== expectedGrantVersion) {
    throw new CutoverFenceError2(`Grant version mismatch: expected ${expectedGrantVersion}, got ${actualGrantVersion}`);
  }
  const holdingOpId = current.ambiguousOperationId ?? current.operationId;
  if (holdingOpId && holdingOpId !== operationId) {
    const priorOpRef = getCutoverOperationDocRef(db, namespace, holdingOpId);
    const priorOpSnap = await transaction.get(priorOpRef);
    if (!priorOpSnap.exists) {
      throw new CutoverFenceError2(
        `Upstream grant is held by unknown operation ${sanitizeId(holdingOpId)}; fail closed`
      );
    }
    const priorOp = priorOpSnap.data();
    if (priorOp.phase === "upstream_pending" || priorOp.phase === "admitted" || priorOp.ambiguousRemoteOutcome) {
      throw new CutoverFenceError2(
        `Upstream grant is held by nonterminal operation ${sanitizeId(holdingOpId)} in phase ${priorOp.phase}; lease expiry cannot release nonterminal claims`
      );
    }
  }
  if (current.ambiguousRemoteOutcome || current.ambiguousOutcome) {
    throw new CutoverFenceError2(`Upstream grant for family ${sanitizeId(familyId)} has unresolved ambiguous outcome`);
  }
  const isLeaseActive = typeof current.leaseExpiresAt === "number" && current.leaseExpiresAt > now || typeof current.leaseUntil === "number" && current.leaseUntil > now;
  if (current.leaseOwner && isLeaseActive) {
    if (current.leaseOwner !== claimOwner || current.ambiguousOperationId !== operationId) {
      throw new CutoverFenceError2(`Upstream grant lease held by another claimant: ${current.leaseOwner}`);
    }
  }
  timer.assertUnderDeadline("claimUpstreamGrantInTransaction reads");
  transaction.set(
    opRef,
    stripUndefined({ phase: "upstream_pending", familyId, updatedAt: now }),
    { merge: true }
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
      updatedAt: now
    }),
    { merge: true }
  );
  timer.assertUnderDeadline("claimUpstreamGrantInTransaction complete");
  return {
    status: "claimed",
    familyId,
    operationId,
    claimOwner,
    familyGeneration: expectedFamilyGeneration,
    grantVersion: expectedGrantVersion,
    leaseExpiresAt: now + clampedLeaseMs,
    grant: current.grant ? { hasGrant: true, expiresAt: current.expiresAt } : null
  };
}
__name(claimUpstreamGrantInTransaction, "claimUpstreamGrantInTransaction");
async function reconcileUpstreamGrantInTransaction(transaction, db, options) {
  const timer = startMonotonicTimer();
  const {
    namespace,
    familyId,
    operationId,
    claimOwner,
    expectedFamilyGeneration,
    expectedGrantVersion,
    outcome,
    evidence,
    nowProvider = Date.now
  } = options;
  assertSupportedCutoverNamespace(namespace);
  const expectedCollection = `${namespace}_tokens_upstream`;
  if (options.collection !== void 0 && options.collection !== expectedCollection) {
    throw new CutoverFenceError2(`Invalid legacy collection override '${options.collection}': exact '${expectedCollection}' required`);
  }
  const collection = expectedCollection;
  if (typeof familyId !== "string" || !familyId.trim()) {
    throw new CutoverFenceError2("familyId is required for upstream reconciliation");
  }
  if (typeof operationId !== "string" || !operationId.trim()) {
    throw new CutoverFenceError2("operationId is required for upstream reconciliation");
  }
  if (typeof claimOwner !== "string" || !claimOwner.trim()) {
    throw new CutoverFenceError2("claimOwner is required for upstream reconciliation");
  }
  if (typeof expectedFamilyGeneration !== "number" || !Number.isInteger(expectedFamilyGeneration) || expectedFamilyGeneration < 1) {
    throw new CutoverFenceError2("expectedFamilyGeneration (positive integer) is required for upstream reconciliation");
  }
  if (typeof expectedGrantVersion !== "number" || !Number.isInteger(expectedGrantVersion) || expectedGrantVersion < 1) {
    throw new CutoverFenceError2("expectedGrantVersion (positive integer) is required for upstream reconciliation");
  }
  const now = nowProvider();
  const control = await readCutoverFenceInTransaction(transaction, db, namespace);
  if (["migrating", "v3_ready", "v3_active"].includes(control.state)) {
    throw new CutoverRefusedError2(
      `Cannot reconcile legacy upstream grant: cutover state is ${control.state}`,
      { cutoverState: control.state, epoch: control.epoch }
    );
  }
  const opRef = getCutoverOperationDocRef(db, namespace, operationId);
  const opSnap = await transaction.get(opRef);
  if (!opSnap.exists) {
    throw new CutoverFenceError2(`Operation record missing: ${sanitizeId(operationId)}`);
  }
  const opData = opSnap.data();
  if (opData.phase !== "upstream_pending") {
    throw new CutoverFenceError2(`Operation ${sanitizeId(operationId)} is in phase ${opData.phase}; expected upstream_pending`);
  }
  if (opData.familyId && opData.familyId !== familyId) {
    throw new CutoverFenceError2(`Operation family mismatch: expected ${sanitizeId(familyId)}, got ${sanitizeId(opData.familyId)}`);
  }
  const docRef = db.collection(collection).doc(familyId);
  const snap = await transaction.get(docRef);
  if (!snap.exists) {
    throw new CutoverFenceError2(`Upstream grant missing for family: ${sanitizeId(familyId)}`);
  }
  const current = snap.data();
  if (current.leaseOwner && current.leaseOwner !== claimOwner) {
    throw new CutoverFenceError2(`Claim owner mismatch: expected ${current.leaseOwner}, got ${claimOwner}`);
  }
  if (current.ambiguousOperationId && current.ambiguousOperationId !== operationId) {
    throw new CutoverFenceError2(`Ambiguous operation mismatch: expected ${current.ambiguousOperationId}, got ${operationId}`);
  }
  if (outcome === "transient_timeout") {
    const ALLOWED_AMBIGUOUS_REASONS = ["upstream_timeout", "upstream_gateway_timeout", "upstream_disconnect", "transport_error"];
    const safeReason = typeof evidence?.reason === "string" && ALLOWED_AMBIGUOUS_REASONS.includes(evidence.reason) ? evidence.reason : "upstream_timeout";
    timer.assertUnderDeadline("reconcileUpstreamGrantInTransaction reads");
    transaction.set(
      opRef,
      stripUndefined({
        phase: "upstream_pending",
        ambiguousRemoteOutcome: true,
        ambiguousReason: safeReason,
        updatedAt: now
      }),
      { merge: true }
    );
    transaction.set(
      docRef,
      stripUndefined({
        ambiguousOutcome: true,
        ambiguousOperationId: operationId,
        ambiguousReason: safeReason,
        ambiguousAt: now,
        leaseUntil: now + 6e4,
        leaseExpiresAt: now + 6e4,
        updatedAt: now
      }),
      { merge: true }
    );
    timer.assertUnderDeadline("reconcileUpstreamGrantInTransaction complete");
    return { status: "ambiguous_pending", operationId, familyId };
  }
  throw new CutoverFenceError2(
    `Upstream grant reconciliation refused: trusted provider recovery mechanism is not established; operation ${sanitizeId(operationId)} remains held in upstream_pending`
  );
}
__name(reconcileUpstreamGrantInTransaction, "reconcileUpstreamGrantInTransaction");
async function prepareMigrationInTransaction(transaction, db, options) {
  const timer = startMonotonicTimer();
  const { namespace, prepDoc } = options;
  assertSupportedCutoverNamespace(namespace);
  if (!options.storeKey || typeof options.storeKey !== "string" && !Buffer.isBuffer(options.storeKey) && !(options.storeKey instanceof Uint8Array)) {
    throw new CutoverFenceError2("storeKey is REQUIRED for prepareMigrationInTransaction");
  }
  const control = await readCutoverFenceInTransaction(transaction, db, namespace);
  const FieldPath = options.FieldPath;
  if (!FieldPath || typeof FieldPath.documentId !== "function") {
    throw new CutoverFenceError2("FieldPath with documentId() is REQUIRED for prepareMigrationInTransaction");
  }
  const docIdField = FieldPath.documentId();
  if (control.state === "migrating") {
    const prepRef2 = db.collection(`${namespace}_meta`).doc(`migration_prepared_${control.epoch}`);
    const prepSnap2 = await transaction.get(prepRef2);
    if (prepSnap2.exists && C(prepSnap2.data()) === C(prepDoc) && control.migrationRunId === prepDoc.migrationRunId) {
      return control;
    }
    throw new CutoverFenceError2(
      "Already migrating with different manifest or runId; immutable retry violation"
    );
  }
  if (control.state !== "fenced") {
    throw new CutoverFenceError2(`Cannot prepare migration: state must be 'fenced', got '${control.state}'`);
  }
  if (control.activeOperations !== 0) {
    throw new CutoverFenceError2(`Cannot prepare migration: activeOperations must be 0, got ${control.activeOperations}`);
  }
  const expectedPrepKeys = prepDoc.totalPhysicalRecords > 0 ? [...REQUIRED_PREPARED_MANIFEST_KEYS, ...NONEMPTY_PROJECTOR_KEYS] : REQUIRED_PREPARED_MANIFEST_KEYS;
  validateMapKeysExact(prepDoc, expectedPrepKeys, "prepared manifest");
  validateMigrationIdentityFields(prepDoc, namespace, control.epoch, prepDoc.migrationRunId);
  if (prepDoc.kind !== "prepared") {
    throw new CutoverFenceError2(`prepared manifest kind must be 'prepared', got '${prepDoc.kind}'`);
  }
  if (typeof prepDoc.preparedAt !== "number" || !Number.isInteger(prepDoc.preparedAt) || prepDoc.preparedAt <= 0) {
    throw new CutoverFenceError2("preparedAt must be a positive integer timestamp");
  }
  validateMapKeysExact(prepDoc.physicalCounts, PHYSICAL_COUNT_KEYS, "prepared physicalCounts");
  validateMapKeysExact(prepDoc.expectedTargetCounts, TARGET_COUNT_KEYS, "prepared expectedTargetCounts");
  validateMapKeysExact(prepDoc.classifications, CLASSIFICATION_KEYS, "prepared classifications");
  validateMapKeysExact(prepDoc.reasons, REASON_KEYS, "prepared reasons");
  const prepPhysicalSum = Object.values(prepDoc.physicalCounts).reduce((sum, n) => {
    if (!Number.isSafeInteger(n) || n < 0) throw new CutoverFenceError2("Invalid physical count");
    return sum + n;
  }, 0);
  if (prepPhysicalSum !== prepDoc.totalPhysicalRecords) {
    throw new CutoverFenceError2(
      `prepared totalPhysicalRecords must equal sum(physicalCounts): expected ${prepPhysicalSum}, got ${prepDoc.totalPhysicalRecords}`
    );
  }
  const prepClassSum = Object.values(prepDoc.classifications).reduce((sum, n) => {
    if (!Number.isSafeInteger(n) || n < 0) throw new CutoverFenceError2("Invalid classification count");
    return sum + n;
  }, 0);
  if (prepClassSum !== prepDoc.scanned || prepDoc.scanned !== prepDoc.candidateCommitments.length) {
    throw new CutoverFenceError2(
      "prepared classifications sum must equal scanned and candidateCommitments.length"
    );
  }
  validateCandidateCommitments(prepDoc.candidateCommitments, prepDoc, namespace, control.epoch, prepDoc.migrationRunId);
  const distinctColNames = getCutoverDistinctCollectionNames(namespace).distinct;
  const readStart = Date.now();
  const rawColSnaps = /* @__PURE__ */ new Map();
  for (const colName of distinctColNames) {
    const q = db.collection(colName).orderBy(docIdField);
    const snap = await transaction.get(q);
    rawColSnaps.set(colName, snap);
  }
  const readDurationMs = Date.now() - readStart;
  if (readDurationMs > FIRESTORE_TRANSACTION_READ_DEADLINE_MS) {
    throw new CutoverFenceError2(`Preparation read duration (${readDurationMs} ms) exceeds 16,000 ms lock deadline`);
  }
  const sourcePhysicalToKey = {
    [`${namespace}_tokens_refresh_families`]: "families",
    [`${namespace}_tokens`]: "tokens",
    [`${namespace}_tokens_refresh`]: "refresh",
    [`${namespace}_tokens_upstream`]: "upstream",
    [`${namespace}_auth_codes`]: "authCodes",
    [`${namespace}_resume_tokens`]: "resumeTokens",
    [`${namespace}_oauth_clients`]: "oauthClients",
    [`${namespace}_clients`]: "clients"
  };
  const targetPhysicalToKey = {
    [`${namespace}_refresh_families`]: "families",
    [`${namespace}_sessions`]: "tokens",
    [`${namespace}_refresh`]: "refresh",
    [`${namespace}_upstream`]: "upstream",
    [`${namespace}_auth_codes`]: "authCodes",
    [`${namespace}_resume_tokens`]: "resumeTokens",
    [`${namespace}_retired_refresh`]: "retiredRefreshTokens",
    [`${namespace}_oauth_clients`]: "oauthClients"
  };
  const sourceDocsByKey = /* @__PURE__ */ new Map();
  for (const k of PHYSICAL_COUNT_KEYS) sourceDocsByKey.set(k, []);
  const targetDocsByKey = /* @__PURE__ */ new Map();
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
  const existingTargetKeyedMap = /* @__PURE__ */ new Map();
  for (const [colKey, docs] of targetDocsByKey.entries()) {
    for (const d of docs) {
      const data = d.data() || {};
      if (colKey !== "oauthClients" && colKey !== "clients") {
        if (typeof data.id === "string" && data.id !== d.id) {
          throw new CutoverFenceError2(`Document ID mismatch in ${colKey}/${d.id}: stored id '${data.id}' != docId '${d.id}'`);
        }
      } else {
        if (typeof data.client_id === "string" && data.client_id !== d.id) {
          throw new CutoverFenceError2(`client_id mismatch in ${colKey}/${d.id}: stored client_id '${data.client_id}' != docId '${d.id}'`);
        }
      }
      const targetId = computeKeyedDocId(options.storeKey, "target-id", namespace, control.epoch, colKey, d.id);
      const recDigest = computeTargetRecordDigest(options.storeKey, namespace, control.epoch, colKey, targetId, data);
      existingTargetKeyedMap.set(`${colKey}:${targetId}`, { doc: d, rawId: d.id, recordDigest: recDigest, data: { ...data, id: d.id } });
    }
  }
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
        throw new CutoverFenceError2(
          `Candidate ${c.id} has partial retained target graph in Firestore (${existingTargetsForCandidate}/${c.targets.length}); must be all-or-none complete`
        );
      }
      for (const t of c.targets) {
        const targetKey = `${t.collection}:${t.id}`;
        const entry = existingTargetKeyedMap.get(targetKey);
        if (t.recordDigest && entry.recordDigest !== t.recordDigest) {
          throw new CutoverFenceError2(
            `Retained target '${targetKey}' for candidate ${c.id} is not equivalent to candidate target recordDigest`
          );
        }
      }
    }
  }
  const candidateTargetKeys = /* @__PURE__ */ new Set();
  for (const c of prepDoc.candidateCommitments) {
    for (const t of c.targets) {
      candidateTargetKeys.add(`${t.collection}:${t.id}`);
    }
  }
  for (const targetKey of existingTargetKeyedMap.keys()) {
    if (!candidateTargetKeys.has(targetKey)) {
      throw new CutoverFenceError2(`Cannot prepare migration: unexpected extra target '${targetKey}' exists prior to migration`);
    }
  }
  for (const k of PHYSICAL_COUNT_KEYS) {
    const actualCount = sourceDocsByKey.get(k).length;
    if (actualCount !== prepDoc.physicalCounts[k]) {
      throw new CutoverFenceError2(
        `Physical collection count mismatch for '${k}': Firestore has ${actualCount}, prepared manifest has ${prepDoc.physicalCounts[k]}`
      );
    }
  }
  const sourceKeyedMap = /* @__PURE__ */ new Map();
  const sourceDescriptors = [];
  for (const [colKey, docs] of sourceDocsByKey.entries()) {
    for (const d of docs) {
      const data = d.data() || {};
      if ((colKey === "families" || colKey === "resumeTokens") && typeof data.id === "string" && data.id !== d.id) {
        throw new CutoverFenceError2(`Document ID mismatch in ${colKey}/${d.id}: stored id '${data.id}' != docId '${d.id}'`);
      }
      if ((colKey === "oauthClients" || colKey === "clients") && typeof data.client_id === "string" && data.client_id !== d.id) {
        throw new CutoverFenceError2(`client_id mismatch in ${colKey}/${d.id}: stored client_id '${data.client_id}' != docId '${d.id}'`);
      }
      const sourceId = computeKeyedDocId(options.storeKey, "source-id", namespace, control.epoch, colKey, d.id);
      const recDigest = computeSourceRecordDigest(options.storeKey, namespace, control.epoch, colKey, sourceId, data);
      sourceKeyedMap.set(`${colKey}:${sourceId}`, { doc: d, rawId: d.id, recordDigest: recDigest, data: { ...data, id: d.id } });
      sourceDescriptors.push({ collection: colKey, id: sourceId, recordDigest: recDigest });
    }
  }
  const coveredSources = /* @__PURE__ */ new Set();
  for (const c of prepDoc.candidateCommitments) {
    for (const s of c.sources) {
      const entry = sourceKeyedMap.get(`${s.collection}:${s.id}`);
      if (!entry) {
        throw new CutoverFenceError2(`Candidate ${c.id} references source document '${s.collection}:${s.id}' not found in Firestore`);
      }
      if (entry.recordDigest !== s.recordDigest) {
        throw new CutoverFenceError2(`Candidate ${c.id} source recordDigest mismatch for '${s.collection}:${s.id}'`);
      }
      coveredSources.add(`${s.collection}:${s.id}`);
    }
  }
  for (const key of sourceKeyedMap.keys()) {
    if (!coveredSources.has(key)) {
      throw new CutoverFenceError2(`Extra source document '${key}' found in Firestore not partitioned into candidate commitments`);
    }
  }
  if (prepDoc.totalPhysicalRecords > 0) {
    if (prepDoc.projectorId !== APPROVED_GRAPH_PROJECTOR_ID || prepDoc.projectorVersion !== APPROVED_GRAPH_PROJECTOR_VERSION) {
      throw new CutoverFenceError2(
        `Projector identity mismatch: expected '${APPROVED_GRAPH_PROJECTOR_ID}' v${APPROVED_GRAPH_PROJECTOR_VERSION}, got '${prepDoc.projectorId}' v${prepDoc.projectorVersion}`
      );
    }
    const measuredProjectorDigest = getMeasuredProjectorDigest();
    if (prepDoc.projectorDigest !== measuredProjectorDigest) {
      throw new CutoverFenceError2(
        `Projector digest mismatch: manifest has ${prepDoc.projectorDigest}, deployed module byte SHA-256 is ${measuredProjectorDigest}`
      );
    }
    const codec = createCodec(options.storeKey);
    for (const c of prepDoc.candidateCommitments) {
      const sourcesMap = /* @__PURE__ */ new Map();
      if (c.kind === "pr56Families") {
        const famDesc = c.sources.find((s) => s.collection === "families");
        if (!famDesc) throw new CutoverFenceError2(`Candidate ${c.id} missing families descriptor in sources`);
        const e = sourceKeyedMap.get(`${famDesc.collection}:${famDesc.id}`);
        if (!e) throw new CutoverFenceError2(`Candidate ${c.id} missing families source document`);
        const famData = { ...e.data || {}, id: e.rawId };
        sourcesMap.set("families", famData);
        const activeRefDesc = c.sources.find((s) => {
          if (s.collection !== "refresh") return false;
          const entry = sourceKeyedMap.get(`refresh:${s.id}`);
          return entry && entry.rawId === famData.currentRefreshToken && entry.data?.status === "active";
        });
        if (!activeRefDesc) {
          throw new CutoverFenceError2(`Candidate ${c.id} missing active refresh descriptor in sources matching currentRefreshToken '${famData.currentRefreshToken}'`);
        }
        const re = sourceKeyedMap.get(`refresh:${activeRefDesc.id}`);
        if (!re) throw new CutoverFenceError2(`Candidate ${c.id} missing active refresh document in sourceKeyedMap`);
        sourcesMap.set("refresh", { ...re.data || {}, id: re.rawId });
        if (famData.previousRefreshToken) {
          const prevRefDesc = c.sources.find((s) => {
            if (s.collection !== "refresh") return false;
            const entry = sourceKeyedMap.get(`refresh:${s.id}`);
            return entry && entry.rawId === famData.previousRefreshToken && entry.data?.status === "consumed";
          });
          if (!prevRefDesc) {
            throw new CutoverFenceError2(`Candidate ${c.id} has previousRefreshToken '${famData.previousRefreshToken}' but missing previous refresh descriptor in sources`);
          }
          const pe = sourceKeyedMap.get(`refresh:${prevRefDesc.id}`);
          if (!pe) throw new CutoverFenceError2(`Candidate ${c.id} missing previous refresh document in sourceKeyedMap`);
          if (typeof pe.data?.consumedAt !== "number") {
            throw new CutoverFenceError2(`Candidate ${c.id} previous refresh document '${pe.rawId}' missing numeric consumedAt`);
          }
          sourcesMap.set("prevRefresh", { ...pe.data || {}, id: pe.rawId });
        }
        const upDesc = c.sources.find((s) => s.collection === "upstream");
        if (!upDesc) throw new CutoverFenceError2(`Candidate ${c.id} missing upstream descriptor in sources`);
        const ue = sourceKeyedMap.get(`${upDesc.collection}:${upDesc.id}`);
        if (!ue) throw new CutoverFenceError2(`Candidate ${c.id} missing upstream source document`);
        sourcesMap.set("upstream", { ...ue.data || {}, id: ue.rawId });
        const tokDesc = c.sources.find((s) => s.collection === "tokens");
        if (tokDesc) {
          const te = sourceKeyedMap.get(`${tokDesc.collection}:${tokDesc.id}`);
          if (te) sourcesMap.set("tokens", { ...te.data || {}, id: te.rawId });
        }
      } else if (c.kind === "baseFormatTokens") {
        const tokDesc = c.sources.find((s) => s.collection === "tokens");
        if (!tokDesc) throw new CutoverFenceError2(`Candidate ${c.id} missing tokens descriptor in sources`);
        const te = sourceKeyedMap.get(`${tokDesc.collection}:${tokDesc.id}`);
        if (!te) throw new CutoverFenceError2(`Candidate ${c.id} missing tokens source document`);
        sourcesMap.set("tokens", { ...te.data || {}, id: te.rawId });
        const refDesc = c.sources.find((s) => s.collection === "refresh");
        if (!refDesc) throw new CutoverFenceError2(`Candidate ${c.id} missing refresh descriptor in sources`);
        const re = sourceKeyedMap.get(`${refDesc.collection}:${refDesc.id}`);
        if (!re) throw new CutoverFenceError2(`Candidate ${c.id} missing refresh source document`);
        sourcesMap.set("refresh", { ...re.data || {}, id: re.rawId });
      } else if (c.kind === "authCodes") {
        const codeDesc = c.sources.find((s) => s.collection === "authCodes");
        if (!codeDesc) throw new CutoverFenceError2(`Candidate ${c.id} missing authCodes descriptor in sources`);
        const e = sourceKeyedMap.get(`${codeDesc.collection}:${codeDesc.id}`);
        if (!e) throw new CutoverFenceError2(`Candidate ${c.id} missing authCodes source document`);
        sourcesMap.set("authCodes", { ...e.data || {}, id: e.rawId });
      } else if (c.kind === "resumeTokens") {
        const resDesc = c.sources.find((s) => s.collection === "resumeTokens");
        if (!resDesc) throw new CutoverFenceError2(`Candidate ${c.id} missing resumeTokens descriptor in sources`);
        const e = sourceKeyedMap.get(`${resDesc.collection}:${resDesc.id}`);
        if (!e) throw new CutoverFenceError2(`Candidate ${c.id} missing resumeTokens source document`);
        sourcesMap.set("resumeTokens", { ...e.data || {}, id: e.rawId });
      } else if (c.kind === "clients") {
        const oauthDesc = c.sources.find((s) => s.collection === "oauthClients");
        const clientDesc = c.sources.find((s) => s.collection === "clients");
        const oauthEntry = oauthDesc ? sourceKeyedMap.get(`oauthClients:${oauthDesc.id}`) : null;
        const clientEntry = clientDesc ? sourceKeyedMap.get(`clients:${clientDesc.id}`) : null;
        if (oauthEntry && clientEntry) {
          const oData = oauthEntry.data || {};
          const cData = clientEntry.data || {};
          if (C(oData.redirect_uris || []) !== C(cData.redirect_uris || []) || oData.token_endpoint_auth_method !== cData.token_endpoint_auth_method) {
            throw new CutoverFenceError2(`Conflicting claims between clients and oauthClients for clientId ${clientEntry.rawId}`);
          }
          sourcesMap.set("clients", { ...cData, ...oData, id: clientEntry.rawId });
        } else if (oauthEntry) {
          sourcesMap.set("clients", { ...oauthEntry.data || {}, id: oauthEntry.rawId });
        } else if (clientEntry) {
          sourcesMap.set("clients", { ...clientEntry.data || {}, id: clientEntry.rawId });
        }
      }
      const sourceResult = projectSourceLogical(c, sourcesMap, codec);
      validateCandidateProjection(c.kind, c.id, sourceResult);
      const derivedSourceLogicalDigest = H(options.storeKey, "logical-record", namespace, control.epoch, [c.kind, sourceResult]);
      if (c.logicalDigest !== derivedSourceLogicalDigest) {
        throw new CutoverFenceError2(
          `Candidate ${c.id} logicalDigest mismatch with projector-derived source logical digest`
        );
      }
      const existingTargetsCount = c.targets.filter((t) => existingTargetKeyedMap.has(`${t.collection}:${t.id}`)).length;
      if (existingTargetsCount > 0) {
        const targetsMap = /* @__PURE__ */ new Map();
        if (c.kind === "pr56Families") {
          const famTarget = c.targets.find((t) => t.collection === "families");
          let famData;
          if (famTarget) {
            const e = existingTargetKeyedMap.get(`${famTarget.collection}:${famTarget.id}`);
            if (e) {
              famData = { ...e.data || {}, id: e.rawId };
              targetsMap.set("families", famData);
            }
          }
          const upTarget = c.targets.find((t) => t.collection === "upstream");
          if (upTarget) {
            const e = existingTargetKeyedMap.get(`${upTarget.collection}:${upTarget.id}`);
            if (e) targetsMap.set("upstream", { ...e.data || {}, id: e.rawId });
          }
          const sessTarget = c.targets.find((t) => t.collection === "tokens");
          if (sessTarget) {
            const e = existingTargetKeyedMap.get(`${sessTarget.collection}:${sessTarget.id}`);
            if (e) targetsMap.set("tokens", { ...e.data || {}, id: e.rawId });
          }
          const refreshTargets = c.targets.filter((t) => t.collection === "refresh");
          for (const t of refreshTargets) {
            const e = existingTargetKeyedMap.get(`refresh:${t.id}`);
            if (e) {
              if (famData && (e.rawId === famData.activeRefreshId && e.data?.status === "active")) {
                targetsMap.set("activeRefresh", { ...e.data || {}, id: e.rawId });
              } else if (famData && (e.rawId !== famData.activeRefreshId && e.data?.status === "consumed")) {
                targetsMap.set("prevRefresh", { ...e.data || {}, id: e.rawId });
              }
            }
          }
          if (!targetsMap.has("activeRefresh")) {
            throw new CutoverFenceError2(`Candidate ${c.id} missing active refresh target document matching activeRefreshId`);
          }
          if (famData && famData.previousRefreshToken && !targetsMap.has("prevRefresh")) {
            throw new CutoverFenceError2(`Candidate ${c.id} has previousRefreshToken but missing prevRefresh target document`);
          }
          const retiredTargets = c.targets.filter((t) => t.collection === "retiredRefreshTokens");
          const retiredIds = [];
          for (const t of retiredTargets) {
            const e = existingTargetKeyedMap.get(`retiredRefreshTokens:${t.id}`);
            if (!e) throw new CutoverFenceError2(`Candidate ${c.id} missing retiredRefreshTokens target document in Firestore`);
            if (e.data?.familyId !== famData?.id) throw new CutoverFenceError2(`Retired refresh token '${e.rawId}' familyId mismatch`);
            retiredIds.push(e.rawId);
          }
          targetsMap.set("retiredRefresh", { ids: retiredIds.sort(canonicalCompare) });
        } else if (c.kind === "baseFormatTokens") {
          const famTarget = c.targets.find((t) => t.collection === "families");
          if (famTarget) {
            const e = existingTargetKeyedMap.get(`${famTarget.collection}:${famTarget.id}`);
            if (e) targetsMap.set("families", { ...e.data || {}, id: e.rawId });
          }
          const upTarget = c.targets.find((t) => t.collection === "upstream");
          if (upTarget) {
            const e = existingTargetKeyedMap.get(`${upTarget.collection}:${upTarget.id}`);
            if (e) targetsMap.set("upstream", { ...e.data || {}, id: e.rawId });
          }
          const sessTarget = c.targets.find((t) => t.collection === "tokens");
          if (sessTarget) {
            const e = existingTargetKeyedMap.get(`${sessTarget.collection}:${sessTarget.id}`);
            if (e) targetsMap.set("tokens", { ...e.data || {}, id: e.rawId });
          }
          const refTarget = c.targets.find((t) => t.collection === "refresh");
          if (refTarget) {
            const e = existingTargetKeyedMap.get(`${refTarget.collection}:${refTarget.id}`);
            if (e) targetsMap.set("activeRefresh", { ...e.data || {}, id: e.rawId });
          }
        } else if (c.kind === "authCodes") {
          const codeTarget = c.targets.find((t) => t.collection === "authCodes");
          if (codeTarget) {
            const e = existingTargetKeyedMap.get(`${codeTarget.collection}:${codeTarget.id}`);
            if (e) targetsMap.set("authCodes", { ...e.data || {}, id: e.rawId });
          }
        } else if (c.kind === "resumeTokens") {
          const resTarget = c.targets.find((t) => t.collection === "resumeTokens");
          if (resTarget) {
            const e = existingTargetKeyedMap.get(`${resTarget.collection}:${resTarget.id}`);
            if (e) targetsMap.set("resumeTokens", { ...e.data || {}, id: e.rawId });
          }
        } else if (c.kind === "clients") {
          const clientTarget = c.targets.find((t) => t.collection === "oauthClients" || t.collection === "clients");
          if (clientTarget) {
            const e = existingTargetKeyedMap.get(`${clientTarget.collection}:${clientTarget.id}`);
            if (e) targetsMap.set("clients", { ...e.data || {}, id: e.rawId });
          }
        }
        const targetResult = projectTargetLogical(c, targetsMap, codec);
        validateCandidateProjection(c.kind, c.id, targetResult);
        const derivedTargetLogicalDigest = H(options.storeKey, "logical-record", namespace, control.epoch, [c.kind, targetResult]);
        if (derivedTargetLogicalDigest !== c.logicalDigest) {
          throw new CutoverFenceError2(
            `Retained target graph for candidate ${c.id} is not logically equivalent to candidate commitment`
          );
        }
      }
    }
  }
  const computedSourceInventory = computeSourceInventoryDigest(options.storeKey, namespace, control.epoch, sourceDescriptors);
  if (prepDoc.sourceInventoryDigest !== computedSourceInventory) {
    throw new CutoverFenceError2("prepared manifest sourceInventoryDigest does not match computed source inventory");
  }
  const sortedCandidateLogicalPairs = prepDoc.candidateCommitments.map((c) => [c.id, c.logicalDigest]).sort((a, b) => canonicalCompare(a[0], b[0]));
  const computedLogicalInventory = H(options.storeKey, "logical-inventory", namespace, control.epoch, sortedCandidateLogicalPairs);
  if (prepDoc.sourceLogicalDigest !== computedLogicalInventory) {
    throw new CutoverFenceError2("prepared manifest sourceLogicalDigest does not match computed logical inventory");
  }
  const allDocs = Array.from(rawColSnaps.values()).flatMap((s) => s.docs.map((d) => d.data()));
  validateMigrationPreflightLimits(prepDoc, { fullReadset: allDocs, readDurationMs });
  const prepRef = db.collection(`${namespace}_meta`).doc(`migration_prepared_${control.epoch}`);
  const prepSnap = await transaction.get(prepRef);
  if (prepSnap.exists) {
    const existing = prepSnap.data();
    if (C(existing) !== C(prepDoc)) {
      throw new CutoverFenceError2(
        "Prepared manifest already exists for this epoch with different content; immutable retry violation"
      );
    }
    return control;
  }
  timer.assertUnderDeadline("prepareMigrationInTransaction reads and verification");
  transaction.set(prepRef, stripUndefined(prepDoc));
  const controlRef = getCutoverFenceDocRef(db, namespace);
  const updatedControl = {
    ...control,
    state: "migrating",
    migrationRunId: prepDoc.migrationRunId,
    migrationManifestDigest: void 0,
    updatedAt: prepDoc.preparedAt
  };
  transaction.set(controlRef, stripUndefined(updatedControl));
  timer.assertUnderDeadline("prepareMigrationInTransaction complete");
  return updatedControl;
}
__name(prepareMigrationInTransaction, "prepareMigrationInTransaction");
async function finalizeMigrationInTransaction(transaction, db, options) {
  const timer = startMonotonicTimer();
  const { namespace, finalDoc, markerDoc } = options;
  assertSupportedCutoverNamespace(namespace);
  if (!options.storeKey || typeof options.storeKey !== "string" && !Buffer.isBuffer(options.storeKey) && !(options.storeKey instanceof Uint8Array)) {
    throw new CutoverFenceError2("storeKey is REQUIRED for finalizeMigrationInTransaction");
  }
  const control = await readCutoverFenceInTransaction(transaction, db, namespace);
  const FieldPath = options.FieldPath;
  if (!FieldPath || typeof FieldPath.documentId !== "function") {
    throw new CutoverFenceError2("FieldPath with documentId() is REQUIRED for finalizeMigrationInTransaction");
  }
  const docIdField = FieldPath.documentId();
  if (control.state === "v3_ready") {
    const finalRef2 = db.collection(`${namespace}_meta`).doc(`migration_manifest_${control.epoch}`);
    const markerRef2 = db.collection(`${namespace}_meta`).doc("v2_adopted");
    const finalSnap2 = await transaction.get(finalRef2);
    const markerSnap2 = await transaction.get(markerRef2);
    if (finalSnap2.exists && markerSnap2.exists && C(finalSnap2.data()) === C(finalDoc) && C(markerSnap2.data()) === C(markerDoc) && control.migrationManifestDigest === markerDoc.migrationManifestDigest) {
      return control;
    }
    throw new CutoverFenceError2(
      "Already in v3_ready state with different manifests; immutable retry violation"
    );
  }
  if (control.state !== "migrating") {
    throw new CutoverFenceError2(`Cannot finalize migration: state must be 'migrating', got '${control.state}'`);
  }
  if (control.activeOperations !== 0) {
    throw new CutoverFenceError2(`Cannot finalize migration: activeOperations must be 0, got ${control.activeOperations}`);
  }
  if (markerDoc.emptyNamespace !== true && !control.irreversible) {
    throw new CutoverFenceError2(
      `Cannot finalize migration for namespace ${namespace}: irreversible latch must be engaged before finalization`
    );
  }
  const prepRef = db.collection(`${namespace}_meta`).doc(`migration_prepared_${control.epoch}`);
  const prepSnap = await transaction.get(prepRef);
  if (!prepSnap.exists) {
    throw new CutoverFenceError2(`Cannot finalize migration: prepared manifest missing for epoch ${control.epoch}`);
  }
  const prep = prepSnap.data();
  const expectedFinalKeys = finalDoc.totalPhysicalRecords > 0 ? [...REQUIRED_FINAL_MANIFEST_KEYS, ...NONEMPTY_PROJECTOR_KEYS] : REQUIRED_FINAL_MANIFEST_KEYS;
  validateMapKeysExact(finalDoc, expectedFinalKeys, "final manifest");
  validateMigrationIdentityFields(finalDoc, namespace, control.epoch, control.migrationRunId);
  if (finalDoc.kind !== "final") {
    throw new CutoverFenceError2(`final manifest kind must be 'final', got '${finalDoc.kind}'`);
  }
  if (typeof finalDoc.completedAt !== "number" || !Number.isInteger(finalDoc.completedAt) || finalDoc.completedAt <= 0) {
    throw new CutoverFenceError2("final manifest completedAt must be a positive integer timestamp");
  }
  const expectedMarkerKeys = markerDoc.emptyNamespace !== true ? [...REQUIRED_OWNERSHIP_MARKER_KEYS, ...NONEMPTY_PROJECTOR_KEYS] : REQUIRED_OWNERSHIP_MARKER_KEYS;
  validateMapKeysExact(markerDoc, expectedMarkerKeys, "ownership marker");
  validateMigrationIdentityFields(markerDoc, namespace, control.epoch, control.migrationRunId);
  if (markerDoc.kind !== "ownership") {
    throw new CutoverFenceError2(`ownership marker kind must be 'ownership', got '${markerDoc.kind}'`);
  }
  if (typeof markerDoc.adoptedAt !== "number" || !Number.isInteger(markerDoc.adoptedAt) || markerDoc.adoptedAt <= 0) {
    throw new CutoverFenceError2("ownership marker adoptedAt must be a positive integer timestamp");
  }
  if (finalDoc.codeSha !== prep.codeSha || finalDoc.codeArtifact !== prep.codeArtifact || finalDoc.packageIntegrity !== prep.packageIntegrity || finalDoc.protocolDigest !== prep.protocolDigest || markerDoc.codeSha !== prep.codeSha || markerDoc.codeArtifact !== prep.codeArtifact || markerDoc.packageIntegrity !== prep.packageIntegrity || markerDoc.protocolDigest !== prep.protocolDigest) {
    throw new CutoverFenceError2("Provenance mismatch across prepared, final, and marker manifests");
  }
  const computedPreparedDigest = D("prepared", namespace, control.epoch, prep);
  if (finalDoc.preparedDigest !== computedPreparedDigest) {
    throw new CutoverFenceError2(
      `final manifest preparedDigest (${finalDoc.preparedDigest}) does not match computed prepared digest (${computedPreparedDigest})`
    );
  }
  if (markerDoc.preparedDigest !== computedPreparedDigest) {
    throw new CutoverFenceError2("ownership marker preparedDigest does not match computed prepared digest");
  }
  const computedFinalDigest = D("final", namespace, control.epoch, finalDoc);
  if (markerDoc.migrationManifestDigest !== computedFinalDigest) {
    throw new CutoverFenceError2(
      `ownership marker migrationManifestDigest (${markerDoc.migrationManifestDigest}) does not match computed final digest (${computedFinalDigest})`
    );
  }
  validateMapKeysExact(finalDoc.physicalCounts, PHYSICAL_COUNT_KEYS, "final physicalCounts");
  validateMapKeysExact(finalDoc.targetCounts, TARGET_COUNT_KEYS, "final targetCounts");
  validateMapKeysExact(finalDoc.classifications, CLASSIFICATION_KEYS, "final classifications");
  validateMapKeysExact(finalDoc.reasons, REASON_KEYS, "final reasons");
  if (finalDoc.errors !== 0) {
    throw new CutoverFenceError2(`Cannot finalize migration: final errors must be 0, got ${finalDoc.errors}`);
  }
  for (const [rKey, rVal] of Object.entries(finalDoc.reasons)) {
    if (rVal !== 0) {
      throw new CutoverFenceError2(`Cannot finalize migration: reason count '${rKey}' must be 0, got ${rVal}`);
    }
  }
  if (finalDoc.sourceLogicalDigest !== finalDoc.targetLogicalDigest) {
    throw new CutoverFenceError2("Cannot finalize migration: sourceLogicalDigest must equal targetLogicalDigest");
  }
  if (finalDoc.sourceInventoryDigest !== prep.sourceInventoryDigest) {
    throw new CutoverFenceError2("Cannot finalize migration: sourceInventoryDigest must match prepared");
  }
  if (finalDoc.sourceLogicalDigest !== prep.sourceLogicalDigest) {
    throw new CutoverFenceError2("Cannot finalize migration: sourceLogicalDigest must match prepared");
  }
  if (C(finalDoc.physicalCounts) !== C(prep.physicalCounts)) {
    throw new CutoverFenceError2("final physicalCounts do not match prepared physicalCounts");
  }
  if (C(finalDoc.targetCounts) !== C(prep.expectedTargetCounts)) {
    throw new CutoverFenceError2("final targetCounts do not match prepared expectedTargetCounts");
  }
  if (C(finalDoc.classifications) !== C(prep.classifications)) {
    throw new CutoverFenceError2("final classifications do not match prepared classifications");
  }
  if (C(finalDoc.reasons) !== C(prep.reasons)) {
    throw new CutoverFenceError2("final reasons do not match prepared reasons");
  }
  const finalPhysicalSum = Object.values(finalDoc.physicalCounts).reduce((sum, n) => sum + n, 0);
  if (finalPhysicalSum !== finalDoc.totalPhysicalRecords) {
    throw new CutoverFenceError2("final physicalCounts sum must equal totalPhysicalRecords");
  }
  const targetCountSum = Object.values(finalDoc.targetCounts).reduce((sum, n) => {
    if (!Number.isSafeInteger(n) || n < 0) throw new CutoverFenceError2("Invalid target count");
    return sum + n;
  }, 0);
  if (markerDoc.emptyNamespace === true) {
    if (finalDoc.totalPhysicalRecords !== 0 || finalDoc.scanned !== 0 || finalDoc.migrated !== 0 || finalDoc.skipped !== 0 || finalDoc.errors !== 0) {
      throw new CutoverFenceError2("Counts must be 0 for emptyNamespace final manifest");
    }
    if (prep.candidateCommitments.length !== 0) {
      throw new CutoverFenceError2("candidateCommitments must be empty for emptyNamespace");
    }
    if (targetCountSum !== 0) {
      throw new CutoverFenceError2("targetCounts sum must be 0 for emptyNamespace");
    }
    const emptySourceInventory = H(options.storeKey, "source-inventory", namespace, control.epoch, []);
    const emptyTargetInventory = H(options.storeKey, "target-inventory", namespace, control.epoch, []);
    const emptyLogicalInventory = H(options.storeKey, "logical-inventory", namespace, control.epoch, []);
    const emptyReceiptSet = D("receipt-set", namespace, control.epoch, []);
    if (prep.sourceInventoryDigest !== emptySourceInventory) {
      throw new CutoverFenceError2("Empty namespace requires canonical empty sourceInventoryDigest");
    }
    if (prep.sourceLogicalDigest !== emptyLogicalInventory) {
      throw new CutoverFenceError2("Empty namespace requires canonical empty sourceLogicalDigest");
    }
    if (finalDoc.targetInventoryDigest !== emptyTargetInventory) {
      throw new CutoverFenceError2("Empty namespace requires canonical empty targetInventoryDigest");
    }
    if (finalDoc.receiptSetDigest !== emptyReceiptSet) {
      throw new CutoverFenceError2("Empty namespace requires canonical empty receiptSetDigest");
    }
  } else {
    if (targetCountSum <= 0 && finalDoc.migrated > 0) {
      throw new CutoverFenceError2("targetCounts sum must be greater than 0 for non-empty namespace");
    }
  }
  const distinctColNames = getCutoverDistinctCollectionNames(namespace).distinct;
  const rawColSnaps = /* @__PURE__ */ new Map();
  for (const colName of distinctColNames) {
    const q = db.collection(colName).orderBy(docIdField);
    const snap = await transaction.get(q);
    rawColSnaps.set(colName, snap);
  }
  const receiptsCol = db.collection(`${namespace}_meta`);
  const lowerBound = `migration_receipt_${control.epoch}_`;
  const upperBound = `migration_receipt_${control.epoch}\``;
  const receiptsQuery = receiptsCol.orderBy(docIdField).startAt(lowerBound).endBefore(upperBound);
  const receiptsSnap = await transaction.get(receiptsQuery);
  const actualReceipts = receiptsSnap.docs.map((d) => {
    const expectedPrefix = `migration_receipt_${control.epoch}_`;
    if (!d.id.startsWith(expectedPrefix)) {
      throw new CutoverFenceError2(`Invalid receipt document ID: ${d.id}`);
    }
    const candidateIdSuffix = d.id.slice(expectedPrefix.length);
    const data = d.data();
    if (data.candidateId !== candidateIdSuffix) {
      throw new CutoverFenceError2(
        `Receipt document ID suffix mismatch: expected ${candidateIdSuffix}, got ${data.candidateId}`
      );
    }
    return data;
  });
  const sourcePhysicalToKey = {
    [`${namespace}_tokens_refresh_families`]: "families",
    [`${namespace}_tokens`]: "tokens",
    [`${namespace}_tokens_refresh`]: "refresh",
    [`${namespace}_tokens_upstream`]: "upstream",
    [`${namespace}_auth_codes`]: "authCodes",
    [`${namespace}_resume_tokens`]: "resumeTokens",
    [`${namespace}_oauth_clients`]: "oauthClients",
    [`${namespace}_clients`]: "clients"
  };
  const targetPhysicalToKey = {
    [`${namespace}_refresh_families`]: "families",
    [`${namespace}_sessions`]: "tokens",
    [`${namespace}_refresh`]: "refresh",
    [`${namespace}_upstream`]: "upstream",
    [`${namespace}_auth_codes`]: "authCodes",
    [`${namespace}_resume_tokens`]: "resumeTokens",
    [`${namespace}_retired_refresh`]: "retiredRefreshTokens",
    [`${namespace}_oauth_clients`]: "oauthClients"
  };
  const sourceDocsByKey = /* @__PURE__ */ new Map();
  for (const k of PHYSICAL_COUNT_KEYS) sourceDocsByKey.set(k, []);
  const targetDocsByKey = /* @__PURE__ */ new Map();
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
  const currentSourceKeyedMap = /* @__PURE__ */ new Map();
  for (const [colKey, docs] of sourceDocsByKey.entries()) {
    for (const d of docs) {
      const data = d.data() || {};
      if ((colKey === "families" || colKey === "resumeTokens") && typeof data.id === "string" && data.id !== d.id) {
        throw new CutoverFenceError2(`Document ID mismatch in ${colKey}/${d.id}: stored id '${data.id}' != docId '${d.id}'`);
      }
      if ((colKey === "oauthClients" || colKey === "clients") && typeof data.client_id === "string" && data.client_id !== d.id) {
        throw new CutoverFenceError2(`client_id mismatch in ${colKey}/${d.id}: stored client_id '${data.client_id}' != docId '${d.id}'`);
      }
      const sourceId = computeKeyedDocId(options.storeKey, "source-id", namespace, control.epoch, colKey, d.id);
      const recDigest = computeSourceRecordDigest(options.storeKey, namespace, control.epoch, colKey, sourceId, data);
      currentSourceKeyedMap.set(`${colKey}:${sourceId}`, { doc: d, rawId: d.id, recordDigest: recDigest, data: { ...data, id: d.id } });
    }
  }
  const currentTargetKeyedMap = /* @__PURE__ */ new Map();
  const targetDescriptors = [];
  for (const [colKey, docs] of targetDocsByKey.entries()) {
    for (const d of docs) {
      const data = d.data() || {};
      if (colKey !== "oauthClients" && colKey !== "clients") {
        if (typeof data.id === "string" && data.id !== d.id) {
          throw new CutoverFenceError2(`Document ID mismatch in ${colKey}/${d.id}: stored id '${data.id}' != docId '${d.id}'`);
        }
      } else {
        if (typeof data.client_id === "string" && data.client_id !== d.id) {
          throw new CutoverFenceError2(`client_id mismatch in ${colKey}/${d.id}: stored client_id '${data.client_id}' != docId '${d.id}'`);
        }
      }
      const targetId = computeKeyedDocId(options.storeKey, "target-id", namespace, control.epoch, colKey, d.id);
      const recDigest = computeTargetRecordDigest(options.storeKey, namespace, control.epoch, colKey, targetId, data);
      currentTargetKeyedMap.set(`${colKey}:${targetId}`, { doc: d, rawId: d.id, recordDigest: recDigest, data: { ...data, id: d.id } });
      targetDescriptors.push({ collection: colKey, id: targetId, recordDigest: recDigest });
    }
  }
  let writtenCount = 0;
  let retainedCount = 0;
  const receiptCandidateIds = /* @__PURE__ */ new Set();
  const candidateMap = new Map(prep.candidateCommitments.map((c) => [c.id, c]));
  const expectedWrittenTargets = /* @__PURE__ */ new Set();
  const retainedSources = /* @__PURE__ */ new Set();
  for (const r of actualReceipts) {
    validateReceipt(r, namespace, control.epoch, control.migrationRunId);
    if (r.disposition === "written") writtenCount++;
    if (r.disposition === "retained") retainedCount++;
    if (receiptCandidateIds.has(r.candidateId)) {
      throw new CutoverFenceError2(`Duplicate candidate receipt in finalization: ${r.candidateId}`);
    }
    receiptCandidateIds.add(r.candidateId);
    const c = candidateMap.get(r.candidateId);
    if (!c) {
      throw new CutoverFenceError2(`Receipt candidateId '${r.candidateId}' does not match any committed candidate`);
    }
    if (r.preparedDigest !== computedPreparedDigest) {
      throw new CutoverFenceError2(`Receipt preparedDigest mismatch for candidate ${r.candidateId}`);
    }
    const expectedCandDigest = D("candidate", namespace, control.epoch, c);
    if (r.candidateDigest !== expectedCandDigest) {
      throw new CutoverFenceError2(`Receipt candidateDigest mismatch for candidate ${r.candidateId}`);
    }
    if (r.logicalDigest !== c.logicalDigest) {
      throw new CutoverFenceError2(`Receipt logicalDigest mismatch for candidate ${r.candidateId}`);
    }
    const rSourceKeys = r.sourceAfter.map((s) => `${s.collection}:${s.id}`).sort(canonicalCompare);
    const cSourceKeys = c.sources.map((s) => `${s.collection}:${s.id}`).sort(canonicalCompare);
    if (rSourceKeys.length !== cSourceKeys.length || !rSourceKeys.every((k, idx) => k === cSourceKeys[idx])) {
      throw new CutoverFenceError2(`Receipt sourceAfter reference set mismatch for candidate ${r.candidateId}`);
    }
    const rTargetKeys = r.targetAfter.map((t) => `${t.collection}:${t.id}`).sort(canonicalCompare);
    const cTargetKeys = c.targets.map((t) => `${t.collection}:${t.id}`).sort(canonicalCompare);
    if (rTargetKeys.length !== cTargetKeys.length || !rTargetKeys.every((k, idx) => k === cTargetKeys[idx])) {
      throw new CutoverFenceError2(`Receipt targetAfter reference set mismatch for candidate ${r.candidateId}`);
    }
    for (const s of r.sourceAfter) {
      const entry = currentSourceKeyedMap.get(`${s.collection}:${s.id}`);
      if (s.recordDigest === null) {
        if (entry) {
          throw new CutoverFenceError2(`Source '${s.collection}:${s.id}' was marked deleted in receipt but still exists in Firestore`);
        }
      } else {
        if (!entry) {
          throw new CutoverFenceError2(`Source '${s.collection}:${s.id}' was marked retained in receipt but does not exist in Firestore`);
        }
        if (entry.recordDigest !== s.recordDigest) {
          throw new CutoverFenceError2(`Source '${s.collection}:${s.id}' recordDigest mismatch`);
        }
        retainedSources.add(`${s.collection}:${s.id}`);
      }
    }
    for (const t of r.targetAfter) {
      const targetKey = `${t.collection}:${t.id}`;
      expectedWrittenTargets.add(targetKey);
      const entry = currentTargetKeyedMap.get(targetKey);
      if (!entry) {
        throw new CutoverFenceError2(`Missing target document '${targetKey}' in Firestore`);
      }
      if (entry.recordDigest !== t.recordDigest) {
        throw new CutoverFenceError2(`Target document '${targetKey}' postimage recordDigest mismatch`);
      }
    }
  }
  for (const sourceKey of currentSourceKeyedMap.keys()) {
    if (!retainedSources.has(sourceKey)) {
      throw new CutoverFenceError2(`Extra source document '${sourceKey}' found in Firestore not accounted for as retained by receipts`);
    }
  }
  for (const targetKey of currentTargetKeyedMap.keys()) {
    if (!expectedWrittenTargets.has(targetKey)) {
      throw new CutoverFenceError2(`Extra target document '${targetKey}' found in Firestore not accounted for by receipts`);
    }
  }
  if (finalDoc.totalPhysicalRecords > 0) {
    if (finalDoc.projectorId !== prep.projectorId || finalDoc.projectorVersion !== prep.projectorVersion || finalDoc.projectorDigest !== prep.projectorDigest) {
      throw new CutoverFenceError2("Final manifest projector identity or digest does not match prepared manifest");
    }
    if (markerDoc.projectorId !== finalDoc.projectorId || markerDoc.projectorVersion !== finalDoc.projectorVersion || markerDoc.projectorDigest !== finalDoc.projectorDigest) {
      throw new CutoverFenceError2("Ownership marker projector identity or digest does not match final manifest");
    }
    const measuredProjectorDigest = getMeasuredProjectorDigest();
    if (finalDoc.projectorDigest !== measuredProjectorDigest) {
      throw new CutoverFenceError2(
        `Projector digest mismatch: manifest has ${finalDoc.projectorDigest}, deployed module byte SHA-256 is ${measuredProjectorDigest}`
      );
    }
    const codec = createCodec(options.storeKey);
    for (const r of actualReceipts) {
      const c = candidateMap.get(r.candidateId);
      const targetsMap = /* @__PURE__ */ new Map();
      if (c.kind === "pr56Families") {
        const famTarget = c.targets.find((t) => t.collection === "families");
        let famData;
        if (famTarget) {
          const e = currentTargetKeyedMap.get(`${famTarget.collection}:${famTarget.id}`);
          if (e) {
            famData = { ...e.data || {}, id: e.rawId };
            targetsMap.set("families", famData);
          }
        }
        const upTarget = c.targets.find((t) => t.collection === "upstream");
        if (upTarget) {
          const e = currentTargetKeyedMap.get(`${upTarget.collection}:${upTarget.id}`);
          if (e) targetsMap.set("upstream", { ...e.data || {}, id: e.rawId });
        }
        const sessTarget = c.targets.find((t) => t.collection === "tokens");
        if (sessTarget) {
          const e = currentTargetKeyedMap.get(`${sessTarget.collection}:${sessTarget.id}`);
          if (e) targetsMap.set("tokens", { ...e.data || {}, id: e.rawId });
        }
        const refreshTargets = c.targets.filter((t) => t.collection === "refresh");
        for (const t of refreshTargets) {
          const e = currentTargetKeyedMap.get(`refresh:${t.id}`);
          if (e) {
            if (famData && (e.rawId === famData.activeRefreshId && e.data?.status === "active")) {
              targetsMap.set("activeRefresh", { ...e.data || {}, id: e.rawId });
            } else if (famData && (e.rawId !== famData.activeRefreshId && e.data?.status === "consumed")) {
              targetsMap.set("prevRefresh", { ...e.data || {}, id: e.rawId });
            }
          }
        }
        if (!targetsMap.has("activeRefresh")) {
          throw new CutoverFenceError2(`Candidate ${c.id} missing active refresh target document matching activeRefreshId`);
        }
        if (famData && famData.previousRefreshToken && !targetsMap.has("prevRefresh")) {
          throw new CutoverFenceError2(`Candidate ${c.id} has previousRefreshToken but missing prevRefresh target document`);
        }
        const retiredTargets = c.targets.filter((t) => t.collection === "retiredRefreshTokens");
        const retiredIds = [];
        for (const t of retiredTargets) {
          const e = currentTargetKeyedMap.get(`retiredRefreshTokens:${t.id}`);
          if (!e) throw new CutoverFenceError2(`Candidate ${c.id} missing retiredRefreshTokens target document in Firestore`);
          if (e.data?.familyId !== famData?.id) throw new CutoverFenceError2(`Retired refresh token '${e.rawId}' familyId mismatch`);
          retiredIds.push(e.rawId);
        }
        targetsMap.set("retiredRefresh", { ids: retiredIds.sort(canonicalCompare) });
      } else if (c.kind === "baseFormatTokens") {
        const famTarget = c.targets.find((t) => t.collection === "families");
        if (famTarget) {
          const e = currentTargetKeyedMap.get(`${famTarget.collection}:${famTarget.id}`);
          if (e) targetsMap.set("families", { ...e.data || {}, id: e.rawId });
        }
        const upTarget = c.targets.find((t) => t.collection === "upstream");
        if (upTarget) {
          const e = currentTargetKeyedMap.get(`${upTarget.collection}:${upTarget.id}`);
          if (e) targetsMap.set("upstream", { ...e.data || {}, id: e.rawId });
        }
        const sessTarget = c.targets.find((t) => t.collection === "tokens");
        if (sessTarget) {
          const e = currentTargetKeyedMap.get(`${sessTarget.collection}:${sessTarget.id}`);
          if (e) targetsMap.set("tokens", { ...e.data || {}, id: e.rawId });
        }
        const refTarget = c.targets.find((t) => t.collection === "refresh");
        if (refTarget) {
          const e = currentTargetKeyedMap.get(`${refTarget.collection}:${refTarget.id}`);
          if (e) targetsMap.set("activeRefresh", { ...e.data || {}, id: e.rawId });
        }
      } else if (c.kind === "authCodes") {
        const codeTarget = c.targets.find((t) => t.collection === "authCodes");
        if (codeTarget) {
          const e = currentTargetKeyedMap.get(`${codeTarget.collection}:${codeTarget.id}`);
          if (e) targetsMap.set("authCodes", { ...e.data || {}, id: e.rawId });
        }
      } else if (c.kind === "resumeTokens") {
        const resTarget = c.targets.find((t) => t.collection === "resumeTokens");
        if (resTarget) {
          const e = currentTargetKeyedMap.get(`${resTarget.collection}:${resTarget.id}`);
          if (e) targetsMap.set("resumeTokens", { ...e.data || {}, id: e.rawId });
        }
      } else if (c.kind === "clients") {
        const clientTarget = c.targets.find((t) => t.collection === "oauthClients" || t.collection === "clients");
        if (clientTarget) {
          const e = currentTargetKeyedMap.get(`${clientTarget.collection}:${clientTarget.id}`);
          if (e) targetsMap.set("clients", { ...e.data || {}, id: e.rawId });
        }
      }
      const targetResult = projectTargetLogical(c, targetsMap, codec);
      validateCandidateProjection(c.kind, r.candidateId, targetResult);
      const derivedTargetLogicalDigest = H(options.storeKey, "logical-record", namespace, control.epoch, [c.kind, targetResult]);
      if (r.logicalDigest !== derivedTargetLogicalDigest) {
        throw new CutoverFenceError2(
          `Receipt ${r.candidateId} logicalDigest mismatch with projector-derived target logical digest`
        );
      }
    }
  }
  const computedTargetInventory = computeTargetInventoryDigest(options.storeKey, namespace, control.epoch, targetDescriptors);
  if (finalDoc.targetInventoryDigest !== computedTargetInventory) {
    throw new CutoverFenceError2("final manifest targetInventoryDigest does not match computed target inventory");
  }
  const sortedReceiptLogicalPairs = actualReceipts.map((r) => [r.candidateId, r.logicalDigest]).sort((a, b) => canonicalCompare(a[0], b[0]));
  const computedTargetLogical = H(options.storeKey, "logical-inventory", namespace, control.epoch, sortedReceiptLogicalPairs);
  if (finalDoc.targetLogicalDigest !== computedTargetLogical) {
    throw new CutoverFenceError2("final manifest targetLogicalDigest does not match computed logical inventory");
  }
  for (const k of TARGET_COUNT_KEYS) {
    const actualCount = targetDocsByKey.get(k).length;
    if (actualCount !== finalDoc.targetCounts[k]) {
      throw new CutoverFenceError2(
        `Target count mismatch on finalization for '${k}': Firestore has ${actualCount}, finalDoc has ${finalDoc.targetCounts[k]}`
      );
    }
  }
  if (finalDoc.migrated !== writtenCount) {
    throw new CutoverFenceError2(`migrated count mismatch: finalDoc has ${finalDoc.migrated}, receipts have ${writtenCount}`);
  }
  if (finalDoc.skipped !== retainedCount) {
    throw new CutoverFenceError2(`skipped count mismatch: finalDoc has ${finalDoc.skipped}, receipts have ${retainedCount}`);
  }
  if (finalDoc.scanned !== finalDoc.migrated + finalDoc.skipped) {
    throw new CutoverFenceError2("Cannot finalize migration: final scanned must equal migrated + skipped");
  }
  if (actualReceipts.length !== prep.scanned) {
    throw new CutoverFenceError2(`receipts count (${actualReceipts.length}) does not equal scanned (${prep.scanned})`);
  }
  const computedReceiptSetDigest = computeReceiptSetDigest(actualReceipts, namespace, control.epoch);
  if (finalDoc.receiptSetDigest !== computedReceiptSetDigest) {
    throw new CutoverFenceError2(
      `receiptSetDigest mismatch: expected ${finalDoc.receiptSetDigest}, computed ${computedReceiptSetDigest}`
    );
  }
  for (const c of prep.candidateCommitments) {
    if (!receiptCandidateIds.has(c.id)) {
      throw new CutoverFenceError2(`Missing receipt for committed candidate ${c.id}`);
    }
  }
  const finalRef = db.collection(`${namespace}_meta`).doc(`migration_manifest_${control.epoch}`);
  const markerRef = db.collection(`${namespace}_meta`).doc("v2_adopted");
  const finalSnap = await transaction.get(finalRef);
  if (finalSnap.exists && C(finalSnap.data()) !== C(finalDoc)) {
    throw new CutoverFenceError2("Final manifest already exists with different content; immutable retry violation");
  }
  const markerSnap = await transaction.get(markerRef);
  if (markerSnap.exists && C(markerSnap.data()) !== C(markerDoc)) {
    throw new CutoverFenceError2("Ownership marker already exists with different content; immutable retry violation");
  }
  timer.assertUnderDeadline("finalizeMigrationInTransaction reads and verification");
  transaction.set(finalRef, stripUndefined(finalDoc));
  transaction.set(markerRef, stripUndefined(markerDoc));
  const controlRef = getCutoverFenceDocRef(db, namespace);
  const updatedControl = {
    ...control,
    state: "v3_ready",
    emptyNamespace: markerDoc.emptyNamespace,
    migrationManifestDigest: markerDoc.migrationManifestDigest,
    irreversible: markerDoc.emptyNamespace === true ? false : control.irreversible,
    updatedAt: markerDoc.adoptedAt
  };
  transaction.set(controlRef, stripUndefined(updatedControl));
  timer.assertUnderDeadline("finalizeMigrationInTransaction complete");
  return updatedControl;
}
__name(finalizeMigrationInTransaction, "finalizeMigrationInTransaction");
async function activateMigrationInTransaction(transaction, db, options) {
  const timer = startMonotonicTimer();
  const { namespace, expectedEpoch, migrationRunId, migrationManifestDigest, codeArtifact, protocolDigest } = options;
  assertSupportedCutoverNamespace(namespace);
  if (!options.storeKey || typeof options.storeKey !== "string" && !Buffer.isBuffer(options.storeKey) && !(options.storeKey instanceof Uint8Array)) {
    throw new CutoverFenceError2("storeKey is REQUIRED for activateMigrationInTransaction");
  }
  const control = await readCutoverFenceInTransaction(transaction, db, namespace);
  const FieldPath = options.FieldPath;
  if (!FieldPath || typeof FieldPath.documentId !== "function") {
    throw new CutoverFenceError2("FieldPath with documentId() is REQUIRED for activateMigrationInTransaction");
  }
  const docIdField = FieldPath.documentId();
  if (control.state === "v3_active") {
    if (control.epoch !== expectedEpoch) {
      throw new CutoverFenceError2(`Activation epoch mismatch: expected ${expectedEpoch}, got ${control.epoch}`);
    }
    if (control.migrationRunId !== migrationRunId) {
      throw new CutoverFenceError2(
        `Already active control migrationRunId mismatch: expected ${migrationRunId}, got ${control.migrationRunId}`
      );
    }
    if (control.migrationManifestDigest !== migrationManifestDigest) {
      throw new CutoverFenceError2(
        `Already active control migrationManifestDigest mismatch: expected ${migrationManifestDigest}, got ${control.migrationManifestDigest}`
      );
    }
    if (control.codeArtifact !== codeArtifact) {
      throw new CutoverFenceError2(
        `Already active control codeArtifact mismatch: expected ${codeArtifact}, got ${control.codeArtifact}`
      );
    }
    const markerRef2 = db.collection(`${namespace}_meta`).doc("v2_adopted");
    const markerSnap2 = await transaction.get(markerRef2);
    if (!markerSnap2.exists) {
      throw new CutoverFenceError2("Already active but immutable migration marker is missing at v2_adopted");
    }
    const m2 = markerSnap2.data();
    const expectedMarkerKeys2 = m2.emptyNamespace !== true ? [...REQUIRED_OWNERSHIP_MARKER_KEYS, ...NONEMPTY_PROJECTOR_KEYS] : REQUIRED_OWNERSHIP_MARKER_KEYS;
    validateMapKeysExact(m2, expectedMarkerKeys2, "ownership marker");
    validateMigrationIdentityFields(m2, namespace, expectedEpoch, migrationRunId);
    if (m2.kind !== "ownership") {
      throw new CutoverFenceError2(`Already active marker kind must be 'ownership', got '${m2.kind}'`);
    }
    if (m2.codeArtifact !== codeArtifact || m2.protocolDigest !== protocolDigest || m2.migrationManifestDigest !== migrationManifestDigest) {
      throw new CutoverFenceError2("Already active immutable marker evidence mismatch");
    }
    const finalRef2 = db.collection(`${namespace}_meta`).doc(`migration_manifest_${expectedEpoch}`);
    const finalSnap2 = await transaction.get(finalRef2);
    if (!finalSnap2.exists) {
      throw new CutoverFenceError2(`Already active but immutable final manifest missing at migration_manifest_${expectedEpoch}`);
    }
    const f2 = finalSnap2.data();
    const expectedFinalKeys2 = f2.totalPhysicalRecords > 0 ? [...REQUIRED_FINAL_MANIFEST_KEYS, ...NONEMPTY_PROJECTOR_KEYS] : REQUIRED_FINAL_MANIFEST_KEYS;
    validateMapKeysExact(f2, expectedFinalKeys2, "final manifest");
    validateMigrationIdentityFields(f2, namespace, expectedEpoch, migrationRunId);
    if (f2.kind !== "final") {
      throw new CutoverFenceError2(`Already active final manifest kind must be 'final', got '${f2.kind}'`);
    }
    if (f2.codeArtifact !== codeArtifact || f2.protocolDigest !== protocolDigest || D("final", namespace, expectedEpoch, f2) !== migrationManifestDigest) {
      throw new CutoverFenceError2("Already active immutable final manifest evidence mismatch");
    }
    const prepRef2 = db.collection(`${namespace}_meta`).doc(`migration_prepared_${expectedEpoch}`);
    const prepSnap2 = await transaction.get(prepRef2);
    if (!prepSnap2.exists) {
      throw new CutoverFenceError2(`Already active but immutable prepared manifest missing at migration_prepared_${expectedEpoch}`);
    }
    const p2 = prepSnap2.data();
    const expectedPrepKeys2 = p2.totalPhysicalRecords > 0 ? [...REQUIRED_PREPARED_MANIFEST_KEYS, ...NONEMPTY_PROJECTOR_KEYS] : REQUIRED_PREPARED_MANIFEST_KEYS;
    validateMapKeysExact(p2, expectedPrepKeys2, "prepared manifest");
    validateMigrationIdentityFields(p2, namespace, expectedEpoch, migrationRunId);
    if (p2.kind !== "prepared") {
      throw new CutoverFenceError2(`Already active prep manifest kind must be 'prepared', got '${p2.kind}'`);
    }
    if (D("prepared", namespace, expectedEpoch, p2) !== f2.preparedDigest) {
      throw new CutoverFenceError2("Already active immutable prep manifest digest mismatch");
    }
    if (f2.totalPhysicalRecords > 0) {
      if (m2.projectorId !== f2.projectorId || m2.projectorVersion !== f2.projectorVersion || m2.projectorDigest !== f2.projectorDigest) {
        throw new CutoverFenceError2("Already active marker projector evidence mismatch with final manifest");
      }
      if (p2.projectorId !== f2.projectorId || p2.projectorVersion !== f2.projectorVersion || p2.projectorDigest !== f2.projectorDigest) {
        throw new CutoverFenceError2("Already active prep projector evidence mismatch with final manifest");
      }
    }
    const receiptsCol2 = db.collection(`${namespace}_meta`);
    const lowerBound2 = `migration_receipt_${expectedEpoch}_`;
    const upperBound2 = `migration_receipt_${expectedEpoch}\``;
    const receiptsSnap2 = await transaction.get(receiptsCol2.orderBy(docIdField).startAt(lowerBound2).endBefore(upperBound2));
    if (receiptsSnap2.size !== p2.scanned) {
      throw new CutoverFenceError2(`Already active receipts count (${receiptsSnap2.size}) does not equal scanned count (${p2.scanned})`);
    }
    const receipts = receiptsSnap2.docs.map((d) => {
      const data = d.data();
      validateReceipt(data, namespace, expectedEpoch, migrationRunId);
      return data;
    });
    if (computeReceiptSetDigest(receipts, namespace, expectedEpoch) !== f2.receiptSetDigest) {
      throw new CutoverFenceError2("Already active immutable receiptSetDigest mismatch");
    }
    return { status: "already_active", control };
  }
  const markerRef = db.collection(`${namespace}_meta`).doc("v2_adopted");
  const markerSnap = await transaction.get(markerRef);
  if (!markerSnap.exists) {
    throw new CutoverFenceError2(`Cannot activate: marker missing at ${namespace}_meta/v2_adopted`);
  }
  const m = markerSnap.data();
  const expectedMarkerKeys = m.emptyNamespace !== true ? [...REQUIRED_OWNERSHIP_MARKER_KEYS, ...NONEMPTY_PROJECTOR_KEYS] : REQUIRED_OWNERSHIP_MARKER_KEYS;
  validateMapKeysExact(m, expectedMarkerKeys, "ownership marker");
  validateMigrationIdentityFields(m, namespace, expectedEpoch, migrationRunId);
  if (m.kind !== "ownership") {
    throw new CutoverFenceError2(`marker kind must be 'ownership', got '${m.kind}'`);
  }
  if (m.codeArtifact !== codeArtifact) {
    throw new CutoverFenceError2(`Cannot activate: marker codeArtifact mismatch: expected ${codeArtifact}, got ${m.codeArtifact}`);
  }
  if (m.protocolDigest !== protocolDigest) {
    throw new CutoverFenceError2(`Cannot activate: marker protocolDigest mismatch: expected ${protocolDigest}, got ${m.protocolDigest}`);
  }
  if (m.migrationManifestDigest !== migrationManifestDigest) {
    throw new CutoverFenceError2("Cannot activate: marker migrationManifestDigest mismatch");
  }
  const finalRef = db.collection(`${namespace}_meta`).doc(`migration_manifest_${expectedEpoch}`);
  const finalSnap = await transaction.get(finalRef);
  if (!finalSnap.exists) {
    throw new CutoverFenceError2(`Cannot activate: final manifest missing at ${namespace}_meta/migration_manifest_${expectedEpoch}`);
  }
  const f = finalSnap.data();
  const expectedFinalKeys = f.totalPhysicalRecords > 0 ? [...REQUIRED_FINAL_MANIFEST_KEYS, ...NONEMPTY_PROJECTOR_KEYS] : REQUIRED_FINAL_MANIFEST_KEYS;
  validateMapKeysExact(f, expectedFinalKeys, "final manifest");
  validateMigrationIdentityFields(f, namespace, expectedEpoch, migrationRunId);
  if (f.kind !== "final") {
    throw new CutoverFenceError2(`Final manifest kind must be 'final', got '${f.kind}'`);
  }
  if (f.codeArtifact !== codeArtifact || f.protocolDigest !== protocolDigest) {
    throw new CutoverFenceError2("Cannot activate: final manifest codeArtifact or protocolDigest mismatch");
  }
  const computedFinalDigest = D("final", namespace, expectedEpoch, f);
  if (computedFinalDigest !== migrationManifestDigest) {
    throw new CutoverFenceError2(
      `Cannot activate: computed final digest (${computedFinalDigest}) does not match expected (${migrationManifestDigest})`
    );
  }
  const prepRef = db.collection(`${namespace}_meta`).doc(`migration_prepared_${expectedEpoch}`);
  const prepSnap = await transaction.get(prepRef);
  if (!prepSnap.exists) {
    throw new CutoverFenceError2(`Cannot activate: prepared manifest missing at ${namespace}_meta/migration_prepared_${expectedEpoch}`);
  }
  const p = prepSnap.data();
  const expectedPrepKeys = p.totalPhysicalRecords > 0 ? [...REQUIRED_PREPARED_MANIFEST_KEYS, ...NONEMPTY_PROJECTOR_KEYS] : REQUIRED_PREPARED_MANIFEST_KEYS;
  validateMapKeysExact(p, expectedPrepKeys, "prepared manifest");
  validateMigrationIdentityFields(p, namespace, expectedEpoch, migrationRunId);
  if (p.kind !== "prepared") {
    throw new CutoverFenceError2(`Prepared manifest kind must be 'prepared', got '${p.kind}'`);
  }
  const computedPrepDigest = D("prepared", namespace, expectedEpoch, p);
  if (computedPrepDigest !== f.preparedDigest) {
    throw new CutoverFenceError2("Cannot activate: prepared digest does not match final manifest preparedDigest");
  }
  if (f.totalPhysicalRecords > 0) {
    if (m.projectorId !== f.projectorId || m.projectorVersion !== f.projectorVersion || m.projectorDigest !== f.projectorDigest) {
      throw new CutoverFenceError2("Marker projector evidence mismatch with final manifest");
    }
    if (p.projectorId !== f.projectorId || p.projectorVersion !== f.projectorVersion || p.projectorDigest !== f.projectorDigest) {
      throw new CutoverFenceError2("Prepared manifest projector evidence mismatch with final manifest");
    }
  }
  const receiptsCol = db.collection(`${namespace}_meta`);
  const lowerBound = `migration_receipt_${expectedEpoch}_`;
  const upperBound = `migration_receipt_${expectedEpoch}\``;
  const receiptsQuery = receiptsCol.orderBy(docIdField).startAt(lowerBound).endBefore(upperBound);
  const receiptsSnap = await transaction.get(receiptsQuery);
  if (receiptsSnap.size !== p.scanned) {
    throw new CutoverFenceError2(
      `Cannot activate: receipt count (${receiptsSnap.size}) does not equal prepared scanned count (${p.scanned})`
    );
  }
  const activateReceipts = receiptsSnap.docs.map((d) => {
    const data = d.data();
    validateReceipt(data, namespace, expectedEpoch, migrationRunId);
    return data;
  });
  const computedRSD = computeReceiptSetDigest(activateReceipts, namespace, expectedEpoch);
  if (f.receiptSetDigest !== computedRSD) {
    throw new CutoverFenceError2(
      `Cannot activate: receiptSetDigest mismatch in Firestore receipts`
    );
  }
  const distinctColNames = getCutoverDistinctCollectionNames(namespace).distinct;
  const rawColSnaps = /* @__PURE__ */ new Map();
  for (const colName of distinctColNames) {
    const q = db.collection(colName).orderBy(docIdField);
    const snap = await transaction.get(q);
    rawColSnaps.set(colName, snap);
  }
  const targetPhysicalToKey = {
    [`${namespace}_refresh_families`]: "families",
    [`${namespace}_sessions`]: "tokens",
    [`${namespace}_refresh`]: "refresh",
    [`${namespace}_upstream`]: "upstream",
    [`${namespace}_auth_codes`]: "authCodes",
    [`${namespace}_resume_tokens`]: "resumeTokens",
    [`${namespace}_retired_refresh`]: "retiredRefreshTokens",
    [`${namespace}_oauth_clients`]: "oauthClients"
  };
  const targetDocsByKey = /* @__PURE__ */ new Map();
  for (const k of TARGET_COUNT_KEYS) targetDocsByKey.set(k, []);
  for (const [physicalName, snap] of rawColSnaps.entries()) {
    if (physicalName in targetPhysicalToKey) {
      const colKey = targetPhysicalToKey[physicalName];
      const isOverlap = physicalName.endsWith("_auth_codes") || physicalName.endsWith("_resume_tokens") || physicalName.endsWith("_oauth_clients");
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
  const currentTargetKeyedMap = /* @__PURE__ */ new Map();
  for (const [colKey, docs] of targetDocsByKey.entries()) {
    for (const d of docs) {
      const data = d.data() || {};
      if (colKey !== "oauthClients" && colKey !== "clients") {
        if (typeof data.id === "string" && data.id !== d.id) {
          throw new CutoverFenceError2(`Document ID mismatch in ${colKey}/${d.id}: stored id '${data.id}' != docId '${d.id}'`);
        }
      } else {
        if (typeof data.client_id === "string" && data.client_id !== d.id) {
          throw new CutoverFenceError2(`client_id mismatch in ${colKey}/${d.id}: stored client_id '${data.client_id}' != docId '${d.id}'`);
        }
      }
      const targetId = computeKeyedDocId(options.storeKey, "target-id", namespace, expectedEpoch, colKey, d.id);
      const recDigest = computeTargetRecordDigest(options.storeKey, namespace, expectedEpoch, colKey, targetId, data);
      currentTargetKeyedMap.set(`${colKey}:${targetId}`, { doc: d, rawId: d.id, recordDigest: recDigest, data: { ...data, id: d.id } });
    }
  }
  const expectedWrittenTargets = /* @__PURE__ */ new Set();
  for (const r of activateReceipts) {
    for (const t of r.targetAfter) {
      const targetKey = `${t.collection}:${t.id}`;
      expectedWrittenTargets.add(targetKey);
      const entry = currentTargetKeyedMap.get(targetKey);
      if (!entry) {
        throw new CutoverFenceError2(`Cannot activate: target document '${targetKey}' missing from Firestore`);
      }
      if (entry.recordDigest !== t.recordDigest) {
        throw new CutoverFenceError2(`Cannot activate: target document '${targetKey}' postimage recordDigest mismatch`);
      }
    }
  }
  for (const targetKey of currentTargetKeyedMap.keys()) {
    if (!expectedWrittenTargets.has(targetKey)) {
      throw new CutoverFenceError2(`Cannot activate: extra target document '${targetKey}' found in Firestore`);
    }
  }
  for (const k of TARGET_COUNT_KEYS) {
    const actualCount = targetDocsByKey.get(k).length;
    if (actualCount !== f.targetCounts[k]) {
      throw new CutoverFenceError2(
        `Cannot activate: target count mismatch for '${k}': Firestore has ${actualCount}, finalDoc has ${f.targetCounts[k]}`
      );
    }
  }
  if (f.errors !== 0) {
    throw new CutoverFenceError2("Cannot activate: final manifest errors must be 0");
  }
  for (const [rK, rV] of Object.entries(f.reasons)) {
    if (rV !== 0) {
      throw new CutoverFenceError2(`Cannot activate: final manifest reason '${rK}' must be 0, got ${rV}`);
    }
  }
  if (f.sourceLogicalDigest !== f.targetLogicalDigest) {
    throw new CutoverFenceError2("Cannot activate: sourceLogicalDigest must equal targetLogicalDigest");
  }
  if (C(f.targetCounts) !== C(p.expectedTargetCounts)) {
    throw new CutoverFenceError2("Cannot activate: final targetCounts must match prepared expectedTargetCounts");
  }
  if (control.state !== "v3_ready") {
    throw new CutoverFenceError2(`Cannot activate migration: state must be 'v3_ready', got '${control.state}'`);
  }
  if (control.activeOperations !== 0) {
    throw new CutoverFenceError2(`Cannot activate migration: activeOperations must be 0, got ${control.activeOperations}`);
  }
  if (control.emptyNamespace !== true && !control.irreversible) {
    throw new CutoverFenceError2("Cannot activate migration: irreversible latch must be true for non-empty namespace");
  }
  if (control.epoch !== expectedEpoch) {
    throw new CutoverFenceError2(`Activation epoch mismatch: expected ${expectedEpoch}, got ${control.epoch}`);
  }
  if (control.migrationRunId !== migrationRunId) {
    throw new CutoverFenceError2(`Activation runId mismatch: expected ${migrationRunId}, got ${control.migrationRunId}`);
  }
  if (control.migrationManifestDigest !== migrationManifestDigest) {
    throw new CutoverFenceError2(
      `Activation digest mismatch: expected ${migrationManifestDigest}, got ${control.migrationManifestDigest}`
    );
  }
  timer.assertUnderDeadline("activateMigrationInTransaction reads and verification");
  const controlRef = getCutoverFenceDocRef(db, namespace);
  const updatedControl = {
    ...control,
    state: "v3_active",
    epoch: control.epoch,
    emptyNamespace: control.emptyNamespace,
    irreversible: control.emptyNamespace === true ? false : control.irreversible,
    codeArtifact,
    codeSha: m.codeSha,
    updatedAt: Date.now()
  };
  transaction.set(controlRef, stripUndefined(updatedControl));
  timer.assertUnderDeadline("activateMigrationInTransaction complete");
  return { status: "activated", control: updatedControl };
}
__name(activateMigrationInTransaction, "activateMigrationInTransaction");
function assertValidMigrationContext(options) {
  if (!options || typeof options !== "object") {
    throw new CutoverFenceError2("MigrationContext must be a non-null object");
  }
  const REQUIRED_CONTEXT_FIELDS = [
    "db",
    "FieldPath",
    "key",
    "namespace",
    "expectedEpoch",
    "migrationRunId",
    "codeSha",
    "codeArtifact",
    "packageIntegrity",
    "protocolDigest"
  ];
  for (const field of REQUIRED_CONTEXT_FIELDS) {
    if (options[field] === void 0 || options[field] === null) {
      throw new CutoverFenceError2(`MigrationContext missing required field: ${field}`);
    }
  }
  if (typeof options.db !== "object" || typeof options.db.collection !== "function" || typeof options.db.runTransaction !== "function") {
    throw new CutoverFenceError2("MigrationContext db must be a Firestore-like object with collection and runTransaction methods");
  }
  if (typeof options.FieldPath !== "object" || typeof options.FieldPath.documentId !== "function") {
    throw new CutoverFenceError2("MigrationContext FieldPath must be an adapter object with documentId() method");
  }
  if (!Buffer.isBuffer(options.key) && !(options.key instanceof Uint8Array)) {
    throw new CutoverFenceError2("MigrationContext key must be a Uint8Array or Buffer");
  }
  if (options.key.length < 16) {
    throw new CutoverFenceError2("MigrationContext key must be at least 16 bytes");
  }
  assertSupportedCutoverNamespace(options.namespace);
  if (typeof options.expectedEpoch !== "number" || !Number.isInteger(options.expectedEpoch) || options.expectedEpoch < 1) {
    throw new CutoverFenceError2("MigrationContext expectedEpoch must be a positive integer");
  }
  if (typeof options.migrationRunId !== "string" || !options.migrationRunId.trim()) {
    throw new CutoverFenceError2("MigrationContext migrationRunId must be a non-empty string");
  }
  if (typeof options.codeSha !== "string" || !/^[0-9a-f]{40}$/.test(options.codeSha)) {
    throw new CutoverFenceError2("MigrationContext codeSha must be a 40-character lowercase hex string");
  }
  if (typeof options.codeArtifact !== "string" || !options.codeArtifact.trim()) {
    throw new CutoverFenceError2("MigrationContext codeArtifact must be a non-empty string");
  }
  if (typeof options.packageIntegrity !== "string" || !options.packageIntegrity.trim()) {
    throw new CutoverFenceError2("MigrationContext packageIntegrity must be a non-empty string");
  }
  if (typeof options.protocolDigest !== "string" || !/^[0-9a-f]{64}$/.test(options.protocolDigest)) {
    throw new CutoverFenceError2("MigrationContext protocolDigest must be a 64-character lowercase hex string");
  }
}
__name(assertValidMigrationContext, "assertValidMigrationContext");
async function inspectFirestoreLegacyMigration(options) {
  assertValidMigrationContext(options);
  const allowedKeys = /* @__PURE__ */ new Set([
    "db",
    "FieldPath",
    "key",
    "namespace",
    "expectedEpoch",
    "migrationRunId",
    "codeSha",
    "codeArtifact",
    "packageIntegrity",
    "protocolDigest"
  ]);
  for (const k of Object.keys(options)) {
    if (!allowedKeys.has(k)) {
      throw new CutoverFenceError2(`Unknown option '${k}' passed to inspectFirestoreLegacyMigration`);
    }
  }
  throw new CutoverFenceError2("inspectFirestoreLegacyMigration requires integration with S3 migration engine plan constructor");
}
__name(inspectFirestoreLegacyMigration, "inspectFirestoreLegacyMigration");
async function adoptFirestoreLegacyTokens(options) {
  assertValidMigrationContext(options);
  const allowedKeys = /* @__PURE__ */ new Set([
    "db",
    "FieldPath",
    "key",
    "namespace",
    "expectedEpoch",
    "migrationRunId",
    "codeSha",
    "codeArtifact",
    "packageIntegrity",
    "protocolDigest",
    "dryRun",
    "expectedSourceInventoryDigest"
  ]);
  for (const k of Object.keys(options)) {
    if (!allowedKeys.has(k)) {
      throw new CutoverFenceError2(`Unknown option '${k}' passed to adoptFirestoreLegacyTokens`);
    }
  }
  if (typeof options.dryRun !== "boolean") {
    throw new CutoverFenceError2("adoptFirestoreLegacyTokens requires boolean dryRun option");
  }
  if (typeof options.expectedSourceInventoryDigest !== "string" || !/^[0-9a-f]{64}$/.test(options.expectedSourceInventoryDigest)) {
    throw new CutoverFenceError2("adoptFirestoreLegacyTokens requires 64-character lowercase hex expectedSourceInventoryDigest");
  }
  throw new CutoverFenceError2("adoptFirestoreLegacyTokens requires integration with bundled S3 migration engine; fake success prohibited");
}
__name(adoptFirestoreLegacyTokens, "adoptFirestoreLegacyTokens");
async function activateFirestoreMigration(options) {
  assertValidMigrationContext(options);
  const allowedKeys = /* @__PURE__ */ new Set([
    "db",
    "FieldPath",
    "key",
    "namespace",
    "expectedEpoch",
    "migrationRunId",
    "codeSha",
    "codeArtifact",
    "packageIntegrity",
    "protocolDigest"
  ]);
  for (const k of Object.keys(options)) {
    if (!allowedKeys.has(k)) {
      throw new CutoverFenceError2(`Unknown option '${k}' passed to activateFirestoreMigration`);
    }
  }
  return await options.db.runTransaction(async (transaction) => {
    const finalRef = options.db.collection(`${options.namespace}_meta`).doc(`migration_manifest_${options.expectedEpoch}`);
    const finalSnap = await transaction.get(finalRef);
    if (!finalSnap.exists) {
      throw new CutoverFenceError2(`Final migration manifest missing at migration_manifest_${options.expectedEpoch}`);
    }
    const finalDoc = finalSnap.data();
    const migrationManifestDigest = D("final", options.namespace, options.expectedEpoch, finalDoc);
    const res = await activateMigrationInTransaction(transaction, options.db, {
      ...options,
      storeKey: options.key,
      migrationManifestDigest
    });
    return { status: res.status };
  });
}
__name(activateFirestoreMigration, "activateFirestoreMigration");
async function getFirestoreMigrationStatus(options) {
  assertValidMigrationContext(options);
  const allowedKeys = /* @__PURE__ */ new Set([
    "db",
    "FieldPath",
    "key",
    "namespace",
    "expectedEpoch",
    "migrationRunId",
    "codeSha",
    "codeArtifact",
    "packageIntegrity",
    "protocolDigest"
  ]);
  for (const k of Object.keys(options)) {
    if (!allowedKeys.has(k)) {
      throw new CutoverFenceError2(`Unknown option '${k}' passed to getFirestoreMigrationStatus`);
    }
  }
  const { db, namespace, expectedEpoch, migrationRunId, codeArtifact, protocolDigest } = options;
  const docRef = getCutoverFenceDocRef(db, namespace);
  const snap = await docRef.get();
  if (!snap.exists) {
    throw new CutoverFenceError2(`Cutover fence control record missing for namespace '${namespace}'`);
  }
  const control = parseCutoverFenceRecord(snap.data(), namespace);
  if (control.state === "v3_ready" || control.state === "v3_active") {
    if (control.epoch !== expectedEpoch) {
      throw new CutoverFenceError2(`Status epoch mismatch: expected ${expectedEpoch}, got ${control.epoch}`);
    }
    const markerRef = db.collection(`${namespace}_meta`).doc("v2_adopted");
    const markerSnap = await markerRef.get();
    if (!markerSnap.exists) {
      throw new CutoverFenceError2("Immutable migration marker missing at v2_adopted");
    }
    const marker = markerSnap.data();
    validateMigrationIdentityFields(marker, namespace, expectedEpoch, migrationRunId);
    if (marker.codeArtifact !== codeArtifact || marker.protocolDigest !== protocolDigest) {
      throw new CutoverFenceError2("Immutable migration marker artifact/protocolDigest mismatch");
    }
  }
  return control;
}
__name(getFirestoreMigrationStatus, "getFirestoreMigrationStatus");

// src/store/firestore-migration-engine.ts
function assertValidMigrationContext2(options) {
  if (!options || typeof options !== "object") {
    throw new CutoverFenceError("MigrationContext must be an object");
  }
  const opts = options;
  const requiredFields = [
    "db",
    "FieldPath",
    "key",
    "namespace",
    "expectedEpoch",
    "migrationRunId",
    "codeSha",
    "codeArtifact",
    "packageIntegrity",
    "protocolDigest",
    "assemblyDigest",
    "indexSchemaDigest"
  ];
  for (const field of requiredFields) {
    if (opts[field] === void 0 || opts[field] === null) {
      throw new CutoverFenceError(`MigrationContext missing required field: ${field}`);
    }
  }
  if (typeof opts.db !== "object" || typeof opts.db.collection !== "function" || typeof opts.db.runTransaction !== "function") {
    throw new CutoverFenceError("MigrationContext db must be a Firestore-like object with collection and runTransaction methods");
  }
  if (typeof opts.FieldPath !== "object" || typeof opts.FieldPath.documentId !== "function") {
    throw new CutoverFenceError("MigrationContext FieldPath must be an adapter object with documentId() method");
  }
  if (!Buffer.isBuffer(opts.key) && !(opts.key instanceof Uint8Array)) {
    throw new CutoverFenceError("MigrationContext key must be a Uint8Array or Buffer");
  }
  if (opts.key.length < 16) {
    throw new CutoverFenceError("MigrationContext key must be at least 16 bytes");
  }
  assertSupportedCutoverNamespace(opts.namespace);
  if (typeof opts.expectedEpoch !== "number" || !Number.isInteger(opts.expectedEpoch) || opts.expectedEpoch < 1) {
    throw new CutoverFenceError("MigrationContext expectedEpoch must be a positive integer");
  }
  if (typeof opts.migrationRunId !== "string" || !opts.migrationRunId.trim()) {
    throw new CutoverFenceError("MigrationContext migrationRunId must be a non-empty string");
  }
  if (typeof opts.codeSha !== "string" || !/^[0-9a-f]{40}$/.test(opts.codeSha)) {
    throw new CutoverFenceError("MigrationContext codeSha must be a 40-character lowercase hex string");
  }
  if (typeof opts.codeArtifact !== "string" || !opts.codeArtifact.trim()) {
    throw new CutoverFenceError("MigrationContext codeArtifact must be a non-empty string");
  }
  if (typeof opts.packageIntegrity !== "string" || !opts.packageIntegrity.trim()) {
    throw new CutoverFenceError("MigrationContext packageIntegrity must be a non-empty string");
  }
  if (typeof opts.protocolDigest !== "string" || !/^[0-9a-f]{64}$/.test(opts.protocolDigest)) {
    throw new CutoverFenceError("MigrationContext protocolDigest must be a 64-character lowercase hex string");
  }
  if (typeof opts.assemblyDigest !== "string" || !/^[0-9a-f]{64}$/.test(opts.assemblyDigest)) {
    throw new CutoverFenceError("MigrationContext assemblyDigest must be a 64-character lowercase hex string");
  }
  if (typeof opts.indexSchemaDigest !== "string" || !/^[0-9a-f]{64}$/.test(opts.indexSchemaDigest)) {
    throw new CutoverFenceError("MigrationContext indexSchemaDigest must be a 64-character lowercase hex string");
  }
}
__name(assertValidMigrationContext2, "assertValidMigrationContext");
function computeDocDepth(obj, currentDepth = 1) {
  if (!obj || typeof obj !== "object" || obj instanceof Date) return currentDepth;
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
__name(computeDocDepth, "computeDocDepth");
function countIndexMetrics2(val) {
  let entries = 0;
  let bytes = 0;
  function traverse(v, pathLen = 0) {
    if (v === null || typeof v === "boolean" || typeof v === "number" || typeof v === "string" || v instanceof Date) {
      entries += 2;
      bytes += pathLen + 8;
    } else if (Array.isArray(v)) {
      for (const item of v) {
        entries += 1;
        bytes += pathLen + 8;
        traverse(item, pathLen);
      }
    } else if (v && typeof v === "object") {
      for (const [k, child] of Object.entries(v)) {
        traverse(child, pathLen + Buffer.byteLength(k, "utf8") + 1);
      }
    }
  }
  __name(traverse, "traverse");
  traverse(val);
  return { entries, bytes };
}
__name(countIndexMetrics2, "countIndexMetrics");
function computeCandidateId(storeKey, namespace, epoch, kind2, sortedSourceIds) {
  return H(storeKey, "candidate-id", namespace, epoch, [kind2, sortedSourceIds]);
}
__name(computeCandidateId, "computeCandidateId");
function computeCandidateLogicalDigest(storeKey, namespace, epoch, kind2, logicalProjection) {
  return H(storeKey, "logical-record", namespace, epoch, [kind2, logicalProjection]);
}
__name(computeCandidateLogicalDigest, "computeCandidateLogicalDigest");
function extractCandidatesAndPlan(params) {
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
    assemblyDigest,
    indexSchemaDigest,
    now
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
  const familiesDocs = sourceDocsByKey.get("families") || [];
  const tokensDocs = sourceDocsByKey.get("tokens") || [];
  const refreshDocs = sourceDocsByKey.get("refresh") || [];
  const upstreamDocs = sourceDocsByKey.get("upstream") || [];
  const authCodesDocs = sourceDocsByKey.get("authCodes") || [];
  const resumeDocs = sourceDocsByKey.get("resumeTokens") || [];
  const oauthClientsDocs = sourceDocsByKey.get("oauthClients") || [];
  const clientsDocs = sourceDocsByKey.get("clients") || [];
  const familiesById = /* @__PURE__ */ new Map();
  for (const d of familiesDocs) familiesById.set(d.id, d.data() || {});
  const tokensById = /* @__PURE__ */ new Map();
  for (const d of tokensDocs) tokensById.set(d.id, d.data() || {});
  const refreshById = /* @__PURE__ */ new Map();
  for (const d of refreshDocs) refreshById.set(d.id, d.data() || {});
  const upstreamById = /* @__PURE__ */ new Map();
  for (const d of upstreamDocs) upstreamById.set(d.id, d.data() || {});
  const candidates = [];
  const candidateCommitments = [];
  const claimedAccessIds = /* @__PURE__ */ new Set();
  const claimedRefreshIds = /* @__PURE__ */ new Set();
  const claimedRetiredFingerprints = /* @__PURE__ */ new Set();
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
    if (curRefFamId !== familyId || curRefDoc.status !== "active") {
      reasons.malformedRecords++;
      continue;
    }
    if (claimedRefreshIds.has(currentRefId)) {
      reasons.conflictingClaims++;
      continue;
    }
    claimedRefreshIds.add(currentRefId);
    const accessId = famData.currentAccessToken ?? curRefDoc.token?.accessToken;
    if (!accessId || typeof accessId !== "string" || !accessId.trim()) {
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
    const rawRetired = Array.isArray(famData.retiredRefreshFingerprints) ? famData.retiredRefreshFingerprints : Array.isArray(famData.retiredTokens) ? famData.retiredTokens : [];
    const retiredFingerprints = Array.from(new Set(rawRetired.filter((fp) => typeof fp === "string" && fp.length > 0)));
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
    const newAccessId = codec.id("session", accessId);
    const newRefreshId = codec.id("refresh", currentRefId);
    const candSources = [
      {
        collection: "families",
        id: computeKeyedDocId(storeKey, "source-id", namespace, epoch, "families", familyId),
        rawId: familyId,
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, "families", computeKeyedDocId(storeKey, "source-id", namespace, epoch, "families", familyId), famData)
      },
      {
        collection: "refresh",
        id: computeKeyedDocId(storeKey, "source-id", namespace, epoch, "refresh", currentRefId),
        rawId: currentRefId,
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, "refresh", computeKeyedDocId(storeKey, "source-id", namespace, epoch, "refresh", currentRefId), curRefDoc)
      },
      {
        collection: "upstream",
        id: computeKeyedDocId(storeKey, "source-id", namespace, epoch, "upstream", familyId),
        rawId: familyId,
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, "upstream", computeKeyedDocId(storeKey, "source-id", namespace, epoch, "upstream", familyId), upstreamById.get(familyId))
      },
      {
        collection: "tokens",
        id: computeKeyedDocId(storeKey, "source-id", namespace, epoch, "tokens", accessId),
        rawId: accessId,
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, "tokens", computeKeyedDocId(storeKey, "source-id", namespace, epoch, "tokens", accessId), tokensById.get(accessId) || {})
      }
    ];
    if (famData.previousRefreshToken) {
      const prevId = famData.previousRefreshToken;
      const prevDoc = refreshById.get(prevId) || {};
      candSources.push({
        collection: "refresh",
        id: computeKeyedDocId(storeKey, "source-id", namespace, epoch, "refresh", prevId),
        rawId: prevId,
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, "refresh", computeKeyedDocId(storeKey, "source-id", namespace, epoch, "refresh", prevId), prevDoc)
      });
    }
    candSources.sort(compareDescriptors);
    const famTargetId = computeKeyedDocId(storeKey, "target-id", namespace, epoch, "families", familyId);
    const accTargetId = computeKeyedDocId(storeKey, "target-id", namespace, epoch, "tokens", newAccessId);
    const refTargetId = computeKeyedDocId(storeKey, "target-id", namespace, epoch, "refresh", newRefreshId);
    const upTargetId = computeKeyedDocId(storeKey, "target-id", namespace, epoch, "upstream", familyId);
    const candTargets = [
      { collection: "families", id: famTargetId, rawId: familyId },
      { collection: "tokens", id: accTargetId, rawId: newAccessId },
      { collection: "refresh", id: refTargetId, rawId: newRefreshId },
      { collection: "upstream", id: upTargetId, rawId: familyId }
    ];
    let prevRefTargetId;
    if (famData.previousRefreshToken) {
      const prevRefId = codec.id("refresh", famData.previousRefreshToken);
      prevRefTargetId = computeKeyedDocId(storeKey, "target-id", namespace, epoch, "refresh", prevRefId);
      candTargets.push({ collection: "refresh", id: prevRefTargetId, rawId: prevRefId });
    }
    for (const fp of retiredFingerprints) {
      const retTgtId = computeKeyedDocId(storeKey, "target-id", namespace, epoch, "retiredRefreshTokens", fp);
      candTargets.push({ collection: "retiredRefreshTokens", id: retTgtId, rawId: fp });
    }
    candTargets.sort(compareDescriptors);
    const sortedSourceIds = candSources.map((s) => s.id).sort(codeUnitCompare);
    const candidateId = computeCandidateId(storeKey, namespace, epoch, "pr56Families", sortedSourceIds);
    const sourcesMap = /* @__PURE__ */ new Map();
    sourcesMap.set("families", safeDocEntry(familyId, famData));
    sourcesMap.set("refresh", safeDocEntry(currentRefId, curRefDoc));
    sourcesMap.set("upstream", safeDocEntry(familyId, upstreamById.get(familyId)));
    sourcesMap.set("tokens", safeDocEntry(accessId, tokensById.get(accessId) || {}));
    if (famData.previousRefreshToken) {
      const prevId = famData.previousRefreshToken;
      sourcesMap.set("prevRefresh", safeDocEntry(prevId, refreshById.get(prevId) || {}));
    }
    const logicalProjection = projectSourceLogical(
      { id: candidateId, kind: "pr56Families", sources: candSources, targets: candTargets, logicalDigest: "" },
      sourcesMap,
      codec
    );
    const logicalDigest = computeCandidateLogicalDigest(storeKey, namespace, epoch, "pr56Families", logicalProjection);
    const generation = typeof famData.generation === "number" ? famData.generation : 1;
    const grantVersion = typeof upstreamById.get(familyId)?.grantVersion === "number" ? upstreamById.get(familyId).grantVersion : 1;
    const famRow = encodeRefreshFamiliesRow(codec, familyId, generation, newRefreshId, newAccessId, logicalProjection, retiredFingerprints, famData.status, now);
    const upRow = encodeUpstreamRow(codec, familyId, grantVersion, {
      nsAccessToken: logicalProjection.upstream.nsAccessToken,
      nsRefreshToken: logicalProjection.upstream.nsRefreshToken,
      nsUsername: logicalProjection.upstream.nsUsername,
      nsUserRole: logicalProjection.upstream.nsUserRole,
      nsApiUrl: logicalProjection.upstream.nsApiUrl,
      nsExpiresAt: logicalProjection.upstream.nsExpiresAt
    }, now);
    const refRow = encodeRefreshRow(newRefreshId, familyId, generation, now);
    const accRow = encodeSessionsRow(codec, newAccessId, familyId, {
      expiresAt: logicalProjection.expiresAt,
      clientId: logicalProjection.clientId,
      serverBaseUrl: logicalProjection.serverBaseUrl,
      extra: logicalProjection.extra
    }, now);
    const targetDocsMap = /* @__PURE__ */ new Map();
    targetDocsMap.set("families", famRow);
    targetDocsMap.set("upstream", upRow);
    targetDocsMap.set("activeRefresh", refRow);
    targetDocsMap.set("tokens", accRow);
    const postimageByTargetId = /* @__PURE__ */ new Map();
    postimageByTargetId.set(famTargetId, famRow);
    postimageByTargetId.set(accTargetId, accRow);
    postimageByTargetId.set(refTargetId, refRow);
    postimageByTargetId.set(upTargetId, upRow);
    let prevRefreshRow = null;
    if (famData.previousRefreshToken) {
      const prevRefId = codec.id("refresh", famData.previousRefreshToken);
      const prevRefDoc = refreshById.get(famData.previousRefreshToken) || {};
      prevRefreshRow = {
        id: prevRefId,
        familyId,
        status: "consumed",
        generation: Math.max(1, generation - 1),
        consumedAt: prevRefDoc.consumedAt || now,
        successorSealed: codec.seal({ accessToken: accessId, refreshToken: currentRefId }, `successor:${prevRefId}`),
        v: 2
      };
      targetDocsMap.set("prevRefresh", prevRefreshRow);
      postimageByTargetId.set(prevRefTargetId, prevRefreshRow);
    }
    const retiredRows = [];
    for (const fp of retiredFingerprints) {
      const retRow = {
        fingerprint: fp,
        familyId,
        retiredAt: now,
        v: 2
      };
      retiredRows.push(retRow);
      const retTgtId = computeKeyedDocId(storeKey, "target-id", namespace, epoch, "retiredRefreshTokens", fp);
      postimageByTargetId.set(retTgtId, retRow);
    }
    if (retiredFingerprints.length > 0) {
      targetDocsMap.set("retiredRefresh", { ids: retiredFingerprints });
    }
    const targetLogicalProjection = projectTargetLogical(
      { id: candidateId, kind: "pr56Families", sources: candSources, targets: candTargets, logicalDigest: "" },
      targetDocsMap,
      codec
    );
    if (C(logicalProjection) !== C(targetLogicalProjection)) {
      throw new CutoverFenceError(`Logical projection equivalence check failed for candidate ${sanitizeId(candidateId)}`);
    }
    const prospectiveTargetPostimages = candTargets.map((t) => {
      const post = postimageByTargetId.get(t.id);
      if (!post) throw new CutoverFenceError(`Missing prospective target postimage for target ${t.collection}:${sanitizeId(t.id)}`);
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
      kind: "pr56Families",
      sources: candSources.map((s) => ({ collection: s.collection, id: s.id, recordDigest: s.recordDigest })),
      targets: candTargets.map((t) => ({ collection: t.collection, id: t.id })),
      logicalDigest
    };
    candidateCommitments.push(candCommitment);
    candidates.push({
      id: candidateId,
      kind: "pr56Families",
      commitment: candCommitment,
      sources: candSources,
      targets: candTargets,
      logicalDigest,
      prospectiveTargetPostimages,
      postimageByTargetId,
      sourceActions: candSources.map((s) => ({ collection: s.collection, id: s.id, rawId: s.rawId, action: "delete" })),
      targetRows: {
        refreshFamilies: famRow,
        upstreamGrants: upRow,
        refreshTokens: refRow,
        sessions: accRow,
        prevRefresh: prevRefreshRow,
        retiredRefresh: retiredRows
      }
    });
  }
  for (const tokDoc of tokensDocs) {
    const accessId = tokDoc.id;
    if (claimedAccessIds.has(accessId)) continue;
    claimedAccessIds.add(accessId);
    const tokData = tokDoc.data() || {};
    const familyId = codec.id("family", accessId);
    const refreshId = codec.id("refresh", tokData.refreshToken || accessId);
    const newAccessId = codec.id("session", accessId);
    const candSources = [
      {
        collection: "tokens",
        id: computeKeyedDocId(storeKey, "source-id", namespace, epoch, "tokens", accessId),
        rawId: accessId,
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, "tokens", computeKeyedDocId(storeKey, "source-id", namespace, epoch, "tokens", accessId), tokData)
      }
    ];
    if (tokData.refreshToken && refreshById.has(tokData.refreshToken)) {
      const refDoc = refreshById.get(tokData.refreshToken);
      candSources.push({
        collection: "refresh",
        id: computeKeyedDocId(storeKey, "source-id", namespace, epoch, "refresh", tokData.refreshToken),
        rawId: tokData.refreshToken,
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, "refresh", computeKeyedDocId(storeKey, "source-id", namespace, epoch, "refresh", tokData.refreshToken), refDoc)
      });
      claimedRefreshIds.add(tokData.refreshToken);
    }
    candSources.sort(compareDescriptors);
    const famTargetId = computeKeyedDocId(storeKey, "target-id", namespace, epoch, "families", familyId);
    const accTargetId = computeKeyedDocId(storeKey, "target-id", namespace, epoch, "tokens", newAccessId);
    const refTargetId = computeKeyedDocId(storeKey, "target-id", namespace, epoch, "refresh", refreshId);
    const upTargetId = computeKeyedDocId(storeKey, "target-id", namespace, epoch, "upstream", familyId);
    const candTargets = [
      { collection: "families", id: famTargetId, rawId: familyId },
      { collection: "tokens", id: accTargetId, rawId: newAccessId },
      { collection: "refresh", id: refTargetId, rawId: refreshId },
      { collection: "upstream", id: upTargetId, rawId: familyId }
    ];
    candTargets.sort(compareDescriptors);
    const sortedSourceIds = candSources.map((s) => s.id).sort(codeUnitCompare);
    const candidateId = computeCandidateId(storeKey, namespace, epoch, "baseFormatTokens", sortedSourceIds);
    const sourcesMap = /* @__PURE__ */ new Map();
    sourcesMap.set("tokens", safeDocEntry(accessId, tokData));
    if (tokData.refreshToken && refreshById.has(tokData.refreshToken)) {
      sourcesMap.set("refresh", safeDocEntry(tokData.refreshToken, refreshById.get(tokData.refreshToken)));
    }
    const logicalProjection = projectSourceLogical(
      { id: candidateId, kind: "baseFormatTokens", sources: candSources, targets: candTargets, logicalDigest: "" },
      sourcesMap,
      codec
    );
    const logicalDigest = computeCandidateLogicalDigest(storeKey, namespace, epoch, "baseFormatTokens", logicalProjection);
    const famRow = encodeRefreshFamiliesRow(codec, familyId, 1, refreshId, newAccessId, logicalProjection, [], "active", now);
    const upRow = encodeUpstreamRow(codec, familyId, 1, {
      nsAccessToken: logicalProjection.upstream.nsAccessToken,
      nsRefreshToken: logicalProjection.upstream.nsRefreshToken,
      nsUsername: logicalProjection.upstream.nsUsername,
      nsUserRole: logicalProjection.upstream.nsUserRole,
      nsApiUrl: logicalProjection.upstream.nsApiUrl,
      nsExpiresAt: logicalProjection.upstream.nsExpiresAt
    }, now);
    const refRow = encodeRefreshRow(refreshId, familyId, 1, now);
    const accRow = encodeSessionsRow(codec, newAccessId, familyId, {
      expiresAt: logicalProjection.expiresAt,
      clientId: logicalProjection.clientId,
      serverBaseUrl: logicalProjection.serverBaseUrl,
      extra: logicalProjection.extra
    }, now);
    const targetDocsMap = /* @__PURE__ */ new Map();
    targetDocsMap.set("families", famRow);
    targetDocsMap.set("upstream", upRow);
    targetDocsMap.set("activeRefresh", refRow);
    targetDocsMap.set("tokens", accRow);
    const postimageByTargetId = /* @__PURE__ */ new Map();
    postimageByTargetId.set(famTargetId, famRow);
    postimageByTargetId.set(accTargetId, accRow);
    postimageByTargetId.set(refTargetId, refRow);
    postimageByTargetId.set(upTargetId, upRow);
    const targetLogicalProjection = projectTargetLogical(
      { id: candidateId, kind: "baseFormatTokens", sources: candSources, targets: candTargets, logicalDigest: "" },
      targetDocsMap,
      codec
    );
    if (C(logicalProjection) !== C(targetLogicalProjection)) {
      throw new CutoverFenceError(`Logical projection equivalence check failed for candidate ${sanitizeId(candidateId)}`);
    }
    const prospectiveTargetPostimages = candTargets.map((t) => postimageByTargetId.get(t.id));
    expectedTargetCounts.families++;
    expectedTargetCounts.tokens++;
    expectedTargetCounts.refresh++;
    expectedTargetCounts.upstream++;
    classifications.baseFormatTokens++;
    const candCommitment = {
      id: candidateId,
      kind: "baseFormatTokens",
      sources: candSources.map((s) => ({ collection: s.collection, id: s.id, recordDigest: s.recordDigest })),
      targets: candTargets.map((t) => ({ collection: t.collection, id: t.id })),
      logicalDigest
    };
    candidateCommitments.push(candCommitment);
    candidates.push({
      id: candidateId,
      kind: "baseFormatTokens",
      commitment: candCommitment,
      sources: candSources,
      targets: candTargets,
      logicalDigest,
      prospectiveTargetPostimages,
      postimageByTargetId,
      sourceActions: candSources.map((s) => ({ collection: s.collection, id: s.id, rawId: s.rawId, action: "delete" })),
      targetRows: {
        refreshFamilies: famRow,
        upstreamGrants: upRow,
        refreshTokens: refRow,
        sessions: accRow
      }
    });
  }
  for (const codeDoc of authCodesDocs) {
    const rawCode = codeDoc.id;
    const cData = codeDoc.data() || {};
    const candSources = [
      {
        collection: "authCodes",
        id: computeKeyedDocId(storeKey, "source-id", namespace, epoch, "authCodes", rawCode),
        rawId: rawCode,
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, "authCodes", computeKeyedDocId(storeKey, "source-id", namespace, epoch, "authCodes", rawCode), cData)
      }
    ];
    const hmacCodeId = codec.id("code", rawCode);
    const targetId = computeKeyedDocId(storeKey, "target-id", namespace, epoch, "authCodes", hmacCodeId);
    const candTargets = [
      { collection: "authCodes", id: targetId, rawId: hmacCodeId }
    ];
    candSources.sort(compareDescriptors);
    candTargets.sort(compareDescriptors);
    const sortedSourceIds = candSources.map((s) => s.id).sort(codeUnitCompare);
    const candidateId = computeCandidateId(storeKey, namespace, epoch, "authCodes", sortedSourceIds);
    const sourcesMap = /* @__PURE__ */ new Map();
    sourcesMap.set("authCodes", safeDocEntry(rawCode, cData));
    const logicalProjection = projectSourceLogical(
      { id: candidateId, kind: "authCodes", sources: candSources, targets: candTargets, logicalDigest: "" },
      sourcesMap,
      codec
    );
    const logicalDigest = computeCandidateLogicalDigest(storeKey, namespace, epoch, "authCodes", logicalProjection);
    const codeRow = encodeAuthCodesRow(
      codec,
      rawCode,
      {
        pending: {
          clientId: logicalProjection.clientId,
          codeChallenge: logicalProjection.codeChallenge,
          redirectUri: logicalProjection.redirectUri,
          createdAt: logicalProjection.createdAt,
          state: logicalProjection.state,
          scopes: logicalProjection.scopes
        },
        nsTokens: {
          access_token: logicalProjection.nsAccessToken,
          refresh_token: logicalProjection.nsRefreshToken,
          username: logicalProjection.nsUsername,
          nsUserRole: logicalProjection.nsUserRole,
          nsApiUrl: logicalProjection.nsApiUrl
        },
        clientId: logicalProjection.clientId,
        serverBaseUrl: logicalProjection.serverBaseUrl,
        extra: logicalProjection.extra
      },
      logicalProjection.expiresAt,
      now
    );
    const targetDocsMap = /* @__PURE__ */ new Map();
    targetDocsMap.set("authCodes", codeRow);
    const targetLogicalProjection = projectTargetLogical(
      { id: candidateId, kind: "authCodes", sources: candSources, targets: candTargets, logicalDigest: "" },
      targetDocsMap,
      codec
    );
    if (C(logicalProjection) !== C(targetLogicalProjection)) {
      throw new CutoverFenceError(`Logical projection equivalence check failed for authCode ${sanitizeId(candidateId)}`);
    }
    const prospectiveTargetPostimages = [codeRow];
    const postimageByTargetId = /* @__PURE__ */ new Map([[targetId, codeRow]]);
    expectedTargetCounts.authCodes++;
    classifications.authCodes++;
    const candCommitment = {
      id: candidateId,
      kind: "authCodes",
      sources: candSources.map((s) => ({ collection: s.collection, id: s.id, recordDigest: s.recordDigest })),
      targets: candTargets.map((t) => ({ collection: t.collection, id: t.id })),
      logicalDigest
    };
    candidateCommitments.push(candCommitment);
    candidates.push({
      id: candidateId,
      kind: "authCodes",
      commitment: candCommitment,
      sources: candSources,
      targets: candTargets,
      logicalDigest,
      prospectiveTargetPostimages,
      postimageByTargetId,
      sourceActions: [{ collection: "authCodes", id: candSources[0].id, rawId: rawCode, action: "delete" }],
      targetRows: { authCodes: codeRow }
    });
  }
  for (const resDoc of resumeDocs) {
    const resId = resDoc.id;
    const rData = resDoc.data() || {};
    const candSources = [
      {
        collection: "resumeTokens",
        id: computeKeyedDocId(storeKey, "source-id", namespace, epoch, "resumeTokens", resId),
        rawId: resId,
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, "resumeTokens", computeKeyedDocId(storeKey, "source-id", namespace, epoch, "resumeTokens", resId), rData)
      }
    ];
    const targetId = computeKeyedDocId(storeKey, "target-id", namespace, epoch, "resumeTokens", resId);
    const candTargets = [
      { collection: "resumeTokens", id: targetId, rawId: resId }
    ];
    candSources.sort(compareDescriptors);
    candTargets.sort(compareDescriptors);
    const sortedSourceIds = candSources.map((s) => s.id).sort(codeUnitCompare);
    const candidateId = computeCandidateId(storeKey, namespace, epoch, "resumeTokens", sortedSourceIds);
    const sourcesMap = /* @__PURE__ */ new Map();
    sourcesMap.set("resumeTokens", safeDocEntry(resId, rData));
    const logicalProjection = projectSourceLogical(
      { id: candidateId, kind: "resumeTokens", sources: candSources, targets: candTargets, logicalDigest: "" },
      sourcesMap,
      codec
    );
    const logicalDigest = computeCandidateLogicalDigest(storeKey, namespace, epoch, "resumeTokens", logicalProjection);
    const resRow = encodeResumeTokensRow(resId, logicalProjection.consumedAt, logicalProjection.expiresAt, now);
    const targetDocsMap = /* @__PURE__ */ new Map();
    targetDocsMap.set("resumeTokens", resRow);
    const targetLogicalProjection = projectTargetLogical(
      { id: candidateId, kind: "resumeTokens", sources: candSources, targets: candTargets, logicalDigest: "" },
      targetDocsMap,
      codec
    );
    if (C(logicalProjection) !== C(targetLogicalProjection)) {
      throw new CutoverFenceError(`Logical projection equivalence check failed for resumeToken ${sanitizeId(candidateId)}`);
    }
    const prospectiveTargetPostimages = [resRow];
    const postimageByTargetId = /* @__PURE__ */ new Map([[targetId, resRow]]);
    expectedTargetCounts.resumeTokens++;
    classifications.resumeTokens++;
    const candCommitment = {
      id: candidateId,
      kind: "resumeTokens",
      sources: candSources.map((s) => ({ collection: s.collection, id: s.id, recordDigest: s.recordDigest })),
      targets: candTargets.map((t) => ({ collection: t.collection, id: t.id })),
      logicalDigest
    };
    candidateCommitments.push(candCommitment);
    candidates.push({
      id: candidateId,
      kind: "resumeTokens",
      commitment: candCommitment,
      sources: candSources,
      targets: candTargets,
      logicalDigest,
      prospectiveTargetPostimages,
      postimageByTargetId,
      sourceActions: [{ collection: "resumeTokens", id: candSources[0].id, rawId: resId, action: "replace" }],
      targetRows: { resumeTokens: resRow }
    });
  }
  const allClientIds = /* @__PURE__ */ new Set();
  const clientDocsById = /* @__PURE__ */ new Map();
  const oauthClientDocsById = /* @__PURE__ */ new Map();
  for (const doc of clientsDocs) {
    allClientIds.add(doc.id);
    clientDocsById.set(doc.id, doc.data() || {});
  }
  for (const doc of oauthClientsDocs) {
    allClientIds.add(doc.id);
    oauthClientDocsById.set(doc.id, doc.data() || {});
  }
  for (const clientId of Array.from(allClientIds).sort(codeUnitCompare)) {
    const candSources = [];
    if (clientDocsById.has(clientId)) {
      const d = clientDocsById.get(clientId);
      candSources.push({
        collection: "clients",
        id: computeKeyedDocId(storeKey, "source-id", namespace, epoch, "clients", clientId),
        rawId: clientId,
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, "clients", computeKeyedDocId(storeKey, "source-id", namespace, epoch, "clients", clientId), d)
      });
    }
    if (oauthClientDocsById.has(clientId)) {
      const d = oauthClientDocsById.get(clientId);
      candSources.push({
        collection: "oauthClients",
        id: computeKeyedDocId(storeKey, "source-id", namespace, epoch, "oauthClients", clientId),
        rawId: clientId,
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, "oauthClients", computeKeyedDocId(storeKey, "source-id", namespace, epoch, "oauthClients", clientId), d)
      });
    }
    candSources.sort(compareDescriptors);
    const targetId = computeKeyedDocId(storeKey, "target-id", namespace, epoch, "oauthClients", clientId);
    const candTargets = [
      { collection: "oauthClients", id: targetId, rawId: clientId }
    ];
    candTargets.sort(compareDescriptors);
    const sortedSourceIds = candSources.map((s) => s.id).sort(codeUnitCompare);
    const candidateId = computeCandidateId(storeKey, namespace, epoch, "clients", sortedSourceIds);
    const sourcesMap = /* @__PURE__ */ new Map();
    if (clientDocsById.has(clientId)) sourcesMap.set("clients", safeDocEntry(clientId, clientDocsById.get(clientId)));
    if (oauthClientDocsById.has(clientId)) sourcesMap.set("oauthClients", safeDocEntry(clientId, oauthClientDocsById.get(clientId)));
    const logicalProjection = projectSourceLogical(
      { id: candidateId, kind: "clients", sources: candSources, targets: candTargets, logicalDigest: "" },
      sourcesMap,
      codec
    );
    const logicalDigest = computeCandidateLogicalDigest(storeKey, namespace, epoch, "clients", logicalProjection);
    const clientRow = encodeOAuthClientsRow(clientId, {
      client_name: logicalProjection.clientName,
      redirect_uris: logicalProjection.redirectUris,
      token_endpoint_auth_method: logicalProjection.tokenEndpointAuthMethod,
      client_secret: logicalProjection.clientSecret,
      grant_types: logicalProjection.grantTypes,
      response_types: logicalProjection.responseTypes,
      client_uri: logicalProjection.clientUri,
      logo_uri: logicalProjection.logoUri,
      scope: logicalProjection.scope,
      client_id_issued_at: logicalProjection.clientIdIssuedAt
    }, now);
    const targetDocsMap = /* @__PURE__ */ new Map();
    targetDocsMap.set("clients", clientRow);
    const targetLogicalProjection = projectTargetLogical(
      { id: candidateId, kind: "clients", sources: candSources, targets: candTargets, logicalDigest: "" },
      targetDocsMap,
      codec
    );
    if (C(logicalProjection) !== C(targetLogicalProjection)) {
      throw new CutoverFenceError(`Logical projection equivalence check failed for client ${sanitizeId(candidateId)}`);
    }
    const prospectiveTargetPostimages = [clientRow];
    const postimageByTargetId = /* @__PURE__ */ new Map([[targetId, clientRow]]);
    expectedTargetCounts.oauthClients++;
    classifications.clients++;
    const candCommitment = {
      id: candidateId,
      kind: "clients",
      sources: candSources.map((s) => ({ collection: s.collection, id: s.id, recordDigest: s.recordDigest })),
      targets: candTargets.map((t) => ({ collection: t.collection, id: t.id })),
      logicalDigest
    };
    candidateCommitments.push(candCommitment);
    candidates.push({
      id: candidateId,
      kind: "clients",
      commitment: candCommitment,
      sources: candSources,
      targets: candTargets,
      logicalDigest,
      prospectiveTargetPostimages,
      postimageByTargetId,
      sourceActions: candSources.map((s) => ({ collection: s.collection, id: s.id, rawId: s.rawId, action: s.collection === "clients" ? "delete" : "replace" })),
      targetRows: { oauthClients: clientRow }
    });
  }
  candidateCommitments.sort((a, b) => codeUnitCompare(a.id, b.id));
  const sourceLogicalItems = candidateCommitments.map((c) => [c.id, c.logicalDigest]);
  const sourceLogicalDigest = computeLogicalInventoryDigest(storeKey, namespace, epoch, sourceLogicalItems);
  const allSourceDescriptors = [];
  for (const [colKey, docs] of sourceDocsByKey.entries()) {
    for (const d of docs) {
      const sourceId = computeKeyedDocId(storeKey, "source-id", namespace, epoch, colKey, d.id);
      const recDigest = computeSourceRecordDigest(storeKey, namespace, epoch, colKey, sourceId, d.data() || {});
      allSourceDescriptors.push({ collection: colKey, id: sourceId, recordDigest: recDigest });
    }
  }
  allSourceDescriptors.sort(compareDescriptors);
  const sourceInventoryDigest = computeSourceInventoryDigest(storeKey, namespace, epoch, allSourceDescriptors);
  const totalPhysicalRecords = Object.values(physicalCounts).reduce((a, b) => a + b, 0);
  const planSpec = {
    schemaVersion: 2,
    namespace,
    epoch,
    runId,
    codeSha,
    codeArtifact,
    packageIntegrity,
    protocolDigest,
    assemblyDigest,
    indexSchemaDigest,
    encoderVersion: 1,
    candidates: candidateCommitments.map((c, idx) => ({
      candidateId: c.id,
      kind: c.kind,
      sources: c.sources,
      targets: c.targets,
      logicalDigest: c.logicalDigest,
      sourceActions: candidates[idx].sourceActions,
      targetBounds: candidates[idx].prospectiveTargetPostimages.map((img) => ({
        sizeBytes: computeEstimatedFirestoreDocSize(img),
        depth: computeDocDepth(img),
        indexEntries: countIndexMetrics2(img).entries,
        indexBytes: countIndexMetrics2(img).bytes
      }))
    })),
    expectedTargetCounts,
    physicalCounts
  };
  const planDigest = D("plan", namespace, epoch, planSpec);
  const prepared = {
    schemaVersion: 2,
    namespace,
    epoch,
    migrationRunId: runId,
    codeSha,
    codeArtifact,
    packageIntegrity,
    protocolDigest,
    assemblyDigest,
    indexSchemaDigest,
    encoderVersion: 1,
    planDigest,
    planSpec,
    kind: "prepared",
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
    ...totalPhysicalRecords > 0 ? {
      projectorId: PROJECTOR_ID,
      projectorVersion: PROJECTOR_VERSION,
      projectorDigest: protocolDigest
    } : {}
  };
  const preparation = {
    estimatedCommitBytes: Math.max(100, computeEstimatedFirestoreDocSize(prepared) + 200),
    estimatedReadDurationMs: 100
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
      assemblyDigest,
      indexSchemaDigest,
      encoderVersion: 1,
      planDigest,
      kind: "receipt",
      preparedDigest: D("manifest", namespace, epoch, prepared),
      candidateId: c.id,
      candidateDigest: D("candidate", namespace, epoch, c.commitment),
      disposition: "written",
      sourceAfter: c.sources.map((s) => ({ collection: s.collection, id: s.id, recordDigest: s.recordDigest })),
      targetAfter: c.targets.map((t) => {
        const post = c.postimageByTargetId.get(t.id);
        const recDigest = computeTargetRecordDigest(storeKey, namespace, epoch, t.collection, t.id, post);
        return { collection: t.collection, id: t.id, recordDigest: recDigest };
      }),
      logicalDigest: c.logicalDigest,
      completedAt: now
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
        estimatedReadDurationMs: 50
      }
    };
  });
  const finalUpperBound = {
    schemaVersion: 2,
    namespace,
    epoch,
    migrationRunId: runId,
    codeSha,
    codeArtifact,
    packageIntegrity,
    protocolDigest,
    assemblyDigest,
    indexSchemaDigest,
    encoderVersion: 1,
    planDigest,
    kind: "final",
    preparedDigest: D("manifest", namespace, epoch, prepared),
    completedAt: now,
    physicalCounts,
    classifications,
    reasons,
    totalPhysicalRecords,
    targetCounts: expectedTargetCounts,
    scanned: candidateCommitments.length,
    migrated: candidateCommitments.length,
    skipped: 0,
    errors: 0,
    sourceInventoryDigest,
    targetInventoryDigest: "0".repeat(64),
    sourceLogicalDigest,
    targetLogicalDigest: sourceLogicalDigest,
    receiptSetDigest: "0".repeat(64),
    ...totalPhysicalRecords > 0 ? {
      projectorId: PROJECTOR_ID,
      projectorVersion: PROJECTOR_VERSION,
      projectorDigest: protocolDigest
    } : {}
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
    assemblyDigest,
    indexSchemaDigest,
    encoderVersion: 1,
    planDigest,
    kind: "ownership",
    preparedDigest: D("manifest", namespace, epoch, prepared),
    migrationManifestDigest: "0".repeat(64),
    emptyNamespace: totalPhysicalRecords === 0,
    adoptedAt: now,
    ...totalPhysicalRecords > 0 ? {
      projectorId: PROJECTOR_ID,
      projectorVersion: PROJECTOR_VERSION,
      projectorDigest: protocolDigest
    } : {}
  };
  const controlUpperBound = {
    schemaVersion: 2,
    namespace,
    epoch,
    state: "v3_ready",
    activeOperations: 0,
    irreversible: totalPhysicalRecords > 0,
    emptyNamespace: totalPhysicalRecords === 0,
    migrationRunId: runId,
    migrationManifestDigest: "0".repeat(64),
    codeSha,
    codeArtifact,
    updatedAt: now
  };
  const finalization = {
    finalUpperBound,
    markerUpperBound,
    controlUpperBound,
    transaction: {
      estimatedCommitBytes: Math.max(100, computeEstimatedFirestoreDocSize(finalUpperBound) + computeEstimatedFirestoreDocSize(markerUpperBound) + computeEstimatedFirestoreDocSize(controlUpperBound)),
      estimatedReadDurationMs: 200
    }
  };
  const activationControlUpperBound = {
    ...controlUpperBound,
    state: "v3_active"
  };
  const activation = {
    controlUpperBound: activationControlUpperBound,
    transaction: {
      estimatedCommitBytes: Math.max(100, computeEstimatedFirestoreDocSize(activationControlUpperBound)),
      estimatedReadDurationMs: 100
    }
  };
  const plan = {
    prepared,
    preparation,
    items,
    finalization,
    activation
  };
  validateCompleteMigrationPlan(plan);
  return {
    candidates,
    candidateCommitments,
    sourceInventoryDigest,
    sourceLogicalDigest,
    physicalCounts,
    expectedTargetCounts,
    planSpec,
    planDigest,
    plan
  };
}
__name(extractCandidatesAndPlan, "extractCandidatesAndPlan");
function computePreflightSummaryFromPlan(plan, sourceInventoryDigest, planDigest) {
  let estimatedFirestoreSize = computeEstimatedFirestoreDocSize(plan.prepared);
  let depth = computeDocDepth(plan.prepared);
  let indexEntries = countIndexMetrics2(plan.prepared).entries;
  let indexBytes = countIndexMetrics2(plan.prepared).bytes;
  for (const item of plan.items) {
    estimatedFirestoreSize += computeEstimatedFirestoreDocSize(item.receiptUpperBound);
    depth = Math.max(depth, computeDocDepth(item.receiptUpperBound));
    indexEntries += countIndexMetrics2(item.receiptUpperBound).entries;
    indexBytes += countIndexMetrics2(item.receiptUpperBound).bytes;
    for (const post of item.prospectiveTargetPostimages) {
      estimatedFirestoreSize += computeEstimatedFirestoreDocSize(post);
      depth = Math.max(depth, computeDocDepth(post));
      indexEntries += countIndexMetrics2(post).entries;
      indexBytes += countIndexMetrics2(post).bytes;
    }
  }
  estimatedFirestoreSize += computeEstimatedFirestoreDocSize(plan.finalization.finalUpperBound);
  estimatedFirestoreSize += computeEstimatedFirestoreDocSize(plan.finalization.markerUpperBound);
  depth = Math.max(depth, computeDocDepth(plan.finalization.finalUpperBound), computeDocDepth(plan.finalization.markerUpperBound));
  indexEntries += countIndexMetrics2(plan.finalization.finalUpperBound).entries + countIndexMetrics2(plan.finalization.markerUpperBound).entries;
  indexBytes += countIndexMetrics2(plan.finalization.finalUpperBound).bytes + countIndexMetrics2(plan.finalization.markerUpperBound).bytes;
  return {
    scanned: plan.items.length,
    sourceInventoryDigest,
    planDigest,
    estimatedFirestoreSize,
    depth,
    indexEntries,
    indexBytes,
    readDeadlineMs: 16e3
  };
}
__name(computePreflightSummaryFromPlan, "computePreflightSummaryFromPlan");
async function inspectFirestoreLegacyMigration2(options) {
  assertValidMigrationContext2(options);
  const allowedKeys = /* @__PURE__ */ new Set([
    "db",
    "FieldPath",
    "key",
    "namespace",
    "expectedEpoch",
    "migrationRunId",
    "codeSha",
    "codeArtifact",
    "packageIntegrity",
    "protocolDigest",
    "assemblyDigest",
    "indexSchemaDigest"
  ]);
  for (const k of Object.keys(options)) {
    if (!allowedKeys.has(k)) {
      throw new CutoverFenceError(`Unknown option '${k}' passed to inspectFirestoreLegacyMigration`);
    }
  }
  const { db, FieldPath, key, namespace, expectedEpoch, migrationRunId, codeSha, codeArtifact, packageIntegrity, protocolDigest, assemblyDigest, indexSchemaDigest } = options;
  const storeKey = key;
  const docIdField = FieldPath.documentId();
  return await db.runTransaction(async (transaction) => {
    const startTime = Date.now();
    const control = await readCutoverFenceInTransaction(transaction, db, namespace);
    if (control.epoch !== expectedEpoch) {
      throw new CutoverFenceError(`Epoch mismatch in inspect: expected ${expectedEpoch}, got ${control.epoch}`);
    }
    const { source: sourceNames, target: targetNames } = getCutoverDistinctCollectionNames(namespace);
    const distinctColNames = Array.from(/* @__PURE__ */ new Set([...Object.values(sourceNames), ...Object.values(targetNames)])).sort();
    const sourceDocsByKey = /* @__PURE__ */ new Map();
    for (const k of PHYSICAL_COUNT_KEYS) sourceDocsByKey.set(k, []);
    const targetDocsByKey = /* @__PURE__ */ new Map();
    for (const k of TARGET_COUNT_KEYS) targetDocsByKey.set(k, []);
    const sourcePhysicalToKey = {};
    for (const [k, name] of Object.entries(sourceNames)) sourcePhysicalToKey[name] = k;
    const targetPhysicalToKey = {};
    for (const [k, name] of Object.entries(targetNames)) targetPhysicalToKey[name] = k;
    for (const colName of distinctColNames) {
      const q = typeof db.collection(colName).orderBy === "function" ? db.collection(colName).orderBy(docIdField) : db.collection(colName);
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
    const duration = Date.now() - startTime;
    if (duration > 16e3) {
      throw new CutoverFenceError(`Preflight scan exceeded 16,000 ms lock deadline (${duration} ms)`);
    }
    const { candidates, sourceInventoryDigest, expectedTargetCounts, planSpec, planDigest, plan } = extractCandidatesAndPlan({
      sourceDocsByKey,
      storeKey,
      namespace,
      epoch: control.epoch,
      runId: migrationRunId,
      codeSha,
      codeArtifact,
      packageIntegrity,
      protocolDigest,
      assemblyDigest,
      indexSchemaDigest,
      now: Date.now()
    });
    const preflight = computePreflightSummaryFromPlan(plan, sourceInventoryDigest, planDigest);
    const prospectiveWritten = Object.values(expectedTargetCounts).reduce((a, b) => a + b, 0);
    return {
      sourceInventoryDigest,
      scanned: candidates.length,
      prospectiveWritten,
      prospectiveRetained: 0,
      planDigest,
      preflight
    };
  });
}
__name(inspectFirestoreLegacyMigration2, "inspectFirestoreLegacyMigration");
async function adoptFirestoreLegacyTokens2(options) {
  assertValidMigrationContext2(options);
  const allowedKeys = /* @__PURE__ */ new Set([
    "db",
    "FieldPath",
    "key",
    "namespace",
    "expectedEpoch",
    "migrationRunId",
    "codeSha",
    "codeArtifact",
    "packageIntegrity",
    "protocolDigest",
    "assemblyDigest",
    "indexSchemaDigest",
    "dryRun",
    "expectedSourceInventoryDigest"
  ]);
  for (const k of Object.keys(options)) {
    if (!allowedKeys.has(k)) {
      throw new CutoverFenceError(`Unknown option '${k}' passed to adoptFirestoreLegacyTokens`);
    }
  }
  if (typeof options.dryRun !== "boolean") {
    throw new CutoverFenceError("adoptFirestoreLegacyTokens requires boolean dryRun option");
  }
  if (typeof options.expectedSourceInventoryDigest !== "string" || !/^[0-9a-f]{64}$/.test(options.expectedSourceInventoryDigest)) {
    throw new CutoverFenceError("adoptFirestoreLegacyTokens requires 64-character lowercase hex expectedSourceInventoryDigest");
  }
  const { db, FieldPath, key, namespace, expectedEpoch, migrationRunId, codeSha, codeArtifact, packageIntegrity, protocolDigest, assemblyDigest, indexSchemaDigest, dryRun, expectedSourceInventoryDigest } = options;
  const storeKey = key;
  const docIdField = FieldPath.documentId();
  const prepResult = await db.runTransaction(async (transaction) => {
    const startTime = Date.now();
    const control = await readCutoverFenceInTransaction(transaction, db, namespace);
    if (control.epoch !== expectedEpoch) {
      throw new CutoverFenceError(`Epoch mismatch in adopt: expected ${expectedEpoch}, got ${control.epoch}`);
    }
    if (control.state === "migrating") {
      if (control.migrationRunId !== migrationRunId) {
        throw new CutoverFenceError(`Cannot resume migration for namespace ${namespace}: migrationRunId mismatch`);
      }
      const prepRef = db.collection(`${namespace}_meta`).doc(`migration_prepared_${control.epoch}`);
      const prepSnap = await transaction.get(prepRef);
      if (!prepSnap.exists) {
        throw new CutoverFenceError(`Prepared manifest missing during resume of migrating namespace ${namespace}`);
      }
      const prepDoc = prepSnap.data();
      return {
        dryRun: false,
        isResume: true,
        prepared: prepDoc,
        planSpec: prepDoc.planSpec
      };
    }
    if (control.state !== "fenced") {
      throw new CutoverRefusedError(`Cannot adopt: cutover state is '${control.state}', expected 'fenced'`, {
        cutoverState: control.state,
        epoch: control.epoch
      });
    }
    const { source: sourceNames, target: targetNames } = getCutoverDistinctCollectionNames(namespace);
    const distinctColNames = Array.from(/* @__PURE__ */ new Set([...Object.values(sourceNames), ...Object.values(targetNames)])).sort();
    const sourceDocsByKey = /* @__PURE__ */ new Map();
    for (const k of PHYSICAL_COUNT_KEYS) sourceDocsByKey.set(k, []);
    const sourcePhysicalToKey = {};
    for (const [k, name] of Object.entries(sourceNames)) sourcePhysicalToKey[name] = k;
    const targetPhysicalToKey = {};
    for (const [k, name] of Object.entries(targetNames)) targetPhysicalToKey[name] = k;
    for (const colName of distinctColNames) {
      const q = typeof db.collection(colName).orderBy === "function" ? db.collection(colName).orderBy(docIdField) : db.collection(colName);
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
    const duration = Date.now() - startTime;
    if (duration > 16e3) {
      throw new CutoverFenceError(`Preflight scan exceeded 16,000 ms lock deadline (${duration} ms)`);
    }
    const { candidates: candidates2, sourceInventoryDigest, plan } = extractCandidatesAndPlan({
      sourceDocsByKey,
      storeKey,
      namespace,
      epoch: control.epoch,
      runId: migrationRunId,
      codeSha,
      codeArtifact,
      packageIntegrity,
      protocolDigest,
      assemblyDigest,
      indexSchemaDigest,
      now: Date.now()
    });
    if (sourceInventoryDigest !== expectedSourceInventoryDigest) {
      throw new CutoverFenceError(
        `Source inventory digest mismatch: expected ${expectedSourceInventoryDigest}, observed ${sourceInventoryDigest}`
      );
    }
    if (dryRun) {
      return {
        dryRun: true,
        scanned: candidates2.length,
        migrated: 0,
        skipped: 0,
        errors: 0
      };
    }
    await prepareMigrationInTransaction(transaction, db, {
      namespace,
      prepDoc: plan.prepared,
      storeKey,
      FieldPath
    });
    return {
      dryRun: false,
      isResume: false,
      candidates: candidates2,
      plan,
      prepared: plan.prepared
    };
  });
  if (prepResult.dryRun) {
    return {
      scanned: prepResult.scanned,
      migrated: prepResult.migrated,
      skipped: prepResult.skipped,
      errors: prepResult.errors
    };
  }
  const { candidates, prepared } = prepResult;
  const now = Date.now();
  for (const c of candidates) {
    await db.runTransaction(async (transaction) => {
      const itemStart = Date.now();
      const control = await readCutoverFenceInTransaction(transaction, db, namespace);
      if (control.state !== "migrating") {
        throw new CutoverFenceError(`Cannot execute item: state must be 'migrating', got '${control.state}'`);
      }
      if (control.migrationRunId !== migrationRunId) {
        throw new CutoverFenceError("migrationRunId mismatch during item transaction");
      }
      const receiptRef = db.collection(`${namespace}_meta`).doc(`migration_receipt_${control.epoch}_${c.id}`);
      const receiptSnap = await transaction.get(receiptRef);
      if (receiptSnap.exists) {
        return;
      }
      if (Date.now() - itemStart > 16e3) {
        throw new CutoverFenceError("Transaction attempt exceeded 16,000 ms lock deadline");
      }
      if (control.emptyNamespace !== true) {
        await markIrreversibleInTransaction(transaction, db, namespace, control.epoch, migrationRunId, () => now);
      }
      for (const sa of c.sourceActions) {
        const colMap = {
          families: `${namespace}_tokens_refresh_families`,
          tokens: `${namespace}_tokens`,
          refresh: `${namespace}_tokens_refresh`,
          upstream: `${namespace}_tokens_upstream`,
          authCodes: `${namespace}_auth_codes`,
          resumeTokens: `${namespace}_resume_tokens`,
          oauthClients: `${namespace}_oauth_clients`,
          clients: `${namespace}_clients`
        };
        const physicalCol = colMap[sa.collection];
        if (physicalCol && sa.action === "delete") {
          transaction.delete(db.collection(physicalCol).doc(sa.rawId));
        }
      }
      const targetColMap = {
        families: `${namespace}_refresh_families`,
        tokens: `${namespace}_sessions`,
        refresh: `${namespace}_refresh`,
        upstream: `${namespace}_upstream`,
        authCodes: `${namespace}_auth_codes`,
        resumeTokens: `${namespace}_resume_tokens`,
        oauthClients: `${namespace}_oauth_clients`,
        retiredRefreshTokens: `${namespace}_retired_refresh`
      };
      for (const t of c.targets) {
        const post = c.postimageByTargetId.get(t.id);
        const physicalCol = targetColMap[t.collection];
        if (physicalCol && post) {
          const docId = post.id || post.code || post.client_id || post.fingerprint || t.rawId;
          transaction.set(db.collection(physicalCol).doc(docId), post);
        }
      }
      const targetAfter = c.targets.map((t) => {
        const post = c.postimageByTargetId.get(t.id);
        const recDigest = computeTargetRecordDigest(storeKey, namespace, control.epoch, t.collection, t.id, post);
        return { collection: t.collection, id: t.id, recordDigest: recDigest };
      });
      const sourceAfter = c.sources.map((s) => {
        const sa = c.sourceActions.find((a) => a.collection === s.collection && a.id === s.id);
        return {
          collection: s.collection,
          id: s.id,
          recordDigest: sa?.action === "delete" ? null : s.recordDigest
        };
      });
      const receiptDoc = {
        schemaVersion: 2,
        namespace,
        epoch: control.epoch,
        migrationRunId,
        codeSha,
        codeArtifact,
        packageIntegrity,
        protocolDigest,
        assemblyDigest,
        indexSchemaDigest,
        encoderVersion: 1,
        planDigest: prepared.planDigest,
        kind: "receipt",
        preparedDigest: D("manifest", namespace, control.epoch, prepared),
        candidateId: c.id,
        candidateDigest: D("candidate", namespace, control.epoch, c.commitment),
        disposition: "written",
        sourceAfter,
        targetAfter,
        logicalDigest: c.logicalDigest,
        completedAt: now
      };
      transaction.set(receiptRef, receiptDoc);
    });
  }
  await db.runTransaction(async (transaction) => {
    const finalStart = Date.now();
    const control = await readCutoverFenceInTransaction(transaction, db, namespace);
    if (control.state !== "migrating") {
      throw new CutoverFenceError(`Cannot finalize: state must be 'migrating', got '${control.state}'`);
    }
    const receiptsCol = db.collection(`${namespace}_meta`);
    const lowerBound = `migration_receipt_${control.epoch}_`;
    const upperBound = `migration_receipt_${control.epoch}\``;
    const receiptsSnap = await transaction.get(receiptsCol.orderBy(docIdField).startAt(lowerBound).endBefore(upperBound));
    const actualReceipts = receiptsSnap.docs.map((d) => d.data());
    const { target: targetNames } = getCutoverDistinctCollectionNames(namespace);
    const targetDescriptors = [];
    const targetPhysicalToKey = {
      [`${namespace}_refresh_families`]: "families",
      [`${namespace}_sessions`]: "tokens",
      [`${namespace}_refresh`]: "refresh",
      [`${namespace}_upstream`]: "upstream",
      [`${namespace}_auth_codes`]: "authCodes",
      [`${namespace}_resume_tokens`]: "resumeTokens",
      [`${namespace}_retired_refresh`]: "retiredRefreshTokens",
      [`${namespace}_oauth_clients`]: "oauthClients"
    };
    for (const [physicalName, colKey] of Object.entries(targetPhysicalToKey)) {
      const snap = await transaction.get(db.collection(physicalName).orderBy(docIdField));
      for (const d of snap.docs) {
        const data = d.data() || {};
        const targetId = computeKeyedDocId(storeKey, "target-id", namespace, control.epoch, colKey, d.id);
        const recDigest = computeTargetRecordDigest(storeKey, namespace, control.epoch, colKey, targetId, data);
        targetDescriptors.push({ collection: colKey, id: targetId, recordDigest: recDigest });
      }
    }
    targetDescriptors.sort(compareDescriptors);
    const targetInventoryDigest = computeTargetInventoryDigest(storeKey, namespace, control.epoch, targetDescriptors);
    const receiptSetDigest = computeReceiptSetDigest(actualReceipts, namespace, control.epoch);
    const finalDoc = {
      schemaVersion: 2,
      namespace,
      epoch: control.epoch,
      migrationRunId,
      codeSha,
      codeArtifact,
      packageIntegrity,
      protocolDigest,
      assemblyDigest,
      indexSchemaDigest,
      encoderVersion: 1,
      planDigest: prepared.planDigest,
      kind: "final",
      preparedDigest: D("manifest", namespace, control.epoch, prepared),
      completedAt: Date.now(),
      physicalCounts: prepared.physicalCounts,
      classifications: prepared.classifications,
      reasons: prepared.reasons,
      totalPhysicalRecords: prepared.totalPhysicalRecords,
      targetCounts: prepared.expectedTargetCounts,
      scanned: candidates.length,
      migrated: candidates.length,
      skipped: 0,
      errors: 0,
      sourceInventoryDigest: prepared.sourceInventoryDigest,
      targetInventoryDigest,
      sourceLogicalDigest: prepared.sourceLogicalDigest,
      targetLogicalDigest: prepared.sourceLogicalDigest,
      receiptSetDigest,
      ...prepared.totalPhysicalRecords > 0 ? {
        projectorId: PROJECTOR_ID,
        projectorVersion: PROJECTOR_VERSION,
        projectorDigest: protocolDigest
      } : {}
    };
    const finalManifestDigest = D("manifest", namespace, control.epoch, finalDoc);
    const markerDoc = {
      schemaVersion: 2,
      namespace,
      epoch: control.epoch,
      migrationRunId,
      codeSha,
      codeArtifact,
      packageIntegrity,
      protocolDigest,
      assemblyDigest,
      indexSchemaDigest,
      encoderVersion: 1,
      planDigest: prepared.planDigest,
      kind: "ownership",
      preparedDigest: D("manifest", namespace, control.epoch, prepared),
      migrationManifestDigest: finalManifestDigest,
      emptyNamespace: prepared.totalPhysicalRecords === 0,
      adoptedAt: Date.now(),
      ...prepared.totalPhysicalRecords > 0 ? {
        projectorId: PROJECTOR_ID,
        projectorVersion: PROJECTOR_VERSION,
        projectorDigest: protocolDigest
      } : {}
    };
    if (Date.now() - finalStart > 16e3) {
      throw new CutoverFenceError("Transaction attempt exceeded 16,000 ms lock deadline");
    }
    await finalizeMigrationInTransaction(transaction, db, {
      namespace,
      finalDoc,
      markerDoc,
      storeKey,
      FieldPath
    });
  });
  return {
    scanned: candidates.length,
    migrated: candidates.length,
    skipped: 0,
    errors: 0
  };
}
__name(adoptFirestoreLegacyTokens2, "adoptFirestoreLegacyTokens");
async function activateFirestoreMigration2(context) {
  assertValidMigrationContext2(context);
  const allowedKeys = /* @__PURE__ */ new Set([
    "db",
    "FieldPath",
    "key",
    "namespace",
    "expectedEpoch",
    "migrationRunId",
    "codeSha",
    "codeArtifact",
    "packageIntegrity",
    "protocolDigest",
    "assemblyDigest",
    "indexSchemaDigest"
  ]);
  for (const k of Object.keys(context)) {
    if (!allowedKeys.has(k)) {
      throw new CutoverFenceError(`Unknown option '${k}' passed to activateFirestoreMigration`);
    }
  }
  const { db, namespace, expectedEpoch, migrationRunId, key } = context;
  return await db.runTransaction(async (transaction) => {
    const actStart = Date.now();
    const control = await readCutoverFenceInTransaction(transaction, db, namespace);
    const finalRef = db.collection(`${namespace}_meta`).doc(`migration_manifest_${expectedEpoch}`);
    const finalSnap = await transaction.get(finalRef);
    let migrationManifestDigest = control.migrationManifestDigest;
    let planDigest = "";
    if (finalSnap.exists) {
      const f = finalSnap.data();
      migrationManifestDigest = D("manifest", namespace, expectedEpoch, f);
      planDigest = f.planDigest || "";
    }
    if (control.state === "v3_active") {
      if (control.epoch !== expectedEpoch) {
        throw new CutoverFenceError(`Epoch mismatch for namespace ${namespace}: expected ${expectedEpoch}, got ${control.epoch}`);
      }
      if (control.migrationRunId && control.migrationRunId !== migrationRunId) {
        throw new CutoverFenceError(`migrationRunId mismatch for namespace ${namespace}: expected ${migrationRunId}, got ${control.migrationRunId}`);
      }
      return {
        status: "already_active",
        epoch: control.epoch,
        migrationRunId: control.migrationRunId || migrationRunId,
        migrationManifestDigest: control.migrationManifestDigest || migrationManifestDigest || "",
        planDigest
      };
    }
    if (control.state !== "v3_ready") {
      throw new CutoverFenceError(`Cannot activate namespace ${namespace}: state must be v3_ready, got ${control.state}`);
    }
    if (Date.now() - actStart > 16e3) {
      throw new CutoverFenceError("Transaction attempt exceeded 16,000 ms lock deadline");
    }
    const res = await activateMigrationInTransaction(transaction, db, {
      ...context,
      storeKey: key,
      migrationManifestDigest: migrationManifestDigest || control.migrationManifestDigest
    });
    return {
      status: "activated",
      epoch: control.epoch,
      migrationRunId,
      migrationManifestDigest: res.control?.migrationManifestDigest || migrationManifestDigest || "",
      planDigest
    };
  });
}
__name(activateFirestoreMigration2, "activateFirestoreMigration");
async function getFirestoreMigrationStatus2(context) {
  assertValidMigrationContext2(context);
  const allowedKeys = /* @__PURE__ */ new Set([
    "db",
    "FieldPath",
    "key",
    "namespace",
    "expectedEpoch",
    "migrationRunId",
    "codeSha",
    "codeArtifact",
    "packageIntegrity",
    "protocolDigest",
    "assemblyDigest",
    "indexSchemaDigest"
  ]);
  for (const k of Object.keys(context)) {
    if (!allowedKeys.has(k)) {
      throw new CutoverFenceError(`Unknown option '${k}' passed to getFirestoreMigrationStatus`);
    }
  }
  const { db, namespace, expectedEpoch, migrationRunId, codeArtifact, protocolDigest } = context;
  return await db.runTransaction(async (transaction) => {
    const control = await readCutoverFenceInTransaction(transaction, db, namespace);
    let planDigest;
    let sourceInventoryDigest;
    if (control.state === "v3_ready" || control.state === "v3_active") {
      if (control.epoch !== expectedEpoch) {
        throw new CutoverFenceError(`Status epoch mismatch: expected ${expectedEpoch}, got ${control.epoch}`);
      }
      const markerRef = db.collection(`${namespace}_meta`).doc("v2_adopted");
      const markerSnap = await transaction.get(markerRef);
      if (!markerSnap.exists) {
        throw new CutoverFenceError("Immutable migration marker missing at v2_adopted");
      }
      const marker = markerSnap.data();
      validateMigrationIdentityFields(marker, namespace, expectedEpoch, migrationRunId);
      if (marker.codeArtifact !== codeArtifact || marker.protocolDigest !== protocolDigest) {
        throw new CutoverFenceError("Immutable migration marker artifact/protocolDigest mismatch");
      }
      const finalRef = db.collection(`${namespace}_meta`).doc(`migration_manifest_${control.epoch}`);
      const finalSnap = await transaction.get(finalRef);
      if (finalSnap.exists) {
        const f = finalSnap.data();
        planDigest = f.planDigest;
        sourceInventoryDigest = f.sourceInventoryDigest;
      }
    }
    return {
      state: control.state,
      epoch: control.epoch,
      migrationRunId: control.migrationRunId,
      migrationManifestDigest: control.migrationManifestDigest,
      planDigest,
      sourceInventoryDigest
    };
  });
}
__name(getFirestoreMigrationStatus2, "getFirestoreMigrationStatus");
export {
  ACCESS_RETENTION_MS,
  AUTH_CODE_TTL_MS,
  CutoverFenceError,
  CutoverRefusedError,
  LeaseLostError,
  MAX_RETIRED_REFRESH_FINGERPRINTS,
  PROJECTOR_ID,
  PROJECTOR_VERSION,
  REFRESH_LEASE_MS,
  REFRESH_POLL_MS,
  REFRESH_RETRY_WINDOW_MS,
  REFRESH_SKEW_MS,
  REFRESH_WAIT_MS,
  RESUME_TOKEN_TTL_MS,
  RetryableRefreshError,
  SESSION_RETENTION_MS,
  StoreConfigError,
  StoreLockedError,
  StoreUnavailableError,
  accessAad,
  activateFirestoreMigration2 as activateFirestoreMigration,
  adoptFirestoreLegacyTokens2 as adoptFirestoreLegacyTokens,
  assertValidMigrationContext2 as assertValidMigrationContext,
  codeUnitCompare,
  compareDescriptors,
  createCodec,
  decodeRefreshFamiliesRow,
  decodeSessionsRow,
  decodeUpstreamRow,
  deriveStoreKey,
  encodeAuthCodesRow,
  encodeOAuthClientsRow,
  encodeRefreshFamiliesRow,
  encodeRefreshRow,
  encodeResumeTokensRow,
  encodeSessionsRow,
  encodeUpstreamRow,
  extractCandidatesAndPlan,
  familyAad,
  getFirestoreMigrationStatus2 as getFirestoreMigrationStatus,
  getTimestampMs,
  inspectFirestoreLegacyMigration2 as inspectFirestoreLegacyMigration,
  isCutoverFenceError,
  isCutoverRefusedError,
  projectSourceLogical,
  projectTargetLogical,
  refreshAad,
  safeDocEntry,
  sessionAad,
  upstreamAad
};
