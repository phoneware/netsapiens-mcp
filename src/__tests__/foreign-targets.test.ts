/**
 * G (D3 (b)): explicit foreign targets over HTTP. A request that names an enrolled target domain is judged by that
 * target's own registry decision. Its foreignAccess and content denials refuse the request, its read-only access
 * refuses writes aimed at it, and its denied and stripped kinds are removed from that call's projection. An un-enrolled
 * target adds nothing. A breadth query names no target and follows the caller's own policy. The self sentinel "~" is
 * the home. Every refusal asserts that no request reached the fake NetSapiens.
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ContentKind } from '../access/contract.js';
import { getToolCatalogView } from '../access/groups.js';
import { compilePolicy } from '../access/policy.js';
import type { AccessView } from '../access/types.js';
import { createOperationGate, type ForeignTargets } from '../netsapiens/guarded-client.js';
import { ALL_CONTENT_ALLOWED, policyOf, startFake, type FakeNetSapiens } from './support/enforcement-harness.js';
import { allowView, createFakeEnforcer } from './support/fake-access-enforcer.js';
import { connectClient, startMcpHttp, type ConnectedClient, type McpHttp } from './support/mcp-http.js';

const HOME = 'example.com';
const TARGET = 'spooner.example';
const SUMMARY = 'call-intelligence-summary';

const savedStateless = process.env.MCP_STATELESS;
let fake: FakeNetSapiens;
const open: Array<McpHttp | ConnectedClient> = [];

beforeAll(async () => {
  fake = await startFake();
  process.env.MCP_STATELESS = 'false';
});

afterAll(async () => {
  await fake.close();
  if (savedStateless !== undefined) process.env.MCP_STATELESS = savedStateless;
  else delete process.env.MCP_STATELESS;
});

afterEach(async () => {
  while (open.length > 0) await open.pop()!.close();
});

/** A signed-in staff session at HOME, with the home view and the foreign views by tenant. */
async function staff(home: AccessView, foreign: Readonly<Record<string, AccessView>> = {}): Promise<Client> {
  const enforcer = createFakeEnforcer(home);
  for (const [tenant, view] of Object.entries(foreign)) enforcer.setForeign(tenant, view);
  const identities = new Map([['tok-staff', { nsDomain: HOME, nsUser: 'staff', nsScope: 'Office Manager', nsApiUrl: fake.origin }]]);
  const mcp = await startMcpHttp({ enforcer, apiUrl: fake.origin, identities, userIdentity: 'staff', stateless: false });
  open.push(mcp);
  const connected = await connectClient(mcp.url, 'tok-staff');
  open.push(connected);
  return connected.client;
}

const readDomain = (client: Client, domain: string) => client.callTool({ name: 'recent_calls', arguments: { domain } });
const writeDomain = (client: Client, domain: string) =>
  client.callTool({ name: 'call_api', arguments: { tool_name: 'post_domains_by_domain_users_by_user_calls', args: { domain, user: '1001' } } });
const transcriptsOf = (client: Client, domain: string) =>
  client.callTool({ name: 'call_api', arguments: { tool_name: 'get_domains_by_domain_transcriptions', args: { domain } } });

