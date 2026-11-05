import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { canonicalJson, MCP_CUTOVER_PREDICATE_TYPE, verifyDSSEEnvelope } from '../cutover/dsse-verifier-core.mjs';
import * as canonicalCore from '../cutover/canonical-core.mjs';
import { subjectDescriptorFromPredicate } from './subject-descriptor.js';
import { CutoverRefusedError } from './errors.js';
import { deriveStoreKey } from './codec.js';
import { bindProtectedContext, type ProtectedOperation } from './protected-binding.js';
import { argvFor, parseProtectedRequestV2, type ProtectedRequestV2 } from './protected-request.js';

// Runner-only factory. It takes the Firestore SDK as its single argument (the
// common bundle has no dynamic imports and no ambient SDK) and reads only fixed
// mounts. The returned object carries exactly the ten public MigrationContext
// fields. The database handle is bound privately, once per process.

const RUN_DIR = '/run/cutover';
const OPT_DIR = '/opt/cutover';
const BUNDLE_URL = 'file:///opt/cutover/cutover-protocol.mjs';
const RUNNER_PATH = '/opt/cutover/runner.mjs';
const BUNDLE_PATH = '/opt/cutover/cutover-protocol.mjs';
const PATHS = {
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
  buildInfo: `${OPT_DIR}/build-info.json`,
} as const;

const ENV_ALLOW = new Set(['HOME', 'HOSTNAME', 'NODE_VERSION', 'PATH', 'YARN_VERSION']);
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const TOKEN_TYPE_JWT = 'urn:ietf:params:oauth:token-type:jwt';
const AUDIENCE = '//iam.googleapis.com/projects/859122914438/locations/global/workloadIdentityPools/github/providers/github';
const STS_URL = 'https://sts.googleapis.com/v1/token';
const IMPERSONATION_URL = 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/edge-tf-deployer@phoneware-edge.iam.gserviceaccount.com:generateAccessToken';
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SHA1_HEX = /^[0-9a-f]{40}$/;
const DECIMAL = /^[1-9][0-9]*$/;
const RUNNER_REPOSITORY = /^[a-z0-9-]+-docker\.pkg\.dev\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+$/;
const PRODUCTION_PREDICATE_TYPE_KEY = 'predicateType';

// Profile rows: the only place endpoints, projects and TLS settings come from.
// Only the emulator profile may use plaintext or the emulator Admin endpoint.
const PROFILES = {
  production: {
    project: 'phoneware-edge',
    database: '(default)',
    firestore: {
      projectId: 'phoneware-edge',
      databaseId: '(default)',
      host: 'firestore.googleapis.com',
      port: 443,
      ssl: true,
      preferRest: false,
      keyFilename: PATHS.credentials,
    },
  },
  emulator: {
    project: 'demo-netsapiens-cutover',
    database: '(default)',
    firestore: {
      projectId: 'demo-netsapiens-cutover',
      databaseId: '(default)',
      host: '127.0.0.1',
      port: 8080,
      ssl: false,
    },
  },
} as const;

type Profile = keyof typeof PROFILES;

interface AdminClient {
  readonly auth: { getAccessToken(): Promise<string | null | undefined> };
  close(): Promise<void>;
}

interface FirestoreSdk {
  readonly Firestore: new (settings: Record<string, unknown>) => object;
  readonly FieldPath: { documentId(): unknown };
  readonly v1?: { readonly FirestoreAdminClient?: new (options: Record<string, unknown>) => AdminClient };
}

export interface ProtectedMigrationContext {
  db: object;
  FieldPath: unknown;
  key: Uint8Array;
  namespace: ProtectedRequestV2['namespace'];
  expectedEpoch: number;
  migrationRunId: string;
  codeSha: string;
  codeArtifact: string;
  packageIntegrity: string;
  protocolDigest: string;
}

let invoked = false;

function refuse(message: string): never {
  throw new CutoverRefusedError(message);
}

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
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_INPUT_BYTES) refuse('Protected input is not a bounded regular file');
  return readFileSync(path);
}

function parseStrictJson(bytes: Buffer, keys: readonly string[], label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    refuse(`Malformed protected JSON: ${label}`);
  }
  if (!exactKeys(value, keys)) refuse(`Unexpected keys in protected JSON: ${label}`);
  return value;
}

