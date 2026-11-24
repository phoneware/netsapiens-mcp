/**
 * Compiles a registry policy against the tool catalog and decides every tool, operation and redirect
 * (docs/access-registry.md, "Effective policy"). Pure: no network, no environment.
 *
 * Matching builds no regular expression. A pattern is split at its stars and each piece is checked with a prefix,
 * suffix or indexOf test, so a decision costs time linear in the name. A name longer than the limit is refused
 * before any pattern is tried.
 */
import { logger } from '../utils/logger.js';
import type { ContentKind } from '../governance/types.js';
import { CONTENT_KINDS, type AccessMode, type AccessPolicyV1, type ContentAction, type UnclassifiedOutput } from './contract.js';
import { buildRedirectMatcher, parsePlatformEntry, type PlatformEntry } from './redirect.js';
import type { OperationRef, ToolCatalogView } from './types.js';

/** Longest tool name a decision matches. A longer name is refused as not_allowed under every policy. */
const MAX_TOOL_NAME_LENGTH = 256;

/** Group names the package defines. Any other "@" entry in tools.deny makes the policy invalid. */
const KNOWN_GROUPS: Record<string, true> = {
  '@curated': true,
  '@meta': true,
  '@generated': true,
  '@read': true,
  '@write': true,
  '@destructive': true,
  '@unclassified': true,
  ...Object.fromEntries(CONTENT_KINDS.map((kind) => [`@content:${kind}`, true] as const)),
};

export type DenyReason =
  | 'denied'
  | 'not_allowed'
  | 'read_only'
  | 'destructive'
  | 'unclassified'
  | `content:${ContentKind}`;

export type PolicyDecision = { readonly allowed: true } | { readonly allowed: false; readonly reason: DenyReason };

export interface CompiledPolicy {
  readonly revision: string;
  readonly access: AccessMode;
  readonly content: Readonly<Record<ContentKind, ContentAction>>;
  readonly unclassifiedOutput: UnclassifiedOutput;
  /** Kinds whose tools and operations are refused. */
  readonly deniedKinds: readonly ContentKind[];
  /** Kinds whose fields are removed from results. */
  readonly strippedKinds: readonly ContentKind[];
  toolDecision(name: string): PolicyDecision;
  operationDecision(op: OperationRef): PolicyDecision;
  allowsRedirect(uri: string): boolean;
}

export type AccessPolicyErrorCode = 'unknown_group' | 'invalid_entry' | 'invalid_platform' | 'invalid_content' | 'invalid_mode';

/** The policy cannot be enforced as written. A caller must treat it as unavailable, which is closed. */
export class AccessPolicyError extends Error {
  readonly code: AccessPolicyErrorCode;

  constructor(code: AccessPolicyErrorCode, message: string) {
    super(message);
    this.name = 'AccessPolicyError';
    this.code = code;
  }
}

const ALLOWED: PolicyDecision = Object.freeze({ allowed: true as const });

function refuse(reason: DenyReason): PolicyDecision {
  return Object.freeze({ allowed: false as const, reason });
}

const READ_ACTION = /^(read|count|list|search|get)/;

/** A pattern split at its stars: "a*b" is ["a", "b"], and "*" is ["", ""]. */
type Glob = readonly string[];

interface PatternList {
  readonly groups: ReadonlySet<string>;
  readonly globs: readonly Glob[];
}

/**
 * Whether a name matches a pattern split at its stars. The first piece must be a prefix and the last a suffix, and
 * each middle piece must occur in order between them. Each middle piece takes its first occurrence. For patterns
 * made only of stars and literal text, that choice never rules out a match, so nothing is retried.
 */
function globMatches(segments: Glob, name: string): boolean {
  if (segments.length === 1) return name === segments[0];
  const head = segments[0];
  const tail = segments[segments.length - 1];
  if (name.length < head.length + tail.length) return false;
  if (!name.startsWith(head) || !name.endsWith(tail)) return false;
  const limit = name.length - tail.length;
  let position = head.length;
  for (let i = 1; i < segments.length - 1; i++) {
    const middle = segments[i];
    if (middle === '') continue;
    const found = name.indexOf(middle, position);
    if (found === -1 || found + middle.length > limit) return false;
    position = found + middle.length;
  }
  return true;
}

function compilePatternList(entries: readonly string[], side: 'allow' | 'deny'): PatternList {
  const groups = new Set<string>();
  const globs: Glob[] = [];
  for (const raw of entries) {
    const pattern = raw.trim();
    if (pattern === '') {
      throw new AccessPolicyError('invalid_entry', `tools.${side} contains an empty entry`);
    }
    if (pattern.startsWith('@')) {
      if (KNOWN_GROUPS[pattern] === true) {
        groups.add(pattern);
      } else if (side === 'deny') {
        throw new AccessPolicyError('unknown_group', `tools.deny names unknown group ${pattern}`);
      } else {
        logger.warn('Access policy allow entry names an unknown group and matches nothing', { group: pattern });
      }
      continue;
    }
    globs.push(pattern.split('*'));
  }
  return { groups, globs };
}

function listMatches(list: PatternList, names: readonly string[], memberOf: ReadonlySet<string>): boolean {
  for (const group of list.groups) {
    if (memberOf.has(group)) return true;
  }
  return list.globs.some((segments) => names.some((name) => globMatches(segments, name)));
}

