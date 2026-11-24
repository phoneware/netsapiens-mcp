/**
 * Path parameters must not move a request off the endpoint its operation key names (review finding on slice B).
 *
 * encodeURIComponent leaves "." alone, so a value of ".." reaches the URL as a dot segment, and axios's new URL()
 * removes it. The operation key then names one endpoint while the request reaches another: servicecode/../transcriptions
 * is keyed as a servicecode read and sent as a transcription read. Registry mode refuses such values in the operation
 * guard before any request is sent. Unset mode refuses only the values that can never name a resource (empty and
 * dot segments). Every other unset request is sent as before, which the battery below pins.
 *
 * Every refusal asserts zero requests at the fake NetSapiens: fake.requests logs each request before it is routed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { startFakeNetSapiens } from '../../scripts/fake-netsapiens/index.mjs';
import type { AccessPolicyV1 } from '../access/contract.js';
import { getToolCatalogView } from '../access/groups.js';
import { compilePolicy, type CompiledPolicy } from '../access/policy.js';
import { NetSapiensClient } from '../netsapiens-client.js';
import { CURATED_CATALOG } from '../tools/curated/catalog.js';
import { textResult, type CuratedTool } from '../tools/curated/types.js';
import { handleToolCall } from '../tools/index.js';
import { isRecord } from '../utils/records.js';

interface FakeRequest {
  method: string;
  path: string;
  query: Record<string, string | string[]>;
  body: unknown;
  hasAuth: boolean;
  headers: Record<string, unknown>;
}

interface FakeNetSapiens {
  readonly origin: string;
  readonly requests: FakeRequest[];
  close(): Promise<void>;
}

const active: FakeNetSapiens[] = [];

afterEach(async () => {
  while (active.length > 0) await active.pop()!.close();
});

/** The probes receive arguments as JSON; a record keeps its keys and stringifies its values, as the client does. */
function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
}

interface V1Caller {
  v1Call(object: string, action: string, params: Record<string, unknown>): Promise<unknown>;
}