function assertSdk(sdk: unknown): asserts sdk is FirestoreSdk {
  if (sdk === null || typeof sdk !== 'object') refuse('Firestore SDK argument is required');
  const candidate = sdk as Partial<FirestoreSdk>;
  if (typeof candidate.Firestore !== 'function' || candidate.FieldPath === undefined ||
    typeof candidate.FieldPath.documentId !== 'function') {
    refuse('Firestore SDK argument does not expose the required classes');
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
    refuse('Protected credential configuration does not match the fixed deploy provider');
  }
}

function assertEnvironment(): void {
  for (const name of Object.keys(process.env)) {
    if (!ENV_ALLOW.has(name)) refuse('Protected runner environment contains a disallowed variable');
  }
  if (process.execArgv.length !== 0) refuse('Protected runner refuses node execution arguments');
  if (process.argv[1] !== RUNNER_PATH) refuse('Protected runner entry path is not the fixed runner');
}

function assertArgv(request: ProtectedRequestV2): void {
  const expected = argvFor(request);
  const actual = process.argv.slice(2);
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    refuse('Protected runner argv does not match the request');
  }
}

// Runtime collection scope is the reviewed canonical core's
// getCutoverRuntimeCollectionScope(namespace), used exactly. Its union covers the
// migration collections, the shared operations and usage collections, the pwmcp
// governance and seat-cleanup collections, and sibling writes. This build does not
// guess that set. When the reviewed export is absent, or its result is incomplete,
// unresolved, or not an exact match for the signed groups, the context refuses.
// Namespace import: the bundle must still link while the export is absent.
function assertRuntimeScopeFromCore(namespace: string, collectionGroups: readonly string[]): void {
  const core = canonicalCore as Record<string, unknown>;
  const scopeFn = core.getCutoverRuntimeCollectionScope;
  if (typeof scopeFn !== 'function') {
    refuse('Runtime collection scope requires the reviewed canonical core export getCutoverRuntimeCollectionScope');
  }
  const scope = (scopeFn as (ns: string) => unknown)(namespace) as Record<string, unknown> | null;
  if (scope === null || typeof scope !== 'object' || scope.complete !== true) {
    refuse('Runtime collection scope is incomplete');
  }
  // unscanned lists sources the reviewed census has not covered. Any entry, or a missing list, means the scope is
  // not a proof, so the factory refuses independently of complete.
  if (!Array.isArray(scope.unscanned) || scope.unscanned.length !== 0) {
    refuse('Runtime collection scope has unscanned sources');
  }
  // unresolved lists collections the census could not name. It is an explicit field of the reviewed scope; the
  // factory requires it to be present and empty, and the core's closure assertion checks the same rule.
  if (!Array.isArray(scope.unresolved) || scope.unresolved.length !== 0) {
    refuse('Runtime collection scope has unresolved collections');
  }
  // The core's closure rule is the same as the checks above. Requiring it here means an older bundle that lacks
  // the rule refuses, rather than silently skipping it.
  if (typeof core.assertRuntimeScopeClosed !== 'function') {
    refuse('Runtime collection scope requires the reviewed closure check assertRuntimeScopeClosed');
  }
  try {
    (core.assertRuntimeScopeClosed as (s: unknown) => void)(scope);
  } catch {
    refuse('Runtime collection scope is not closed');
  }
  // Compare the signed groups against the core's groups list, the only mapping the signed-policy check uses.
  const groups = scope.groups;
  if (!Array.isArray(groups) || groups.some((name) => typeof name !== 'string')) {
    refuse('Runtime collection scope groups are malformed');
  }
  const names = groups as string[];
  if (new Set(names).size !== names.length) refuse('Runtime collection scope groups have duplicates');
  if (canonicalJson([...names].sort()) !== canonicalJson([...collectionGroups].sort())) {
    refuse('Signed index collection groups differ from the reviewed runtime collection scope');
  }
}

// Exact dispatch claims for mutating production operations. These are checked
// on the decoded token; signature and STS acceptance are the host pre-pass.
const OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const OIDC_REQUEST_AUDIENCE = 'https://iam.googleapis.com/projects/859122914438/locations/global/workloadIdentityPools/github/providers/github';
const OIDC_WORKFLOW_REF = 'phoneware/monorepo/.github/workflows/deploy.yml@refs/heads/main';

