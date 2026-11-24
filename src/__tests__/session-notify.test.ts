/**
 * E10: in session mode a change in the request's access view sends tools/list_changed over the standalone stream; in
 * stateless mode nothing is sent (there is no stream to send it on). The change is noticed on the next tools/list or
 * tools/call, not on a timer: the registry is asked per request, so a change with no request sends nothing until then.
 */
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { allowView, createFakeEnforcer } from './support/fake-access-enforcer.js';
import { policyOf, startFake, type FakeNetSapiens } from './support/enforcement-harness.js';
import { connectClient, settle, startMcpHttp, until, type ConnectedClient, type McpHttp } from './support/mcp-http.js';

const savedStateless = process.env.MCP_STATELESS;
let fake: FakeNetSapiens;
const open: Array<McpHttp | ConnectedClient> = [];

beforeAll(async () => {
  fake = await startFake();
});

afterAll(async () => {
  await fake.close();
});

afterEach(async () => {
  while (open.length > 0) await open.pop()!.close();
  if (savedStateless !== undefined) process.env.MCP_STATELESS = savedStateless;
  else delete process.env.MCP_STATELESS;
});

/** Starts an endpoint and a client for one signed-in session, with the given mode. */
async function endpoint(stateless: boolean, enforcer = createFakeEnforcer(allowView(policyOf(), 'r1'))) {
  process.env.MCP_STATELESS = stateless ? 'true' : 'false';
  const identities = new Map([['tok-alice', { nsDomain: 'example.com', nsUser: 'alice', nsScope: 'Office Manager', nsApiUrl: fake.origin }]]);
  const mcp = await startMcpHttp({ enforcer, apiUrl: fake.origin, identities, userIdentity: 'alice', stateless });
  open.push(mcp);
  const connected = await connectClient(mcp.url, 'tok-alice');
  open.push(connected);
  let notifications = 0;
  connected.client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    notifications += 1;
  });
  return { enforcer, client: connected.client, notifications: () => notifications };
}

describe('E10 tools/list_changed', () => {
  it('sends tools/list_changed over the standalone stream when the view signature changes, in session mode', async () => {
    const s = await endpoint(false);
    await s.client.listTools();
    expect(s.notifications()).toBe(0);
    s.enforcer.setHome(allowView(policyOf(), 'r2'));
    await s.client.listTools();
    await until(() => s.notifications() > 0);
    expect(s.notifications()).toBe(1);
  });

  // Absence has no event to await: the bounded settle lets any notification the server would send arrive first.
  it('sends nothing when the view does not change between requests', async () => {
    const s = await endpoint(false);
    await s.client.listTools();
    await s.client.listTools();
    await settle(300);
    expect(s.notifications()).toBe(0);
  });

  it('sends nothing in stateless mode, although the view changes', async () => {
    const s = await endpoint(true);
    await s.client.listTools();
    s.enforcer.setHome(allowView(policyOf(), 'r2'));
    await s.client.listTools();
    await settle(300);
    expect(s.notifications()).toBe(0);
  });
});
