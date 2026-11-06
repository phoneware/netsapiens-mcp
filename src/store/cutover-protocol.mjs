var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/cutover/canonical-core.mjs
var canonical_core_exports = {};
__export(canonical_core_exports, {
  ALLOWED_STATE_TRANSITIONS: () => ALLOWED_STATE_TRANSITIONS,
  APPROVED_GRAPH_PROJECTOR_ID: () => APPROVED_GRAPH_PROJECTOR_ID,
  APPROVED_GRAPH_PROJECTOR_VERSION: () => APPROVED_GRAPH_PROJECTOR_VERSION,
  C: () => C,
  CANDIDATE_KIND_TO_CLASSIFICATION: () => CANDIDATE_KIND_TO_CLASSIFICATION,
  CLASSIFICATION_KEYS: () => CLASSIFICATION_KEYS,
  CUTOVER_OPERATIONS_GROUP: () => CUTOVER_OPERATIONS_GROUP,
  CutoverFenceError: () => CutoverFenceError,
  CutoverRefusedError: () => CutoverRefusedError,
  D: () => D,
  F: () => F,
  FIRESTORE_MAX_DOCUMENT_SIZE_BYTES: () => FIRESTORE_MAX_DOCUMENT_SIZE_BYTES,
  FIRESTORE_MAX_FIELD_TRANSFORMS: () => FIRESTORE_MAX_FIELD_TRANSFORMS,
  FIRESTORE_MAX_INDEX_BYTES: () => FIRESTORE_MAX_INDEX_BYTES,
  FIRESTORE_MAX_INDEX_ENTRIES: () => FIRESTORE_MAX_INDEX_ENTRIES,
  FIRESTORE_MAX_NESTING_DEPTH: () => FIRESTORE_MAX_NESTING_DEPTH,
  FIRESTORE_MAX_REQUEST_SIZE_BYTES: () => FIRESTORE_MAX_REQUEST_SIZE_BYTES,
  FIRESTORE_TRANSACTION_READ_DEADLINE_MS: () => FIRESTORE_TRANSACTION_READ_DEADLINE_MS,
  H: () => H,
  NONEMPTY_PROJECTOR_KEYS: () => NONEMPTY_PROJECTOR_KEYS,
  PHYSICAL_COUNT_KEYS: () => PHYSICAL_COUNT_KEYS,
  PREFLIGHT_MAX_DOC_BYTES: () => PREFLIGHT_MAX_DOC_BYTES,
  PREFLIGHT_MAX_FIELD_TRANSFORMS: () => PREFLIGHT_MAX_FIELD_TRANSFORMS,
  PREFLIGHT_MAX_INDEX_BYTES: () => PREFLIGHT_MAX_INDEX_BYTES,
  PREFLIGHT_MAX_INDEX_ENTRIES: () => PREFLIGHT_MAX_INDEX_ENTRIES,
  PREFLIGHT_MAX_NESTING_DEPTH: () => PREFLIGHT_MAX_NESTING_DEPTH,
  PREFLIGHT_MAX_REQUEST_BYTES: () => PREFLIGHT_MAX_REQUEST_BYTES,
  REASON_KEYS: () => REASON_KEYS,
  REQUIRED_CANDIDATE_KEYS: () => REQUIRED_CANDIDATE_KEYS,
  REQUIRED_FINAL_MANIFEST_KEYS: () => REQUIRED_FINAL_MANIFEST_KEYS,
  REQUIRED_IDENTITY_KEYS: () => REQUIRED_IDENTITY_KEYS,
  REQUIRED_OWNERSHIP_MARKER_KEYS: () => REQUIRED_OWNERSHIP_MARKER_KEYS,
  REQUIRED_PLAN_SPEC_KEYS: () => REQUIRED_PLAN_SPEC_KEYS,
  REQUIRED_PREPARED_MANIFEST_KEYS: () => REQUIRED_PREPARED_MANIFEST_KEYS,
  REQUIRED_RECEIPT_KEYS: () => REQUIRED_RECEIPT_KEYS,
  SUPPORTED_CUTOVER_NAMESPACES: () => SUPPORTED_CUTOVER_NAMESPACES,
  TARGET_COUNT_KEYS: () => TARGET_COUNT_KEYS,
  activateMigrationInTransaction: () => activateMigrationInTransaction,
  assertPreparedIdentity: () => assertPreparedIdentity,
  assertRuntimeScopeClosed: () => assertRuntimeScopeClosed,
  assertSubjectRefsPresent: () => assertSubjectRefsPresent,
  assertSupportedCutoverNamespace: () => assertSupportedCutoverNamespace,
  assertValidMigrationContext: () => assertValidMigrationContext,
  canonicalCompare: () => canonicalCompare,
  canonicalJsonStringify: () => canonicalJsonStringify,
  checkMutationGuardInTransaction: () => checkMutationGuardInTransaction,
  checkV3MutationGuardInTransaction: () => checkV3MutationGuardInTransaction,
  claimUpstreamGrantInTransaction: () => claimUpstreamGrantInTransaction,
  computeEstimatedFirestoreDocSize: () => computeEstimatedFirestoreDocSize,
  computeKeyedDocId: () => computeKeyedDocId,
  computeLogicalInventoryDigest: () => computeLogicalInventoryDigest,
  computeManifestDigest: () => computeManifestDigest,
  computePlanDigest: () => computePlanDigest,
  computeProtocolDigest: () => computeProtocolDigest,
  computeReceiptDigest: () => computeReceiptDigest,
  computeReceiptSetDigest: () => computeReceiptSetDigest,
  computeSourceInventoryDigest: () => computeSourceInventoryDigest,
  computeSourceRecordDigest: () => computeSourceRecordDigest,
  computeTargetInventoryDigest: () => computeTargetInventoryDigest,
  computeTargetRecordDigest: () => computeTargetRecordDigest,
  deriveKey: () => deriveKey,
  finalizeMigrationInTransaction: () => finalizeMigrationInTransaction,
  frame: () => frame,
  getCutoverCollectionRegistry: () => getCutoverCollectionRegistry,
  getCutoverDistinctCollectionNames: () => getCutoverDistinctCollectionNames,
  getCutoverFenceDocRef: () => getCutoverFenceDocRef,
  getCutoverFenceRecord: () => getCutoverFenceRecord,
  getCutoverOperationDocRef: () => getCutoverOperationDocRef,
  getCutoverOperationsColRef: () => getCutoverOperationsColRef,
  getCutoverRuntimeCollectionScope: () => getCutoverRuntimeCollectionScope,
  getSourceCollectionAllowlist: () => getSourceCollectionAllowlist,
  getTargetCollectionAllowlist: () => getTargetCollectionAllowlist,
  initializeCutoverFence: () => initializeCutoverFence,
  isCutoverFenceError: () => isCutoverFenceError,
  isCutoverRefusedError: () => isCutoverRefusedError,
  isLegacyMutationPermittedInTransaction: () => isLegacyMutationPermittedInTransaction,
  isMonotonicTimer: () => isMonotonicTimer,
  isSupportedCutoverNamespace: () => isSupportedCutoverNamespace,
  isTargetFormatRow: () => isTargetFormatRow,
  markIrreversibleInTransaction: () => markIrreversibleInTransaction,
  markOperationAmbiguous: () => markOperationAmbiguous,
  normalizeValue: () => normalizeValue,
  operationStorageId: () => operationStorageId,
  parseCutoverFenceRecord: () => parseCutoverFenceRecord,
  prepareMigrationInTransaction: () => prepareMigrationInTransaction,
  readCutoverFenceInTransaction: () => readCutoverFenceInTransaction,
  reconcileUpstreamGrantInTransaction: () => reconcileUpstreamGrantInTransaction,
  releaseLegacyOperation: () => releaseLegacyOperation,
  rfc8785CanonicalJson: () => rfc8785CanonicalJson,
  sanitizeId: () => sanitizeId2,
  startMonotonicTimer: () => startMonotonicTimer,
  transitionCutoverFenceState: () => transitionCutoverFenceState,
  validateCandidateCommitments: () => validateCandidateCommitments,
  validateCompleteMigrationPlan: () => validateCompleteMigrationPlan,
  validateCompleteMigrationPlanForIdentity: () => validateCompleteMigrationPlanForIdentity,
  validateMapKeysExact: () => validateMapKeysExact,
  validateMigrationIdentityFields: () => validateMigrationIdentityFields,
  validateMigrationPreflightLimits: () => validateMigrationPreflightLimits,
  validateProspectiveDocBudget: () => validateProspectiveDocBudget,
  validateReceipt: () => validateReceipt,
  validateTransactionBudgetPlan: () => validateTransactionBudgetPlan,
  verifyActiveMigrationInTransaction: () => verifyActiveMigrationInTransaction,
  verifyIndexManifestDigests: () => verifyIndexManifestDigests,
  withLegacyOperation: () => withLegacyOperation
});

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
  const consumed2 = /* @__PURE__ */ new Set();
  const use = /* @__PURE__ */ __name((role, entry, id) => {
    if (roles.has(role) || consumed2.has(entry)) throw new CutoverFenceError("Duplicate source projection role");
    roles.set(role, projectionEntry(entry, id));
    consumed2.add(entry);
  }, "use");
  if (candidate.kind === "pr56Families" || candidate.kind === "baseFormatTokens") {
    const access = singleEntry(entries, "tokens");
    const accessId = requireCredential(access, aliases(access.data.accessToken, access.data.token?.accessToken));
    use("tokens", access, accessId);
    let family;
    if (candidate.kind === "pr56Families") {
      family = singleEntry(entries, "families");
      const upstream = singleEntry(entries, "upstream");
      if (family.data.id !== void 0 && family.data.id !== family.physicalId || upstream.physicalId !== family.physicalId || access.data.familyId != null && access.data.familyId !== family.physicalId || access.data.refreshFamilyId != null && access.data.refreshFamilyId !== family.physicalId || family.data.currentAccessToken !== accessId) throw new CutoverFenceError("Source family identity mismatch");
      use("families", family, family.physicalId);
      use("upstream", upstream, upstream.physicalId);
    }
    const activeId = family ? family.data.currentRefreshToken : aliases(access.data.refreshToken, access.data.token?.refreshToken);
    if (typeof activeId !== "string" || !activeId) throw new CutoverFenceError("Source refresh credential is missing");
    const previousId = family?.data.previousRefreshToken;
    if (previousId != null && (typeof previousId !== "string" || !previousId || previousId === activeId)) {
      throw new CutoverFenceError("Source previous refresh identity is invalid");
    }
    for (const entry of entriesFor(entries, "refresh")) {
      const linkedAccess = entry.data.accessToken;
      const fromAccess = linkedAccess === accessId ? aliases(access.data.refreshToken, access.data.token?.refreshToken) : void 0;
      const raw = requireCredential(entry, aliases(entry.data.refreshToken, entry.data.token?.refreshToken) ?? fromAccess);
      if (family && entry.data.familyId !== family.physicalId) throw new CutoverFenceError("Source refresh family mismatch");
      if (raw === activeId && entry.data.status === "active") use("refresh", entry, raw);
      else if (family && raw === previousId && entry.data.status === "consumed" && Number.isSafeInteger(entry.data.consumedAt)) use("prevRefresh", entry, raw);
      else throw new CutoverFenceError("Source refresh role or status mismatch");
    }
    if (family && (!roles.has("refresh") || !!previousId !== roles.has("prevRefresh"))) throw new CutoverFenceError("Source refresh role is missing");
    if (!family && entriesFor(entries, "refresh").length > 1) throw new CutoverFenceError("Duplicate base refresh pointer");
  } else if (candidate.kind === "clients") {
    const clients = entries.filter((entry) => entry.collection === "clients" || entry.collection === "oauthClients");
    if (clients.length < 1 || clients.length > 2 || new Set(clients.map((entry) => entry.collection)).size !== clients.length) throw new CutoverFenceError("Invalid client source cardinality");
    for (const entry of clients) {
      if (entry.physicalId !== clients[0].physicalId || entry.data.client_id !== void 0 && entry.data.client_id !== entry.physicalId) throw new CutoverFenceError("Source client identity mismatch");
    }
    const projected = clients.map((entry) => projectSourceLogical(candidate, /* @__PURE__ */ new Map([["clients", projectionEntry(entry, entry.physicalId)]]), codec, null));
    if (projected.length === 2 && JSON.stringify(projected[0]) !== JSON.stringify(projected[1])) throw new CutoverFenceError("Conflicting client logical projections");
    const selected = clients.find((entry) => entry.collection === "oauthClients") ?? clients[0];
    roles.set("clients", projectionEntry(selected, selected.physicalId));
    for (const entry of clients) consumed2.add(entry);
  } else {
    const collection = candidate.kind === "authCodes" ? "authCodes" : candidate.kind === "resumeTokens" ? "resumeTokens" : null;
    if (!collection) throw new CutoverFenceError("Unsupported source projection kind");
    const entry = singleEntry(entries, collection);
    const raw = collection === "authCodes" ? aliases(entry.data.code, entry.data.rawCode) : aliases(entry.data.token, entry.data.resumeToken);
    if (raw !== void 0 && raw !== entry.physicalId) throw new CutoverFenceError("Source document identity mismatch");
    use(collection, entry, entry.physicalId);
  }
  if (consumed2.size !== entries.length) throw new CutoverFenceError("Unexpected source projection entry");
  return roles;
}
__name(buildSourceProjectionMap, "buildSourceProjectionMap");
function buildTargetProjectionMap(candidate, entries) {
  assertEntrySet(entries);
  const roles = /* @__PURE__ */ new Map();
  const consumed2 = /* @__PURE__ */ new Set();
  const use = /* @__PURE__ */ __name((role, entry) => {
    if (roles.has(role) || consumed2.has(entry)) throw new CutoverFenceError("Duplicate target projection role");
    if (entry.data.id !== void 0 && entry.data.id !== entry.physicalId) throw new CutoverFenceError("Target document identity mismatch");
    roles.set(role, projectionEntry(entry, entry.physicalId));
    consumed2.add(entry);
  }, "use");
  if (candidate.kind === "pr56Families" || candidate.kind === "baseFormatTokens") {
    const family = singleEntry(entries, "families");
    const access = singleEntry(entries, "tokens");
    const upstream = singleEntry(entries, "upstream");
    if (upstream.physicalId !== family.physicalId || access.physicalId !== family.data.currentAccessTokenId || access.data.familyId !== family.physicalId) throw new CutoverFenceError("Target family identity mismatch");
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
    for (const entry of retired) {
      if (entry.data.familyId !== family.physicalId || entry.data.id !== void 0 && entry.data.id !== entry.physicalId || entry.data.retiredAt !== void 0 && (!Number.isSafeInteger(entry.data.retiredAt) || entry.data.retiredAt <= 0)) {
        throw new CutoverFenceError("Target retired refresh identity mismatch");
      }
      consumed2.add(entry);
    }
    if (retired.length) roles.set("retiredRefresh", { ids: retired.map((entry) => entry.physicalId).sort(codeUnitCompare) });
  } else {
    const collection = candidate.kind === "clients" ? "oauthClients" : candidate.kind === "authCodes" ? "authCodes" : candidate.kind === "resumeTokens" ? "resumeTokens" : null;
    if (!collection) throw new CutoverFenceError("Unsupported target projection kind");
    const entry = singleEntry(entries, collection);
    if (collection === "oauthClients" && entry.data.client_id !== entry.physicalId) throw new CutoverFenceError("Target client identity mismatch");
    use(collection === "oauthClients" ? "clients" : collection, entry);
  }
  if (consumed2.size !== entries.length) throw new CutoverFenceError("Unexpected target projection entry");
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
    const accessToken = tokDoc.accessToken;
    const refreshToken = tokDoc.refreshToken;
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
    const legacyPayload = data.code !== void 0 || data.rawCode !== void 0 || data.clientId !== void 0 || data.redirectUri !== void 0 || data.pending !== void 0 || data.nsTokens !== void 0;
    const isSource = !isTarget && (legacyPayload || data.expiresAt !== void 0);
    if (isTarget && legacyPayload) throw new CutoverFenceError(`Ambiguous auth_codes document format in '${collection}'`);
    if (isTarget && !isSource) return true;
    if (isSource && !isTarget) return false;
    throw new CutoverFenceError(`Ambiguous auth_codes document format in '${collection}'`);
  }
  if (collection.endsWith("_resume_tokens")) {
    const isTarget = data.v === 2 && data._mcp_format === "v3_target";
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
    const expectedByKey = new Map(expectedTargets.map((ref) => [`${ref.collection}:${ref.id}`, ref]));
    if (expectedByKey.size !== expectedTargets.length) throw new CutoverFenceError("Projected target identity is duplicated");
    const prospective = item.targetReferences.map((ref, index) => {
      const key = `${ref.collection}:${ref.id}`;
      const identity = expectedByKey.get(key);
      if (!identity) throw new CutoverFenceError("Prospective target does not match its projected identity");
      expectedByKey.delete(key);
      return { collection: identity.collection, physicalId: identity.physicalId, data: item.prospectiveTargetPostimages[index] };
    });
    if (expectedByKey.size) throw new CutoverFenceError("Prospective target set is incomplete");
    const prospectiveProjection = projectTargetLogical(cand, buildTargetProjectionMap(cand, prospective), codec);
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
    validateMapKeysExact(p2, REQUIRED_PREPARED_MANIFEST_KEYS, "prepared manifest");
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
  validateMapKeysExact(p, REQUIRED_PREPARED_MANIFEST_KEYS, "prepared manifest");
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
function encodeRefreshFamiliesRow(codec, familyId, generation, activeRefreshId, currentAccessTokenId, session, retiredFingerprints, status, now, subjectRefs) {
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
    ...subjectRefs && status === "active" ? { subjectRefs } : {},
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
    ...upstream.nsExpiresAt === void 0 ? {} : { nsExpiresAt: upstream.nsExpiresAt },
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
  const used = typeof data.used === "boolean" ? data.used : false;
  const sealed = codec.seal({ ...data, used }, `code:${id}`);
  return {
    id,
    expiresAt,
    ttlAt: new Date(expiresAt),
    sealed,
    used,
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

// src/store/protected-binding.ts
import { createHash as createHash3 } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
var CREDENTIAL_PATH = "/run/cutover/oidc.jwt";
var MAX_CREDENTIAL_BYTES = 64 * 1024;
var bindings = /* @__PURE__ */ new WeakMap();
var consumed = /* @__PURE__ */ new WeakSet();
function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value) && !ArrayBuffer.isView(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
__name(deepFreeze, "deepFreeze");
function bindProtectedContext(db, binding) {
  if (bindings.has(db)) {
    throw new CutoverFenceError("Protected migration database handle is already bound");
  }
  const privateKey = Uint8Array.from(binding.key);
  const stored = { ...binding, get key() {
    return Uint8Array.from(privateKey);
  } };
  bindings.set(db, deepFreeze(stored));
}
__name(bindProtectedContext, "bindProtectedContext");
function assertCredentialUnchanged(db) {
  const binding = bindings.get(db);
  if (!binding) throw new CutoverRefusedError("Protected migration context required: database handle is not bound");
  if (binding.credentialDigest === null) return;
  const stat = lstatSync(CREDENTIAL_PATH);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CREDENTIAL_BYTES) {
    throw new CutoverRefusedError("Credential token file is not a bounded regular file");
  }
  const digest = createHash3("sha256").update(readFileSync(CREDENTIAL_PATH)).digest("hex");
  if (digest !== binding.credentialDigest) {
    throw new CutoverRefusedError("Credential token bytes changed since the authenticated exchange");
  }
}
__name(assertCredentialUnchanged, "assertCredentialUnchanged");
function assertProtectedContext(context, request) {
  const binding = bindings.get(context.db);
  if (!binding) {
    throw new CutoverRefusedError("Protected migration context required: database handle is not bound");
  }
  if (consumed.has(context.db)) {
    throw new CutoverRefusedError("Protected migration database handle was already used for an operation");
  }
  if (binding.authorized.operation !== request.operation) {
    throw new CutoverRefusedError("Protected migration operation is not the authorized operation");
  }
  if (canonicalJson(request.options) !== canonicalJson(binding.authorized.options)) {
    throw new CutoverRefusedError("Protected migration options do not match the authorized options");
  }
  const mismatch = binding.namespace !== context.namespace || binding.expectedEpoch !== context.expectedEpoch || binding.migrationRunId !== context.migrationRunId || binding.codeSha !== context.codeSha || binding.codeArtifact !== context.codeArtifact || binding.packageIntegrity !== context.packageIntegrity || binding.protocolDigest !== context.protocolDigest || binding.FieldPath !== context.FieldPath || !Buffer.from(context.key).equals(Buffer.from(binding.key));
  if (mismatch) {
    throw new CutoverRefusedError("Protected migration context does not match the authenticated binding");
  }
  assertCredentialUnchanged(context.db);
  consumed.add(context.db);
  return binding;
}
__name(assertProtectedContext, "assertProtectedContext");
function getProtectedBinding(db) {
  return bindings.get(db);
}
__name(getProtectedBinding, "getProtectedBinding");

// src/store/index-coverage.ts
var SIMPLE_SEGMENT = /^[_A-Za-z][_A-Za-z0-9]*$/;
var INDEX_ENTRY_BUDGET = Math.floor(4e4 * 0.8);
var INDEX_BYTE_BUDGET = Math.floor(8 * 1024 * 1024 * 0.8);
var DOCUMENT_BYTE_BUDGET = Math.floor(1024 * 1024 * 0.8);
var DOCUMENT_DEPTH_BUDGET = Math.floor(20 * 0.8);
function isPlainObject(value) {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}
__name(isPlainObject, "isPlainObject");
function isLeaf(value) {
  return value === null || typeof value === "string" || typeof value === "number" && Number.isFinite(value) || typeof value === "boolean" || value instanceof Date || value instanceof Uint8Array;
}
__name(isLeaf, "isLeaf");
function concreteFieldPaths(document) {
  if (!isPlainObject(document)) throw new CutoverRefusedError("Concrete coverage requires a plain document object");
  const multiplicity = /* @__PURE__ */ new Map();
  let maxDepth = 0;
  const visit = /* @__PURE__ */ __name((value, path, mult, depth) => {
    if (value === void 0) return;
    if (path !== "") {
      multiplicity.set(path, Math.max(multiplicity.get(path) ?? 0, mult));
      maxDepth = Math.max(maxDepth, depth);
    }
    if (Array.isArray(value)) {
      const childMult = mult * Math.max(1, value.length);
      for (const element of value) visit(element, path, childMult, depth);
      return;
    }
    if (isPlainObject(value)) {
      for (const key of Object.keys(value)) {
        if (value[key] === void 0) continue;
        if (!SIMPLE_SEGMENT.test(key)) throw new CutoverRefusedError("Unsupported Firestore field path segment");
        visit(value[key], path === "" ? key : `${path}.${key}`, mult, depth + 1);
      }
      return;
    }
    if (isLeaf(value)) return;
    throw new CutoverRefusedError("Unsupported Firestore value type in document");
  }, "visit");
  visit(document, "", 1, 0);
  return { multiplicity, maxDepth };
}
__name(concreteFieldPaths, "concreteFieldPaths");
function serializedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value, (_key, item) => item instanceof Uint8Array ? Buffer.from(item).toString("base64") : item), "utf8");
}
__name(serializedBytes, "serializedBytes");
function canonicalIndexList(indexes) {
  return canonicalJson(indexes.map((index) => canonicalJson(index)).sort());
}
__name(canonicalIndexList, "canonicalIndexList");
function resourceName(databaseResource, collectionGroup, fieldPath) {
  return `${databaseResource}/collectionGroups/${collectionGroup}/fields/${fieldPath}`;
}
__name(resourceName, "resourceName");
function collectionPolicy(policy, collectionGroup) {
  const found = policy.collections.filter((entry) => entry.collectionGroup === collectionGroup);
  if (found.length !== 1) throw new CutoverRefusedError("Signed index policy does not cover the collection group exactly once");
  return found[0];
}
__name(collectionPolicy, "collectionPolicy");
function signedRootFor(policy, collectionGroup, fieldPath, databaseResource) {
  const override = collectionPolicy(policy, collectionGroup).overrides.find((entry) => entry.fieldPath === fieldPath);
  if (override) {
    return { source: resourceName(databaseResource, collectionGroup, fieldPath), indexes: override.indexes };
  }
  return policy.default;
}
__name(signedRootFor, "signedRootFor");
function assertConcreteCoverage(input) {
  const { policy, databaseResource, collectionGroup, paths, fresh } = input;
  if (fresh.collectionGroup !== collectionGroup) throw new CutoverRefusedError("Fresh coverage is for a different collection group");
  const effective = /* @__PURE__ */ new Map();
  for (const entry of fresh.effectiveFields) {
    if (effective.has(entry.fieldPath)) throw new CutoverRefusedError("Duplicate fresh effective field observation");
    effective.set(entry.fieldPath, entry);
  }
  const defaultRoot = policy.default;
  for (const fieldPath of paths.keys()) {
    const root = signedRootFor(policy, collectionGroup, fieldPath, databaseResource);
    const explicit = root !== defaultRoot;
    const resource = resourceName(databaseResource, collectionGroup, fieldPath);
    const entry = effective.get(fieldPath);
    if (!entry) throw new CutoverRefusedError("Concrete field is not covered by fresh authenticated observation");
    const expectedChain = explicit ? [resource] : [resource, defaultRoot.source];
    if (entry.source !== root.source || entry.chain.length !== expectedChain.length || entry.chain.some((name, index) => name !== expectedChain[index])) {
      throw new CutoverRefusedError("Concrete field inheritance does not resolve to its signed root");
    }
    if (canonicalIndexList(entry.indexes) !== canonicalIndexList(root.indexes)) {
      throw new CutoverRefusedError("Concrete field index modes differ from the signed policy");
    }
  }
}
__name(assertConcreteCoverage, "assertConcreteCoverage");
function estimateDocumentIndexCost(input) {
  const { policy, databaseResource, collectionGroup, paths, documentBytes } = input;
  let entries = 0;
  let bytes = 0;
  for (const [fieldPath, mult] of paths) {
    const root = signedRootFor(policy, collectionGroup, fieldPath, databaseResource);
    const modes = root.indexes.length * mult;
    entries += modes;
    bytes += modes * (Buffer.byteLength(fieldPath, "utf8") + 8 + documentBytes);
  }
  const composites = collectionPolicy(policy, collectionGroup).composites;
  for (const composite2 of composites) {
    const pathBytes = composite2.fields.reduce((sum, field) => sum + Buffer.byteLength(field.fieldPath, "utf8"), 0);
    entries += 1;
    bytes += pathBytes + 8 + documentBytes;
  }
  return { entries, bytes };
}
__name(estimateDocumentIndexCost, "estimateDocumentIndexCost");
function assertDocumentBudget(input) {
  const { document, policy, databaseResource, collectionGroup } = input;
  const documentBytes = serializedBytes(document);
  if (documentBytes > DOCUMENT_BYTE_BUDGET) throw new CutoverRefusedError("Prospective document exceeds the byte budget");
  const { multiplicity, maxDepth } = concreteFieldPaths(document);
  if (maxDepth > DOCUMENT_DEPTH_BUDGET) throw new CutoverRefusedError("Prospective document exceeds the depth budget");
  const cost = estimateDocumentIndexCost({ policy, databaseResource, collectionGroup, paths: multiplicity, documentBytes });
  if (cost.entries > INDEX_ENTRY_BUDGET || cost.bytes > INDEX_BYTE_BUDGET) {
    throw new CutoverRefusedError("Prospective document exceeds the index budget");
  }
}
__name(assertDocumentBudget, "assertDocumentBudget");