export function assertMutatingClaims(bytes: Buffer): { runId: string; runAttempt: string } {
  const parts = bytes.toString('utf8').trim().split('.');
  if (parts.length !== 3) refuse('OIDC token is not a compact JWT');
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    refuse('OIDC token payload is not JSON');
  }
  if (claims === null || typeof claims !== 'object') refuse('OIDC token payload is not an object');
  const c = claims as Record<string, unknown>;
  if (c.iss !== OIDC_ISSUER ||
    c.aud !== OIDC_REQUEST_AUDIENCE ||
    c.repository_id !== '1278135054' ||
    c.repository_owner_id !== '13560178' ||
    c.repository !== 'phoneware/monorepo' ||
    c.ref !== 'refs/heads/main' ||
    c.event_name !== 'workflow_dispatch' ||
    c.workflow_ref !== OIDC_WORKFLOW_REF ||
    c.environment !== 'production' ||
    typeof c.exp !== 'number' || c.exp * 1000 <= Date.now() ||
    typeof c.run_id !== 'string' || !DECIMAL.test(c.run_id) ||
    typeof c.run_attempt !== 'string' || !DECIMAL.test(c.run_attempt)) {
    refuse('OIDC claims do not match the fixed production deploy dispatch');
  }
  return { runId: c.run_id, runAttempt: c.run_attempt };
}

function fetchForProfile(profile: Profile): typeof fetch {
  if (profile === 'production') return fetch;
  return (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const prefix = 'https://firestore.googleapis.com/';
    if (!url.startsWith(prefix)) refuse('Emulator Admin fetch refuses a non-emulator URL');
    return fetch(`http://127.0.0.1:8081/${url.slice(prefix.length)}`, init);
  };
}

