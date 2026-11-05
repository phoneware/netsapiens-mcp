import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { canonicalJson, verifyDSSEEnvelope } from '../cutover/dsse-verifier-core.mjs';
import { CutoverRefusedError } from './errors.js';
import { deriveStoreKey } from './codec.js';
import { bindProtectedContext } from './protected-binding.js';

// Runner-only entry. It takes no selectors and reads only fixed mounts. The
// constructed database handle is bound privately; the returned object carries
// exactly the ten public MigrationContext fields and nothing else.

const RUN_DIR = '/run/cutover';
const OPT_DIR = '/opt/cutover';
const PATHS = {
  request: `${RUN_DIR}/request.json`,
  approval: `${RUN_DIR}/approval.dsse.json`,
  attestation: `${RUN_DIR}/attestation-manifest.json`,
  indexSchema: `${RUN_DIR}/index-schema.json`,
  credentials: `${RUN_DIR}/credentials.json`,
  oidc: `${RUN_DIR}/oidc.jwt`,
  sessionSecret: `${RUN_DIR}/session-secret`,
  trustPolicy: `${OPT_DIR}/trust-policy.json`,
  buildInfo: `${OPT_DIR}/build-info.json`,
} as const;

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const PREDICATE_TYPE_KEY = 'predicateType';
const PROJECT = 'phoneware-edge';
const DATABASE = '(default)';
const TOKEN_TYPE_JWT = 'urn:ietf:params:oauth:token-type:jwt';
const AUDIENCE = '//iam.googleapis.com/projects/859122914438/locations/global/workloadIdentityPools/github/providers/github';
const STS_URL = 'https://sts.googleapis.com/v1/token';
const IMPERSONATION_URL = 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/edge-tf-deployer@phoneware-edge.iam.gserviceaccount.com:generateAccessToken';
const NAMESPACES = ['mcp', 'pwmcp', 'readonly_mcp'] as const;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SHA1_HEX = /^[0-9a-f]{40}$/;
const SRI_SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;
const OCI_IMAGE = /^[a-z0-9][a-z0-9._/-]*[a-z0-9]@sha256:[0-9a-f]{64}$/;
const RUNNER_REPOSITORY = /^[a-z0-9-]+-docker\.pkg\.dev\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+$/;
const RUN_ID = /^[A-Za-z0-9_-]{8,64}$/;

export const PROTECTED_RUNNER_ACTIONS = ['verify-active-ownership'] as const;

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function readFixedFile(path: string): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_INPUT_BYTES) {
    throw new CutoverRefusedError('Protected input is not a bounded regular file');
  }
  return readFileSync(path);
}

function parseStrictJson(bytes: Buffer, keys: readonly string[], label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new CutoverRefusedError(`Malformed protected JSON: ${label}`);
  }
  if (!exactKeys(value, keys)) throw new CutoverRefusedError(`Unexpected keys in protected JSON: ${label}`);
  return value;
}

function assertAbsentEnvironment(): void {
  // Any emulator, proxy, preload, or CA override changes the transport
  // silently, so the protected runner refuses to start with one present.
  for (const name of Object.keys(process.env)) {
    if (/EMULATOR|_PROXY$|^NODE_OPTIONS$|^NODE_EXTRA_CA_CERTS$/i.test(name)) {
      throw new CutoverRefusedError('Protected runner refuses an environment transport override');
    }
  }
}

function assertNamespace(value: unknown): asserts value is (typeof NAMESPACES)[number] {
  if (typeof value !== 'string' || !(NAMESPACES as readonly string[]).includes(value)) {
    throw new CutoverRefusedError('Protected request namespace is not supported');
  }
}

function assertCredentialFile(bytes: Buffer): void {
  const credentials = parseStrictJson(bytes, [
    'type', 'audience', 'subject_token_type', 'token_url', 'service_account_impersonation_url', 'credential_source',
  ], 'credentials');
  const source = credentials.credential_source;
  if (credentials.type !== 'external_account' ||
    credentials.audience !== AUDIENCE ||
    credentials.subject_token_type !== TOKEN_TYPE_JWT ||
    credentials.token_url !== STS_URL ||
    credentials.service_account_impersonation_url !== IMPERSONATION_URL ||
    !exactKeys(source, ['file', 'format']) ||
    source.file !== PATHS.oidc ||
    !exactKeys(source.format, ['type']) ||
    source.format.type !== 'text') {
    throw new CutoverRefusedError('Protected credential configuration does not match the fixed deploy provider');
  }
}

