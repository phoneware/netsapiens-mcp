/**
 * P2 (review round 2): v1 call:disconnect and call:reject end a call and turn one away, as their v2 forms (DELETE) do. Under
 * deny @destructive each is refused at the tool layer (its group) and at the operation guard, with zero /ns-api/ requests:
 * through call_api, and through a curated probe that calls the client directly (only the guard can refuse that one). Under
 * access read each is refused as a non-read action. With nothing denied each reaches the fake once.
 */
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getToolCatalogView } from '../access/groups.js';
import { compilePolicy, type CompiledPolicy } from '../access/policy.js';
import { NetSapiensClient } from '../netsapiens-client.js';
import { CURATED_CATALOG } from '../tools/curated/catalog.js';
import { textResult, type CuratedTool } from '../tools/curated/types.js';
import { handleToolCall } from '../tools/index.js';
import { policyOf, startFake, type FakeNetSapiens } from './support/enforcement-harness.js';

const HOME = { home: 'example.com', judge: async () => ({ kind: 'allow' as const }) };
const TOOLS = ['v1_call_disconnect', 'v1_call_reject'] as const;
const ACTIONS = ['disconnect', 'reject'] as const;
const CALL_ARGS = { callid: 'c-1', uid: '1001' };

/**
 * Test only. It calls the client directly with the call action its arguments name. Its own name and group carry no
 * destructive word, so the tool layer lets it through and only the operation guard can refuse it.
 */
const PROBE: CuratedTool = {
  operations: [],
  minRole: 'user',
  schema: {
    name: 'probe_call_control',
    description: 'Test only: calls the call action the arguments name.',
    inputSchema: { type: 'object', additionalProperties: true },
  },
  targets: {},
  output: { rules: [] },
  handler: async (args, client) => {
    const caller = client as unknown as { v1Call(object: string, action: string, params: Record<string, unknown>): Promise<unknown> };
    return textResult(await caller.v1Call('call', String(args.action), {}));
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

const client = () => new NetSapiensClient({ apiUrl: fake.origin, apiToken: 'test-token' });
const compiled = (overrides: Parameters<typeof policyOf>[0]): CompiledPolicy =>
  compilePolicy(policyOf(overrides), getToolCatalogView(), 'rev-call-control');
const DENY_DESTRUCTIVE = { tools: { allow: ['*'], deny: ['@destructive'] } };
const READ_ONLY = { access: 'read' as const };
const v1Requests = (mark: number): number => fake.requests.slice(mark).filter(request => request.path === '/ns-api/').length;
const callApi = (tool: string, policy: CompiledPolicy) =>
  handleToolCall(client(), 'call_api', { tool_name: tool, args: CALL_ARGS }, 'domain_admin', 'alice', undefined, policy, HOME);

describe('P2 call_api: the v1 call actions are refused under deny @destructive, with zero requests', () => {
  it.each(TOOLS)('refuses %s under deny @destructive, and the fake sees no /ns-api/ request', async tool => {
    const mark = fake.requests.length;
    await expect(callApi(tool, compiled(DENY_DESTRUCTIVE))).rejects.toBeInstanceOf(McpError);
    expect(v1Requests(mark)).toBe(0);
  });

  it.each(TOOLS)('refuses %s under access read, and the fake sees no /ns-api/ request', async tool => {
    const mark = fake.requests.length;
    await expect(callApi(tool, compiled(READ_ONLY))).rejects.toBeInstanceOf(McpError);
    expect(v1Requests(mark)).toBe(0);
  });

  it.each(TOOLS)('sends %s once when nothing is denied (control: the arguments reach the fake)', async tool => {
    const mark = fake.requests.length;
    await callApi(tool, compiled({}));
    expect(v1Requests(mark)).toBe(1);
  });
});

describe('P2 tool layer: the v1 call actions carry @destructive in the catalog', () => {
  it.each(TOOLS)('%s is in the destructive group and the write group', tool => {
    const groups = getToolCatalogView().lookupTool(tool)?.groups ?? [];
    expect(groups).toEqual(expect.arrayContaining(['@destructive', '@write']));
    expect(groups).not.toContain('@read');
  });
});

describe('P2 operation guard: a curated tool that calls the client directly is refused under deny @destructive', () => {
  it.each(ACTIONS)('refuses client.v1Call("call", "%s") with zero requests', async action => {
    const mark = fake.requests.length;
    await expect(handleToolCall(client(), 'probe_call_control', { action }, 'domain_admin', 'alice', undefined, compiled(DENY_DESTRUCTIVE), HOME)).rejects.toBeInstanceOf(
      McpError,
    );
    expect(fake.requests.length).toBe(mark);
  });

  it.each(ACTIONS)('sends client.v1Call("call", "%s") when nothing is denied (control)', async action => {
    const mark = fake.requests.length;
    await handleToolCall(client(), 'probe_call_control', { action }, 'domain_admin', 'alice', undefined, compiled({}), HOME);
    expect(v1Requests(mark)).toBe(1);
  });
});
