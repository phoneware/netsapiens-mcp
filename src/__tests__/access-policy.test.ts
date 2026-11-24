import { describe, expect, it, vi } from 'vitest';
import type { ContentKind } from '../governance/types.js';
import type { AccessPolicyV1, ContentAction } from '../access/contract.js';
import { ALLOW_ALL, AccessPolicyError, compilePolicy, type CompiledPolicy } from '../access/policy.js';
import type { OperationClass, ToolCatalogEntry, ToolCatalogView } from '../access/types.js';
import { logger } from '../utils/logger.js';

const ALL_CONTENT_ALLOW: Record<ContentKind, ContentAction> = {
  call_recording: 'allow',
  transcript: 'allow',
  voicemail: 'allow',
  sms_text: 'allow',
  ai_summary: 'allow',
  fax_page: 'allow',
};

interface PolicyOptions {
  allow?: string[];
  deny?: string[];
  access?: 'read' | 'write';
  content?: Partial<Record<ContentKind, ContentAction>>;
  unclassified?: 'deny' | 'allow';
  platforms?: string[];
}

function policy(options: PolicyOptions = {}): AccessPolicyV1 {
  return {
    tools: { allow: options.allow ?? [], deny: options.deny ?? [] },
    access: options.access ?? 'write',
    content: { ...ALL_CONTENT_ALLOW, ...options.content },
    unclassifiedOutput: options.unclassified ?? 'allow',
    platforms: options.platforms ?? [],
  };
}

interface ToolFixture {
  canonical: string;
  exposed?: string;
  groups?: string[];
}

function catalog(tools: ToolFixture[], operations: Array<[string, OperationClass]> = []): ToolCatalogView {
  const byName = new Map<string, ToolCatalogEntry>();
  for (const tool of tools) {
    const entry: ToolCatalogEntry = {
      canonical: tool.canonical,
      exposed: tool.exposed ?? tool.canonical,
      groups: tool.groups ?? [],
    };
    byName.set(entry.canonical, entry);
    byName.set(entry.exposed, entry);
  }
  const classes = new Map(operations);
  return {
    lookupTool: (name) => byName.get(name),
    lookupOperation: (key) => classes.get(key),
  };
}

const READ_TOOL: ToolFixture = { canonical: 'get_domains', groups: ['@curated', '@read'] };
const WRITE_TOOL: ToolFixture = { canonical: 'delete_domain', groups: ['@generated', '@write', '@destructive'] };
const TRANSCRIPT_TOOL: ToolFixture = {
  canonical: 'call_transcript',
  groups: ['@curated', '@read', '@content:transcript'],
};
const UNCLASSIFIED_TOOL: ToolFixture = {
  canonical: 'mystery_report',
  groups: ['@generated', '@read', '@unclassified'],
};
const ALIASED_TOOL: ToolFixture = {
  canonical: 'v2_domains_by_domain_users_list',
  exposed: 'domain_users',
  groups: ['@generated', '@read'],
};
const TOOLS = [READ_TOOL, WRITE_TOOL, TRANSCRIPT_TOOL, UNCLASSIFIED_TOOL, ALIASED_TOOL];

const OPERATIONS: Array<[string, OperationClass]> = [
  ['GET /transcripts/{}', ['transcript']],
  ['POST /mystery/{}', 'unreviewed'],
];

