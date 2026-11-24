import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONTENT_KINDS, parseRegistryDecision } from '../access/contract.js';
import * as lib from '../lib.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/access/', import.meta.url));

type Body = Record<string, unknown>;

const CONTENT = {
  call_recording: 'deny',
  transcript: 'deny',
  voicemail: 'deny',
  sms_text: 'deny',
  ai_summary: 'deny',
  fax_page: 'deny',
} as const;

const POLICY = {
  tools: { allow: ['@curated'], deny: ['@destructive'] },
  access: 'read',
  content: CONTENT,
  unclassifiedOutput: 'deny',
  platforms: ['https://ai.example.com/oauth/callback'],
} as const;

const VALID_ALLOW = {
  version: 1,
  decision: 'allow',
  revision: '9f2c1e7a40b3d6e1',
  ttlSeconds: 60,
  policy: POLICY,
} as const;

const VALID_DENY = {
  version: 1,
  decision: 'deny',
  reason: 'tenant_not_enrolled',
  revision: '0',
  ttlSeconds: 60,
} as const;

/** A valid allow with some members replaced. */
function allowWith(patch: Body): Body {
  return { ...VALID_ALLOW, ...patch };
}

/** A valid deny with some members replaced. */
function denyWith(patch: Body): Body {
  return { ...VALID_DENY, ...patch };
}

/** The valid policy with some members replaced. */
function policyWith(patch: Body): Body {
  return { ...POLICY, ...patch };
}

/** A copy of a record without one member. */
function without(record: Body, key: string): Body {
  const copy: Body = { ...record };
  delete copy[key];
  return copy;
}

