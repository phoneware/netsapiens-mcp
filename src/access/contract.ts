/**
 * Registry wire contract v1 (docs/access-registry.md, "Decision response").
 *
 * This module parses and validates. It makes no network calls, reads no environment
 * and is not wired into the server: a decision that fails here is a registry error,
 * never an authoritative "not enrolled".
 *
 * Schemas use only the zod calls that zod 3.25 and zod 4 both provide, because
 * package.json accepts either major.
 */
import { z } from 'zod';
import type { ContentKind } from '../governance/types.js';
import { isValidPlatformEntry } from './redirect.js';

/** Every content kind a policy classifies, in the order decisions report them. */
export const CONTENT_KINDS = [
  'call_recording',
  'transcript',
  'voicemail',
  'sms_text',
  'ai_summary',
  'fax_page',
] as const satisfies readonly ContentKind[];

// Fails to compile when CONTENT_KINDS stops covering every ContentKind.
type MissingContentKind = Exclude<ContentKind, (typeof CONTENT_KINDS)[number]>;
const contentKindsComplete: [MissingContentKind] extends [never] ? true : never = true;
void contentKindsComplete;

export type ContentAction = 'deny' | 'strip' | 'allow';
export type AccessMode = 'read' | 'write';
export type UnclassifiedOutput = 'deny' | 'allow';

export const MAX_LIST_ENTRIES = 512;
export const MAX_PATTERN_LENGTH = 200;
export const MAX_PLATFORM_LENGTH = 2048;
/** A deny reason keeps this many characters. Anything beyond is dropped, not an error. */
const MAX_REASON_CHARACTERS = 64;
export const REVISION_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export interface AccessPolicyV1 {
  /** Glob or @group entries, matched with the MCP_DISABLED_TOOLS grammar. */
  readonly tools: { readonly allow: readonly string[]; readonly deny: readonly string[] };
  readonly access: AccessMode;
  /** All six kinds are required. */
  readonly content: Readonly<Record<ContentKind, ContentAction>>;
  readonly unclassifiedOutput: UnclassifiedOutput;
  /** An https URI without userinfo, fragment or query, or "loopback", or "*". */
  readonly platforms: readonly string[];
}

export type AccessDecisionV1 =
  | {
      readonly version: 1;
      readonly decision: 'allow';
      readonly revision: string;
      readonly ttlSeconds: number;
      readonly critical?: readonly string[];
      readonly policy: AccessPolicyV1;
    }
  | {
      readonly version: 1;
      readonly decision: 'deny';
      readonly reason: string;
      readonly revision: string;
      readonly ttlSeconds: number;
      readonly critical?: readonly string[];
    };

/** Why a registry body was rejected. These are the errorClass values the client logs. */
export type RegistryDecisionErrorClass = 'invalid_json' | 'contract' | 'critical';

export type ParseRegistryDecisionResult =
  | { readonly ok: true; readonly decision: AccessDecisionV1 }
  | { readonly ok: false; readonly errorClass: RegistryDecisionErrorClass; readonly message: string };

const revisionSchema = z
  .string()
  .regex(REVISION_PATTERN, 'revision must be 1 to 128 characters from [A-Za-z0-9._:-]');

const ttlSchema = z
  .number()
  .int('ttlSeconds must be an integer of at least 1')
  .min(1, 'ttlSeconds must be an integer of at least 1')
  .refine(Number.isSafeInteger, 'ttlSeconds must be a safe integer');

const patternSchema = z
  .string()
  .max(MAX_PATTERN_LENGTH, `tool patterns are at most ${MAX_PATTERN_LENGTH} characters`)
  .refine((value) => value.trim() !== '', 'tool patterns must not be empty');

const patternListSchema = z
  .array(patternSchema)
  .max(MAX_LIST_ENTRIES, `tool pattern lists hold at most ${MAX_LIST_ENTRIES} entries`);

const platformSchema = z
  .string()
  .max(MAX_PLATFORM_LENGTH, `platform entries are at most ${MAX_PLATFORM_LENGTH} characters`)
  .refine(isValidPlatformEntry, 'platform must be an https URI without userinfo, fragment or query, or "loopback", or "*"');

const actionSchema = z.enum(['deny', 'strip', 'allow']);

const contentSchema = z.object({
  call_recording: actionSchema,
  transcript: actionSchema,
  voicemail: actionSchema,
  sms_text: actionSchema,
  ai_summary: actionSchema,
  fax_page: actionSchema,
});

const policySchema = z.object({
  tools: z.object({ allow: patternListSchema, deny: patternListSchema }),
  access: z.enum(['read', 'write']),
  content: contentSchema,
  unclassifiedOutput: z.enum(['deny', 'allow']),
  platforms: z.array(platformSchema).max(MAX_LIST_ENTRIES, `platform lists hold at most ${MAX_LIST_ENTRIES} entries`),
});