// src/store/fresh-index-observation.ts
var FRESH_INDEX_OBSERVATION_MAX_AGE_NS = 120000n * 1000000n;
var observations = /* @__PURE__ */ new WeakMap();
function recordFreshIndexObservation(db, observation) {
  if (observations.has(db)) throw new CutoverFenceError("A fresh index observation is already recorded for this handle");
  observations.set(db, observation);
}
__name(recordFreshIndexObservation, "recordFreshIndexObservation");
function requireObservation(db, purpose, binding) {
  const observation = observations.get(db);
  if (!observation) throw new CutoverRefusedError("Fresh authenticated index observation is required");
  if (observation.purpose !== purpose) throw new CutoverRefusedError("Fresh index observation has the wrong purpose");
  if (observation.namespace !== binding.namespace || observation.expectedEpoch !== binding.expectedEpoch || observation.migrationRunId !== binding.migrationRunId || observation.indexPolicyDigest !== binding.indexPolicyDigest) {
    throw new CutoverRefusedError("Fresh index observation does not match the authenticated binding");
  }
  if (observation.accessTokenDigest !== binding.adminTokenDigest) {
    throw new CutoverRefusedError("Fresh index observation was not read with the authenticated exchange token");
  }
  const ageNs = process.hrtime.bigint() - observation.completedAtNs;
  if (ageNs < 0n || ageNs > FRESH_INDEX_OBSERVATION_MAX_AGE_NS) {
    throw new CutoverRefusedError("Fresh index observation is outside the allowed age window");
  }
  return observation;
}
__name(requireObservation, "requireObservation");
var TTL_RETENTION_FIELD = {
  sessions: "retainUntil",
  auth_codes: "expiresAt",
  resume_tokens: "expiresAt"
};
function ttlRuleFor(group) {
  for (const suffix of ["sessions", "auth_codes", "resume_tokens"]) {
    if (group.endsWith(`_${suffix}`)) return TTL_RETENTION_FIELD[suffix];
  }
  return null;
}
__name(ttlRuleFor, "ttlRuleFor");
function isPositiveInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
__name(isPositiveInteger, "isPositiveInteger");
function assertTtlSchema(policy, group, document) {
  const signed = policy.collections.find((entry) => entry.collectionGroup === group)?.ttl ?? [];
  for (const entry of signed) {
    if (entry.fieldPath !== "ttlAt" || entry.state !== "ACTIVE") {
      throw new CutoverRefusedError("Signed TTL policy entry is malformed or not on ttlAt");
    }
  }
  const rule = ttlRuleFor(group);
  const doc = document !== null && typeof document === "object" ? document : {};
  if (rule === null) {
    if (signed.length > 0) throw new CutoverRefusedError("Signed TTL policy exists for a group without a TTL rule");
    if (doc.ttlAt !== void 0) throw new CutoverRefusedError("Record in a group without a TTL rule carries ttlAt");
    return;
  }
  if (signed.length !== 1) throw new CutoverRefusedError("Signed TTL policy is missing for a TTL-governed group");
  if (!isPositiveInteger(doc[rule])) throw new CutoverRefusedError(`${rule} must be a positive integer timestamp`);
  if (!(doc.ttlAt instanceof Date) || !Number.isFinite(doc.ttlAt.getTime())) {
    throw new CutoverRefusedError("ttlAt must be a valid timestamp");
  }
  if (doc.ttlAt.getTime() !== doc[rule]) throw new CutoverRefusedError(`ttlAt must equal ${rule}`);
  if (rule === "retainUntil") {
    if (!isPositiveInteger(doc.expiresAt) || doc.retainUntil < doc.expiresAt) {
      throw new CutoverRefusedError("retainUntil must be at least expiresAt");
    }
  } else if (group.endsWith("_resume_tokens")) {
    if (typeof doc.consumedAt !== "number" || !Number.isSafeInteger(doc.consumedAt) || doc.consumedAt < 0) {
      throw new CutoverRefusedError("consumedAt must be a non-negative integer timestamp");
    }
  } else if (typeof doc.used !== "boolean") {
    throw new CutoverRefusedError("Auth code used flag must be boolean");
  }
}
__name(assertTtlSchema, "assertTtlSchema");
function assertPreparationObservation(input) {
  const { db, binding, inventoryDigest, writes, subjectRefsGroup } = input;
  const observation = requireObservation(db, "preparation", binding);
  if (subjectRefsGroup !== void 0) {
    const fresh = observation.coverage.get(subjectRefsGroup);
    const field = fresh?.effectiveFields.find((entry) => entry.fieldPath === "subjectRefs");
    const requiredSubjectRefs = (observation.requiredFields[subjectRefsGroup] ?? []).includes("subjectRefs");
    const arrayContains = field?.indexes.some((index) => canonicalJson(index) === canonicalJson({ queryScope: "COLLECTION", arrayConfig: "CONTAINS" })) ?? false;
    if (!fresh || !field || !requiredSubjectRefs || !arrayContains) {
      throw new CutoverRefusedError("Subject reference index is not covered by the fresh observation");
    }
  }
  if (observation.sourceInventoryDigest !== inventoryDigest) {
    throw new CutoverRefusedError("Source inventory digest differs from the observed inventory");
  }
  const schema = binding.indexSchema;
  if (subjectRefsGroup !== void 0) {
    const fresh = observation.coverage.get(subjectRefsGroup);
    if (!fresh) throw new CutoverRefusedError("Subject reference index is not covered by the fresh observation");
    assertConcreteCoverage({
      policy: schema.policy,
      databaseResource: schema.provenance.databaseResource,
      collectionGroup: subjectRefsGroup,
      paths: /* @__PURE__ */ new Map([["subjectRefs", 1]]),
      fresh
    });
  }
  for (const write of writes) {
    assertDocumentBudget({
      document: write.document,
      policy: schema.policy,
      databaseResource: schema.provenance.databaseResource,
      collectionGroup: write.group
    });
    assertTtlSchema(schema.policy, write.group, write.document);
    const fresh = observation.coverage.get(write.group);
    const required = observation.requiredFields[write.group];
    if (!fresh || !required) throw new CutoverRefusedError("Prospective collection group is not in the observation");
    const paths = concreteFieldPaths(write.document).multiplicity;
    for (const path of paths.keys()) {
      if (!required.includes(path)) throw new CutoverRefusedError("Concrete field is not in the observed required set");
    }
    assertConcreteCoverage({
      policy: schema.policy,
      databaseResource: schema.provenance.databaseResource,
      collectionGroup: write.group,
      paths,
      fresh
    });
  }
}
__name(assertPreparationObservation, "assertPreparationObservation");
function assertActivationObservation(db, binding) {
  requireObservation(db, "activation", binding);
}
__name(assertActivationObservation, "assertActivationObservation");

// src/cutover/index-policy-core.mjs
async function readFirestoreAdminIndexes({ project, database, collectionGroups, requiredFields, accessToken, fetchFn = fetch }) {
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project) || database !== "(default)" || !Array.isArray(collectionGroups) || !collectionGroups.length || new Set(collectionGroups).size !== collectionGroups.length || collectionGroups.some((name) => !/^[A-Za-z0-9_-]+$/.test(name)) || !requiredFields || typeof requiredFields !== "object" || Array.isArray(requiredFields) || Object.keys(requiredFields).length !== collectionGroups.length || collectionGroups.some((name) => !Array.isArray(requiredFields[name]) || new Set(requiredFields[name]).size !== requiredFields[name].length || requiredFields[name].some((field) => typeof field !== "string" || !/^[_A-Za-z][_A-Za-z0-9]*(\.[_A-Za-z][_A-Za-z0-9]*)*$/.test(field))) || typeof accessToken !== "string" || !accessToken) throw new Error("Invalid approved Admin read binding");
  const databaseName = `projects/${project}/databases/${database}`;
  const base = `https://firestore.googleapis.com/v1/${databaseName}`;
  const request = /* @__PURE__ */ __name(async (url) => {
    const response = await fetchFn(url, { headers: { authorization: `Bearer ${accessToken}` }, redirect: "error" });
    if (!response.ok) throw new Error(`Firestore Admin read failed: HTTP ${response.status}`);
    const value = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed Admin response");
    return value;
  }, "request");
  const pages = /* @__PURE__ */ __name(async (url, filter, key) => {
    const result = [], seen = /* @__PURE__ */ new Set();
    let token = "";
    do {
      const next = new URL(url);
      if (filter) next.searchParams.set("filter", filter);
      next.searchParams.set("pageSize", "100");
      if (token) next.searchParams.set("pageToken", token);
      const data = await request(next.href);
      if (data[key] !== void 0 && !Array.isArray(data[key])) throw new Error("Malformed Admin page");
      result.push(...data[key] ?? []);
      token = data.nextPageToken ?? "";
      if (typeof token !== "string" || token && seen.has(token)) throw new Error("Invalid Admin pagination cursor");
      if (token) seen.add(token);
    } while (token);
    return result;
  }, "pages");
  const validField = /* @__PURE__ */ __name((name) => typeof name === "string" && name.startsWith(`${databaseName}/collectionGroups/`) && /^projects\/[^/]+\/databases\/[^/]+\/collectionGroups\/[^/]+\/fields\/[^/]+$/.test(name), "validField");
  const fieldCache = /* @__PURE__ */ new Map();
  const getField = /* @__PURE__ */ __name(async (name) => {
    if (!validField(name)) throw new Error("Invalid Firestore ancestor field reference");
    if (!fieldCache.has(name)) {
      const value = await request(`https://firestore.googleapis.com/v1/${name.split("/").map(encodeURIComponent).join("/")}`);
      if (value.name !== name) throw new Error("Firestore field resource mismatch");
      fieldCache.set(name, value);
    }
    return fieldCache.get(name);
  }, "getField");
  const resolveField = /* @__PURE__ */ __name(async (field) => {
    const visited = /* @__PURE__ */ new Set();
    while (true) {
      if (!validField(field.name) || visited.has(field.name)) throw new Error("Invalid or cyclic index inheritance");
      visited.add(field.name);
      const config = field.indexConfig;
      if (!config || config.reverting === true) throw new Error("Missing or changing Firestore index configuration");
      if (config.usesAncestorConfig === true) {
        field = await getField(config.ancestorField);
      } else if (config.usesAncestorConfig === false || config.usesAncestorConfig === void 0) {
        if (config.indexes !== void 0 && !Array.isArray(config.indexes)) throw new Error("Malformed explicit Firestore index list");
        return { source: field.name, chain: [...visited], indexes: config.indexes ?? [] };
      } else throw new Error("Unknown Firestore index inheritance state");
    }
  }, "resolveField");
  const defaultField = await getField(`${databaseName}/collectionGroups/__default__/fields/*`);
  const defaultIndexes = await resolveField(defaultField);
  const collections = [];
  for (const collectionGroup of [...collectionGroups].sort()) {
    const parent = `${base}/collectionGroups/${encodeURIComponent(collectionGroup)}`;
    const [overrides, ttl, composites] = await Promise.all([
      pages(`${parent}/fields`, "indexConfig.usesAncestorConfig:false", "fields"),
      pages(`${parent}/fields`, "ttlConfig:*", "fields"),
      pages(`${parent}/indexes`, "", "indexes")
    ]);
    const names = /* @__PURE__ */ new Set();
    for (const field of [...overrides, ...ttl]) {
      if (!validField(field.name) || !field.name.startsWith(`${databaseName}/collectionGroups/${collectionGroup}/fields/`)) throw new Error("Unexpected Firestore field resource");
      names.add(field.name);
    }
    for (const fieldPath of requiredFields[collectionGroup]) {
      names.add(`${databaseName}/collectionGroups/${collectionGroup}/fields/${fieldPath}`);
    }
    const resolved = [];
    for (const name of [...names].sort()) {
      const field = await getField(name);
      if (field.ttlConfig && field.ttlConfig.state !== "ACTIVE") throw new Error("Firestore TTL is not active");
      resolved.push({ name, index: await resolveField(field), ttlConfig: field.ttlConfig ?? null });
    }
    for (const index of composites) {
      if (index.state !== "READY" || typeof index.name !== "string" || !index.name.startsWith(`${databaseName}/collectionGroups/${collectionGroup}/indexes/`)) throw new Error("Firestore composite index is not ready");
    }
    collections.push({ collectionGroup, fields: resolved, composites, requiredFields: [...requiredFields[collectionGroup]].sort() });
  }
  return { databaseResource: databaseName, defaultIndexes, collections, paginationComplete: true };
}
__name(readFirestoreAdminIndexes, "readFirestoreAdminIndexes");
var sort = /* @__PURE__ */ __name((items) => [...items].sort((a, b) => canonicalJson(a) < canonicalJson(b) ? -1 : canonicalJson(a) > canonicalJson(b) ? 1 : 0), "sort");
function indexField(field) {
  if (!field || typeof field.fieldPath !== "string" || !field.fieldPath) throw new Error("Unknown index field");
  const options = [field.order && ["order", field.order], field.arrayConfig && ["arrayConfig", field.arrayConfig], field.vectorConfig && ["vectorConfig", field.vectorConfig]].filter(Boolean);
  if (options.length !== 1 || options[0][0] === "vectorConfig" || options[0][0] === "order" && !["ASCENDING", "DESCENDING"].includes(options[0][1]) || options[0][0] === "arrayConfig" && options[0][1] !== "CONTAINS") throw new Error("Unsupported Firestore index field");
  return { fieldPath: field.fieldPath, [options[0][0]]: options[0][1] };
}
__name(indexField, "indexField");
function single(index) {
  if (index.state !== void 0 && index.state !== "READY") throw new Error("Single-field index is not ready");
  if (!["COLLECTION", "COLLECTION_GROUP"].includes(index.queryScope) || !Array.isArray(index.fields) || index.fields.length !== 1) throw new Error("Unsupported single-field index");
  const { fieldPath: _fieldPath, ...mode } = indexField(index.fields[0]);
  return { queryScope: index.queryScope, ...mode };
}
__name(single, "single");
function composite(index) {
  if (!["COLLECTION", "COLLECTION_GROUP"].includes(index.queryScope) || !Array.isArray(index.fields) || !index.fields.length) throw new Error("Unsupported composite index");
  return { queryScope: index.queryScope, fields: index.fields.map(indexField) };
}
__name(composite, "composite");
function projectIndexObservation({ databaseResource, collectionGroups, observation }) {
  if (typeof databaseResource !== "string" || !databaseResource || observation?.databaseResource !== databaseResource || observation.paginationComplete !== true || !Array.isArray(collectionGroups) || !collectionGroups.length || new Set(collectionGroups).size !== collectionGroups.length || !Array.isArray(observation.collections) || !Array.isArray(observation.defaultIndexes?.indexes)) throw new Error("Incomplete protected index inputs");
  const groups = [...collectionGroups].sort();
  if (canonicalJson(groups) !== canonicalJson(observation.collections.map((entry) => entry.collectionGroup).sort())) throw new Error("Firestore collection-group coverage mismatch");
  const defaultIndexes = sort(observation.defaultIndexes.indexes.map(single)), defaultChain = observation.defaultIndexes.chain;
  const defaultName = `${databaseResource}/collectionGroups/__default__/fields/*`;
  if (!Array.isArray(defaultChain) || !defaultChain.length || defaultChain[0] !== defaultName || defaultChain[defaultChain.length - 1] !== observation.defaultIndexes.source || new Set(defaultChain).size !== defaultChain.length || defaultChain.some((name) => typeof name !== "string" || !name.startsWith(`${databaseResource}/collectionGroups/`))) throw new Error("Invalid default index inheritance chain");
  const collections = groups.map((group) => {
    const observed = observation.collections.find((entry) => entry.collectionGroup === group);
    if (!Array.isArray(observed.fields) || !Array.isArray(observed.composites) || !Array.isArray(observed.requiredFields) || new Set(observed.requiredFields).size !== observed.requiredFields.length || observed.composites.some((index) => index.state !== "READY")) throw new Error("Incomplete Admin collection observation");
    const overrides = [], ttl = [], effectiveFields = [], composites = sort(observed.composites.map(composite));
    for (const field of observed.fields) {
      const prefix = `${databaseResource}/collectionGroups/${group}/fields/`;
      if (typeof field.name !== "string" || !field.name.startsWith(prefix) || !field.index || !Array.isArray(field.index.indexes)) throw new Error("Malformed effective field observation");
      const fieldPath = field.name.slice(prefix.length), chain = field.index.chain;
      if (!/^[_A-Za-z][_A-Za-z0-9]*(\.[_A-Za-z][_A-Za-z0-9]*)*$/.test(fieldPath) || !Array.isArray(chain) || !chain.length || chain[0] !== field.name || chain[chain.length - 1] !== field.index.source || new Set(chain).size !== chain.length || chain.some((name) => typeof name !== "string" || !name.startsWith(`${databaseResource}/collectionGroups/`))) throw new Error("Malformed field inheritance chain");
      const indexes = sort(field.index.indexes.map(single));
      effectiveFields.push({ fieldPath, indexes, source: field.index.source, chain });
      if (field.index.source === field.name) overrides.push({ fieldPath, indexes });
      if (field.ttlConfig) {
        if (field.ttlConfig.state !== "ACTIVE" || field.ttlConfig.expirationOffset && field.ttlConfig.expirationOffset !== "0s") throw new Error("Unsupported TTL state or offset");
        ttl.push({ fieldPath, state: "ACTIVE" });
      }
    }
    if (new Set(effectiveFields.map((field) => field.fieldPath)).size !== effectiveFields.length || observed.requiredFields.some((fieldPath) => !effectiveFields.some((field) => field.fieldPath === fieldPath))) throw new Error(`Incomplete effective field coverage for ${group}`);
    return { collectionGroup: group, requiredFields: [...observed.requiredFields].sort(), effectiveFields: sort(effectiveFields), overrides: sort(overrides), composites, ttl: sort(ttl) };
  });
  return {
    policy: { default: { source: observation.defaultIndexes.source, indexes: defaultIndexes }, collections: collections.map(({ collectionGroup, overrides, composites, ttl }) => ({ collectionGroup, overrides, composites, ttl })) },
    coverage: collections.map(({ collectionGroup, requiredFields, effectiveFields }) => ({ collectionGroup, requiredFields, effectiveFields }))
  };
}
__name(projectIndexObservation, "projectIndexObservation");

// src/store/fresh-index-producer.ts
import { createHash as createHash4 } from "node:crypto";
var DEFAULT_DATABASE_RESOURCE = /^projects\/([a-z][a-z0-9-]{4,61}[a-z0-9])\/databases\/\(default\)$/;
function sha256Hex(value) {
  return createHash4("sha256").update(value, "utf8").digest("hex");
}
__name(sha256Hex, "sha256Hex");
async function observeFreshIndexes(input) {
  const binding = getProtectedBinding(input.db);
  if (!binding) throw new CutoverRefusedError("Protected migration context required for a fresh index observation");
  assertCredentialUnchanged(input.db);
  const access = binding.adminAccess;
  if (!access || binding.adminTokenDigest === null) {
    throw new CutoverRefusedError("No Admin read token was authenticated for this handle");
  }
  const schema = binding.indexSchema;
  const match = DEFAULT_DATABASE_RESOURCE.exec(schema.provenance.databaseResource);
  if (!match) throw new CutoverRefusedError("Index schema does not name a default database");
  const token = await access.getAccessToken();
  if (typeof token !== "string" || !token) throw new CutoverRefusedError("Admin read token is not available");
  if (sha256Hex(token) !== binding.adminTokenDigest) {
    throw new CutoverRefusedError("Admin read token differs from the authenticated exchange token");
  }
  const groups = schema.policy.collections.map((entry) => entry.collectionGroup);
  for (const name of Object.keys(input.requiredFields)) {
    if (!groups.includes(name)) throw new CutoverRefusedError("Required field list names a group outside the signed policy");
  }
  const requiredFields = {};
  for (const group of groups) requiredFields[group] = [...input.requiredFields[group] ?? []];
  const raw = await readFirestoreAdminIndexes({
    project: match[1],
    database: "(default)",
    collectionGroups: groups,
    requiredFields,
    accessToken: token,
    fetchFn: access.fetchFn
  });
  const projected = projectIndexObservation({
    databaseResource: schema.provenance.databaseResource,
    collectionGroups: groups,
    observation: raw
  });
  if (sha256Hex(canonicalJson(projected.policy)) !== binding.indexPolicyDigest) {
    throw new CutoverRefusedError("Fresh index policy differs from the signed index policy");
  }
  const coverage = /* @__PURE__ */ new Map();
  for (const entry of projected.coverage) {
    coverage.set(entry.collectionGroup, { collectionGroup: entry.collectionGroup, effectiveFields: entry.effectiveFields });
  }
  recordFreshIndexObservation(input.db, {
    purpose: input.purpose,
    namespace: binding.namespace,
    expectedEpoch: binding.expectedEpoch,
    migrationRunId: binding.migrationRunId,
    indexPolicyDigest: binding.indexPolicyDigest,
    sourceInventoryDigest: input.sourceInventoryDigest,
    requiredFields,
    coverage,
    completedAtNs: process.hrtime.bigint(),
    accessTokenDigest: binding.adminTokenDigest
  });
}
__name(observeFreshIndexes, "observeFreshIndexes");

