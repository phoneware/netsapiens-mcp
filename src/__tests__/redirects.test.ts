/**
 * P1, registry mode: a redirect is never followed. The gate judges the operation a request names, so an answer that points
 * elsewhere would reach an operation nobody admitted. Every registry request is sent with redirects refused, a 3xx answer
 * is an error, and the target sees no request. Unset mode still follows redirects, and the unset tests pin that. Each
 * assertion reads the fake's request log: the first hop is recorded, and the target is not.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getToolCatalogView } from '../access/groups.js';
import { ALLOW_ALL, compilePolicy } from '../access/policy.js';
import { NetSapiensClient } from '../netsapiens-client.js';
import { CURATED_CATALOG } from '../tools/curated/catalog.js';
import { textResult, type CuratedTool } from '../tools/curated/types.js';
import { handleToolCall } from '../tools/index.js';
import { policyOf, startFake, textOf, type FakeNetSapiens } from './support/enforcement-harness.js';

const HOME = { home: 'example.com', judge: async () => ({ kind: 'allow' as const }) };
const TARGET = '/ns-api/v2/domains/example.com/users/1001/voicemails/new/vm-1';
const PROBE = '/ns-api/v2/domains/example.com/users/1001/redirect-probe';
const MULTIPART_PROBE = '/ns-api/v2/domains/example.com/redirect-probe';
const UNAUTHORIZED_GATE = '/ns-api/v2/domains/example.com/redirect-probe-401-gate';
const UNAUTHORIZED_UNSET = '/ns-api/v2/domains/example.com/redirect-probe-401-unset';
const MEDIA = 'vm-1.wav';

/** Test-only tools. Their operation lists are empty, so the tool filter allows them and only the gate and the client decide. */
const PROBES: CuratedTool[] = [
  {
    operations: [],
    minRole: 'user',
    schema: {
      name: 'probe_request',
      description: 'Test only: sends a v2 request, optionally as multipart.',
      inputSchema: { type: 'object', additionalProperties: true },
    },
    targets: {},
    output: { rules: [] },
    handler: async (args, client) =>
      textResult(
        await client.request({
          method: String(args.method),
          pathTemplate: String(args.pathTemplate),
          pathParams: args.pathParams as Record<string, string> | undefined,
          body: args.body,
          multipart: args.multipart as { field: string; filename: string; base64: string; contentType?: string } | undefined,
        }),
      ),
  },
  {
    operations: [],
    minRole: 'user',
    schema: {
      name: 'probe_v1',
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

let fake: FakeNetSapiens;

beforeAll(async () => {
  CURATED_CATALOG.push(...PROBES);
  fake = await startFake();
});

afterAll(async () => {
  for (const probe of PROBES) {
    const index = CURATED_CATALOG.indexOf(probe);
    if (index !== -1) CURATED_CATALOG.splice(index, 1);
  }
  await fake.close();
});

const gated = () => compilePolicy(policyOf(), getToolCatalogView(), 'rev-p1');
const plainClient = () => new NetSapiensClient({ apiUrl: fake.origin, apiToken: 'test-token' });
const retryingClient = () => new NetSapiensClient({ apiUrl: fake.origin, apiToken: 'test-token', onUnauthorized: async () => undefined });

/** The paths the fake received since the mark, in order. */
const since = (mark: number): string[] => fake.requests.slice(mark).map((request) => request.path);

const PROBE_ARGS = { method: 'GET', pathTemplate: '/domains/{domain}/users/{user}/redirect-probe', pathParams: { domain: 'example.com', user: '1001' } };

describe('P1 registry mode: a redirect is never followed', () => {
  it('a GET answered by a 302 is refused under the gate: the target sees no request and the result carries no media', async () => {
    const mark = fake.requests.length;
    const result = await handleToolCall(plainClient(), 'probe_request', PROBE_ARGS, 'domain_admin', 'alice', undefined, gated(), HOME);
    expect(JSON.parse(textOf(result))).toMatchObject({ success: false });
    expect(textOf(result)).not.toContain(MEDIA);
    expect(since(mark)).toEqual([PROBE]);
  });

  it('a multipart POST answered by a 307 is not replayed to its target under the gate', async () => {
    const mark = fake.requests.length;
    const args = {
      method: 'POST',
      pathTemplate: '/domains/{domain}/redirect-probe',
      pathParams: { domain: 'example.com' },
      body: { name: 'hold' },
      multipart: { field: 'file', filename: 'hold.wav', base64: 'AAAA', contentType: 'audio/wav' },
    };
    const result = await handleToolCall(plainClient(), 'probe_request', args, 'domain_admin', 'alice', undefined, gated(), HOME);
    expect(JSON.parse(textOf(result))).toMatchObject({ success: false });
    expect(since(mark)).toEqual([MULTIPART_PROBE]);
  });

  it('a v1 call answered by a 302 is refused under the gate: the POST is not turned into a GET at the target', async () => {
    const mark = fake.requests.length;
    const result = await handleToolCall(plainClient(), 'probe_v1', { object: 'redirect_probe', action: 'read' }, 'domain_admin', 'alice', undefined, gated(), HOME);
    expect(JSON.parse(textOf(result))).toMatchObject({ success: false });
    expect(textOf(result)).not.toContain(MEDIA);
    expect(since(mark)).toEqual(['/ns-api/']);
  });

  it('a v1 call answered by a 307 is refused under the gate: the POST is not replayed to the target', async () => {
    const mark = fake.requests.length;
    const result = await handleToolCall(plainClient(), 'probe_v1', { object: 'redirect_probe_307', action: 'read' }, 'domain_admin', 'alice', undefined, gated(), HOME);
    expect(JSON.parse(textOf(result))).toMatchObject({ success: false });
    expect(since(mark)).toEqual(['/ns-api/']);
  });

  it('a 401 whose retry is answered by a 302 is not followed under the gate: the retry is the last request', async () => {
    const mark = fake.requests.length;
    const args = { method: 'GET', pathTemplate: '/domains/{domain}/redirect-probe-401-gate', pathParams: { domain: 'example.com' } };
    const result = await handleToolCall(retryingClient(), 'probe_request', args, 'domain_admin', 'alice', undefined, gated(), HOME);
    expect(JSON.parse(textOf(result))).toMatchObject({ success: false });
    expect(textOf(result)).not.toContain(MEDIA);
    expect(since(mark)).toEqual([UNAUTHORIZED_GATE, UNAUTHORIZED_GATE]);
  });
});

describe('P1 unset mode and ALLOW_ALL: redirects are still followed, as they always were', () => {
  it('the same GET is followed in unset mode, and the target is reached', async () => {
    const mark = fake.requests.length;
    const result = await handleToolCall(plainClient(), 'probe_request', PROBE_ARGS, 'domain_admin', 'alice');
    expect(textOf(result)).toContain(MEDIA);
    expect(since(mark)).toEqual([PROBE, TARGET]);
  });

  it('ALLOW_ALL is not gated, so its redirects are followed as unset mode follows them', async () => {
    const mark = fake.requests.length;
    const result = await handleToolCall(plainClient(), 'probe_request', PROBE_ARGS, 'domain_admin', 'alice', undefined, ALLOW_ALL, HOME);
    expect(textOf(result)).toContain(MEDIA);
    expect(since(mark)).toEqual([PROBE, TARGET]);
  });

  it('a v1 call answered by a 302 is followed in unset mode, and the target is reached', async () => {
    const mark = fake.requests.length;
    const result = await handleToolCall(plainClient(), 'probe_v1', { object: 'redirect_probe', action: 'read' }, 'domain_admin', 'alice');
    expect(textOf(result)).toContain(MEDIA);
    expect(since(mark)).toEqual(['/ns-api/', TARGET]);
  });

  it('a 401 whose retry is answered by a 302 is followed in unset mode, and the target is reached', async () => {
    const mark = fake.requests.length;
    const args = { method: 'GET', pathTemplate: '/domains/{domain}/redirect-probe-401-unset', pathParams: { domain: 'example.com' } };
    const result = await handleToolCall(retryingClient(), 'probe_request', args, 'domain_admin', 'alice');
    expect(textOf(result)).toContain(MEDIA);
    expect(since(mark)).toEqual([UNAUTHORIZED_UNSET, UNAUTHORIZED_UNSET, TARGET]);
  });
});
