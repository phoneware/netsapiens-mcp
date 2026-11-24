/**
 * Result projection (spec 3.3 and E9). In registry mode the innermost dispatched tool's result is projected once: the
 * content fields of every kind the policy denies or strips are removed (a denied kind's fields are stripped from
 * results as well as its operations refused), internal fields are dropped, and with unclassifiedOutput deny every path
 * the declaration does not name is dropped. A removal adds a _withheld count. A result with several content blocks, or
 * a block that is not text, is refused.
 */
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessPolicyV1 } from '../access/contract.js';
import { getToolCatalogView } from '../access/groups.js';
import { compilePolicy, type CompiledPolicy } from '../access/policy.js';
import { NetSapiensClient } from '../netsapiens-client.js';
import { CURATED_CATALOG } from '../tools/curated/catalog.js';
import { textResult, type CuratedResult, type CuratedTool } from '../tools/curated/types.js';
import { handleToolCall } from '../tools/index.js';
import { policyOf, startFake, textOf, type FakeNetSapiens } from './support/enforcement-harness.js';

interface Payload {
  readonly data?: Array<Record<string, unknown>>;
  readonly _withheld?: Record<string, number>;
}

const HOME = { home: 'example.com', judge: async () => ({ kind: 'allow' as const }) };

function compiled(overrides: Partial<AccessPolicyV1>, revision = 'rev-e9'): CompiledPolicy {
  return compilePolicy(policyOf(overrides), getToolCatalogView(), revision);
}

/** Content kinds: transcript and ai_summary stripped, everything else allowed. */
const STRIP_AI_AND_TRANSCRIPT: Partial<AccessPolicyV1> = {
  content: { call_recording: 'allow', transcript: 'strip', voicemail: 'allow', sms_text: 'allow', ai_summary: 'strip', fax_page: 'allow' },
};

const DENY_AI: Partial<AccessPolicyV1> = {
  content: { call_recording: 'allow', transcript: 'allow', voicemail: 'allow', sms_text: 'allow', ai_summary: 'deny', fax_page: 'allow' },
};

const ALLOWLIST: Partial<AccessPolicyV1> = {
  ...STRIP_AI_AND_TRANSCRIPT,
  unclassifiedOutput: 'deny',
};

/** Test-only tool that returns the blocks its argument names, so a test controls the result shape. */
const PROBE: CuratedTool = {
  operations: [],
  minRole: 'user',
  schema: {
    name: 'probe_result_blocks',
    description: 'Test only: returns a result with the blocks named by kind.',
    inputSchema: { type: 'object', additionalProperties: true },
  },
  targets: {},
  output: { rules: [] },
  handler: async (args) => {
    if (args.kind === 'two_text') return { content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] };
    return { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] } as unknown as CuratedResult;
  },
};

let fake: FakeNetSapiens;

beforeAll(async () => {
  CURATED_CATALOG.push(PROBE);
  fake = await startFake();
});

afterAll(async () => {
  const index = CURATED_CATALOG.indexOf(PROBE);
  if (index !== -1) CURATED_CATALOG.splice(index, 1);
  await fake.close();
});

function clientFor(): NetSapiensClient {
  return new NetSapiensClient({ apiUrl: fake.origin, apiToken: 'test-token' });
}

async function recentCalls(policy: CompiledPolicy | undefined): Promise<Payload> {
  const result = await handleToolCall(clientFor(), 'recent_calls', { domain: 'example.com' }, 'domain_admin', 'alice', undefined, policy, policy ? HOME : undefined);
  return JSON.parse(textOf(result)) as Payload;
}

const CALL_INTELLIGENCE = ['call-intelligence-summary', 'call-intelligence-topics-top', 'prefilled-transcription-api'];
const METADATA = ['call-direction', 'call-answer-datetime', 'call-orig-call-id', 'call-intelligence-percent-positive'];

