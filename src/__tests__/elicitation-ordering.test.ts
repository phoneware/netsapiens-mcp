/**
 * H: the registry policy is checked before the destructive confirmation prompt. A refused tool never prompts and no
 * request reaches the fake NetSapiens. An allowed destructive tool prompts once. The stand-in server records prompts.
 */
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NetSapiensClient } from '../netsapiens-client.js';
import { registerAllTools } from '../tools/index.js';
import { authExtra, policyOf, standInServer, startFake, type FakeNetSapiens } from './support/enforcement-harness.js';
import { allowView, createFakeEnforcer } from './support/fake-access-enforcer.js';

const DESTRUCTIVE = 'end_call';
const ARGS = { call_id: 'c-1' };
const savedConfirm = process.env.MCP_CONFIRM_DESTRUCTIVE;
let fake: FakeNetSapiens;

beforeAll(async () => {
  fake = await startFake();
});

afterAll(async () => {
  await fake.close();
  if (savedConfirm !== undefined) process.env.MCP_CONFIRM_DESTRUCTIVE = savedConfirm;
  else delete process.env.MCP_CONFIRM_DESTRUCTIVE;
});

beforeEach(() => {
  process.env.MCP_CONFIRM_DESTRUCTIVE = 'true';
});

/** A stand-in server with the tools installed under the given tool selection, and a call that carries a signed-in session. */
function session(tools: { allow: string[]; deny: string[] }) {
  const stand = standInServer();
  const enforcer = createFakeEnforcer(allowView(policyOf({ tools }), 'h-1'));
  const client = new NetSapiensClient({ apiUrl: fake.origin, apiToken: 'test-token' });
  registerAllTools(stand.server as unknown as Server, client, 'domain_admin', 'alice', undefined, enforcer);
  const call = (name: string, args: Record<string, unknown>) =>
    stand.invoke(CallToolRequestSchema, { params: { name, arguments: args } }, authExtra(fake.origin));
  return { stand, call };
}

describe('H the policy is checked before the confirmation prompt', () => {
  it('a denied destructive tool is refused without a prompt, and no request reaches the fake', async () => {
    const s = session({ allow: ['*'], deny: [DESTRUCTIVE] });
    const before = [...fake.requests];
    await expect(s.call(DESTRUCTIVE, ARGS)).rejects.toBeInstanceOf(McpError);
    expect(s.stand.elicitInput).not.toHaveBeenCalled();
    expect(fake.requests).toEqual(before);
  });

  it('a denied destructive tool called through call_api by its inner name is refused without a prompt', async () => {
    const s = session({ allow: ['*'], deny: [DESTRUCTIVE] });
    const before = [...fake.requests];
    await expect(s.call('call_api', { tool_name: DESTRUCTIVE, args: ARGS })).rejects.toBeInstanceOf(McpError);
    expect(s.stand.elicitInput).not.toHaveBeenCalled();
    expect(fake.requests).toEqual(before);
  });

  it('control: an allowed destructive tool prompts once before it is dispatched', async () => {
    const s = session({ allow: ['*'], deny: [] });
    await s.call(DESTRUCTIVE, ARGS).catch(() => undefined);
    expect(s.stand.elicitInput).toHaveBeenCalledTimes(1);
  });
});