// Constructs the protected database handle and returns the public context.
// Refuses before any credential, approval, or data read if any input is absent
// or unauthenticated. The trust policy is required and is never synthesized.
export async function createProtectedFirestoreMigrationContext(): Promise<{
  db: object;
  FieldPath: unknown;
  key: Uint8Array;
  namespace: (typeof NAMESPACES)[number];
  expectedEpoch: number;
  migrationRunId: string;
  codeSha: string;
  codeArtifact: string;
  packageIntegrity: string;
  protocolDigest: string;
}> {
  assertAbsentEnvironment();

  const policy = parseStrictJson(readFixedFile(PATHS.trustPolicy), [
    'algorithm', 'keyVersion', 'publicKeyPem', 'publicKeySha256', 'runnerRepository',
  ], 'trust-policy');
  if (policy.algorithm !== 'RSA_SIGN_PSS_3072_SHA256' ||
    typeof policy.keyVersion !== 'string' || !policy.keyVersion ||
    typeof policy.publicKeyPem !== 'string' ||
    typeof policy.publicKeySha256 !== 'string' || !SHA256_HEX.test(policy.publicKeySha256) ||
    sha256Hex(Buffer.from(policy.publicKeyPem, 'utf8')) !== policy.publicKeySha256 ||
    typeof policy.runnerRepository !== 'string' || !RUNNER_REPOSITORY.test(policy.runnerRepository)) {
    throw new CutoverRefusedError('Protected trust policy is malformed or does not match its pinned key');
  }

  const buildInfo = parseStrictJson(readFixedFile(PATHS.buildInfo), [
    'schemaVersion', PREDICATE_TYPE_KEY, 'sessionSecretVersion', 'publicPackageSourceSha',
    'privateRunnerSha', 'workflowSourceSha', 'assemblyDigest',
  ], 'build-info');
  if (buildInfo.schemaVersion !== 1 ||
    typeof buildInfo[PREDICATE_TYPE_KEY] !== 'string' || !buildInfo[PREDICATE_TYPE_KEY] ||
    typeof buildInfo.sessionSecretVersion !== 'string' || !/^[1-9][0-9]*$/.test(buildInfo.sessionSecretVersion) ||
    typeof buildInfo.publicPackageSourceSha !== 'string' || !SHA1_HEX.test(buildInfo.publicPackageSourceSha) ||
    typeof buildInfo.privateRunnerSha !== 'string' || !SHA1_HEX.test(buildInfo.privateRunnerSha) ||
    typeof buildInfo.workflowSourceSha !== 'string' || !SHA1_HEX.test(buildInfo.workflowSourceSha) ||
    typeof buildInfo.assemblyDigest !== 'string' || !SHA256_HEX.test(buildInfo.assemblyDigest)) {
    throw new CutoverRefusedError('Protected build information is malformed');
  }

  const requestBytes = readFixedFile(PATHS.request);
  const request = parseStrictJson(requestBytes, [
    'schemaVersion', 'action', 'profile', 'namespace', 'approvalPayloadSha256', 'expected',
  ], 'request');
  const expected = request.expected;
  if (request.schemaVersion !== 1 ||
    request.action !== 'verify-active-ownership' ||
    request.profile !== 'production') {
    throw new CutoverRefusedError('Protected request action or profile is not permitted');
  }
  assertNamespace(request.namespace);
  if (typeof request.approvalPayloadSha256 !== 'string' || !SHA256_HEX.test(request.approvalPayloadSha256) ||
    !exactKeys(expected, ['expectedEpoch', 'migrationRunId', 'codeSha', 'codeArtifact', 'packageIntegrity',
      'protocolDigest', 'migrationManifestDigest', 'planDigest'])) {
    throw new CutoverRefusedError('Protected request binding is malformed');
  }
  const e = expected as Record<string, unknown>;
  if (typeof e.expectedEpoch !== 'number' || !Number.isSafeInteger(e.expectedEpoch) || e.expectedEpoch < 1 ||
    typeof e.migrationRunId !== 'string' || !RUN_ID.test(e.migrationRunId) ||
    typeof e.codeSha !== 'string' || !SHA1_HEX.test(e.codeSha) ||
    typeof e.codeArtifact !== 'string' || !OCI_IMAGE.test(e.codeArtifact) ||
    typeof e.packageIntegrity !== 'string' || !SRI_SHA512.test(e.packageIntegrity) ||
    typeof e.protocolDigest !== 'string' || !SHA256_HEX.test(e.protocolDigest) ||
    typeof e.migrationManifestDigest !== 'string' || !SHA256_HEX.test(e.migrationManifestDigest) ||
    typeof e.planDigest !== 'string' || !SHA256_HEX.test(e.planDigest)) {
    throw new CutoverRefusedError('Protected request expected identity is malformed');
  }

  const attestationBytes = readFixedFile(PATHS.attestation);
  if (sha256Hex(attestationBytes) !== request.approvalPayloadSha256) {
    throw new CutoverRefusedError('Attestation manifest does not match the approved payload digest');
  }

  const indexBytes = readFixedFile(PATHS.indexSchema);
  const index = parseStrictJson(indexBytes, ['schemaVersion', 'kind', 'binding', 'policy', 'provenance'], 'index-schema');
  const binding = index.binding as Record<string, unknown> | undefined;
  const provenance = index.provenance as Record<string, unknown> | undefined;
  if (index.schemaVersion !== 2 || index.kind !== 'firestore-index-policy' ||
    binding?.profile !== 'production' || binding?.project !== PROJECT || binding?.database !== DATABASE ||
    provenance?.databaseResource !== `projects/${PROJECT}/databases/${DATABASE}` ||
    provenance?.paginationComplete !== true) {
    throw new CutoverRefusedError('Index policy binding does not match the protected production database');
  }
  const indexSchemaDigest = sha256Hex(Buffer.from(canonicalJson(index), 'utf8'));
  const indexPolicyDigest = sha256Hex(Buffer.from(canonicalJson(index.policy), 'utf8'));

  const credentialBytes = readFixedFile(PATHS.credentials);
  assertCredentialFile(credentialBytes);
  readFixedFile(PATHS.oidc);

  const approval = parseStrictJson(readFixedFile(PATHS.approval), ['payloadType', 'payload', 'signatures'], 'approval');
  const verified = verifyDSSEEnvelope(approval, policy.publicKeyPem as string, {
    expectedKeyVersion: policy.keyVersion as string,
    expectedPredicateType: buildInfo[PREDICATE_TYPE_KEY] as string,
    runnerRepository: policy.runnerRepository as string,
    expectedPredicate: {
      codeSha: e.codeSha as string,
      publicPackageSourceSha: buildInfo.publicPackageSourceSha as string,
      privateRunnerSha: buildInfo.privateRunnerSha as string,
      workflowSourceSha: buildInfo.workflowSourceSha as string,
      assemblyDigest: buildInfo.assemblyDigest as string,
      sessionSecretVersion: buildInfo.sessionSecretVersion as string,
      image: e.codeArtifact as string,
      packageIntegrity: e.packageIntegrity as string,
      indexSchemaDigest,
      indexPolicyDigest,
      project: PROJECT,
      database: DATABASE,
      namespace: request.namespace as string,
      protocolDigest: e.protocolDigest as string,
    },
  });
  if (!Buffer.from(verified.payloadBytes).equals(attestationBytes)) {
    throw new CutoverRefusedError('Verified approval payload is not the attestation manifest bytes');
  }

  // Secret bytes are used exactly as stored: no trimming or fallback.
  const sessionSecret = readFixedFile(PATHS.sessionSecret).toString('utf8');
  const key = deriveStoreKey(sessionSecret);

  // Exception: @google-cloud/firestore is an optional peer. A static import would
  // make the canonical bundle fail to load for consumers that do not install it.
  const sdk = await import('@google-cloud/firestore');
  const db = new sdk.Firestore({
    projectId: PROJECT,
    databaseId: DATABASE,
    host: 'firestore.googleapis.com',
    port: 443,
    ssl: true,
    keyFilename: PATHS.credentials,
  });

  const namespace = request.namespace as (typeof NAMESPACES)[number];
  bindProtectedContext(db, {
    namespace,
    expectedEpoch: e.expectedEpoch as number,
    migrationRunId: e.migrationRunId as string,
    codeSha: e.codeSha as string,
    codeArtifact: e.codeArtifact as string,
    packageIntegrity: e.packageIntegrity as string,
    protocolDigest: e.protocolDigest as string,
    migrationManifestDigest: e.migrationManifestDigest as string,
    planDigest: e.planDigest as string,
    key,
    FieldPath: sdk.FieldPath,
    indexSchema: index,
    allowedOperations: new Set(['verifyActive']),
  });

  return {
    db,
    FieldPath: sdk.FieldPath,
    key,
    namespace,
    expectedEpoch: e.expectedEpoch as number,
    migrationRunId: e.migrationRunId as string,
    codeSha: e.codeSha as string,
    codeArtifact: e.codeArtifact as string,
    packageIntegrity: e.packageIntegrity as string,
    protocolDigest: e.protocolDigest as string,
  };
}
