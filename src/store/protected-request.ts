import { createHash } from 'node:crypto';
import { canonicalJson } from '../cutover/dsse-verifier-core.mjs';
import { CutoverRefusedError } from './errors.js';

// Request v2 per the action contract. The request is unsigned: every field is
// a guard checked here or later against an authenticated or live value. It is
// never itself an authority.

export const REQUEST_MAX_BYTES = 65_536;
export const REQUEST_KIND = 'netsapiens-protected-migration-request';
export const PROTECTED_ACTIONS = ['inspect', 'adopt', 'activate', 'status', 'verify-active-ownership'] as const;
export const PROTECTED_PROFILES = ['production', 'emulator'] as const;
export const PROTECTED_NAMESPACES = ['mcp', 'pwmcp', 'readonly_mcp'] as const;

export type ProtectedAction = (typeof PROTECTED_ACTIONS)[number];
export type ProtectedProfile = (typeof PROTECTED_PROFILES)[number];
export type ProtectedNamespace = (typeof PROTECTED_NAMESPACES)[number];

export interface ProtectedIdentity {
  readonly expectedEpoch: number;
  readonly migrationRunId: string;
  readonly codeSha: string;
  readonly codeArtifact: string;
  readonly packageIntegrity: string;
  readonly protocolDigest: string;
}

export type ProtectedOptions =
  | Record<string, never>
  | { readonly dryRun: boolean; readonly expectedSourceInventoryDigest: string }
  | { readonly migrationManifestDigest: string }
  | { readonly migrationManifestDigest: string; readonly planDigest: string };

export interface ProtectedRequestV2 {
  readonly schemaVersion: 2;
  readonly kind: typeof REQUEST_KIND;
  readonly action: ProtectedAction;
  readonly profile: ProtectedProfile;
  readonly namespace: ProtectedNamespace;
  readonly approvalPayloadSha256: string;
  readonly identity: ProtectedIdentity;
  readonly options: ProtectedOptions;
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const RUN_ID = /^nsm-[0-9a-f]{40}$/;
const CODE_ARTIFACT = /^[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-f]{64}$/;
const SRI_SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;
const RUN_ID_DOMAIN = 'netsapiens-mcp/cutover/migration-run/v1';

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function refuse(message: string): never {
  throw new CutoverRefusedError(message);
}

// Derived run identity: binds the approval, the namespace and the epoch.
export function migrationRunIdFor(approvalPayloadSha256: string, namespace: string, epoch: number): string {
  if (!HEX64.test(approvalPayloadSha256)) refuse('Run identity requires a lowercase approval digest');
  if (!Number.isSafeInteger(epoch) || epoch < 1) refuse('Run identity requires a positive safe epoch');
  const material = `${RUN_ID_DOMAIN}\n${approvalPayloadSha256}\n${namespace}\n${String(epoch)}`;
  return `nsm-${createHash('sha256').update(Buffer.from(material, 'utf8')).digest('hex').slice(0, 40)}`;
}

// Exact argv the runner must be started with for this request.
export function argvFor(request: ProtectedRequestV2): string[] {
  if (request.action === 'adopt') {
    const options = request.options as { readonly dryRun: boolean };
    return ['adopt', '--namespace', request.namespace, '--mode', options.dryRun ? 'dry-run' : 'commit'];
  }
  return [request.action, '--namespace', request.namespace];
}

function parseOptions(action: ProtectedAction, raw: unknown): ProtectedOptions {
  switch (action) {
    case 'inspect':
    case 'status':
      if (!exactKeys(raw, [])) refuse('Request options are not permitted for this action');
      return {};
    case 'adopt':
      if (!exactKeys(raw, ['dryRun', 'expectedSourceInventoryDigest']) ||
        typeof raw.dryRun !== 'boolean' ||
        typeof raw.expectedSourceInventoryDigest !== 'string' || !HEX64.test(raw.expectedSourceInventoryDigest)) {
        refuse('Adopt options are malformed');
      }
      return { dryRun: raw.dryRun, expectedSourceInventoryDigest: raw.expectedSourceInventoryDigest };
    case 'activate':
      if (!exactKeys(raw, ['migrationManifestDigest']) ||
        typeof raw.migrationManifestDigest !== 'string' || !HEX64.test(raw.migrationManifestDigest)) {
        refuse('Activate options are malformed');
      }
      return { migrationManifestDigest: raw.migrationManifestDigest };
    case 'verify-active-ownership':
      if (!exactKeys(raw, ['migrationManifestDigest', 'planDigest']) ||
        typeof raw.migrationManifestDigest !== 'string' || !HEX64.test(raw.migrationManifestDigest) ||
        typeof raw.planDigest !== 'string' || !HEX64.test(raw.planDigest)) {
        refuse('Verify options are malformed');
      }
      return { migrationManifestDigest: raw.migrationManifestDigest, planDigest: raw.planDigest };
  }
}

// Parses the exact bytes of request.json. Byte rules are checked first, then
// every key set, value format, and the derived run identity.
export function parseProtectedRequestV2(bytes: Uint8Array): ProtectedRequestV2 {
  if (bytes.byteLength > REQUEST_MAX_BYTES) refuse('Request exceeds the byte limit');
  let text: string;
  let parsed: unknown;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    refuse('Request is not valid UTF-8 JSON');
  }
  if (canonicalJson(parsed) !== text) refuse('Request is not canonical JSON');
  if (!exactKeys(parsed, ['schemaVersion', 'kind', 'action', 'profile', 'namespace', 'approvalPayloadSha256', 'identity', 'options'])) {
    refuse('Request key set is not exact');
  }
  const r = parsed;
  if (r.schemaVersion !== 2 || r.kind !== REQUEST_KIND) refuse('Request schema is not version 2');
  if (typeof r.action !== 'string' || !(PROTECTED_ACTIONS as readonly string[]).includes(r.action)) refuse('Request action is not permitted');
  if (typeof r.profile !== 'string' || !(PROTECTED_PROFILES as readonly string[]).includes(r.profile)) refuse('Request profile is not permitted');
  if (typeof r.namespace !== 'string' || !(PROTECTED_NAMESPACES as readonly string[]).includes(r.namespace)) refuse('Request namespace is not permitted');
  if (typeof r.approvalPayloadSha256 !== 'string' || !HEX64.test(r.approvalPayloadSha256)) refuse('Approval digest is malformed');

