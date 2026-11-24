/**
 * ALLOW_ALL is what an unconfigured deployment behaves as, so it must produce the unset surface: the same tool list in
 * both modes and the same tool outputs. It is compared by identity, so it gets no operation gate and no projection
 * (decision recorded for slice E). A compiled policy that allows everything but is not the ALLOW_ALL object is an
 * enforced policy, and its projection removes internal fields; a test pins that difference.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getToolCatalogView } from '../access/groups.js';
import { ALLOW_ALL, compilePolicy } from '../access/policy.js';
import { NetSapiensClient } from '../netsapiens-client.js';
import { getAllToolDefinitions, handleToolCall } from '../tools/index.js';
import { policyOf, startFake, type FakeNetSapiens } from './support/enforcement-harness.js';

const savedMode = process.env.MCP_TOOL_MODE;
let fake: FakeNetSapiens;
const HOME = { home: 'example.com', judge: async () => ({ kind: 'allow' as const }) };

beforeAll(async () => {
  fake = await startFake();
});

afterAll(async () => {
  await fake.close();
  if (savedMode !== undefined) process.env.MCP_TOOL_MODE = savedMode;
  else delete process.env.MCP_TOOL_MODE;
});

afterEach(() => {
  if (savedMode !== undefined) process.env.MCP_TOOL_MODE = savedMode;
  else delete process.env.MCP_TOOL_MODE;
});

/** The tools a deployment exposes to a caller: the same calls the unset path makes, with and without ALLOW_ALL. */
const CALLS: Array<{ name: string; args: Record<string, unknown> }> = [
  { name: 'recent_calls', args: { domain: 'example.com' } },
  { name: 'get_holidays_by_country_by_region_by_year', args: { country: 'us', region: 'ca', year: '2026' } },
  { name: 'read_domain_service_code', args: { domain: 'example.com', type: '1001', code: 'a.b..c' } },
];

describe('ALLOW_ALL produces the unset surface', () => {
  for (const mode of ['curated', 'full']) {
    for (const role of [undefined, 'system_admin'] as const) {
      it(`lists the same tools as the unset path in ${mode} mode for role ${role ?? 'undefined'}`, async () => {
        process.env.MCP_TOOL_MODE = mode;
        const unset = await getAllToolDefinitions(role, undefined, undefined);
        const allowAll = await getAllToolDefinitions(role, undefined, undefined, ALLOW_ALL);
        expect(allowAll).toEqual(unset);
      });
    }
  }

  it.each(CALLS.map((call) => [call.name, call] as const))('returns the same output as the unset path for %s', async (_name, call) => {
    const client = new NetSapiensClient({ apiUrl: fake.origin, apiToken: 'test-token' });
    const unset = await handleToolCall(client, call.name, call.args, 'domain_admin', 'alice');
    const allowAll = await handleToolCall(client, call.name, call.args, 'domain_admin', 'alice', undefined, ALLOW_ALL, HOME);
    expect(allowAll).toEqual(unset);
  });

  it('keeps the internal field under ALLOW_ALL, as the unset path does', async () => {
    const client = new NetSapiensClient({ apiUrl: fake.origin, apiToken: 'test-token' });
    const allowAll = await handleToolCall(client, 'recent_calls', { domain: 'example.com' }, 'domain_admin', 'alice', undefined, ALLOW_ALL, HOME);
    expect(JSON.stringify(allowAll)).toContain('prefilled-transcription-api');
  });

  it('enforces a compiled allow-everything policy that is not the ALLOW_ALL object: it removes the internal field', async () => {
    const client = new NetSapiensClient({ apiUrl: fake.origin, apiToken: 'test-token' });
    const compiled = compilePolicy(policyOf(), getToolCatalogView(), 'rev-allow-everything');
    const enforced = await handleToolCall(client, 'recent_calls', { domain: 'example.com' }, 'domain_admin', 'alice', undefined, compiled, HOME);
    expect(JSON.stringify(enforced)).not.toContain('prefilled-transcription-api');
  });
});