/** Two test-only tools that hand their arguments straight to the client, so a test controls the exact request. */
const PROBES: CuratedTool[] = [
  {
    operations: [],
    minRole: 'user',
    schema: {
      name: 'probe_template',
      description: 'Test only: sends a templated request built from its arguments.',
      inputSchema: { type: 'object', additionalProperties: true },
    },
    targets: {},
    output: { rules: [] },
    handler: async (args, client) => {
      const result = await client.request({
        method: 'GET',
        pathTemplate: String(args.template),
        pathParams: stringRecord(args.pathParams),
      });
      return textResult(result);
    },
  },
  {
    operations: [],
    minRole: 'user',
    schema: {
      name: 'probe_v1',
      description: 'Test only: sends a v1 call built from its arguments.',
      inputSchema: { type: 'object', additionalProperties: true },
    },
    targets: {},
    output: { rules: [] },
    handler: async (args, client) => {
      // The generated v1 handlers reach v1Call through this same cast; the probe has no typed v1 surface.
      const caller = client as unknown as V1Caller;
      const result = await caller.v1Call(String(args.object), String(args.action), isRecord(args.params) ? args.params : {});
      return textResult(result);
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

const CONTENT_DENIED = {
  call_recording: 'deny',
  transcript: 'deny',
  voicemail: 'deny',
  sms_text: 'deny',
  ai_summary: 'deny',
  fax_page: 'deny',
} as const;

/** An enforcing registry policy: every tool allowed, every content kind denied, unclassified output allowed. */
function enforcing(): CompiledPolicy {
  const policy: AccessPolicyV1 = {
    tools: { allow: ['*'], deny: [] },
    access: 'write',
    content: { ...CONTENT_DENIED },
    unclassifiedOutput: 'allow',
    platforms: ['*'],
  };
  return compilePolicy(policy, getToolCatalogView(), 'rev-path-1');
}

/** Foreign-target judgement for a request whose explicit domain is the caller's own: nothing to judge. */
function homeTargets(home: string) {
  return { home, judge: async () => ({ kind: 'allow' as const }) };
}

async function setup(): Promise<{ fake: FakeNetSapiens; client: NetSapiensClient }> {
  const fake = await startFakeNetSapiens({ apiVersion: '44.4.10' });
  active.push(fake);
  const client = new NetSapiensClient({ apiUrl: fake.origin, apiToken: 'test-token' });
  return { fake, client };
}

/** The text of a single-block tool result. Anything else fails the test rather than being read loosely. */
function textOf(result: unknown): string {
  if (isRecord(result) && Array.isArray(result.content)) {
    const first: unknown = result.content[0];
    if (isRecord(first) && typeof first.text === 'string') return first.text;
  }
  throw new Error('expected a single text block');
}

/** The reviewer's demo tool, called with the given path values, under the caller's own domain. */
function servicecode(domain: string, type: string, code: string) {
  return { tool: 'read_domain_service_code', args: { domain, type, code }, targets: homeTargets(domain) };
}

describe('registry mode: path values are refused before any request', () => {
  it('refuses the reviewer demo ".." that reaches the transcriptions endpoint from a servicecode read', async () => {
    const { fake, client } = await setup();
    const before = fake.requests.length;
    const call = servicecode('clinic.example', '..', 'transcriptions');
    await expect(
      handleToolCall(client as never, call.tool, call.args, 'domain_admin', 'alice', undefined, enforcing(), call.targets as never),
    ).rejects.toBeInstanceOf(McpError);
    expect(fake.requests.length).toBe(before);
  });

  it('refuses the reviewer demo that reaches the insight endpoint from a holiday lookup', async () => {
    const { fake, client } = await setup();
    const before = fake.requests.length;
    await expect(
      handleToolCall(
        client as never,
        'get_holidays_by_country_by_region_by_year',
        { country: '..', region: 'insight', year: 'active_alerts' },
        'domain_admin',
        'alice',
        undefined,
        enforcing(),
        homeTargets('example.com') as never,
      ),
    ).rejects.toBeInstanceOf(McpError);
    expect(fake.requests.length).toBe(before);
  });

  it.each([
    ['%2e%2e', 'lowercase percent-encoded double dot'],
    ['%2E%2E', 'uppercase percent-encoded double dot'],
    ['..%2f', 'double dot with an encoded slash'],
    ['.%2e', 'mixed encoded and literal double dot'],
  ])('refuses the encoded dot value %s (%s) before any request', async (type) => {
    const { fake, client } = await setup();
    const before = fake.requests.length;
    const call = servicecode('clinic.example', type, 'transcriptions');
    await expect(
      handleToolCall(client as never, call.tool, call.args, 'domain_admin', 'alice', undefined, enforcing(), call.targets as never),
    ).rejects.toBeInstanceOf(McpError);
    expect(fake.requests.length).toBe(before);
  });

  it('refuses an empty path value before any request', async () => {
    const { fake, client } = await setup();
    const before = fake.requests.length;
    const call = servicecode('clinic.example', '', 'transcriptions');
    await expect(
      handleToolCall(client as never, call.tool, call.args, 'domain_admin', 'alice', undefined, enforcing(), call.targets as never),
    ).rejects.toBeInstanceOf(McpError);
    expect(fake.requests.length).toBe(before);
  });

  it.each([
    ['a/b', 'a forward slash'],
    ['a\\b', 'a backslash'],
    ['a%2Fb', 'an encoded forward slash'],
    ['a%5Cb', 'an encoded backslash'],
    ['a\u0001b', 'a control character'],
    ['a\u007fb', 'a DEL character'],
  ])('refuses a path value holding %s (%s) before any request', async (type) => {
    const { fake, client } = await setup();
    const before = fake.requests.length;
    const call = servicecode('clinic.example', type, 'transcriptions');
    await expect(
      handleToolCall(client as never, call.tool, call.args, 'domain_admin', 'alice', undefined, enforcing(), call.targets as never),
    ).rejects.toBeInstanceOf(McpError);
    expect(fake.requests.length).toBe(before);
  });

  it('refuses a template whose own literal segments collapse, although every value is harmless', async () => {
    const { fake, client } = await setup();
    const before = fake.requests.length;
    await expect(
      handleToolCall(
        client as never,
        'probe_template',
        { template: '/domains/{domain}/../{x}', pathParams: { domain: 'a', x: 'b' } },
        'domain_admin',
        'alice',
        undefined,
        enforcing(),
        homeTargets('a') as never,
      ),
    ).rejects.toBeInstanceOf(McpError);
    expect(fake.requests.length).toBe(before);
  });

  it('refuses a v1 call whose params would replace the object or action it was keyed on', async () => {
    const { fake, client } = await setup();
    const before = fake.requests.length;
    await expect(
      handleToolCall(
        client as never,
        'probe_v1',
        { object: 'domain', action: 'read', params: { action: 'play', object: 'audio', domain: 'example.com' } },
        'domain_admin',
        'alice',
        undefined,
        enforcing(),
        homeTargets('example.com') as never,
      ),
    ).rejects.toBeInstanceOf(McpError);
    expect(fake.requests.filter((r) => r.path === '/ns-api/').length).toBe(0);
    expect(fake.requests.length).toBe(before);
  });

  it.each([
    ['example.com', '1001', 'a.b..c'],
    ['example.com', '...', '.hidden'],
    ['example.com', '1001', 'x..'],
  ])('lets legitimate values that contain dots through: %s / %s / %s', async (domain, type, code) => {
    const { fake, client } = await setup();
    const call = servicecode(domain, type, code);
    await handleToolCall(client as never, call.tool, call.args, 'domain_admin', 'alice', undefined, enforcing(), call.targets as never);
    expect(fake.requests.at(-1)?.path).toBe(`/ns-api/v2/domains/${domain}/servicecode/${type}/${code}`);
  });
});

describe('unset mode: only values that can never name a resource are refused', () => {
  it('refuses the reviewer demo ".." before any request, without any policy', async () => {
    const { fake, client } = await setup();
    const before = fake.requests.length;
    const result = await handleToolCall(client as never, 'read_domain_service_code', {
      domain: 'clinic.example',
      type: '..',
      code: 'transcriptions',
    }, 'domain_admin', 'alice');
    expect(fake.requests.length).toBe(before);
    const body: unknown = JSON.parse(textOf(result));
    expect(isRecord(body) && body.success === false).toBe(true);
    expect(isRecord(body) && typeof body.error === 'string' && /not sent/.test(body.error)).toBe(true);
  });

  it('refuses the holiday demo before any request, without any policy', async () => {
    const { fake, client } = await setup();
    const before = fake.requests.length;
    await handleToolCall(client as never, 'get_holidays_by_country_by_region_by_year', {
      country: '..',
      region: 'insight',
      year: 'active_alerts',
    }, 'domain_admin', 'alice');
    expect(fake.requests.length).toBe(before);
  });

  it.each(['%2e%2e', '%2E%2E', '.%2e'])('refuses the encoded dot value %s before any request, without any policy', async (type) => {
    const { fake, client } = await setup();
    const before = fake.requests.length;
    await handleToolCall(client as never, 'read_domain_service_code', {
      domain: 'clinic.example',
      type,
      code: 'transcriptions',
    }, 'domain_admin', 'alice');
    expect(fake.requests.length).toBe(before);
  });

  it('refuses an empty value before any request, without any policy', async () => {
    const { fake, client } = await setup();
    const before = fake.requests.length;
    await handleToolCall(client as never, 'read_domain_service_code', {
      domain: 'clinic.example',
      type: '',
      code: 'transcriptions',
    }, 'domain_admin', 'alice');
    expect(fake.requests.length).toBe(before);
  });

  it.each([
    ['a/b', 'a%2Fb'],
    ['a\\b', 'a%5Cb'],
    ['a\u0001b', 'a%01b'],
    ['100%', '100%25'],
    ['..%2f', '..%252f'],
  ])('sends the value %j exactly as before (encoded as %s) without any policy', async (type, encoded) => {
    const { fake, client } = await setup();
    await handleToolCall(client as never, 'read_domain_service_code', {
      domain: 'example.com',
      type,
      code: 'c',
    }, 'domain_admin', 'alice');
    expect(fake.requests.at(-1)?.path).toBe(`/ns-api/v2/domains/example.com/servicecode/${encoded}/c`);
  });

  /**
   * The unset request battery: each call's request path is pinned, and the same values under an enforcing
   * registry policy are sent to the same paths. A registry-mode request differs from unset only by refusal.
   */
  const BATTERY: Array<{ tool: string; domain: string; args: Record<string, unknown>; path: string }> = [
    {
      tool: 'read_domain_service_code',
      domain: 'example.com',
      args: { domain: 'example.com', type: '1001', code: 'a.b..c' },
      path: '/ns-api/v2/domains/example.com/servicecode/1001/a.b..c',
    },
    {
      tool: 'read_domain_service_code',
      domain: 'example.com',
      args: { domain: 'example.com', type: '...', code: '.hidden' },
      path: '/ns-api/v2/domains/example.com/servicecode/.../.hidden',
    },
    {
      tool: 'get_holidays_by_country_by_region_by_year',
      domain: 'example.com',
      args: { country: 'us', region: 'ca', year: '2026' },
      path: '/ns-api/v2/holidays/us/ca/2026',
    },
    {
      tool: 'get_domains_by_domain_users_by_user_cdrs',
      domain: 'example.com',
      args: { domain: 'example.com', user: '1001' },
      path: '/ns-api/v2/domains/example.com/users/1001/cdrs',
    },
  ];

  it.each(BATTERY.map((call) => [call.tool, call] as const))('keeps the unset request path for %s', async (_tool, call) => {
    const { fake, client } = await setup();
    await handleToolCall(client as never, call.tool, call.args, 'domain_admin', 'alice');
    expect(fake.requests.at(-1)?.path).toBe(call.path);
  });

  it.each(BATTERY.map((call) => [call.tool, call] as const))('sends the same path in registry mode as unset: %s', async (_tool, call) => {
    const { fake, client } = await setup();
    await handleToolCall(client as never, call.tool, call.args, 'domain_admin', 'alice', undefined, enforcing(), homeTargets(call.domain) as never);
    expect(fake.requests.at(-1)?.path).toBe(call.path);
  });
});
