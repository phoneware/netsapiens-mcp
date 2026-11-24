/**
 * Tool enforcement (spec 3.5 E4 to E7): what tools/list, search_api, tools/call and the dispatcher allow under a
 * compiled registry policy. Every refusal asserts zero requests at the fake NetSapiens: fake.requests logs each request
 * before routing, so an unchanged count proves the connector sent nothing. The denied tools are called with arguments
 * that validate, so a refusal can only come from the policy.
 */
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AccessView } from '../access/types.js';
import { NetSapiensClient } from '../netsapiens-client.js';
import { registerAllTools } from '../tools/index.js';
import { allowView, createFakeEnforcer } from './support/fake-access-enforcer.js';
import {
  authExtra,
  policyOf,
  standInServer,
  startFake,
  textOf,
  type FakeNetSapiens,
} from './support/enforcement-harness.js';

const active: FakeNetSapiens[] = [];
const savedMode = process.env.MCP_TOOL_MODE;
/** Valid arguments for recent_calls: a request that reaches the fake if the policy allows it. */
const RECENT_CALLS_ARGS = { domain: 'example.com' };

beforeAll(() => {
  delete process.env.MCP_TOOL_MODE;
});

afterAll(() => {
  if (savedMode !== undefined) process.env.MCP_TOOL_MODE = savedMode;
});

afterEach(async () => {
  while (active.length > 0) await active.pop()!.close();
});

/** A signed-in session over the real registerAllTools, with the given view and identity. */
async function session(view: AccessView, overrides: Record<string, unknown> = {}) {
  const fake = await startFake();
  active.push(fake);
  const enforcer = createFakeEnforcer(view);
  const client = new NetSapiensClient({ apiUrl: fake.origin, apiToken: 'test-token' });
  const stand = standInServer();
  registerAllTools(stand.server as unknown as Server, client, 'domain_admin', 'alice', undefined, enforcer);
  const extra = authExtra(fake.origin, overrides);
  return {
    fake,
    enforcer,
    async list(): Promise<string[]> {
      const result = (await stand.invoke(ListToolsRequestSchema, { params: {} }, extra)) as { tools: Array<{ name: string }> };
      return result.tools.map((tool) => tool.name);
    },
    call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
      return stand.invoke(CallToolRequestSchema, { params: { name, arguments: args } }, extra) as Promise<unknown>;
    },
    async search(query: string): Promise<string[]> {
      const result = await stand.invoke(CallToolRequestSchema, { params: { name: 'search_api', arguments: { query, limit: 50 } } }, extra);
      const body = JSON.parse(textOf(result)) as { matches: Array<{ name: string }> };
      return body.matches.map((match) => match.name);
    },
  };
}

describe('E4 tools/list', () => {
  it('omits a denied tool and keeps the tools it does not deny', async () => {
    const s = await session(allowView(policyOf({ tools: { allow: ['*'], deny: ['recent_calls'] } }), 'b-list-1'));
    const names = await s.list();
    expect(names).not.toContain('recent_calls');
    expect(names).toContain('find_user');
  });

  it.each([
    ['a tenant that is not enrolled', { kind: 'deny', reason: 'tenant_not_enrolled' } as AccessView, {}],
    ['an unavailable registry', { kind: 'unavailable' } as AccessView, {}],
    ['an identity that cannot be keyed', allowView(policyOf(), 'b-list-2'), { nsDomain: undefined }],
  ])('lists nothing for %s, and refuses calls with zero NetSapiens requests', async (_label, view, overrides) => {
    const s = await session(view, overrides);
    const before = s.fake.requests.length;
    expect(await s.list()).toEqual([]);
    await expect(s.call('recent_calls', RECENT_CALLS_ARGS)).rejects.toBeInstanceOf(McpError);
    expect(s.fake.requests.length).toBe(before);
  });
});

describe('E5 search_api', () => {
  const DENIED = 'get_holidays_by_country_by_region_by_year';

  it('leaves a denied generated tool out of search results, and keeps its neighbours', async () => {
    const open = await session(allowView(policyOf(), 'b-search-1'));
    expect(await open.search('holidays')).toContain(DENIED);

    const closed = await session(allowView(policyOf({ tools: { allow: ['*'], deny: [DENIED] } }), 'b-search-2'));
    const matches = await closed.search('holidays');
    expect(matches).not.toContain(DENIED);
    expect(matches.length).toBeGreaterThan(0);
  });
});

