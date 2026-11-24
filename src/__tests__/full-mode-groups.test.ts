/**
 * P2, full mode. A generated entry takes its groups from its own operation. A name lookup found the curated tool of the
 * same name, so the generated PATCH agent_status was labelled a read, and deny @write did not refuse it. Curated mode still
 * dispatches the curated tool and takes its groups from its own metadata. Both modes are checked on the same catalog, and
 * lookupTool decides which entry each mode dispatches.
 */
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getToolCatalogView } from '../access/groups.js';
import { compilePolicy } from '../access/policy.js';
import { toolRegistry } from '../generated/registry.js';
import { NetSapiensClient } from '../netsapiens-client.js';
import { handleToolCall, isToolReadOnly } from '../tools/index.js';
import { policyOf, startFake, type FakeNetSapiens } from './support/enforcement-harness.js';

const HOME = { home: 'example.com', judge: async () => ({ kind: 'allow' as const }) };
const COLLIDING = ['agent_status', 'read_voicemail', 'forward_voicemail', 'agent_login', 'agent_logout'];
const AGENT_STATUS_ARGS = { domain: 'example.com', 'callqueue-agent-id': '1001', status: 'offline' };

const savedMode = process.env.MCP_TOOL_MODE;
let fake: FakeNetSapiens;

beforeAll(async () => {
  fake = await startFake();
});

afterAll(async () => {
  await fake.close();
  if (savedMode === undefined) delete process.env.MCP_TOOL_MODE;
  else process.env.MCP_TOOL_MODE = savedMode;
});

/** Runs a body with MCP_TOOL_MODE set to the mode, and restores the environment after it. */
async function inMode<T>(mode: 'full' | 'curated', body: () => Promise<T>): Promise<T> {
  process.env.MCP_TOOL_MODE = mode;
  try {
    return await body();
  } finally {
    if (savedMode === undefined) delete process.env.MCP_TOOL_MODE;
    else process.env.MCP_TOOL_MODE = savedMode;
  }
}

const client = () => new NetSapiensClient({ apiUrl: fake.origin, apiToken: 'test-token' });

/** The HTTP method of a generated tool's own operation, as its definition states it. */
const generatedMethod = (name: string): string | undefined => toolRegistry.get(name)?.operation?.method?.toUpperCase();

describe('P2 full mode: the catalog takes a generated entry\'s groups from its own operation', () => {
  it.each(COLLIDING)('full mode: %s is a read only when its generated operation is a GET', async (name) => {
    const groups = await inMode('full', async () => getToolCatalogView().lookupTool(name)?.groups ?? []);
    expect(groups).toContain('@generated');
    expect(groups.includes('@read')).toBe(generatedMethod(name) === 'GET');
    expect(groups.includes('@write')).toBe(generatedMethod(name) !== 'GET');
  });

  it.each(COLLIDING)('curated mode: %s takes the groups of its curated tool', async (name) => {
    const groups = await inMode('curated', async () => getToolCatalogView().lookupTool(name)?.groups ?? []);
    expect(groups).toContain('@curated');
    expect(groups.includes('@read')).toBe(isToolReadOnly(name));
  });
});

describe('P2 full mode: dispatch refuses the generated write it runs', () => {
  it('refuses the generated agent_status PATCH under deny @write, with no request', async () => {
    const mark = fake.requests.length;
    await inMode('full', async () => {
      const policy = compilePolicy(policyOf({ tools: { allow: ['*'], deny: ['@write'] } }), getToolCatalogView(), 'rev-p2-full');
      await expect(handleToolCall(client(), 'agent_status', AGENT_STATUS_ARGS, 'domain_admin', 'alice', undefined, policy, HOME)).rejects.toBeInstanceOf(McpError);
    });
    expect(fake.requests.slice(mark)).toEqual([]);
  });

  it('refuses the generated agent_status PATCH when only @read is allowed, with no request', async () => {
    const mark = fake.requests.length;
    await inMode('full', async () => {
      const policy = compilePolicy(policyOf({ tools: { allow: ['@read'], deny: [] } }), getToolCatalogView(), 'rev-p2-read');
      await expect(handleToolCall(client(), 'agent_status', AGENT_STATUS_ARGS, 'domain_admin', 'alice', undefined, policy, HOME)).rejects.toBeInstanceOf(McpError);
    });
    expect(fake.requests.slice(mark)).toEqual([]);
  });

  it('control: with nothing denied the generated PATCH reaches the fake', async () => {
    const mark = fake.requests.length;
    await inMode('full', async () => {
      const policy = compilePolicy(policyOf(), getToolCatalogView(), 'rev-p2-open');
      await handleToolCall(client(), 'agent_status', AGENT_STATUS_ARGS, 'domain_admin', 'alice', undefined, policy, HOME).catch(() => undefined);
    });
    expect(fake.requests.slice(mark).map((request) => request.method)).toEqual(['PATCH']);
  });
});