describe('E9 projection of the innermost result', () => {
  it('removes the call-intelligence and internal fields, keeps the metadata, and counts the stripped fields', async () => {
    const payload = await recentCalls(compiled(STRIP_AI_AND_TRANSCRIPT));
    const row = payload.data?.[0] ?? {};
    for (const field of CALL_INTELLIGENCE) expect(row).not.toHaveProperty(field);
    for (const field of METADATA) expect(row).toHaveProperty(field);
    expect(payload._withheld).toEqual({ ai_summary: 2 });
  });

  it('strips the fields of a denied kind as well as refusing its operations (the strip set includes denied kinds)', async () => {
    const payload = await recentCalls(compiled(DENY_AI));
    const row = payload.data?.[0] ?? {};
    expect(row).not.toHaveProperty('call-intelligence-summary');
    expect(row).not.toHaveProperty('call-intelligence-topics-top');
    expect(payload._withheld).toEqual({ ai_summary: 2 });
  });

  it('drops every undeclared path under unclassifiedOutput deny, and counts it', async () => {
    const payload = await recentCalls(compiled(ALLOWLIST));
    const row = payload.data?.[0] ?? {};
    expect(row).not.toHaveProperty('x-debug-blob');
    for (const field of METADATA) expect(row).toHaveProperty(field);
    expect(payload._withheld?.undeclared).toBeGreaterThan(0);
    expect(payload._withheld?.ai_summary).toBe(2);
  });

  it('keeps undeclared paths when unclassifiedOutput is allow, and adds no undeclared count', async () => {
    const payload = await recentCalls(compiled(STRIP_AI_AND_TRANSCRIPT));
    expect(payload.data?.[0]).toHaveProperty('x-debug-blob');
    expect(payload._withheld?.undeclared).toBeUndefined();
  });

  it('denies an unmapped generated tool under unclassifiedOutput deny, with zero requests', async () => {
    const policy = compiled(ALLOWLIST);
    const before = fake.requests.length;
    const args = { domain: 'example.com', user: '1001', type: 'greeting', file: 'a', index: '1', time: '1', auth: 'x' };
    await expect(handleToolCall(clientFor(), 'v1_audio_play', args, 'domain_admin', 'alice', undefined, policy, HOME)).rejects.toBeInstanceOf(McpError);
    expect(fake.requests.length).toBe(before);
  });

  it('sends the same unmapped generated tool when unclassifiedOutput is allow', async () => {
    const policy = compiled({ ...STRIP_AI_AND_TRANSCRIPT, unclassifiedOutput: 'allow' });
    const before = fake.requests.length;
    const args = { domain: 'example.com', user: '1001', type: 'greeting', file: 'a', index: '1', time: '1', auth: 'x' };
    await handleToolCall(clientFor(), 'v1_audio_play', args, 'domain_admin', 'alice', undefined, policy, HOME);
    expect(fake.requests.filter((request) => request.path === '/ns-api/').length).toBe(1);
    expect(fake.requests.length).toBe(before + 1);
  });

  it('refuses a result with several content blocks in registry mode, and passes it through unset', async () => {
    await expect(
      handleToolCall(clientFor(), 'probe_result_blocks', { kind: 'two_text' }, 'domain_admin', 'alice', undefined, compiled(STRIP_AI_AND_TRANSCRIPT), HOME),
    ).rejects.toBeInstanceOf(McpError);
    const unset = await handleToolCall(clientFor(), 'probe_result_blocks', { kind: 'two_text' }, 'domain_admin', 'alice');
    expect((unset as { content: unknown[] }).content.length).toBe(2);
  });

  it('refuses a result whose block is not text in registry mode', async () => {
    await expect(
      handleToolCall(clientFor(), 'probe_result_blocks', { kind: 'image' }, 'domain_admin', 'alice', undefined, compiled(STRIP_AI_AND_TRANSCRIPT), HOME),
    ).rejects.toBeInstanceOf(McpError);
  });

  it('projects the call_api result once: the counts through call_api equal the direct counts, under strip and under the allowlist', async () => {
    for (const overrides of [STRIP_AI_AND_TRANSCRIPT, ALLOWLIST]) {
      const policy = compiled(overrides);
      const direct = await recentCalls(policy);
      const result = await handleToolCall(
        clientFor(),
        'call_api',
        { tool_name: 'recent_calls', args: { domain: 'example.com' } },
        'domain_admin',
        'alice',
        undefined,
        policy,
        HOME,
      );
      const viaCallApi = JSON.parse(textOf(result)) as Payload;
      expect(viaCallApi._withheld).toEqual(direct._withheld);
      expect(viaCallApi.data?.[0]).toHaveProperty('call-direction');
    }
  });
});
