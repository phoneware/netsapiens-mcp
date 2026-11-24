/**
 * The operation guard (spec 3.3 and E8): every NetSapiens request is judged by the operation it performs, whichever
 * tool asks for it. The oracle for the table tests is the content-operation table itself: every key the table lists
 * under a denied kind must be refused, and it must reach the client when the kind is allowed. Refusals assert zero
 * requests at the client (or at the fake NetSapiens for the dispatcher tests).
 */
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getToolCatalogView } from '../access/groups.js';
import { compilePolicy } from '../access/policy.js';
import { CONTENT_OPERATIONS, UNREVIEWED_CONTENT_OPERATIONS } from '../governance/content-operations.js';
import type { ContentKind } from '../governance/types.js';
import { createGuardedClient, createOperationGate, OperationRefusedError } from '../netsapiens/guarded-client.js';
import { NetSapiensClient } from '../netsapiens-client.js';
import { CURATED_CATALOG } from '../tools/curated/catalog.js';
import { textResult, type CuratedTool } from '../tools/curated/types.js';
import { handleToolCall } from '../tools/index.js';
import { ALL_CONTENT_ALLOWED, policyOf, startFake, type FakeNetSapiens } from './support/enforcement-harness.js';

const KINDS = Object.keys(CONTENT_OPERATIONS) as ContentKind[];

/** A client that records every request it is asked to send. The guard must keep the recorded list empty for a refusal. */
function recordingClient(): { client: NetSapiensClient; calls: string[] } {
  const calls: string[] = [];
  const client = {
    async request(opts: { method: string; pathTemplate: string }) {
      calls.push(`${opts.method} ${opts.pathTemplate}`);
      return { success: true };
    },
    async v1Call(object: string, action: string) {
      calls.push(`v1:${object}:${action}`);
      return { success: true };
    },
  };
  return { client: client as unknown as NetSapiensClient, calls };
}

/** The content kinds, one of them denied and every other allowed. */
function denying(denied: ContentKind): Record<ContentKind, 'allow' | 'deny'> {
  const content: Record<ContentKind, 'allow' | 'deny'> = {
    call_recording: 'allow',
    transcript: 'allow',
    voicemail: 'allow',
    sms_text: 'allow',
    ai_summary: 'allow',
    fax_page: 'allow',
  };
  content[denied] = 'deny';
  return content;
}

function gateFor(content: Record<ContentKind, 'allow' | 'deny'>) {
  const policy = compilePolicy(policyOf({ content }), getToolCatalogView(), 'rev-e8');
  return createOperationGate({ policy, foreignStrip: new Set<ContentKind>() });
}

/** Issues the request a table key names, with placeholder values, through a guarded client. */
async function issue(guarded: NetSapiensClient, key: string): Promise<unknown> {
  if (key.startsWith('v1:')) {
    const [, object, action] = key.split(':');
    return guarded.v1Call(object, action, {});
  }
  const [method, path] = key.split(' ');
  let index = 0;
  const pathTemplate = path.replace(/\{\}/g, () => `{p${index++}}`);
  const pathParams = Object.fromEntries(Array.from({ length: index }, (_, i) => [`p${i}`, 'x']));
  return guarded.request({ method, pathTemplate, pathParams });
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
}

/** Test-only tools. Their operations lists are empty, so the tool filter allows them and only the guard can refuse. */
const PROBES: CuratedTool[] = [
  {
    operations: [],
    minRole: 'user',
    schema: {
      name: 'probe_content_template',
      description: 'Test only: sends a templated request.',
      inputSchema: { type: 'object', additionalProperties: true },
    },
    targets: {},
    output: { rules: [] },
    handler: async (args, client) =>
      textResult(await client.request({
        method: 'GET',
        pathTemplate: String(args.template),
        pathParams: stringRecord(args.pathParams),
      })),
  },
  {
    operations: [],
    minRole: 'user',
    schema: {
      name: 'probe_v1_call',
      description: 'Test only: sends a v1 call.',
      inputSchema: { type: 'object', additionalProperties: true },
    },
    targets: {},
    output: { rules: [] },
    handler: async (args, client) => {
      const caller = client as unknown as { v1Call(object: string, action: string, params: Record<string, unknown>): Promise<unknown> };
      return textResult(await caller.v1Call(String(args.object), String(args.action), {}));
    },
  },
];