  const identity = r.identity;
  if (!exactKeys(identity, ['expectedEpoch', 'migrationRunId', 'codeSha', 'codeArtifact', 'packageIntegrity', 'protocolDigest'])) {
    refuse('Request identity key set is not exact');
  }
  const i = identity;
  if (typeof i.expectedEpoch !== 'number' || !Number.isSafeInteger(i.expectedEpoch) || i.expectedEpoch < 1) refuse('Expected epoch is malformed');
  if (typeof i.migrationRunId !== 'string' || !RUN_ID.test(i.migrationRunId)) refuse('Run identity is malformed');
  if (typeof i.codeSha !== 'string' || !HEX40.test(i.codeSha)) refuse('Code SHA is malformed');
  if (typeof i.codeArtifact !== 'string' || !CODE_ARTIFACT.test(i.codeArtifact)) refuse('Code artifact is malformed');
  if (typeof i.packageIntegrity !== 'string' || !SRI_SHA512.test(i.packageIntegrity)) refuse('Package integrity is malformed');
  if (typeof i.protocolDigest !== 'string' || !HEX64.test(i.protocolDigest)) refuse('Protocol digest is malformed');
  if (i.migrationRunId !== migrationRunIdFor(r.approvalPayloadSha256, r.namespace, i.expectedEpoch)) {
    refuse('Run identity does not match the approval, namespace and epoch');
  }

  const action = r.action as ProtectedAction;
  return Object.freeze({
    schemaVersion: 2,
    kind: REQUEST_KIND,
    action,
    profile: r.profile as ProtectedProfile,
    namespace: r.namespace as ProtectedNamespace,
    approvalPayloadSha256: r.approvalPayloadSha256,
    identity: Object.freeze({
      expectedEpoch: i.expectedEpoch,
      migrationRunId: i.migrationRunId,
      codeSha: i.codeSha,
      codeArtifact: i.codeArtifact,
      packageIntegrity: i.packageIntegrity,
      protocolDigest: i.protocolDigest,
    }),
    options: Object.freeze(parseOptions(action, r.options)),
  });
}