// src/store/firestore-migration-engine.ts
import { createHash as createHash5 } from "node:crypto";
function prospectiveWrites(namespace, plan) {
  const targets = getCutoverDistinctCollectionNames(namespace).target;
  const writes = [];
  for (const item of plan.items) {
    if (item.targetReferences.length !== item.prospectiveTargetPostimages.length) {
      throw new CutoverRefusedError("Prospective target postimages do not match target references");
    }
    item.targetReferences.forEach((reference, index) => {
      const group = targets[reference.collection];
      if (!group) throw new CutoverRefusedError("Unknown prospective target collection");
      writes.push({ group, document: item.prospectiveTargetPostimages[index] });
    });
    writes.push({ group: `${namespace}_meta`, document: item.receiptUpperBound });
  }
  writes.push(
    { group: `${namespace}_meta`, document: plan.prepared },
    { group: `${namespace}_meta`, document: plan.finalization.finalUpperBound },
    { group: `${namespace}_meta`, document: plan.finalization.markerUpperBound },
    { group: `${namespace}_meta`, document: plan.finalization.controlUpperBound }
  );
  return writes;
}
__name(prospectiveWrites, "prospectiveWrites");
function assertPreparationInputs(db, inputs) {
  const binding = getProtectedBinding(db);
  if (!binding) throw new CutoverRefusedError("Protected migration context required for preparation");
  const { completePlan, expectedIdentity, sourceInventoryDigest } = inputs;
  const prepared = completePlan.prepared;
  validateCompleteMigrationPlan(completePlan);
  assertPreparedIdentity(prepared, expectedIdentity, expectedIdentity.namespace);
  if (prepared.planDigest !== computePlanDigest(expectedIdentity.namespace, expectedIdentity.epoch, prepared.planSpec)) {
    throw new CutoverRefusedError("Prepared plan digest does not match its planSpec");
  }
  if (prepared.sourceInventoryDigest !== sourceInventoryDigest) {
    throw new CutoverRefusedError("Prepared plan source inventory differs from the snapshot");
  }
  if (expectedIdentity.namespace !== binding.namespace || expectedIdentity.epoch !== binding.expectedEpoch || expectedIdentity.migrationRunId !== binding.migrationRunId || expectedIdentity.codeSha !== binding.codeSha || expectedIdentity.codeArtifact !== binding.codeArtifact || expectedIdentity.packageIntegrity !== binding.packageIntegrity || expectedIdentity.protocolDigest !== binding.protocolDigest || expectedIdentity.assemblyDigest !== binding.assemblyDigest || expectedIdentity.indexSchemaDigest !== binding.indexSchemaDigest) {
    throw new CutoverRefusedError("Expected identity differs from the authenticated binding");
  }
  const manifestText = canonicalJson(binding.indexSchema);
  if (createHash5("sha256").update(Buffer.from(manifestText, "utf8")).digest("hex") !== expectedIdentity.indexSchemaDigest) {
    throw new CutoverRefusedError("Signed index manifest does not match the expected index schema digest");
  }
  return binding;
}
__name(assertPreparationInputs, "assertPreparationInputs");
function assertPreparationGate(db, inputs) {
  const binding = assertPreparationInputs(db, inputs);
  assertPreparationObservation({
    db,
    binding,
    inventoryDigest: inputs.sourceInventoryDigest,
    writes: prospectiveWrites(inputs.expectedIdentity.namespace, inputs.completePlan),
    subjectRefsGroup: binding.subjectDescriptor !== null ? `${inputs.expectedIdentity.namespace}_refresh_families` : void 0
  });
}
__name(assertPreparationGate, "assertPreparationGate");
function assertValidMigrationContext2(options, extraFields = []) {
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
    "protocolDigest"
  ];
  for (const field of requiredFields) {
    if (opts[field] === void 0 || opts[field] === null) {
      throw new CutoverFenceError(`MigrationContext missing required field: ${field}`);
    }
  }
  if (typeof opts.db !== "object" || typeof opts.db.collection !== "function" || typeof opts.db.runTransaction !== "function") {
    throw new CutoverFenceError("MigrationContext db must be a Firestore-like object with collection and runTransaction methods");
  }
  if (typeof opts.FieldPath !== "object" && typeof opts.FieldPath !== "function" || typeof opts.FieldPath.documentId !== "function") {
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
  const allowedFields = /* @__PURE__ */ new Set([
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
    ...extraFields
  ]);
  for (const k of Object.keys(opts)) {
    if (!allowedFields.has(k)) {
      throw new CutoverFenceError(`Unknown option '${k}' passed to MigrationContext`);
    }
  }
}
__name(assertValidMigrationContext2, "assertValidMigrationContext");
function protectedBootstrapBindings(db) {
  const binding = getProtectedBinding(db);
  if (!binding) throw new CutoverRefusedError("Protected migration context required for bootstrap bindings");
  return { assemblyDigest: binding.assemblyDigest, indexSchemaDigest: binding.indexSchemaDigest };
}
__name(protectedBootstrapBindings, "protectedBootstrapBindings");
function legacyDocId(token) {
  if (typeof token !== "string") return "";
  return token.replace(/\//g, "_").replace(/\./g, "_");
}
__name(legacyDocId, "legacyDocId");
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
function computeCandidateId(storeKey, namespace, epoch, kind, sortedSourceIds) {
  return H(storeKey, "candidate-id", namespace, epoch, [kind, sortedSourceIds]);
}
__name(computeCandidateId, "computeCandidateId");
function computeCandidateLogicalDigest(storeKey, namespace, epoch, kind, logicalProjection) {
  return H(storeKey, "logical-record", namespace, epoch, [kind, logicalProjection]);
}
__name(computeCandidateLogicalDigest, "computeCandidateLogicalDigest");
function subjectSpecForDb(db, namespace, storeKey) {
  const binding = getProtectedBinding(db);
  if (!binding) throw new CutoverRefusedError("Protected migration context required for subject mapping");
  if (binding.namespace !== namespace) throw new CutoverRefusedError("Subject descriptor is bound to a different namespace");
  return subjectSpecFor(binding.subjectDescriptor, namespace, storeKey);
}
__name(subjectSpecForDb, "subjectSpecForDb");
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
    now,
    subject = null
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
  const upstreamById = /* @__PURE__ */ new Map();
  for (const d of upstreamDocs) upstreamById.set(d.id, d.data() || {});
  const malformedDocKeys = /* @__PURE__ */ new Set();
  const tokensByCredential = /* @__PURE__ */ new Map();
  const tokensByPhysicalId = /* @__PURE__ */ new Map();
  for (const d of tokensDocs) {
    const data = d.data() || {};
    if (data.familyId != null && data.refreshFamilyId != null && data.familyId !== data.refreshFamilyId) {
      malformedDocKeys.add(`tokens:${d.id}`);
      reasons.conflictingClaims++;
      continue;
    }
    const credToken = data.accessToken ?? data.token?.accessToken;
    if (typeof credToken === "string" && credToken.length > 0) {
      const expId = legacyDocId(credToken);
      if (d.id !== expId) {
        malformedDocKeys.add(`tokens:${d.id}`);
        reasons.malformedRecords++;
        continue;
      }
      if (tokensByPhysicalId.has(d.id)) {
        const existing = tokensByPhysicalId.get(d.id);
        if (existing.credentialToken !== credToken) {
          reasons.conflictingClaims++;
          continue;
        }
      }
      if (tokensByCredential.has(credToken)) {
        const existing = tokensByCredential.get(credToken);
        if (existing.physicalId !== d.id) {
          reasons.conflictingClaims++;
          continue;
        }
      }
      const entry = { doc: d, data, physicalId: d.id, credentialToken: credToken };
      tokensByCredential.set(credToken, entry);
      tokensByPhysicalId.set(d.id, entry);
    }
  }
  const refreshByCredential = /* @__PURE__ */ new Map();
  const refreshByPhysicalId = /* @__PURE__ */ new Map();
  for (const d of refreshDocs) {
    const data = d.data() || {};
    let credToken = data.refreshToken ?? data.token?.refreshToken;
    if (!credToken && data.accessToken) {
      const tok = tokensByCredential.get(data.accessToken);
      const rawRef = tok?.data?.refreshToken;
      if (rawRef && legacyDocId(rawRef) === d.id) {
        credToken = rawRef;
      } else {
        continue;
      }
    }
    if (typeof credToken === "string" && credToken.length > 0) {
      const expId = legacyDocId(credToken);
      if (d.id !== expId) {
        malformedDocKeys.add(`refresh:${d.id}`);
        reasons.malformedRecords++;
        continue;
      }
      if (refreshByPhysicalId.has(d.id)) {
        const existing = refreshByPhysicalId.get(d.id);
        if (existing.credentialToken !== credToken) {
          reasons.conflictingClaims++;
          continue;
        }
      }
      if (refreshByCredential.has(credToken)) {
        const existing = refreshByCredential.get(credToken);
        if (existing.physicalId !== d.id) {
          reasons.conflictingClaims++;
          continue;
        }
      }
      const entry = { doc: d, data, physicalId: d.id, credentialToken: credToken };
      refreshByCredential.set(credToken, entry);
      refreshByPhysicalId.set(d.id, entry);
    }
  }
  const candidates = [];
  const candidateCommitments = [];
  const claimedAccessIds = /* @__PURE__ */ new Set();
  const claimedRefreshIds = /* @__PURE__ */ new Set();
  const claimedRetiredFingerprints = /* @__PURE__ */ new Set();
  const claimedRefreshDocIds = /* @__PURE__ */ new Set();
  const claimedTokenDocIds = /* @__PURE__ */ new Set();
  const claimedUpstreamDocIds = /* @__PURE__ */ new Set();
  for (const famDoc of familiesDocs) {
    const familyId = famDoc.id;
    const famData = famDoc.data() || {};
    if (!upstreamById.has(familyId)) {
      reasons.missingUpstreamGrants++;
      continue;
    }
    const currentRefToken = famData.currentRefreshToken;
    let curRefEntry = currentRefToken ? refreshByCredential.get(currentRefToken) : void 0;
    if (!curRefEntry && currentRefToken) {
      const byPhys = refreshByPhysicalId.get(legacyDocId(currentRefToken));
      if (byPhys && byPhys.credentialToken === currentRefToken) {
        curRefEntry = byPhys;
      }
    }
    if (!currentRefToken || !curRefEntry) {
      reasons.missingRefreshPointers++;
      continue;
    }
    const curRefDoc = curRefEntry.data || {};
    const curRefFamId = curRefDoc.familyId ?? curRefDoc.family_id;
    if (curRefFamId !== familyId || curRefDoc.status !== "active") {
      malformedDocKeys.add(`families:${famDoc.id}`);
      reasons.malformedRecords++;
      continue;
    }
    if (claimedRefreshIds.has(curRefEntry.credentialToken)) {
      reasons.conflictingClaims++;
      continue;
    }
    claimedRefreshIds.add(curRefEntry.credentialToken);
    const accessId = famData.currentAccessToken ?? curRefDoc.accessToken ?? curRefDoc.token?.accessToken;
    let accessEntry = accessId ? tokensByCredential.get(accessId) : void 0;
    if (!accessEntry && accessId) {
      const byPhys = tokensByPhysicalId.get(legacyDocId(accessId));
      if (byPhys && byPhys.credentialToken === accessId) {
        accessEntry = byPhys;
      }
    }
    if (!accessId || typeof accessId !== "string" || !accessId.trim() || !accessEntry) {
      reasons.missingAccessTokens++;
      continue;
    }
    const owners = [accessEntry.data.familyId, accessEntry.data.refreshFamilyId].filter((value) => value != null);
    if (owners.some((value) => typeof value !== "string")) {
      reasons.malformedRecords++;
      continue;
    }
    if (owners.some((value) => value !== familyId)) {
      reasons.conflictingClaims++;
      continue;
    }
    if (claimedAccessIds.has(accessEntry.credentialToken)) {
      reasons.conflictingClaims++;
      continue;
    }
    claimedAccessIds.add(accessEntry.credentialToken);
    let prevRefEntry = void 0;
    if (famData.previousRefreshToken) {
      const prevRefToken = famData.previousRefreshToken;
      prevRefEntry = refreshByCredential.get(prevRefToken);
      if (!prevRefEntry) {
        const byPhys = refreshByPhysicalId.get(legacyDocId(prevRefToken));
        if (byPhys && byPhys.credentialToken === prevRefToken) {
          prevRefEntry = byPhys;
        }
      }
      if (prevRefToken === currentRefToken || claimedRefreshIds.has(prevRefToken) || !prevRefEntry) {
        reasons.conflictingClaims++;
        continue;
      }
      claimedRefreshIds.add(prevRefToken);
    }
    const rawRetired = Array.isArray(famData.retiredRefreshFingerprints) ? famData.retiredRefreshFingerprints : Array.isArray(famData.retiredTokens) ? famData.retiredTokens : [];
    const seenFp = /* @__PURE__ */ new Set();
    const retiredFingerprints = [];
    let retiredConflict = false;
    for (const fp of rawRetired) {
      if (typeof fp !== "string" || fp.length === 0) {
        malformedDocKeys.add(`families:${famDoc.id}`);
        reasons.malformedRecords++;
        retiredConflict = true;
        break;
      }
      if (seenFp.has(fp) || claimedRetiredFingerprints.has(fp)) {
        reasons.conflictingClaims++;
        retiredConflict = true;
        break;
      }
      seenFp.add(fp);
      claimedRetiredFingerprints.add(fp);
      retiredFingerprints.push(fp);
    }
    if (retiredConflict) continue;
    retiredFingerprints.sort(codeUnitCompare);
    const newAccessId = codec.id("session", accessEntry.credentialToken);
    const newRefreshId = codec.id("refresh", curRefEntry.credentialToken);
    const candSources = [
      {
        collection: "families",
        id: computeKeyedDocId(storeKey, "source-id", namespace, epoch, "families", familyId),
        rawId: familyId,
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, "families", computeKeyedDocId(storeKey, "source-id", namespace, epoch, "families", familyId), famData)
      },
      {
        collection: "refresh",
        id: computeKeyedDocId(storeKey, "source-id", namespace, epoch, "refresh", curRefEntry.physicalId),
        rawId: curRefEntry.physicalId,
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, "refresh", computeKeyedDocId(storeKey, "source-id", namespace, epoch, "refresh", curRefEntry.physicalId), curRefDoc)
      },
      {
        collection: "upstream",
        id: computeKeyedDocId(storeKey, "source-id", namespace, epoch, "upstream", familyId),
        rawId: familyId,
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, "upstream", computeKeyedDocId(storeKey, "source-id", namespace, epoch, "upstream", familyId), upstreamById.get(familyId))
      },
      {
        collection: "tokens",
        id: computeKeyedDocId(storeKey, "source-id", namespace, epoch, "tokens", accessEntry.physicalId),
        rawId: accessEntry.physicalId,
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, "tokens", computeKeyedDocId(storeKey, "source-id", namespace, epoch, "tokens", accessEntry.physicalId), accessEntry.data || {})
      }
    ];
    if (prevRefEntry) {
      candSources.push({
        collection: "refresh",
        id: computeKeyedDocId(storeKey, "source-id", namespace, epoch, "refresh", prevRefEntry.physicalId),
        rawId: prevRefEntry.physicalId,
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, "refresh", computeKeyedDocId(storeKey, "source-id", namespace, epoch, "refresh", prevRefEntry.physicalId), prevRefEntry.data || {})
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
    if (prevRefEntry) {
      const prevRefId = codec.id("refresh", prevRefEntry.credentialToken);
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
    const sourceEntries = [
      { collection: "families", physicalId: familyId, data: famData },
      { collection: "refresh", physicalId: curRefEntry.physicalId, data: curRefDoc },
      { collection: "upstream", physicalId: familyId, data: upstreamById.get(familyId) },
      { collection: "tokens", physicalId: accessEntry.physicalId, data: accessEntry.data }
    ];
    if (prevRefEntry) sourceEntries.push({ collection: "refresh", physicalId: prevRefEntry.physicalId, data: prevRefEntry.data });
    const sourcesMap = buildSourceProjectionMap({ id: candidateId, kind: "pr56Families", targets: candTargets, logicalDigest: "" }, sourceEntries, codec);
    const logicalProjection = projectSourceLogical(
      { id: candidateId, kind: "pr56Families", targets: candTargets, logicalDigest: "" },
      sourcesMap,
      codec,
      subject
    );
    if (subjectRefsForFamily(subject, logicalProjection.extra, logicalProjection.status).problem) reasons.subject_value_missing++;
    const logicalDigest = computeCandidateLogicalDigest(storeKey, namespace, epoch, "pr56Families", logicalProjection);
    const generation = typeof famData.generation === "number" ? famData.generation : 1;
    const grantVersion = typeof upstreamById.get(familyId)?.grantVersion === "number" ? upstreamById.get(familyId).grantVersion : 1;
    const famRow = encodeRefreshFamiliesRow(codec, familyId, generation, newRefreshId, newAccessId, logicalProjection, retiredFingerprints, famData.status, now, logicalProjection.subjectRefs);
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
    if (prevRefEntry) {
      const prevRefId = codec.id("refresh", prevRefEntry.credentialToken);
      const previousRefresh = logicalProjection.previousRefresh;
      if (!previousRefresh) throw new CutoverFenceError(`Previous refresh projection missing for candidate ${sanitizeId(candidateId)}`);
      prevRefreshRow = {
        id: prevRefId,
        familyId,
        status: "consumed",
        generation: Math.max(1, generation - 1),
        consumedAt: previousRefresh.consumedAt,
        successorSealed: codec.seal({ accessToken: accessId, refreshToken: currentRefToken }, `successor:${prevRefId}`),
        v: 2
      };
      targetDocsMap.set("prevRefresh", prevRefreshRow);
      postimageByTargetId.set(prevRefTargetId, prevRefreshRow);
    }
    const retiredRows = [];
    for (const fp of retiredFingerprints) {
      const retRow = { familyId };
      retiredRows.push({ fingerprint: fp });
      const retTgtId = computeKeyedDocId(storeKey, "target-id", namespace, epoch, "retiredRefreshTokens", fp);
      postimageByTargetId.set(retTgtId, retRow);
    }
    if (retiredFingerprints.length > 0) {
      targetDocsMap.set("retiredRefresh", { ids: retiredFingerprints });
    }
    const targetLogicalProjection = projectTargetLogical(
      { id: candidateId, kind: "pr56Families", targets: candTargets, logicalDigest: "" },
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
    if (prevRefEntry) expectedTargetCounts.refresh++;
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
    claimedRefreshDocIds.add(curRefEntry.doc.id);
    if (prevRefEntry) claimedRefreshDocIds.add(prevRefEntry.doc.id);
    claimedTokenDocIds.add(accessEntry.doc.id);
    claimedUpstreamDocIds.add(familyId);
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
    const physicalId = tokDoc.id;
    const tokEntry = tokensByPhysicalId.get(physicalId) || tokensByCredential.get(physicalId);
    if (!tokEntry) continue;
    if (claimedAccessIds.has(tokEntry.credentialToken)) continue;
    claimedAccessIds.add(tokEntry.credentialToken);
    const tokData = tokEntry.data || {};
    if (tokData.refreshFamilyId != null || tokData.familyId != null) continue;
    if (typeof tokData.refreshToken !== "string" || tokData.refreshToken.length === 0) {
      malformedDocKeys.add(`tokens:${tokEntry.doc.id}`);
      reasons.malformedRecords++;
      continue;
    }
    const familyId = codec.id("family", tokEntry.credentialToken);
    const refreshId = codec.id("refresh", tokData.refreshToken);
    const newAccessId = codec.id("session", tokEntry.credentialToken);
    const candSources = [
      {
        collection: "tokens",
        id: computeKeyedDocId(storeKey, "source-id", namespace, epoch, "tokens", tokEntry.physicalId),
        rawId: tokEntry.physicalId,
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, "tokens", computeKeyedDocId(storeKey, "source-id", namespace, epoch, "tokens", tokEntry.physicalId), tokData)
      }
    ];
    let baseRefEntry = void 0;
    if (tokData.refreshToken) {
      const rawRef = tokData.refreshToken;
      baseRefEntry = refreshByCredential.get(rawRef);
      if (!baseRefEntry) {
        const byPhys = refreshByPhysicalId.get(legacyDocId(rawRef));
        if (byPhys) {
          if (byPhys.credentialToken !== rawRef) {
            reasons.conflictingClaims++;
            continue;
          }
          baseRefEntry = byPhys;
        }
      }
      if (baseRefEntry) {
        if (claimedRefreshIds.has(baseRefEntry.credentialToken)) {
          reasons.conflictingClaims++;
          continue;
        }
        candSources.push({
          collection: "refresh",
          id: computeKeyedDocId(storeKey, "source-id", namespace, epoch, "refresh", baseRefEntry.physicalId),
          rawId: baseRefEntry.physicalId,
          recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, "refresh", computeKeyedDocId(storeKey, "source-id", namespace, epoch, "refresh", baseRefEntry.physicalId), baseRefEntry.data || {})
        });
        claimedRefreshIds.add(baseRefEntry.credentialToken);
      }
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
    const sourceEntries = [{ collection: "tokens", physicalId: tokEntry.physicalId, data: tokData }];
    if (baseRefEntry) sourceEntries.push({ collection: "refresh", physicalId: baseRefEntry.physicalId, data: baseRefEntry.data });
    const sourcesMap = buildSourceProjectionMap({ id: candidateId, kind: "baseFormatTokens", targets: candTargets, logicalDigest: "" }, sourceEntries, codec);
    const logicalProjection = projectSourceLogical(
      { id: candidateId, kind: "baseFormatTokens", targets: candTargets, logicalDigest: "" },
      sourcesMap,
      codec,
      subject
    );
    if (subjectRefsForFamily(subject, logicalProjection.extra, logicalProjection.status).problem) reasons.subject_value_missing++;
    const logicalDigest = computeCandidateLogicalDigest(storeKey, namespace, epoch, "baseFormatTokens", logicalProjection);
    const famRow = encodeRefreshFamiliesRow(codec, familyId, 1, refreshId, newAccessId, logicalProjection, [], "active", now, logicalProjection.subjectRefs);
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
      { id: candidateId, kind: "baseFormatTokens", targets: candTargets, logicalDigest: "" },
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
    claimedTokenDocIds.add(tokEntry.doc.id);
    if (baseRefEntry) claimedRefreshDocIds.add(baseRefEntry.doc.id);
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
    const sourcesMap = buildSourceProjectionMap({ id: candidateId, kind: "authCodes", targets: candTargets, logicalDigest: "" }, [{ collection: "authCodes", physicalId: rawCode, data: cData }], codec);
    const logicalProjection = projectSourceLogical(
      { id: candidateId, kind: "authCodes", targets: candTargets, logicalDigest: "" },
      sourcesMap,
      codec,
      subject
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
        extra: logicalProjection.extra,
        used: logicalProjection.used
      },
      logicalProjection.expiresAt,
      now
    );
    const targetDocsMap = /* @__PURE__ */ new Map();
    targetDocsMap.set("authCodes", codeRow);
    const targetLogicalProjection = projectTargetLogical(
      { id: candidateId, kind: "authCodes", targets: candTargets, logicalDigest: "" },
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
    const sourcesMap = buildSourceProjectionMap({ id: candidateId, kind: "resumeTokens", targets: candTargets, logicalDigest: "" }, [{ collection: "resumeTokens", physicalId: resId, data: rData }], codec);
    const logicalProjection = projectSourceLogical(
      { id: candidateId, kind: "resumeTokens", targets: candTargets, logicalDigest: "" },
      sourcesMap,
      codec,
      subject
    );
    const logicalDigest = computeCandidateLogicalDigest(storeKey, namespace, epoch, "resumeTokens", logicalProjection);
    const resRow = encodeResumeTokensRow(resId, logicalProjection.consumedAt, logicalProjection.expiresAt, now);
    const targetDocsMap = /* @__PURE__ */ new Map();
    targetDocsMap.set("resumeTokens", resRow);
    const targetLogicalProjection = projectTargetLogical(
      { id: candidateId, kind: "resumeTokens", targets: candTargets, logicalDigest: "" },
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
    const hasLegacyClient = clientDocsById.has(clientId);
    const hasOauthClient = oauthClientDocsById.has(clientId);
    if (hasLegacyClient) {
      const d = clientDocsById.get(clientId);
      candSources.push({
        collection: "clients",
        id: computeKeyedDocId(storeKey, "source-id", namespace, epoch, "clients", clientId),
        rawId: clientId,
        recordDigest: computeSourceRecordDigest(storeKey, namespace, epoch, "clients", computeKeyedDocId(storeKey, "source-id", namespace, epoch, "clients", clientId), d)
      });
    }
    if (hasOauthClient) {
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
    const sourceEntries = [];
    if (hasLegacyClient) sourceEntries.push({ collection: "clients", physicalId: clientId, data: clientDocsById.get(clientId) });
    if (hasOauthClient) sourceEntries.push({ collection: "oauthClients", physicalId: clientId, data: oauthClientDocsById.get(clientId) });
    const sourcesMap = buildSourceProjectionMap({ id: candidateId, kind: "clients", targets: candTargets, logicalDigest: "" }, sourceEntries, codec);
    const logicalProjection = projectSourceLogical(
      { id: candidateId, kind: "clients", targets: candTargets, logicalDigest: "" },
      sourcesMap,
      codec,
      subject
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
      { id: candidateId, kind: "clients", targets: candTargets, logicalDigest: "" },
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
  for (const doc of upstreamDocs) {
    if (!claimedUpstreamDocIds.has(doc.id) && !malformedDocKeys.has(`upstream:${doc.id}`)) {
      reasons.orphanUpstreamGrants++;
    }
  }
  for (const doc of refreshDocs) {
    if (!claimedRefreshDocIds.has(doc.id) && !malformedDocKeys.has(`refresh:${doc.id}`)) {
      reasons.orphanRefreshPointers++;
    }
  }
  for (const doc of tokensDocs) {
    if (!claimedTokenDocIds.has(doc.id) && !malformedDocKeys.has(`tokens:${doc.id}`)) {
      reasons.orphanAccessTokens++;
    }
  }
  candidates.sort((a, b) => codeUnitCompare(a.id, b.id));
  const candidateById = new Map(candidates.map((c) => [c.id, c]));
  if (candidateById.size !== candidates.length) {
    throw new CutoverFenceError("Duplicate candidateId detected in candidate extraction");
  }
  const sortedCommitments = candidates.map((c) => c.commitment);
  const sourceLogicalItems = sortedCommitments.map((c) => [c.id, c.logicalDigest]);
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
    candidates: sortedCommitments.map((c) => {
      const executionCand = candidateById.get(c.id);
      if (!executionCand) throw new CutoverFenceError(`Candidate ${sanitizeId(c.id)} missing from execution candidates`);
      return {
        candidateId: c.id,
        kind: c.kind,
        sources: c.sources,
        targets: c.targets,
        logicalDigest: c.logicalDigest,
        sourceActions: executionCand.sourceActions.map((sa) => ({
          collection: sa.collection,
          id: sa.id,
          action: sa.action
        })),
        targetBounds: executionCand.prospectiveTargetPostimages.map((img) => ({
          sizeBytes: computeEstimatedFirestoreDocSize(img),
          depth: computeDocDepth(img),
          indexEntries: countIndexMetrics2(img).entries,
          indexBytes: countIndexMetrics2(img).bytes
        }))
      };
    }),
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
    // Record-bearing plans carry the approved projector identity. The reviewed core requires this exact
    // triple once records exist, and requires projectorDigest to equal protocolDigest.
    ...totalPhysicalRecords > 0 ? { projectorId: PROJECTOR_ID, projectorVersion: PROJECTOR_VERSION, projectorDigest: protocolDigest } : {}
  };
  const preparation = {
    estimatedCommitBytes: Math.max(100, computeEstimatedFirestoreDocSize(prepared) + 200)
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
      preparedDigest: D("prepared", namespace, epoch, prepared),
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
      sourceActions: c.sourceActions.map((sa) => ({ collection: sa.collection, id: sa.id, action: sa.action })),
      receiptUpperBound,
      transaction: {
        estimatedCommitBytes: Math.max(100, itemCommitBytes)
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
    preparedDigest: D("prepared", namespace, epoch, prepared),
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
    receiptSetDigest: "0".repeat(64)
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
    preparedDigest: D("prepared", namespace, epoch, prepared),
    migrationManifestDigest: "0".repeat(64),
    emptyNamespace: totalPhysicalRecords === 0,
    adoptedAt: now
  };
  const controlUpperBound = {
    schemaVersion: 1,
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
      estimatedCommitBytes: Math.max(100, computeEstimatedFirestoreDocSize(finalUpperBound) + computeEstimatedFirestoreDocSize(markerUpperBound) + computeEstimatedFirestoreDocSize(controlUpperBound))
    }
  };
  const activationControlUpperBound = {
    ...controlUpperBound,
    state: "v3_active"
  };
  const activation = {
    controlUpperBound: activationControlUpperBound,
    transaction: {
      estimatedCommitBytes: Math.max(100, computeEstimatedFirestoreDocSize(activationControlUpperBound))
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
    classifications,
    reasons,
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
async function inspectFirestoreLegacyMigration(options) {
  assertValidMigrationContext2(options);
  const binding = assertProtectedContext(options, { operation: "inspect", options: {} });
  options = { ...options, key: binding.key };
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
      throw new CutoverFenceError(`Unknown option '${k}' passed to inspectFirestoreLegacyMigration`);
    }
  }
  const { db, FieldPath, key, namespace, expectedEpoch, migrationRunId, codeSha, codeArtifact, packageIntegrity, protocolDigest } = options;
  const { assemblyDigest, indexSchemaDigest } = protectedBootstrapBindings(db);
  const storeKey = key;
  const docIdField = FieldPath.documentId();
  return await db.runTransaction(async (transaction) => {
    const timer = startMonotonicTimer();
    const control = await readCutoverFenceInTransaction(transaction, db, namespace);
    if (control.epoch !== expectedEpoch) {
      throw new CutoverFenceError(`Epoch mismatch in inspect: expected ${expectedEpoch}, got ${control.epoch}`);
    }
    if (control.state !== "fenced") {
      throw new CutoverFenceError(`Inspect requires a fenced namespace: state is '${control.state}'`);
    }
    const codec = createCodec(storeKey);
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
          if (isTargetFormatRow(colName, data)) {
            tDocs.push(doc);
          } else {
            sDocs.push(doc);
          }
        }
        sourceDocsByKey.set(srcKey, sDocs);
        targetDocsByKey.set(tgtKey, tDocs);
      }
    }
    const { candidates, sourceInventoryDigest, expectedTargetCounts, physicalCounts, classifications, reasons, planSpec, planDigest, plan } = extractCandidatesAndPlan({
      sourceDocsByKey,
      storeKey,
      namespace,
      subject: subjectSpecForDb(db, namespace, storeKey),
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
    timer.assertUnderDeadline("Preflight scan");
    const targetDocMapById = /* @__PURE__ */ new Map();
    for (const [colKey, docs] of targetDocsByKey.entries()) {
      for (const d of docs) {
        targetDocMapById.set(`${colKey}:${d.id}`, { collection: colKey, physicalId: d.id, data: d.data() || {} });
      }
    }
    let prospectiveRetained = 0;
    const claimedTargetIds = /* @__PURE__ */ new Set();
    for (const c of candidates) {
      const targetEntries = c.targets.map((target) => targetDocMapById.get(`${target.collection}:${target.rawId}`)).filter(Boolean);
      const existingCount = targetEntries.length;
      if (existingCount === 0) {
        continue;
      }
      if (existingCount !== c.targets.length) {
        reasons.partialTargets++;
        for (const t of c.targets) {
          const key2 = `${t.collection}:${t.rawId}`;
          if (targetDocMapById.has(key2)) claimedTargetIds.add(key2);
        }
        continue;
      }
      let derivedDigest;
      try {
        const decodedLogical = projectTargetLogical(c, buildTargetProjectionMap(c, targetEntries), codec);
        derivedDigest = H(storeKey, "logical-record", namespace, control.epoch, [c.kind, decodedLogical]);
      } catch (err) {
        if (!isCutoverFenceError(err)) throw err;
        reasons.partialTargets++;
        for (const t of c.targets) {
          const key2 = `${t.collection}:${t.rawId}`;
          if (targetDocMapById.has(key2)) claimedTargetIds.add(key2);
        }
        continue;
      }
      if (derivedDigest === c.logicalDigest) {
        prospectiveRetained++;
        for (const t of c.targets) {
          claimedTargetIds.add(`${t.collection}:${t.rawId}`);
        }
      } else {
        reasons.partialTargets++;
        for (const t of c.targets) {
          const key2 = `${t.collection}:${t.rawId}`;
          if (targetDocMapById.has(key2)) claimedTargetIds.add(key2);
        }
      }
    }
    for (const key2 of targetDocMapById.keys()) {
      if (!claimedTargetIds.has(key2)) {
        reasons.partialTargets++;
      }
    }
    const preflight = computePreflightSummaryFromPlan(plan, sourceInventoryDigest, planDigest);
    const prospectiveWritten = Object.values(expectedTargetCounts).reduce((a, b) => a + b, 0);
    return {
      sourceInventoryDigest,
      scanned: candidates.length,
      prospectiveWritten,
      prospectiveRetained,
      planDigest,
      physicalCounts,
      classifications,
      reasons,
      expectedTargetCounts,
      preflight
    };
  }, { readOnly: true });
}
__name(inspectFirestoreLegacyMigration, "inspectFirestoreLegacyMigration");
function requiredFieldsFromPlan(namespace, plan, subjectBound) {
  const required = /* @__PURE__ */ new Map();
  for (const write of prospectiveWrites(namespace, plan)) {
    const paths = required.get(write.group) ?? /* @__PURE__ */ new Set();
    for (const path of concreteFieldPaths(write.document).multiplicity.keys()) paths.add(path);
    required.set(write.group, paths);
  }
  if (subjectBound) {
    const refreshFamilies = `${namespace}_refresh_families`;
    const paths = required.get(refreshFamilies) ?? /* @__PURE__ */ new Set();
    paths.add("subjectRefs");
    required.set(refreshFamilies, paths);
  }
  return Object.fromEntries([...required].map(([group, paths]) => [group, [...paths].sort()]));
}
__name(requiredFieldsFromPlan, "requiredFieldsFromPlan");
async function readPreparationInputs(transaction, input) {
  const { db, namespace, epoch, storeKey, FieldPath, migrationRunId, codeSha, codeArtifact, packageIntegrity, protocolDigest, assemblyDigest, indexSchemaDigest } = input;
  const docIdField = FieldPath.documentId();
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
        if (!isTargetFormatRow(colName, data)) {
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
    subject: subjectSpecForDb(db, namespace, storeKey),
    epoch,
    runId: migrationRunId,
    codeSha,
    codeArtifact,
    packageIntegrity,
    protocolDigest,
    assemblyDigest,
    indexSchemaDigest,
    now: Date.now()
  });
  return { candidates, sourceInventoryDigest, plan };
}
__name(readPreparationInputs, "readPreparationInputs");
async function adoptFirestoreLegacyTokens(options) {
  assertValidMigrationContext2(options, ["dryRun", "expectedSourceInventoryDigest"]);
  const binding = assertProtectedContext(options, {
    operation: "adopt",
    options: { dryRun: options.dryRun, expectedSourceInventoryDigest: options.expectedSourceInventoryDigest }
  });
  options = { ...options, key: binding.key };
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
      throw new CutoverFenceError(`Unknown option '${k}' passed to adoptFirestoreLegacyTokens`);
    }
  }
  if (typeof options.dryRun !== "boolean") {
    throw new CutoverFenceError("adoptFirestoreLegacyTokens requires boolean dryRun option");
  }
  if (typeof options.expectedSourceInventoryDigest !== "string" || !/^[0-9a-f]{64}$/.test(options.expectedSourceInventoryDigest)) {
    throw new CutoverFenceError("adoptFirestoreLegacyTokens requires 64-character lowercase hex expectedSourceInventoryDigest");
  }
  const { db, FieldPath, key, namespace, expectedEpoch, migrationRunId, codeSha, codeArtifact, packageIntegrity, protocolDigest, dryRun, expectedSourceInventoryDigest } = options;
  const { assemblyDigest, indexSchemaDigest } = protectedBootstrapBindings(db);
  const storeKey = key;
  const codec = createCodec(storeKey);
  const docIdField = FieldPath.documentId();
  const observed = await db.runTransaction(async (transaction) => {
    const timer = startMonotonicTimer();
    assertCredentialUnchanged(db);
    const control = await readCutoverFenceInTransaction(transaction, db, namespace);
    if (control.epoch !== expectedEpoch || control.state !== "fenced") return null;
    const inputs = await readPreparationInputs(transaction, {
      db,
      namespace,
      epoch: control.epoch,
      storeKey,
      FieldPath,
      migrationRunId,
      codeSha,
      codeArtifact,
      packageIntegrity,
      protocolDigest,
      assemblyDigest,
      indexSchemaDigest
    });
    timer.assertUnderDeadline("Preparation observation scan");
    if (inputs.sourceInventoryDigest !== expectedSourceInventoryDigest) {
      throw new CutoverFenceError(`Source inventory digest mismatch: expected ${expectedSourceInventoryDigest}, observed ${inputs.sourceInventoryDigest}`);
    }
    const errors = Object.values(inputs.plan.prepared.reasons || {}).reduce((a, b) => a + (typeof b === "number" ? b : 0), 0);
    if (errors > 0) return null;
    return { sourceInventoryDigest: inputs.sourceInventoryDigest, requiredFields: requiredFieldsFromPlan(namespace, inputs.plan, subjectSpecForDb(db, namespace, storeKey) !== null) };
  });
  if (observed !== null) {
    await observeFreshIndexes({ db, purpose: "preparation", requiredFields: observed.requiredFields, sourceInventoryDigest: observed.sourceInventoryDigest });
  }
  const prepResult = await db.runTransaction(async (transaction) => {
    const timer = startMonotonicTimer();
    assertCredentialUnchanged(db);
    const control = await readCutoverFenceInTransaction(transaction, db, namespace);
    if (control.epoch !== expectedEpoch) {
      throw new CutoverFenceError(`Epoch mismatch in adopt: expected ${expectedEpoch}, got ${control.epoch}`);
    }
    if (control.state === "migrating") {
      if (dryRun) {
        throw new CutoverFenceError("Dry-run inspection cannot resume a migration already in progress");
      }
      if (control.migrationRunId !== migrationRunId) {
        throw new CutoverFenceError(`Cannot resume migration for namespace ${namespace}: migrationRunId mismatch`);
      }
      const prepRef = db.collection(`${namespace}_meta`).doc(`migration_prepared_${control.epoch}`);
      const prepSnap = await transaction.get(prepRef);
      if (!prepSnap.exists) {
        throw new CutoverFenceError(`Prepared manifest missing during resume of migrating namespace ${namespace}`);
      }
      const prepDoc = prepSnap.data();
      validateMigrationIdentityFields(prepDoc, namespace, expectedEpoch, migrationRunId);
      if (prepDoc.kind !== "prepared" || prepDoc.sourceInventoryDigest !== expectedSourceInventoryDigest || prepDoc.codeSha !== codeSha || prepDoc.codeArtifact !== codeArtifact || prepDoc.packageIntegrity !== packageIntegrity || prepDoc.protocolDigest !== protocolDigest || prepDoc.assemblyDigest !== assemblyDigest || prepDoc.indexSchemaDigest !== indexSchemaDigest) {
        throw new CutoverFenceError("Prepared manifest identity or inventory mismatch during resume");
      }
      if (prepDoc.encoderVersion !== 1 || prepDoc.namespace !== namespace || prepDoc.epoch !== expectedEpoch || prepDoc.migrationRunId !== migrationRunId || control.migrationRunId !== migrationRunId) {
        throw new CutoverFenceError("Prepared manifest identity does not match the control record during resume");
      }
      assertPreparedIdentity(prepDoc, {
        namespace,
        epoch: expectedEpoch,
        migrationRunId,
        codeSha,
        codeArtifact,
        packageIntegrity,
        protocolDigest,
        assemblyDigest,
        indexSchemaDigest,
        encoderVersion: 1
      }, namespace);
      validateMapKeysExact(
        prepDoc,
        prepDoc.totalPhysicalRecords > 0 ? [...REQUIRED_PREPARED_MANIFEST_KEYS, ...NONEMPTY_PROJECTOR_KEYS] : REQUIRED_PREPARED_MANIFEST_KEYS,
        "prepared manifest"
      );
      const computedPlanDigest = computePlanDigest(namespace, control.epoch, prepDoc.planSpec);
      if (prepDoc.planDigest !== computedPlanDigest) {
        throw new CutoverFenceError("prepDoc.planDigest does not match computePlanDigest(prepDoc.planSpec)");
      }
      timer.assertUnderDeadline("Preparation resume check");
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
    const existingPreparedRef = db.collection(`${namespace}_meta`).doc(`migration_prepared_${control.epoch}`);
    if ((await transaction.get(existingPreparedRef)).exists) {
      throw new CutoverFenceError(`Inconsistent state: prepared manifest exists while cutover state is 'fenced' for namespace ${namespace}`);
    }
    timer.assertUnderDeadline("Fenced prepared check");
    const { candidates: candidates2, sourceInventoryDigest, plan } = await readPreparationInputs(transaction, {
      db,
      namespace,
      epoch: control.epoch,
      storeKey,
      FieldPath,
      migrationRunId,
      codeSha,
      codeArtifact,
      packageIntegrity,
      protocolDigest,
      assemblyDigest,
      indexSchemaDigest
    });
    timer.assertUnderDeadline("Preparation source scan");
    const preparationBinding = getProtectedBinding(db);
    if (!preparationBinding) throw new CutoverRefusedError("Protected migration context required for preparation");
    assertSupportedCutoverNamespace(preparationBinding.namespace);
    const preparationIdentity = {
      namespace: preparationBinding.namespace,
      epoch: preparationBinding.expectedEpoch,
      migrationRunId: preparationBinding.migrationRunId,
      codeSha: preparationBinding.codeSha,
      codeArtifact: preparationBinding.codeArtifact,
      packageIntegrity: preparationBinding.packageIntegrity,
      protocolDigest: preparationBinding.protocolDigest,
      assemblyDigest: preparationBinding.assemblyDigest,
      indexSchemaDigest: preparationBinding.indexSchemaDigest,
      indexPolicyDigest: preparationBinding.indexPolicyDigest,
      encoderVersion: 1
    };
    if (sourceInventoryDigest !== expectedSourceInventoryDigest) {
      throw new CutoverFenceError(
        `Source inventory digest mismatch: expected ${expectedSourceInventoryDigest}, observed ${sourceInventoryDigest}`
      );
    }
    const totalErrors = Object.values(plan.prepared.reasons || {}).reduce((a, b) => a + (typeof b === "number" ? b : 0), 0);
    if (dryRun) {
      timer.assertUnderDeadline("Dry run inspection");
      if (totalErrors === 0) {
        assertPreparationGate(db, { completePlan: plan, expectedIdentity: preparationIdentity, sourceInventoryDigest });
      }
      return {
        dryRun: true,
        scanned: candidates2.length,
        migrated: 0,
        skipped: 0,
        errors: totalErrors
      };
    }
    if (totalErrors > 0) {
      throw new CutoverFenceError(
        `Cannot prepare migration for namespace ${namespace}: detected ${totalErrors} error(s) in source inventory (${JSON.stringify(plan.prepared.reasons)})`
      );
    }
    timer.assertUnderDeadline("Preparation attempt");
    assertPreparationGate(db, { completePlan: plan, expectedIdentity: preparationIdentity, sourceInventoryDigest });
    await prepareMigrationInTransaction(transaction, db, {
      namespace,
      prepDoc: plan.prepared,
      storeKey,
      FieldPath,
      timer,
      completePlan: plan,
      expectedIdentity: preparationIdentity,
      indexManifest: preparationBinding.indexSchema,
      protectedBinding: {
        profile: preparationBinding.profile,
        project: preparationBinding.project,
        database: preparationBinding.database,
        subjectDescriptor: preparationBinding.subjectDescriptor
      }
    });
    timer.assertUnderDeadline("Preparation commit");
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
  const { prepared, isResume } = prepResult;
  let candidates = prepResult.isResume ? [] : prepResult.candidates;
  let migratedCount = 0;
  let skippedCount = 0;
  if (isResume) {
    const { source: sourceNames, target: targetNames } = getCutoverDistinctCollectionNames(namespace);
    const sourceDocsByKey = /* @__PURE__ */ new Map();
    const sourceAfter = /* @__PURE__ */ new Map();
    const targetAfter = /* @__PURE__ */ new Map();
    const targetNamesSet = new Set(Object.values(targetNames));
    const sourceNamesSet = new Set(Object.values(sourceNames));
    for (const [k, colName] of Object.entries(sourceNames)) {
      const snap = await db.collection(colName).orderBy(docIdField).get();
      const docs = targetNamesSet.has(colName) ? snap.docs.filter((d) => !isTargetFormatRow(colName, d.data())) : snap.docs;
      sourceDocsByKey.set(k, docs);
      for (const d of docs) {
        const id = computeKeyedDocId(storeKey, "source-id", namespace, expectedEpoch, k, d.id);
        sourceAfter.set(`${k}:${id}`, computeSourceRecordDigest(storeKey, namespace, expectedEpoch, k, id, d.data()));
      }
    }
    for (const [k, colName] of Object.entries(targetNames)) {
      const snap = await db.collection(colName).orderBy(docIdField).get();
      const docs = sourceNamesSet.has(colName) ? snap.docs.filter((d) => isTargetFormatRow(colName, d.data())) : snap.docs;
      for (const d of docs) {
        const id = computeKeyedDocId(storeKey, "target-id", namespace, expectedEpoch, k, d.id);
        targetAfter.set(`${k}:${id}`, computeTargetRecordDigest(storeKey, namespace, expectedEpoch, k, id, d.data()));
      }
    }
    const receipts = await db.collection(`${namespace}_meta`).orderBy(docIdField).startAt(`migration_receipt_${expectedEpoch}_`).endBefore(`migration_receipt_${expectedEpoch}\``).get();
    const commitments = new Map(
      prepared.candidateCommitments.map((c) => [c.id, c])
    );
    const completed = /* @__PURE__ */ new Set();
    for (const receiptSnapshot of receipts.docs) {
      const data = receiptSnapshot.data();
      validateReceipt(data, namespace, expectedEpoch, migrationRunId);
      const receipt = data;
      const commitment = commitments.get(receipt.candidateId);
      if (!commitment || completed.has(receipt.candidateId) || receiptSnapshot.id !== `migration_receipt_${expectedEpoch}_${receipt.candidateId}` || receipt.preparedDigest !== D("prepared", namespace, expectedEpoch, prepared) || receipt.candidateDigest !== D("candidate", namespace, expectedEpoch, commitment) || receipt.logicalDigest !== commitment.logicalDigest || REQUIRED_IDENTITY_KEYS.some((key2) => receipt[key2] !== prepared[key2])) {
        throw new CutoverFenceError("Resume receipt does not match its prepared candidate");
      }
      const plans = prepared.planSpec.candidates;
      const itemPlan = plans.find((item) => item.candidateId === receipt.candidateId);
      const refs = /* @__PURE__ */ __name((items) => items.map((item) => `${item.collection}:${item.id}`).sort(codeUnitCompare), "refs");
      if (!itemPlan || C(refs(receipt.sourceAfter)) !== C(refs(commitment.sources)) || C(refs(receipt.targetAfter)) !== C(refs(commitment.targets))) {
        throw new CutoverFenceError("Resume receipt does not cover its prepared references");
      }
      for (const source of receipt.sourceAfter) {
        const action = itemPlan.sourceActions.find((a) => a.collection === source.collection && a.id === source.id);
        const before = commitment.sources.find((s) => s.collection === source.collection && s.id === source.id);
        const expected = action?.action === "retain" ? before?.recordDigest : null;
        if (!action || source.recordDigest !== expected || (sourceAfter.get(`${source.collection}:${source.id}`) ?? null) !== expected) {
          throw new CutoverFenceError("Resume receipt source postimage mismatch");
        }
      }
      for (const target of receipt.targetAfter) {
        if (targetAfter.get(`${target.collection}:${target.id}`) !== target.recordDigest) {
          throw new CutoverFenceError("Resume receipt target postimage mismatch");
        }
      }
      completed.add(receipt.candidateId);
      if (receipt.disposition === "retained") skippedCount++;
      else migratedCount++;
    }
    const reconstructed = extractCandidatesAndPlan({
      sourceDocsByKey,
      storeKey,
      namespace,
      subject: subjectSpecForDb(db, namespace, storeKey),
      epoch: expectedEpoch,
      runId: migrationRunId,
      codeSha,
      codeArtifact,
      packageIntegrity,
      protocolDigest,
      assemblyDigest,
      indexSchemaDigest,
      now: Date.now()
    });
    candidates = reconstructed.candidates;
    if (Object.values(reconstructed.reasons).some((count) => count !== 0) || candidates.length + completed.size !== commitments.size || candidates.some((c) => completed.has(c.id) || C(c.commitment) !== C(commitments.get(c.id)))) {
      throw new CutoverFenceError("Resume source inventory does not match the pending prepared candidates");
    }
  }
  const now = Date.now();
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
  const expectedPreparedDigest = D("prepared", namespace, expectedEpoch, prepared);
  for (const c of candidates) {
    const itemResult = await db.runTransaction(async (transaction) => {
      const timer = startMonotonicTimer();
      assertCredentialUnchanged(db);
      const control = await readCutoverFenceInTransaction(transaction, db, namespace);
      if (control.epoch !== expectedEpoch) throw new CutoverFenceError("Migration epoch changed before item transaction");
      if (control.state !== "migrating") {
        throw new CutoverFenceError(`Cannot execute item: state must be 'migrating', got '${control.state}'`);
      }
      if (control.migrationRunId !== migrationRunId) {
        throw new CutoverFenceError("migrationRunId mismatch during item transaction");
      }
      const prepRef = db.collection(`${namespace}_meta`).doc(`migration_prepared_${control.epoch}`);
      const prepSnap = await transaction.get(prepRef);
      if (!prepSnap.exists) {
        throw new CutoverFenceError(`Prepared manifest missing in item transaction for namespace ${namespace}`);
      }
      const prepDoc = prepSnap.data();
      validateMigrationIdentityFields(prepDoc, namespace, expectedEpoch, migrationRunId);
      if (prepDoc.migrationRunId !== migrationRunId || prepDoc.epoch !== control.epoch) {
        throw new CutoverFenceError("migration_prepared identity mismatch in item transaction");
      }
      if (prepDoc.codeSha !== codeSha || prepDoc.codeArtifact !== codeArtifact || prepDoc.protocolDigest !== protocolDigest) {
        throw new CutoverFenceError("migration_prepared provenance mismatch in item transaction");
      }
      if (D("prepared", namespace, control.epoch, prepDoc) !== expectedPreparedDigest) {
        throw new CutoverFenceError("Prepared manifest changed before item transaction");
      }
      const candidateCommitment = prepDoc.candidateCommitments?.find((item) => item.id === c.id);
      if (!candidateCommitment) {
        throw new CutoverFenceError(`Candidate ${sanitizeId(c.id)} not bound in prepared manifest commitments`);
      }
      if (!c.commitment || C(candidateCommitment) !== C(c.commitment)) {
        throw new CutoverFenceError("Candidate commitment changed before item transaction");
      }
      const receiptRef = db.collection(`${namespace}_meta`).doc(`migration_receipt_${control.epoch}_${c.id}`);
      const receiptSnap = await transaction.get(receiptRef);
      if (receiptSnap.exists) {
        const rData = receiptSnap.data();
        if (rData && rData.candidateId === c.id && rData.kind === "receipt") {
          validateReceipt(rData, namespace, control.epoch, control.migrationRunId);
          for (const t of rData.targetAfter) {
            const physicalCol = targetColMap[t.collection];
            if (physicalCol) {
              const post = c.postimageByTargetId?.get(t.id);
              const docId = post?.id || post?.code || post?.client_id || post?.fingerprint || t.rawId;
              const targetSnap = await transaction.get(db.collection(physicalCol).doc(docId));
              if (!targetSnap.exists) {
                throw new CutoverFenceError(`Receipt exists for ${sanitizeId(c.id)} but target '${t.collection}/${sanitizeId(docId)}' missing in Firestore`);
              }
              const recDigest = computeTargetRecordDigest(storeKey, namespace, control.epoch, t.collection, t.id, targetSnap.data());
              if (recDigest !== t.recordDigest) {
                throw new CutoverFenceError(`Receipt exists for ${sanitizeId(c.id)} but target '${t.collection}/${sanitizeId(docId)}' recordDigest mismatch`);
              }
            }
          }
          timer.assertUnderDeadline("Item retry check");
          return { status: rData.disposition === "retained" ? "retained" : "written" };
        }
      }
      for (const s of c.sources) {
        const physicalCol = colMap[s.collection];
        if (physicalCol && s.rawId) {
          const docSnap = await transaction.get(db.collection(physicalCol).doc(s.rawId));
          if (!docSnap.exists) {
            throw new CutoverFenceError(`Source document '${s.collection}/${sanitizeId(s.rawId)}' disappeared concurrently`);
          }
          const recDigest = computeSourceRecordDigest(storeKey, namespace, control.epoch, s.collection, s.id, docSnap.data() || {});
          if (recDigest !== s.recordDigest) {
            throw new CutoverFenceError(`Source document '${s.collection}/${sanitizeId(s.rawId)}' modified concurrently after preparation`);
          }
        }
      }
      for (const t of c.targets) {
        const post = c.postimageByTargetId?.get(t.id);
        const physicalCol = targetColMap[t.collection];
        if (!post || !physicalCol) {
          throw new CutoverFenceError(`Missing prospective target postimage or mapping for target ${t.collection}:${sanitizeId(t.id)}`);
        }
      }
      const prospectiveEntries = c.targets.map((t) => ({
        collection: t.collection,
        physicalId: t.rawId,
        data: c.postimageByTargetId.get(t.id)
      }));
      const prospectiveLogical = projectTargetLogical(c, buildTargetProjectionMap(c, prospectiveEntries), codec);
      if (H(storeKey, "logical-record", namespace, control.epoch, [c.kind, prospectiveLogical]) !== c.logicalDigest) {
        throw new CutoverFenceError("Candidate target postimages do not match the source projection");
      }
      let allTargetsAlreadyRetained = true;
      let hasAnyTarget = false;
      const existingTargetEntries = [];
      const retainedTargetRows = /* @__PURE__ */ new Map();
      for (const t of c.targets) {
        const physicalCol = targetColMap[t.collection];
        const docId = t.rawId;
        if (computeKeyedDocId(storeKey, "target-id", namespace, control.epoch, t.collection, docId) !== t.id) throw new CutoverFenceError("Candidate target identity changed");
        const targetSnap = await transaction.get(db.collection(physicalCol).doc(docId));
        if (targetSnap.exists) {
          hasAnyTarget = true;
          existingTargetEntries.push({ collection: t.collection, physicalId: docId, data: targetSnap.data() || {} });
          retainedTargetRows.set(t.id, targetSnap.data());
        } else {
          allTargetsAlreadyRetained = false;
        }
      }
      if (hasAnyTarget) {
        if (!allTargetsAlreadyRetained) {
          throw new CutoverFenceError(`Conflicting partial target graph detected for candidate ${sanitizeId(c.id)}; cannot overwrite`);
        }
        try {
          const existingLogical = projectTargetLogical(c, buildTargetProjectionMap(c, existingTargetEntries), codec);
          if (C(existingLogical) !== C(c.logicalDigest)) {
            const derivedDigest = H(storeKey, "logical-record", namespace, control.epoch, [c.kind, existingLogical]);
            if (derivedDigest !== c.logicalDigest) {
              throw new CutoverFenceError(`Conflicting target document content detected for candidate ${sanitizeId(c.id)}; cannot overwrite`);
            }
          }
        } catch (err) {
          throw new CutoverFenceError(`Conflicting target document format detected for candidate ${sanitizeId(c.id)}: ${err.message}`);
        }
      }
      timer.assertUnderDeadline("Item transaction attempt");
      if (control.emptyNamespace !== true) {
        await markIrreversibleInTransaction(transaction, db, namespace, control.epoch, migrationRunId, () => now, timer);
      }
      for (const sa of c.sourceActions) {
        const physicalCol = colMap[sa.collection];
        if (physicalCol && sa.rawId && sa.action === "delete") {
          transaction.delete(db.collection(physicalCol).doc(sa.rawId));
        }
      }
      if (!allTargetsAlreadyRetained) {
        for (const t of c.targets) {
          const post = c.postimageByTargetId.get(t.id);
          const physicalCol = targetColMap[t.collection];
          const docId = t.rawId;
          transaction.set(db.collection(physicalCol).doc(docId), post);
        }
      }
      const targetAfter = c.targets.map((t) => {
        const post = allTargetsAlreadyRetained ? retainedTargetRows.get(t.id) : c.postimageByTargetId.get(t.id);
        const recDigest = computeTargetRecordDigest(storeKey, namespace, control.epoch, t.collection, t.id, post);
        return { collection: t.collection, id: t.id, recordDigest: recDigest };
      });
      const sourceAfter = c.sources.map((s) => {
        const sa = c.sourceActions?.find((a) => a.collection === s.collection && a.id === s.id);
        return {
          collection: s.collection,
          id: s.id,
          recordDigest: sa?.action === "delete" || sa?.action === "replace" ? null : s.recordDigest
        };
      });
      const disposition = allTargetsAlreadyRetained ? "retained" : "written";
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
        preparedDigest: D("prepared", namespace, control.epoch, prepDoc),
        candidateId: c.id,
        candidateDigest: D("candidate", namespace, control.epoch, c.commitment || c),
        disposition,
        sourceAfter,
        targetAfter,
        logicalDigest: c.logicalDigest,
        completedAt: now
      };
      transaction.set(receiptRef, receiptDoc);
      timer.assertUnderDeadline("Item transaction commit");
      return { status: disposition };
    });
    if (itemResult.status === "retained") {
      skippedCount++;
    } else {
      migratedCount++;
    }
  }
  await db.runTransaction(async (transaction) => {
    const timer = startMonotonicTimer();
    assertCredentialUnchanged(db);
    const control = await readCutoverFenceInTransaction(transaction, db, namespace);
    if (control.state !== "migrating") {
      throw new CutoverFenceError(`Cannot finalize: state must be 'migrating', got '${control.state}'`);
    }
    const receiptsCol = db.collection(`${namespace}_meta`);
    const lowerBound = `migration_receipt_${control.epoch}_`;
    const upperBound = `migration_receipt_${control.epoch}\``;
    const receiptsSnap = await transaction.get(receiptsCol.orderBy(docIdField).startAt(lowerBound).endBefore(upperBound));
    const actualReceipts = receiptsSnap.docs.map((d) => d.data());
    const targetDescriptors = [];
    const targetRowsById = /* @__PURE__ */ new Map();
    const targetCounts = Object.fromEntries(TARGET_COUNT_KEYS.map((key2) => [key2, 0]));
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
        if (["authCodes", "resumeTokens", "oauthClients"].includes(colKey) && !isTargetFormatRow(physicalName, data)) continue;
        const targetId = computeKeyedDocId(storeKey, "target-id", namespace, control.epoch, colKey, d.id);
        const recDigest = computeTargetRecordDigest(storeKey, namespace, control.epoch, colKey, targetId, data);
        targetDescriptors.push({ collection: colKey, id: targetId, recordDigest: recDigest });
        targetCounts[colKey]++;
        targetRowsById.set(`${colKey}:${targetId}`, { ...data, id: d.id });
      }
    }
    targetDescriptors.sort(compareDescriptors);
    const logicalItems = [];
    const commitments = prepared.candidateCommitments;
    for (const candidate of commitments) {
      const targets = /* @__PURE__ */ new Map();
      const retiredIds = [];
      const rows = candidate.targets.map((ref) => {
        const row = targetRowsById.get(`${ref.collection}:${ref.id}`);
        if (!row) throw new CutoverFenceError("Final target graph is incomplete");
        return { ref, row };
      });
      const family = rows.find(({ ref }) => ref.collection === "families")?.row;
      for (const { ref, row } of rows) {
        if (ref.collection === "refresh") {
          if (!family || row.familyId !== family.id) throw new CutoverFenceError("Final refresh family mismatch");
          const role = row.id === family.activeRefreshId ? "activeRefresh" : "prevRefresh";
          if (targets.has(role)) throw new CutoverFenceError("Duplicate final refresh role");
          targets.set(role, row);
        } else if (ref.collection === "retiredRefreshTokens") {
          if (!family || row.familyId !== family.id) throw new CutoverFenceError("Final retired refresh family mismatch");
          retiredIds.push(row.id);
        } else {
          const role = ref.collection === "oauthClients" ? "clients" : ref.collection;
          if (targets.has(role)) throw new CutoverFenceError("Duplicate final target role");
          targets.set(role, row);
        }
      }
      if (retiredIds.length) targets.set("retiredRefresh", { ids: retiredIds.sort(codeUnitCompare) });
      const logical = projectTargetLogical(candidate, targets, codec);
      const digest = H(storeKey, "logical-record", namespace, control.epoch, [candidate.kind, logical]);
      if (digest !== candidate.logicalDigest) throw new CutoverFenceError("Final target semantic mismatch");
      logicalItems.push([candidate.id, digest]);
    }
    const targetLogicalDigest = computeLogicalInventoryDigest(storeKey, namespace, control.epoch, logicalItems);
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
      preparedDigest: D("prepared", namespace, control.epoch, prepared),
      completedAt: Date.now(),
      physicalCounts: prepared.physicalCounts,
      classifications: prepared.classifications,
      reasons: prepared.reasons,
      totalPhysicalRecords: prepared.totalPhysicalRecords,
      targetCounts,
      scanned: prepared.scanned,
      migrated: migratedCount,
      skipped: skippedCount,
      errors: 0,
      sourceInventoryDigest: prepared.sourceInventoryDigest,
      targetInventoryDigest,
      sourceLogicalDigest: prepared.sourceLogicalDigest,
      targetLogicalDigest,
      receiptSetDigest
    };
    const finalManifestDigest = D("final", namespace, control.epoch, finalDoc);
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
      preparedDigest: D("prepared", namespace, control.epoch, prepared),
      migrationManifestDigest: finalManifestDigest,
      emptyNamespace: prepared.totalPhysicalRecords === 0,
      adoptedAt: Date.now()
    };
    timer.assertUnderDeadline("Finalization attempt");
    await finalizeMigrationInTransaction(transaction, db, {
      namespace,
      finalDoc,
      markerDoc,
      storeKey,
      FieldPath,
      timer
    });
    timer.assertUnderDeadline("Finalization commit");
  });
  return {
    scanned: prepared.scanned,
    migrated: migratedCount,
    skipped: skippedCount,
    errors: 0
  };
}
__name(adoptFirestoreLegacyTokens, "adoptFirestoreLegacyTokens");
async function verifyActiveFirestoreMigration(context) {
  assertValidMigrationContext2(context, ["migrationManifestDigest"]);
  const binding = assertProtectedContext(context, { operation: "verifyActive", options: { migrationManifestDigest: context.migrationManifestDigest } });
  context = { ...context, key: binding.key };
  if (typeof context.migrationManifestDigest !== "string" || !/^[0-9a-f]{64}$/.test(context.migrationManifestDigest)) {
    throw new CutoverFenceError("migrationManifestDigest must be a 64-character lowercase hex string");
  }
  const verifyActive = verifyActiveMigrationInTransaction;
  if (typeof verifyActive !== "function") {
    throw new CutoverRefusedError("Active verification requires verifyActiveMigrationInTransaction from the reviewed canonical core, which this build does not export");
  }
  return context.db.runTransaction(async (transaction) => {
    const timer = startMonotonicTimer();
    const result = await verifyActive(transaction, context.db, {
      ...context,
      storeKey: context.key,
      timer
    });
    timer.assertUnderDeadline("Active ownership verification");
    return result;
  }, { readOnly: true });
}
__name(verifyActiveFirestoreMigration, "verifyActiveFirestoreMigration");
async function activateFirestoreMigration(context) {
  assertValidMigrationContext2(context, ["migrationManifestDigest"]);
  const binding = assertProtectedContext(context, { operation: "activate", options: { migrationManifestDigest: context.migrationManifestDigest } });
  context = { ...context, key: binding.key };
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
    "migrationManifestDigest"
  ]);
  for (const k of Object.keys(context)) {
    if (!allowedKeys.has(k)) {
      throw new CutoverFenceError(`Unknown option '${k}' passed to activateFirestoreMigration`);
    }
  }
  const { db, namespace, expectedEpoch, migrationRunId, key, migrationManifestDigest } = context;
  if (!/^[0-9a-f]{64}$/.test(migrationManifestDigest)) {
    throw new CutoverFenceError("migrationManifestDigest must be a 64-character lowercase hex string");
  }
  const fenceBefore = await getCutoverFenceRecord(db, namespace);
  if (fenceBefore?.state === "v3_ready") {
    await observeFreshIndexes({ db, purpose: "activation", requiredFields: {}, sourceInventoryDigest: null });
  }
  return await db.runTransaction(async (transaction) => {
    const timer = startMonotonicTimer();
    assertCredentialUnchanged(db);
    const control = await readCutoverFenceInTransaction(transaction, db, namespace);
    if (control.epoch !== expectedEpoch || control.migrationRunId !== migrationRunId || control.migrationManifestDigest !== migrationManifestDigest) {
      throw new CutoverFenceError("Activation control identity or manifest digest mismatch");
    }
    if (control.state !== "v3_ready" && control.state !== "v3_active") {
      throw new CutoverFenceError(`Cannot activate namespace ${namespace}: state must be v3_ready or v3_active`);
    }
    if (control.state === "v3_ready") {
      const binding2 = getProtectedBinding(db);
      if (!binding2) throw new CutoverRefusedError("Protected migration context required for activation");
      assertActivationObservation(db, binding2);
    }
    const finalSnap = await transaction.get(db.collection(`${namespace}_meta`).doc(`migration_manifest_${expectedEpoch}`));
    if (!finalSnap.exists) throw new CutoverFenceError("Final migration manifest is missing");
    const finalDoc = finalSnap.data();
    validateMigrationIdentityFields(finalDoc, namespace, expectedEpoch, migrationRunId);
    if (D("final", namespace, expectedEpoch, finalDoc) !== migrationManifestDigest || typeof finalDoc.planDigest !== "string" || !/^[0-9a-f]{64}$/.test(finalDoc.planDigest)) {
      throw new CutoverFenceError("Final migration manifest digest or plan binding mismatch");
    }
    if (control.state === "v3_ready") {
      const { assemblyDigest, indexSchemaDigest } = protectedBootstrapBindings(context.db);
      if (finalDoc.assemblyDigest !== assemblyDigest || finalDoc.indexSchemaDigest !== indexSchemaDigest) {
        throw new CutoverFenceError("Final migration manifest bootstrap bindings mismatch");
      }
    }
    timer.assertUnderDeadline("Activation attempt");
    const res = await activateMigrationInTransaction(transaction, db, {
      ...context,
      storeKey: key,
      migrationManifestDigest,
      timer
    });
    timer.assertUnderDeadline("Activation commit");
    return {
      status: res.status,
      epoch: control.epoch,
      migrationRunId,
      migrationManifestDigest,
      planDigest: finalDoc.planDigest
    };
  });
}
__name(activateFirestoreMigration, "activateFirestoreMigration");
async function getFirestoreMigrationStatus(context) {
  assertValidMigrationContext2(context);
  const binding = assertProtectedContext(context, { operation: "status", options: {} });
  context = { ...context, key: binding.key };
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
  for (const k of Object.keys(context)) {
    if (!allowedKeys.has(k)) {
      throw new CutoverFenceError(`Unknown option '${k}' passed to getFirestoreMigrationStatus`);
    }
  }
  const { db, namespace, expectedEpoch, migrationRunId, codeArtifact, protocolDigest } = context;
  return await db.runTransaction(async (transaction) => {
    const timer = startMonotonicTimer();
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
      if (control.state === "v3_ready") {
        const { assemblyDigest, indexSchemaDigest } = protectedBootstrapBindings(context.db);
        if (marker.assemblyDigest !== assemblyDigest || marker.indexSchemaDigest !== indexSchemaDigest) {
          throw new CutoverFenceError("Immutable migration marker bootstrap bindings mismatch");
        }
      }
      const finalRef = db.collection(`${namespace}_meta`).doc(`migration_manifest_${control.epoch}`);
      const finalSnap = await transaction.get(finalRef);
      if (finalSnap.exists) {
        const f = finalSnap.data();
        if (control.state === "v3_ready") {
          const { assemblyDigest, indexSchemaDigest } = protectedBootstrapBindings(context.db);
          if (f.assemblyDigest !== assemblyDigest || f.indexSchemaDigest !== indexSchemaDigest) {
            throw new CutoverFenceError("Final migration manifest bootstrap bindings mismatch");
          }
        }
        planDigest = f.planDigest;
        sourceInventoryDigest = f.sourceInventoryDigest;
      }
    }
    timer.assertUnderDeadline("Status check");
    return {
      state: control.state,
      epoch: control.epoch,
      migrationRunId: control.migrationRunId,
      migrationManifestDigest: control.migrationManifestDigest,
      planDigest,
      sourceInventoryDigest
    };
  }, { readOnly: true });
}
__name(getFirestoreMigrationStatus, "getFirestoreMigrationStatus");