beforeAll(() => {
  CURATED_CATALOG.push(...PROBES);
});

afterAll(() => {
  for (const probe of PROBES) {
    const index = CURATED_CATALOG.indexOf(probe);
    if (index !== -1) CURATED_CATALOG.splice(index, 1);
  }
});

describe('E8 the gate refuses every content operation whose kind is denied (table oracle)', () => {
  for (const kind of KINDS) {
    it.each(Object.keys(CONTENT_OPERATIONS[kind]))(`refuses %s under a denied ${kind}, with zero requests, and sends it when allowed`, async (key) => {
      const refusedRaw = recordingClient();
      await expect(issue(createGuardedClient(refusedRaw.client, undefined, { gate: gateFor(denying(kind)) }), key)).rejects.toBeInstanceOf(
        OperationRefusedError,
      );
      expect(refusedRaw.calls).toEqual([]);

      const allowedRaw = recordingClient();
      await issue(createGuardedClient(allowedRaw.client, undefined, { gate: gateFor({ ...ALL_CONTENT_ALLOWED }) }), key);
      expect(allowedRaw.calls.length).toBe(1);
    });
  }

  it.each(Object.keys(UNREVIEWED_CONTENT_OPERATIONS))('refuses the unreviewed %s under any single denied kind, with zero requests', async (key) => {
    for (const kind of KINDS) {
      const raw = recordingClient();
      await expect(issue(createGuardedClient(raw.client, undefined, { gate: gateFor(denying(kind)) }), key)).rejects.toBeInstanceOf(
        OperationRefusedError,
      );
      expect(raw.calls).toEqual([]);
    }
  });
});

describe('E7 and E8 through the dispatcher and the fake NetSapiens', () => {
  let fake: FakeNetSapiens;
  beforeAll(async () => {
    fake = await startFake();
  });
  afterAll(async () => {
    await fake.close();
  });

  const home = { home: 'example.com', judge: async () => ({ kind: 'allow' as const }) };

  it('refuses a test-only tool that requests a denied operation, and the fake sees no request', async () => {
    const policy = compilePolicy(policyOf({ content: denying('transcript') }), getToolCatalogView(), 'rev-e8-d');
    const client = new NetSapiensClient({ apiUrl: fake.origin, apiToken: 'test-token' });
    const before = fake.requests.length;
    await expect(
      handleToolCall(
        client,
        'probe_content_template',
        { template: '/domains/{domain}/transcriptions', pathParams: { domain: 'example.com' } },
        'domain_admin',
        'alice',
        undefined,
        policy,
        home,
      ),
    ).rejects.toBeInstanceOf(McpError);
    expect(fake.requests.length).toBe(before);
  });

  it('refuses a v1 audio:play through call_api with zero requests to /ns-api/', async () => {
    const policy = compilePolicy(policyOf({ content: denying('call_recording') }), getToolCatalogView(), 'rev-e8-v');
    const client = new NetSapiensClient({ apiUrl: fake.origin, apiToken: 'test-token' });
    const before = fake.requests.length;
    await expect(
      handleToolCall(
        client,
        'call_api',
        {
          tool_name: 'v1_audio_play',
          args: { domain: 'example.com', user: '1001', type: 'greeting', file: 'a', index: '1', time: '1', auth: 'x' },
        },
        'domain_admin',
        'alice',
        undefined,
        policy,
        home,
      ),
    ).rejects.toBeInstanceOf(McpError);
    expect(fake.requests.filter((request) => request.path === '/ns-api/').length).toBe(0);
    expect(fake.requests.length).toBe(before);
  });

  it('refuses a content operation reached through the v1 path, with zero requests to /ns-api/', async () => {
    const policy = compilePolicy(policyOf({ content: denying('transcript') }), getToolCatalogView(), 'rev-e8-w');
    const client = new NetSapiensClient({ apiUrl: fake.origin, apiToken: 'test-token' });
    const before = fake.requests.length;
    await expect(
      handleToolCall(client, 'probe_v1_call', { object: 'cdrexport', action: 'read' }, 'domain_admin', 'alice', undefined, policy, home),
    ).rejects.toBeInstanceOf(McpError);
    expect(fake.requests.filter((request) => request.path === '/ns-api/').length).toBe(0);
    expect(fake.requests.length).toBe(before);
  });
});