function payloadOf(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

const homeAllowed = (): AccessView => allowView(policyOf(), 'home-1');

describe('G D3 (b) explicit foreign targets over HTTP', () => {
  it('a read-only target refuses a write aimed at it, with zero requests', async () => {
    const client = await staff(homeAllowed(), { [TARGET]: allowView(policyOf({ access: 'read' }), 'target-read') });
    const before = [...fake.requests];
    await expect(writeDomain(client, TARGET)).rejects.toBeInstanceOf(McpError);
    expect(fake.requests).toEqual(before);
  });

  it('a read-only target still serves a read aimed at it', async () => {
    const client = await staff(homeAllowed(), { [TARGET]: allowView(policyOf({ access: 'read' }), 'target-read') });
    const before = fake.requests.length;
    await readDomain(client, TARGET);
    expect(fake.requests.length).toBe(before + 1);
  });

  it('a read-write target lets a write aimed at it reach the fake (control for the refusal above)', async () => {
    const client = await staff(homeAllowed(), { [TARGET]: allowView(policyOf(), 'target-write') });
    const before = fake.requests.length;
    await writeDomain(client, TARGET).catch(() => undefined);
    expect(fake.requests.length).toBe(before + 1);
  });

  it('a target that denies transcript refuses a transcript read aimed at it, with zero requests', async () => {
    const client = await staff(homeAllowed(), { [TARGET]: allowView(policyOf({ content: { ...ALL_CONTENT_ALLOWED, transcript: 'deny' } }), 'target-deny') });
    const before = [...fake.requests];
    await expect(transcriptsOf(client, TARGET)).rejects.toBeInstanceOf(McpError);
    expect(fake.requests).toEqual(before);
  });

  it('the same transcript read reaches the fake when the target allows transcripts (control for the refusal above)', async () => {
    const client = await staff(homeAllowed(), { [TARGET]: allowView(policyOf(), 'target-allow') });
    const before = fake.requests.length;
    await transcriptsOf(client, TARGET).catch(() => undefined);
    expect(fake.requests.length).toBe(before + 1);
  });

  it('a target whose foreignAccess is denied refuses the read, with zero requests', async () => {
    const client = await staff(homeAllowed(), { [TARGET]: { kind: 'deny', reason: 'foreign_access_denied' } });
    const before = [...fake.requests];
    await expect(readDomain(client, TARGET)).rejects.toBeInstanceOf(McpError);
    expect(fake.requests).toEqual(before);
  });

  it('a disabled target tenant refuses the read, with zero requests', async () => {
    const client = await staff(homeAllowed(), { [TARGET]: { kind: 'deny', reason: 'tenant_disabled' } });
    const before = [...fake.requests];
    await expect(readDomain(client, TARGET)).rejects.toBeInstanceOf(McpError);
    expect(fake.requests).toEqual(before);
  });

  it('an unavailable target refuses the read, with zero requests', async () => {
    const client = await staff(homeAllowed(), { [TARGET]: { kind: 'unavailable' } as AccessView });
    const before = [...fake.requests];
    await expect(readDomain(client, TARGET)).rejects.toBeInstanceOf(McpError);
    expect(fake.requests).toEqual(before);
  });

  it('a deny reason this server does not know still refuses the read, with zero requests', async () => {
    const client = await staff(homeAllowed(), { [TARGET]: { kind: 'deny', reason: 'some_future_reason' } });
    const before = [...fake.requests];
    await expect(readDomain(client, TARGET)).rejects.toBeInstanceOf(McpError);
    expect(fake.requests).toEqual(before);
  });

  it('an un-enrolled target adds nothing: the read goes through under the home policy, and keeps the summary', async () => {
    const client = await staff(homeAllowed());
    const before = fake.requests.length;
    const payload = payloadOf(await readDomain(client, TARGET));
    expect(fake.requests.length).toBe(before + 1);
    expect(JSON.stringify(payload)).toContain(SUMMARY);
  });

  it('a target strip removes its kinds from that call only; the home call keeps them', async () => {
    const client = await staff(homeAllowed(), {
      [TARGET]: allowView(policyOf({ content: { ...ALL_CONTENT_ALLOWED, ai_summary: 'strip' } }), 'target-strip'),
    });
    const foreign = payloadOf(await readDomain(client, TARGET));
    expect(JSON.stringify(foreign)).not.toContain(SUMMARY);
    expect(foreign._withheld).toHaveProperty('ai_summary');
    const home = payloadOf(await readDomain(client, HOME));
    expect(JSON.stringify(home)).toContain(SUMMARY);
  });

  it('a target denial of ai_summary strips its fields from a read that is not an ai_summary operation, and does not refuse it', async () => {
    const client = await staff(homeAllowed(), {
      [TARGET]: allowView(policyOf({ content: { ...ALL_CONTENT_ALLOWED, ai_summary: 'deny' } }), 'target-deny-summary'),
    });
    const before = fake.requests.length;
    const payload = payloadOf(await readDomain(client, TARGET));
    expect(fake.requests.length).toBe(before + 1);
    expect(JSON.stringify(payload)).not.toContain(SUMMARY);
    expect(payload._withheld).toHaveProperty('ai_summary');
  });
});

describe('G D3 (b) at the gate: breadth queries and the self sentinel', () => {
  /** A gate whose targets are judged by a recording judge that allows every target. */
  function gateRecording(judged: string[]) {
    const targets: ForeignTargets = {
      home: HOME,
      judge: async (domain) => {
        judged.push(domain);
        return { kind: 'allow' };
      },
    };
    const policy = compilePolicy(policyOf(), getToolCatalogView(), 'rev-breadth');
    return createOperationGate({ policy, targets, foreignStrip: new Set<ContentKind>() });
  }

  it('a breadth query names no target: no target is judged and the caller\'s own policy decides', async () => {
    const judged: string[] = [];
    await gateRecording(judged).admit({ kind: 'v2', method: 'GET', pathTemplate: '/domains', pathParams: undefined, queryParams: undefined });
    expect(judged).toEqual([]);
  });

  it('the self sentinel "~" and an empty domain name no target: neither is judged', async () => {
    const judged: string[] = [];
    const gate = gateRecording(judged);
    await gate.admit({ kind: 'v2', method: 'GET', pathTemplate: '/domains', pathParams: undefined, queryParams: { domain: '~' } });
    await gate.admit({ kind: 'v2', method: 'GET', pathTemplate: '/domains', pathParams: undefined, queryParams: { domain: '' } });
    expect(judged).toEqual([]);
  });
});