// src/cutover/writer-census-contract.mjs
import { createHash as createHash6 } from "node:crypto";
var CENSUS_SCHEMA = 2;
var OBSERVED_SCHEMA = 2;
var PROJECT = "phoneware-edge";
var PROJECT_NUMBER = "859122914438";
var DATABASE = "(default)";
var PRODUCTION_INVENTORY_BINDING = Object.freeze({ profile: "production", project: PROJECT, projectNumber: PROJECT_NUMBER, database: DATABASE });
var EMULATOR_INVENTORY_BINDING = Object.freeze({ profile: "emulator", project: "demo-netsapiens-cutover", projectNumber: null, database: "(default)" });
function assertInventoryBinding(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding) || JSON.stringify(Object.keys(binding).sort()) !== JSON.stringify(["database", "profile", "project", "projectNumber"])) throw new Error("Invalid inventory binding");
  const expected = binding.profile === "production" ? PRODUCTION_INVENTORY_BINDING : binding.profile === "emulator" ? EMULATOR_INVENTORY_BINDING : null;
  if (!expected || Object.keys(expected).some((key) => binding[key] !== expected[key])) throw new Error("Invalid inventory binding");
  return expected;
}
__name(assertInventoryBinding, "assertInventoryBinding");
var NAMESPACE_PATTERN = /^(mcp_|pwmcp_|readonly_mcp_)|^operations$/;
var DEFAULT_BOUNDS = Object.freeze({ namespaceMaxDocuments: 2e6, fullPassMaxDocuments: 2e6, maxServiceAccounts: 500 });
var sha256 = /* @__PURE__ */ __name((text) => createHash6("sha256").update(text).digest("hex"), "sha256");
var WRITE_PERMISSION_PATTERNS = Object.freeze([
  /^datastore\.(entities|databases|indexes|fields|backups)\.(create|update|delete)$/,
  /^datastore\.databases\.(import|bulkDelete)$/,
  /^firebaserules\.(releases|rulesets)\.(create|update|delete)$/,
  /^firebase\.[A-Za-z.]+\.(create|update|delete)$/
]);
var CONTROL_PERMISSION_PATTERNS = Object.freeze([
  /^iam\.serviceAccounts\.(actAs|getAccessToken|getOpenIdToken|getIdToken|signBlob|signJwt|implicitDelegation|setIamPolicy|create|delete|update|enable|undelete)$/,
  /^iam\.serviceAccountKeys\.(create|enable)$/,
  /^iam\.(roles|workloadIdentityPools|workloadIdentityPoolProviders)\.(create|update|delete|undelete|setIamPolicy)$/,
  /^resourcemanager\.(projects|folders|organizations)\.setIamPolicy$/,
  /^(run\.(services|jobs)|cloudfunctions\.functions|compute\.instances)\.(create|update|setIamPolicy)$/,
  /^run\.jobs\.(run|runWithOverrides)$/,
  /^compute\.instances\.(setMetadata|setServiceAccount)$/,
  /^compute\.projects\.setCommonInstanceMetadata$/,
  /^cloudbuild\.builds\.create$/,
  /^artifactregistry\.(repositories\.uploadArtifacts|tags\.(create|update))$/,
  /^appengine\.versions\.(create|update)$/,
  /^workflows\.workflows\.(create|update)$/,
  /^container\.pods\.(create|exec)$/
]);
var IMPERSONATION_PERMISSIONS = Object.freeze([
  "iam.serviceAccounts.getAccessToken",
  "iam.serviceAccounts.getOpenIdToken",
  "iam.serviceAccounts.signBlob",
  "iam.serviceAccounts.signJwt",
  "iam.serviceAccounts.implicitDelegation",
  "iam.serviceAccounts.actAs",
  "iam.serviceAccounts.setIamPolicy",
  "iam.serviceAccountKeys.create"
]);
var BASIC_ROLES = Object.freeze({
  "roles/owner": Object.freeze({ writer: true, controller: true, impersonation: true }),
  "roles/editor": Object.freeze({ writer: true, controller: true, impersonation: true }),
  "roles/viewer": Object.freeze({ writer: false, controller: false, impersonation: false })
});
var SERVICE_AGENT_PATTERNS = Object.freeze([
  /^service-\d+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/,
  /@gcp-sa-[a-z0-9-]+\.iam\.gserviceaccount\.com$/,
  /^\d+@cloudservices\.gserviceaccount\.com$/,
  /@firebase-sa-management\.iam\.gserviceaccount\.com$/
]);
var MACHINE_EMAIL_PATTERN = /@([a-z0-9-]+\.iam|developer|appspot|cloudbuild|cloudservices)\.gserviceaccount\.com$/;
var EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
var TOKEN_IN_TEXT = /ya29\.[A-Za-z0-9._-]+|Bearer\s+\S+/;
var CONDITIONAL_SURFACES = Object.freeze({
  "run-services": "run.googleapis.com",
  "run-revisions": "run.googleapis.com",
  "run-jobs": "run.googleapis.com",
  "cloud-functions": "cloudfunctions.googleapis.com",
  "compute-instances": "compute.googleapis.com",
  "app-engine": "appengine.googleapis.com",
  "workflows": "workflows.googleapis.com",
  "cloud-build-triggers": "cloudbuild.googleapis.com"
});
var COMPUTE_CAPABLE_APIS = Object.freeze({
  "run.googleapis.com": ["run-services", "run-revisions", "run-jobs"],
  "cloudfunctions.googleapis.com": ["cloud-functions"],
  "compute.googleapis.com": ["compute-instances"],
  "appengine.googleapis.com": ["app-engine"],
  "workflows.googleapis.com": ["workflows"],
  "cloudbuild.googleapis.com": ["cloud-build-triggers"],
  "container.googleapis.com": null,
  "batch.googleapis.com": null,
  "dataflow.googleapis.com": null,
  "composer.googleapis.com": null,
  "dataproc.googleapis.com": null,
  "aiplatform.googleapis.com": null,
  "cloudscheduler.googleapis.com": null,
  "cloudtasks.googleapis.com": null,
  "notebooks.googleapis.com": null
});
var SURFACES = Object.freeze([
  "iam-ancestry",
  "iam-project-policy",
  "iam-ancestor-policies",
  "iam-role-definitions",
  "service-accounts",
  "service-account-iam-policies",
  "service-account-keys",
  "enabled-services",
  "run-services",
  "run-revisions",
  "run-jobs",
  "cloud-functions",
  "compute-instances",
  "app-engine",
  "workflows",
  "cloud-build-triggers",
  "unsupported-compute",
  "image-attribution",
  "wif-pools",
  "wif-providers",
  "ci-admitted-state",
  "firestore-top-level",
  "firestore-namespace-walk",
  "firestore-full-pass",
  "firestore-ttl-fields",
  "firebase-rules-releases",
  "firebase-rulesets",
  "firebase-rules-tests"
]);
var lower = /* @__PURE__ */ __name((text) => text.toLowerCase(), "lower");
var humanSha = /* @__PURE__ */ __name((type, email) => sha256(`principal:${type}:${lower(email)}`), "humanSha");
function principalRecord(rawMember) {
  if (typeof rawMember !== "string" || !rawMember) throw new Error("principal must be a non-empty string");
  let member = rawMember;
  let deleted = false;
  if (member.startsWith("deleted:")) {
    deleted = true;
    member = member.slice("deleted:".length);
  }
  member = member.replace(/\?uid=[^?]*$/, "");
  const colon = member.indexOf(":");
  const prefix = colon > 0 ? member.slice(0, colon + 1) : "";
  const value = colon > 0 ? member.slice(colon + 1) : "";
  if (member.startsWith("principal://") || member.startsWith("principalSet://")) {
    if (member.includes("/locations/global/workforcePools/")) {
      return { kind: "human", type: "workforce", domain: null, sha256: sha256(`principal:workforce:${lower(member)}`), deleted };
    }
    if (member.includes("/workloadIdentityPools/")) return { kind: "workload", member };
    throw new Error("unknown principal:// scope");
  }
  if (member === "allUsers" || member === "allAuthenticatedUsers") return { kind: "public", member };
  if (["projectOwner:", "projectEditor:", "projectViewer:"].includes(prefix)) return { kind: "convenience", member };
  if (prefix === "user:" || prefix === "group:") {
    const at = value.lastIndexOf("@");
    if (at < 0) throw new Error("human principal without a domain");
    const domain = lower(value.slice(at + 1));
    return { kind: "human", type: prefix.slice(0, -1), domain, sha256: humanSha(prefix.slice(0, -1), value), deleted };
  }
  if (prefix === "domain:") {
    return { kind: "human", type: "domain", domain: lower(value), sha256: sha256(`principal:domain:${lower(value)}`), deleted };
  }
  if (prefix === "serviceAccount:") {
    return { kind: "serviceAccount", email: lower(value), agent: SERVICE_AGENT_PATTERNS.some((re) => re.test(lower(value))), deleted };
  }
  throw new Error("unknown principal prefix");
}
__name(principalRecord, "principalRecord");
function conditionRecord(condition) {
  if (condition === null || condition === void 0) return null;
  if (typeof condition.title !== "string" || typeof condition.expression !== "string") throw new Error("malformed condition");
  return { title: condition.title, expression: condition.expression, expressionSha256: sha256(condition.expression) };
}
__name(conditionRecord, "conditionRecord");
function classifyRole(roleId, permissions) {
  if (Object.hasOwn(BASIC_ROLES, roleId)) {
    return { ...BASIC_ROLES[roleId], matched: [roleId], definition: "basic" };
  }
  if (permissions === null || permissions === void 0) {
    return { writer: true, controller: true, impersonation: true, matched: ["*unreadable*"], definition: "unreadable" };
  }
  if (!Array.isArray(permissions) || permissions.some((p) => typeof p !== "string")) throw new Error("malformed permission list");
  const writer = permissions.some((p) => WRITE_PERMISSION_PATTERNS.some((re) => re.test(p)));
  const controller = permissions.some((p) => CONTROL_PERMISSION_PATTERNS.some((re) => re.test(p)));
  const impersonation = permissions.some((p) => IMPERSONATION_PERMISSIONS.includes(p));
  const matched = [...new Set(permissions.filter((p) => WRITE_PERMISSION_PATTERNS.some((re) => re.test(p)) || CONTROL_PERMISSION_PATTERNS.some((re) => re.test(p)) || IMPERSONATION_PERMISSIONS.includes(p)))].sort();
  return { writer, controller, impersonation, matched, definition: "read" };
}
__name(classifyRole, "classifyRole");
function closedListsDigest() {
  return sha256(canonicalJson({
    write: WRITE_PERMISSION_PATTERNS.map((p) => p.source),
    control: CONTROL_PERMISSION_PATTERNS.map((p) => p.source),
    impersonation: [...IMPERSONATION_PERMISSIONS].sort(),
    basic: Object.fromEntries(Object.entries(BASIC_ROLES).map(([id, v]) => [id, { writer: v.writer, controller: v.controller, impersonation: v.impersonation }])),
    serviceAgents: SERVICE_AGENT_PATTERNS.map((p) => p.source),
    machineEmail: MACHINE_EMAIL_PATTERN.source,
    computeCapable: COMPUTE_CAPABLE_APIS,
    namespace: NAMESPACE_PATTERN.source,
    conditional: CONDITIONAL_SURFACES,
    surfaces: [...SURFACES],
    inventoryBindings: [PRODUCTION_INVENTORY_BINDING, EMULATOR_INVENTORY_BINDING]
  }));
}
__name(closedListsDigest, "closedListsDigest");
function computeWriterSet(identity) {
  const set = /* @__PURE__ */ new Set();
  for (const entry of identity?.principals ?? []) {
    if ((entry.writer || entry.controller) && entry.principal.kind === "serviceAccount") set.add(entry.principal.email);
  }
  return set;
}
__name(computeWriterSet, "computeWriterSet");
var isStr = /* @__PURE__ */ __name((v) => typeof v === "string" && v.length > 0, "isStr");
var isBool = /* @__PURE__ */ __name((v) => typeof v === "boolean", "isBool");
var isInt = /* @__PURE__ */ __name((v) => Number.isSafeInteger(v) && v >= 0, "isInt");
var isHex40 = /* @__PURE__ */ __name((v) => typeof v === "string" && /^[0-9a-f]{40}$/.test(v), "isHex40");
var isHex64 = /* @__PURE__ */ __name((v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v), "isHex64");
var isDigest = /* @__PURE__ */ __name((v) => typeof v === "string" && /^sha256:[0-9a-f]{64}$/.test(v), "isDigest");
var isAnyStr = /* @__PURE__ */ __name((v) => typeof v === "string", "isAnyStr");
var isServiceAccountEmail = /* @__PURE__ */ __name((v) => typeof v === "string" && /^[a-z0-9][a-z0-9._%+-]*@[a-z0-9.-]+\.gserviceaccount\.com$/.test(v), "isServiceAccountEmail");
var PRINCIPAL = {
  oneOf: [
    { obj: { kind: { literal: "human" }, type: { enumOf: ["user", "group", "domain", "workforce"] }, domain: { nullable: isAnyStr }, sha256: isHex64, deleted: isBool } },
    { obj: { kind: { literal: "serviceAccount" }, email: isStr, agent: isBool, deleted: isBool } },
    { obj: { kind: { literal: "workload" }, member: isStr } },
    { obj: { kind: { literal: "public" }, member: { enumOf: ["allUsers", "allAuthenticatedUsers"] } } },
    { obj: { kind: { literal: "convenience" }, member: isStr } }
  ]
};
var CONDITION = { nullable: { obj: { title: isAnyStr, expression: isAnyStr, expressionSha256: isHex64 } } };
var OBSERVED_SPEC = {
  obj: {
    schemaVersion: { literal: OBSERVED_SCHEMA },
    project: { literal: PROJECT },
    projectNumber: { literal: PROJECT_NUMBER },
    database: { literal: DATABASE },
    identity: {
      obj: {
        ancestry: { arr: isStr },
        policies: { arr: { obj: { resource: isStr, read: isBool } } },
        roles: { arr: { obj: { role: isStr, definition: { enumOf: ["read", "basic", "unreadable"] }, writer: isBool, controller: isBool, impersonation: isBool, matched: { arr: isStr } } } },
        grants: { arr: { obj: { resource: isStr, role: isStr, principal: PRINCIPAL, condition: CONDITION } } },
        principals: { arr: { obj: { principal: PRINCIPAL, writer: isBool, controller: isBool, via: { arr: isStr } } } },
        serviceAccounts: {
          arr: {
            obj: {
              email: isStr,
              projectOwned: isBool,
              agent: isBool,
              disabled: { nullable: isBool },
              policyRead: isBool,
              keysRead: isBool,
              keys: { arr: { obj: { keyId: isStr, disabled: isBool, validAfterTime: isStr, validBeforeTime: { nullable: isStr }, keyOrigin: isStr } } }
            }
          }
        }
      }
    },
    workload: {
      obj: {
        enabledServices: { arr: isStr },
        workloads: {
          arr: {
            obj: {
              kind: { enumOf: ["run-revision", "run-job", "function", "compute-instance", "app-engine-version", "workflow"] },
              location: isStr,
              name: isStr,
              parent: { nullable: isStr },
              serving: { nullable: { obj: { percent: isInt, tags: { arr: isStr }, latestReady: isBool } } },
              serviceAccount: isServiceAccountEmail,
              environment: { nullable: { enumOf: ["GEN_1", "GEN_2"] } },
              images: { arr: { obj: { container: isStr, repository: isStr, digest: { nullable: isDigest }, digestSource: { enumOf: ["revision-status", "pinned", "registry-tag", "none"] } } } }
            }
          }
        },
        attribution: { arr: { obj: { digest: isDigest, repository: isStr, method: { enumOf: ["cloud-build", "ar-tag", "unmapped"] }, sourceRepository: { nullable: isStr }, commit: { nullable: isHex40 } } } }
      }
    },
    ci: {
      obj: {
        wifPools: { arr: { obj: { pool: isStr, state: isStr, disabled: isBool } } },
        wifProviders: {
          arr: {
            obj: {
              pool: isStr,
              provider: isStr,
              state: isStr,
              disabled: isBool,
              issuer: { nullable: isStr },
              allowedAudiences: { arr: isStr },
              attributeMapping: { map: isAnyStr },
              attributeCondition: { nullable: isAnyStr },
              attributeConditionSha256: { nullable: isHex64 },
              admitted: { nullable: { arr: { obj: { repository: isStr, workflowPath: isStr, ref: isStr } } } }
            }
          }
        },
        admittedState: { arr: { obj: { repository: isStr, ref: isStr, readable: isBool, headCommit: { nullable: isHex40 }, workflows: { arr: { obj: { path: isStr, blobSha: isHex40 } } } } } },
        buildTriggers: { arr: { obj: { location: isStr, name: isStr, serviceAccount: isServiceAccountEmail, disabled: isBool, source: isAnyStr, filter: isAnyStr, configSha256: { nullable: isHex64 } } } }
      }
    },
    data: {
      obj: {
        topLevel: { obj: { namespace: { arr: isStr } } },
        namespacePatterns: { arr: isStr },
        fullPass: { obj: { complete: isBool } },
        foreignParentPrefixed: { arr: isStr },
        sharedGroupIds: { arr: isStr },
        ttlFields: { arr: { obj: { collectionGroup: isStr, field: isStr } } }
      }
    },
    rules: {
      obj: {
        releases: { arr: { obj: { release: isStr, ruleset: isStr, files: { arr: { obj: { name: isStr, sha256: isHex64 } } } } } },
        matchesCommitted: isBool,
        reachability: { enumOf: ["none", "reachable", "unresolved"] },
        tests: { arr: { obj: { group: isStr, auth: { enumOf: ["none", "synthetic"] }, method: { literal: "create" }, result: { enumOf: ["deny", "allow"] } } } }
      }
    }
  }
};
function validateShape(value, spec, at = "observed") {
  const problems = [];
  const plain = /* @__PURE__ */ __name((v) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype, "plain");
  const visit = /* @__PURE__ */ __name((v, s, p) => {
    if (typeof s === "function") {
      if (!s(v)) problems.push({ at: p, kind: "shape" });
      return;
    }
    if ("literal" in s) {
      if (v !== s.literal) problems.push({ at: p, kind: "shape" });
      return;
    }
    if ("enumOf" in s) {
      if (!s.enumOf.includes(v)) problems.push({ at: p, kind: "shape" });
      return;
    }
    if ("nullable" in s) {
      if (v !== null) visit(v, s.nullable, p);
      return;
    }
    if ("arr" in s) {
      if (!Array.isArray(v)) {
        problems.push({ at: p, kind: "shape" });
        return;
      }
      v.forEach((item, i) => visit(item, s.arr, `${p}[${i}]`));
      return;
    }
    if ("map" in s) {
      if (!plain(v)) {
        problems.push({ at: p, kind: "shape" });
        return;
      }
      for (const [k, child] of Object.entries(v)) visit(child, s.map, `${p}.${k}`);
      return;
    }
    if ("any" in s) return;
    if ("oneOf" in s) {
      const ok = s.oneOf.some((option) => validateShape(v, option, p).length === 0);
      if (!ok) problems.push({ at: p, kind: "shape" });
      return;
    }
    if ("obj" in s) {
      if (!plain(v)) {
        problems.push({ at: p, kind: "shape" });
        return;
      }
      const expected = Object.keys(s.obj).sort();
      const actual = Object.keys(v).sort();
      if (JSON.stringify(expected) !== JSON.stringify(actual)) problems.push({ at: p, kind: "keys", missing: expected.filter((k) => !actual.includes(k)), extra: actual.filter((k) => !expected.includes(k)) });
      for (const key of expected) if (Object.hasOwn(v, key)) visit(v[key], s.obj[key], `${p}.${key}`);
      return;
    }
    throw new Error("unknown schema node");
  }, "visit");
  visit(value, spec, at);
  return problems;
}
__name(validateShape, "validateShape");
var POSITIONAL = /* @__PURE__ */ new Set(["ancestry", "policies"]);
var BY_EMAIL = /* @__PURE__ */ new Set(["serviceAccounts"]);
function checkSorted(value, path, problems) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => checkSorted(item, `${path}[${i}]`, problems));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (Array.isArray(child) && !POSITIONAL.has(key)) {
        if (BY_EMAIL.has(key)) {
          const emails = child.map((item) => item.email);
          if (JSON.stringify(emails) !== JSON.stringify([...emails].sort())) problems.push({ at: `${path}.${key}`, kind: "unsorted-email" });
        } else {
          const keys = child.map((item) => canonicalJson(item));
          if (JSON.stringify(keys) !== JSON.stringify([...keys].sort())) problems.push({ at: `${path}.${key}`, kind: "unsorted" });
        }
      }
      checkSorted(child, `${path}.${key}`, problems);
    }
  }
}
__name(checkSorted, "checkSorted");
function canonicalizeObserved(value, key = null) {
  if (Array.isArray(value)) {
    if (POSITIONAL.has(key)) return value.map((item) => canonicalizeObserved(item));
    if (BY_EMAIL.has(key)) {
      return value.map((item) => canonicalizeObserved(item)).sort((a, b) => a.email < b.email ? -1 : a.email > b.email ? 1 : 0);
    }
    return value.map((item) => canonicalizeObserved(item)).map((item) => ({ item, text: canonicalJson(item) })).sort((a, b) => a.text < b.text ? -1 : a.text > b.text ? 1 : 0).map(({ item }) => item);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, child]) => [k, canonicalizeObserved(child, k)]));
  }
  return value;
}
__name(canonicalizeObserved, "canonicalizeObserved");
function patternProblems(pattern) {
  const parts = pattern.split("/");
  if (parts.length % 2 === 0) return ["even-segment-count"];
  const problems = [];
  parts.forEach((segment, i) => {
    if (i % 2 === 1 && segment !== "*") problems.push("document-position-not-wildcard");
    if (i % 2 === 0 && segment === "*") problems.push("collection-position-wildcard");
  });
  return problems;
}
__name(patternProblems, "patternProblems");
function validateObserved(observed, binding) {
  const policy = assertInventoryBinding(binding);
  const spec = { obj: { ...OBSERVED_SPEC.obj, project: { literal: policy.project }, projectNumber: { literal: policy.projectNumber }, database: { literal: policy.database } } };
  const problems = validateShape(observed, spec);
  if (problems.length) return problems;
  checkSorted(observed, "observed", problems);
  for (const pattern of [...observed.data.namespacePatterns, ...observed.data.foreignParentPrefixed]) {
    for (const kind of patternProblems(pattern)) problems.push({ at: `data.pattern:${pattern}`, kind });
  }
  const leaks = findRawLeaks(observed, "observed");
  if (leaks.length) problems.push({ at: "observed", kind: "raw-leak", paths: leaks });
  const machineEmail = "[a-z0-9._%+-]+@(?:[a-z0-9-]+\\.iam|developer|appspot|cloudbuild|cloudservices)\\.gserviceaccount\\.com";
  const VIA_DIRECT = new RegExp(`^direct:((projects|folders|organizations)/[0-9]+|serviceAccounts/${machineEmail})$`);
  const VIA_IMPERSONATION = new RegExp(`^impersonation:${machineEmail}$`);
  const writerSet = computeWriterSet(observed.identity);
  for (const p of observed.identity.principals) {
    for (const via of p.via) {
      if (!VIA_DIRECT.test(via) && !VIA_IMPERSONATION.test(via)) problems.push({ at: "identity.principals.via", kind: "via-pattern" });
      if (via.startsWith("impersonation:") && !writerSet.has(via.slice("impersonation:".length))) problems.push({ at: "identity.principals.via", kind: "via-target-not-in-writer-set" });
    }
  }
  for (const a of observed.workload.attribution) {
    if (a.method === "unmapped") {
      if (a.sourceRepository !== null || a.commit !== null) problems.push({ at: "workload.attribution", kind: "unmapped-with-source" });
    } else if (!a.sourceRepository || !a.commit) {
      problems.push({ at: "workload.attribution", kind: "attribution-missing-source" });
    }
  }
  for (const entry of observed.identity.principals) {
    if (!entry.writer && !entry.controller) problems.push({ at: "identity.principals", kind: "not-writer-or-controller" });
  }
  const writers = [...computeWriterSet(observed.identity)].sort();
  const accounts = observed.identity.serviceAccounts.map((sa) => sa.email);
  if (JSON.stringify(writers) !== JSON.stringify(accounts)) problems.push({ at: "identity.serviceAccounts", kind: "not-writer-set" });
  return problems;
}
__name(validateObserved, "validateObserved");
function findRawLeaks(value, path = "$") {
  const leaks = [];
  const scanText = /* @__PURE__ */ __name((text, at) => {
    if (/^(deleted:)?(user|group|domain):/.test(text)) leaks.push(at);
    if (TOKEN_IN_TEXT.test(text)) leaks.push(at);
    for (const match of text.match(EMAIL_IN_TEXT) ?? []) if (!MACHINE_EMAIL_PATTERN.test(match)) leaks.push(at);
  }, "scanText");
  const walk = /* @__PURE__ */ __name((node, at) => {
    if (typeof node === "string") {
      scanText(node, at);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${at}[${i}]`));
      return;
    }
    if (node && typeof node === "object") {
      const patternKeys = /* @__PURE__ */ new Set(["namespacePatterns", "foreignParentPrefixed"]);
      for (const [key, child] of Object.entries(node)) {
        scanText(key, `${at}.<key>`);
        if (patternKeys.has(key) && Array.isArray(child)) {
          for (const pattern of child) if (typeof pattern === "string" && patternProblems(pattern).length) leaks.push(`${at}.${key}`);
        }
        if (key === "documentCounts" && child && typeof child === "object") {
          for (const docKey of Object.keys(child)) if (patternProblems(docKey).length) leaks.push(`${at}.${key}.<key>`);
        }
        walk(child, `${at}.${key}`);
      }
    }
  }, "walk");
  walk(value, path);
  return [...new Set(leaks)].sort();
}
__name(findRawLeaks, "findRawLeaks");
var ASSUMPTION_IDS = Object.freeze([
  "human-principals",
  "org-folder-allow-unobserved",
  "service-account-unobserved",
  "user-managed-key",
  "google-managed",
  "image-tag-attribution",
  "unattributable-workload",
  "ci-plane-unreadable",
  "ci-unbounded",
  "client-writes",
  "rules-not-committed",
  "foreign-parent-subtrees",
  "dynamic-name",
  "post-observation-window"
]);
function emittedAssumptions(observed, census) {
  const out = /* @__PURE__ */ new Map();
  const add = /* @__PURE__ */ __name((id, subjects) => {
    const unique = [...new Set(subjects)].sort();
    if (unique.length) out.set(id, unique);
  }, "add");
  const writers = computeWriterSet(observed.identity);
  const wt = observed.identity.principals.filter((p) => p.writer || p.controller);
  add("human-principals", wt.flatMap((p) => {
    if (p.principal.kind === "human") return [`human:${p.principal.sha256}`];
    if (p.principal.kind === "convenience") return [`convenience:${p.principal.member}`];
    return [];
  }));
  add("org-folder-allow-unobserved", observed.identity.policies.filter((p) => !p.read).map((p) => p.resource));
  add("service-account-unobserved", observed.identity.serviceAccounts.filter((sa) => !sa.policyRead || !sa.keysRead).map((sa) => sa.email));
  add("user-managed-key", observed.identity.serviceAccounts.filter((sa) => writers.has(sa.email)).flatMap((sa) => sa.keys.map((k) => `${sa.email}/${k.keyId}`)));
  add("google-managed", [
    ...wt.filter((p) => p.principal.kind === "serviceAccount" && p.principal.agent).map((p) => p.principal.email),
    ...observed.data.ttlFields.map((t) => `ttl:${t.collectionGroup}/${t.field}`)
  ]);
  const attribution = new Map(observed.workload.attribution.map((a) => [a.digest, a]));
  const wtWorkloads = observed.workload.workloads.filter((w) => writers.has(w.serviceAccount));
  add("image-tag-attribution", wtWorkloads.flatMap((w) => w.images.map((i) => i.digest).filter(Boolean)).filter((d) => attribution.get(d)?.method === "ar-tag"));
  add("unattributable-workload", [
    ...wtWorkloads.filter((w) => w.images.length === 0 || w.images.some((i) => !i.digest || attribution.get(i.digest)?.method === "unmapped") || w.kind === "function" && w.environment === "GEN_1").map((w) => `${w.kind}/${w.location}/${w.name}`),
    ...observed.ci.buildTriggers.filter((t) => !t.disabled && writers.has(t.serviceAccount)).map((t) => `cloud-build-trigger/${t.location}/${t.name}`)
  ]);
  add("ci-plane-unreadable", observed.ci.admittedState.filter((a) => !a.readable).map((a) => a.repository));
  add("ci-unbounded", observed.ci.wifProviders.flatMap((p) => (p.admitted ?? []).filter((a) => a.ref === "*").map((a) => `${p.pool}/${p.provider}:${a.repository}`)));
  add("client-writes", observed.rules.reachability === "reachable" || observed.rules.tests.some((t) => t.result === "allow") ? observed.rules.releases.map((r) => r.release) : []);
  add("rules-not-committed", observed.rules.matchesCommitted ? [] : observed.rules.releases.map((r) => r.release));
  add("foreign-parent-subtrees", observed.data.fullPass.complete ? [] : [DATABASE]);
  const dynamic = (census?.codeCensus ?? []).flatMap((repo) => repo.writeSites.filter((s) => s.dynamic && s.dynamic.resolved === false).map((s) => `${repo.repository}@${repo.commit}:${s.file}:${s.line}`));
  add("dynamic-name", dynamic);
  add("post-observation-window", census?.mode?.runnerAuditReread === false ? ["runner"] : []);
  return [...out.entries()].map(([id, subjects]) => ({ id, subjects })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
__name(emittedAssumptions, "emittedAssumptions");
var ROLES = ["migration", "meta", "operations", "runtime", "governance"];
var FENCES = ["runner", "guard", "none"];
var CENSUS_SPEC = {
  obj: {
    schemaVersion: { literal: CENSUS_SCHEMA },
    kind: { literal: "netsapiens-writer-census" },
    closedListsSha256: isHex64,
    bounds: { obj: { namespaceMaxDocuments: isInt, fullPassMaxDocuments: isInt, maxServiceAccounts: isInt } },
    mode: { obj: { runnerAuditReread: isBool } },
    union: { arr: isStr },
    exclusions: { arr: { obj: { pattern: isStr, reason: isStr } } },
    codeCensus: {
      arr: {
        obj: {
          repository: isStr,
          commit: isHex40,
          writeSites: {
            arr: {
              obj: {
                file: isStr,
                line: isInt,
                group: { nullable: isStr },
                role: { enumOf: ROLES },
                fence: { enumOf: FENCES },
                dynamic: { nullable: { obj: { source: isStr, resolved: isBool, value: { nullable: isStr } } } }
              }
            }
          }
        }
      }
    },
    acceptedAssumptions: { arr: { obj: { id: { enumOf: [...ASSUMPTION_IDS] }, subjects: { arr: isStr } } } },
    observed: { any: true },
    review: { obj: { reviewedBy: isStr, reviewedAt: isStr, instructionRef: isStr } }
  }
};
function validateCensus(census, binding) {
  assertInventoryBinding(binding);
  const problems = validateShape(census, CENSUS_SPEC, "census");
  if (problems.length) return problems;
  if (census.closedListsSha256 !== closedListsDigest()) problems.push({ at: "census.closedListsSha256", kind: "closed-lists-changed" });
  if (!isSortedUnique(census.union)) problems.push({ at: "census.union", kind: "unsorted" });
  for (const [key, value] of Object.entries(census.bounds)) if (!Number.isSafeInteger(value) || value <= 0) problems.push({ at: `census.bounds.${key}`, kind: "bound" });
  for (const a of census.acceptedAssumptions) if (!isSortedUnique(a.subjects)) problems.push({ at: "census.acceptedAssumptions", kind: "unsorted" });
  return problems;
}
__name(validateCensus, "validateCensus");
function isSortedUnique(list) {
  return JSON.stringify(list) === JSON.stringify([...new Set(list)].sort());
}
__name(isSortedUnique, "isSortedUnique");
function normalizeAssumptions(list) {
  return list.map((a) => ({ id: a.id, subjects: [...new Set(a.subjects)].sort() })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
__name(normalizeAssumptions, "normalizeAssumptions");
function surfaceProblems(surfaces, observed) {
  const problems = [];
  const incomplete = [];
  for (const name of SURFACES) {
    const entry = surfaces?.[name];
    if (!entry) {
      incomplete.push(name);
      continue;
    }
    if (entry.status === "ok") continue;
    if (entry.status === "absent" && Object.hasOwn(CONDITIONAL_SURFACES, name)) {
      const api = CONDITIONAL_SURFACES[name];
      const enabled = observed?.workload?.enabledServices?.includes(api);
      const appEngine404 = name === "app-engine" && entry.reason === "404";
      if (appEngine404 || !enabled) continue;
    }
    incomplete.push(name);
  }
  if (incomplete.length) problems.push({ kind: "incomplete-surfaces", surfaces: incomplete });
  return problems;
}
__name(surfaceProblems, "surfaceProblems");
function dataProblems(observed, census) {
  const problems = [];
  const union = new Set(census.union);
  const exclusionPatterns = new Set(census.exclusions.map((e) => e.pattern));
  const shared = new Set(observed.data.sharedGroupIds);
  for (const id of observed.data.topLevel.namespace) if (!union.has(id)) problems.push({ kind: "namespace-outside-union", id });
  for (const pattern of observed.data.namespacePatterns) {
    const last = pattern.split("/").at(-1);
    if (!union.has(last) && !exclusionPatterns.has(pattern)) problems.push({ kind: "namespace-pattern-outside-union", pattern });
    if (shared.has(last) && !exclusionPatterns.has(pattern)) problems.push({ kind: "shared-group-pattern-not-excluded", pattern });
  }
  for (const pattern of observed.data.foreignParentPrefixed) if (!exclusionPatterns.has(pattern)) problems.push({ kind: "foreign-parent-not-excluded", pattern });
  for (const id of observed.data.sharedGroupIds) if (union.has(id)) problems.push({ kind: "shared-group-in-union", id });
  return problems;
}
__name(dataProblems, "dataProblems");
function workloadProblems(observed, census, accepted) {
  const problems = [];
  const writers = computeWriterSet(observed.identity);
  const attribution = new Map(observed.workload.attribution.map((a) => [a.digest, a]));
  const codeSites = new Set(census.codeCensus.map((c) => `${c.repository}@${c.commit}`));
  const unattributable = new Set(accepted.find((a) => a.id === "unattributable-workload")?.subjects ?? []);
  for (const w of observed.workload.workloads) {
    if (!writers.has(w.serviceAccount)) continue;
    const subject = `${w.kind}/${w.location}/${w.name}`;
    for (const image of w.images) {
      if (!image.digest) {
        if (!unattributable.has(subject)) problems.push({ kind: "unattributed-image", subject });
        continue;
      }
      const a = attribution.get(image.digest);
      if (!a || a.method === "unmapped") {
        if (!unattributable.has(subject)) problems.push({ kind: "unattributed-image", subject });
        continue;
      }
      if (!a.commit || !a.sourceRepository) {
        if (!unattributable.has(subject)) problems.push({ kind: "unattributed-image", subject });
        continue;
      }
      if (!codeSites.has(`${a.sourceRepository}@${a.commit}`)) problems.push({ kind: "attributed-commit-not-in-code-census", subject });
    }
  }
  for (const row of observed.ci.admittedState) {
    if (row.readable && !codeSites.has(`${row.repository}@${row.headCommit}`)) problems.push({ kind: "admitted-commit-not-in-code-census", subject: `${row.repository}@${row.ref}` });
  }
  for (const repo of census.codeCensus) {
    for (const site of repo.writeSites) {
      if ((site.role === "migration" || site.role === "meta" || site.role === "operations") && site.fence === "none") {
        problems.push({ kind: "unfenced-write-site", repository: repo.repository, file: site.file, line: site.line });
      }
    }
  }
  return problems;
}
__name(workloadProblems, "workloadProblems");
function compareCensus(input) {
  assertInventoryBinding(input?.binding);
  const { census, observed, measurements, surfaces, scopeGroups, binding } = input;
  const problems = [];
  const surfaceIssues = surfaceProblems(surfaces, observed);
  const incomplete = surfaceIssues.find((p) => p.kind === "incomplete-surfaces")?.surfaces ?? [];
  problems.push(...surfaceIssues);
  const census2 = census && census.schemaVersion === CENSUS_SCHEMA ? census : null;
  if (!census2) problems.push({ kind: "census-missing-or-invalid" });
  else {
    problems.push(...validateCensus(census2, binding).map((p) => ({ kind: "census-shape", at: p.at, detail: p.kind })));
  }
  const observedProblems = observed ? validateObserved(observed, binding) : [{ kind: "observation-missing" }];
  problems.push(...observedProblems.map((p) => ({ kind: "observed-shape", at: p.at, detail: p.kind })));
  if (census2 && census2.observed) {
    problems.push(...validateObserved(census2.observed, binding).map((p) => ({ kind: "census-observed-shape", at: p.at, detail: p.kind })));
  }
  if (census2 && observed && canonicalJson(census2.observed) !== canonicalJson(observed)) problems.push({ kind: "observed-mismatch" });
  if (census2 && observed && observedProblems.length === 0) {
    const emitted = normalizeAssumptions(emittedAssumptions(observed, census2));
    const accepted = normalizeAssumptions(census2.acceptedAssumptions);
    if (canonicalJson(emitted) !== canonicalJson(accepted)) problems.push({ kind: "assumptions-not-accepted" });
    problems.push(...dataProblems(observed, census2));
    problems.push(...workloadProblems(observed, census2, accepted));
  }
  const leakSurfaces = Object.fromEntries(Object.entries(surfaces ?? {}).map(([k, v]) => [k, v.error ?? null]));
  const leaks = [
    ...findRawLeaks(observed ?? null, "observed"),
    ...findRawLeaks(measurements ?? null, "measurements"),
    ...findRawLeaks(leakSurfaces, "surfaces")
  ];
  if (leaks.length) problems.push({ kind: "raw-leak", paths: leaks });
  if (!Array.isArray(scopeGroups)) problems.push({ kind: "scope-missing-or-invalid" });
  else if (census2) {
    const union = [...census2.union].sort();
    const scope = [...scopeGroups].sort();
    if (JSON.stringify(union) !== JSON.stringify(scope)) problems.push({ kind: "union-not-scope" });
  }
  return { decision: problems.length === 0 ? "match" : "fail", incomplete, problems };
}
__name(compareCensus, "compareCensus");

// src/cutover/writer-inventory-format.mjs
var isFirestore = /* @__PURE__ */ __name((name) => name.startsWith("firestore-"), "isFirestore");
var exact2 = /* @__PURE__ */ __name((value, keys) => value !== null && typeof value === "object" && !Array.isArray(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()), "exact");
function parseProtectedJson(bytes) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Protected inventory JSON is invalid");
  }
}
__name(parseProtectedJson, "parseProtectedJson");
function assertSafeObservation(value, binding) {
  assertInventoryBinding(binding);
  const { observed, measurements, surfaces } = value;
  const leaks = [...findRawLeaks(observed, "observed"), ...findRawLeaks(measurements, "measurements"), ...findRawLeaks(surfaces, "surfaces")];
  if (leaks.length) throw new Error(`Inventory output rejected: ${leaks.length} unsafe field paths`);
  const problems = validateObserved(observed, binding);
  if (problems.length) throw new Error(`Inventory shape rejected: ${problems.length} invalid fields`);
}
__name(assertSafeObservation, "assertSafeObservation");
function splitForFiles(value, binding) {
  assertSafeObservation(value, binding);
  const { observed, measurements, surfaces } = value;
  const writer = {
    schemaVersion: 2,
    kind: "netsapiens-writer-inventory",
    identity: observed.identity,
    workload: observed.workload,
    ci: observed.ci,
    rules: observed.rules,
    surfaces: Object.fromEntries(Object.entries(surfaces).filter(([k]) => !isFirestore(k))),
    measurements: Object.fromEntries(Object.entries(measurements).filter(([k]) => k !== "data"))
  };
  const collection = {
    schemaVersion: 2,
    kind: "netsapiens-collection-inventory",
    data: observed.data,
    surfaces: Object.fromEntries(Object.entries(surfaces).filter(([k]) => isFirestore(k))),
    measurements: { data: measurements.data }
  };
  return { "writer-inventory.json": writer, "collection-inventory.json": collection };
}
__name(splitForFiles, "splitForFiles");
function joinFromFiles(writer, collection, binding) {
  const policy = assertInventoryBinding(binding);
  if (!exact2(writer, ["schemaVersion", "kind", "identity", "workload", "ci", "rules", "surfaces", "measurements"]) || !exact2(collection, ["schemaVersion", "kind", "data", "surfaces", "measurements"]) || writer.schemaVersion !== 2 || writer.kind !== "netsapiens-writer-inventory" || collection.schemaVersion !== 2 || collection.kind !== "netsapiens-collection-inventory") throw new Error("Invalid inventory file kind");
  if (!writer.surfaces || !collection.surfaces || Object.keys(writer.surfaces).some(isFirestore) || Object.keys(collection.surfaces).some((k) => !isFirestore(k)) || !writer.measurements || !collection.measurements || Object.keys(collection.measurements).join(",") !== "data" || Object.hasOwn(writer.measurements, "data")) throw new Error("Invalid inventory file partition");
  const result = {
    observed: {
      schemaVersion: OBSERVED_SCHEMA,
      project: policy.project,
      projectNumber: policy.projectNumber,
      database: policy.database,
      identity: writer.identity,
      workload: writer.workload,
      ci: writer.ci,
      rules: writer.rules,
      data: collection.data
    },
    measurements: { ...writer.measurements, ...collection.measurements },
    surfaces: { ...writer.surfaces, ...collection.surfaces }
  };
  assertSafeObservation(result, binding);
  return result;
}
__name(joinFromFiles, "joinFromFiles");

// src/store/protected-request.ts
import { createHash as createHash7 } from "node:crypto";
var REQUEST_MAX_BYTES = 65536;
var REQUEST_KIND = "netsapiens-protected-migration-request";
var PROTECTED_ACTIONS = ["inspect", "adopt", "activate", "status", "verify-active-ownership"];
var PROTECTED_PROFILES = ["production", "emulator"];
var PROTECTED_NAMESPACES = ["mcp", "pwmcp", "readonly_mcp"];
var HEX64 = /^[0-9a-f]{64}$/;
var HEX40 = /^[0-9a-f]{40}$/;
var RUN_ID = /^nsm-[0-9a-f]{40}$/;
var CODE_ARTIFACT = /^[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-f]{64}$/;
var SRI_SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;
var RUN_ID_DOMAIN = "netsapiens-mcp/cutover/migration-run/v1";
function exactKeys(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
__name(exactKeys, "exactKeys");
function refuse2(message) {
  throw new CutoverRefusedError(message);
}
__name(refuse2, "refuse");
function migrationRunIdFor(approvalPayloadSha256, namespace, epoch) {
  if (!HEX64.test(approvalPayloadSha256)) refuse2("Run identity requires a lowercase approval digest");
  if (!Number.isSafeInteger(epoch) || epoch < 1) refuse2("Run identity requires a positive safe epoch");
  const material = `${RUN_ID_DOMAIN}
${approvalPayloadSha256}
${namespace}
${String(epoch)}`;
  return `nsm-${createHash7("sha256").update(Buffer.from(material, "utf8")).digest("hex").slice(0, 40)}`;
}
__name(migrationRunIdFor, "migrationRunIdFor");
function argvFor(request) {
  if (request.action === "adopt") {
    const options = request.options;
    return ["adopt", "--namespace", request.namespace, "--mode", options.dryRun ? "dry-run" : "commit"];
  }
  return [request.action, "--namespace", request.namespace];
}
__name(argvFor, "argvFor");
function parseOptions(action, raw) {
  switch (action) {
    case "inspect":
    case "status":
      if (!exactKeys(raw, [])) refuse2("Request options are not permitted for this action");
      return {};
    case "adopt":
      if (!exactKeys(raw, ["dryRun", "expectedSourceInventoryDigest"]) || typeof raw.dryRun !== "boolean" || typeof raw.expectedSourceInventoryDigest !== "string" || !HEX64.test(raw.expectedSourceInventoryDigest)) {
        refuse2("Adopt options are malformed");
      }
      return { dryRun: raw.dryRun, expectedSourceInventoryDigest: raw.expectedSourceInventoryDigest };
    case "activate":
      if (!exactKeys(raw, ["migrationManifestDigest"]) || typeof raw.migrationManifestDigest !== "string" || !HEX64.test(raw.migrationManifestDigest)) {
        refuse2("Activate options are malformed");
      }
      return { migrationManifestDigest: raw.migrationManifestDigest };
    case "verify-active-ownership":
      if (!exactKeys(raw, ["migrationManifestDigest", "planDigest"]) || typeof raw.migrationManifestDigest !== "string" || !HEX64.test(raw.migrationManifestDigest) || typeof raw.planDigest !== "string" || !HEX64.test(raw.planDigest)) {
        refuse2("Verify options are malformed");
      }
      return { migrationManifestDigest: raw.migrationManifestDigest, planDigest: raw.planDigest };
  }
}
__name(parseOptions, "parseOptions");
function parseProtectedRequestV2(bytes) {
  if (bytes.byteLength > REQUEST_MAX_BYTES) refuse2("Request exceeds the byte limit");
  let text;
  let parsed;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    refuse2("Request is not valid UTF-8 JSON");
  }
  if (canonicalJson(parsed) !== text) refuse2("Request is not canonical JSON");
  if (!exactKeys(parsed, ["schemaVersion", "kind", "action", "profile", "namespace", "approvalPayloadSha256", "identity", "options"])) {
    refuse2("Request key set is not exact");
  }
  const r = parsed;
  if (r.schemaVersion !== 2 || r.kind !== REQUEST_KIND) refuse2("Request schema is not version 2");
  if (typeof r.action !== "string" || !PROTECTED_ACTIONS.includes(r.action)) refuse2("Request action is not permitted");
  if (typeof r.profile !== "string" || !PROTECTED_PROFILES.includes(r.profile)) refuse2("Request profile is not permitted");
  if (typeof r.namespace !== "string" || !PROTECTED_NAMESPACES.includes(r.namespace)) refuse2("Request namespace is not permitted");
  if (typeof r.approvalPayloadSha256 !== "string" || !HEX64.test(r.approvalPayloadSha256)) refuse2("Approval digest is malformed");
  const identity = r.identity;
  if (!exactKeys(identity, ["expectedEpoch", "migrationRunId", "codeSha", "codeArtifact", "packageIntegrity", "protocolDigest"])) {
    refuse2("Request identity key set is not exact");
  }
  const i = identity;
  if (typeof i.expectedEpoch !== "number" || !Number.isSafeInteger(i.expectedEpoch) || i.expectedEpoch < 1) refuse2("Expected epoch is malformed");
  if (typeof i.migrationRunId !== "string" || !RUN_ID.test(i.migrationRunId)) refuse2("Run identity is malformed");
  if (typeof i.codeSha !== "string" || !HEX40.test(i.codeSha)) refuse2("Code SHA is malformed");
  if (typeof i.codeArtifact !== "string" || !CODE_ARTIFACT.test(i.codeArtifact)) refuse2("Code artifact is malformed");
  if (typeof i.packageIntegrity !== "string" || !SRI_SHA512.test(i.packageIntegrity)) refuse2("Package integrity is malformed");
  if (typeof i.protocolDigest !== "string" || !HEX64.test(i.protocolDigest)) refuse2("Protocol digest is malformed");
  if (i.migrationRunId !== migrationRunIdFor(r.approvalPayloadSha256, r.namespace, i.expectedEpoch)) {
    refuse2("Run identity does not match the approval, namespace and epoch");
  }
  const action = r.action;
  return Object.freeze({
    schemaVersion: 2,
    kind: REQUEST_KIND,
    action,
    profile: r.profile,
    namespace: r.namespace,
    approvalPayloadSha256: r.approvalPayloadSha256,
    identity: Object.freeze({
      expectedEpoch: i.expectedEpoch,
      migrationRunId: i.migrationRunId,
      codeSha: i.codeSha,
      codeArtifact: i.codeArtifact,
      packageIntegrity: i.packageIntegrity,
      protocolDigest: i.protocolDigest
    }),
    options: Object.freeze(parseOptions(action, r.options))
  });
}
__name(parseProtectedRequestV2, "parseProtectedRequestV2");

// src/store/protected-migration-context.ts
import { createHash as createHash8 } from "node:crypto";
import { existsSync, lstatSync as lstatSync2, readFileSync as readFileSync2 } from "node:fs";
var RUN_DIR = "/run/cutover";
var OPT_DIR = "/opt/cutover";
var BUNDLE_URL = "file:///opt/cutover/cutover-protocol.mjs";
var RUNNER_PATH = "/opt/cutover/runner.mjs";
var BUNDLE_PATH = "/opt/cutover/cutover-protocol.mjs";
var PATHS = {
  request: `${RUN_DIR}/request.json`,
  approval: `${RUN_DIR}/approval.dsse.json`,
  attestation: `${RUN_DIR}/attestation-manifest.json`,
  indexSchema: `${RUN_DIR}/index-schema.json`,
  writerCensus: `${RUN_DIR}/writer-census.json`,
  writerInventory: `${RUN_DIR}/writer-inventory.json`,
  collectionInventory: `${RUN_DIR}/collection-inventory.json`,
  credentials: `${RUN_DIR}/credentials.json`,
  oidc: `${RUN_DIR}/oidc.jwt`,
  sessionSecret: `${RUN_DIR}/session-secret`,
  trustPolicy: `${OPT_DIR}/trust-policy.json`,
  buildInfo: `${OPT_DIR}/build-info.json`
};
var ENV_ALLOW = /* @__PURE__ */ new Set(["HOME", "HOSTNAME", "NODE_VERSION", "PATH", "YARN_VERSION"]);
var MAX_INPUT_BYTES = 8 * 1024 * 1024;
var TOKEN_TYPE_JWT = "urn:ietf:params:oauth:token-type:jwt";
var AUDIENCE = "//iam.googleapis.com/projects/859122914438/locations/global/workloadIdentityPools/github/providers/github";
var STS_URL = "https://sts.googleapis.com/v1/token";
var IMPERSONATION_URL = "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/edge-tf-deployer@phoneware-edge.iam.gserviceaccount.com:generateAccessToken";
var SHA256_HEX = /^[0-9a-f]{64}$/;
var SHA1_HEX = /^[0-9a-f]{40}$/;
var DECIMAL = /^[1-9][0-9]*$/;
var RUNNER_REPOSITORY = /^[a-z0-9-]+-docker\.pkg\.dev\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+$/;
var PRODUCTION_PREDICATE_TYPE_KEY = "predicateType";
var PROFILES = {
  production: {
    project: "phoneware-edge",
    database: "(default)",
    firestore: {
      projectId: "phoneware-edge",
      databaseId: "(default)",
      host: "firestore.googleapis.com",
      port: 443,
      ssl: true,
      preferRest: false,
      keyFilename: PATHS.credentials
    }
  },
  emulator: {
    project: "demo-netsapiens-cutover",
    database: "(default)",
    firestore: {
      projectId: "demo-netsapiens-cutover",
      databaseId: "(default)",
      host: "127.0.0.1",
      port: 8080,
      ssl: false
    }
  }
};
var invoked = false;
function refuse3(message) {
  throw new CutoverRefusedError(message);
}
__name(refuse3, "refuse");
function sha256Hex2(bytes) {
  return createHash8("sha256").update(bytes).digest("hex");
}
__name(sha256Hex2, "sha256Hex");
function exactKeys2(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
__name(exactKeys2, "exactKeys");
function readFixedFile(path) {
  const stat = lstatSync2(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_INPUT_BYTES) refuse3("Protected input is not a bounded regular file");
  return readFileSync2(path);
}
__name(readFixedFile, "readFixedFile");
function parseStrictJson(bytes, keys, label) {
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    refuse3(`Malformed protected JSON: ${label}`);
  }
  if (!exactKeys2(value, keys)) refuse3(`Unexpected keys in protected JSON: ${label}`);
  return value;
}
__name(parseStrictJson, "parseStrictJson");
function assertSdk(sdk) {
  if (sdk === null || typeof sdk !== "object") refuse3("Firestore SDK argument is required");
  const candidate = sdk;
  if (typeof candidate.Firestore !== "function" || candidate.FieldPath === void 0 || typeof candidate.FieldPath.documentId !== "function") {
    refuse3("Firestore SDK argument does not expose the required classes");
  }
}
__name(assertSdk, "assertSdk");
function assertCredentialFile(bytes) {
  const credentials = parseStrictJson(bytes, [
    "type",
    "audience",
    "subject_token_type",
    "token_url",
    "service_account_impersonation_url",
    "credential_source"
  ], "credentials");
  const source = credentials.credential_source;
  if (credentials.type !== "external_account" || credentials.audience !== AUDIENCE || credentials.subject_token_type !== TOKEN_TYPE_JWT || credentials.token_url !== STS_URL || credentials.service_account_impersonation_url !== IMPERSONATION_URL || !exactKeys2(source, ["file", "format"]) || source.file !== PATHS.oidc || !exactKeys2(source.format, ["type"]) || source.format.type !== "text") {
    refuse3("Protected credential configuration does not match the fixed deploy provider");
  }
}
__name(assertCredentialFile, "assertCredentialFile");
function assertEnvironment() {
  for (const name of Object.keys(process.env)) {
    if (!ENV_ALLOW.has(name)) refuse3("Protected runner environment contains a disallowed variable");
  }
  if (process.execArgv.length !== 0) refuse3("Protected runner refuses node execution arguments");
  if (process.argv[1] !== RUNNER_PATH) refuse3("Protected runner entry path is not the fixed runner");
}
__name(assertEnvironment, "assertEnvironment");
function assertArgv(request) {
  const expected = argvFor(request);
  const actual = process.argv.slice(2);
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    refuse3("Protected runner argv does not match the request");
  }
}
__name(assertArgv, "assertArgv");
function assertRuntimeScopeFromCore(namespace, collectionGroups) {
  const core = canonical_core_exports;
  const scopeFn = core.getCutoverRuntimeCollectionScope;
  if (typeof scopeFn !== "function") {
    refuse3("Runtime collection scope requires the reviewed canonical core export getCutoverRuntimeCollectionScope");
  }
  const scope = scopeFn(namespace);
  if (scope === null || typeof scope !== "object" || scope.complete !== true) {
    refuse3("Runtime collection scope is incomplete");
  }
  if (!Array.isArray(scope.unscanned) || scope.unscanned.length !== 0) {
    refuse3("Runtime collection scope has unscanned sources");
  }
  if (!Array.isArray(scope.unresolved) || scope.unresolved.length !== 0) {
    refuse3("Runtime collection scope has unresolved collections");
  }
  if (typeof core.assertRuntimeScopeClosed !== "function") {
    refuse3("Runtime collection scope requires the reviewed closure check assertRuntimeScopeClosed");
  }
  try {
    core.assertRuntimeScopeClosed(scope);
  } catch {
    refuse3("Runtime collection scope is not closed");
  }
  const groups = scope.groups;
  if (!Array.isArray(groups) || groups.some((name) => typeof name !== "string")) {
    refuse3("Runtime collection scope groups are malformed");
  }
  const names = groups;
  if (new Set(names).size !== names.length) refuse3("Runtime collection scope groups have duplicates");
  if (canonicalJson([...names].sort()) !== canonicalJson([...collectionGroups].sort())) {
    refuse3("Signed index collection groups differ from the reviewed runtime collection scope");
  }
}
__name(assertRuntimeScopeFromCore, "assertRuntimeScopeFromCore");
var OIDC_ISSUER = "https://token.actions.githubusercontent.com";
var OIDC_REQUEST_AUDIENCE = "https://iam.googleapis.com/projects/859122914438/locations/global/workloadIdentityPools/github/providers/github";
var OIDC_WORKFLOW_REF = "phoneware/monorepo/.github/workflows/deploy.yml@refs/heads/main";
function assertMutatingClaims(bytes) {
  const parts = bytes.toString("utf8").trim().split(".");
  if (parts.length !== 3) refuse3("OIDC token is not a compact JWT");
  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    refuse3("OIDC token payload is not JSON");
  }
  if (claims === null || typeof claims !== "object") refuse3("OIDC token payload is not an object");
  const c = claims;
  if (c.iss !== OIDC_ISSUER || c.aud !== OIDC_REQUEST_AUDIENCE || c.repository_id !== "1278135054" || c.repository_owner_id !== "13560178" || c.repository !== "phoneware/monorepo" || c.ref !== "refs/heads/main" || c.event_name !== "workflow_dispatch" || c.workflow_ref !== OIDC_WORKFLOW_REF || c.environment !== "production" || typeof c.exp !== "number" || c.exp * 1e3 <= Date.now() || typeof c.run_id !== "string" || !DECIMAL.test(c.run_id) || typeof c.run_attempt !== "string" || !DECIMAL.test(c.run_attempt)) {
    refuse3("OIDC claims do not match the fixed production deploy dispatch");
  }
  return { runId: c.run_id, runAttempt: c.run_attempt };
}
__name(assertMutatingClaims, "assertMutatingClaims");
function fetchForProfile(profile) {
  if (profile === "production") return fetch;
  return (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const prefix = "https://firestore.googleapis.com/";
    if (!url.startsWith(prefix)) refuse3("Emulator Admin fetch refuses a non-emulator URL");
    return fetch(`http://127.0.0.1:8081/${url.slice(prefix.length)}`, init);
  };
}
__name(fetchForProfile, "fetchForProfile");
async function createProtectedFirestoreMigrationContext(...args) {
  if (invoked) refuse3("Protected migration context may be created once per process");
  invoked = true;
  if (args.length !== 1) refuse3("Protected migration context requires exactly one SDK argument");
  const firestoreSdk = args[0];
  if (import.meta.url !== BUNDLE_URL) refuse3("Protected migration context must run from the fixed bundle");
  assertEnvironment();
  assertSdk(firestoreSdk);
  const policy = parseStrictJson(readFixedFile(PATHS.trustPolicy), [
    "algorithm",
    "keyVersion",
    "publicKeyPem",
    "publicKeySha256",
    "runnerRepository"
  ], "trust-policy");
  if (policy.algorithm !== "RSA_SIGN_PSS_3072_SHA256" || typeof policy.keyVersion !== "string" || !policy.keyVersion || typeof policy.publicKeyPem !== "string" || typeof policy.publicKeySha256 !== "string" || !SHA256_HEX.test(policy.publicKeySha256) || sha256Hex2(Buffer.from(policy.publicKeyPem, "utf8")) !== policy.publicKeySha256 || typeof policy.runnerRepository !== "string" || !RUNNER_REPOSITORY.test(policy.runnerRepository)) {
    refuse3("Protected trust policy is malformed or does not match its pinned key");
  }
  const buildInfo = parseStrictJson(readFixedFile(PATHS.buildInfo), [
    "schemaVersion",
    PRODUCTION_PREDICATE_TYPE_KEY,
    "sessionSecretVersion",
    "publicPackageSourceSha",
    "privateRunnerSha",
    "workflowSourceSha",
    "assemblyDigest",
    "profile"
  ], "build-info");
  if (buildInfo.schemaVersion !== 2 || buildInfo[PRODUCTION_PREDICATE_TYPE_KEY] !== MCP_CUTOVER_PREDICATE_TYPE || typeof buildInfo.sessionSecretVersion !== "string" || !DECIMAL.test(buildInfo.sessionSecretVersion) || typeof buildInfo.publicPackageSourceSha !== "string" || !SHA1_HEX.test(buildInfo.publicPackageSourceSha) || typeof buildInfo.privateRunnerSha !== "string" || !SHA1_HEX.test(buildInfo.privateRunnerSha) || typeof buildInfo.workflowSourceSha !== "string" || !SHA1_HEX.test(buildInfo.workflowSourceSha) || typeof buildInfo.assemblyDigest !== "string" || !SHA256_HEX.test(buildInfo.assemblyDigest) || buildInfo.profile !== "production" && buildInfo.profile !== "emulator") {
    refuse3("Protected build information is malformed");
  }
  const profile = buildInfo.profile;
  const row = PROFILES[profile];
  const request = parseProtectedRequestV2(readFixedFile(PATHS.request));
  if (request.profile !== profile) refuse3("Request profile does not match the build profile");
  assertArgv(request);
  const bundleDigest = sha256Hex2(readFixedFile(BUNDLE_PATH));
  if (bundleDigest !== request.identity.protocolDigest) refuse3("Bundle digest does not match the approved protocol digest");
  const attestationBytes = readFixedFile(PATHS.attestation);
  if (sha256Hex2(attestationBytes) !== request.approvalPayloadSha256) {
    refuse3("Attestation manifest does not match the approved payload digest");
  }
  const indexBytes = readFixedFile(PATHS.indexSchema);
  const index = parseStrictJson(indexBytes, ["schemaVersion", "kind", "binding", "policy", "provenance"], "index-schema");
  const indexText = new TextDecoder("utf-8", { fatal: true }).decode(indexBytes);
  if (canonicalJson(index) !== indexText) refuse3("Index schema is not canonical JSON");
  const indexBinding = index.binding;
  const provenance = index.provenance;
  if (index.schemaVersion !== 2 || index.kind !== "firestore-index-policy" || indexBinding?.profile !== profile || indexBinding?.project !== row.project || indexBinding?.database !== row.database || provenance?.databaseResource !== `projects/${row.project}/databases/${row.database}` || provenance?.paginationComplete !== true) {
    refuse3("Index policy binding does not match the protected database profile");
  }
  const groups = indexBinding.collectionGroups;
  const policyGroups = index.policy?.collections?.map((entry) => entry.collectionGroup) ?? [];
  if (!Array.isArray(groups) || groups.some((name) => typeof name !== "string") || canonicalJson([...groups].sort()) !== canonicalJson(groups) || new Set(groups).size !== groups.length || canonicalJson([...policyGroups].sort()) !== canonicalJson([...groups].sort())) {
    refuse3("Index policy collection groups are not the signed set");
  }
  assertRuntimeScopeFromCore(request.namespace, groups);
  const inventoryBinding = profile === "production" ? PRODUCTION_INVENTORY_BINDING : EMULATOR_INVENTORY_BINDING;
  if (inventoryBinding.project !== row.project || inventoryBinding.database !== row.database) {
    refuse3("Inventory binding does not match the protected database profile");
  }
  const censusBytes = readFixedFile(PATHS.writerCensus);
  const writerBytes = readFixedFile(PATHS.writerInventory);
  const collectionBytes = readFixedFile(PATHS.collectionInventory);
  let census;
  let writer;
  let collection;
  try {
    census = parseProtectedJson(censusBytes);
    writer = parseProtectedJson(writerBytes);
    collection = parseProtectedJson(collectionBytes);
    if (canonicalJson(writer) !== new TextDecoder("utf-8", { fatal: true }).decode(writerBytes) || canonicalJson(collection) !== new TextDecoder("utf-8", { fatal: true }).decode(collectionBytes)) {
      refuse3("Protected inventory files are not canonical JSON");
    }
    const inventory = joinFromFiles(writer, collection, inventoryBinding);
    if (compareCensus({ census, ...inventory, scopeGroups: groups, binding: inventoryBinding }).decision !== "match") {
      refuse3("Protected inventory does not match the approved census");
    }
  } catch {
    refuse3("Protected inventory evidence is invalid");
  }
  const writerCensusDigest = sha256Hex2(censusBytes);
  const writerInventoryDigest = sha256Hex2(writerBytes);
  const collectionInventoryDigest = sha256Hex2(collectionBytes);
  const indexSchemaDigest = sha256Hex2(Buffer.from(canonicalJson(index), "utf8"));
  const indexPolicyDigest = sha256Hex2(Buffer.from(canonicalJson(index.policy), "utf8"));
  const approval = parseStrictJson(readFixedFile(PATHS.approval), ["payloadType", "payload", "signatures"], "approval");
  const expectedKeyVersion = policy.keyVersion;
  const verified = verifyDSSEEnvelope(approval, policy.publicKeyPem, {
    expectedKeyVersion,
    expectedPredicateType: buildInfo[PRODUCTION_PREDICATE_TYPE_KEY],
    runnerRepository: policy.runnerRepository,
    expectedPredicate: {
      codeSha: request.identity.codeSha,
      publicPackageSourceSha: buildInfo.publicPackageSourceSha,
      privateRunnerSha: buildInfo.privateRunnerSha,
      workflowSourceSha: buildInfo.workflowSourceSha,
      assemblyDigest: buildInfo.assemblyDigest,
      sessionSecretVersion: buildInfo.sessionSecretVersion,
      image: request.identity.codeArtifact,
      packageIntegrity: request.identity.packageIntegrity,
      indexSchemaDigest,
      indexPolicyDigest,
      project: row.project,
      database: row.database,
      namespace: request.namespace,
      protocolDigest: request.identity.protocolDigest,
      writerCensusDigest,
      writerInventoryDigest,
      collectionInventoryDigest
    }
  });
  if (!Buffer.from(verified.payloadBytes).equals(attestationBytes)) {
    refuse3("Verified approval payload is not the attestation manifest bytes");
  }
  const credentialsPresent = existsSync(PATHS.credentials);
  const oidcPresent = existsSync(PATHS.oidc);
  let oidcBefore = null;
  if (profile === "production") {
    assertCredentialFile(readFixedFile(PATHS.credentials));
    oidcBefore = readFixedFile(PATHS.oidc);
  } else if (credentialsPresent || oidcPresent) {
    refuse3("Emulator profile refuses mounted production credentials");
  }
  const mutating = request.action === "activate" || request.action === "adopt" && "dryRun" in request.options && request.options.dryRun === false;
  let invocation = null;
  if (oidcBefore !== null && mutating) {
    invocation = assertMutatingClaims(oidcBefore);
  }
  const subjectDescriptor = subjectDescriptorFromPredicate(request.namespace, verified.statement.predicate);
  const key = deriveStoreKey(readFixedFile(PATHS.sessionSecret).toString("utf8"));
  const sdk = firestoreSdk;
  const Firestore = sdk.Firestore;
  const settings = row.firestore;
  const db = new Firestore({ ...settings });
  if (!(db instanceof Firestore)) refuse3("Constructed Firestore handle is not the SDK class");
  let adminAccess = null;
  let credentialDigest = null;
  let adminTokenDigest = null;
  if (profile === "production") {
    if (oidcBefore === null) refuse3("Production credential bytes were not bound");
    const AdminClient = sdk.v1?.FirestoreAdminClient;
    if (typeof AdminClient !== "function") refuse3("Firestore Admin client is not available in the SDK");
    const client = new AdminClient({ projectId: row.project, keyFilename: PATHS.credentials, universeDomain: "googleapis.com" });
    const token = await client.auth.getAccessToken();
    await client.close();
    if (typeof token !== "string" || !token) refuse3("Admin access token was not obtained");
    adminTokenDigest = sha256Hex2(Buffer.from(token, "utf8"));
    const oidcAfter = readFixedFile(PATHS.oidc);
    if (!oidcAfter.equals(oidcBefore)) refuse3("Credential token bytes changed across the STS exchange");
    credentialDigest = sha256Hex2(oidcAfter);
    if (request.action === "adopt" || request.action === "activate") {
      adminAccess = { getAccessToken: /* @__PURE__ */ __name(async () => token, "getAccessToken"), fetchFn: fetchForProfile(profile) };
    }
  } else if (profile === "emulator" && (request.action === "adopt" || request.action === "activate")) {
    adminTokenDigest = sha256Hex2(Buffer.from("owner", "utf8"));
    adminAccess = { getAccessToken: /* @__PURE__ */ __name(async () => "owner", "getAccessToken"), fetchFn: fetchForProfile(profile) };
  }
  const operations = {
    inspect: "inspect",
    adopt: "adopt",
    activate: "activate",
    status: "status",
    "verify-active-ownership": "verifyActive"
  };
  let authorizedOptions;
  if (request.action === "verify-active-ownership") {
    if (!("migrationManifestDigest" in request.options)) throw new CutoverRefusedError("Verify request options are malformed");
    authorizedOptions = { migrationManifestDigest: request.options.migrationManifestDigest };
  } else {
    authorizedOptions = request.options;
  }
  bindProtectedContext(db, {
    namespace: request.namespace,
    expectedEpoch: request.identity.expectedEpoch,
    migrationRunId: request.identity.migrationRunId,
    codeSha: request.identity.codeSha,
    codeArtifact: request.identity.codeArtifact,
    packageIntegrity: request.identity.packageIntegrity,
    protocolDigest: request.identity.protocolDigest,
    profile,
    project: row.project,
    database: row.database,
    assemblyDigest: buildInfo.assemblyDigest,
    indexSchemaDigest,
    indexPolicyDigest,
    indexSchema: index,
    key,
    FieldPath: sdk.FieldPath,
    authorized: { operation: operations[request.action], options: { ...authorizedOptions } },
    adminAccess,
    invocation,
    credentialDigest,
    adminTokenDigest,
    subjectDescriptor
  });
  return {
    db,
    FieldPath: sdk.FieldPath,
    key,
    namespace: request.namespace,
    expectedEpoch: request.identity.expectedEpoch,
    migrationRunId: request.identity.migrationRunId,
    codeSha: request.identity.codeSha,
    codeArtifact: request.identity.codeArtifact,
    packageIntegrity: request.identity.packageIntegrity,
    protocolDigest: request.identity.protocolDigest
  };
}
__name(createProtectedFirestoreMigrationContext, "createProtectedFirestoreMigrationContext");
export {
  CutoverFenceError,
  CutoverRefusedError,
  SUPPORTED_CUTOVER_NAMESPACES,
  activateFirestoreMigration,
  adoptFirestoreLegacyTokens,
  assertSupportedCutoverNamespace,
  assertValidMigrationContext2 as assertValidMigrationContext,
  checkMutationGuardInTransaction,
  claimUpstreamGrantInTransaction,
  createProtectedFirestoreMigrationContext,
  deriveStoreKey,
  getCutoverFenceDocRef,
  getCutoverFenceRecord,
  getCutoverOperationDocRef,
  getCutoverOperationsColRef,
  getFirestoreMigrationStatus,
  initializeCutoverFence,
  inspectFirestoreLegacyMigration,
  isCutoverFenceError,
  isCutoverRefusedError,
  isLegacyMutationPermittedInTransaction,
  isSupportedCutoverNamespace,
  markIrreversibleInTransaction,
  markOperationAmbiguous,
  parseCutoverFenceRecord,
  readCutoverFenceInTransaction,
  reconcileUpstreamGrantInTransaction,
  releaseLegacyOperation,
  startMonotonicTimer,
  transitionCutoverFenceState,
  verifyActiveFirestoreMigration,
  withLegacyOperation
};
