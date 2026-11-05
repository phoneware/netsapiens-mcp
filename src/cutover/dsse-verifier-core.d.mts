// Type declarations for the byte-identical shared verifier in dsse-verifier-core.mjs.
// This file is compile-time only and is not part of the cleared source handoff.

export const DSSE_PAYLOAD_TYPE: 'application/vnd.in-toto+json';
export const MCP_CUTOVER_PREDICATE_TYPE: 'https://phoneware.us/mcp-cutover/v2';

export function canonicalJson(value: unknown): string;

// Namespace-bound rule for the approval's subject descriptor. Returns nothing; throws
// with a fixed message that never echoes the value.
export function validateSubjectDescriptor(namespace: string, value: unknown): void;
export function validateCutoverStatement(statement: unknown): void;

export function formatPAE(payloadType: string, payloadBytes: Uint8Array): Buffer;

export interface DSSEVerifyOptions {
  readonly expectedKeyVersion: string;
  readonly expectedPredicateType: string;
  readonly runnerRepository: string;
  readonly expectedPredicate: Readonly<Record<
    | 'codeSha'
    | 'publicPackageSourceSha'
    | 'privateRunnerSha'
    | 'workflowSourceSha'
    | 'assemblyDigest'
    | 'sessionSecretVersion'
    | 'image'
    | 'packageIntegrity'
    | 'indexSchemaDigest'
    | 'indexPolicyDigest'
    | 'project'
    | 'database'
    | 'namespace'
    | 'protocolDigest'
    | 'writerCensusDigest'
    | 'writerInventoryDigest'
    | 'collectionInventoryDigest',
    string>>;
}

export interface DSSEVerifyResult {
  readonly valid: true;
  readonly keyid: string;
  readonly payload: unknown;
  readonly statement: Record<string, unknown>;
  readonly payloadBytes: Buffer;
  readonly signatureBytes: Buffer;
}

export function verifyDSSEEnvelope(
  envelope: unknown,
  publicKeyPem: string,
  options: DSSEVerifyOptions,
): DSSEVerifyResult;