function checkedAction(action: unknown, kind: ContentKind): ContentAction {
  if (action !== 'deny' && action !== 'strip' && action !== 'allow') {
    throw new AccessPolicyError('invalid_content', `content.${kind} must be deny, strip or allow`);
  }
  return action;
}

function compileContent(content: AccessPolicyV1['content']): Record<ContentKind, ContentAction> {
  return {
    call_recording: checkedAction(content.call_recording, 'call_recording'),
    transcript: checkedAction(content.transcript, 'transcript'),
    voicemail: checkedAction(content.voicemail, 'voicemail'),
    sms_text: checkedAction(content.sms_text, 'sms_text'),
    ai_summary: checkedAction(content.ai_summary, 'ai_summary'),
    fax_page: checkedAction(content.fax_page, 'fax_page'),
  };
}

/**
 * Compiles a policy for one registry decision. `catalog` answers which tool and operation a name or key is.
 * Throws AccessPolicyError when the policy cannot be enforced as written.
 */
export function compilePolicy(policy: AccessPolicyV1, catalog: ToolCatalogView, revision: string): CompiledPolicy {
  const { access, unclassifiedOutput } = policy;
  if (access !== 'read' && access !== 'write') {
    throw new AccessPolicyError('invalid_mode', 'access must be read or write');
  }
  if (unclassifiedOutput !== 'deny' && unclassifiedOutput !== 'allow') {
    throw new AccessPolicyError('invalid_mode', 'unclassifiedOutput must be deny or allow');
  }
  const allow = compilePatternList(policy.tools.allow, 'allow');
  const deny = compilePatternList(policy.tools.deny, 'deny');
  const content = compileContent(policy.content);
  const platforms: PlatformEntry[] = policy.platforms.map((entry) => {
    const parsed = parsePlatformEntry(entry);
    if (parsed === undefined) {
      throw new AccessPolicyError('invalid_platform', 'platforms holds an entry that is not an https URI, "loopback" or "*"');
    }
    return parsed;
  });
  const redirects = buildRedirectMatcher(platforms);
  const deniedKinds = CONTENT_KINDS.filter((kind) => content[kind] === 'deny');
  const strippedKinds = CONTENT_KINDS.filter((kind) => content[kind] === 'strip');

  // Order is fixed: length, deny, allow, read, content, unclassified. The first refusal is the reason reported.
  function toolDecision(name: string): PolicyDecision {
    if (name.length > MAX_TOOL_NAME_LENGTH) return refuse('not_allowed');
    const entry = catalog.lookupTool(name);
    const names = entry === undefined ? [name] : [entry.canonical, entry.exposed];
    const memberOf = new Set<string>(entry === undefined ? [] : entry.groups);
    if (listMatches(deny, names, memberOf)) return refuse('denied');
    if (!listMatches(allow, names, memberOf)) return refuse('not_allowed');
    if (access === 'read' && memberOf.has('@write')) return refuse('read_only');
    for (const kind of CONTENT_KINDS) {
      if (content[kind] === 'deny' && memberOf.has(`@content:${kind}`)) return refuse(`content:${kind}`);
    }
    if (unclassifiedOutput === 'deny' && memberOf.has('@unclassified')) return refuse('unclassified');
    return ALLOWED;
  }

  function operationDecision(op: OperationRef): PolicyDecision {
    const classification = catalog.lookupOperation(op.key);
    if (classification !== undefined) {
      const kinds: readonly ContentKind[] = classification === 'unreviewed' ? CONTENT_KINDS : classification;
      for (const kind of CONTENT_KINDS) {
        if (content[kind] === 'deny' && kinds.includes(kind)) return refuse(`content:${kind}`);
      }
    }
    if (access === 'read') {
      if (op.kind === 'v2' && op.method.toUpperCase() !== 'GET') return refuse('read_only');
      if (op.kind === 'v1' && !READ_ACTION.test(op.action)) return refuse('read_only');
    }
    const destructiveBlocked = deny.groups.has('@destructive') || access === 'read';
    if (op.kind === 'v2' && op.method.toUpperCase() === 'DELETE' && destructiveBlocked) return refuse('destructive');
    return ALLOWED;
  }

  return Object.freeze({
    revision,
    access,
    content: Object.freeze(content),
    unclassifiedOutput,
    deniedKinds: Object.freeze(deniedKinds),
    strippedKinds: Object.freeze(strippedKinds),
    toolDecision,
    operationDecision,
    allowsRedirect: redirects.allows,
  });
}

const ALLOW_ALL_POLICY: AccessPolicyV1 = {
  tools: { allow: ['*'], deny: [] },
  access: 'write',
  content: {
    call_recording: 'allow',
    transcript: 'allow',
    voicemail: 'allow',
    sms_text: 'allow',
    ai_summary: 'allow',
    fax_page: 'allow',
  },
  unclassifiedOutput: 'allow',
  platforms: ['*'],
};

const NO_CATALOG: ToolCatalogView = {
  lookupTool: () => undefined,
  lookupOperation: () => undefined,
};

/** What an unconfigured deployment behaves as: every tool, operation, field and redirect is allowed. */
export const ALLOW_ALL: CompiledPolicy = compilePolicy(ALLOW_ALL_POLICY, NO_CATALOG, 'unset');