describe('tool decisions', () => {
  it('lets a deny beat an allow', () => {
    const compiled = compilePolicy(policy({ allow: ['*'], deny: ['delete_*'] }), catalog(TOOLS), 'r1');
    expect(compiled.toolDecision('delete_domain')).toEqual({ allowed: false, reason: 'denied' });
    expect(compiled.toolDecision('get_domains')).toEqual({ allowed: true });
  });

  it('lets a deny group beat an allow group', () => {
    const compiled = compilePolicy(
      policy({ allow: ['@curated', '@generated'], deny: ['@destructive'] }),
      catalog(TOOLS),
      'r1',
    );
    expect(compiled.toolDecision('delete_domain')).toEqual({ allowed: false, reason: 'denied' });
    expect(compiled.toolDecision('get_domains')).toEqual({ allowed: true });
  });

  it('refuses a tool that no allow entry matches', () => {
    const compiled = compilePolicy(policy({ allow: ['@curated'] }), catalog(TOOLS), 'r1');
    expect(compiled.toolDecision('delete_domain')).toEqual({ allowed: false, reason: 'not_allowed' });
    expect(compiled.toolDecision('get_domains')).toEqual({ allowed: true });
  });

  it('nothing is allowed when the allow list is empty', () => {
    const compiled = compilePolicy(policy({}), catalog(TOOLS), 'r1');
    expect(compiled.toolDecision('get_domains')).toEqual({ allowed: false, reason: 'not_allowed' });
  });

  it('a read policy denies write tools', () => {
    const compiled = compilePolicy(policy({ allow: ['*'], access: 'read' }), catalog(TOOLS), 'r1');
    expect(compiled.toolDecision('delete_domain')).toEqual({ allowed: false, reason: 'read_only' });
    expect(compiled.toolDecision('get_domains')).toEqual({ allowed: true });
  });

  it('reports the deny before the read-only reason', () => {
    const compiled = compilePolicy(policy({ allow: ['*'], deny: ['delete_*'], access: 'read' }), catalog(TOOLS), 'r1');
    expect(compiled.toolDecision('delete_domain')).toEqual({ allowed: false, reason: 'denied' });
  });

  it('a content deny refuses the tools of that kind; strip does not', () => {
    const denied = compilePolicy(policy({ allow: ['*'], content: { transcript: 'deny' } }), catalog(TOOLS), 'r1');
    expect(denied.toolDecision('call_transcript')).toEqual({ allowed: false, reason: 'content:transcript' });
    expect(denied.toolDecision('get_domains')).toEqual({ allowed: true });

    const stripped = compilePolicy(policy({ allow: ['*'], content: { transcript: 'strip' } }), catalog(TOOLS), 'r1');
    expect(stripped.toolDecision('call_transcript')).toEqual({ allowed: true });
  });

  it('an unclassified deny refuses unclassified tools; allow does not', () => {
    const denied = compilePolicy(policy({ allow: ['*'], unclassified: 'deny' }), catalog(TOOLS), 'r1');
    expect(denied.toolDecision('mystery_report')).toEqual({ allowed: false, reason: 'unclassified' });

    const allowed = compilePolicy(policy({ allow: ['*'], unclassified: 'allow' }), catalog(TOOLS), 'r1');
    expect(allowed.toolDecision('mystery_report')).toEqual({ allowed: true });
  });

  it('matches both the canonical name and the exposed name', () => {
    const byExposed = compilePolicy(policy({ allow: ['domain_users'] }), catalog(TOOLS), 'r1');
    expect(byExposed.toolDecision('v2_domains_by_domain_users_list')).toEqual({ allowed: true });

    const byCanonical = compilePolicy(policy({ allow: ['v2_domains_*'] }), catalog(TOOLS), 'r1');
    expect(byCanonical.toolDecision('domain_users')).toEqual({ allowed: true });

    const denyCanonical = compilePolicy(policy({ allow: ['*'], deny: ['v2_*'] }), catalog(TOOLS), 'r1');
    expect(denyCanonical.toolDecision('domain_users')).toEqual({ allowed: false, reason: 'denied' });

    const denyExposed = compilePolicy(policy({ allow: ['*'], deny: ['domain_*'] }), catalog(TOOLS), 'r1');
    expect(denyExposed.toolDecision('v2_domains_by_domain_users_list')).toEqual({ allowed: false, reason: 'denied' });
  });

  it('decides an unknown name by its patterns alone', () => {
    expect(compilePolicy(policy({ allow: ['*'] }), catalog(TOOLS), 'r1').toolDecision('no_such_tool')).toEqual({
      allowed: true,
    });
    expect(compilePolicy(policy({ allow: ['@curated'] }), catalog(TOOLS), 'r1').toolDecision('no_such_tool')).toEqual({
      allowed: false,
      reason: 'not_allowed',
    });
  });

  it('a star matches every name, including names that contain a newline', () => {
    expect(compilePolicy(policy({ allow: ['*'] }), catalog([]), 'r1').toolDecision('line\nbreak')).toEqual({
      allowed: true,
    });
    expect(
      compilePolicy(policy({ allow: ['*'], deny: ['*'] }), catalog([]), 'r1').toolDecision('line\nbreak'),
    ).toEqual({ allowed: false, reason: 'denied' });
  });

  it('anchors patterns and escapes regular-expression characters', () => {
    const compiled = compilePolicy(policy({ allow: ['get.domains', 'get_*'] }), catalog([]), 'r1');
    expect(compiled.toolDecision('get.domains')).toEqual({ allowed: true });
    expect(compiled.toolDecision('getXdomains')).toEqual({ allowed: false, reason: 'not_allowed' });
    expect(compiled.toolDecision('xget_domains')).toEqual({ allowed: false, reason: 'not_allowed' });
  });

  it('refuses a deny that names an unknown group', () => {
    expect(() => compilePolicy(policy({ deny: ['@nope'] }), catalog(TOOLS), 'r1')).toThrow(AccessPolicyError);
    expect(() => compilePolicy(policy({ deny: ['@content:bogus'] }), catalog(TOOLS), 'r1')).toThrow(
      expect.objectContaining({ code: 'unknown_group' }),
    );
  });

  it('an allow that names an unknown group matches nothing, and logs it', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const compiled = compilePolicy(policy({ allow: ['@nope'] }), catalog(TOOLS), 'r1');
      expect(compiled.toolDecision('get_domains')).toEqual({ allowed: false, reason: 'not_allowed' });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown group'), { group: '@nope' });
    } finally {
      warn.mockRestore();
    }
  });

  it('refuses a blank pattern', () => {
    expect(() => compilePolicy(policy({ allow: [' '] }), catalog(TOOLS), 'r1')).toThrow(
      expect.objectContaining({ code: 'invalid_entry' }),
    );
  });

  it('refuses a policy whose access mode or content is malformed', () => {
    const badAccess = { ...policy({ allow: ['*'] }), access: 'admin' } as unknown as AccessPolicyV1;
    expect(() => compilePolicy(badAccess, catalog(TOOLS), 'r1')).toThrow(expect.objectContaining({ code: 'invalid_mode' }));

    const { transcript: _omitted, ...partial } = ALL_CONTENT_ALLOW;
    const badContent = { ...policy({ allow: ['*'] }), content: partial } as unknown as AccessPolicyV1;
    expect(() => compilePolicy(badContent, catalog(TOOLS), 'r1')).toThrow(
      expect.objectContaining({ code: 'invalid_content' }),
    );
  });

  it('carries the revision it was compiled from', () => {
    expect(compilePolicy(policy({ allow: ['*'] }), catalog(TOOLS), '9f2c1e7a40b3d6e1').revision).toBe('9f2c1e7a40b3d6e1');
  });

  it('lists the denied and stripped kinds in classification order', () => {
    const compiled = compilePolicy(
      policy({ content: { fax_page: 'deny', call_recording: 'deny', sms_text: 'strip', ai_summary: 'strip' } }),
      catalog(TOOLS),
      'r1',
    );
    expect(compiled.deniedKinds).toEqual(['call_recording', 'fax_page']);
    expect(compiled.strippedKinds).toEqual(['sms_text', 'ai_summary']);
  });
});