function manyStrings(count: number, prefix: string): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${i}`);
}

const MALFORMED: Array<[string, unknown]> = [
  ['a missing decision', without(VALID_ALLOW, 'decision')],
  ['a decision that is neither allow nor deny', allowWith({ decision: 'maybe' })],
  ['version 2', allowWith({ version: 2 })],
  ['version as a string', allowWith({ version: '1' })],
  ['a missing version', without(VALID_ALLOW, 'version')],
  ['a missing revision', without(VALID_ALLOW, 'revision')],
  ['an empty revision', allowWith({ revision: '' })],
  ['a revision with a space', allowWith({ revision: 'rev 1' })],
  ['a revision with a slash', allowWith({ revision: '../rev' })],
  ['a revision longer than 128 characters', allowWith({ revision: 'a'.repeat(129) })],
  ['ttlSeconds of zero', allowWith({ ttlSeconds: 0 })],
  ['a negative ttlSeconds', allowWith({ ttlSeconds: -5 })],
  ['a fractional ttlSeconds', allowWith({ ttlSeconds: 1.5 })],
  ['ttlSeconds as a string', allowWith({ ttlSeconds: '60' })],
  ['a missing ttlSeconds', without(VALID_ALLOW, 'ttlSeconds')],
  ['ttlSeconds beyond the safe integer range', allowWith({ ttlSeconds: 2 ** 53 })],
  ['an allow without a policy', without(VALID_ALLOW, 'policy')],
  ['a policy without tools', allowWith({ policy: without(POLICY, 'tools') })],
  [
    'tools.allow that is not a list',
    allowWith({ policy: policyWith({ tools: { allow: '@curated', deny: [] } }) }),
  ],
  ['a tools entry that is not a string', allowWith({ policy: policyWith({ tools: { allow: [1], deny: [] } }) })],
  ['a tools entry that is blank', allowWith({ policy: policyWith({ tools: { allow: ['   '], deny: [] } }) })],
  [
    'a tools entry over 200 characters',
    allowWith({ policy: policyWith({ tools: { allow: [], deny: ['x'.repeat(201)] } }) }),
  ],
  [
    'a tools list over 512 entries',
    allowWith({ policy: policyWith({ tools: { allow: manyStrings(513, 'tool_'), deny: [] } }) }),
  ],
  ['an access mode that is neither read nor write', allowWith({ policy: policyWith({ access: 'admin' }) })],
  ['a missing access mode', allowWith({ policy: without(POLICY, 'access') })],
  ['a missing content object', allowWith({ policy: without(POLICY, 'content') })],
  [
    'a content object missing one kind',
    allowWith({ policy: policyWith({ content: without(CONTENT, 'fax_page') }) }),
  ],
  [
    'a content action that is not deny, strip or allow',
    allowWith({ policy: policyWith({ content: { ...CONTENT, transcript: 'block' } }) }),
  ],
  [
    'an unclassifiedOutput that is neither deny nor allow',
    allowWith({ policy: policyWith({ unclassifiedOutput: 'maybe' }) }),
  ],
  ['a missing unclassifiedOutput', allowWith({ policy: without(POLICY, 'unclassifiedOutput') })],
  ['a missing platforms list', allowWith({ policy: without(POLICY, 'platforms') })],
  [
    'a platform over http',
    allowWith({ policy: policyWith({ platforms: ['http://ai.example.com/oauth/callback'] }) }),
  ],
  [
    'a platform with userinfo',
    allowWith({ policy: policyWith({ platforms: ['https://user@ai.example.com/oauth/callback'] }) }),
  ],
  ['a platform with a fragment', allowWith({ policy: policyWith({ platforms: ['https://ai.example.com/cb#x'] }) })],
  ['a platform with a query', allowWith({ policy: policyWith({ platforms: ['https://ai.example.com/cb?x=1'] }) })],
  ['a platform that is not https', allowWith({ policy: policyWith({ platforms: ['javascript:alert(1)'] }) })],
  ['an empty platform', allowWith({ policy: policyWith({ platforms: [''] }) })],
  ['a platform that is not a string', allowWith({ policy: policyWith({ platforms: [5] }) })],
  [
    'a platform list over 512 entries',
    allowWith({
      policy: policyWith({ platforms: manyStrings(513, 'https://ai').map((host) => `${host}.example.com/cb`) }),
    }),
  ],
  ['a deny without a reason', without(VALID_DENY, 'reason')],
  ['a deny with an empty reason', denyWith({ reason: '' })],
  ['a deny with a reason over 200 characters', denyWith({ reason: 'r'.repeat(201) })],
  ['critical that is not a list', allowWith({ critical: 'policy.v2' })],
  ['critical that holds a non-string', allowWith({ critical: [1] })],
  ['critical that is null', allowWith({ critical: null })],
  ['a body that is an array', []],
  ['a body that is null', null],
  ['a body that is a number', 5],
];

describe('registry decision parser', () => {
  it('accepts a valid allow and returns exactly its members', () => {
    expect(parseRegistryDecision(VALID_ALLOW)).toEqual({ ok: true, decision: VALID_ALLOW });
  });

  it('accepts a valid deny and returns exactly its members', () => {
    expect(parseRegistryDecision(VALID_DENY)).toEqual({ ok: true, decision: VALID_DENY });
  });

  it('treats an unknown deny reason as a deny', () => {
    const body = denyWith({ reason: 'registry_maintenance' });
    expect(parseRegistryDecision(body)).toEqual({ ok: true, decision: body });
  });

  it('ignores unknown members that are not named in critical', () => {
    const body = allowWith({
      futureTopLevel: { anything: true },
      policy: policyWith({ futureField: 'x', tools: { ...POLICY.tools, futureList: ['y'] } }),
    });
    expect(parseRegistryDecision(body)).toEqual({ ok: true, decision: VALID_ALLOW });
  });

  it('accepts the JSON text of a decision as well as the parsed value', () => {
    expect(parseRegistryDecision(JSON.stringify(VALID_ALLOW))).toEqual({ ok: true, decision: VALID_ALLOW });
  });

  it('reports a body that is not JSON text as invalid_json', () => {
    expect(parseRegistryDecision('{"version":1,')).toMatchObject({ ok: false, errorClass: 'invalid_json' });
  });

  it('accepts an empty critical list', () => {
    expect(parseRegistryDecision(denyWith({ critical: [] }))).toEqual({ ok: true, decision: VALID_DENY });
  });

  it('accepts the three platform forms', () => {
    const body = allowWith({ policy: policyWith({ platforms: ['loopback', '*', 'https://ai.example.com/'] }) });
    expect(parseRegistryDecision(body).ok).toBe(true);
  });

  it('accepts the boundary values: a 128 character revision, ttl 1, and 512 tool entries', () => {
    const body = allowWith({
      revision: 'a'.repeat(128),
      ttlSeconds: 1,
      policy: policyWith({ tools: { allow: manyStrings(512, 'tool_'), deny: [] } }),
    });
    expect(parseRegistryDecision(body).ok).toBe(true);
  });

  it.each(MALFORMED)('rejects a decision with %s as a contract error', (_name, input) => {
    expect(parseRegistryDecision(input)).toMatchObject({ ok: false, errorClass: 'contract' });
  });

  it('rejects a non-empty critical list as critical, whether the body is valid or not', () => {
    expect(parseRegistryDecision(allowWith({ critical: ['policy.v2'] }))).toMatchObject({
      ok: false,
      errorClass: 'critical',
    });
    expect(parseRegistryDecision(denyWith({ critical: ['x'] }))).toMatchObject({ ok: false, errorClass: 'critical' });
    expect(parseRegistryDecision(without(denyWith({ critical: ['x'] }), 'reason'))).toMatchObject({
      ok: false,
      errorClass: 'critical',
    });
  });

  it('never echoes received values into the error message', () => {
    const result = parseRegistryDecision(allowWith({ revision: 'secret value here!' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).not.toContain('secret value here');
  });

  it('is exported from the package entry point', () => {
    expect(lib.parseRegistryDecision).toBe(parseRegistryDecision);
  });

  it('classifies the six content kinds the policy needs', () => {
    expect([...CONTENT_KINDS]).toEqual([
      'call_recording',
      'transcript',
      'voicemail',
      'sms_text',
      'ai_summary',
      'fax_page',
    ]);
  });

  it('requires every content kind, so each missing one is a contract error', () => {
    for (const kind of CONTENT_KINDS) {
      const body = allowWith({ policy: policyWith({ content: without(CONTENT, kind) }) });
      expect(parseRegistryDecision(body), `missing ${kind}`).toMatchObject({ ok: false, errorClass: 'contract' });
    }
  });
});

describe('wire fixtures', () => {
  const files = readdirSync(FIXTURES)
    .filter((file) => file.endsWith('.json'))
    .sort();

  it('ships the fixtures the documentation quotes', () => {
    expect(files).toEqual(
      expect.arrayContaining(['allow.json', 'deny.json', 'deny-unknown-reason.json', 'invalid-critical.json']),
    );
  });

  for (const file of files) {
    it(`${file} parses as its name declares`, () => {
      const result = parseRegistryDecision(readFileSync(`${FIXTURES}${file}`, 'utf8'));
      if (file === 'invalid-critical.json') {
        expect(result).toMatchObject({ ok: false, errorClass: 'critical' });
      } else if (file.startsWith('invalid-')) {
        expect(result).toMatchObject({ ok: false, errorClass: 'contract' });
      } else {
        expect(result.ok, file).toBe(true);
      }
    });
  }

  it('parses allow.json and deny.json to the values the tests use', () => {
    expect(parseRegistryDecision(readFileSync(`${FIXTURES}allow.json`, 'utf8'))).toEqual({
      ok: true,
      decision: VALID_ALLOW,
    });
    expect(parseRegistryDecision(readFileSync(`${FIXTURES}deny.json`, 'utf8'))).toEqual({
      ok: true,
      decision: VALID_DENY,
    });
  });
});
