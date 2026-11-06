var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/cutover/dsse-verifier-core.mjs
import { constants, createPublicKey, verify } from "node:crypto";
var DSSE_PAYLOAD_TYPE = "application/vnd.in-toto+json";
var MCP_CUTOVER_PREDICATE_TYPE = "https://phoneware.us/mcp-cutover/v2";
var EXPECTED_FIELDS = ["codeSha", "publicPackageSourceSha", "privateRunnerSha", "workflowSourceSha", "assemblyDigest", "sessionSecretVersion", "image", "packageIntegrity", "indexSchemaDigest", "indexPolicyDigest", "project", "database", "namespace", "protocolDigest", "writerCensusDigest", "writerInventoryDigest", "collectionInventoryDigest"];
var SUBJECTS = ["cutover-protocol.mjs", "image", "package", "git-commit", "cutover-runner-image"];
var REQUIRED_PREDICATE = [...EXPECTED_FIELDS, "keyVersion", "runner", "serviceConfiguration", "terraformPlanDigest", "terraformSavedPlanDigest", "terraformProjectionDigest", "observationRunId", "observationRunAttempt", "observationArtifactId", "observationArtifactDigest", "assemblyRunId", "assemblyRunAttempt"];
var OPTIONAL_PREDICATE = ["builder", "assembledAt"];
var exact = /* @__PURE__ */ __name((object, keys) => object && typeof object === "object" && !Array.isArray(object) && JSON.stringify(Object.keys(object).sort()) === JSON.stringify([...keys].sort()), "exact");
var sha = /* @__PURE__ */ __name((value, length) => typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`).test(value), "sha");
var decimal = /* @__PURE__ */ __name((value) => typeof value === "string" && /^[1-9][0-9]*$/.test(value), "decimal");
var validSri = /* @__PURE__ */ __name((value) => {
  if (typeof value !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(value)) return false;
  const decoded = Buffer.from(value.slice(7), "base64");
  return decoded.length === 64 && `sha512-${decoded.toString("base64")}` === value;
}, "validSri");
function validateSubjectDescriptor(namespace, value) {
  if (namespace === "mcp" || namespace === "readonly_mcp") {
    if (value !== null) throw new Error("Invalid signed subject descriptor");
    return;
  }
  if (namespace !== "pwmcp" || !exact(value, ["allow", "collection", "extraKey", "field"]) || typeof value.extraKey !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value.extraKey) || typeof value.collection !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value.collection) || typeof value.field !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value.field) || !Array.isArray(value.allow) || value.allow.length < 1 || value.allow.length > 16 || value.allow.some((item) => typeof item !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(item)) || value.allow.some((item, index) => index > 0 && value.allow[index - 1] >= item)) throw new Error("Invalid signed subject descriptor");
}
__name(validateSubjectDescriptor, "validateSubjectDescriptor");
function canonicalJson(value) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite JSON number");
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) throw new Error("Unpaired JSON surrogate");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) throw new Error("Sparse JSON array");
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("Unsupported JSON value");
  return `{${Object.keys(value).sort().map((key) => `${canonicalJson(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
__name(canonicalJson, "canonicalJson");
function formatPAE(payloadType, payloadBytes) {
  const type = Buffer.from(payloadType, "utf8");
  return Buffer.concat([Buffer.from(`DSSEv1 ${type.length} `), type, Buffer.from(` ${payloadBytes.length} `), payloadBytes]);
}
__name(formatPAE, "formatPAE");
function decodeBase64(value) {
  if (typeof value !== "string" || !value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("Invalid DSSE base64");
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new Error("Noncanonical DSSE base64");
  return decoded;
}
__name(decodeBase64, "decodeBase64");
function validateCutoverStatement(statement) {
  if (!exact(statement, ["_type", "subject", "predicateType", "predicate"]) || statement._type !== "https://in-toto.io/Statement/v1" || statement.predicateType !== MCP_CUTOVER_PREDICATE_TYPE || !Array.isArray(statement.subject) || statement.subject.length !== SUBJECTS.length) throw new Error("Invalid v2 statement");
  const p = statement.predicate;
  if (!p || typeof p !== "object" || Array.isArray(p) || REQUIRED_PREDICATE.some((key) => !Object.hasOwn(p, key)) || Object.keys(p).some((key) => !REQUIRED_PREDICATE.includes(key) && !OPTIONAL_PREDICATE.includes(key)) || EXPECTED_FIELDS.some((key) => typeof p[key] !== "string" || !p[key]) || ![p.codeSha, p.publicPackageSourceSha, p.privateRunnerSha, p.workflowSourceSha].every((v) => sha(v, 40)) || p.codeSha !== p.publicPackageSourceSha || ![
    p.assemblyDigest,
    p.indexSchemaDigest,
    p.indexPolicyDigest,
    p.protocolDigest,
    p.writerCensusDigest,
    p.writerInventoryDigest,
    p.collectionInventoryDigest,
    p.terraformPlanDigest,
    p.terraformSavedPlanDigest,
    p.terraformProjectionDigest
  ].every((v) => sha(v, 64)) || ![p.sessionSecretVersion, p.observationRunId, p.observationRunAttempt, p.observationArtifactId, p.assemblyRunId, p.assemblyRunAttempt].every(decimal) || !/^sha256:[0-9a-f]{64}$/.test(p.observationArtifactDigest ?? "") || !/^[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-f]{64}$/.test(p.image) || !validSri(p.packageIntegrity) || !["mcp", "pwmcp", "readonly_mcp"].includes(p.namespace) || typeof p.keyVersion !== "string" || !p.keyVersion) throw new Error("Invalid v2 predicate");
  const r = p.runner;
  if (!exact(r, ["image", "childManifestDigest", "configDigest", "archiveSha256"]) || !/^sha256:[0-9a-f]{64}$/.test(r.childManifestDigest ?? "") || !/^sha256:[0-9a-f]{64}$/.test(r.configDigest ?? "") || !sha(r.archiveSha256, 64) || typeof r.image !== "string" || !r.image.endsWith(`@${r.childManifestDigest}`)) throw new Error("Invalid signed runner descriptor");
  const config = p.serviceConfiguration;
  const fields = p.namespace === "pwmcp" ? ["oauthClientSecretVersion", "subjectDescriptor"] : ["platforms", "oauthClientSecretVersion", "subjectDescriptor"];
  if (!exact(config, fields) || !decimal(config.oauthClientSecretVersion) || p.namespace !== "pwmcp" && (typeof config.platforms !== "string" || !config.platforms)) throw new Error("Invalid signed service configuration");
  validateSubjectDescriptor(p.namespace, config.subjectDescriptor);
  if (p.builder !== void 0 && (typeof p.builder !== "string" || !p.builder)) throw new Error("Invalid builder metadata");
  if (p.assembledAt !== void 0 && (typeof p.assembledAt !== "string" || !Number.isFinite(Date.parse(p.assembledAt)))) throw new Error("Invalid assembly timestamp");
  const subjects = /* @__PURE__ */ new Map();
  for (const subject of statement.subject) {
    if (!exact(subject, ["name", "digest"]) || !SUBJECTS.includes(subject.name) || subjects.has(subject.name)) throw new Error("Invalid signed subject set");
    subjects.set(subject.name, subject.digest);
  }
  const expectedSubjects = /* @__PURE__ */ new Map([
    ["cutover-protocol.mjs", { sha256: p.protocolDigest }],
    ["image", { sha256: p.image.slice(-64) }],
    ["package", { sha512: Buffer.from(p.packageIntegrity.slice(7), "base64").toString("hex") }],
    ["git-commit", { sha1: p.codeSha }],
    ["cutover-runner-image", { sha256: r.childManifestDigest.slice(7) }]
  ]);
  for (const [name, digest] of expectedSubjects) if (!exact(subjects.get(name), Object.keys(digest)) || canonicalJson(subjects.get(name)) !== canonicalJson(digest)) throw new Error("Signed subject differs from predicate");
}
__name(validateCutoverStatement, "validateCutoverStatement");
function verifyDSSEEnvelope(envelope, publicKeyPem, options) {
  if (!exact(options, ["expectedKeyVersion", "expectedPredicateType", "runnerRepository", "expectedPredicate"]) || typeof options.expectedKeyVersion !== "string" || !options.expectedKeyVersion || options.expectedPredicateType !== MCP_CUTOVER_PREDICATE_TYPE || typeof options.runnerRepository !== "string" || !options.runnerRepository || !exact(options.expectedPredicate, EXPECTED_FIELDS)) throw new Error("Incomplete protected DSSE policy");
  const expected = options.expectedPredicate;
  if (EXPECTED_FIELDS.some((key2) => typeof expected[key2] !== "string" || !expected[key2]) || ![expected.codeSha, expected.publicPackageSourceSha, expected.privateRunnerSha, expected.workflowSourceSha].every((value) => sha(value, 40)) || expected.codeSha !== expected.publicPackageSourceSha || ![expected.assemblyDigest, expected.indexSchemaDigest, expected.indexPolicyDigest, expected.protocolDigest, expected.writerCensusDigest, expected.writerInventoryDigest, expected.collectionInventoryDigest].every((value) => sha(value, 64)) || !decimal(expected.sessionSecretVersion) || !/^[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-f]{64}$/.test(expected.image) || !validSri(expected.packageIntegrity) || !["mcp", "pwmcp", "readonly_mcp"].includes(expected.namespace)) throw new Error("Malformed protected DSSE identity");
  if (!exact(envelope, ["payloadType", "payload", "signatures"]) || envelope.payloadType !== DSSE_PAYLOAD_TYPE || !Array.isArray(envelope.signatures) || envelope.signatures.length !== 1 || !exact(envelope.signatures[0], ["keyid", "sig"]) || envelope.signatures[0].keyid !== options.expectedKeyVersion) throw new Error("Invalid DSSE envelope or signature identity");
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== "rsa") throw new Error("Invalid public key type: expected rsa");
  if (key.asymmetricKeyDetails?.modulusLength !== 3072) throw new Error(`Invalid RSA modulusLength: expected 3072, got ${key.asymmetricKeyDetails?.modulusLength}`);
  const payloadBytes = decodeBase64(envelope.payload), signatureBytes = decodeBase64(envelope.signatures[0].sig);
  if (!verify("sha256", formatPAE(envelope.payloadType, payloadBytes), { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, signatureBytes)) throw new Error("DSSE envelope signature verification failed against approved public key");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
  const statement = JSON.parse(text);
  validateCutoverStatement(statement);
  if (canonicalJson(statement) !== text || !exact(statement, ["_type", "subject", "predicateType", "predicate"]) || statement._type !== "https://in-toto.io/Statement/v1" || statement.predicateType !== options.expectedPredicateType || !Array.isArray(statement.subject) || statement.subject.length !== SUBJECTS.length) throw new Error("Invalid canonical in-toto statement");
  const subjects = /* @__PURE__ */ new Map();
  for (const subject of statement.subject) {
    if (!exact(subject, ["name", "digest"]) || !SUBJECTS.includes(subject.name) || subjects.has(subject.name)) throw new Error("Invalid signed subject set");
    subjects.set(subject.name, subject.digest);
  }
  const predicate = statement.predicate;
  if (!predicate || typeof predicate !== "object" || Array.isArray(predicate) || REQUIRED_PREDICATE.some((key2) => !Object.hasOwn(predicate, key2)) || Object.keys(predicate).some((key2) => !REQUIRED_PREDICATE.includes(key2) && !OPTIONAL_PREDICATE.includes(key2)) || predicate.keyVersion !== options.expectedKeyVersion || EXPECTED_FIELDS.some((key2) => predicate[key2] !== expected[key2])) throw new Error("Signed predicate differs from protected policy");
  const runner = predicate.runner;
  if (!exact(runner, ["image", "childManifestDigest", "configDigest", "archiveSha256"]) || !/^sha256:[0-9a-f]{64}$/.test(runner.childManifestDigest ?? "") || !/^sha256:[0-9a-f]{64}$/.test(runner.configDigest ?? "") || !sha(runner.archiveSha256, 64) || runner.image !== `${options.runnerRepository}@${runner.childManifestDigest}`) throw new Error("Invalid signed runner descriptor");
  const imageDigest = /@sha256:([0-9a-f]{64})$/.exec(expected.image)[1];
  const expectedSubjects = /* @__PURE__ */ new Map([
    ["cutover-protocol.mjs", { sha256: expected.protocolDigest }],
    ["image", { sha256: imageDigest }],
    ["package", { sha512: Buffer.from(expected.packageIntegrity.slice(7), "base64").toString("hex") }],
    ["git-commit", { sha1: expected.codeSha }],
    ["cutover-runner-image", { sha256: runner.childManifestDigest.slice(7) }]
  ]);
  for (const [name, value] of expectedSubjects) if (!exact(subjects.get(name), Object.keys(value)) || canonicalJson(subjects.get(name)) !== canonicalJson(value)) throw new Error("Signed subject differs from protected policy");
  const configuration = predicate.serviceConfiguration;
  const fields = expected.namespace === "pwmcp" ? ["oauthClientSecretVersion", "subjectDescriptor"] : ["platforms", "oauthClientSecretVersion", "subjectDescriptor"];
  if (!exact(configuration, fields) || !decimal(configuration.oauthClientSecretVersion) || expected.namespace !== "pwmcp" && (typeof configuration.platforms !== "string" || !configuration.platforms)) throw new Error("Invalid signed service configuration");
  validateSubjectDescriptor(expected.namespace, configuration.subjectDescriptor);
  if (![predicate.assemblyRunId, predicate.assemblyRunAttempt].every(decimal)) throw new Error("Invalid or missing signed assembly run identity");
  if (![predicate.terraformPlanDigest, predicate.terraformSavedPlanDigest, predicate.terraformProjectionDigest].every((value) => sha(value, 64)) || ![predicate.observationRunId, predicate.observationRunAttempt, predicate.observationArtifactId].every(decimal) || !/^sha256:[0-9a-f]{64}$/.test(predicate.observationArtifactDigest ?? "")) throw new Error("Invalid or missing signed observation identity");
  if (predicate.builder !== void 0 && (typeof predicate.builder !== "string" || !predicate.builder)) throw new Error("Invalid builder metadata");
  if (predicate.assembledAt !== void 0 && (typeof predicate.assembledAt !== "string" || !Number.isFinite(Date.parse(predicate.assembledAt)))) throw new Error("Invalid assembly timestamp");
  return { valid: true, keyid: options.expectedKeyVersion, payload: statement, statement, payloadBytes, signatureBytes };
}
__name(verifyDSSEEnvelope, "verifyDSSEEnvelope");

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
    Object.defineProperty(this, "kitCode", { value: "cutover_fence_error", enumerable: true });
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
    Object.defineProperty(this, "kitCode", { value: "cutover_refused", enumerable: true });
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
function safeDocEntry(physicalId, data, projectionId) {
  const d = data || {};
  return {
    ...d,
    physicalId,
    id: projectionId
  };
}
__name(safeDocEntry, "safeDocEntry");

// src/store/subject-guard.ts
import { createHmac as createHmac2 } from "node:crypto";
function assertSubjectGuardShape(guard) {
  if (typeof guard.collection !== "string" || !guard.collection || typeof guard.documentId !== "string" || !guard.documentId || typeof guard.field !== "string" || !guard.field || !Array.isArray(guard.allow) || guard.allow.length === 0 || guard.allow.some((value) => typeof value !== "string" || !value)) {
    throw new CutoverRefusedError("Subject guard is malformed");
  }
}
__name(assertSubjectGuardShape, "assertSubjectGuardShape");
function subjectGuardAllows(data, guard) {
  if (!data) return false;
  const value = data[guard.field];
  return typeof value === "string" && guard.allow.includes(value);
}
__name(subjectGuardAllows, "subjectGuardAllows");
function subjectRefFor(storeKey, namespace, extraKey, value) {
  return createHmac2("sha256", storeKey).update(JSON.stringify(["netsapiens-mcp/subject", 1, namespace, extraKey, value])).digest("hex");
}
__name(subjectRefFor, "subjectRefFor");

// src/store/subject-descriptor.ts
function refuse(message) {
  throw new CutoverRefusedError(message);
}
__name(refuse, "refuse");
function validatedCopy(namespace, value) {
  try {
    validateSubjectDescriptor(namespace, value);
  } catch {
    refuse("Subject descriptor is invalid for this namespace");
  }
  if (value === null) return null;
  const copy = JSON.parse(canonicalJson(value));
  return Object.freeze({ ...copy, allow: Object.freeze([...copy.allow]) });
}
__name(validatedCopy, "validatedCopy");
function subjectDescriptorFromPredicate(namespace, predicate) {
  const configuration = predicate?.serviceConfiguration;
  if (configuration === null || typeof configuration !== "object" || Array.isArray(configuration) || !Object.prototype.hasOwnProperty.call(configuration, "subjectDescriptor")) {
    refuse("Signed predicate does not declare subjectDescriptor explicitly");
  }
  return validatedCopy(namespace, configuration.subjectDescriptor);
}
__name(subjectDescriptorFromPredicate, "subjectDescriptorFromPredicate");
function nullAllowed(namespace) {
  try {
    validateSubjectDescriptor(namespace, null);
    return true;
  } catch {
    return false;
  }
}
__name(nullAllowed, "nullAllowed");
function subjectDescriptorFromEnv(namespace, raw) {
  if (raw === void 0) return validatedCopy(namespace, null);
  if (nullAllowed(namespace)) refuse("MCP_SUBJECT_DESCRIPTOR is not allowed for this namespace");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    refuse("MCP_SUBJECT_DESCRIPTOR is not valid JSON");
  }
  if (canonicalJson(parsed) !== raw) refuse("MCP_SUBJECT_DESCRIPTOR is not canonical JSON");
  return validatedCopy(namespace, parsed);
}
__name(subjectDescriptorFromEnv, "subjectDescriptorFromEnv");
function subjectSpecFor(descriptor, namespace, storeKey) {
  if (!descriptor) return null;
  return {
    namespace,
    extraKey: descriptor.extraKey,
    refFor: /* @__PURE__ */ __name((value) => subjectRefFor(storeKey, namespace, descriptor.extraKey, value), "refFor")
  };
}
__name(subjectSpecFor, "subjectSpecFor");
function subjectRefsForFamily(spec, extra, status) {
  if (!spec || status !== "active") return {};
  const value = extra?.[spec.extraKey];
  if (typeof value !== "string" || value.length === 0) return { problem: "subject_value_missing" };
  return { refs: [spec.refFor(value)] };
}
__name(subjectRefsForFamily, "subjectRefsForFamily");
function subjectIssuanceFromDescriptor(descriptor, extra) {
  if (!descriptor) return void 0;
  const value = extra?.[descriptor.extraKey];
  if (typeof value !== "string" || value.length === 0) refuse("Subject value is missing or ambiguous");
  return {
    extraKey: descriptor.extraKey,
    value,
    guard: {
      collection: descriptor.collection,
      documentId: value,
      field: descriptor.field,
      allow: descriptor.allow
    }
  };
}
__name(subjectIssuanceFromDescriptor, "subjectIssuanceFromDescriptor");

// src/store/netsapiens-projector.mjs
import { createHash } from "node:crypto";
function sourceSubjectFields(refs) {
  return refs ? { subjectRefs: refs } : {};
}
__name(sourceSubjectFields, "sourceSubjectFields");
function targetSubjectFields(famData) {
  return Array.isArray(famData?.subjectRefs) && famData.status === "active" ? { subjectRefs: [...famData.subjectRefs] } : {};
}
__name(targetSubjectFields, "targetSubjectFields");
function requireSubjectParameter(subject) {
  if (subject === void 0) throw new CutoverFenceError("Subject policy parameter is required");
  if (subject !== null && (typeof subject !== "object" || typeof subject.refFor !== "function" || typeof subject.extraKey !== "string")) {
    throw new CutoverFenceError("Subject policy parameter is malformed");
  }
}
__name(requireSubjectParameter, "requireSubjectParameter");
function sanitizeId(_id) {
  return "[redacted]";
}
__name(sanitizeId, "sanitizeId");
var PROJECTOR_ID = "netsapiens-mcp/v2-v3-projector";
var PROJECTOR_VERSION = 1;
function entriesFor(entries, collection) {
  return entries.filter((entry) => entry.collection === collection);
}
__name(entriesFor, "entriesFor");
function singleEntry(entries, collection) {
  const found = entriesFor(entries, collection);
  if (found.length !== 1) throw new CutoverFenceError(`Expected exactly one ${collection} source or target`);
  return found[0];
}
__name(singleEntry, "singleEntry");
function projectionEntry(entry, id) {
  return { ...entry.data, physicalId: entry.physicalId, id };
}
__name(projectionEntry, "projectionEntry");
function aliases(...values) {
  const present = values.filter((value) => value !== void 0 && value !== null);
  if (present.some((value) => typeof value !== "string" || value.length === 0) || present.some((value) => value !== present[0])) throw new CutoverFenceError("Conflicting or malformed credential identity");
  return present[0];
}
__name(aliases, "aliases");
function legacyPhysicalId(value) {
  return value.replace(/\//g, "_").replace(/\./g, "_");
}
__name(legacyPhysicalId, "legacyPhysicalId");
function requireCredential(entry, raw) {
  if (typeof raw !== "string" || !raw || legacyPhysicalId(raw) !== entry.physicalId) {
    throw new CutoverFenceError("Legacy credential does not match its physical document identity");
  }
  return raw;
}
__name(requireCredential, "requireCredential");
function assertEntrySet(entries) {
  const keys = /* @__PURE__ */ new Set();
  for (const entry of entries) {
    if (!entry || typeof entry.collection !== "string" || typeof entry.physicalId !== "string" || !entry.physicalId || !entry.data || typeof entry.data !== "object" || Array.isArray(entry.data)) {
      throw new CutoverFenceError("Malformed projection snapshot entry");
    }
    const key = JSON.stringify([entry.collection, entry.physicalId]);
    if (keys.has(key)) throw new CutoverFenceError("Duplicate projection snapshot entry");
    keys.add(key);
  }
}
__name(assertEntrySet, "assertEntrySet");
function buildSourceProjectionMap(candidate, entries, codec) {
  assertEntrySet(entries);
  const roles = /* @__PURE__ */ new Map();
  const consumed = /* @__PURE__ */ new Set();
  const use = /* @__PURE__ */ __name((role, entry, id) => {
    if (roles.has(role) || consumed.has(entry)) throw new CutoverFenceError("Duplicate source projection role");
    roles.set(role, projectionEntry(entry, id));
    consumed.add(entry);
  }, "use");
  if (candidate.kind === "pr56Families" || candidate.kind === "baseFormatTokens") {
    const access = singleEntry(entries, "tokens");
    const accessId = requireCredential(access, aliases(access.data.accessToken, access.data.token?.accessToken));
    use("tokens", access, accessId);
    let family;
    if (candidate.kind === "pr56Families") {
      family = singleEntry(entries, "families");
      const upstream = singleEntry(entries, "upstream");
      if (family.data.id !== void 0 && family.data.id !== family.physicalId || upstream.physicalId !== family.physicalId || access.data.familyId != null && access.data.familyId !== family.physicalId || access.data.refreshFamilyId != null && access.data.refreshFamilyId !== family.physicalId || family.data.currentAccessToken != null && family.data.currentAccessToken !== accessId) throw new CutoverFenceError("Source family identity mismatch");
      use("families", family, family.physicalId);
      use("upstream", upstream, upstream.physicalId);
    }
    const accessRefresh = aliases(access.data.refreshToken, access.data.token?.refreshToken);
    const activeId = family ? family.data.currentRefreshToken : accessRefresh;
    if (typeof activeId !== "string" || !activeId) throw new CutoverFenceError("Source refresh credential is missing");
    if (family && accessRefresh !== void 0 && accessRefresh !== activeId) throw new CutoverFenceError("Source access refresh identity mismatch");
    const previousId = family?.data.previousRefreshToken;
    if (previousId != null && (typeof previousId !== "string" || !previousId || previousId === activeId)) {
      throw new CutoverFenceError("Source previous refresh identity is invalid");
    }
    for (const entry of entriesFor(entries, "refresh")) {
      const linkedAccess = entry.data.accessToken;
      const fromAccess = linkedAccess === accessId ? aliases(access.data.refreshToken, access.data.token?.refreshToken) : void 0;
      const raw = requireCredential(entry, aliases(entry.data.refreshToken, entry.data.token?.refreshToken) ?? fromAccess);
      if (family && aliases(entry.data.familyId, entry.data.family_id) !== family.physicalId) throw new CutoverFenceError("Source refresh family mismatch");
      if (raw === activeId && (entry.data.status === "active" || !family && entry.data.status === void 0 && linkedAccess === accessId)) {
        const linked = aliases(entry.data.accessToken, entry.data.token?.accessToken);
        if (linked !== void 0 && linked !== accessId || family && family.data.currentAccessToken == null && linked !== accessId) {
          throw new CutoverFenceError("Source active refresh access identity mismatch");
        }
        use("refresh", entry, raw);
      } else if (family && raw === previousId && entry.data.status === "consumed" && Number.isSafeInteger(entry.data.consumedAt) && entry.data.successorRefreshToken === activeId) use("prevRefresh", entry, raw);
      else throw new CutoverFenceError("Source refresh role or status mismatch");
    }
    if (family && (!roles.has("refresh") || !!previousId !== roles.has("prevRefresh"))) throw new CutoverFenceError("Source refresh role is missing");
    if (!family && entriesFor(entries, "refresh").length > 1) throw new CutoverFenceError("Duplicate base refresh pointer");
  } else if (candidate.kind === "clients") {
    const clients = entries.filter((entry) => entry.collection === "clients" || entry.collection === "oauthClients");
    if (clients.length < 1 || clients.length > 2 || new Set(clients.map((entry) => entry.collection)).size !== clients.length) throw new CutoverFenceError("Invalid client source cardinality");
    for (const entry of clients) {
      if (entry.physicalId !== clients[0].physicalId || entry.data.client_id !== void 0 && entry.data.client_id !== entry.physicalId || entry.data.clientId !== void 0 && entry.data.clientId !== entry.physicalId) throw new CutoverFenceError("Source client identity mismatch");
    }
    const projected = clients.map((entry) => projectSourceLogical(candidate, /* @__PURE__ */ new Map([["clients", projectionEntry(entry, entry.physicalId)]]), codec, null));
    if (projected.length === 2 && JSON.stringify(projected[0]) !== JSON.stringify(projected[1])) throw new CutoverFenceError("Conflicting client logical projections");
    const selected = clients.find((entry) => entry.collection === "oauthClients") ?? clients[0];
    roles.set("clients", projectionEntry(selected, selected.physicalId));
    for (const entry of clients) consumed.add(entry);
  } else {
    const collection = candidate.kind === "authCodes" ? "authCodes" : candidate.kind === "resumeTokens" ? "resumeTokens" : null;
    if (!collection) throw new CutoverFenceError("Unsupported source projection kind");
    const entry = singleEntry(entries, collection);
    const raw = collection === "authCodes" ? aliases(entry.data.code, entry.data.rawCode) : aliases(entry.data.token, entry.data.resumeToken);
    if (raw !== void 0 && raw !== entry.physicalId || entry.data.id !== void 0 && entry.data.id !== entry.physicalId) throw new CutoverFenceError("Source document identity mismatch");
    use(collection, entry, entry.physicalId);
  }
  if (consumed.size !== entries.length) throw new CutoverFenceError("Unexpected source projection entry");
  return roles;
}
__name(buildSourceProjectionMap, "buildSourceProjectionMap");
function buildTargetProjectionMap(candidate, entries, options = {}) {
  assertEntrySet(entries);
  const roles = /* @__PURE__ */ new Map();
  const consumed = /* @__PURE__ */ new Set();
  const use = /* @__PURE__ */ __name((role, entry) => {
    if (roles.has(role) || consumed.has(entry)) throw new CutoverFenceError("Duplicate target projection role");
    if (options.requireIds && entry.collection !== "oauthClients" && entry.data.id !== entry.physicalId) throw new CutoverFenceError("Prospective target identity is missing or mismatched");
    if (entry.data.id !== void 0 && entry.data.id !== entry.physicalId) throw new CutoverFenceError("Target document identity mismatch");
    roles.set(role, projectionEntry(entry, entry.physicalId));
    consumed.add(entry);
  }, "use");
  if (candidate.kind === "pr56Families" || candidate.kind === "baseFormatTokens") {
    const family = singleEntry(entries, "families");
    const access = singleEntry(entries, "tokens");
    const upstream = singleEntry(entries, "upstream");
    if (upstream.physicalId !== family.physicalId || access.physicalId !== family.data.currentAccessTokenId || access.data.familyId !== family.physicalId || upstream.data.familyId !== void 0 && upstream.data.familyId !== family.physicalId) throw new CutoverFenceError("Target family identity mismatch");
    use("families", family);
    use("tokens", access);
    use("upstream", upstream);
    for (const entry of entriesFor(entries, "refresh")) {
      if (entry.data.familyId !== family.physicalId) throw new CutoverFenceError("Target refresh family mismatch");
      if (entry.physicalId === family.data.activeRefreshId && entry.data.status === "active") use("activeRefresh", entry);
      else if (entry.data.status === "consumed") use("prevRefresh", entry);
      else throw new CutoverFenceError("Target refresh role or status mismatch");
    }
    if (!roles.has("activeRefresh")) throw new CutoverFenceError("Target active refresh is missing");
    const retired = entriesFor(entries, "retiredRefreshTokens");
    if (candidate.kind === "baseFormatTokens" && (roles.has("prevRefresh") || retired.length)) throw new CutoverFenceError("Base target graph contains extra refresh roles");
    for (const entry of retired) {
      if (entry.data.familyId !== family.physicalId || entry.data.id !== void 0 && entry.data.id !== entry.physicalId || entry.data.retiredAt !== void 0 && (!Number.isSafeInteger(entry.data.retiredAt) || entry.data.retiredAt <= 0)) {
        throw new CutoverFenceError("Target retired refresh identity mismatch");
      }
      consumed.add(entry);
    }
    if (retired.length) roles.set("retiredRefresh", { ids: retired.map((entry) => entry.physicalId).sort(codeUnitCompare) });
  } else {
    const collection = candidate.kind === "clients" ? "oauthClients" : candidate.kind === "authCodes" ? "authCodes" : candidate.kind === "resumeTokens" ? "resumeTokens" : null;
    if (!collection) throw new CutoverFenceError("Unsupported target projection kind");
    const entry = singleEntry(entries, collection);
    if (collection === "oauthClients" && (entry.data.client_id !== entry.physicalId || entry.data.clientId !== void 0 && entry.data.clientId !== entry.physicalId)) throw new CutoverFenceError("Target client identity mismatch");
    use(collection === "oauthClients" ? "clients" : collection, entry);
  }
  if (consumed.size !== entries.length) throw new CutoverFenceError("Unexpected target projection entry");
  return roles;
}
__name(buildTargetProjectionMap, "buildTargetProjectionMap");
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
function projectSourceLogical(candidate, sources, codec, subject) {
  requireSubjectParameter(subject);
  if (candidate.kind === "pr56Families") {
    const famDoc = sources.get("families");
    if (!famDoc) throw new CutoverFenceError(`Candidate ${sanitizeId(candidate.id)} missing families source`);
    const famData = famDoc;
    const familyId = famData.id;
    if (!familyId || typeof familyId !== "string") throw new CutoverFenceError("pr56Families missing required familyId");
    const generation = typeof famData.generation === "number" ? famData.generation : 1;
    const refDoc = sources.get("refresh");
    if (!refDoc) throw new CutoverFenceError(`Candidate ${sanitizeId(candidate.id)} missing active refresh source`);
    const curRefDoc = refDoc;
    if (curRefDoc.id !== famData.currentRefreshToken || curRefDoc.status !== "active") {
      throw new CutoverFenceError(`Active refresh token mismatch or not active for family ${sanitizeId(familyId)}`);
    }
    const currentRefId = curRefDoc.id;
    const upDoc = sources.get("upstream");
    if (!upDoc) throw new CutoverFenceError(`Candidate ${sanitizeId(candidate.id)} missing upstream source`);
    const grant = upDoc.grant && typeof upDoc.grant === "object" ? upDoc.grant : upDoc;
    const tokDoc = sources.get("tokens");
    if (!tokDoc) throw new CutoverFenceError(`Candidate ${sanitizeId(candidate.id)} missing tokens source`);
    const accessId = tokDoc.accessToken ?? famData.currentAccessToken ?? tokDoc.id;
    if (!accessId || typeof accessId !== "string") throw new CutoverFenceError("pr56Families missing accessId");
    const newAccessId = codec.id("session", accessId);
    const newRefreshId = codec.id("refresh", currentRefId);
    let previousRefresh = null;
    if (famData.previousRefreshToken) {
      const prevId = famData.previousRefreshToken;
      const prevDoc = sources.get("prevRefresh");
      if (!prevDoc) {
        throw new CutoverFenceError(`Candidate ${sanitizeId(candidate.id)} missing prevRefresh source`);
      }
      if (prevDoc.id !== prevId || prevDoc.status !== "consumed") {
        throw new CutoverFenceError(`Previous refresh token mismatch or not consumed for family ${sanitizeId(familyId)}`);
      }
      if (prevDoc.successorRefreshToken !== currentRefId) {
        throw new CutoverFenceError("Previous refresh successor does not match the active credential");
      }
      if (typeof prevDoc.consumedAt !== "number") {
        throw new CutoverFenceError(`Candidate ${sanitizeId(candidate.id)} previous refresh missing numeric consumedAt`);
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
    const seenFp = /* @__PURE__ */ new Set();
    const retiredFingerprints = [];
    for (const fp of rawRetired) {
      if (typeof fp !== "string" || fp.length === 0) {
        throw new CutoverFenceError(`Malformed retired refresh token fingerprint in family ${sanitizeId(familyId)}`);
      }
      if (seenFp.has(fp)) {
        throw new CutoverFenceError(`Duplicate retired refresh token fingerprint detected in family ${sanitizeId(familyId)}`);
      }
      seenFp.add(fp);
      retiredFingerprints.push(fp);
    }
    retiredFingerprints.sort(codeUnitCompare);
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
    const pr56SubjectRefs = subjectRefsForFamily(subject, curRefDoc.token?.extra ?? tokDoc.extra ?? {}, famData.status === "revoked" ? "revoked" : "active").refs;
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
      retiredRefreshFingerprints: retiredFingerprints,
      ...sourceSubjectFields(pr56SubjectRefs),
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
    if (!tokDoc) throw new CutoverFenceError(`Candidate ${sanitizeId(candidate.id)} missing tokens source`);
    const accessToken = aliases(tokDoc.accessToken, tokDoc.token?.accessToken);
    const refreshToken = aliases(tokDoc.refreshToken, tokDoc.token?.refreshToken);
    if (typeof accessToken !== "string" || accessToken.length === 0 || typeof refreshToken !== "string" || refreshToken.length === 0) {
      throw new CutoverFenceError("baseFormatTokens missing raw access or refresh credential");
    }
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
    const familySubjectRefs = subjectRefsForFamily(subject, tokDoc.extra ?? {}, "active").refs;
    return {
      familyId,
      generation: 1,
      status: "active",
      clientId,
      serverBaseUrl: tokDoc.serverBaseUrl ?? null,
      extra: tokDoc.extra ?? {},
      activeRefreshId: refreshId,
      currentAccessTokenId: accessId,
      previousRefresh: null,
      retiredRefreshFingerprints: [],
      ...sourceSubjectFields(familySubjectRefs),
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
    if (!codeDoc) throw new CutoverFenceError(`Candidate ${sanitizeId(candidate.id)} missing authCodes source`);
    const rawCode = codeDoc.code ?? codeDoc.rawCode ?? codeDoc.id;
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
      used: (() => {
        const pUsed = rawPending.used;
        const cUsed = codeDoc.used;
        if (pUsed !== void 0 && typeof pUsed !== "boolean") {
          throw new CutoverFenceError("authCodes invalid non-boolean pending.used property");
        }
        if (cUsed !== void 0 && typeof cUsed !== "boolean") {
          throw new CutoverFenceError("authCodes invalid non-boolean codeDoc.used property");
        }
        if (pUsed !== void 0 && cUsed !== void 0 && pUsed !== cUsed) {
          throw new CutoverFenceError("authCodes conflicting used property between pending and codeDoc");
        }
        return pUsed ?? cUsed ?? false;
      })(),
      v: 2
    };
  }
  if (candidate.kind === "resumeTokens") {
    const resDoc = sources.get("resumeTokens");
    if (!resDoc) throw new CutoverFenceError(`Candidate ${sanitizeId(candidate.id)} missing resumeTokens source`);
    const resumeId = resDoc.token ?? resDoc.resumeToken ?? resDoc.id;
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
    if (!clientDoc) throw new CutoverFenceError(`Candidate ${sanitizeId(candidate.id)} missing clients source`);
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
  throw new CutoverFenceError(`Unsupported candidate kind for source projection: ${candidate.kind}`);
}
__name(projectSourceLogical, "projectSourceLogical");
function projectTargetLogical(candidate, targets, codec) {
  if (candidate.kind === "pr56Families") {
    const famDoc = targets.get("families");
    if (!famDoc) throw new CutoverFenceError(`Candidate ${sanitizeId(candidate.id)} missing families target document`);
    const famData = famDoc;
    const familyId = famData.id;
    if (!familyId || typeof familyId !== "string") throw new CutoverFenceError("Target family missing id");
    const generation = famData.generation;
    if (typeof generation !== "number" || generation < 1) {
      throw new CutoverFenceError(`Target family ${sanitizeId(familyId)} malformed generation`);
    }
    const unsealedFam = famData.sealed ? codec.open(famData.sealed, familyAad({ id: familyId, generation })) : null;
    if (!unsealedFam) {
      throw new CutoverFenceError(`Target family sealed payload decrypt failed for ${sanitizeId(familyId)}`);
    }
    const upDoc = targets.get("upstream");
    if (!upDoc) throw new CutoverFenceError(`Candidate ${sanitizeId(candidate.id)} missing upstream target document`);
    const upData = upDoc;
    const grantVersion = upData.grantVersion;
    if (typeof grantVersion !== "number" || grantVersion < 1) {
      throw new CutoverFenceError(`Target upstream ${sanitizeId(familyId)} malformed grantVersion`);
    }
    if (upData.familyId !== familyId && upData.id !== familyId) {
      throw new CutoverFenceError(`Target upstream family binding mismatch for ${sanitizeId(familyId)}`);
    }
    const unsealedUp = upData.sealed ? codec.open(upData.sealed, upstreamAad({ id: familyId, grantVersion })) : null;
    if (!unsealedUp) {
      throw new CutoverFenceError(`Target upstream sealed payload decrypt failed for ${sanitizeId(familyId)}`);
    }
    const sessDoc = targets.get("tokens");
    if (!sessDoc) throw new CutoverFenceError(`Candidate ${sanitizeId(candidate.id)} missing tokens target document`);
    const sessData = sessDoc;
    if (sessData.v !== 2 || typeof sessData.expiresAt !== "number" || typeof sessData.retainUntil !== "number" || !sessData.ttlAt) {
      throw new CutoverFenceError(`Target session invalid for family ${sanitizeId(familyId)}: missing v: 2, expiresAt, retainUntil, or ttlAt`);
    }
    if (sessData.familyId !== familyId) {
      throw new CutoverFenceError(`Target session family binding mismatch: expected ${sanitizeId(familyId)}, got ${sanitizeId(sessData.familyId)}`);
    }
    if (sessData.retainUntil !== sessData.expiresAt + 30 * 24 * 60 * 60 * 1e3) {
      throw new CutoverFenceError(`Target session retainUntil must equal expiresAt + 30 days for family ${sanitizeId(familyId)}`);
    }
    const ttlMs = getTimestampMs(sessData.ttlAt);
    if (ttlMs === null || ttlMs !== sessData.retainUntil) {
      throw new CutoverFenceError(`Target session ttlAt must equal retainUntil for family ${sanitizeId(familyId)}`);
    }
    const unsealedSess = codec.open(sessData.sealed, accessAad({ id: sessData.id, familyId }));
    if (!unsealedSess) {
      throw new CutoverFenceError(`Target session sealed payload decrypt failed for family ${sanitizeId(familyId)}`);
    }
    const clientId = unsealedFam.clientId ?? unsealedSess.clientId;
    if (!clientId || typeof clientId !== "string") {
      throw new CutoverFenceError(`Target family missing decrypted clientId for ${sanitizeId(familyId)}`);
    }
    const nsAccessToken = unsealedUp.nsAccessToken;
    if (!nsAccessToken || typeof nsAccessToken !== "string") {
      throw new CutoverFenceError(`Target upstream missing decrypted nsAccessToken for ${sanitizeId(familyId)}`);
    }
    const nsUsername = unsealedUp.nsUsername;
    if (!nsUsername || typeof nsUsername !== "string") {
      throw new CutoverFenceError(`Target upstream missing decrypted nsUsername for ${sanitizeId(familyId)}`);
    }
    const activeRefDoc = targets.get("activeRefresh");
    if (!activeRefDoc) throw new CutoverFenceError(`Candidate ${sanitizeId(candidate.id)} missing active refresh target document`);
    const activeRefData = activeRefDoc;
    if (activeRefData.id !== famData.activeRefreshId || activeRefData.familyId !== familyId || activeRefData.status !== "active" || activeRefData.generation !== generation || activeRefData.v !== 2) {
      throw new CutoverFenceError(`Target active refresh token invalid for family ${sanitizeId(familyId)}`);
    }
    let previousRefresh = null;
    const prevRefDoc = targets.get("prevRefresh");
    if (prevRefDoc) {
      const prevRefData = prevRefDoc;
      if (prevRefData.familyId !== familyId || prevRefData.status !== "consumed" || typeof prevRefData.consumedAt !== "number" || prevRefData.v !== 2) {
        throw new CutoverFenceError(`Target consumed refresh token invalid for family ${sanitizeId(familyId)}`);
      }
      const unsealedSuccessor = codec.open(
        prevRefData.successorSealed,
        `successor:${prevRefData.id}`
      );
      if (!unsealedSuccessor || typeof unsealedSuccessor.accessToken !== "string" || typeof unsealedSuccessor.refreshToken !== "string") {
        throw new CutoverFenceError(`Target successor sealed invalid for previous refresh ${sanitizeId(prevRefData.id)}`);
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
    const retiredIds = Array.isArray(rawRetired?.ids) ? rawRetired.ids : [];
    const seenTgtFp = /* @__PURE__ */ new Set();
    const retiredRefreshFingerprints = [];
    for (const fp of retiredIds) {
      if (typeof fp !== "string" || fp.length === 0) {
        throw new CutoverFenceError(`Target retired refresh token fingerprint must be a non-empty string in family ${sanitizeId(familyId)}`);
      }
      if (seenTgtFp.has(fp)) {
        throw new CutoverFenceError(`Duplicate target retired refresh token fingerprint detected in family ${sanitizeId(familyId)}`);
      }
      seenTgtFp.add(fp);
      retiredRefreshFingerprints.push(fp);
    }
    retiredRefreshFingerprints.sort(codeUnitCompare);
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
      retiredRefreshFingerprints,
      ...targetSubjectFields(famData),
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
    if (!famDoc) throw new CutoverFenceError(`Candidate ${sanitizeId(candidate.id)} missing families target document`);
    const famData = famDoc;
    const familyId = famData.id;
    if (!familyId || typeof familyId !== "string") throw new CutoverFenceError("Target family missing id");
    const generation = famData.generation;
    if (typeof generation !== "number" || generation !== 1) {
      throw new CutoverFenceError(`Target base family ${sanitizeId(familyId)} malformed generation`);
    }
    const unsealedFam = famData.sealed ? codec.open(famData.sealed, familyAad({ id: familyId, generation })) : null;
    if (!unsealedFam) {
      throw new CutoverFenceError(`Target family sealed payload decrypt failed for ${sanitizeId(familyId)}`);
    }
    const upDoc = targets.get("upstream");
    if (!upDoc) throw new CutoverFenceError(`Candidate ${sanitizeId(candidate.id)} missing upstream target document`);
    const upData = upDoc;
    const grantVersion = upData.grantVersion;
    if (typeof grantVersion !== "number" || grantVersion !== 1) {
      throw new CutoverFenceError(`Target base upstream ${sanitizeId(familyId)} malformed grantVersion`);
    }
    const unsealedUp = upData.sealed ? codec.open(upData.sealed, upstreamAad({ id: familyId, grantVersion })) : null;
    if (!unsealedUp) {
      throw new CutoverFenceError(`Target upstream sealed payload decrypt failed for ${sanitizeId(familyId)}`);
    }
    const sessDoc = targets.get("tokens");
    if (!sessDoc) throw new CutoverFenceError(`Candidate ${sanitizeId(candidate.id)} missing tokens target document`);
    const sessData = sessDoc;
    if (sessData.v !== 2 || typeof sessData.expiresAt !== "number" || typeof sessData.retainUntil !== "number" || !sessData.ttlAt) {
      throw new CutoverFenceError(`Target session invalid for base session ${sanitizeId(sessData.id)}: missing v: 2, expiresAt, retainUntil, or ttlAt`);
    }
    if (sessData.familyId !== familyId) {
      throw new CutoverFenceError(`Target base session family binding mismatch for ${sanitizeId(sessData.id)}`);
    }
    if (sessData.retainUntil !== sessData.expiresAt + 30 * 24 * 60 * 60 * 1e3) {
      throw new CutoverFenceError(`Target session retainUntil must equal expiresAt + 30 days for base session ${sanitizeId(sessData.id)}`);
    }
    const ttlMs = getTimestampMs(sessData.ttlAt);
    if (ttlMs === null || ttlMs !== sessData.retainUntil) {
      throw new CutoverFenceError(`Target session ttlAt must equal retainUntil for base session ${sanitizeId(sessData.id)}`);
    }
    const unsealedSess = codec.open(sessData.sealed, accessAad({ id: sessData.id, familyId }));
    if (!unsealedSess) {
      throw new CutoverFenceError(`Target base session decrypt failed for ${sanitizeId(sessData.id)}`);
    }
    const clientId = unsealedFam.clientId ?? unsealedSess.clientId;
    if (!clientId || typeof clientId !== "string") {
      throw new CutoverFenceError(`Target base family missing decrypted clientId for ${sanitizeId(familyId)}`);
    }
    const nsAccessToken = unsealedUp.nsAccessToken;
    if (!nsAccessToken || typeof nsAccessToken !== "string") {
      throw new CutoverFenceError(`Target base upstream missing decrypted nsAccessToken for ${sanitizeId(familyId)}`);
    }
    const nsUsername = unsealedUp.nsUsername;
    if (!nsUsername || typeof nsUsername !== "string") {
      throw new CutoverFenceError(`Target base upstream missing decrypted nsUsername for ${sanitizeId(familyId)}`);
    }
    const activeRefDoc = targets.get("activeRefresh");
    if (!activeRefDoc) throw new CutoverFenceError(`Candidate ${sanitizeId(candidate.id)} missing active refresh target document`);
    const activeRefData = activeRefDoc;
    if (activeRefData.familyId !== familyId || activeRefData.status !== "active" || activeRefData.generation !== 1 || activeRefData.v !== 2) {
      throw new CutoverFenceError(`Target active refresh token invalid for base family ${sanitizeId(familyId)}`);
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
      previousRefresh: null,
      retiredRefreshFingerprints: [],
      ...targetSubjectFields(famData),
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
    if (!codeDoc) throw new CutoverFenceError(`Candidate ${sanitizeId(candidate.id)} missing authCodes target document`);
    const codeData = codeDoc;
    if (codeData.v !== 2 || typeof codeData.expiresAt !== "number" || codeData.expiresAt <= 0 || !codeData.ttlAt) {
      throw new CutoverFenceError(`Target auth code ${sanitizeId(codeData.id)} missing v: 2, valid positive expiresAt, or ttlAt`);
    }
    const ttlMs = getTimestampMs(codeData.ttlAt);
    if (ttlMs === null || ttlMs !== codeData.expiresAt) {
      throw new CutoverFenceError(`Target auth code ${sanitizeId(codeData.id)} ttlAt must equal expiresAt`);
    }
    const unsealed = codeData.sealed ? codec.open(codeData.sealed, `code:${codeData.id}`) : null;
    if (!unsealed) throw new CutoverFenceError(`Target auth code decrypt failed for ${sanitizeId(codeData.id)}`);
    if (typeof codeData.used !== "boolean") {
      throw new CutoverFenceError(`Target auth code ${sanitizeId(codeData.id)} missing boolean used property`);
    }
    if (typeof unsealed.used !== "boolean") {
      throw new CutoverFenceError(`Target auth code ${sanitizeId(codeData.id)} unsealed payload missing boolean used property`);
    }
    if (codeData.used !== unsealed.used) {
      throw new CutoverFenceError(`Target auth code ${sanitizeId(codeData.id)} top-level used (${codeData.used}) does not match sealed used (${unsealed.used})`);
    }
    const rawPending = unsealed.pending || {};
    const rawNsTokens = unsealed.nsTokens || {};
    const clientId = unsealed.clientId;
    if (!clientId || typeof clientId !== "string") {
      throw new CutoverFenceError(`Target auth code ${sanitizeId(codeData.id)} missing decrypted clientId`);
    }
    const nsAccessToken = rawNsTokens.access_token;
    if (!nsAccessToken || typeof nsAccessToken !== "string") {
      throw new CutoverFenceError(`Target auth code ${sanitizeId(codeData.id)} missing decrypted nsTokens.access_token`);
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
      used: codeData.used,
      v: 2
    };
  }
  if (candidate.kind === "resumeTokens") {
    const resDoc = targets.get("resumeTokens");
    if (!resDoc) throw new CutoverFenceError(`Candidate ${sanitizeId(candidate.id)} missing resumeTokens target document`);
    const resData = resDoc;
    if (resData._mcp_format !== "v3_target" || resData.v !== 2 || typeof resData.expiresAt !== "number" || resData.expiresAt <= 0 || !resData.ttlAt) {
      throw new CutoverFenceError(`Target resume token ${sanitizeId(resData.id)} missing _mcp_format v3_target, v: 2, positive expiresAt, or ttlAt`);
    }
    if (typeof resData.consumedAt !== "number") {
      throw new CutoverFenceError(`Target resume token ${sanitizeId(resData.id)} missing numeric consumedAt`);
    }
    const ttlMs = getTimestampMs(resData.ttlAt);
    if (ttlMs === null || ttlMs !== resData.expiresAt) {
      throw new CutoverFenceError(`Target resume token ${sanitizeId(resData.id)} ttlAt must equal expiresAt`);
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
    if (!clientDoc) throw new CutoverFenceError(`Candidate ${sanitizeId(candidate.id)} missing clients target document`);
    const clientData = clientDoc;
    if (clientData._mcp_format !== "v3_target" || clientData.v !== 2) {
      throw new CutoverFenceError(`Target oauth client ${sanitizeId(clientData.client_id ?? clientData.id)} missing _mcp_format v3_target`);
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
  throw new CutoverFenceError(`Unsupported candidate kind for target projection: ${candidate.kind}`);
}
__name(projectTargetLogical, "projectTargetLogical");

// src/cutover/canonical-core.mjs
import { createHash as createHash2, createHmac as createHmac3, randomUUID } from "node:crypto";
var SUPPORTED_CUTOVER_NAMESPACES = ["mcp", "pwmcp", "readonly_mcp"];
var APPROVED_GRAPH_PROJECTOR_ID = PROJECTOR_ID;
var APPROVED_GRAPH_PROJECTOR_VERSION = PROJECTOR_VERSION;
var NONEMPTY_PROJECTOR_KEYS = ["projectorId", "projectorVersion", "projectorDigest"];
function isSupportedCutoverNamespace(namespace) {
  return SUPPORTED_CUTOVER_NAMESPACES.includes(namespace);
}
__name(isSupportedCutoverNamespace, "isSupportedCutoverNamespace");
function assertSupportedCutoverNamespace(namespace) {
  if (!isSupportedCutoverNamespace(namespace)) {
    throw new CutoverFenceError(
      `Unsupported cutover namespace: ${namespace}. Supported namespaces are: ${SUPPORTED_CUTOVER_NAMESPACES.join(", ")}`
    );
  }
}
__name(assertSupportedCutoverNamespace, "assertSupportedCutoverNamespace");
function sanitizeId2(_id) {
  return "[redacted]";
}
__name(sanitizeId2, "sanitizeId");
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
  "malformedRecords",
  "subject_value_missing"
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
function validateMapKeysExact(obj, allowedKeys, label = "object") {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
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
    if (!(k in obj) || obj[k] === void 0) {
      throw new CutoverFenceError(`Missing required field '${k}' in ${label}`);
    }
  }
}
__name(validateMapKeysExact, "validateMapKeysExact");
function validateMigrationIdentityFields(doc, expectedNamespace, expectedEpoch, expectedRunId) {
  if (!doc || typeof doc !== "object") {
    throw new CutoverFenceError("Migration manifest must be an object");
  }
  if (doc.schemaVersion !== 2) {
    throw new CutoverFenceError(`Unsupported manifest schemaVersion: expected 2, got ${doc.schemaVersion}`);
  }
  if (doc.namespace !== expectedNamespace) {
    throw new CutoverFenceError(
      `Manifest namespace mismatch: expected ${expectedNamespace}, got ${doc.namespace}`
    );
  }
  if (doc.epoch !== expectedEpoch) {
    throw new CutoverFenceError(`Manifest epoch mismatch: expected ${expectedEpoch}, got ${doc.epoch}`);
  }
  if (expectedRunId && doc.migrationRunId !== expectedRunId) {
    throw new CutoverFenceError(
      `Manifest migrationRunId mismatch: expected ${expectedRunId}, got ${doc.migrationRunId}`
    );
  }
  if (typeof doc.codeSha !== "string" || !/^[0-9a-f]{40}$/.test(doc.codeSha)) {
    throw new CutoverFenceError(`Invalid codeSha in manifest: ${doc.codeSha}`);
  }
  if (typeof doc.codeArtifact !== "string" || !doc.codeArtifact.trim()) {
    throw new CutoverFenceError("Invalid codeArtifact in manifest");
  }
  if (typeof doc.packageIntegrity !== "string" || !doc.packageIntegrity.trim()) {
    throw new CutoverFenceError("Invalid packageIntegrity in manifest");
  }
  if (typeof doc.protocolDigest !== "string" || !/^[0-9a-f]{64}$/.test(doc.protocolDigest)) {
    throw new CutoverFenceError(`Invalid protocolDigest in manifest: ${doc.protocolDigest}`);
  }
  if (typeof doc.assemblyDigest !== "string" || !/^[0-9a-f]{64}$/.test(doc.assemblyDigest)) {
    throw new CutoverFenceError(`Invalid assemblyDigest in manifest: ${doc.assemblyDigest}`);
  }
  if (typeof doc.indexSchemaDigest !== "string" || !/^[0-9a-f]{64}$/.test(doc.indexSchemaDigest)) {
    throw new CutoverFenceError(`Invalid indexSchemaDigest in manifest: ${doc.indexSchemaDigest}`);
  }
  if (doc.encoderVersion !== 1) {
    throw new CutoverFenceError(`Unsupported encoderVersion: expected 1, got ${doc.encoderVersion}`);
  }
  if (typeof doc.planDigest !== "string" || !/^[0-9a-f]{64}$/.test(doc.planDigest)) {
    throw new CutoverFenceError(`Invalid planDigest in manifest: ${doc.planDigest}`);
  }
}
__name(validateMigrationIdentityFields, "validateMigrationIdentityFields");
function validateCandidateProjection(kind, candidateId, proj) {
  if (!proj || typeof proj !== "object" || Array.isArray(proj)) {
    throw new CutoverFenceError(`Projector must return a plain non-null object for candidate ${candidateId}`);
  }
  const keys = Object.keys(proj);
  if (keys.length === 0) {
    throw new CutoverFenceError(`Projector returned empty projection for candidate ${candidateId}`);
  }
  if (kind === "clients" || kind === "client") {
    if (typeof proj.clientId !== "string" || !proj.clientId) {
      throw new CutoverFenceError(`Projector projection for ${kind} candidate ${candidateId} missing required clientId`);
    }
  } else if (kind === "pr56Families" || kind === "family") {
    if (typeof proj.familyId !== "string" || typeof proj.generation !== "number") {
      throw new CutoverFenceError(`Projector projection for ${kind} candidate ${candidateId} missing required familyId or generation`);
    }
  } else if (kind === "baseFormatTokens" || kind === "base") {
    if (typeof proj.familyId !== "string" && typeof proj.accessTokenId !== "string" && typeof proj.accessToken !== "string") {
      throw new CutoverFenceError(`Projector projection for ${kind} candidate ${candidateId} missing required familyId or accessTokenId`);
    }
  } else if (kind === "authCodes" || kind === "code") {
    if (typeof proj.codeId !== "string" && typeof proj.code !== "string") {
      throw new CutoverFenceError(`Projector projection for ${kind} candidate ${candidateId} missing required codeId`);
    }
  } else if (kind === "resumeTokens" || kind === "resume") {
    if (typeof proj.resumeId !== "string" && typeof proj.resumeTokenId !== "string" && typeof proj.token !== "string") {
      throw new CutoverFenceError(`Projector projection for ${kind} candidate ${candidateId} missing required resumeId`);
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
function isTargetFormatRow(collection, data) {
  if (data === null || data === void 0 || typeof data !== "object" || Array.isArray(data)) {
    throw new CutoverFenceError(`Malformed document in '${collection}': data must be a non-null object`);
  }
  if (collection.endsWith("_auth_codes")) {
    const isTarget = typeof data.sealed === "string";
    const legacyPayload = data.code !== void 0 || data.rawCode !== void 0 || data.clientId !== void 0 || data.client_id !== void 0 || data.redirectUri !== void 0 || data.redirect_uri !== void 0 || data.codeChallenge !== void 0 || data.code_challenge !== void 0 || data.nsAccessToken !== void 0 || data.pending !== void 0 || data.nsTokens !== void 0;
    const isSource = !isTarget && (legacyPayload || data.expiresAt !== void 0);
    if (isTarget && legacyPayload) throw new CutoverFenceError(`Ambiguous auth_codes document format in '${collection}'`);
    if (isTarget && !isSource) return true;
    if (isSource && !isTarget) return false;
    throw new CutoverFenceError(`Ambiguous auth_codes document format in '${collection}'`);
  }
  if (collection.endsWith("_resume_tokens")) {
    const isTarget = data.v === 2 && data._mcp_format === "v3_target";
    if (isTarget && (data.token !== void 0 || data.resumeToken !== void 0)) throw new CutoverFenceError(`Ambiguous resume_tokens document format in '${collection}'`);
    const isSource = data.v === void 0 && data._mcp_format === void 0 && (data.consumedAt !== void 0 || data.expiresAt !== void 0 || data.token !== void 0);
    if (isTarget && !isSource) return true;
    if (isSource && !isTarget) return false;
    throw new CutoverFenceError(`Ambiguous resume_tokens document format in '${collection}'`);
  }
  if (collection.endsWith("_oauth_clients")) {
    const hasClientId = typeof data.client_id === "string" || typeof data.clientId === "string";
    if (!hasClientId) {
      throw new CutoverFenceError(`Ambiguous oauth_clients document format in '${collection}': missing client_id`);
    }
    if (data._targetFormat !== void 0) {
      throw new CutoverFenceError(`Ambiguous oauth_clients document format in '${collection}': reserved field _targetFormat present`);
    }
    const isTarget = data._mcp_format === "v3_target";
    const isSource = data._mcp_format === void 0;
    if (isTarget && !isSource) return true;
    if (isSource && !isTarget) return false;
    throw new CutoverFenceError(`Ambiguous oauth_clients document format in '${collection}'`);
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
function assertIdentityKey(identityKey) {
  if (!(identityKey instanceof Uint8Array) || identityKey.byteLength !== 32) {
    throw new CutoverFenceError("A stable operation identity key is required");
  }
}
__name(assertIdentityKey, "assertIdentityKey");
function operationStorageId(namespace, operationId, identityKey) {
  assertSupportedCutoverNamespace(namespace);
  assertIdentityKey(identityKey);
  if (typeof operationId !== "string") {
    throw new CutoverFenceError("Operation id must be a string");
  }
  const value = JSON.stringify(["netsapiens-mcp/operation-id", 1, namespace, operationId]);
  return "op1_" + createHmac3("sha256", deriveKey(identityKey)).update(value, "utf8").digest("hex");
}
__name(operationStorageId, "operationStorageId");
function operationKeyCheck(namespace, identityKey) {
  assertIdentityKey(identityKey);
  return createHmac3("sha256", deriveKey(identityKey)).update(JSON.stringify(["netsapiens-mcp/operation-key-check", 1, namespace]), "utf8").digest("hex");
}
__name(operationKeyCheck, "operationKeyCheck");
function claimOwnerStorageId(namespace, owner, identityKey) {
  assertIdentityKey(identityKey);
  if (typeof owner !== "string" || !owner.length) throw new CutoverFenceError("Claim owner is required");
  return "owner1_" + createHmac3("sha256", deriveKey(identityKey)).update(JSON.stringify(["netsapiens-mcp/claim-owner", 1, namespace, owner]), "utf8").digest("hex");
}
__name(claimOwnerStorageId, "claimOwnerStorageId");
function storedOperationRef(db, namespace, storageId) {
  return getCutoverOperationsColRef(db, namespace).doc(storageId);
}
__name(storedOperationRef, "storedOperationRef");
function getCutoverOperationDocRef(db, namespace, operationId, identityKey) {
  return storedOperationRef(db, namespace, operationStorageId(namespace, operationId, identityKey));
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
        throw new CutoverFenceError("Invalid lone high surrogate in string");
      }
      const next = str.charCodeAt(i + 1);
      if (next < 56320 || next > 57343) {
        throw new CutoverFenceError("Invalid lone high surrogate in string");
      }
      i++;
    } else if (code >= 56320 && code <= 57343) {
      throw new CutoverFenceError("Invalid lone low surrogate in string");
    }
  }
}
__name(validateNoLoneSurrogates, "validateNoLoneSurrogates");
function normalizeValue(val) {
  if (val === null) return ["null"];
  if (typeof val === "boolean") return ["boolean", val];
  if (typeof val === "number") {
    if (!Number.isFinite(val)) {
      throw new CutoverFenceError(`Cannot normalize non-finite number: ${val}`);
    }
    const normalizedNum = Object.is(val, -0) ? 0 : val;
    if (Number.isInteger(normalizedNum)) {
      if (!Number.isSafeInteger(normalizedNum)) {
        throw new CutoverFenceError(`Cannot normalize unsafe integer: ${normalizedNum}`);
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
      throw new CutoverFenceError("Invalid Date object");
    }
    const seconds = Math.floor(ms / 1e3);
    const nanoseconds = (ms - seconds * 1e3) * 1e6;
    return ["timestamp", String(seconds), nanoseconds];
  }
  if (val && typeof val === "object" && (val.constructor?.name === "Timestamp" || typeof val.toMillis === "function" && typeof val.seconds === "number" && typeof val.nanoseconds === "number" && Object.keys(val).every(
    (k) => ["seconds", "nanoseconds", "_seconds", "_nanoseconds"].includes(k)
  ))) {
    if (!Number.isSafeInteger(val.seconds) || !Number.isSafeInteger(val.nanoseconds) || val.nanoseconds < 0 || val.nanoseconds >= 1e9) {
      throw new CutoverFenceError("Invalid Firestore Timestamp field ranges");
    }
    return ["timestamp", String(val.seconds), val.nanoseconds];
  }
  if (val instanceof Uint8Array || typeof Buffer !== "undefined" && Buffer.isBuffer(val)) {
    return ["bytes", Buffer.from(val).toString("base64")];
  }
  if (Array.isArray(val)) {
    for (let i = 0; i < val.length; i++) {
      if (!(i in val)) {
        throw new CutoverFenceError(`Sparse arrays are not supported at index ${i}`);
      }
    }
    return ["array", val.map(normalizeValue)];
  }
  if (typeof val === "object") {
    if (val.constructor && val.constructor !== Object && val.constructor.name !== "Object") {
      throw new CutoverFenceError(`Unsupported object class: ${val.constructor.name}`);
    }
    const keys = Object.keys(val).sort(canonicalCompare);
    return ["map", keys.map((k) => {
      validateNoLoneSurrogates(k);
      return [k, normalizeValue(val[k])];
    })];
  }
  throw new CutoverFenceError(`Unsupported type for canonical normalization: ${typeof val}`);
}
__name(normalizeValue, "normalizeValue");
function rfc8785CanonicalJson(val) {
  if (val === null) return "null";
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") {
    if (!Number.isFinite(val)) {
      throw new CutoverFenceError(`Cannot serialize non-finite number: ${val}`);
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
  throw new CutoverFenceError(`Unsupported type for canonical JSON: ${typeof val}`);
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
  return createHmac3("sha256", rawKey).update(Buffer.from("netsapiens-mcp/cutover/v2", "utf8")).digest();
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
  return createHash2("sha256").update(Buffer.from(payload, "utf8")).digest("hex");
}
__name(D, "D");
function H(storeKey, purpose, namespace, epoch, value) {
  if (!storeKey || typeof storeKey !== "string" && !Buffer.isBuffer(storeKey) && !(storeKey instanceof Uint8Array)) {
    throw new CutoverFenceError("storeKey is REQUIRED for keyed HMAC operations");
  }
  const K = deriveKey(storeKey);
  const payload = frame(purpose, namespace, epoch, value);
  return createHmac3("sha256", K).update(Buffer.from(payload, "utf8")).digest("hex");
}
__name(H, "H");
function computeKeyedDocId(storeKey, purpose, namespace, epoch, collectionKey, rawId) {
  return H(storeKey, purpose, namespace, epoch, [collectionKey, rawId]);
}
__name(computeKeyedDocId, "computeKeyedDocId");
function computeSourceRecordDigest(storeKey, namespace, epoch, collectionKey, sourceId, data) {
  if (data === null || data === void 0 || typeof data !== "object" || Array.isArray(data)) {
    throw new CutoverFenceError(`Malformed source data in '${collectionKey}/${sourceId}'`);
  }
  return H(storeKey, "source-record", namespace, epoch, [collectionKey, sourceId, data]);
}
__name(computeSourceRecordDigest, "computeSourceRecordDigest");
function computeTargetRecordDigest(storeKey, namespace, epoch, collectionKey, targetId, data) {
  if (data === null || data === void 0 || typeof data !== "object" || Array.isArray(data)) {
    throw new CutoverFenceError(`Malformed target data in '${collectionKey}/${targetId}'`);
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
    throw new CutoverFenceError("Manifest must be an object");
  }
  const ns = namespace ?? manifest.namespace;
  const ep = epoch ?? manifest.epoch;
  if (!ns || !ep) {
    throw new CutoverFenceError("namespace and epoch are required to compute manifest digest");
  }
  return D("final", ns, ep, manifest);
}
__name(computeManifestDigest, "computeManifestDigest");
function computeProtocolDigest(moduleSource) {
  const buf = typeof moduleSource === "string" ? Buffer.from(moduleSource, "utf8") : moduleSource;
  return createHash2("sha256").update(buf).digest("hex");
}
__name(computeProtocolDigest, "computeProtocolDigest");
var FIRESTORE_MAX_DOCUMENT_SIZE_BYTES = 1048576;
var FIRESTORE_MAX_REQUEST_SIZE_BYTES = 10485760;
var FIRESTORE_MAX_INDEX_ENTRIES = 4e4;
var FIRESTORE_MAX_INDEX_BYTES = 8388608;
var FIRESTORE_MAX_NESTING_DEPTH = 20;
var FIRESTORE_MAX_FIELD_TRANSFORMS = 500;
var FIRESTORE_TRANSACTION_READ_DEADLINE_MS = 16e3;
var ACTIVE_MONOTONIC_TIMERS = /* @__PURE__ */ new WeakSet();
function startMonotonicTimer() {
  const start = process.hrtime.bigint();
  const timer = {
    elapsedMs() {
      return Number(process.hrtime.bigint() - start) / 1e6;
    },
    assertUnderDeadline(label = "Transaction callback") {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      if (ms > FIRESTORE_TRANSACTION_READ_DEADLINE_MS) {
        throw new CutoverFenceError(
          `${label} elapsed duration (${Math.round(ms)} ms) exceeds 16,000 ms lock deadline`
        );
      }
    }
  };
  ACTIVE_MONOTONIC_TIMERS.add(timer);
  return timer;
}
__name(startMonotonicTimer, "startMonotonicTimer");
function isMonotonicTimer(t) {
  return Boolean(t && typeof t === "object" && ACTIVE_MONOTONIC_TIMERS.has(t));
}
__name(isMonotonicTimer, "isMonotonicTimer");
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
    throw new CutoverFenceError(
      `Prepared migration manifest canonical size (${sizeBytes} bytes) exceeds 80% limit (${PREFLIGHT_MAX_DOC_BYTES} bytes)`
    );
  }
  const estFirestoreSize = computeEstimatedFirestoreDocSize(prep);
  if (estFirestoreSize > PREFLIGHT_MAX_DOC_BYTES) {
    throw new CutoverFenceError(
      `Prepared migration manifest estimated Firestore storage size (${estFirestoreSize} bytes) exceeds 80% limit (${PREFLIGHT_MAX_DOC_BYTES} bytes)`
    );
  }
  const depth = getMaxDepth(prep);
  if (depth > PREFLIGHT_MAX_NESTING_DEPTH) {
    throw new CutoverFenceError(
      `Prepared migration manifest nesting depth (${depth}) exceeds 80% budget (${PREFLIGHT_MAX_NESTING_DEPTH})`
    );
  }
  const indexMetrics = countIndexMetrics(prep);
  if (indexMetrics.entries > PREFLIGHT_MAX_INDEX_ENTRIES) {
    throw new CutoverFenceError(
      `Prepared migration manifest index entries (${indexMetrics.entries}) exceeds 80% budget (${PREFLIGHT_MAX_INDEX_ENTRIES})`
    );
  }
  if (indexMetrics.bytes > PREFLIGHT_MAX_INDEX_BYTES) {
    throw new CutoverFenceError(
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
  if (options.readDurationMs !== void 0) {
    if (options.readDurationMs > FIRESTORE_TRANSACTION_READ_DEADLINE_MS) {
      throw new CutoverFenceError(
        `Preflight read duration (${options.readDurationMs} ms) exceeds 16,000 ms lock deadline`
      );
    }
  }
  return { sizeBytes, estFirestoreSize, depth, indexEntries: indexMetrics.entries, indexBytes: indexMetrics.bytes };
}
__name(validateMigrationPreflightLimits, "validateMigrationPreflightLimits");
function validateProspectiveDocBudget(doc, label = "Document") {
  if (!doc || typeof doc !== "object") {
    throw new CutoverFenceError(`${label} is missing or not an object`);
  }
  const estFirestoreSize = computeEstimatedFirestoreDocSize(doc);
  if (estFirestoreSize > PREFLIGHT_MAX_DOC_BYTES) {
    throw new CutoverFenceError(
      `${label} estimated Firestore size (${estFirestoreSize} bytes) exceeds 80% document budget (${PREFLIGHT_MAX_DOC_BYTES} bytes)`
    );
  }
  const depth = getMaxDepth(doc);
  if (depth > PREFLIGHT_MAX_NESTING_DEPTH) {
    throw new CutoverFenceError(
      `${label} nesting depth (${depth}) exceeds 80% budget (${PREFLIGHT_MAX_NESTING_DEPTH})`
    );
  }
  const indexMetrics = countIndexMetrics(doc);
  if (indexMetrics.entries > PREFLIGHT_MAX_INDEX_ENTRIES) {
    throw new CutoverFenceError(
      `${label} index entries (${indexMetrics.entries}) exceeds 80% budget (${PREFLIGHT_MAX_INDEX_ENTRIES})`
    );
  }
  if (indexMetrics.bytes > PREFLIGHT_MAX_INDEX_BYTES) {
    throw new CutoverFenceError(
      `${label} index bytes (${indexMetrics.bytes}) exceeds 80% budget (${PREFLIGHT_MAX_INDEX_BYTES})`
    );
  }
  const transforms = doc._transformsCount ?? 0;
  if (transforms > PREFLIGHT_MAX_FIELD_TRANSFORMS) {
    throw new CutoverFenceError(
      `${label} field transforms (${transforms}) exceeds 80% budget (${PREFLIGHT_MAX_FIELD_TRANSFORMS})`
    );
  }
  return { estFirestoreSize, depth, indexEntries: indexMetrics.entries, indexBytes: indexMetrics.bytes, transforms };
}
__name(validateProspectiveDocBudget, "validateProspectiveDocBudget");
function validateTransactionBudgetPlan(txPlan, label = "Transaction") {
  if (!txPlan || typeof txPlan !== "object") {
    throw new CutoverFenceError(`${label} transaction budget plan is missing or not an object`);
  }
  const commitBytes = txPlan.estimatedCommitBytes ?? txPlan.commitBytes;
  if (typeof commitBytes !== "number" || !Number.isSafeInteger(commitBytes) || commitBytes <= 0 || commitBytes > PREFLIGHT_MAX_REQUEST_BYTES) {
    throw new CutoverFenceError(
      `${label} estimated commit bytes (${commitBytes}) must be a positive integer <= 80% request budget (${PREFLIGHT_MAX_REQUEST_BYTES})`
    );
  }
  return { commitBytes };
}
__name(validateTransactionBudgetPlan, "validateTransactionBudgetPlan");
function validateCompleteMigrationPlan(plan) {
  if (!plan || typeof plan !== "object") {
    throw new CutoverFenceError("CompleteMigrationPlan must be a non-null object");
  }
  if (!plan.prepared || typeof plan.prepared !== "object") {
    throw new CutoverFenceError("CompleteMigrationPlan missing required prepared document");
  }
  const preparedMetrics = validateProspectiveDocBudget(plan.prepared, "Prepared manifest");
  validateTransactionBudgetPlan(plan.preparation, "Preparation");
  if (!Array.isArray(plan.items)) {
    throw new CutoverFenceError("CompleteMigrationPlan missing required items array");
  }
  const candidateCommitments = plan.prepared.candidateCommitments || [];
  if (plan.items.length !== candidateCommitments.length) {
    throw new CutoverFenceError(
      `CompleteMigrationPlan items count (${plan.items.length}) does not match prepared candidates count (${candidateCommitments.length})`
    );
  }
  const seenCandidateIds = /* @__PURE__ */ new Set();
  for (let i = 0; i < plan.items.length; i++) {
    const item = plan.items[i];
    if (!item || typeof item !== "object") {
      throw new CutoverFenceError(`Item plan at index ${i} is missing or not an object`);
    }
    if (typeof item.candidateId !== "string" || !item.candidateId.trim()) {
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
        `Candidate ${item.candidateId} target postimage [${j}]`
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
  if (!plan.finalization || typeof plan.finalization !== "object") {
    throw new CutoverFenceError("CompleteMigrationPlan missing required finalization section");
  }
  validateProspectiveDocBudget(plan.finalization.finalUpperBound, "Final manifest upper bound");
  validateProspectiveDocBudget(plan.finalization.markerUpperBound, "Marker document upper bound");
  validateProspectiveDocBudget(plan.finalization.controlUpperBound, "Finalization control upper bound");
  validateTransactionBudgetPlan(plan.finalization.transaction, "Finalization");
  if (!plan.activation || typeof plan.activation !== "object") {
    throw new CutoverFenceError("CompleteMigrationPlan missing required activation section");
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
    throw new CutoverFenceError("candidateCommitments must be an array");
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
      throw new CutoverFenceError(`candidateCommitments[${i}] must be an object`);
    }
    validateMapKeysExact(c, REQUIRED_CANDIDATE_KEYS, `candidateCommitments[${i}]`);
    if (typeof c.id !== "string" || !/^[0-9a-f]{64}$/.test(c.id)) {
      throw new CutoverFenceError(`candidateCommitments[${i}].id must be 64-char hex`);
    }
    const classificationKind = CANDIDATE_KIND_TO_CLASSIFICATION[c.kind];
    if (!classificationKind || !CLASSIFICATION_KEYS.includes(classificationKind)) {
      throw new CutoverFenceError(`candidateCommitments[${i}].kind must map to valid classification (${CLASSIFICATION_KEYS.join(", ")})`);
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
    let prevSourceKey = "";
    for (const s of c.sources) {
      if (!s || typeof s !== "object") {
        throw new CutoverFenceError(`Invalid source descriptor in candidate ${c.id}`);
      }
      validateMapKeysExact(s, ["collection", "id", "recordDigest"], `candidate ${c.id} source`);
      if (typeof s.collection !== "string" || typeof s.id !== "string" || !/^[0-9a-f]{64}$/.test(s.id) || !/^[0-9a-f]{64}$/.test(s.recordDigest)) {
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
    let prevTargetKey = "";
    for (const t of c.targets) {
      if (!t || typeof t !== "object") {
        throw new CutoverFenceError(`Invalid target descriptor in candidate ${c.id}`);
      }
      validateMapKeysExact(t, ["collection", "id"], `candidate ${c.id} target`);
      if (typeof t.collection !== "string" || typeof t.id !== "string" || !/^[0-9a-f]{64}$/.test(t.id)) {
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
__name(validateCandidateCommitments, "validateCandidateCommitments");
function validateReceipt(receipt, expectedNamespace, expectedEpoch, expectedRunId) {
  if (!receipt || typeof receipt !== "object") {
    throw new CutoverFenceError("Receipt must be an object");
  }
  validateMapKeysExact(receipt, REQUIRED_RECEIPT_KEYS, "receipt");
  validateMigrationIdentityFields(receipt, expectedNamespace, expectedEpoch, expectedRunId);
  if (receipt.kind !== "receipt") {
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
  const validDispositions = ["written", "retained"];
  if (!validDispositions.includes(receipt.disposition)) {
    throw new CutoverFenceError(
      `Receipt disposition must be one of [${validDispositions.join(", ")}], got '${receipt.disposition}'`
    );
  }
  const allowedSources = getSourceCollectionAllowlist(expectedNamespace);
  const allowedTargets = getTargetCollectionAllowlist(expectedNamespace);
  if (!Array.isArray(receipt.sourceAfter)) {
    throw new CutoverFenceError("Receipt sourceAfter must be an array of source after-state descriptors");
  }
  for (const s of receipt.sourceAfter) {
    if (!s || typeof s !== "object") {
      throw new CutoverFenceError("Invalid sourceAfter item in receipt");
    }
    validateMapKeysExact(s, ["collection", "id", "recordDigest"], "receipt sourceAfter item");
    if (typeof s.collection !== "string" || typeof s.id !== "string" || !/^[0-9a-f]{64}$/.test(s.id)) {
      throw new CutoverFenceError("Invalid sourceAfter collection or id format");
    }
    if (!allowedSources.includes(s.collection)) {
      throw new CutoverFenceError(`Receipt sourceAfter collection '${s.collection}' not in allowlist`);
    }
    if (s.recordDigest !== null && (typeof s.recordDigest !== "string" || !/^[0-9a-f]{64}$/.test(s.recordDigest))) {
      throw new CutoverFenceError("sourceAfter recordDigest must be 64-char hex or null");
    }
  }
  if (!Array.isArray(receipt.targetAfter)) {
    throw new CutoverFenceError("Receipt targetAfter must be an array of target after-state descriptors");
  }
  for (const t of receipt.targetAfter) {
    if (!t || typeof t !== "object") {
      throw new CutoverFenceError("Invalid targetAfter item in receipt");
    }
    validateMapKeysExact(t, ["collection", "id", "recordDigest"], "receipt targetAfter item");
    if (typeof t.collection !== "string" || typeof t.id !== "string" || !/^[0-9a-f]{64}$/.test(t.id) || typeof t.recordDigest !== "string" || !/^[0-9a-f]{64}$/.test(t.recordDigest)) {
      throw new CutoverFenceError("Invalid targetAfter descriptor format in receipt");
    }
    if (!allowedTargets.includes(t.collection)) {
      throw new CutoverFenceError(`Receipt targetAfter collection '${t.collection}' not in allowlist`);
    }
  }
  if (!Number.isInteger(receipt.completedAt) || receipt.completedAt <= 0) {
    throw new CutoverFenceError("Receipt completedAt must be a positive integer timestamp");
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
    throw new CutoverFenceError("planSpec must be a non-null object");
  }
  return D("plan", namespace, epoch, planSpec);
}
__name(computePlanDigest, "computePlanDigest");
var REQUIRED_PLAN_SPEC_KEYS = [
  "schemaVersion",
  "namespace",
  "epoch",
  "runId",
  "codeSha",
  "codeArtifact",
  "packageIntegrity",
  "protocolDigest",
  "assemblyDigest",
  "indexSchemaDigest",
  "encoderVersion",
  "candidates",
  "expectedTargetCounts",
  "physicalCounts"
];
function validatePlanSpec(planSpec, prepDoc, namespace, epoch, migrationRunId) {
  if (!planSpec || typeof planSpec !== "object") {
    throw new CutoverFenceError("planSpec must be a non-null object");
  }
  validateMapKeysExact(planSpec, REQUIRED_PLAN_SPEC_KEYS, "planSpec");
  if ("planDigest" in planSpec || "preparedManifestDigest" in planSpec || "migrationManifestDigest" in planSpec || "receiptSetDigest" in planSpec) {
    throw new CutoverFenceError("planSpec must not contain self-digest, prepared digest, receipt digest or final digest");
  }
  if (planSpec.schemaVersion !== 2 || prepDoc && prepDoc.schemaVersion !== 2) {
    throw new CutoverFenceError("planSpec schemaVersion must be 2");
  }
  if (planSpec.namespace !== namespace || prepDoc && prepDoc.namespace !== namespace) {
    throw new CutoverFenceError("planSpec namespace mismatch");
  }
  if (planSpec.epoch !== epoch || prepDoc && prepDoc.epoch !== epoch) {
    throw new CutoverFenceError("planSpec epoch mismatch");
  }
  if (planSpec.runId !== migrationRunId || prepDoc && prepDoc.migrationRunId !== migrationRunId) {
    throw new CutoverFenceError("planSpec runId mismatch");
  }
  if (typeof planSpec.codeSha !== "string" || !/^[0-9a-f]{40}$/.test(planSpec.codeSha) || prepDoc && prepDoc.codeSha !== planSpec.codeSha) {
    throw new CutoverFenceError("planSpec codeSha must be a 40-character lowercase hex string matching prepared manifest");
  }
  if (typeof planSpec.codeArtifact !== "string" || !planSpec.codeArtifact.trim() || prepDoc && prepDoc.codeArtifact !== planSpec.codeArtifact) {
    throw new CutoverFenceError("planSpec codeArtifact must be a non-empty string matching prepared manifest");
  }
  if (typeof planSpec.packageIntegrity !== "string" || !planSpec.packageIntegrity.startsWith("sha512-")) {
    throw new CutoverFenceError("planSpec packageIntegrity must be a valid sha512 integrity string");
  }
  if (prepDoc && prepDoc.packageIntegrity !== planSpec.packageIntegrity) {
    throw new CutoverFenceError("planSpec packageIntegrity mismatch with prepared manifest");
  }
  if (typeof planSpec.protocolDigest !== "string" || !/^[0-9a-f]{64}$/.test(planSpec.protocolDigest) || prepDoc && prepDoc.protocolDigest !== planSpec.protocolDigest) {
    throw new CutoverFenceError("planSpec protocolDigest must be a 64-character lowercase hex string matching prepared manifest");
  }
  if (typeof planSpec.assemblyDigest !== "string" || !/^[0-9a-f]{64}$/.test(planSpec.assemblyDigest) || prepDoc && prepDoc.assemblyDigest !== planSpec.assemblyDigest) {
    throw new CutoverFenceError("planSpec assemblyDigest must be a 64-character lowercase hex string matching prepared manifest");
  }
  if (typeof planSpec.indexSchemaDigest !== "string" || !/^[0-9a-f]{64}$/.test(planSpec.indexSchemaDigest) || prepDoc && prepDoc.indexSchemaDigest !== planSpec.indexSchemaDigest) {
    throw new CutoverFenceError("planSpec indexSchemaDigest must be a 64-character lowercase hex string matching prepared manifest");
  }
  if (planSpec.encoderVersion !== 1 || prepDoc && prepDoc.encoderVersion !== 1) {
    throw new CutoverFenceError("planSpec encoderVersion must be 1");
  }
  validateMapKeysExact(planSpec.physicalCounts, PHYSICAL_COUNT_KEYS, "planSpec physicalCounts");
  validateMapKeysExact(planSpec.expectedTargetCounts, TARGET_COUNT_KEYS, "planSpec expectedTargetCounts");
  if (prepDoc) {
    if (C(planSpec.physicalCounts) !== C(prepDoc.physicalCounts)) {
      throw new CutoverFenceError("planSpec physicalCounts mismatch with prepared manifest");
    }
    if (C(planSpec.expectedTargetCounts) !== C(prepDoc.expectedTargetCounts)) {
      throw new CutoverFenceError("planSpec expectedTargetCounts mismatch with prepared manifest");
    }
  }
  if (!Array.isArray(planSpec.candidates)) {
    throw new CutoverFenceError("planSpec candidates must be an array");
  }
  if (prepDoc) {
    if (!Array.isArray(prepDoc.candidateCommitments)) {
      throw new CutoverFenceError("prepDoc candidateCommitments must be an array");
    }
    if (planSpec.candidates.length !== prepDoc.candidateCommitments.length) {
      throw new CutoverFenceError("planSpec candidates count must equal prepared candidateCommitments count");
    }
  }
  const ALLOWED_CANDIDATE_KINDS = /* @__PURE__ */ new Set(["pr56Families", "baseFormatTokens", "authCodes", "resumeTokens", "clients"]);
  const distinctNames = getCutoverDistinctCollectionNames(namespace);
  const sourceSet = new Set(Object.keys(distinctNames.source));
  const targetSet = new Set(Object.keys(distinctNames.target));
  const REQUIRED_CANDIDATE_KEYS2 = ["candidateId", "kind", "sources", "targets", "logicalDigest", "sourceActions", "targetBounds"];
  const REQUIRED_SOURCE_KEYS = ["collection", "id", "recordDigest"];
  const REQUIRED_TARGET_KEYS = ["collection", "id"];
  const REQUIRED_ACTION_KEYS = ["collection", "id", "action"];
  const REQUIRED_BOUND_KEYS = ["sizeBytes", "depth", "indexEntries", "indexBytes"];
  let prevCandidateId = "";
  for (let i = 0; i < planSpec.candidates.length; i++) {
    const c = planSpec.candidates[i];
    if (!c || typeof c !== "object") {
      throw new CutoverFenceError("planSpec candidate must be an object");
    }
    validateMapKeysExact(c, REQUIRED_CANDIDATE_KEYS2, "planSpec candidate");
    if (typeof c.candidateId !== "string" || !/^[0-9a-f]{64}$/.test(c.candidateId)) {
      throw new CutoverFenceError("planSpec candidateId must be a 64-character lowercase hex string");
    }
    if (i > 0 && canonicalCompare(c.candidateId, prevCandidateId) <= 0) {
      throw new CutoverFenceError("planSpec candidates must be strictly sorted by candidateId");
    }
    prevCandidateId = c.candidateId;
    if (!ALLOWED_CANDIDATE_KINDS.has(c.kind)) {
      throw new CutoverFenceError(`planSpec candidate kind '${c.kind}' is not allowed`);
    }
    if (typeof c.logicalDigest !== "string" || !/^[0-9a-f]{64}$/.test(c.logicalDigest)) {
      throw new CutoverFenceError("planSpec candidate logicalDigest must be a 64-character hex string");
    }
    if (prepDoc) {
      const prepC = prepDoc.candidateCommitments[i];
      if (c.candidateId !== prepC.id) {
        throw new CutoverFenceError("planSpec candidateId mismatch with prepared commitment id");
      }
      if (c.kind !== prepC.kind) {
        throw new CutoverFenceError("planSpec candidate kind mismatch with prepared commitment kind");
      }
      if (c.logicalDigest !== prepC.logicalDigest) {
        throw new CutoverFenceError("planSpec candidate logicalDigest mismatch with prepared commitment logicalDigest");
      }
      if (C(c.sources) !== C(prepC.sources)) {
        throw new CutoverFenceError("planSpec candidate sources mismatch with prepared commitment sources");
      }
      if (C(c.targets) !== C(prepC.targets)) {
        throw new CutoverFenceError("planSpec candidate targets mismatch with prepared commitment targets");
      }
    }
    if (!Array.isArray(c.sources)) {
      throw new CutoverFenceError("planSpec candidate sources must be an array");
    }
    const sourceKeySet = /* @__PURE__ */ new Set();
    for (const src of c.sources) {
      if (!src || typeof src !== "object") throw new CutoverFenceError("planSpec candidate source must be an object");
      validateMapKeysExact(src, REQUIRED_SOURCE_KEYS, "planSpec candidate source");
      if (!sourceSet.has(src.collection)) throw new CutoverFenceError(`Unknown source collection '${src.collection}'`);
      if (typeof src.id !== "string" || !/^[0-9a-f]{64}$/.test(src.id)) {
        throw new CutoverFenceError("planSpec candidate source id must be a 64-character lowercase hex string");
      }
      if (typeof src.recordDigest !== "string" || !/^[0-9a-f]{64}$/.test(src.recordDigest)) {
        throw new CutoverFenceError("planSpec candidate source recordDigest must be a 64-character hex string");
      }
      const k = `${src.collection}:${src.id}`;
      if (sourceKeySet.has(k)) throw new CutoverFenceError(`Duplicate source key in candidate: ${k}`);
      sourceKeySet.add(k);
    }
    if (!Array.isArray(c.targets)) {
      throw new CutoverFenceError("planSpec candidate targets must be an array");
    }
    const targetKeySet = /* @__PURE__ */ new Set();
    for (const tgt of c.targets) {
      if (!tgt || typeof tgt !== "object") throw new CutoverFenceError("planSpec candidate target must be an object");
      validateMapKeysExact(tgt, REQUIRED_TARGET_KEYS, "planSpec candidate target");
      if (!targetSet.has(tgt.collection)) throw new CutoverFenceError(`Unknown target collection '${tgt.collection}'`);
      if (typeof tgt.id !== "string" || !/^[0-9a-f]{64}$/.test(tgt.id)) {
        throw new CutoverFenceError("planSpec candidate target id must be a 64-character lowercase hex string");
      }
      const k = `${tgt.collection}:${tgt.id}`;
      if (targetKeySet.has(k)) throw new CutoverFenceError(`Duplicate target key in candidate: ${k}`);
      targetKeySet.add(k);
    }
    if (!Array.isArray(c.sourceActions)) {
      throw new CutoverFenceError("planSpec candidate sourceActions must be an array");
    }
    if (c.sourceActions.length !== c.sources.length) {
      throw new CutoverFenceError("planSpec candidate sourceActions count must equal sources count");
    }
    const actionKeySet = /* @__PURE__ */ new Set();
    for (const sa of c.sourceActions) {
      if (!sa || typeof sa !== "object") throw new CutoverFenceError("planSpec candidate sourceAction must be an object");
      validateMapKeysExact(sa, REQUIRED_ACTION_KEYS, "planSpec candidate sourceAction");
      if (!sourceSet.has(sa.collection)) throw new CutoverFenceError(`Unknown sourceAction collection '${sa.collection}'`);
      if (typeof sa.id !== "string" || !/^[0-9a-f]{64}$/.test(sa.id)) {
        throw new CutoverFenceError("planSpec candidate sourceAction id must be a 64-character lowercase hex string");
      }
      if (!["delete", "replace", "retain"].includes(sa.action)) {
        throw new CutoverFenceError(`Invalid sourceAction action '${sa.action}': must be delete, replace, or retain`);
      }
      const k = `${sa.collection}:${sa.id}`;
      if (actionKeySet.has(k)) throw new CutoverFenceError(`Duplicate sourceAction key in candidate: ${k}`);
      if (!sourceKeySet.has(k)) throw new CutoverFenceError(`sourceAction key '${k}' does not match any source in candidate`);
      actionKeySet.add(k);
    }
    if (!Array.isArray(c.targetBounds)) {
      throw new CutoverFenceError("planSpec candidate targetBounds must be an array");
    }
    if (c.targetBounds.length !== c.targets.length) {
      throw new CutoverFenceError("planSpec candidate targetBounds count must equal targets count");
    }
    for (const tb of c.targetBounds) {
      if (!tb || typeof tb !== "object") throw new CutoverFenceError("planSpec candidate targetBound must be an object");
      validateMapKeysExact(tb, REQUIRED_BOUND_KEYS, "planSpec candidate targetBound");
      if (typeof tb.sizeBytes !== "number" || !Number.isSafeInteger(tb.sizeBytes) || tb.sizeBytes < 0 || tb.sizeBytes > PREFLIGHT_MAX_DOC_BYTES) {
        throw new CutoverFenceError(`targetBound sizeBytes (${tb.sizeBytes}) exceeds 80% document budget (${PREFLIGHT_MAX_DOC_BYTES})`);
      }
      if (typeof tb.depth !== "number" || !Number.isSafeInteger(tb.depth) || tb.depth < 0 || tb.depth > PREFLIGHT_MAX_NESTING_DEPTH) {
        throw new CutoverFenceError(`targetBound depth (${tb.depth}) exceeds 80% nesting depth budget (${PREFLIGHT_MAX_NESTING_DEPTH})`);
      }
      if (typeof tb.indexEntries !== "number" || !Number.isSafeInteger(tb.indexEntries) || tb.indexEntries < 0 || tb.indexEntries > PREFLIGHT_MAX_INDEX_ENTRIES) {
        throw new CutoverFenceError(`targetBound indexEntries (${tb.indexEntries}) exceeds 80% index entries budget (${PREFLIGHT_MAX_INDEX_ENTRIES})`);
      }
      if (typeof tb.indexBytes !== "number" || !Number.isSafeInteger(tb.indexBytes) || tb.indexBytes < 0 || tb.indexBytes > PREFLIGHT_MAX_INDEX_BYTES) {
        throw new CutoverFenceError(`targetBound indexBytes (${tb.indexBytes}) exceeds 80% index bytes budget (${PREFLIGHT_MAX_INDEX_BYTES})`);
      }
    }
  }
}
__name(validatePlanSpec, "validatePlanSpec");
function computeReceiptSetDigest(receipts, namespace, epoch) {
  if (!Array.isArray(receipts)) {
    throw new CutoverFenceError("Receipts must be an array");
  }
  const pairs = [];
  const candidateIds = /* @__PURE__ */ new Set();
  for (const r of receipts) {
    if (r.namespace !== namespace || r.epoch !== epoch) {
      throw new CutoverFenceError("Receipt namespace or epoch mismatch in receipt set");
    }
    if (candidateIds.has(r.candidateId)) {
      throw new CutoverFenceError(`Duplicate candidate receipt in receipt set: ${r.candidateId}`);
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
    throw new CutoverFenceError(
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
    "operationIdentityVersion",
    "operationIdentityKeyCheck",
    "lastTransitionReason"
  ];
  for (const key of Object.keys(record)) {
    if (!ALLOWED_CONTROL_KEYS.includes(key)) {
      throw new CutoverFenceError(
        `Unknown field '${key}' in cutover fence control record for namespace ${namespace}`
      );
    }
  }
  if (record.schemaVersion !== 1) {
    throw new CutoverFenceError(
      `Unsupported schemaVersion for namespace ${namespace}: expected 1, got ${record.schemaVersion}`
    );
  }
  if (record.namespace !== namespace) {
    throw new CutoverFenceError(
      `Namespace mismatch in cutover fence record: expected ${namespace}, got ${record.namespace}`
    );
  }
  if (typeof record.epoch !== "number" || !Number.isInteger(record.epoch) || record.epoch < 1) {
    throw new CutoverFenceError(
      `Invalid epoch in cutover fence record for namespace ${namespace}: ${record.epoch}`
    );
  }
  const validStates = ["legacy_open", "closing", "fenced", "migrating", "v3_ready", "v3_active"];
  if (typeof record.state !== "string" || !validStates.includes(record.state)) {
    throw new CutoverFenceError(
      `Invalid cutover fence state for namespace ${namespace}: ${String(record.state)}`
    );
  }
  if (typeof record.activeOperations !== "number" || !Number.isInteger(record.activeOperations) || record.activeOperations < 0) {
    throw new CutoverFenceError(
      `Invalid activeOperations in cutover fence record for namespace ${namespace}: ${String(record.activeOperations)}`
    );
  }
  if (typeof record.irreversible !== "boolean") {
    throw new CutoverFenceError(
      `Invalid irreversible field in cutover fence record for namespace ${namespace}: expected boolean, got ${typeof record.irreversible}`
    );
  }
  if (["legacy_open", "closing", "fenced", "migrating"].includes(record.state)) {
    if (record.emptyNamespace !== void 0) {
      throw new CutoverFenceError(
        `Invalid cutover fence invariants for namespace ${namespace}: ${record.state} cannot define emptyNamespace`
      );
    }
  }
  if (record.state === "legacy_open") {
    if (record.irreversible !== false) {
      throw new CutoverFenceError(
        `Invalid cutover fence invariants for namespace ${namespace}: legacy_open cannot have irreversible: true`
      );
    }
    if (record.migrationRunId !== void 0 || record.migrationManifestDigest !== void 0) {
      throw new CutoverFenceError(
        `Invalid cutover fence invariants for namespace ${namespace}: legacy_open cannot have migration markers`
      );
    }
  } else if (record.state === "closing" || record.state === "fenced") {
    if (record.migrationRunId !== void 0 || record.migrationManifestDigest !== void 0) {
      throw new CutoverFenceError(
        `Invalid cutover fence invariants for namespace ${namespace}: ${record.state} cannot have migration markers`
      );
    }
  } else if (record.state === "migrating") {
    if (typeof record.migrationRunId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(record.migrationRunId)) {
      throw new CutoverFenceError(
        `Invalid cutover fence invariants for namespace ${namespace}: migrating requires non-empty migrationRunId matching /^[A-Za-z0-9_-]{8,64}$/`
      );
    }
    if (record.migrationManifestDigest !== void 0) {
      throw new CutoverFenceError(
        `Invalid cutover fence invariants for namespace ${namespace}: migrating cannot have migrationManifestDigest before v3_ready`
      );
    }
  } else if (record.state === "v3_ready" || record.state === "v3_active") {
    if (typeof record.migrationRunId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(record.migrationRunId)) {
      throw new CutoverFenceError(
        `Invalid cutover fence invariants for namespace ${namespace}: ${record.state} requires migrationRunId matching /^[A-Za-z0-9_-]{8,64}$/`
      );
    }
    if (typeof record.migrationManifestDigest !== "string" || !/^[0-9a-f]{64}$/.test(record.migrationManifestDigest)) {
      throw new CutoverFenceError(
        `Invalid cutover fence invariants for namespace ${namespace}: ${record.state} requires migrationManifestDigest to be 64-char hex`
      );
    }
    if (typeof record.emptyNamespace !== "boolean") {
      throw new CutoverFenceError(
        `Invalid cutover fence invariants for namespace ${namespace}: ${record.state} requires emptyNamespace to be a boolean`
      );
    }
    if (record.emptyNamespace === true) {
      if (record.irreversible !== false) {
        throw new CutoverFenceError(
          `Invalid cutover fence invariants for namespace ${namespace}: emptyNamespace requires irreversible: false`
        );
      }
    } else {
      if (record.irreversible !== true) {
        throw new CutoverFenceError(
          `Invalid cutover fence invariants for namespace ${namespace}: non-empty ${record.state} requires irreversible: true`
        );
      }
    }
  }
  if (record.codeSha !== void 0) {
    if (typeof record.codeSha !== "string" || !/^[0-9a-f]{40}$/.test(record.codeSha)) {
      throw new CutoverFenceError(`Invalid codeSha in cutover fence record for namespace ${namespace}`);
    }
  }
  if (record.codeArtifact !== void 0) {
    if (typeof record.codeArtifact !== "string" || !record.codeArtifact.trim()) {
      throw new CutoverFenceError(`Invalid codeArtifact in cutover fence record for namespace ${namespace}`);
    }
  }
  if ((record.operationIdentityVersion !== void 0 || record.operationIdentityKeyCheck !== void 0) && (record.operationIdentityVersion !== 1 || typeof record.operationIdentityKeyCheck !== "string" || !/^[0-9a-f]{64}$/.test(record.operationIdentityKeyCheck))) {
    throw new CutoverFenceError("Invalid operation identity binding");
  }
  return {
    schemaVersion: 1,
    namespace,
    epoch: record.epoch,
    state: record.state,
    activeOperations: record.activeOperations,
    irreversible: record.irreversible,
    operationIdentityVersion: record.operationIdentityVersion,
    operationIdentityKeyCheck: record.operationIdentityKeyCheck,
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
    throw new CutoverFenceError(
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
    throw new CutoverFenceError(
      `Initial epoch for namespace ${namespace} must be exactly 1, got ${requestedInitialEpoch}`
    );
  }
  const requestedInitialState = options.initialState ?? "legacy_open";
  if (requestedInitialState !== "legacy_open") {
    throw new CutoverFenceError(
      `Initial state for namespace ${namespace} must be 'legacy_open', got '${requestedInitialState}'`
    );
  }
  const markerRef = db.collection(`${namespace}_meta`).doc("v2_adopted");
  return await db.runTransaction(async (transaction) => {
    const timer = startMonotonicTimer();
    const markerSnap = await transaction.get(markerRef);
    if (markerSnap.exists) {
      throw new CutoverFenceError(
        `Cannot initialize cutover fence for namespace ${namespace}: immutable ownership marker already exists at v2_adopted`
      );
    }
    const snap = await transaction.get(docRef);
    if (snap.exists) {
      const existing = parseCutoverFenceRecord(snap.data(), namespace);
      if (existing.epoch !== 1 || existing.state !== "legacy_open") {
        throw new CutoverFenceError(
          `Cutover fence record for namespace ${namespace} already exists with epoch ${existing.epoch}, state ${existing.state}`
        );
      }
      timer.assertUnderDeadline("initializeCutoverFence exists");
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
    timer.assertUnderDeadline("initializeCutoverFence preWrite");
    transaction.set(docRef, initial);
    timer.assertUnderDeadline("initializeCutoverFence preReturn");
    return initial;
  });
}
__name(initializeCutoverFence, "initializeCutoverFence");
async function transitionCutoverFenceState(db, namespace, params) {
  assertSupportedCutoverNamespace(namespace);
  const docRef = getCutoverFenceDocRef(db, namespace);
  const now = (params.now ?? Date.now)();
  if (["migrating", "v3_ready", "v3_active"].includes(params.toState)) {
    throw new CutoverFenceError(
      `Transition to '${params.toState}' must use atomic transaction helper (prepareMigrationInTransaction, finalizeMigrationInTransaction, or activateMigrationInTransaction)`
    );
  }
  if (params.emptyNamespace !== void 0) {
    throw new CutoverFenceError("emptyNamespace flag is only allowed on transition to v3_ready through the atomic finalization helper");
  }
  if (params.migrationRunId !== void 0 || params.migrationManifestDigest !== void 0) {
    throw new CutoverFenceError("Migration identity is only set by atomic migration helpers");
  }
  return await db.runTransaction(async (transaction) => {
    const timer = startMonotonicTimer();
    const snap = await transaction.get(docRef);
    if (!snap.exists) {
      throw new CutoverFenceError(
        `Cannot transition: cutover fence record missing for namespace ${namespace}`
      );
    }
    const current = parseCutoverFenceRecord(snap.data(), namespace);
    if (current.state === params.toState) {
      if (params.allowIdempotent) {
        return current;
      }
      throw new CutoverFenceError(
        `Idempotent transition rejected for namespace ${namespace}: already in state '${current.state}'`
      );
    }
    if (params.fromState !== void 0) {
      const allowedFrom = Array.isArray(params.fromState) ? params.fromState : [params.fromState];
      if (!allowedFrom.includes(current.state)) {
        throw new CutoverFenceError(
          `Invalid fromState precondition for namespace ${namespace}: expected ${allowedFrom.join("|")}, got '${current.state}'`
        );
      }
    }
    if (current.epoch !== params.expectedEpoch) {
      throw new CutoverFenceError(
        `Epoch mismatch on transition for namespace ${namespace}: expected ${params.expectedEpoch}, got ${current.epoch}`
      );
    }
    const allowedNext = ALLOWED_STATE_TRANSITIONS[current.state] ?? [];
    if (!allowedNext.includes(params.toState)) {
      throw new CutoverFenceError(
        `Illegal cutover state transition for namespace ${namespace}: ${current.state} -> ${params.toState}`
      );
    }
    if (params.toState === "fenced") {
      const nonterminalOps = await transaction.get(
        getCutoverOperationsColRef(db, namespace).where("phase", "in", ["admitted", "upstream_pending"])
      );
      if (nonterminalOps.size !== current.activeOperations) {
        throw new CutoverFenceError(
          `Cannot transition to fenced: activeOperations counter (${current.activeOperations}) does not match nonterminal operations count (${nonterminalOps.size})`
        );
      }
      if (nonterminalOps.size !== 0) {
        throw new CutoverFenceError(
          `Cannot transition to fenced for namespace ${namespace}: ${nonterminalOps.size} active or pending operations exist`
        );
      }
      const ambiguousOps = await transaction.get(
        getCutoverOperationsColRef(db, namespace).where("ambiguousRemoteOutcome", "==", true)
      );
      if (!ambiguousOps.empty) {
        throw new CutoverFenceError(
          `Cannot transition to fenced for namespace ${namespace}: unresolved ambiguous remote operations exist`
        );
      }
    } else if (params.toState === "legacy_open") {
      if (current.irreversible) {
        throw new CutoverFenceError(
          `Cannot return to legacy_open for namespace ${namespace}: irreversible migration latch is engaged`
        );
      }
      if (current.migrationRunId || current.emptyNamespace) {
        throw new CutoverFenceError(
          `Cannot return to legacy_open for namespace ${namespace}: migration ownership record exists`
        );
      }
      const markerRef = db.collection(`${namespace}_meta`).doc("v2_adopted");
      const markerSnap = await transaction.get(markerRef);
      if (markerSnap.exists) {
        throw new CutoverFenceError(
          `Cannot return to legacy_open for namespace ${namespace}: durable v2_adopted ownership marker exists`
        );
      }
      const prepRef = db.collection(`${namespace}_meta`).doc(`migration_prepared_${current.epoch}`);
      const prepSnap = await transaction.get(prepRef);
      if (prepSnap.exists) {
        throw new CutoverFenceError(
          `Cannot return to legacy_open for namespace ${namespace}: prepared migration manifest exists for epoch ${current.epoch}`
        );
      }
      if (current.activeOperations !== 0) {
        throw new CutoverFenceError(
          `Cannot return to legacy_open for namespace ${namespace}: activeOperations is ${current.activeOperations}`
        );
      }
    }
    if (params.nextEpoch !== void 0) {
      const allowedNext2 = params.toState === "fenced" && current.state === "closing" ? current.epoch + 1 : current.epoch;
      if (params.nextEpoch !== allowedNext2) {
        throw new CutoverFenceError(`Arbitrary nextEpoch is not permitted for transition to ${params.toState}`);
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
      operationIdentityVersion: current.operationIdentityVersion,
      operationIdentityKeyCheck: current.operationIdentityKeyCheck,
      emptyNamespace: current.emptyNamespace,
      migrationRunId: params.migrationRunId ?? current.migrationRunId,
      migrationManifestDigest: params.migrationManifestDigest ?? current.migrationManifestDigest,
      createdAt: current.createdAt ?? now,
      updatedAt: now,
      codeArtifact: current.codeArtifact,
      codeSha: current.codeSha,
      lastTransitionReason: `Transitioned from ${current.state} to ${params.toState}`
    };
    timer.assertUnderDeadline("transitionCutoverFenceState preWrite");
    transaction.set(docRef, stripUndefined(updated));
    timer.assertUnderDeadline("transitionCutoverFenceState preReturn");
    return updated;
  });
}
__name(transitionCutoverFenceState, "transitionCutoverFenceState");
async function markIrreversibleInTransaction(transaction, db, namespace, expectedEpoch, migrationRunId, nowProvider = Date.now, timer) {
  if (!isMonotonicTimer(timer)) {
    throw new CutoverFenceError("markIrreversibleInTransaction requires a callback-entry monotonic timer");
  }
  timer.assertUnderDeadline("markIrreversibleInTransaction entry");
  assertSupportedCutoverNamespace(namespace);
  const current = await readCutoverFenceInTransaction(transaction, db, namespace);
  if (current.state !== "migrating") {
    throw new CutoverFenceError(
      `Cannot set irreversible latch for namespace ${namespace}: state must be 'migrating', got '${current.state}'`
    );
  }
  if (current.epoch !== expectedEpoch) {
    throw new CutoverFenceError(
      `Epoch mismatch when setting irreversible latch for namespace ${namespace}: expected ${expectedEpoch}, got ${current.epoch}`
    );
  }
  if (migrationRunId && current.migrationRunId !== migrationRunId) {
    throw new CutoverFenceError(
      `migrationRunId mismatch when setting irreversible latch: expected ${migrationRunId}, got ${current.migrationRunId}`
    );
  }
  if (current.emptyNamespace === true) {
    throw new CutoverFenceError(
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
  timer.assertUnderDeadline("markIrreversibleInTransaction before write");
  transaction.set(ref, stripUndefined(updated), { merge: true });
  timer.assertUnderDeadline("markIrreversibleInTransaction before return");
  return updated;
}
__name(markIrreversibleInTransaction, "markIrreversibleInTransaction");
var LEGACY_OPERATION_KINDS = /* @__PURE__ */ new Set([
  "register",
  "token",
  "revoke",
  "authorize",
  "login",
  "mfa",
  "mcp",
  "issue",
  "rotate",
  "read",
  "update",
  "upstream_refresh",
  "delete",
  "revocation",
  "register_client",
  "auth_code",
  "seat_revoke_cleanup",
  "token_issue",
  "token_rotate"
]);
async function withLegacyOperation(options, fn) {
  assertSupportedCutoverNamespace(options.namespace);
  const now = options.now ?? Date.now;
  const opId = options.operationId ?? randomUUID();
  const storageId = operationStorageId(options.namespace, opId, options.identityKey);
  const keyCheck = operationKeyCheck(options.namespace, options.identityKey);
  const opRef = storedOperationRef(options.db, options.namespace, storageId);
  const controlRef = getCutoverFenceDocRef(options.db, options.namespace);
  const opRecord = await options.db.runTransaction(async (transaction) => {
    const timer = startMonotonicTimer();
    const existingSnap = await transaction.get(opRef);
    if (existingSnap.exists) {
      throw new CutoverFenceError(
        `Operation already exists in namespace ${options.namespace}`
      );
    }
    const control = await readCutoverFenceInTransaction(transaction, options.db, options.namespace);
    if (["fenced", "migrating", "v3_ready", "v3_active"].includes(control.state)) {
      throw new CutoverRefusedError(
        `Cutover state is ${control.state}; new operations refused for namespace ${options.namespace}`,
        { cutoverState: control.state, epoch: control.epoch }
      );
    }
    if (control.state === "closing") {
      throw new CutoverRefusedError(
        `Cutover state is closing; new admissions refused for namespace ${options.namespace}`,
        { cutoverState: control.state, epoch: control.epoch }
      );
    }
    if (control.operationIdentityVersion === void 0 && control.operationIdentityKeyCheck === void 0) {
      const inventory = await transaction.get(getCutoverOperationsColRef(options.db, options.namespace).limit(1));
      if (!inventory.empty || control.activeOperations !== 0) {
        throw new CutoverFenceError("Unbound namespace contains operations and requires reviewed rekey");
      }
    } else if (control.operationIdentityVersion !== 1 || control.operationIdentityKeyCheck !== keyCheck) {
      throw new CutoverFenceError("Operation identity key binding mismatch");
    }
    if (!LEGACY_OPERATION_KINDS.has(options.kind)) {
      throw new CutoverFenceError("Unsupported operation kind");
    }
    let metadata;
    if (options.metadata !== void 0) {
      if (!options.metadata || typeof options.metadata !== "object" || Array.isArray(options.metadata)) {
        throw new CutoverFenceError("Invalid operation metadata");
      }
      metadata = {};
      for (const [key, value] of Object.entries(options.metadata)) {
        if (key === "revision" || key === "phase") {
          if (typeof value !== "string" || value.length === 0 || value.length > 128) {
            throw new CutoverFenceError("Invalid operation metadata");
          }
          metadata[key + "Fingerprint"] = createHmac3("sha256", deriveKey(options.identityKey)).update(JSON.stringify(["netsapiens-mcp/operation-metadata", 1, options.namespace, key, value]), "utf8").digest("hex");
        } else if (key === "attempt" && Number.isSafeInteger(value) && value >= 1 && value <= 100) {
          metadata.attempt = value;
        } else if (key === "reconciled" && typeof value === "boolean") {
          metadata.reconciled = value;
        } else {
          throw new CutoverFenceError("Invalid operation metadata");
        }
      }
    }
    const currentTime = now();
    const createdRecord = {
      schemaVersion: 1,
      id: storageId,
      operationId: storageId,
      operationIdentityVersion: 1,
      namespace: options.namespace,
      epoch: control.epoch,
      kind: options.kind,
      phase: "admitted",
      leaseOwner: randomUUID(),
      leaseExpiresAt: currentTime + (options.leaseMs ?? 3e4),
      createdAt: currentTime,
      updatedAt: currentTime,
      metadata
    };
    timer.assertUnderDeadline("withLegacyOperation admission reads");
    transaction.set(opRef, stripUndefined(createdRecord));
    transaction.set(
      controlRef,
      {
        operationIdentityVersion: 1,
        operationIdentityKeyCheck: keyCheck,
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
    storageId,
    identityKeyCheck: keyCheck,
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
    if (ctx.isAmbiguousRemoteOutcome()) {
      throw new CutoverFenceError("Operation has an unresolved upstream outcome");
    }
    if (!ctx.isCompleted()) {
      await releaseLegacyOperation(options.db, ctx, options.identityKey, "completed", now);
    }
    return result;
  } catch (err) {
    if (ctx.isAmbiguousRemoteOutcome()) {
      try {
        await markOperationAmbiguous(options.db, ctx, options.identityKey, now);
      } catch (markErr) {
        if (err && typeof err === "object") {
          err.markAmbiguousError = markErr;
        }
      }
    } else if (!ctx.isCompleted()) {
      try {
        await releaseLegacyOperation(options.db, ctx, options.identityKey, "failed", now);
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
async function releaseLegacyOperation(db, ctx, identityKey, outcome = "completed", nowProvider = Date.now) {
  assertSupportedCutoverNamespace(ctx.namespace);
  if (operationStorageId(ctx.namespace, ctx.id, identityKey) !== ctx.storageId || operationKeyCheck(ctx.namespace, identityKey) !== ctx.identityKeyCheck) {
    throw new CutoverFenceError("Operation identity binding mismatch");
  }
  if (outcome !== "completed" && outcome !== "failed") {
    throw new CutoverFenceError(`Invalid outcome for release: ${outcome}`);
  }
  const controlRef = getCutoverFenceDocRef(db, ctx.namespace);
  const opRef = storedOperationRef(db, ctx.namespace, ctx.storageId);
  const currentTime = nowProvider();
  await db.runTransaction(async (transaction) => {
    const timer = startMonotonicTimer();
    const controlSnap = await transaction.get(controlRef);
    const opSnap = await transaction.get(opRef);
    if (!controlSnap.exists) {
      throw new CutoverFenceError(`Control record missing for namespace ${ctx.namespace}`);
    }
    if (!opSnap.exists) {
      throw new CutoverFenceError("Operation record missing on release");
    }
    const control = parseCutoverFenceRecord(controlSnap.data(), ctx.namespace);
    const opData = opSnap.data();
    if (control.operationIdentityVersion !== 1 || control.operationIdentityKeyCheck !== ctx.identityKeyCheck || opData.operationIdentityVersion !== 1) throw new CutoverFenceError("Operation identity binding mismatch");
    if (opData.schemaVersion !== 1) {
      throw new CutoverFenceError(`Invalid operation schemaVersion: expected 1, got ${opData.schemaVersion}`);
    }
    if (opData.id !== ctx.storageId || opData.operationId !== ctx.storageId) {
      throw new CutoverFenceError("Operation id mismatch on release");
    }
    if (opData.namespace !== ctx.namespace) {
      throw new CutoverFenceError(`Operation namespace mismatch: expected ${ctx.namespace}, got ${opData.namespace}`);
    }
    if (opData.kind !== ctx.kind) {
      throw new CutoverFenceError(`Operation kind mismatch on release: expected ${ctx.kind}, got ${opData.kind}`);
    }
    if (opData.epoch !== ctx.epoch) {
      throw new CutoverFenceError(
        `Epoch mismatch on release: context epoch ${ctx.epoch} != recorded epoch ${opData.epoch}`
      );
    }
    if (opData.phase === "completed" || opData.phase === "failed") {
      timer.assertUnderDeadline("releaseLegacyOperation terminal");
      return;
    }
    if (typeof ctx.isCompleted !== "function" || ctx.isCompleted()) {
      throw new CutoverFenceError("Completed operation cannot release a nonterminal record");
    }
    if (opData.phase === "upstream_pending" || opData.ambiguousRemoteOutcome === true) {
      throw new CutoverFenceError(
        `Cannot release operation in phase ${opData.phase}; pending or ambiguous claims must be resolved`
      );
    }
    if (opData.phase !== "admitted" || control.epoch !== ctx.epoch || control.state !== "legacy_open" && control.state !== "closing") {
      throw new CutoverFenceError("Operation cannot be released in its current phase or control state");
    }
    if (control.activeOperations <= 0) {
      throw new CutoverFenceError(
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
async function markOperationAmbiguous(db, ctx, identityKey, nowProvider = Date.now) {
  assertSupportedCutoverNamespace(ctx.namespace);
  if (operationStorageId(ctx.namespace, ctx.id, identityKey) !== ctx.storageId || operationKeyCheck(ctx.namespace, identityKey) !== ctx.identityKeyCheck) {
    throw new CutoverFenceError("Operation identity binding mismatch");
  }
  const opRef = storedOperationRef(db, ctx.namespace, ctx.storageId);
  const currentTime = nowProvider();
  await db.runTransaction(async (transaction) => {
    const timer = startMonotonicTimer();
    const control = await readCutoverFenceInTransaction(transaction, db, ctx.namespace);
    const opSnap = await transaction.get(opRef);
    if (!opSnap.exists) {
      throw new CutoverFenceError("Operation record missing on mark ambiguous");
    }
    const opData = opSnap.data();
    if (control.operationIdentityVersion !== 1 || control.operationIdentityKeyCheck !== ctx.identityKeyCheck || opData.operationIdentityVersion !== 1) throw new CutoverFenceError("Operation identity binding mismatch");
    if (opData.schemaVersion !== 1) {
      throw new CutoverFenceError(`Invalid operation schemaVersion: expected 1, got ${opData.schemaVersion}`);
    }
    if (opData.id !== ctx.storageId || opData.operationId !== ctx.storageId) {
      throw new CutoverFenceError("Operation id mismatch on mark ambiguous");
    }
    if (opData.namespace !== ctx.namespace) {
      throw new CutoverFenceError(`Operation namespace mismatch on mark ambiguous`);
    }
    if (opData.kind !== ctx.kind) {
      throw new CutoverFenceError(`Operation kind mismatch on mark ambiguous: expected ${ctx.kind}, got ${opData.kind}`);
    }
    if (opData.epoch !== ctx.epoch) {
      throw new CutoverFenceError(
        `Epoch mismatch on mark ambiguous: context epoch ${ctx.epoch} != recorded epoch ${opData.epoch}`
      );
    }
    if (typeof ctx.isCompleted !== "function" || ctx.isCompleted() || control.epoch !== ctx.epoch || control.state !== "legacy_open" && control.state !== "closing" || opData.phase !== "upstream_pending") {
      throw new CutoverFenceError("Only the original pending operation can be marked ambiguous");
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
async function checkV3MutationGuardInTransaction(transaction, options) {
  if (!options || !isMonotonicTimer(options.timer)) {
    throw new CutoverFenceError("V3 mutation guard requires a callback-entry monotonic timer");
  }
  const { db, namespace, timer } = options;
  timer.assertUnderDeadline("v3 mutation guard entry");
  const control = await readCutoverFenceInTransaction(transaction, db, namespace);
  if (control.state !== "v3_active") {
    throw new CutoverRefusedError("V3 mutation requires active ownership", {
      cutoverState: control.state,
      epoch: control.epoch
    });
  }
  const markerSnap = await transaction.get(db.collection(`${namespace}_meta`).doc("v2_adopted"));
  if (!markerSnap.exists) throw new CutoverFenceError("V3 ownership marker is missing");
  const marker = markerSnap.data();
  validateMapKeysExact(marker, REQUIRED_OWNERSHIP_MARKER_KEYS, "ownership marker");
  validateMigrationIdentityFields(marker, namespace, control.epoch, control.migrationRunId);
  if (marker.kind !== "ownership" || typeof marker.emptyNamespace !== "boolean" || !Number.isSafeInteger(marker.adoptedAt) || marker.adoptedAt < 0 || !/^[0-9a-f]{64}$/.test(marker.preparedDigest) || marker.migrationManifestDigest !== control.migrationManifestDigest || marker.codeArtifact !== control.codeArtifact) {
    throw new CutoverFenceError("V3 ownership marker does not match control");
  }
  let buffered = false;
  return {
    control,
    assertPreReturn: /* @__PURE__ */ __name(() => timer.assertUnderDeadline("v3 mutation before return"), "assertPreReturn"),
    bufferMutation: /* @__PURE__ */ __name(() => {
      timer.assertUnderDeadline("v3 mutation before first write");
      if (buffered) throw new CutoverFenceError("V3 mutation guard already buffered");
      buffered = true;
      if (!control.irreversible) {
        transaction.set(getCutoverFenceDocRef(db, namespace), {
          irreversible: true,
          emptyNamespace: false,
          updatedAt: (options.now ?? Date.now)()
        }, { merge: true });
      }
    }, "bufferMutation")
  };
}
__name(checkV3MutationGuardInTransaction, "checkV3MutationGuardInTransaction");
async function checkMutationGuardInTransaction(transaction, options) {
  if (!options || !isMonotonicTimer(options.timer)) {
    throw new CutoverFenceError("checkMutationGuardInTransaction requires a canonical startMonotonicTimer() instance in options.timer created at transaction callback entry");
  }
  const timer = options.timer;
  timer.assertUnderDeadline("checkMutationGuardInTransaction entry");
  assertSupportedCutoverNamespace(options.namespace);
  const control = await readCutoverFenceInTransaction(transaction, options.db, options.namespace);
  if (["fenced", "migrating", "v3_ready", "v3_active"].includes(control.state)) {
    throw new CutoverRefusedError(
      `Cutover state is ${control.state}; mutations refused for namespace ${options.namespace}`,
      { cutoverState: control.state, epoch: control.epoch }
    );
  }
  if (!options.operation) {
    throw new CutoverFenceError(
      `Durable operation context is required for guarded mutation in namespace ${options.namespace}`
    );
  }
  if (operationStorageId(options.namespace, options.operation.id, options.identityKey) !== options.operation.storageId || operationKeyCheck(options.namespace, options.identityKey) !== options.operation.identityKeyCheck || control.operationIdentityKeyCheck !== options.operation.identityKeyCheck) {
    throw new CutoverFenceError("Operation identity binding mismatch");
  }
  const opRef = storedOperationRef(options.db, options.namespace, options.operation.storageId);
  const opSnap = await transaction.get(opRef);
  if (!opSnap.exists) {
    throw new CutoverFenceError(
      `Durable operation record missing in namespace ${options.namespace}`
    );
  }
  const opRecord = opSnap.data();
  if (control.operationIdentityVersion !== 1 || control.operationIdentityKeyCheck !== options.operation.identityKeyCheck || opRecord.operationIdentityVersion !== 1) throw new CutoverFenceError("Operation identity binding mismatch");
  if (opRecord.schemaVersion !== 1) {
    throw new CutoverFenceError(`Invalid operation schemaVersion: expected 1, got ${opRecord.schemaVersion}`);
  }
  if (opRecord.id !== options.operation.storageId || opRecord.operationId !== options.operation.storageId) {
    throw new CutoverFenceError("Durable operation id mismatch");
  }
  if (opRecord.namespace !== options.namespace) {
    throw new CutoverFenceError(`Durable operation namespace mismatch: expected ${options.namespace}, got ${opRecord.namespace}`);
  }
  if (opRecord.kind !== options.operation.kind) {
    throw new CutoverFenceError(`Durable operation kind mismatch: expected ${options.operation.kind}, got ${opRecord.kind}`);
  }
  if (options.operation.namespace !== options.namespace || options.operation.epoch !== opRecord.epoch) {
    throw new CutoverFenceError("Operation context identity mismatch");
  }
  if (opRecord.epoch !== control.epoch) {
    throw new CutoverFenceError(
      `Operation epoch mismatch: operation epoch ${opRecord.epoch} != control epoch ${control.epoch}`
    );
  }
  if (opRecord.phase !== "admitted" && opRecord.phase !== "upstream_pending") {
    throw new CutoverFenceError(
      `Operation is already in phase ${opRecord.phase}; cannot be reused`
    );
  }
  if (options.operation.isCompleted()) {
    throw new CutoverFenceError(
      "Operation was marked completed locally; cannot be reused"
    );
  }
  if (opRecord.phase === "upstream_pending") {
    const claim = options.pendingClaim;
    if (!claim || claim.operationId !== options.operation.id || claim.storageId !== options.operation.storageId || claim.familyId !== opRecord.familyId || typeof claim.claimOwner !== "string" || !claim.claimOwner || operationStorageId(options.namespace, options.operation.id, options.identityKey) !== options.operation.storageId || operationKeyCheck(options.namespace, options.identityKey) !== options.operation.identityKeyCheck || claimOwnerStorageId(options.namespace, claim.claimOwner, options.identityKey) !== claim.ownerStorageId || !Number.isSafeInteger(claim.familyGeneration) || !Number.isSafeInteger(claim.grantVersion) || !Number.isSafeInteger(claim.leaseExpiresAt) || opRecord.ambiguousRemoteOutcome === true) {
      throw new CutoverFenceError("A matching pending claim is required for grant completion");
    }
    const grantSnap = await transaction.get(
      options.db.collection(`${options.namespace}_tokens_upstream`).doc(claim.familyId)
    );
    const grant = grantSnap.exists ? grantSnap.data() : void 0;
    if (!grant || grant.operationId !== claim.storageId || grant.ambiguousOperationId !== claim.storageId || grant.leaseOwner !== claim.ownerStorageId || grant.familyGeneration !== claim.familyGeneration || grant.grantVersion !== claim.grantVersion || grant.leaseUntil !== claim.leaseExpiresAt || grant.leaseExpiresAt !== claim.leaseExpiresAt || grant.ambiguousOutcome) {
      throw new CutoverFenceError("Pending grant ownership does not match");
    }
  }
  const completeOperation = options.completeOperation ?? true;
  let bufferedCompletionTime;
  return {
    control,
    operation: opRecord,
    timer,
    assertPreWrite: /* @__PURE__ */ __name((label = "Mutation transaction before write") => {
      timer.assertUnderDeadline(label);
    }, "assertPreWrite"),
    assertPreReturn: /* @__PURE__ */ __name((label = "Mutation transaction before return") => {
      timer.assertUnderDeadline(label);
    }, "assertPreReturn"),
    bufferCompletion: /* @__PURE__ */ __name((now = (options.now ?? Date.now)()) => {
      timer.assertUnderDeadline("checkMutationGuardInTransaction bufferCompletion");
      if (!options.operation || !completeOperation) {
        return;
      }
      if (bufferedCompletionTime !== void 0) {
        throw new CutoverFenceError("Operation completion already buffered");
      }
      if (opRecord.ambiguousRemoteOutcome === true) {
        throw new CutoverFenceError("Ambiguous operation cannot be completed by a mutation");
      }
      if (control.activeOperations <= 0) {
        throw new CutoverFenceError("Active operations underflow");
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
        throw new CutoverFenceError(
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
async function legacyPermissionDecision(transaction, db, namespace, operation, timer, identityKey) {
  assertSupportedCutoverNamespace(namespace);
  const control = await readCutoverFenceInTransaction(transaction, db, namespace);
  if (["fenced", "migrating", "v3_ready", "v3_active"].includes(control.state)) {
    return { permitted: false, control };
  }
  if (!operation || typeof operation.storageId !== "string" || !operation.storageId || operation.namespace !== namespace || typeof operation.isCompleted !== "function" || operation.isCompleted()) {
    return { permitted: false, control };
  }
  if (!(identityKey instanceof Uint8Array) || identityKey.byteLength !== 32 || operationStorageId(namespace, operation.id, identityKey) !== operation.storageId || operationKeyCheck(namespace, identityKey) !== operation.identityKeyCheck || control.operationIdentityKeyCheck !== operation.identityKeyCheck) {
    return { permitted: false, control };
  }
  const opRef = storedOperationRef(db, namespace, operation.storageId);
  const opSnap = await transaction.get(opRef);
  if (!opSnap.exists) {
    return { permitted: false, control };
  }
  const opRecord = opSnap.data();
  if (control.operationIdentityVersion !== 1 || control.operationIdentityKeyCheck !== operation.identityKeyCheck || opRecord.operationIdentityVersion !== 1 || opRecord.schemaVersion !== 1 || opRecord.id !== operation.storageId || opRecord.operationId !== operation.storageId) {
    return { permitted: false, control };
  }
  if (opRecord.namespace !== namespace || opRecord.epoch !== control.epoch || operation.epoch !== opRecord.epoch) {
    return { permitted: false, control };
  }
  if (opRecord.kind !== operation.kind) {
    return { permitted: false, control };
  }
  if (opRecord.phase !== "admitted") {
    return { permitted: false, control };
  }
  timer.assertUnderDeadline("isLegacyMutationPermittedInTransaction");
  return { permitted: true, control };
}
__name(legacyPermissionDecision, "legacyPermissionDecision");
async function isLegacyMutationPermittedInTransaction(transaction, db, namespace, operation, timer, identityKey) {
  if (!isMonotonicTimer(timer)) {
    throw new CutoverFenceError("isLegacyMutationPermittedInTransaction requires the caller callback-entry monotonic timer");
  }
  timer.assertUnderDeadline("isLegacyMutationPermittedInTransaction entry");
  const result = await legacyPermissionDecision(transaction, db, namespace, operation, timer, identityKey);
  timer.assertUnderDeadline("isLegacyMutationPermittedInTransaction before return");
  return result;
}
__name(isLegacyMutationPermittedInTransaction, "isLegacyMutationPermittedInTransaction");
async function claimUpstreamGrantInTransaction(transaction, db, options) {
  if (!options || !isMonotonicTimer(options.timer)) {
    throw new CutoverFenceError("claimUpstreamGrantInTransaction requires a canonical startMonotonicTimer() instance in options.timer created at transaction callback entry");
  }
  const timer = options.timer;
  timer.assertUnderDeadline("claimUpstreamGrantInTransaction entry");
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
    throw new CutoverFenceError(`Invalid legacy collection override '${options.collection}': exact '${expectedCollection}' required`);
  }
  if (options.familyCollection !== void 0 && options.familyCollection !== expectedFamilyCollection) {
    throw new CutoverFenceError(`Invalid legacy familyCollection override '${options.familyCollection}': exact '${expectedFamilyCollection}' required`);
  }
  if (options.refreshCollection !== void 0 && options.refreshCollection !== expectedRefreshCollection) {
    throw new CutoverFenceError(`Invalid legacy refreshCollection override '${options.refreshCollection}': exact '${expectedRefreshCollection}' required`);
  }
  const collection = expectedCollection;
  const familyCollection = expectedFamilyCollection;
  const refreshCollection = expectedRefreshCollection;
  if (typeof epoch !== "number" || !Number.isInteger(epoch) || epoch < 1) {
    throw new CutoverFenceError("epoch (positive integer) is required for claimUpstreamGrantInTransaction");
  }
  if (typeof familyId !== "string" || !familyId.trim()) {
    throw new CutoverFenceError("familyId is required for claimUpstreamGrantInTransaction");
  }
  if (typeof operationId !== "string") {
    throw new CutoverFenceError("operationId is required for claimUpstreamGrantInTransaction");
  }
  if (typeof claimOwner !== "string" || !claimOwner.trim()) {
    throw new CutoverFenceError("claimOwner is required for claimUpstreamGrantInTransaction");
  }
  if (typeof expectedFamilyGeneration !== "number" || !Number.isInteger(expectedFamilyGeneration) || expectedFamilyGeneration < 1) {
    throw new CutoverFenceError("expectedFamilyGeneration (positive integer) is required for claimUpstreamGrantInTransaction");
  }
  if (typeof expectedGrantVersion !== "number" || !Number.isInteger(expectedGrantVersion) || expectedGrantVersion < 1) {
    throw new CutoverFenceError("expectedGrantVersion (positive integer) is required for claimUpstreamGrantInTransaction");
  }
  if (typeof expectedKind !== "string" || !expectedKind.trim()) {
    throw new CutoverFenceError("expectedKind is required for claimUpstreamGrantInTransaction");
  }
  const now = nowProvider();
  const clampedLeaseMs = Math.max(5e3, Math.min(12e4, leaseMs));
  const control = await readCutoverFenceInTransaction(transaction, db, namespace);
  if (["fenced", "migrating", "v3_ready", "v3_active"].includes(control.state)) {
    throw new CutoverRefusedError(
      `Cutover state is ${control.state}; upstream claim refused for namespace ${namespace}`,
      { cutoverState: control.state, epoch: control.epoch }
    );
  }
  if (epoch !== control.epoch) {
    throw new CutoverFenceError(
      `Operation epoch mismatch for upstream claim in namespace ${namespace}: expected ${control.epoch}, got ${epoch}`
    );
  }
  const storageId = operationStorageId(namespace, operationId, options.identityKey);
  if (control.operationIdentityVersion !== 1 || control.operationIdentityKeyCheck !== operationKeyCheck(namespace, options.identityKey)) {
    throw new CutoverFenceError("Operation identity key binding mismatch");
  }
  const opRef = storedOperationRef(db, namespace, storageId);
  const opSnap = await transaction.get(opRef);
  if (!opSnap.exists) {
    throw new CutoverFenceError("Durable operation record missing for upstream claim");
  }
  const opData = opSnap.data();
  if (opData.schemaVersion !== 1 || opData.operationIdentityVersion !== 1 || opData.id !== storageId || opData.operationId !== storageId) {
    throw new CutoverFenceError("Operation id mismatch on record");
  }
  if (opData.namespace !== namespace) {
    throw new CutoverFenceError(`Operation namespace mismatch: expected ${namespace}, got ${opData.namespace}`);
  }
  if (opData.kind !== expectedKind) {
    throw new CutoverFenceError("Operation kind mismatch");
  }
  if (opData.epoch !== control.epoch) {
    throw new CutoverFenceError(`Operation record epoch mismatch: expected ${control.epoch}, got ${opData.epoch}`);
  }
  if (opData.phase !== "admitted") {
    throw new CutoverFenceError(`Operation is in phase ${opData.phase}; claim refused`);
  }
  const familyRef = db.collection(familyCollection).doc(familyId);
  const familySnap = await transaction.get(familyRef);
  if (!familySnap.exists) {
    throw new CutoverFenceError("Family record missing for claim");
  }
  const family = familySnap.data();
  const actualFamilyGen = family.generation === void 0 ? 1 : family.generation;
  if (family.id !== familyId || !Number.isSafeInteger(actualFamilyGen) || actualFamilyGen < 1 || actualFamilyGen !== expectedFamilyGeneration) {
    throw new CutoverFenceError("Family generation mismatch");
  }
  const activePointerId = family.currentRefreshToken;
  if (typeof activePointerId !== "string" || !activePointerId.trim()) {
    throw new CutoverFenceError("Family missing active refresh pointer");
  }
  const pointerRef = db.collection(refreshCollection).doc(activePointerId.replace(/[\/.]/g, "_"));
  const pointerSnap = await transaction.get(pointerRef);
  if (!pointerSnap.exists) {
    throw new CutoverFenceError("Active refresh pointer missing");
  }
  const pointer = pointerSnap.data();
  if (typeof pointer.familyId !== "string" || pointer.familyId !== familyId) {
    throw new CutoverFenceError("Pointer family binding mismatch");
  }
  if (typeof pointer.status !== "string" || pointer.status !== "active") {
    throw new CutoverFenceError(`Current refresh pointer is not active: ${pointer.status}`);
  }
  const grantRef = db.collection(collection).doc(familyId);
  const grantSnap = await transaction.get(grantRef);
  if (!grantSnap.exists) {
    throw new CutoverFenceError("Upstream grant missing for family");
  }
  const current = grantSnap.data();
  const actualGrantVersion = current.grantVersion === void 0 ? current.version === void 0 ? 1 : current.version : current.grantVersion;
  if (!Number.isSafeInteger(actualGrantVersion) || actualGrantVersion < 1 || actualGrantVersion !== expectedGrantVersion) {
    throw new CutoverFenceError("Grant version mismatch");
  }
  if (current.ambiguousOperationId != null || current.operationId != null || current.leaseOwner != null || current.leaseUntil != null || current.leaseExpiresAt != null) {
    throw new CutoverFenceError("Upstream grant has an unresolved prior claim");
  }
  if (current.ambiguousRemoteOutcome || current.ambiguousOutcome) {
    throw new CutoverFenceError("Upstream grant for family has unresolved ambiguous outcome");
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
      leaseOwner: claimOwnerStorageId(namespace, claimOwner, options.identityKey),
      ambiguousOperationId: storageId,
      operationId: storageId,
      familyGeneration: expectedFamilyGeneration,
      grantVersion: expectedGrantVersion,
      claimedAt: now
    }),
    { merge: true }
  );
  timer.assertUnderDeadline("claimUpstreamGrantInTransaction complete");
  return {
    status: "claimed",
    familyId,
    operationId,
    storageId,
    claimOwner,
    ownerStorageId: claimOwnerStorageId(namespace, claimOwner, options.identityKey),
    familyGeneration: expectedFamilyGeneration,
    grantVersion: expectedGrantVersion,
    leaseExpiresAt: now + clampedLeaseMs,
    grant: current.grant ? { hasGrant: true, expiresAt: current.expiresAt } : null
  };
}
__name(claimUpstreamGrantInTransaction, "claimUpstreamGrantInTransaction");
async function reconcileUpstreamGrantInTransaction(transaction, db, options) {
  if (!options || !isMonotonicTimer(options.timer)) {
    throw new CutoverFenceError("reconcileUpstreamGrantInTransaction requires a canonical startMonotonicTimer() instance in options.timer created at transaction callback entry");
  }
  const timer = options.timer;
  timer.assertUnderDeadline("reconcileUpstreamGrantInTransaction entry");
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
    throw new CutoverFenceError(`Invalid legacy collection override '${options.collection}': exact '${expectedCollection}' required`);
  }
  const collection = expectedCollection;
  if (typeof familyId !== "string" || !familyId.trim()) {
    throw new CutoverFenceError("familyId is required for upstream reconciliation");
  }
  if (typeof operationId !== "string") {
    throw new CutoverFenceError("operationId is required for upstream reconciliation");
  }
  if (typeof claimOwner !== "string" || !claimOwner.trim()) {
    throw new CutoverFenceError("claimOwner is required for upstream reconciliation");
  }
  if (typeof expectedFamilyGeneration !== "number" || !Number.isInteger(expectedFamilyGeneration) || expectedFamilyGeneration < 1) {
    throw new CutoverFenceError("expectedFamilyGeneration (positive integer) is required for upstream reconciliation");
  }
  if (typeof expectedGrantVersion !== "number" || !Number.isInteger(expectedGrantVersion) || expectedGrantVersion < 1) {
    throw new CutoverFenceError("expectedGrantVersion (positive integer) is required for upstream reconciliation");
  }
  const now = nowProvider();
  const control = await readCutoverFenceInTransaction(transaction, db, namespace);
  if (control.state !== "legacy_open" && control.state !== "closing") {
    throw new CutoverRefusedError(
      `Cannot reconcile legacy upstream grant: cutover state is ${control.state}`,
      { cutoverState: control.state, epoch: control.epoch }
    );
  }
  const storageId = operationStorageId(namespace, operationId, options.identityKey);
  if (control.operationIdentityVersion !== 1 || control.operationIdentityKeyCheck !== operationKeyCheck(namespace, options.identityKey)) {
    throw new CutoverFenceError("Operation identity key binding mismatch");
  }
  const opRef = storedOperationRef(db, namespace, storageId);
  const opSnap = await transaction.get(opRef);
  if (!opSnap.exists) {
    throw new CutoverFenceError("Operation record missing for upstream reconciliation");
  }
  const opData = opSnap.data();
  if (opData.schemaVersion !== 1 || opData.operationIdentityVersion !== 1 || opData.id !== storageId || opData.operationId !== storageId || opData.namespace !== namespace || opData.epoch !== control.epoch || typeof opData.kind !== "string" || !opData.kind || opData.phase !== "upstream_pending" || opData.familyId !== familyId) {
    throw new CutoverFenceError("Operation identity mismatch for upstream reconciliation");
  }
  const docRef = db.collection(collection).doc(familyId);
  const snap = await transaction.get(docRef);
  if (!snap.exists) {
    throw new CutoverFenceError("Upstream grant missing for family");
  }
  const current = snap.data();
  if (current.leaseOwner !== claimOwnerStorageId(namespace, claimOwner, options.identityKey) || current.ambiguousOperationId !== storageId || current.operationId !== storageId || current.familyGeneration !== expectedFamilyGeneration || current.grantVersion !== expectedGrantVersion || !Number.isSafeInteger(current.leaseUntil) || current.leaseUntil !== current.leaseExpiresAt) {
    throw new CutoverFenceError("Upstream claim mismatch for reconciliation");
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
        ambiguousOperationId: storageId,
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
  throw new CutoverFenceError(
    "Upstream grant reconciliation refused: trusted provider recovery mechanism is not established; operation remains held in upstream_pending"
  );
}
__name(reconcileUpstreamGrantInTransaction, "reconcileUpstreamGrantInTransaction");
function verifyIndexManifestDigests(manifest, expected) {
  const sha2 = /* @__PURE__ */ __name((value) => createHash2("sha256").update(canonicalJson(value), "utf8").digest("hex"), "sha");
  if (!manifest || typeof manifest !== "object") throw new CutoverFenceError("Index schema manifest is required");
  if (manifest.schemaVersion !== 2 || manifest.kind !== "firestore-index-policy") {
    throw new CutoverFenceError("Index schema manifest has an unsupported version or kind");
  }
  if (!manifest.binding || typeof manifest.binding !== "object" || !manifest.policy || typeof manifest.policy !== "object") {
    throw new CutoverFenceError("Index schema manifest is missing binding or policy");
  }
  const b = manifest.binding;
  const expectedBinding = expected.binding;
  if (!expectedBinding || typeof expectedBinding !== "object") {
    throw new CutoverFenceError("Protected binding identity is required");
  }
  if (b.profile !== expectedBinding.profile || b.project !== expectedBinding.project || b.database !== expectedBinding.database) {
    throw new CutoverFenceError("Index binding does not match the protected profile, project or database");
  }
  const groups = b.collectionGroups;
  const sortedUnique = /* @__PURE__ */ __name((xs) => [...new Set(xs)].sort(), "sortedUnique");
  if (!Array.isArray(groups) || JSON.stringify(groups) !== JSON.stringify(sortedUnique(groups))) {
    throw new CutoverFenceError("Index binding collectionGroups must be sorted and unique");
  }
  const policyGroups = sortedUnique((manifest.policy.collections ?? []).map((e) => e.collectionGroup));
  if (JSON.stringify(groups) !== JSON.stringify(policyGroups)) {
    throw new CutoverFenceError("Index binding collectionGroups must equal the policy collection groups");
  }
  const runtimeScope = getCutoverRuntimeCollectionScope(expected.namespace);
  assertRuntimeScopeClosed(runtimeScope);
  for (const name of runtimeScope.groups) {
    if (!groups.includes(name)) {
      throw new CutoverFenceError(`Index binding omits runtime collection group ${name}`);
    }
  }
  if (sha2(manifest) !== expected.indexSchemaDigest) {
    throw new CutoverFenceError("Index schema digest does not match the approved manifest");
  }
  if (typeof expected.indexPolicyDigest !== "string" || sha2(manifest.policy) !== expected.indexPolicyDigest) {
    throw new CutoverFenceError("Index policy digest does not match the approved manifest");
  }
  return { indexSchemaDigest: sha2(manifest), indexPolicyDigest: sha2(manifest.policy) };
}
__name(verifyIndexManifestDigests, "verifyIndexManifestDigests");
async function revalidatePreparationSnapshot(transaction, db, options, control) {
  const { namespace, storeKey, completePlan, prepDoc, expectedIdentity, timer, protectedBinding } = options;
  const epoch = control.epoch;
  const registry = getCutoverCollectionRegistry(namespace);
  const codec = bundledCodec(storeKey);
  const subject = subjectSpecFor(protectedBinding.subjectDescriptor, namespace, storeKey);
  const { sourceDocsByKey, targetDocsByKey } = options.snapshot;
  timer.assertUnderDeadline("revalidatePreparationSnapshot reads");
  validateMapKeysExact(prepDoc.physicalCounts, PHYSICAL_COUNT_KEYS, "prepared physicalCounts");
  let total = 0;
  const descriptors = [];
  const snapshotSources = /* @__PURE__ */ new Map();
  for (const key of PHYSICAL_COUNT_KEYS) {
    const docs = sourceDocsByKey.get(key);
    if (prepDoc.physicalCounts[key] !== docs.length) {
      throw new CutoverFenceError(`Physical count mismatch for source ${key}`);
    }
    total += docs.length;
    for (const doc of docs) {
      const data = doc.data();
      const sourceId = computeKeyedDocId(storeKey, "source-id", namespace, epoch, key, doc.id);
      if (snapshotSources.has(sourceId)) {
        throw new CutoverFenceError(`Duplicate keyed source identity in source ${key}`);
      }
      const recordDigest = computeSourceRecordDigest(storeKey, namespace, epoch, key, sourceId, data);
      snapshotSources.set(sourceId, { collection: key, physicalId: doc.id, data, recordDigest });
      descriptors.push({ collection: key, id: sourceId, recordDigest });
    }
  }
  if (total !== prepDoc.totalPhysicalRecords) {
    throw new CutoverFenceError("Prepared totalPhysicalRecords does not match the snapshot");
  }
  if (computeSourceInventoryDigest(storeKey, namespace, epoch, descriptors) !== prepDoc.sourceInventoryDigest) {
    throw new CutoverFenceError("Prepared sourceInventoryDigest does not match the recomputed snapshot inventory");
  }
  validateCompleteMigrationPlanForIdentity(completePlan, expectedIdentity);
  if (C(prepDoc) !== C(completePlan.prepared)) {
    throw new CutoverFenceError("Engine prepared document and complete plan prepared document differ");
  }
  validatePlanSpec(prepDoc.planSpec, prepDoc, namespace, epoch, expectedIdentity.migrationRunId);
  if (computePlanDigest(namespace, epoch, prepDoc.planSpec) !== prepDoc.planDigest) {
    throw new CutoverFenceError("Prepared planDigest does not match the recomputed plan digest");
  }
  const covered = /* @__PURE__ */ new Set();
  for (const item of completePlan.items) {
    for (const ref of item.sourceReferences) {
      const snap = snapshotSources.get(ref.id);
      if (!snap) throw new CutoverFenceError("Plan references a source absent from the snapshot");
      if (snap.collection !== ref.collection) {
        throw new CutoverFenceError("Plan source collection does not match the snapshot");
      }
      if (covered.has(ref.id)) throw new CutoverFenceError("A snapshot source is referenced by more than one plan item");
      covered.add(ref.id);
    }
  }
  if (covered.size !== snapshotSources.size) {
    throw new CutoverFenceError("Plan does not cover every snapshot source exactly once");
  }
  const snapshotTargets = /* @__PURE__ */ new Map();
  for (const key of Object.keys(registry.target)) {
    const targetDocs = targetDocsByKey.get(key);
    for (const doc of targetDocs) {
      const targetId = computeKeyedDocId(storeKey, "target-id", namespace, epoch, key, doc.id);
      if (snapshotTargets.has(targetId)) throw new CutoverFenceError("Duplicate keyed target identity");
      snapshotTargets.set(targetId, { collection: key, physicalId: doc.id, data: doc.data() });
    }
  }
  const logicalItems = [];
  const planItems = new Map(completePlan.items.map((item) => [item.candidateId, item]));
  for (const cand of prepDoc.candidateCommitments) {
    const entries = cand.sources.map((source) => {
      const snap = snapshotSources.get(source.id);
      if (!snap || snap.collection !== source.collection || snap.recordDigest !== source.recordDigest) {
        throw new CutoverFenceError("Candidate source does not match its snapshot commitment");
      }
      return snap;
    });
    const srcProj = projectSourceLogical(cand, buildSourceProjectionMap(cand, entries, codec), codec, subject);
    assertSubjectRefsPresent(cand.kind, srcProj, subject);
    const srcDigest = H(storeKey, "logical-record", namespace, epoch, [cand.kind, srcProj]);
    if (srcDigest !== cand.logicalDigest) {
      throw new CutoverFenceError("Candidate logical digest does not match the recomputed source projection");
    }
    logicalItems.push([cand.id, srcDigest]);
    const expectedTargets = [];
    const target = /* @__PURE__ */ __name((collection, physicalId) => {
      if (typeof physicalId !== "string" || !physicalId) throw new CutoverFenceError("Projected target identity is missing");
      expectedTargets.push({ collection, physicalId, id: computeKeyedDocId(storeKey, "target-id", namespace, epoch, collection, physicalId) });
    }, "target");
    if (cand.kind === "pr56Families" || cand.kind === "baseFormatTokens") {
      target("families", srcProj.familyId);
      target("upstream", srcProj.familyId);
      target("tokens", srcProj.currentAccessTokenId);
      target("refresh", srcProj.activeRefreshId);
      if (srcProj.previousRefresh) target("refresh", srcProj.previousRefresh.id);
      for (const fingerprint of srcProj.retiredRefreshFingerprints) target("retiredRefreshTokens", fingerprint);
    } else if (cand.kind === "authCodes") target("authCodes", srcProj.codeId);
    else if (cand.kind === "resumeTokens") target("resumeTokens", srcProj.resumeId);
    else if (cand.kind === "clients") target("oauthClients", srcProj.clientId);
    else throw new CutoverFenceError("Unsupported candidate target kind");
    const sorted = /* @__PURE__ */ __name((refs) => refs.map(({ collection, id }) => ({ collection, id })).sort((a, b) => canonicalCompare(`${a.collection}:${a.id}`, `${b.collection}:${b.id}`)), "sorted");
    if (C(sorted(expectedTargets)) !== C(sorted(cand.targets))) throw new CutoverFenceError("Candidate target references do not match the projected identities");
    const item = planItems.get(cand.id);
    if (!item) throw new CutoverFenceError("Candidate plan item is missing");
    const expectedByIdentity = new Map(expectedTargets.map((ref) => [`${ref.collection}\0${ref.physicalId}`, ref]));
    if (expectedByIdentity.size !== expectedTargets.length) throw new CutoverFenceError("Projected target identity is duplicated");
    const postimagesByKey = /* @__PURE__ */ new Map();
    const retiredPostimages = [];
    for (const data of item.prospectiveTargetPostimages) {
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new CutoverFenceError("Malformed prospective target postimage");
      let collection;
      let physicalId;
      if (cand.kind === "clients") {
        collection = "oauthClients";
        physicalId = data.client_id;
      } else if (cand.kind === "authCodes") {
        collection = "authCodes";
        physicalId = data.id;
      } else if (cand.kind === "resumeTokens") {
        collection = "resumeTokens";
        physicalId = data.id;
      } else if (data.id === void 0) {
        retiredPostimages.push(data);
        continue;
      } else if (data.activeRefreshId !== void 0) {
        collection = "families";
        physicalId = data.id;
      } else if (data.grantVersion !== void 0) {
        collection = "upstream";
        physicalId = data.id;
      } else if (data.retainUntil !== void 0) {
        collection = "tokens";
        physicalId = data.id;
      } else if (data.status !== void 0) {
        collection = "refresh";
        physicalId = data.id;
      } else throw new CutoverFenceError("Prospective target postimage has no recognized identity");
      const identity = expectedByIdentity.get(`${collection}\0${physicalId}`);
      if (!identity) throw new CutoverFenceError("Prospective target postimage identity does not match the source");
      const key = `${identity.collection}:${identity.id}`;
      if (postimagesByKey.has(key)) throw new CutoverFenceError("Duplicate prospective target identity");
      postimagesByKey.set(key, { collection, physicalId, data });
    }
    const retired = expectedTargets.filter((ref) => ref.collection === "retiredRefreshTokens").sort((a, b) => canonicalCompare(a.id, b.id));
    if (retired.length !== retiredPostimages.length || retiredPostimages.some((data) => C(data) !== C({ familyId: srcProj.familyId }))) {
      throw new CutoverFenceError("Prospective retired target postimages do not match their source family");
    }
    for (const identity of retired) {
      postimagesByKey.set(`${identity.collection}:${identity.id}`, { collection: identity.collection, physicalId: identity.physicalId, data: retiredPostimages[0] });
    }
    if (postimagesByKey.size !== expectedTargets.length) throw new CutoverFenceError("Prospective target identity set is incomplete");
    const prospective = item.targetReferences.map((ref) => {
      const entry = postimagesByKey.get(`${ref.collection}:${ref.id}`);
      if (!entry) throw new CutoverFenceError("Prospective target reference has no matching postimage identity");
      return entry;
    });
    const receiptTargets = prospective.map((entry) => {
      const id = computeKeyedDocId(storeKey, "target-id", namespace, epoch, entry.collection, entry.physicalId);
      return { collection: entry.collection, id, recordDigest: computeTargetRecordDigest(storeKey, namespace, epoch, entry.collection, id, entry.data) };
    });
    if (C(item.receiptUpperBound.targetAfter) !== C(receiptTargets)) throw new CutoverFenceError("Prospective receipt does not bind target postimages");
    const prospectiveProjection = projectTargetLogical(cand, buildTargetProjectionMap(cand, prospective, { requireIds: true }), codec);
    if (H(storeKey, "logical-record", namespace, epoch, [cand.kind, prospectiveProjection]) !== srcDigest) {
      throw new CutoverFenceError("Prospective target graph does not match its source projection");
    }
    const present = cand.targets.filter((t) => snapshotTargets.has(t.id));
    if (present.length === 0) continue;
    if (present.length !== cand.targets.length) {
      throw new CutoverFenceError("Partial target graph present for a candidate; held");
    }
    const targetEntries = cand.targets.map((ref) => {
      const snap = snapshotTargets.get(ref.id);
      if (!snap || snap.collection !== ref.collection) throw new CutoverFenceError("Candidate target does not match its snapshot reference");
      return snap;
    });
    const tgtProj = projectTargetLogical(cand, buildTargetProjectionMap(cand, targetEntries), codec);
    assertSubjectRefsPresent(cand.kind, tgtProj, subject);
    if (H(storeKey, "logical-record", namespace, epoch, [cand.kind, tgtProj]) !== srcDigest) {
      throw new CutoverFenceError("Existing target graph does not equal the source projection; held");
    }
  }
  logicalItems.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  if (computeLogicalInventoryDigest(storeKey, namespace, epoch, logicalItems) !== prepDoc.sourceLogicalDigest) {
    throw new CutoverFenceError("Prepared sourceLogicalDigest does not match the recomputed logical inventory");
  }
  timer.assertUnderDeadline("revalidatePreparationSnapshot complete");
  return { scanned: snapshotSources.size };
}
__name(revalidatePreparationSnapshot, "revalidatePreparationSnapshot");
var PREPARE_OPTION_KEYS = Object.freeze(["namespace", "prepDoc", "storeKey", "FieldPath", "timer", "completePlan", "expectedIdentity", "indexManifest", "protectedBinding"]);
var EXPECTED_IDENTITY_KEYS = Object.freeze(["namespace", "epoch", "migrationRunId", "codeSha", "codeArtifact", "packageIntegrity", "protocolDigest", "assemblyDigest", "indexSchemaDigest", "indexPolicyDigest", "encoderVersion"]);
var PROTECTED_BINDING_KEYS = Object.freeze(["profile", "project", "database", "subjectDescriptor"]);
var PREPARED_IDENTITY_KEYS = Object.freeze(["namespace", "epoch", "migrationRunId", "codeSha", "codeArtifact", "packageIntegrity", "protocolDigest", "assemblyDigest", "indexSchemaDigest", "encoderVersion"]);
function assertPreparedIdentity(prepDoc, expectedIdentity, namespace) {
  if (expectedIdentity.namespace !== namespace) {
    throw new CutoverFenceError("Approved identity namespace does not match the preparation namespace");
  }
  for (const key of PREPARED_IDENTITY_KEYS) {
    if (prepDoc[key] !== expectedIdentity[key]) {
      throw new CutoverFenceError(`Prepared manifest identity '${key}' does not match the approved value`);
    }
  }
}
__name(assertPreparedIdentity, "assertPreparedIdentity");
function assertSubjectRefsPresent(kind, projection, subject) {
  if (subject === null) return;
  if (kind !== "pr56Families" && kind !== "baseFormatTokens") return;
  if (projection.status === "active" && !Array.isArray(projection.subjectRefs)) {
    throw new CutoverFenceError("Subject-bound active family or token projection has no subjectRefs; held");
  }
}
__name(assertSubjectRefsPresent, "assertSubjectRefsPresent");
async function readPreparationSnapshot(transaction, db, namespace, FieldPath) {
  if (!FieldPath || typeof FieldPath.documentId !== "function") {
    throw new CutoverFenceError("FieldPath with documentId() is REQUIRED for prepareMigrationInTransaction");
  }
  const docIdField = FieldPath.documentId();
  const rawColSnaps = /* @__PURE__ */ new Map();
  for (const colName of getCutoverDistinctCollectionNames(namespace).distinct) {
    rawColSnaps.set(colName, await transaction.get(db.collection(colName).orderBy(docIdField)));
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
        if (isTargetFormatRow(physicalName, d.data())) {
          targetDocsByKey.get(tKey).push(d);
        } else {
          sourceDocsByKey.get(sKey).push(d);
        }
      }
    }
  }
  const allDocs = Array.from(rawColSnaps.values()).flatMap((s) => s.docs.map((d) => d.data()));
  return { sourceDocsByKey, targetDocsByKey, allDocs };
}
__name(readPreparationSnapshot, "readPreparationSnapshot");
async function prepareMigrationInTransaction(transaction, db, options) {
  if (!options || !isMonotonicTimer(options.timer)) {
    throw new CutoverFenceError("prepareMigrationInTransaction requires a canonical startMonotonicTimer() instance in options.timer created at transaction callback entry");
  }
  const timer = options.timer;
  timer.assertUnderDeadline("prepareMigrationInTransaction entry");
  const { namespace, prepDoc } = options;
  assertSupportedCutoverNamespace(namespace);
  if (!options.storeKey || typeof options.storeKey !== "string" && !Buffer.isBuffer(options.storeKey) && !(options.storeKey instanceof Uint8Array)) {
    throw new CutoverFenceError("storeKey is REQUIRED for prepareMigrationInTransaction");
  }
  if (!options.completePlan || !options.expectedIdentity || !options.indexManifest || !options.protectedBinding) {
    throw new CutoverFenceError("Preparation requires the engine-built complete plan, expected identity, verified index manifest and protected binding; not integrated");
  }
  validateMapKeysExact(options, PREPARE_OPTION_KEYS, "prepareMigrationInTransaction options");
  validateMapKeysExact(options.expectedIdentity, EXPECTED_IDENTITY_KEYS, "expected identity");
  validateMapKeysExact(options.protectedBinding, PROTECTED_BINDING_KEYS, "protected binding");
  try {
    validateSubjectDescriptor(namespace, options.protectedBinding.subjectDescriptor);
  } catch {
    throw new CutoverFenceError("Protected binding subject descriptor is not a valid signed descriptor");
  }
  assertPreparedIdentity(prepDoc, options.expectedIdentity, namespace);
  verifyIndexManifestDigests(options.indexManifest, { ...options.expectedIdentity, binding: options.protectedBinding });
  validateCompleteMigrationPlan(options.completePlan);
  if (C(prepDoc) !== C(options.completePlan.prepared)) {
    throw new CutoverFenceError("Engine prepared document and complete plan prepared document differ");
  }
  const preflightControl = await readCutoverFenceInTransaction(transaction, db, namespace);
  if (preflightControl.state !== "fenced" && preflightControl.state !== "migrating") {
    throw new CutoverFenceError(`Cannot prepare migration: state must be 'fenced', got '${preflightControl.state}'`);
  }
  if (preflightControl.state === "fenced" && preflightControl.activeOperations !== 0) {
    throw new CutoverFenceError(`Cannot prepare migration: activeOperations must be 0, got ${preflightControl.activeOperations}`);
  }
  if (preflightControl.epoch !== options.expectedIdentity.epoch) {
    throw new CutoverFenceError("Preparation epoch does not match the approved identity");
  }
  let snapshot;
  if (preflightControl.state === "fenced") {
    snapshot = await readPreparationSnapshot(transaction, db, namespace, options.FieldPath);
    await revalidatePreparationSnapshot(transaction, db, { ...options, prepDoc, snapshot }, preflightControl);
  }
  const control = await readCutoverFenceInTransaction(transaction, db, namespace);
  const FieldPath = options.FieldPath;
  if (!FieldPath || typeof FieldPath.documentId !== "function") {
    throw new CutoverFenceError("FieldPath with documentId() is REQUIRED for prepareMigrationInTransaction");
  }
  if (control.state === "migrating") {
    const prepRef2 = db.collection(`${namespace}_meta`).doc(`migration_prepared_${control.epoch}`);
    const prepSnap2 = await transaction.get(prepRef2);
    if (prepSnap2.exists) {
      assertPreparedIdentity(prepSnap2.data(), options.expectedIdentity, namespace);
    }
    validateCompleteMigrationPlanForIdentity(options.completePlan, options.expectedIdentity);
    if (prepSnap2.exists && C(prepSnap2.data()) === C(prepDoc) && C(prepDoc) === C(options.completePlan.prepared) && control.migrationRunId === options.expectedIdentity.migrationRunId) {
      return control;
    }
    throw new CutoverFenceError(
      "Already migrating with different manifest or runId; immutable retry violation"
    );
  }
  if (control.state !== "fenced") {
    throw new CutoverFenceError(`Cannot prepare migration: state must be 'fenced', got '${control.state}'`);
  }
  if (control.activeOperations !== 0) {
    throw new CutoverFenceError(`Cannot prepare migration: activeOperations must be 0, got ${control.activeOperations}`);
  }
  const expectedPrepKeys = prepDoc.totalPhysicalRecords > 0 ? [...REQUIRED_PREPARED_MANIFEST_KEYS, ...NONEMPTY_PROJECTOR_KEYS] : REQUIRED_PREPARED_MANIFEST_KEYS;
  validateMapKeysExact(prepDoc, expectedPrepKeys, "prepared manifest");
  validateMigrationIdentityFields(prepDoc, namespace, control.epoch, prepDoc.migrationRunId);
  const computedPlanDigest = computePlanDigest(namespace, control.epoch, prepDoc.planSpec);
  if (prepDoc.planDigest !== computedPlanDigest) {
    throw new CutoverFenceError(
      `prepared manifest planDigest mismatch: expected ${computedPlanDigest}, got ${prepDoc.planDigest}`
    );
  }
  if (prepDoc.kind !== "prepared") {
    throw new CutoverFenceError(`prepared manifest kind must be 'prepared', got '${prepDoc.kind}'`);
  }
  if (typeof prepDoc.preparedAt !== "number" || !Number.isInteger(prepDoc.preparedAt) || prepDoc.preparedAt <= 0) {
    throw new CutoverFenceError("preparedAt must be a positive integer timestamp");
  }
  validateMapKeysExact(prepDoc.physicalCounts, PHYSICAL_COUNT_KEYS, "prepared physicalCounts");
  validateMapKeysExact(prepDoc.expectedTargetCounts, TARGET_COUNT_KEYS, "prepared expectedTargetCounts");
  validateMapKeysExact(prepDoc.classifications, CLASSIFICATION_KEYS, "prepared classifications");
  validateMapKeysExact(prepDoc.reasons, REASON_KEYS, "prepared reasons");
  const prepPhysicalSum = Object.values(prepDoc.physicalCounts).reduce((sum, n) => {
    if (!Number.isSafeInteger(n) || n < 0) throw new CutoverFenceError("Invalid physical count");
    return sum + n;
  }, 0);
  if (prepPhysicalSum !== prepDoc.totalPhysicalRecords) {
    throw new CutoverFenceError(
      `prepared totalPhysicalRecords must equal sum(physicalCounts): expected ${prepPhysicalSum}, got ${prepDoc.totalPhysicalRecords}`
    );
  }
  const prepClassSum = Object.values(prepDoc.classifications).reduce((sum, n) => {
    if (!Number.isSafeInteger(n) || n < 0) throw new CutoverFenceError("Invalid classification count");
    return sum + n;
  }, 0);
  if (prepClassSum !== prepDoc.scanned || prepDoc.scanned !== prepDoc.candidateCommitments.length) {
    throw new CutoverFenceError(
      "prepared classifications sum must equal scanned and candidateCommitments.length"
    );
  }
  validateCandidateCommitments(prepDoc.candidateCommitments, prepDoc, namespace, control.epoch, prepDoc.migrationRunId);
  if (snapshot === void 0) {
    throw new CutoverFenceError("Preparation snapshot is missing; the fenced snapshot is read before the prepare body");
  }
  const { sourceDocsByKey, targetDocsByKey, allDocs } = snapshot;
  const existingTargetKeyedMap = /* @__PURE__ */ new Map();
  for (const [colKey, docs] of targetDocsByKey.entries()) {
    for (const d of docs) {
      const data = d.data() || {};
      if (colKey !== "oauthClients" && colKey !== "clients") {
        if (typeof data.id === "string" && data.id !== d.id) {
          throw new CutoverFenceError(`Document ID mismatch in ${colKey}: stored id does not match document key`);
        }
      } else {
        if (typeof data.client_id === "string" && data.client_id !== d.id) {
          throw new CutoverFenceError(`client_id mismatch in ${colKey}: stored client_id does not match document key`);
        }
      }
      const targetId = computeKeyedDocId(options.storeKey, "target-id", namespace, control.epoch, colKey, d.id);
      const recDigest = computeTargetRecordDigest(options.storeKey, namespace, control.epoch, colKey, targetId, data);
      existingTargetKeyedMap.set(`${colKey}:${targetId}`, { doc: d, rawId: d.id, recordDigest: recDigest, data });
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
        throw new CutoverFenceError(
          `Candidate ${c.id} has partial retained target graph in Firestore (${existingTargetsForCandidate}/${c.targets.length}); must be all-or-none complete`
        );
      }
      for (const t of c.targets) {
        const targetKey = `${t.collection}:${t.id}`;
        const entry = existingTargetKeyedMap.get(targetKey);
        if (t.recordDigest && entry.recordDigest !== t.recordDigest) {
          throw new CutoverFenceError(
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
      throw new CutoverFenceError(`Cannot prepare migration: unexpected extra target '${targetKey}' exists prior to migration`);
    }
  }
  for (const k of PHYSICAL_COUNT_KEYS) {
    const actualCount = sourceDocsByKey.get(k).length;
    if (actualCount !== prepDoc.physicalCounts[k]) {
      throw new CutoverFenceError(
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
        throw new CutoverFenceError(`Document ID mismatch in ${colKey}: stored id does not match document key`);
      }
      if ((colKey === "oauthClients" || colKey === "clients") && typeof data.client_id === "string" && data.client_id !== d.id) {
        throw new CutoverFenceError(`client_id mismatch in ${colKey}: stored client_id does not match document key`);
      }
      const sourceId = computeKeyedDocId(options.storeKey, "source-id", namespace, control.epoch, colKey, d.id);
      const recDigest = computeSourceRecordDigest(options.storeKey, namespace, control.epoch, colKey, sourceId, data);
      sourceKeyedMap.set(`${colKey}:${sourceId}`, { doc: d, rawId: d.id, recordDigest: recDigest, data });
      sourceDescriptors.push({ collection: colKey, id: sourceId, recordDigest: recDigest });
    }
  }
  const coveredSources = /* @__PURE__ */ new Set();
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
  if (prepDoc.totalPhysicalRecords > 0) {
    if (prepDoc.projectorId !== APPROVED_GRAPH_PROJECTOR_ID || prepDoc.projectorVersion !== APPROVED_GRAPH_PROJECTOR_VERSION) {
      throw new CutoverFenceError(
        `Projector identity mismatch: expected '${APPROVED_GRAPH_PROJECTOR_ID}' v${APPROVED_GRAPH_PROJECTOR_VERSION}, got '${prepDoc.projectorId}' v${prepDoc.projectorVersion}`
      );
    }
    if (prepDoc.projectorDigest !== options.expectedIdentity.protocolDigest) {
      throw new CutoverFenceError("prepDoc.projectorDigest must equal protocolDigest");
    }
    const codec = createCodec(options.storeKey);
    const subject = subjectSpecFor(options.protectedBinding.subjectDescriptor, namespace, options.storeKey);
    for (const c of prepDoc.candidateCommitments) {
      const sourceEntries = c.sources.map((ref) => {
        const entry = sourceKeyedMap.get(`${ref.collection}:${ref.id}`);
        if (!entry || entry.recordDigest !== ref.recordDigest) throw new CutoverFenceError("Candidate source does not match its snapshot commitment");
        return { collection: ref.collection, physicalId: entry.rawId, data: entry.data };
      });
      const sourcesMap = buildSourceProjectionMap(c, sourceEntries, codec);
      const sourceResult = projectSourceLogical(c, sourcesMap, codec, subject);
      assertSubjectRefsPresent(c.kind, sourceResult, subject);
      validateCandidateProjection(c.kind, c.id, sourceResult);
      const derivedSourceLogicalDigest = H(options.storeKey, "logical-record", namespace, control.epoch, [c.kind, sourceResult]);
      if (c.logicalDigest !== derivedSourceLogicalDigest) {
        throw new CutoverFenceError(
          `Candidate ${c.id} logicalDigest mismatch with projector-derived source logical digest`
        );
      }
      const existingTargetsCount = c.targets.filter((t) => existingTargetKeyedMap.has(`${t.collection}:${t.id}`)).length;
      if (existingTargetsCount > 0) {
        const targetEntries = c.targets.map((ref) => {
          const entry = existingTargetKeyedMap.get(`${ref.collection}:${ref.id}`);
          if (!entry) throw new CutoverFenceError("Candidate target is absent from the snapshot");
          return { collection: ref.collection, physicalId: entry.rawId, data: entry.data };
        });
        const targetsMap = buildTargetProjectionMap(c, targetEntries);
        const targetResult = projectTargetLogical(c, targetsMap, codec);
        assertSubjectRefsPresent(c.kind, targetResult, subject);
        validateCandidateProjection(c.kind, c.id, targetResult);
        const derivedTargetLogicalDigest = H(options.storeKey, "logical-record", namespace, control.epoch, [c.kind, targetResult]);
        if (derivedTargetLogicalDigest !== c.logicalDigest) {
          throw new CutoverFenceError(
            `Retained target graph for candidate ${c.id} is not logically equivalent to candidate commitment`
          );
        }
      }
    }
  }
  const computedSourceInventory = computeSourceInventoryDigest(options.storeKey, namespace, control.epoch, sourceDescriptors);
  if (prepDoc.sourceInventoryDigest !== computedSourceInventory) {
    throw new CutoverFenceError("prepared manifest sourceInventoryDigest does not match computed source inventory");
  }
  const sortedCandidateLogicalPairs = prepDoc.candidateCommitments.map((c) => [c.id, c.logicalDigest]).sort((a, b) => canonicalCompare(a[0], b[0]));
  const computedLogicalInventory = H(options.storeKey, "logical-inventory", namespace, control.epoch, sortedCandidateLogicalPairs);
  if (prepDoc.sourceLogicalDigest !== computedLogicalInventory) {
    throw new CutoverFenceError("prepared manifest sourceLogicalDigest does not match computed logical inventory");
  }
  validateMigrationPreflightLimits(prepDoc, { fullReadset: allDocs });
  const prepRef = db.collection(`${namespace}_meta`).doc(`migration_prepared_${control.epoch}`);
  const prepSnap = await transaction.get(prepRef);
  if (prepSnap.exists) {
    throw new CutoverFenceError(
      "Prepared manifest exists while the fence is fenced; the state is inconsistent and is held for review, not treated as prepared"
    );
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
  if (!options || !isMonotonicTimer(options.timer)) {
    throw new CutoverFenceError("finalizeMigrationInTransaction requires a canonical startMonotonicTimer() instance in options.timer created at transaction callback entry");
  }
  const timer = options.timer;
  timer.assertUnderDeadline("finalizeMigrationInTransaction entry");
  const { namespace, finalDoc, markerDoc } = options;
  assertSupportedCutoverNamespace(namespace);
  if (!options.storeKey || typeof options.storeKey !== "string" && !Buffer.isBuffer(options.storeKey) && !(options.storeKey instanceof Uint8Array)) {
    throw new CutoverFenceError("storeKey is REQUIRED for finalizeMigrationInTransaction");
  }
  const control = await readCutoverFenceInTransaction(transaction, db, namespace);
  const FieldPath = options.FieldPath;
  if (!FieldPath || typeof FieldPath.documentId !== "function") {
    throw new CutoverFenceError("FieldPath with documentId() is REQUIRED for finalizeMigrationInTransaction");
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
    throw new CutoverFenceError(
      "Already in v3_ready state with different manifests; immutable retry violation"
    );
  }
  if (control.state !== "migrating") {
    throw new CutoverFenceError(`Cannot finalize migration: state must be 'migrating', got '${control.state}'`);
  }
  if (control.activeOperations !== 0) {
    throw new CutoverFenceError(`Cannot finalize migration: activeOperations must be 0, got ${control.activeOperations}`);
  }
  if (markerDoc.emptyNamespace !== true && !control.irreversible) {
    throw new CutoverFenceError(
      `Cannot finalize migration for namespace ${namespace}: irreversible latch must be engaged before finalization`
    );
  }
  const prepRef = db.collection(`${namespace}_meta`).doc(`migration_prepared_${control.epoch}`);
  const prepSnap = await transaction.get(prepRef);
  if (!prepSnap.exists) {
    throw new CutoverFenceError(`Cannot finalize migration: prepared manifest missing for epoch ${control.epoch}`);
  }
  const prep = prepSnap.data();
  validateMapKeysExact(finalDoc, REQUIRED_FINAL_MANIFEST_KEYS, "final manifest");
  validateMigrationIdentityFields(finalDoc, namespace, control.epoch, control.migrationRunId);
  if (finalDoc.kind !== "final") {
    throw new CutoverFenceError(`final manifest kind must be 'final', got '${finalDoc.kind}'`);
  }
  if (typeof finalDoc.completedAt !== "number" || !Number.isInteger(finalDoc.completedAt) || finalDoc.completedAt <= 0) {
    throw new CutoverFenceError("final manifest completedAt must be a positive integer timestamp");
  }
  validateMapKeysExact(markerDoc, REQUIRED_OWNERSHIP_MARKER_KEYS, "ownership marker");
  validateMigrationIdentityFields(markerDoc, namespace, control.epoch, control.migrationRunId);
  if (markerDoc.kind !== "ownership") {
    throw new CutoverFenceError(`ownership marker kind must be 'ownership', got '${markerDoc.kind}'`);
  }
  if (typeof markerDoc.adoptedAt !== "number" || !Number.isInteger(markerDoc.adoptedAt) || markerDoc.adoptedAt <= 0) {
    throw new CutoverFenceError("ownership marker adoptedAt must be a positive integer timestamp");
  }
  for (const k of REQUIRED_IDENTITY_KEYS) {
    if (finalDoc[k] !== prep[k] || markerDoc[k] !== prep[k]) {
      throw new CutoverFenceError(`Identity field '${k}' mismatch across prepared, final, and marker manifests`);
    }
  }
  validatePlanSpec(prep.planSpec, prep, namespace, control.epoch, prep.migrationRunId);
  const computedPlanDigest = computePlanDigest(namespace, control.epoch, prep.planSpec);
  if (prep.planDigest !== computedPlanDigest) {
    throw new CutoverFenceError(
      `Prepared manifest planDigest mismatch: expected ${computedPlanDigest}, got ${prep.planDigest}`
    );
  }
  const computedPreparedDigest = D("prepared", namespace, control.epoch, prep);
  if (finalDoc.preparedDigest !== computedPreparedDigest) {
    throw new CutoverFenceError(
      `final manifest preparedDigest (${finalDoc.preparedDigest}) does not match computed prepared digest (${computedPreparedDigest})`
    );
  }
  if (markerDoc.preparedDigest !== computedPreparedDigest) {
    throw new CutoverFenceError("ownership marker preparedDigest does not match computed prepared digest");
  }
  const computedFinalDigest = D("final", namespace, control.epoch, finalDoc);
  if (markerDoc.migrationManifestDigest !== computedFinalDigest) {
    throw new CutoverFenceError(
      `ownership marker migrationManifestDigest (${markerDoc.migrationManifestDigest}) does not match computed final digest (${computedFinalDigest})`
    );
  }
  validateMapKeysExact(finalDoc.physicalCounts, PHYSICAL_COUNT_KEYS, "final physicalCounts");
  validateMapKeysExact(finalDoc.targetCounts, TARGET_COUNT_KEYS, "final targetCounts");
  validateMapKeysExact(finalDoc.classifications, CLASSIFICATION_KEYS, "final classifications");
  validateMapKeysExact(finalDoc.reasons, REASON_KEYS, "final reasons");
  if (finalDoc.errors !== 0) {
    throw new CutoverFenceError(`Cannot finalize migration: final errors must be 0, got ${finalDoc.errors}`);
  }
  for (const [rKey, rVal] of Object.entries(finalDoc.reasons)) {
    if (rVal !== 0) {
      throw new CutoverFenceError(`Cannot finalize migration: reason count '${rKey}' must be 0, got ${rVal}`);
    }
  }
  if (finalDoc.sourceLogicalDigest !== finalDoc.targetLogicalDigest) {
    throw new CutoverFenceError("Cannot finalize migration: sourceLogicalDigest must equal targetLogicalDigest");
  }
  if (finalDoc.sourceInventoryDigest !== prep.sourceInventoryDigest) {
    throw new CutoverFenceError("Cannot finalize migration: sourceInventoryDigest must match prepared");
  }
  if (finalDoc.sourceLogicalDigest !== prep.sourceLogicalDigest) {
    throw new CutoverFenceError("Cannot finalize migration: sourceLogicalDigest must match prepared");
  }
  if (C(finalDoc.physicalCounts) !== C(prep.physicalCounts)) {
    throw new CutoverFenceError("final physicalCounts do not match prepared physicalCounts");
  }
  if (C(finalDoc.targetCounts) !== C(prep.expectedTargetCounts)) {
    throw new CutoverFenceError("final targetCounts do not match prepared expectedTargetCounts");
  }
  if (C(finalDoc.classifications) !== C(prep.classifications)) {
    throw new CutoverFenceError("final classifications do not match prepared classifications");
  }
  if (C(finalDoc.reasons) !== C(prep.reasons)) {
    throw new CutoverFenceError("final reasons do not match prepared reasons");
  }
  const finalPhysicalSum = Object.values(finalDoc.physicalCounts).reduce((sum, n) => sum + n, 0);
  if (finalPhysicalSum !== finalDoc.totalPhysicalRecords) {
    throw new CutoverFenceError("final physicalCounts sum must equal totalPhysicalRecords");
  }
  const targetCountSum = Object.values(finalDoc.targetCounts).reduce((sum, n) => {
    if (!Number.isSafeInteger(n) || n < 0) throw new CutoverFenceError("Invalid target count");
    return sum + n;
  }, 0);
  if (markerDoc.emptyNamespace === true) {
    if (finalDoc.totalPhysicalRecords !== 0 || finalDoc.scanned !== 0 || finalDoc.migrated !== 0 || finalDoc.skipped !== 0 || finalDoc.errors !== 0) {
      throw new CutoverFenceError("Counts must be 0 for emptyNamespace final manifest");
    }
    if (prep.candidateCommitments.length !== 0) {
      throw new CutoverFenceError("candidateCommitments must be empty for emptyNamespace");
    }
    if (targetCountSum !== 0) {
      throw new CutoverFenceError("targetCounts sum must be 0 for emptyNamespace");
    }
    const emptySourceInventory = H(options.storeKey, "source-inventory", namespace, control.epoch, []);
    const emptyTargetInventory = H(options.storeKey, "target-inventory", namespace, control.epoch, []);
    const emptyLogicalInventory = H(options.storeKey, "logical-inventory", namespace, control.epoch, []);
    const emptyReceiptSet = D("receipt-set", namespace, control.epoch, []);
    if (prep.sourceInventoryDigest !== emptySourceInventory) {
      throw new CutoverFenceError("Empty namespace requires canonical empty sourceInventoryDigest");
    }
    if (prep.sourceLogicalDigest !== emptyLogicalInventory) {
      throw new CutoverFenceError("Empty namespace requires canonical empty sourceLogicalDigest");
    }
    if (finalDoc.targetInventoryDigest !== emptyTargetInventory) {
      throw new CutoverFenceError("Empty namespace requires canonical empty targetInventoryDigest");
    }
    if (finalDoc.receiptSetDigest !== emptyReceiptSet) {
      throw new CutoverFenceError("Empty namespace requires canonical empty receiptSetDigest");
    }
  } else {
    if (targetCountSum <= 0 && finalDoc.migrated > 0) {
      throw new CutoverFenceError("targetCounts sum must be greater than 0 for non-empty namespace");
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
      throw new CutoverFenceError(`Invalid receipt document ID: ${d.id}`);
    }
    const candidateIdSuffix = d.id.slice(expectedPrefix.length);
    const data = d.data();
    if (data.candidateId !== candidateIdSuffix) {
      throw new CutoverFenceError(
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
        if (isTargetFormatRow(physicalName, d.data())) {
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
        throw new CutoverFenceError(`Document ID mismatch in ${colKey}: stored id does not match document key`);
      }
      if ((colKey === "oauthClients" || colKey === "clients") && typeof data.client_id === "string" && data.client_id !== d.id) {
        throw new CutoverFenceError(`client_id mismatch in ${colKey}: stored client_id does not match document key`);
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
          throw new CutoverFenceError(`Document ID mismatch in ${colKey}: stored id does not match document key`);
        }
      } else {
        if (typeof data.client_id === "string" && data.client_id !== d.id) {
          throw new CutoverFenceError(`client_id mismatch in ${colKey}: stored client_id does not match document key`);
        }
      }
      const targetId = computeKeyedDocId(options.storeKey, "target-id", namespace, control.epoch, colKey, d.id);
      const recDigest = computeTargetRecordDigest(options.storeKey, namespace, control.epoch, colKey, targetId, data);
      currentTargetKeyedMap.set(`${colKey}:${targetId}`, { doc: d, rawId: d.id, recordDigest: recDigest, data });
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
    const expectedCandDigest = D("candidate", namespace, control.epoch, c);
    if (r.candidateDigest !== expectedCandDigest) {
      throw new CutoverFenceError(`Receipt candidateDigest mismatch for candidate ${r.candidateId}`);
    }
    if (r.logicalDigest !== c.logicalDigest) {
      throw new CutoverFenceError(`Receipt logicalDigest mismatch for candidate ${r.candidateId}`);
    }
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
  for (const sourceKey of currentSourceKeyedMap.keys()) {
    if (!retainedSources.has(sourceKey)) {
      throw new CutoverFenceError(`Extra source document '${sourceKey}' found in Firestore not accounted for as retained by receipts`);
    }
  }
  for (const targetKey of currentTargetKeyedMap.keys()) {
    if (!expectedWrittenTargets.has(targetKey)) {
      throw new CutoverFenceError(`Extra target document '${targetKey}' found in Firestore not accounted for by receipts`);
    }
  }
  if (finalDoc.totalPhysicalRecords > 0) {
    const codec = bundledCodec(options.storeKey);
    for (const r of actualReceipts) {
      const c = candidateMap.get(r.candidateId);
      const targetEntries = c.targets.map((ref) => {
        const entry = currentTargetKeyedMap.get(`${ref.collection}:${ref.id}`);
        if (!entry) throw new CutoverFenceError("Candidate target is absent from the final snapshot");
        return { collection: ref.collection, physicalId: entry.rawId, data: entry.data };
      });
      const targetsMap = buildTargetProjectionMap(c, targetEntries);
      const targetResult = projectTargetLogical(c, targetsMap, codec);
      validateCandidateProjection(c.kind, r.candidateId, targetResult);
      const derivedTargetLogicalDigest = H(options.storeKey, "logical-record", namespace, control.epoch, [c.kind, targetResult]);
      if (r.logicalDigest !== derivedTargetLogicalDigest) {
        throw new CutoverFenceError(
          `Receipt ${r.candidateId} logicalDigest mismatch with projector-derived target logical digest`
        );
      }
    }
  }
  const computedTargetInventory = computeTargetInventoryDigest(options.storeKey, namespace, control.epoch, targetDescriptors);
  if (finalDoc.targetInventoryDigest !== computedTargetInventory) {
    throw new CutoverFenceError("final manifest targetInventoryDigest does not match computed target inventory");
  }
  const sortedReceiptLogicalPairs = actualReceipts.map((r) => [r.candidateId, r.logicalDigest]).sort((a, b) => canonicalCompare(a[0], b[0]));
  const computedTargetLogical = H(options.storeKey, "logical-inventory", namespace, control.epoch, sortedReceiptLogicalPairs);
  if (finalDoc.targetLogicalDigest !== computedTargetLogical) {
    throw new CutoverFenceError("final manifest targetLogicalDigest does not match computed logical inventory");
  }
  for (const k of TARGET_COUNT_KEYS) {
    const actualCount = targetDocsByKey.get(k).length;
    if (actualCount !== finalDoc.targetCounts[k]) {
      throw new CutoverFenceError(
        `Target count mismatch on finalization for '${k}': Firestore has ${actualCount}, finalDoc has ${finalDoc.targetCounts[k]}`
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
    throw new CutoverFenceError("Cannot finalize migration: final scanned must equal migrated + skipped");
  }
  if (actualReceipts.length !== prep.scanned) {
    throw new CutoverFenceError(`receipts count (${actualReceipts.length}) does not equal scanned (${prep.scanned})`);
  }
  const computedReceiptSetDigest = computeReceiptSetDigest(actualReceipts, namespace, control.epoch);
  if (finalDoc.receiptSetDigest !== computedReceiptSetDigest) {
    throw new CutoverFenceError(
      `receiptSetDigest mismatch: expected ${finalDoc.receiptSetDigest}, computed ${computedReceiptSetDigest}`
    );
  }
  for (const c of prep.candidateCommitments) {
    if (!receiptCandidateIds.has(c.id)) {
      throw new CutoverFenceError(`Missing receipt for committed candidate ${c.id}`);
    }
  }
  const finalRef = db.collection(`${namespace}_meta`).doc(`migration_manifest_${control.epoch}`);
  const markerRef = db.collection(`${namespace}_meta`).doc("v2_adopted");
  const finalSnap = await transaction.get(finalRef);
  if (finalSnap.exists && C(finalSnap.data()) !== C(finalDoc)) {
    throw new CutoverFenceError("Final manifest already exists with different content; immutable retry violation");
  }
  const markerSnap = await transaction.get(markerRef);
  if (markerSnap.exists && C(markerSnap.data()) !== C(markerDoc)) {
    throw new CutoverFenceError("Ownership marker already exists with different content; immutable retry violation");
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
  if (!options || !isMonotonicTimer(options.timer)) {
    throw new CutoverFenceError("activateMigrationInTransaction requires a canonical startMonotonicTimer() instance in options.timer created at transaction callback entry");
  }
  const timer = options.timer;
  timer.assertUnderDeadline("activateMigrationInTransaction entry");
  const { namespace, expectedEpoch, migrationRunId, migrationManifestDigest, codeArtifact, protocolDigest } = options;
  assertSupportedCutoverNamespace(namespace);
  if (!options.storeKey || typeof options.storeKey !== "string" && !Buffer.isBuffer(options.storeKey) && !(options.storeKey instanceof Uint8Array)) {
    throw new CutoverFenceError("storeKey is REQUIRED for activateMigrationInTransaction");
  }
  const control = await readCutoverFenceInTransaction(transaction, db, namespace);
  const FieldPath = options.FieldPath;
  if (!FieldPath || typeof FieldPath.documentId !== "function") {
    throw new CutoverFenceError("FieldPath with documentId() is REQUIRED for activateMigrationInTransaction");
  }
  const docIdField = FieldPath.documentId();
  if (control.state === "v3_active") {
    if (control.epoch !== expectedEpoch) {
      throw new CutoverFenceError(`Activation epoch mismatch: expected ${expectedEpoch}, got ${control.epoch}`);
    }
    if (control.migrationRunId !== migrationRunId) {
      throw new CutoverFenceError(
        `Already active control migrationRunId mismatch: expected ${migrationRunId}, got ${control.migrationRunId}`
      );
    }
    if (control.migrationManifestDigest !== migrationManifestDigest) {
      throw new CutoverFenceError(
        `Already active control migrationManifestDigest mismatch: expected ${migrationManifestDigest}, got ${control.migrationManifestDigest}`
      );
    }
    if (control.codeArtifact !== codeArtifact) {
      throw new CutoverFenceError(
        `Already active control codeArtifact mismatch: expected ${codeArtifact}, got ${control.codeArtifact}`
      );
    }
    const markerRef2 = db.collection(`${namespace}_meta`).doc("v2_adopted");
    const markerSnap2 = await transaction.get(markerRef2);
    if (!markerSnap2.exists) {
      throw new CutoverFenceError("Already active but immutable migration marker is missing at v2_adopted");
    }
    const m2 = markerSnap2.data();
    validateMapKeysExact(m2, REQUIRED_OWNERSHIP_MARKER_KEYS, "ownership marker");
    validateMigrationIdentityFields(m2, namespace, expectedEpoch, migrationRunId);
    if (m2.kind !== "ownership") {
      throw new CutoverFenceError(`Already active marker kind must be 'ownership', got '${m2.kind}'`);
    }
    if (m2.codeArtifact !== codeArtifact || m2.protocolDigest !== protocolDigest || m2.migrationManifestDigest !== migrationManifestDigest) {
      throw new CutoverFenceError("Already active immutable marker evidence mismatch");
    }
    const finalRef2 = db.collection(`${namespace}_meta`).doc(`migration_manifest_${expectedEpoch}`);
    const finalSnap2 = await transaction.get(finalRef2);
    if (!finalSnap2.exists) {
      throw new CutoverFenceError(`Already active but immutable final manifest missing at migration_manifest_${expectedEpoch}`);
    }
    const f2 = finalSnap2.data();
    validateMapKeysExact(f2, REQUIRED_FINAL_MANIFEST_KEYS, "final manifest");
    validateMigrationIdentityFields(f2, namespace, expectedEpoch, migrationRunId);
    if (f2.kind !== "final") {
      throw new CutoverFenceError(`Already active final manifest kind must be 'final', got '${f2.kind}'`);
    }
    if (f2.codeArtifact !== codeArtifact || f2.protocolDigest !== protocolDigest || D("final", namespace, expectedEpoch, f2) !== migrationManifestDigest) {
      throw new CutoverFenceError("Already active immutable final manifest evidence mismatch");
    }
    const prepRef2 = db.collection(`${namespace}_meta`).doc(`migration_prepared_${expectedEpoch}`);
    const prepSnap2 = await transaction.get(prepRef2);
    if (!prepSnap2.exists) {
      throw new CutoverFenceError(`Already active but immutable prepared manifest missing at migration_prepared_${expectedEpoch}`);
    }
    const p2 = prepSnap2.data();
    validateMapKeysExact(p2, p2.totalPhysicalRecords > 0 ? [...REQUIRED_PREPARED_MANIFEST_KEYS, ...NONEMPTY_PROJECTOR_KEYS] : REQUIRED_PREPARED_MANIFEST_KEYS, "prepared manifest");
    validateMigrationIdentityFields(p2, namespace, expectedEpoch, migrationRunId);
    if (p2.kind !== "prepared") {
      throw new CutoverFenceError(`Already active prep manifest kind must be 'prepared', got '${p2.kind}'`);
    }
    for (const k of REQUIRED_IDENTITY_KEYS) {
      if (f2[k] !== p2[k] || m2[k] !== p2[k]) {
        throw new CutoverFenceError(`Already active identity field '${k}' mismatch across prepared, final, and marker manifests`);
      }
    }
    const preparedDigest = D("prepared", namespace, expectedEpoch, p2);
    if (m2.preparedDigest !== preparedDigest || f2.preparedDigest !== preparedDigest || typeof m2.emptyNamespace !== "boolean" || !Number.isSafeInteger(p2.totalPhysicalRecords) || p2.totalPhysicalRecords < 0 || f2.totalPhysicalRecords !== p2.totalPhysicalRecords || m2.emptyNamespace !== (p2.totalPhysicalRecords === 0)) {
      throw new CutoverFenceError("Already active historical ownership evidence mismatch");
    }
    validatePlanSpec(p2.planSpec, p2, namespace, expectedEpoch, migrationRunId);
    const computedPlanDigest2 = computePlanDigest(namespace, expectedEpoch, p2.planSpec);
    if (p2.planDigest !== computedPlanDigest2) {
      throw new CutoverFenceError(`Already active prep manifest planDigest mismatch: expected ${computedPlanDigest2}, got ${p2.planDigest}`);
    }
    const receiptsCol2 = db.collection(`${namespace}_meta`);
    const lowerBound2 = `migration_receipt_${expectedEpoch}_`;
    const upperBound2 = `migration_receipt_${expectedEpoch}\``;
    const receiptsSnap2 = await transaction.get(receiptsCol2.orderBy(docIdField).startAt(lowerBound2).endBefore(upperBound2));
    if (receiptsSnap2.size !== p2.scanned) {
      throw new CutoverFenceError(`Already active receipts count (${receiptsSnap2.size}) does not equal scanned count (${p2.scanned})`);
    }
    const receipts = receiptsSnap2.docs.map((d) => {
      const data = d.data();
      validateReceipt(data, namespace, expectedEpoch, migrationRunId);
      return data;
    });
    if (computeReceiptSetDigest(receipts, namespace, expectedEpoch) !== f2.receiptSetDigest) {
      throw new CutoverFenceError("Already active immutable receiptSetDigest mismatch");
    }
    return { status: "already_active", control, planDigest: p2.planDigest, marker: m2 };
  }
  const markerRef = db.collection(`${namespace}_meta`).doc("v2_adopted");
  const markerSnap = await transaction.get(markerRef);
  if (!markerSnap.exists) {
    throw new CutoverFenceError(`Cannot activate: marker missing at ${namespace}_meta/v2_adopted`);
  }
  const m = markerSnap.data();
  validateMapKeysExact(m, REQUIRED_OWNERSHIP_MARKER_KEYS, "ownership marker");
  validateMigrationIdentityFields(m, namespace, expectedEpoch, migrationRunId);
  if (m.kind !== "ownership") {
    throw new CutoverFenceError(`marker kind must be 'ownership', got '${m.kind}'`);
  }
  if (m.codeArtifact !== codeArtifact) {
    throw new CutoverFenceError(`Cannot activate: marker codeArtifact mismatch: expected ${codeArtifact}, got ${m.codeArtifact}`);
  }
  if (m.protocolDigest !== protocolDigest) {
    throw new CutoverFenceError(`Cannot activate: marker protocolDigest mismatch: expected ${protocolDigest}, got ${m.protocolDigest}`);
  }
  if (m.migrationManifestDigest !== migrationManifestDigest) {
    throw new CutoverFenceError("Cannot activate: marker migrationManifestDigest mismatch");
  }
  const finalRef = db.collection(`${namespace}_meta`).doc(`migration_manifest_${expectedEpoch}`);
  const finalSnap = await transaction.get(finalRef);
  if (!finalSnap.exists) {
    throw new CutoverFenceError(`Cannot activate: final manifest missing at ${namespace}_meta/migration_manifest_${expectedEpoch}`);
  }
  const f = finalSnap.data();
  validateMapKeysExact(f, REQUIRED_FINAL_MANIFEST_KEYS, "final manifest");
  validateMigrationIdentityFields(f, namespace, expectedEpoch, migrationRunId);
  if (f.kind !== "final") {
    throw new CutoverFenceError(`Final manifest kind must be 'final', got '${f.kind}'`);
  }
  if (f.codeArtifact !== codeArtifact || f.protocolDigest !== protocolDigest) {
    throw new CutoverFenceError("Cannot activate: final manifest codeArtifact or protocolDigest mismatch");
  }
  const computedFinalDigest = D("final", namespace, expectedEpoch, f);
  if (computedFinalDigest !== migrationManifestDigest) {
    throw new CutoverFenceError(
      `Cannot activate: computed final digest (${computedFinalDigest}) does not match expected (${migrationManifestDigest})`
    );
  }
  const prepRef = db.collection(`${namespace}_meta`).doc(`migration_prepared_${expectedEpoch}`);
  const prepSnap = await transaction.get(prepRef);
  if (!prepSnap.exists) {
    throw new CutoverFenceError(`Cannot activate: prepared manifest missing at ${namespace}_meta/migration_prepared_${expectedEpoch}`);
  }
  const p = prepSnap.data();
  validateMapKeysExact(p, p.totalPhysicalRecords > 0 ? [...REQUIRED_PREPARED_MANIFEST_KEYS, ...NONEMPTY_PROJECTOR_KEYS] : REQUIRED_PREPARED_MANIFEST_KEYS, "prepared manifest");
  validateMigrationIdentityFields(p, namespace, expectedEpoch, migrationRunId);
  if (p.kind !== "prepared") {
    throw new CutoverFenceError(`Prepared manifest kind must be 'prepared', got '${p.kind}'`);
  }
  const computedPrepDigest = D("prepared", namespace, expectedEpoch, p);
  if (computedPrepDigest !== f.preparedDigest) {
    throw new CutoverFenceError("Cannot activate: prepared digest does not match final manifest preparedDigest");
  }
  for (const k of REQUIRED_IDENTITY_KEYS) {
    if (f[k] !== p[k] || m[k] !== p[k]) {
      throw new CutoverFenceError(`Cannot activate: identity field '${k}' mismatch across prepared, final, and marker manifests`);
    }
  }
  validatePlanSpec(p.planSpec, p, namespace, expectedEpoch, migrationRunId);
  const computedPlanDigest = computePlanDigest(namespace, expectedEpoch, p.planSpec);
  if (p.planDigest !== computedPlanDigest) {
    throw new CutoverFenceError(`Cannot activate: prepared manifest planDigest mismatch: expected ${computedPlanDigest}, got ${p.planDigest}`);
  }
  const receiptsCol = db.collection(`${namespace}_meta`);
  const lowerBound = `migration_receipt_${expectedEpoch}_`;
  const upperBound = `migration_receipt_${expectedEpoch}\``;
  const receiptsQuery = receiptsCol.orderBy(docIdField).startAt(lowerBound).endBefore(upperBound);
  const receiptsSnap = await transaction.get(receiptsQuery);
  if (receiptsSnap.size !== p.scanned) {
    throw new CutoverFenceError(
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
    throw new CutoverFenceError(
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
          if (isTargetFormatRow(physicalName, d.data())) {
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
          throw new CutoverFenceError(`Document ID mismatch in ${colKey}: stored id does not match document key`);
        }
      } else {
        if (typeof data.client_id === "string" && data.client_id !== d.id) {
          throw new CutoverFenceError(`client_id mismatch in ${colKey}: stored client_id does not match document key`);
        }
      }
      const targetId = computeKeyedDocId(options.storeKey, "target-id", namespace, expectedEpoch, colKey, d.id);
      const recDigest = computeTargetRecordDigest(options.storeKey, namespace, expectedEpoch, colKey, targetId, data);
      currentTargetKeyedMap.set(`${colKey}:${targetId}`, { doc: d, rawId: d.id, recordDigest: recDigest, data });
    }
  }
  const expectedWrittenTargets = /* @__PURE__ */ new Set();
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
  for (const targetKey of currentTargetKeyedMap.keys()) {
    if (!expectedWrittenTargets.has(targetKey)) {
      throw new CutoverFenceError(`Cannot activate: extra target document '${targetKey}' found in Firestore`);
    }
  }
  for (const k of TARGET_COUNT_KEYS) {
    const actualCount = targetDocsByKey.get(k).length;
    if (actualCount !== f.targetCounts[k]) {
      throw new CutoverFenceError(
        `Cannot activate: target count mismatch for '${k}': Firestore has ${actualCount}, finalDoc has ${f.targetCounts[k]}`
      );
    }
  }
  if (f.errors !== 0) {
    throw new CutoverFenceError("Cannot activate: final manifest errors must be 0");
  }
  for (const [rK, rV] of Object.entries(f.reasons)) {
    if (rV !== 0) {
      throw new CutoverFenceError(`Cannot activate: final manifest reason '${rK}' must be 0, got ${rV}`);
    }
  }
  if (f.sourceLogicalDigest !== f.targetLogicalDigest) {
    throw new CutoverFenceError("Cannot activate: sourceLogicalDigest must equal targetLogicalDigest");
  }
  if (C(f.targetCounts) !== C(p.expectedTargetCounts)) {
    throw new CutoverFenceError("Cannot activate: final targetCounts must match prepared expectedTargetCounts");
  }
  if (control.state !== "v3_ready") {
    throw new CutoverFenceError(`Cannot activate migration: state must be 'v3_ready', got '${control.state}'`);
  }
  if (control.activeOperations !== 0) {
    throw new CutoverFenceError(`Cannot activate migration: activeOperations must be 0, got ${control.activeOperations}`);
  }
  if (control.emptyNamespace !== true && !control.irreversible) {
    throw new CutoverFenceError("Cannot activate migration: irreversible latch must be true for non-empty namespace");
  }
  if (control.epoch !== expectedEpoch) {
    throw new CutoverFenceError(`Activation epoch mismatch: expected ${expectedEpoch}, got ${control.epoch}`);
  }
  if (control.migrationRunId !== migrationRunId) {
    throw new CutoverFenceError(`Activation runId mismatch: expected ${migrationRunId}, got ${control.migrationRunId}`);
  }
  if (control.migrationManifestDigest !== migrationManifestDigest) {
    throw new CutoverFenceError(
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
  return { status: "activated", control: updatedControl, planDigest: p.planDigest };
}
__name(activateMigrationInTransaction, "activateMigrationInTransaction");
async function verifyActiveMigrationInTransaction(transaction, db, options) {
  if (!options || !isMonotonicTimer(options.timer)) {
    throw new CutoverFenceError("Active ownership verification requires a callback-entry timer");
  }
  const {
    namespace,
    expectedEpoch,
    migrationRunId,
    migrationManifestDigest,
    codeSha,
    codeArtifact,
    packageIntegrity,
    protocolDigest,
    timer
  } = options;
  if (typeof codeSha !== "string" || !/^[0-9a-f]{40}$/.test(codeSha) || typeof packageIntegrity !== "string" || !packageIntegrity || typeof migrationManifestDigest !== "string" || !/^[0-9a-f]{64}$/.test(migrationManifestDigest)) {
    throw new CutoverFenceError("Active ownership verification requires approved identity and digest");
  }
  const control = await readCutoverFenceInTransaction(transaction, db, namespace);
  if (control.state !== "v3_active") {
    throw new CutoverRefusedError("Active ownership verification requires v3_active", {
      cutoverState: control.state,
      epoch: control.epoch
    });
  }
  const result = await activateMigrationInTransaction(transaction, db, options);
  if (result.status !== "already_active" || !result.marker || result.marker.codeSha !== codeSha || result.marker.packageIntegrity !== packageIntegrity || result.marker.codeArtifact !== codeArtifact || result.marker.protocolDigest !== protocolDigest || result.marker.migrationRunId !== migrationRunId || result.marker.epoch !== expectedEpoch || result.marker.migrationManifestDigest !== migrationManifestDigest) {
    throw new CutoverFenceError("Active ownership evidence does not match approved identity");
  }
  timer.assertUnderDeadline("active ownership verification before return");
  return { status: "active", emptyNamespace: result.marker.emptyNamespace, planDigest: result.planDigest };
}
__name(verifyActiveMigrationInTransaction, "verifyActiveMigrationInTransaction");
function bundledCodec(storeKey) {
  if (!storeKey) throw new CutoverFenceError("Store key is required for the bundled codec");
  return createCodec(storeKey);
}
__name(bundledCodec, "bundledCodec");
function getCutoverCollectionRegistry(namespace) {
  assertSupportedCutoverNamespace(namespace);
  const names = getCutoverDistinctCollectionNames(namespace);
  const all = [`${namespace}_meta`, ...Object.values(names.source), ...Object.values(names.target)];
  return Object.freeze({
    namespace,
    meta: `${namespace}_meta`,
    controlDocument: "cutover_fence",
    operationsGroup: CUTOVER_OPERATIONS_GROUP,
    source: Object.freeze({ ...names.source }),
    target: Object.freeze({ ...names.target }),
    collections: Object.freeze([...new Set(all)].sort())
  });
}
__name(getCutoverCollectionRegistry, "getCutoverCollectionRegistry");
var CUTOVER_OPERATIONS_GROUP = "operations";
var PLAN_OPERATION_ACTIONS = Object.freeze(["delete", "replace", "retain"]);
function validateCompleteMigrationPlanForIdentity(plan, expected) {
  validateCompleteMigrationPlan(plan);
  if (!expected || typeof expected !== "object") {
    throw new CutoverFenceError("Expected migration identity is required");
  }
  const ns = expected.namespace;
  assertSupportedCutoverNamespace(ns);
  if (!Number.isSafeInteger(expected.epoch) || expected.epoch < 1) {
    throw new CutoverFenceError("Expected epoch must be a positive safe integer");
  }
  if (expected.encoderVersion !== 1) {
    throw new CutoverFenceError("Expected encoderVersion must be 1");
  }
  for (const k of ["assemblyDigest", "indexSchemaDigest", "protocolDigest"]) {
    if (typeof expected[k] !== "string" || !/^[0-9a-f]{64}$/.test(expected[k])) {
      throw new CutoverFenceError(`Expected ${k} must be 64 lowercase hex characters`);
    }
  }
  const prep = plan.prepared;
  validateMigrationIdentityFields(prep, ns, expected.epoch, expected.migrationRunId);
  for (const k of ["codeSha", "codeArtifact", "packageIntegrity", "protocolDigest", "assemblyDigest", "indexSchemaDigest", "encoderVersion"]) {
    if (prep[k] !== expected[k]) {
      throw new CutoverFenceError(`Prepared manifest identity '${k}' does not match the approved value`);
    }
  }
  const registry = getCutoverCollectionRegistry(ns);
  const pairKey = /* @__PURE__ */ __name((c, id) => `${c}\0${id}`, "pairKey");
  const candidates = /* @__PURE__ */ new Map();
  for (const c of prep.candidateCommitments) {
    if (candidates.has(c.id)) throw new CutoverFenceError(`Duplicate prepared candidate '${c.id}'`);
    for (const s of c.sources) {
      if (!(s.collection in registry.source)) {
        throw new CutoverFenceError(`Candidate '${c.id}' source key '${s.collection}' is outside the registry`);
      }
    }
    for (const t of c.targets) {
      if (!(t.collection in registry.target)) {
        throw new CutoverFenceError(`Candidate '${c.id}' target key '${t.collection}' is outside the registry`);
      }
    }
    candidates.set(c.id, c);
  }
  const covered = /* @__PURE__ */ new Set();
  validatePlanSpec(prep.planSpec, prep, ns, expected.epoch, expected.migrationRunId);
  const specifications = new Map(prep.planSpec.candidates.map((entry) => [entry.candidateId, entry]));
  for (const item of plan.items) {
    const c = candidates.get(item.candidateId);
    if (!c) throw new CutoverFenceError(`Plan item '${item.candidateId}' has no prepared candidate`);
    if (covered.has(item.candidateId)) throw new CutoverFenceError(`Duplicate plan item for '${item.candidateId}'`);
    covered.add(item.candidateId);
    const wantSources = c.sources.map((src) => pairKey(src.collection, src.id));
    const gotSources = item.sourceReferences.map((r) => pairKey(r.collection, r.id));
    if (JSON.stringify(wantSources) !== JSON.stringify(gotSources)) {
      throw new CutoverFenceError(`Plan item '${item.candidateId}' source references do not match the candidate`);
    }
    const wantTargets = c.targets.map((tgt) => pairKey(tgt.collection, tgt.id));
    const gotTargets = item.targetReferences.map((r) => pairKey(r.collection, r.id));
    if (JSON.stringify(wantTargets) !== JSON.stringify(gotTargets)) {
      throw new CutoverFenceError(`Plan item '${item.candidateId}' target references do not match the candidate`);
    }
    const actionKeys = item.sourceActions.map((a) => {
      if (!a || !PLAN_OPERATION_ACTIONS.includes(a.action)) {
        throw new CutoverFenceError(`Plan item '${item.candidateId}' has an unsupported source action`);
      }
      return pairKey(a.collection, a.id);
    });
    if (new Set(actionKeys).size !== actionKeys.length) {
      throw new CutoverFenceError(`Plan item '${item.candidateId}' repeats a source action`);
    }
    const refKeys = new Set(gotSources);
    if (actionKeys.length !== refKeys.size || !actionKeys.every((k) => refKeys.has(k))) {
      throw new CutoverFenceError(`Plan item '${item.candidateId}' source actions are not exactly the source references`);
    }
    const specification = specifications.get(item.candidateId);
    if (!specification || C(specification.sourceActions) !== C(item.sourceActions)) {
      throw new CutoverFenceError(`Plan item '${item.candidateId}' source actions do not match its prepared specification`);
    }
  }
  if (covered.size !== candidates.size) {
    throw new CutoverFenceError(`Plan covers ${covered.size} of ${candidates.size} prepared candidates`);
  }
  return { candidates: candidates.size, registryCollections: registry.collections.length };
}
__name(validateCompleteMigrationPlanForIdentity, "validateCompleteMigrationPlanForIdentity");
var RUNTIME_ONLY_SUFFIXES = Object.freeze(["usage"]);
var GOVERNANCE_PWMCP_COLLECTIONS = Object.freeze([
  "pwmcp_seats",
  "pwmcp_seat_keys",
  "pwmcp_policies",
  "pwmcp_audit",
  "pwmcp_pending_actions",
  "pwmcp_fax_links",
  "pwmcp_fax_accounts",
  "pwmcp_billing_links",
  "pwmcp_link_tickets",
  "pwmcp_texting_links",
  "pwmcp_texting_bindings",
  "pwmcp_port_links",
  "pwmcp_port_site_claims",
  "pwmcp_port_order_ownerships",
  "pwmcp_login_links",
  "pwmcp_omni_requests",
  "pwmcp_seat_cleanup",
  "pwmcp_seat_cleanup_state"
]);
var SIBLING_WRITERS = Object.freeze([
  {
    file: "packages/mcp-governance/src/stores/seat-store.ts",
    collection: "pwmcp_tokens",
    mode: "batch.delete",
    migrated: true,
    note: "seat revocation deletes migrated token rows directly; must route through the canonical guard"
  },
  {
    file: "packages/mcp-governance/src/stores/seat-store.ts",
    collection: "pwmcp_tokens",
    mode: "scanSeatCredentials then transaction.delete of access, refresh, family and upstream refs",
    migrated: true,
    note: "seat revocation deletes migrated credential refs inside the admitted or pre-fence transaction. Bound at PR2457 5c8a9f3d8 (source evidence, no runtime proof): pwmcp_tokens, pwmcp_tokens_refresh, pwmcp_tokens_refresh_families, pwmcp_tokens_upstream, all in the pwmcp migration registry"
  },
  {
    file: "packages/mcp-governance/src/stores/seat-store.ts",
    collection: "pwmcp_seat_cleanup_state",
    mode: "drain cursor and bounded-operation state (set and get)",
    migrated: false,
    note: "governance-owned via SERVICE_OWNED_COLLECTIONS.seatCleanupState at consumer b7602f8cb; holds no seat, key or credential rows"
  },
  {
    file: "apps/recording-notice/server/src/firestore-store.ts",
    collection: "rn_usage",
    mode: "set on usage doc ${domain}__${month}",
    migrated: false,
    note: "shares the GCP project (var.project_id) and the default database with the fenced pwmcp namespaces; client has no explicit project or database, and edge-recording-notice sets GOOGLE_CLOUD_PROJECT to var.project_id (recording-notice.tf)"
  },
  {
    file: "packages/mcp-governance/src/stores/seat-store.ts",
    collection: "pwmcp_seat_cleanup",
    mode: "transaction.set; reads and deletes in the revoke path",
    migrated: false,
    note: "consumer cleanup/audit outbox written inside seat revocation; outside the migration census"
  },
  { file: "packages/mcp-governance/src/stores/seat-store.ts", collection: "pwmcp_seat_keys", mode: "create|set|batch.delete", migrated: false, note: "" },
  {
    file: "services/phoneware-mcp/src/http/server.ts",
    collection: "pwmcp_resume_tokens",
    mode: "provider-config",
    migrated: true,
    note: "named as the OAuth provider resume store; writes depend on the provider fence config"
  },
  {
    file: "services/sso/src/links/store.ts",
    collection: "pwmcp_login_links",
    mode: "via @phoneware/mcp-governance FirestoreLoginLinkStore",
    migrated: false,
    note: "SSO sibling writer; policy contention only"
  },
  { file: "apps/lens/proof/services.mjs", collection: "pwmcp_seats", mode: "proof harness", migrated: false, note: "test-data writer; subject to safe-testing rule" }
]);
function getCutoverRuntimeCollectionScope(namespace) {
  assertSupportedCutoverNamespace(namespace);
  const registry = getCutoverCollectionRegistry(namespace);
  const control = [
    { name: `${namespace}_meta`, kind: "collection", role: "meta" },
    // The `operations` collection group is shared across namespaces and voice-studio composites; the policy scope keeps the whole group.
    { name: "operations", path: `${namespace}_meta/cutover_fence/operations`, kind: "collectionGroup", role: "operations", shared: true }
  ];
  const runtime = RUNTIME_ONLY_SUFFIXES.map((s) => ({ name: `${namespace}_${s}`, kind: "collection", role: "runtime" }));
  if (namespace === "pwmcp") {
    for (const n of GOVERNANCE_PWMCP_COLLECTIONS) runtime.push({ name: n, kind: "collection", role: "governance" });
  }
  const migrationNames = new Set(registry.collections);
  const union = [...control, ...runtime, ...registry.collections.map((n) => ({ name: n, kind: "collection", role: "migration" }))];
  const byName = /* @__PURE__ */ new Map();
  for (const e of union) if (!byName.has(e.name)) byName.set(e.name, e);
  return Object.freeze({
    namespace,
    complete: false,
    unscanned: Object.freeze(["sibling services", "terraform", "workflows"]),
    migration: registry.collections,
    control: Object.freeze(control),
    runtime: Object.freeze(runtime),
    union: Object.freeze([...byName.values()].sort((a, b) => a.name.localeCompare(b.name))),
    migrationNames: Object.freeze([...migrationNames].sort()),
    // The one mapping the signed policy is checked against: every union name, once, sorted. Object union stays internal.
    groups: Object.freeze([...new Set(byName.keys())].sort()),
    // Collections whose names could not be resolved to a literal. Empty means every name is literal and known.
    unresolved: Object.freeze([]),
    siblingWriters: SIBLING_WRITERS
  });
}
__name(getCutoverRuntimeCollectionScope, "getCutoverRuntimeCollectionScope");
function assertRuntimeScopeClosed(scope) {
  if (scope.complete !== true || !Array.isArray(scope.unscanned) || scope.unscanned.length !== 0 || !Array.isArray(scope.unresolved) || scope.unresolved.length !== 0) {
    throw new CutoverRefusedError("Runtime collection scope is not closed: the census of unscanned surfaces is incomplete");
  }
}
__name(assertRuntimeScopeClosed, "assertRuntimeScopeClosed");
function assertValidMigrationContext(options) {
  if (!options || typeof options !== "object") {
    throw new CutoverFenceError("MigrationContext must be a non-null object");
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
      throw new CutoverFenceError(`MigrationContext missing required field: ${field}`);
    }
  }
  if (typeof options.db !== "object" || typeof options.db.collection !== "function" || typeof options.db.runTransaction !== "function") {
    throw new CutoverFenceError("MigrationContext db must be a Firestore-like object with collection and runTransaction methods");
  }
  if (typeof options.FieldPath !== "object" && typeof options.FieldPath !== "function" || typeof options.FieldPath.documentId !== "function") {
    throw new CutoverFenceError("MigrationContext FieldPath must be an adapter object or class with documentId() method");
  }
  if (!Buffer.isBuffer(options.key) && !(options.key instanceof Uint8Array)) {
    throw new CutoverFenceError("MigrationContext key must be a Uint8Array or Buffer");
  }
  if (options.key.length < 16) {
    throw new CutoverFenceError("MigrationContext key must be at least 16 bytes");
  }
  assertSupportedCutoverNamespace(options.namespace);
  if (typeof options.expectedEpoch !== "number" || !Number.isInteger(options.expectedEpoch) || options.expectedEpoch < 1) {
    throw new CutoverFenceError("MigrationContext expectedEpoch must be a positive integer");
  }
  if (typeof options.migrationRunId !== "string" || !options.migrationRunId.trim()) {
    throw new CutoverFenceError("MigrationContext migrationRunId must be a non-empty string");
  }
  if (typeof options.codeSha !== "string" || !/^[0-9a-f]{40}$/.test(options.codeSha)) {
    throw new CutoverFenceError("MigrationContext codeSha must be a 40-character lowercase hex string");
  }
  if (typeof options.codeArtifact !== "string" || !options.codeArtifact.trim()) {
    throw new CutoverFenceError("MigrationContext codeArtifact must be a non-empty string");
  }
  if (typeof options.packageIntegrity !== "string" || !options.packageIntegrity.trim()) {
    throw new CutoverFenceError("MigrationContext packageIntegrity must be a non-empty string");
  }
  if (typeof options.protocolDigest !== "string" || !/^[0-9a-f]{64}$/.test(options.protocolDigest)) {
    throw new CutoverFenceError("MigrationContext protocolDigest must be a 64-character lowercase hex string");
  }
}
__name(assertValidMigrationContext, "assertValidMigrationContext");
export {
  ALLOWED_STATE_TRANSITIONS,
  APPROVED_GRAPH_PROJECTOR_ID,
  APPROVED_GRAPH_PROJECTOR_VERSION,
  C,
  CANDIDATE_KIND_TO_CLASSIFICATION,
  CLASSIFICATION_KEYS,
  CUTOVER_OPERATIONS_GROUP,
  CutoverFenceError,
  CutoverRefusedError,
  D,
  F,
  FIRESTORE_MAX_DOCUMENT_SIZE_BYTES,
  FIRESTORE_MAX_FIELD_TRANSFORMS,
  FIRESTORE_MAX_INDEX_BYTES,
  FIRESTORE_MAX_INDEX_ENTRIES,
  FIRESTORE_MAX_NESTING_DEPTH,
  FIRESTORE_MAX_REQUEST_SIZE_BYTES,
  FIRESTORE_TRANSACTION_READ_DEADLINE_MS,
  H,
  NONEMPTY_PROJECTOR_KEYS,
  PHYSICAL_COUNT_KEYS,
  PREFLIGHT_MAX_DOC_BYTES,
  PREFLIGHT_MAX_FIELD_TRANSFORMS,
  PREFLIGHT_MAX_INDEX_BYTES,
  PREFLIGHT_MAX_INDEX_ENTRIES,
  PREFLIGHT_MAX_NESTING_DEPTH,
  PREFLIGHT_MAX_REQUEST_BYTES,
  REASON_KEYS,
  REQUIRED_CANDIDATE_KEYS,
  REQUIRED_FINAL_MANIFEST_KEYS,
  REQUIRED_IDENTITY_KEYS,
  REQUIRED_OWNERSHIP_MARKER_KEYS,
  REQUIRED_PLAN_SPEC_KEYS,
  REQUIRED_PREPARED_MANIFEST_KEYS,
  REQUIRED_RECEIPT_KEYS,
  SUPPORTED_CUTOVER_NAMESPACES,
  TARGET_COUNT_KEYS,
  activateMigrationInTransaction,
  assertPreparedIdentity,
  assertRuntimeScopeClosed,
  assertSubjectRefsPresent,
  assertSupportedCutoverNamespace,
  assertValidMigrationContext,
  canonicalCompare,
  canonicalJsonStringify,
  checkMutationGuardInTransaction,
  checkV3MutationGuardInTransaction,
  claimUpstreamGrantInTransaction,
  computeEstimatedFirestoreDocSize,
  computeKeyedDocId,
  computeLogicalInventoryDigest,
  computeManifestDigest,
  computePlanDigest,
  computeProtocolDigest,
  computeReceiptDigest,
  computeReceiptSetDigest,
  computeSourceInventoryDigest,
  computeSourceRecordDigest,
  computeTargetInventoryDigest,
  computeTargetRecordDigest,
  deriveKey,
  deriveStoreKey,
  finalizeMigrationInTransaction,
  frame,
  getCutoverCollectionRegistry,
  getCutoverDistinctCollectionNames,
  getCutoverFenceDocRef,
  getCutoverFenceRecord,
  getCutoverOperationDocRef,
  getCutoverOperationsColRef,
  getCutoverRuntimeCollectionScope,
  getSourceCollectionAllowlist,
  getTargetCollectionAllowlist,
  initializeCutoverFence,
  isCutoverFenceError,
  isCutoverRefusedError,
  isLegacyMutationPermittedInTransaction,
  isMonotonicTimer,
  isSupportedCutoverNamespace,
  isTargetFormatRow,
  markIrreversibleInTransaction,
  markOperationAmbiguous,
  normalizeValue,
  operationStorageId,
  parseCutoverFenceRecord,
  prepareMigrationInTransaction,
  readCutoverFenceInTransaction,
  reconcileUpstreamGrantInTransaction,
  releaseLegacyOperation,
  rfc8785CanonicalJson,
  sanitizeId2 as sanitizeId,
  startMonotonicTimer,
  transitionCutoverFenceState,
  validateCandidateCommitments,
  validateCompleteMigrationPlan,
  validateCompleteMigrationPlanForIdentity,
  validateMapKeysExact,
  validateMigrationIdentityFields,
  validateMigrationPreflightLimits,
  validateProspectiveDocBudget,
  validateReceipt,
  validateTransactionBudgetPlan,
  verifyActiveMigrationInTransaction,
  verifyIndexManifestDigests,
  withLegacyOperation
};