const allowSchema = z.object({
  version: z.literal(1),
  decision: z.literal('allow'),
  revision: revisionSchema,
  ttlSeconds: ttlSchema,
  policy: policySchema,
});

const denySchema = z.object({
  version: z.literal(1),
  decision: z.literal('deny'),
  // Any string is still a deny: an empty or unknown reason fails closed. The decision keeps a sanitized copy.
  reason: z.string(),
  revision: revisionSchema,
  ttlSeconds: ttlSchema,
});

const decisionSchema = z.discriminatedUnion('decision', [allowSchema, denySchema]);

// Reads only the member that decides whether the body is rejected outright. z.object strips
// everything else, so unknown members never reach decisionSchema.
const criticalEnvelopeSchema = z.object({ critical: z.array(z.string()).optional() });

/**
 * The reason a deny keeps: its first 64 characters (code points), each printable ASCII or "?". An empty reason is
 * reported as "unspecified". Reasons are free text from the registry, so nothing outside printable ASCII is kept.
 */
function sanitizeDenyReason(reason: string): string {
  if (reason === '') return 'unspecified';
  let kept = '';
  let count = 0;
  for (const character of reason) {
    if (count === MAX_REASON_CHARACTERS) break;
    const code = character.codePointAt(0) ?? 0;
    kept += code >= 0x20 && code <= 0x7e ? character : '?';
    count++;
  }
  return kept;
}

/** Checks a value already known to be a JSON object: the `critical` member first, then the decision schema. */
function decodeDecision(value: unknown): ParseRegistryDecisionResult {
  const envelope = criticalEnvelopeSchema.safeParse(value);
  if (!envelope.success) {
    return failure('contract', describeIssues(envelope.error.issues));
  }
  const critical = envelope.data.critical ?? [];
  if (critical.length > 0) {
    return failure('critical', `registry marked ${critical.length} member(s) critical; this client understands none`);
  }

  const parsed = decisionSchema.safeParse(value);
  if (!parsed.success) return failure('contract', describeIssues(parsed.error.issues));
  if (parsed.data.decision === 'deny') {
    return { ok: true, decision: { ...parsed.data, reason: sanitizeDenyReason(parsed.data.reason) } };
  }
  return { ok: true, decision: parsed.data };
}

/**
 * Parses registry decision JSON text. The text is parsed exactly once. A result that is not an object is a contract
 * error, which is what a body encoded twice produces. Use this when the response body is read as text.
 */
export function parseRegistryDecisionText(text: string): ParseRegistryDecisionResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return failure('invalid_json', 'decision body is not valid JSON');
  }
  if (typeof value === 'string') {
    return failure('contract', 'decision text parsed to a JSON string, not an object; the body may be encoded twice');
  }
  return decodeDecision(value);
}

/**
 * Parses a registry decision that is already a parsed value, such as the result of `res.json()`. It takes an object
 * only. A string is refused, because it may be JSON text that a registry encoded twice.
 */
export function parseRegistryDecisionValue(value: unknown): ParseRegistryDecisionResult {
  if (typeof value === 'string') {
    return failure('contract', 'decision value is a string; pass JSON text to parseRegistryDecisionText');
  }
  return decodeDecision(value);
}

/**
 * Compatibility entry point. A string is read as JSON text, as parseRegistryDecisionText reads it, and any other
 * value is taken as a parsed value, as parseRegistryDecisionValue takes it. Embedders that return `res.json()` must
 * call parseRegistryDecisionValue, and clients that read the body as text must call parseRegistryDecisionText.
 */
export function parseRegistryDecision(input: unknown): ParseRegistryDecisionResult {
  return typeof input === 'string' ? parseRegistryDecisionText(input) : parseRegistryDecisionValue(input);
}

function failure(errorClass: RegistryDecisionErrorClass, message: string): ParseRegistryDecisionResult {
  return { ok: false, errorClass, message };
}

/** Identifier-shaped text only: a schema member name, a zod issue code, or an array position. */
const LABEL = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function label(part: PropertyKey): string {
  if (typeof part === 'number') return String(part);
  if (typeof part === 'string' && LABEL.test(part)) return part;
  return '?';
}

/**
 * Describes each issue by its path and code only. zod messages are never used: zod 3 quotes the received value in
 * some of them, and a registry value must not reach an error string or a log.
 */
function describeIssues(issues: ReadonlyArray<{ readonly path: ReadonlyArray<PropertyKey>; readonly code: string }>): string {
  return issues
    .slice(0, 3)
    .map((issue) => `${issue.path.map(label).join('.') || '(root)'}: ${label(issue.code)}`)
    .join('; ');
}