describe('operation decisions', () => {
  const withOps = catalog(TOOLS, OPERATIONS);

  it('refuses a content operation whose kind is denied, and not one that is only stripped', () => {
    const denied = compilePolicy(policy({ content: { transcript: 'deny' } }), withOps, 'r1');
    expect(denied.operationDecision({ kind: 'v2', method: 'GET', key: 'GET /transcripts/{}' })).toEqual({
      allowed: false,
      reason: 'content:transcript',
    });

    const stripped = compilePolicy(policy({ content: { transcript: 'strip' } }), withOps, 'r1');
    expect(stripped.operationDecision({ kind: 'v2', method: 'GET', key: 'GET /transcripts/{}' })).toEqual({
      allowed: true,
    });
  });

  it('refuses an unreviewed operation when any kind is denied, and reports the first denied kind', () => {
    const denied = compilePolicy(policy({ content: { call_recording: 'deny' } }), withOps, 'r1');
    expect(denied.operationDecision({ kind: 'v2', method: 'POST', key: 'POST /mystery/{}' })).toEqual({
      allowed: false,
      reason: 'content:call_recording',
    });

    const allowed = compilePolicy(policy({}), withOps, 'r1');
    expect(allowed.operationDecision({ kind: 'v2', method: 'POST', key: 'POST /mystery/{}' })).toEqual({
      allowed: true,
    });
  });

  it('refuses every non-GET v2 request in a read policy, and every v1 action that is not a read', () => {
    const read = compilePolicy(policy({ access: 'read' }), withOps, 'r1');
    expect(read.operationDecision({ kind: 'v2', method: 'POST', key: 'POST /domains/{}' })).toEqual({
      allowed: false,
      reason: 'read_only',
    });
    expect(read.operationDecision({ kind: 'v2', method: 'get', key: 'GET /domains/{}' })).toEqual({ allowed: true });
    expect(read.operationDecision({ kind: 'v1', action: 'create', key: 'v1:user:create' })).toEqual({
      allowed: false,
      reason: 'read_only',
    });
    expect(read.operationDecision({ kind: 'v1', action: 'list', key: 'v1:user:list' })).toEqual({ allowed: true });
    expect(read.operationDecision({ kind: 'v1', action: 'get', key: 'v1:user:get' })).toEqual({ allowed: true });
  });

  it('refuses DELETE when destructive operations are denied, and in a read policy', () => {
    const denyDestructive = compilePolicy(policy({ deny: ['@destructive'] }), withOps, 'r1');
    expect(denyDestructive.operationDecision({ kind: 'v2', method: 'DELETE', key: 'DELETE /domains/{}' })).toEqual({
      allowed: false,
      reason: 'destructive',
    });

    const writable = compilePolicy(policy({}), withOps, 'r1');
    expect(writable.operationDecision({ kind: 'v2', method: 'DELETE', key: 'DELETE /domains/{}' })).toEqual({
      allowed: true,
    });

    const read = compilePolicy(policy({ access: 'read' }), withOps, 'r1');
    expect(read.operationDecision({ kind: 'v2', method: 'DELETE', key: 'DELETE /domains/{}' })).toEqual({
      allowed: false,
      reason: 'read_only',
    });
  });
});

