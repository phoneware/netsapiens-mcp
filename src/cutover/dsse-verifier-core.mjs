import { constants, createPublicKey, verify } from "node:crypto";

export const DSSE_PAYLOAD_TYPE = "application/vnd.in-toto+json";
const EXPECTED_FIELDS = ["codeSha", "publicPackageSourceSha", "privateRunnerSha", "workflowSourceSha", "assemblyDigest", "sessionSecretVersion", "image", "packageIntegrity", "indexSchemaDigest", "indexPolicyDigest", "project", "database", "namespace", "protocolDigest"];
const SUBJECTS = ["cutover-protocol.mjs", "image", "package", "git-commit", "cutover-runner-image"];
const OPTIONAL_PREDICATE = ["readonlyServiceConfiguration", "builder", "assembledAt", "terraformPlanDigest", "terraformSavedPlanDigest", "terraformProjectionDigest", "observationRunId", "observationRunAttempt", "observationArtifactId", "observationArtifactDigest"];
const exact = (object, keys) => object && typeof object === "object" && !Array.isArray(object) && JSON.stringify(Object.keys(object).sort()) === JSON.stringify([...keys].sort());
const sha = (value, length) => typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`).test(value);
const decimal = (value) => typeof value === "string" && /^[1-9][0-9]*$/.test(value);
const validSri = (value) => {
  if (typeof value !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(value)) return false;
  const decoded = Buffer.from(value.slice(7), "base64");
  return decoded.length === 64 && `sha512-${decoded.toString("base64")}` === value;
};

export function canonicalJson(value) {
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

export function formatPAE(payloadType, payloadBytes) {
  const type = Buffer.from(payloadType, "utf8");
  return Buffer.concat([Buffer.from(`DSSEv1 ${type.length} `), type, Buffer.from(` ${payloadBytes.length} `), payloadBytes]);
}

function decodeBase64(value) {
  if (typeof value !== "string" || !value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("Invalid DSSE base64");
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new Error("Noncanonical DSSE base64");
  return decoded;
}

// Protected caller policy provides every expected value; the envelope never chooses trust.
export function verifyDSSEEnvelope(envelope, publicKeyPem, options) {
  if (!exact(options, ["expectedKeyVersion", "expectedPredicateType", "runnerRepository", "expectedPredicate"]) ||
    typeof options.expectedKeyVersion !== "string" || !options.expectedKeyVersion ||
    typeof options.expectedPredicateType !== "string" || !options.expectedPredicateType ||
    typeof options.runnerRepository !== "string" || !options.runnerRepository ||
    !exact(options.expectedPredicate, EXPECTED_FIELDS)) throw new Error("Incomplete protected DSSE policy");
  const expected = options.expectedPredicate;
  if (EXPECTED_FIELDS.some((key) => typeof expected[key] !== "string" || !expected[key]) ||
    ![expected.codeSha, expected.publicPackageSourceSha, expected.privateRunnerSha, expected.workflowSourceSha].every((value) => sha(value, 40)) ||
    expected.codeSha !== expected.publicPackageSourceSha || ![expected.assemblyDigest, expected.indexSchemaDigest, expected.indexPolicyDigest, expected.protocolDigest].every((value) => sha(value, 64)) ||
    !decimal(expected.sessionSecretVersion) || !/@sha256:[0-9a-f]{64}$/.test(expected.image) ||
    !validSri(expected.packageIntegrity) || !["mcp", "pwmcp", "readonly_mcp"].includes(expected.namespace)) throw new Error("Malformed protected DSSE identity");
  if (!exact(envelope, ["payloadType", "payload", "signatures"]) || envelope.payloadType !== DSSE_PAYLOAD_TYPE ||
    !Array.isArray(envelope.signatures) || envelope.signatures.length !== 1 ||
    !exact(envelope.signatures[0], ["keyid", "sig"]) || envelope.signatures[0].keyid !== options.expectedKeyVersion) throw new Error("Invalid DSSE envelope or signature identity");
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== "rsa") throw new Error("Invalid public key type: expected rsa");
  if (key.asymmetricKeyDetails?.modulusLength !== 3072) throw new Error(`Invalid RSA modulusLength: expected 3072, got ${key.asymmetricKeyDetails?.modulusLength}`);
  const payloadBytes = decodeBase64(envelope.payload), signatureBytes = decodeBase64(envelope.signatures[0].sig);
  if (!verify("sha256", formatPAE(envelope.payloadType, payloadBytes), { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, signatureBytes)) throw new Error("DSSE envelope signature verification failed against approved public key");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
  const statement = JSON.parse(text);
  if (canonicalJson(statement) !== text || !exact(statement, ["_type", "subject", "predicateType", "predicate"]) ||
    statement._type !== "https://in-toto.io/Statement/v1" || statement.predicateType !== options.expectedPredicateType ||
    !Array.isArray(statement.subject) || statement.subject.length !== SUBJECTS.length) throw new Error("Invalid canonical in-toto statement");
  const subjects = new Map();
  for (const subject of statement.subject) {
    if (!exact(subject, ["name", "digest"]) || !SUBJECTS.includes(subject.name) || subjects.has(subject.name)) throw new Error("Invalid signed subject set");
    subjects.set(subject.name, subject.digest);
  }
  const predicate = statement.predicate;
  if (!predicate || typeof predicate !== "object" || Array.isArray(predicate) ||
    Object.keys(predicate).some((key) => !EXPECTED_FIELDS.includes(key) && !OPTIONAL_PREDICATE.includes(key) && key !== "keyVersion" && key !== "runner") ||
    predicate.keyVersion !== options.expectedKeyVersion || EXPECTED_FIELDS.some((key) => predicate[key] !== expected[key])) throw new Error("Signed predicate differs from protected policy");
  const runner = predicate.runner;
  if (!exact(runner, ["image", "childManifestDigest", "configDigest", "archiveSha256"]) ||
    !/^sha256:[0-9a-f]{64}$/.test(runner.childManifestDigest ?? "") || !/^sha256:[0-9a-f]{64}$/.test(runner.configDigest ?? "") ||
    !sha(runner.archiveSha256, 64) || runner.image !== `${options.runnerRepository}@${runner.childManifestDigest}`) throw new Error("Invalid signed runner descriptor");
  const imageDigest = /@sha256:([0-9a-f]{64})$/.exec(expected.image)[1];
  const expectedSubjects = new Map([
    ["cutover-protocol.mjs", { sha256: expected.protocolDigest }], ["image", { sha256: imageDigest }],
    ["package", { sha512: Buffer.from(expected.packageIntegrity.slice(7), "base64").toString("hex") }], ["git-commit", { sha1: expected.codeSha }],
    ["cutover-runner-image", { sha256: runner.childManifestDigest.slice(7) }],
  ]);
  for (const [name, value] of expectedSubjects) if (!exact(subjects.get(name), Object.keys(value)) || canonicalJson(subjects.get(name)) !== canonicalJson(value)) throw new Error("Signed subject differs from protected policy");
  const readonly = predicate.readonlyServiceConfiguration;
  if (expected.namespace === "readonly_mcp") {
    if (!exact(readonly, ["platforms", "oauthClientSecretVersion"]) || typeof readonly.platforms !== "string" || !readonly.platforms || !decimal(readonly.oauthClientSecretVersion)) throw new Error("Invalid signed readonly configuration");
  } else if (readonly !== undefined) throw new Error("Unexpected readonly configuration");
  if (![predicate.terraformPlanDigest, predicate.terraformSavedPlanDigest, predicate.terraformProjectionDigest].every((value) => sha(value, 64)) ||
    ![predicate.observationRunId, predicate.observationRunAttempt, predicate.observationArtifactId].every(decimal) ||
    !/^sha256:[0-9a-f]{64}$/.test(predicate.observationArtifactDigest ?? "")) throw new Error("Invalid or missing signed observation identity");
  if (predicate.builder !== undefined && (typeof predicate.builder !== "string" || !predicate.builder)) throw new Error("Invalid builder metadata");
  if (predicate.assembledAt !== undefined && (typeof predicate.assembledAt !== "string" || !Number.isFinite(Date.parse(predicate.assembledAt)))) throw new Error("Invalid assembly timestamp");
  return { valid: true, keyid: options.expectedKeyVersion, payload: statement, statement, payloadBytes, signatureBytes };
}