describe('E6 tools/call and E7 dispatch', () => {
  it('refuses a denied tool before any request', async () => {
    const s = await session(allowView(policyOf({ tools: { allow: ['*'], deny: ['recent_calls'] } }), 'b-call-1'));
    const before = s.fake.requests.length;
    await expect(s.call('recent_calls', RECENT_CALLS_ARGS)).rejects.toBeInstanceOf(McpError);
    expect(s.fake.requests.length).toBe(before);
  });

  it('refuses a denied tool under its exposed, shortened alias', async () => {
    const canonical = 'patch_domains_by_domain_users_by_user_calls_by_call_id_transfer_peer';
    const s = await session(allowView(policyOf({ tools: { allow: ['*'], deny: [canonical] } }), 'b-call-2'));
    const before = s.fake.requests.length;
    await expect(s.call('patch_domain_user_call_transfer_peer', {})).rejects.toBeInstanceOf(McpError);
    expect(s.fake.requests.length).toBe(before);
  });

  it('refuses a denied tool through call_api by its inner name', async () => {
    const s = await session(allowView(policyOf({ tools: { allow: ['*'], deny: ['recent_calls'] } }), 'b-call-3'));
    const before = s.fake.requests.length;
    await expect(s.call('call_api', { tool_name: 'recent_calls', args: RECENT_CALLS_ARGS })).rejects.toBeInstanceOf(McpError);
    expect(s.fake.requests.length).toBe(before);
  });

  it('refuses a generated tool called directly in curated mode unless the allow list names it', async () => {
    const holidays = 'get_holidays_by_country_by_region_by_year';
    const args = { country: 'us', region: 'ca', year: '2026' };

    const curatedOnly = await session(allowView(policyOf({ tools: { allow: ['@curated'], deny: [] } }), 'b-call-4'));
    const refusedBefore = curatedOnly.fake.requests.length;
    await expect(curatedOnly.call(holidays, args)).rejects.toBeInstanceOf(McpError);
    expect(curatedOnly.fake.requests.length).toBe(refusedBefore);

    const everything = await session(allowView(policyOf(), 'b-call-5'));
    const allowedBefore = everything.fake.requests.length;
    await everything.call(holidays, args);
    expect(everything.fake.requests.length).toBe(allowedBefore + 1);
    expect(everything.fake.requests.at(-1)?.path).toBe('/ns-api/v2/holidays/us/ca/2026');
  });
});

describe('E4 to E7 read mode', () => {
  it('lists no write tool and refuses one called directly, with zero requests', async () => {
    const s = await session(allowView(policyOf({ access: 'read' }), 'b-read-1'));
    const names = await s.list();
    expect(names).not.toContain('place_call');
    expect(names).not.toContain('end_call');
    expect(names).toContain('recent_calls');
    const before = s.fake.requests.length;
    await expect(s.call('place_call', { to: '1001' })).rejects.toBeInstanceOf(McpError);
    expect(s.fake.requests.length).toBe(before);
  });

  it('refuses a v2 POST through call_api with zero requests', async () => {
    const s = await session(allowView(policyOf({ access: 'read' }), 'b-read-2'));
    const before = s.fake.requests.length;
    await expect(
      s.call('call_api', { tool_name: 'post_domains_by_domain_users_by_user_calls', args: { domain: 'example.com', user: '1001' } }),
    ).rejects.toBeInstanceOf(McpError);
    expect(s.fake.requests.length).toBe(before);
  });

  it('refuses a non-read v1 action through call_api with zero requests to /ns-api/', async () => {
    const s = await session(allowView(policyOf({ access: 'read' }), 'b-read-3'));
    const before = s.fake.requests.length;
    await expect(
      s.call('call_api', {
        tool_name: 'v1_audio_play',
        args: { domain: 'example.com', user: '1001', type: 'greeting', file: 'a', index: '1', time: '1', auth: 'x' },
      }),
    ).rejects.toBeInstanceOf(McpError);
    expect(s.fake.requests.filter((request) => request.path === '/ns-api/').length).toBe(0);
    expect(s.fake.requests.length).toBe(before);
  });
});