// Constructs the protected database handle and returns the public context.
// Every failure refuses before any data read and before any mutating network use.
export async function createProtectedFirestoreMigrationContext(...args: unknown[]): Promise<ProtectedMigrationContext> {
  if (invoked) refuse('Protected migration context may be created once per process');
  invoked = true;
  if (args.length !== 1) refuse('Protected migration context requires exactly one SDK argument');
  const firestoreSdk: unknown = args[0];
  if (import.meta.url !== BUNDLE_URL) refuse('Protected migration context must run from the fixed bundle');
  assertEnvironment();
  assertSdk(firestoreSdk);

  const policy = parseStrictJson(readFixedFile(PATHS.trustPolicy), [
    'algorithm', 'keyVersion', 'publicKeyPem', 'publicKeySha256', 'runnerRepository',
  ], 'trust-policy');
  if (policy.algorithm !== 'RSA_SIGN_PSS_3072_SHA256' ||
    typeof policy.keyVersion !== 'string' || !policy.keyVersion ||
    typeof policy.publicKeyPem !== 'string' ||
    typeof policy.publicKeySha256 !== 'string' || !SHA256_HEX.test(policy.publicKeySha256) ||
    sha256Hex(Buffer.from(policy.publicKeyPem, 'utf8')) !== policy.publicKeySha256 ||
    typeof policy.runnerRepository !== 'string' || !RUNNER_REPOSITORY.test(policy.runnerRepository)) {
    refuse('Protected trust policy is malformed or does not match its pinned key');
  }

  const buildInfo = parseStrictJson(readFixedFile(PATHS.buildInfo), [
    'schemaVersion', PRODUCTION_PREDICATE_TYPE_KEY, 'sessionSecretVersion', 'publicPackageSourceSha',
    'privateRunnerSha', 'workflowSourceSha', 'assemblyDigest', 'profile',
  ], 'build-info');
  if (buildInfo.schemaVersion !== 2 ||
    buildInfo[PRODUCTION_PREDICATE_TYPE_KEY] !== MCP_CUTOVER_PREDICATE_TYPE ||
    typeof buildInfo.sessionSecretVersion !== 'string' || !DECIMAL.test(buildInfo.sessionSecretVersion) ||
    typeof buildInfo.publicPackageSourceSha !== 'string' || !SHA1_HEX.test(buildInfo.publicPackageSourceSha) ||
    typeof buildInfo.privateRunnerSha !== 'string' || !SHA1_HEX.test(buildInfo.privateRunnerSha) ||
    typeof buildInfo.workflowSourceSha !== 'string' || !SHA1_HEX.test(buildInfo.workflowSourceSha) ||
    typeof buildInfo.assemblyDigest !== 'string' || !SHA256_HEX.test(buildInfo.assemblyDigest) ||
    (buildInfo.profile !== 'production' && buildInfo.profile !== 'emulator')) {
    refuse('Protected build information is malformed');
  }
  const profile: Profile = buildInfo.profile;
  const row = PROFILES[profile];

  const request = parseProtectedRequestV2(readFixedFile(PATHS.request));
  if (request.profile !== profile) refuse('Request profile does not match the build profile');
  assertArgv(request);

  const bundleDigest = sha256Hex(readFixedFile(BUNDLE_PATH));
  if (bundleDigest !== request.identity.protocolDigest) refuse('Bundle digest does not match the approved protocol digest');

  const attestationBytes = readFixedFile(PATHS.attestation);
  if (sha256Hex(attestationBytes) !== request.approvalPayloadSha256) {
    refuse('Attestation manifest does not match the approved payload digest');
  }

  const indexBytes = readFixedFile(PATHS.indexSchema);
  const index = parseStrictJson(indexBytes, ['schemaVersion', 'kind', 'binding', 'policy', 'provenance'], 'index-schema');
  const indexText = new TextDecoder('utf-8', { fatal: true }).decode(indexBytes);
  if (canonicalJson(index) !== indexText) refuse('Index schema is not canonical JSON');
  const indexBinding = index.binding as Record<string, unknown> | undefined;
  const provenance = index.provenance as Record<string, unknown> | undefined;
  if (index.schemaVersion !== 2 || index.kind !== 'firestore-index-policy' ||
    indexBinding?.profile !== profile || indexBinding?.project !== row.project || indexBinding?.database !== row.database ||
    provenance?.databaseResource !== `projects/${row.project}/databases/${row.database}` ||
    provenance?.paginationComplete !== true) {
    refuse('Index policy binding does not match the protected database profile');
  }
  const groups = indexBinding.collectionGroups;
  const policyGroups = (index.policy as { collections?: Array<{ collectionGroup?: unknown }> } | undefined)?.collections
    ?.map((entry) => entry.collectionGroup) ?? [];
  if (!Array.isArray(groups) || groups.some((name) => typeof name !== 'string') ||
    canonicalJson([...groups].sort()) !== canonicalJson(groups) || new Set(groups).size !== groups.length ||
    canonicalJson([...policyGroups].sort()) !== canonicalJson([...groups].sort())) {
    refuse('Index policy collection groups are not the signed set');
  }
  assertRuntimeScopeFromCore(request.namespace, groups as string[]);

  const indexSchemaDigest = sha256Hex(Buffer.from(canonicalJson(index), 'utf8'));
  const indexPolicyDigest = sha256Hex(Buffer.from(canonicalJson(index.policy), 'utf8'));

  const approval = parseStrictJson(readFixedFile(PATHS.approval), ['payloadType', 'payload', 'signatures'], 'approval');
  const expectedKeyVersion = policy.keyVersion as string;
  const verified = verifyDSSEEnvelope(approval, policy.publicKeyPem as string, {
    expectedKeyVersion,
    expectedPredicateType: buildInfo[PRODUCTION_PREDICATE_TYPE_KEY] as string,
    runnerRepository: policy.runnerRepository as string,
    expectedPredicate: {
      codeSha: request.identity.codeSha,
      publicPackageSourceSha: buildInfo.publicPackageSourceSha as string,
      privateRunnerSha: buildInfo.privateRunnerSha as string,
      workflowSourceSha: buildInfo.workflowSourceSha as string,
      assemblyDigest: buildInfo.assemblyDigest as string,
      sessionSecretVersion: buildInfo.sessionSecretVersion as string,
      image: request.identity.codeArtifact,
      packageIntegrity: request.identity.packageIntegrity,
      indexSchemaDigest,
      indexPolicyDigest,
      project: row.project,
      database: row.database,
      namespace: request.namespace,
      protocolDigest: request.identity.protocolDigest,
    },
  });
  if (!Buffer.from(verified.payloadBytes).equals(attestationBytes)) {
    refuse('Verified approval payload is not the attestation manifest bytes');
  }
  const credentialsPresent = existsSync(PATHS.credentials);
  const oidcPresent = existsSync(PATHS.oidc);
  let oidcBefore: Buffer | null = null;
  if (profile === 'production') {
    assertCredentialFile(readFixedFile(PATHS.credentials));
    oidcBefore = readFixedFile(PATHS.oidc);
  } else if (credentialsPresent || oidcPresent) {
    refuse('Emulator profile refuses mounted production credentials');
  }

  // Mutating production operations (adopt commit, activate) must carry the fixed
  // dispatch claims. These are read from the same bytes the exchange below must
  // accept; a decoded claim is never authority on its own.
  const mutating = request.action === 'activate' || (request.action === 'adopt' && 'dryRun' in request.options && request.options.dryRun === false);
  let invocation: { runId: string; runAttempt: string } | null = null;
  if (oidcBefore !== null && mutating) {
    invocation = assertMutatingClaims(oidcBefore);
  }


  // Subject descriptor authority: the verified predicate only, bound module-private before any read.
  const subjectDescriptor = subjectDescriptorFromPredicate(request.namespace, verified.statement.predicate);

  // The session secret is used exactly as stored: no trimming and no fallback.
  const key = deriveStoreKey(readFixedFile(PATHS.sessionSecret).toString('utf8'));

  const sdk = firestoreSdk;
  const Firestore = sdk.Firestore;
  const settings = row.firestore as Record<string, unknown>;
  const db = new Firestore({ ...settings });
  if (!(db instanceof Firestore)) refuse('Constructed Firestore handle is not the SDK class');

  // Production: the fixed credential exchanges these exact bytes for an
  // authenticated token before any data-plane use. The bytes must be unchanged
  // across that exchange; their digest then binds every later operation.
  let adminAccess: { getAccessToken: () => Promise<string>; fetchFn: typeof fetch } | null = null;
  let credentialDigest: string | null = null;
  let adminTokenDigest: string | null = null;
  if (profile === 'production') {
    if (oidcBefore === null) refuse('Production credential bytes were not bound');
    const AdminClient = sdk.v1?.FirestoreAdminClient;
    if (typeof AdminClient !== 'function') refuse('Firestore Admin client is not available in the SDK');
    const client = new AdminClient({ projectId: row.project, keyFilename: PATHS.credentials, universeDomain: 'googleapis.com' });
    const token = await client.auth.getAccessToken();
    await client.close();
    if (typeof token !== 'string' || !token) refuse('Admin access token was not obtained');
    adminTokenDigest = sha256Hex(Buffer.from(token, 'utf8'));
    const oidcAfter = readFixedFile(PATHS.oidc);
    if (!oidcAfter.equals(oidcBefore)) refuse('Credential token bytes changed across the STS exchange');
    credentialDigest = sha256Hex(oidcAfter);
    if (request.action === 'adopt' || request.action === 'activate') {
      adminAccess = { getAccessToken: async () => token, fetchFn: fetchForProfile(profile) };
    }
  } else if (profile === 'emulator' && (request.action === 'adopt' || request.action === 'activate')) {
    // Emulator test profile only: the fixed test owner token, read through the
    // loopback fake Admin endpoint. Its digest binds fresh observations to this
    // token the same way production binds them to the exchanged STS token. No
    // production credential or production approval is used on this path.
    adminTokenDigest = sha256Hex(Buffer.from('owner', 'utf8'));
    adminAccess = { getAccessToken: async () => 'owner', fetchFn: fetchForProfile(profile) };
  }

  // Each protected operation is authorized by name and exact options. The
  // verify options carry planDigest in the request; the engine receives only the
  // manifest digest, and the runner checks planDigest against the result.
  const operations: Record<ProtectedRequestV2['action'], ProtectedOperation> = {
    inspect: 'inspect',
    adopt: 'adopt',
    activate: 'activate',
    status: 'status',
    'verify-active-ownership': 'verifyActive',
  };
  let authorizedOptions: Record<string, unknown>;
  if (request.action === 'verify-active-ownership') {
    if (!('migrationManifestDigest' in request.options)) throw new CutoverRefusedError('Verify request options are malformed');
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
    assemblyDigest: buildInfo.assemblyDigest as string,
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
    subjectDescriptor,
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
    protocolDigest: request.identity.protocolDigest,
  };
}