describe('redirects through a compiled policy', () => {
  it('allows the registered callback, with or without a trailing slash, and nothing else', () => {
    const compiled = compilePolicy(
      policy({ platforms: ['https://ai.example.com/oauth/callback'] }),
      catalog([]),
      'r1',
    );
    expect(compiled.allowsRedirect('https://ai.example.com/oauth/callback')).toBe(true);
    expect(compiled.allowsRedirect('https://ai.example.com/oauth/callback/')).toBe(true);
    expect(compiled.allowsRedirect('http://ai.example.com/oauth/callback')).toBe(false);
    expect(compiled.allowsRedirect('https://ai.example.com/other')).toBe(false);
  });

  it('allows no redirect when the platform list is empty', () => {
    expect(compilePolicy(policy({}), catalog([]), 'r1').allowsRedirect('https://ai.example.com/cb')).toBe(false);
  });

  it('allows any valid redirect with "*"', () => {
    const compiled = compilePolicy(policy({ platforms: ['*'] }), catalog([]), 'r1');
    expect(compiled.allowsRedirect('https://anything.example/cb')).toBe(true);
    expect(compiled.allowsRedirect('not a uri')).toBe(false);
  });

  it('refuses a platform entry that is not one of the three forms', () => {
    expect(() => compilePolicy(policy({ platforms: ['http://ai.example.com/cb'] }), catalog([]), 'r1')).toThrow(
      expect.objectContaining({ code: 'invalid_platform' }),
    );
  });
});

describe('ALLOW_ALL', () => {
  it('is frozen and carries the unset revision', () => {
    expect(Object.isFrozen(ALLOW_ALL)).toBe(true);
    expect(ALLOW_ALL.revision).toBe('unset');
  });

  it('restricts nothing: no denied or stripped kinds, writes allowed, unclassified output allowed', () => {
    expect(ALLOW_ALL.access).toBe('write');
    expect(ALLOW_ALL.unclassifiedOutput).toBe('allow');
    expect(ALLOW_ALL.deniedKinds).toEqual([]);
    expect(ALLOW_ALL.strippedKinds).toEqual([]);
    expect(ALLOW_ALL.content).toEqual(ALL_CONTENT_ALLOW);
  });

  it('allows every tool name, including unknown and multi-line names', () => {
    for (const name of ['get_domains', 'delete_domain', 'call_transcript', 'never_seen', 'line\nbreak']) {
      expect(ALLOW_ALL.toolDecision(name), name).toEqual({ allowed: true });
    }
  });

  it('allows every operation, including writes, deletes and content operations', () => {
    const operations: Array<Parameters<CompiledPolicy['operationDecision']>[0]> = [
      { kind: 'v2', method: 'DELETE', key: 'DELETE /domains/{}' },
      { kind: 'v2', method: 'POST', key: 'POST /transcripts/{}' },
      { kind: 'v1', action: 'delete', key: 'v1:user:delete' },
    ];
    for (const op of operations) {
      expect(ALLOW_ALL.operationDecision(op), op.key).toEqual({ allowed: true });
    }
  });

  it('allows any valid redirect, loopback included', () => {
    expect(ALLOW_ALL.allowsRedirect('https://anything.example/cb')).toBe(true);
    expect(ALLOW_ALL.allowsRedirect('http://localhost:1/x')).toBe(true);
  });
});
