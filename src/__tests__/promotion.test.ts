/**
 * Tests for per-user tool promotion: usage tracking, threshold-based
 * promotion, and the catalog including promoted tools.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { InMemoryUsageStore, _resetUsageStoreForTests } from '../tools/promotion/usage-store.js';

function clearEnv() {
  delete process.env.MCP_TOOL_MODE;
  delete process.env.MCP_DISABLED_TOOLS;
  delete process.env.MCP_DISABLED_ACTIONS;
  delete process.env.MCP_DISABLE_DESTRUCTIVE;
  delete process.env.MCP_DISABLE_ROLE_FILTER;
  delete process.env.MCP_DISABLE_PROMOTION;
  delete process.env.MCP_PROMOTE_THRESHOLD;
  delete process.env.MCP_PROMOTE_WINDOW_DAYS;
}

async function importTools() {
  vi.resetModules();
  _resetUsageStoreForTests(new InMemoryUsageStore());
  return import('../tools/index.js');
}

describe('promotion', () => {
  beforeEach(() => {
    clearEnv();
    process.env.MCP_PROMOTE_THRESHOLD = '2'; // make tests fast
  });

  it('does NOT promote a tool until it crosses the threshold', async () => {
    const { getAllToolDefinitions } = await importTools();
    const before = await getAllToolDefinitions('domain_admin', 'alice');
    expect(before.find((t) => t.name === 'get_devices')).toBeUndefined();
  });

  it('promotes a tool once the user calls it through call_api enough times', async () => {
    const { registerAllTools, getAllToolDefinitions } = await importTools();
    const handlers = new Map<unknown, (req: unknown) => Promise<unknown>>();
    const server = {
      setRequestHandler: (s: unknown, h: (req: unknown) => Promise<unknown>) => handlers.set(s, h),
      sendToolListChanged: vi.fn(async () => {}),
    } as never;
    const fakeClient = { request: async () => ({ success: true, data: {} }) };

    registerAllTools(server, fakeClient as never, 'domain_admin', 'alice');
    const callHandler = handlers.get(CallToolRequestSchema) as (req: unknown) => Promise<unknown>;

    // Invoke a long-tail tool via call_api twice (threshold = 2).
    await callHandler({ params: { name: 'call_api', arguments: { tool_name: 'get_devices', args: {} } } });
    await callHandler({ params: { name: 'call_api', arguments: { tool_name: 'get_devices', args: {} } } });

    const tools = await getAllToolDefinitions('domain_admin', 'alice');
    const promoted = tools.find((t) => t.name === 'get_devices');
    expect(promoted).toBeDefined();
    expect(promoted!.description).toMatch(/^\[promoted\]/);
  });

  it('sends sendToolListChanged exactly once — on the call that crosses the threshold', async () => {
    const { registerAllTools } = await importTools();
    const handlers = new Map<unknown, (req: unknown) => Promise<unknown>>();
    const sendToolListChanged = vi.fn(async () => {});
    const server = {
      setRequestHandler: (s: unknown, h: (req: unknown) => Promise<unknown>) => handlers.set(s, h),
      sendToolListChanged,
    } as never;
    const fakeClient = { request: async () => ({ success: true, data: {} }) };

    registerAllTools(server, fakeClient as never, 'domain_admin', 'bob');
    const callHandler = handlers.get(CallToolRequestSchema) as (req: unknown) => Promise<unknown>;

    await callHandler({ params: { name: 'call_api', arguments: { tool_name: 'get_devices', args: {} } } });
    expect(sendToolListChanged).not.toHaveBeenCalled();

    await callHandler({ params: { name: 'call_api', arguments: { tool_name: 'get_devices', args: {} } } });
    expect(sendToolListChanged).toHaveBeenCalledOnce();

    // A third call is past the threshold — no further notifications fire.
    await callHandler({ params: { name: 'call_api', arguments: { tool_name: 'get_devices', args: {} } } });
    expect(sendToolListChanged).toHaveBeenCalledOnce();
  });

  it('promotion respects MCP_DISABLED_TOOLS (a disabled tool never gets promoted)', async () => {
    process.env.MCP_DISABLED_TOOLS = 'get_devices';
    const { registerAllTools, getAllToolDefinitions } = await importTools();
    const handlers = new Map<unknown, (req: unknown) => Promise<unknown>>();
    const server = {
      setRequestHandler: (s: unknown, h: (req: unknown) => Promise<unknown>) => handlers.set(s, h),
      sendToolListChanged: vi.fn(async () => {}),
    } as never;
    const fakeClient = { request: async () => ({ success: true, data: {} }) };

    registerAllTools(server, fakeClient as never, 'domain_admin', 'carol');
    const callHandler = handlers.get(CallToolRequestSchema) as (req: unknown) => Promise<unknown>;

    // call_api against a disabled tool would already reject, but even if we
    // could record the calls, the catalog must still hide it. Bypass the
    // record path by calling the promotion module directly:
    const { recordCallApiInvocation } = await import('../tools/promotion/index.js');
    await recordCallApiInvocation('carol', 'get_devices');
    await recordCallApiInvocation('carol', 'get_devices');

    const tools = await getAllToolDefinitions('domain_admin', 'carol');
    expect(tools.find((t) => t.name === 'get_devices')).toBeUndefined();
  });

  it('promotion respects MCP_DISABLE_DESTRUCTIVE (a destructive tool stays hidden even with high usage)', async () => {
    process.env.MCP_DISABLE_DESTRUCTIVE = 'true';
    const { getAllToolDefinitions } = await importTools();
    const { recordCallApiInvocation } = await import('../tools/promotion/index.js');
    // Pick a real destructive generated tool — delete_address_for_domain
    await recordCallApiInvocation('dan', 'delete_address_for_domain');
    await recordCallApiInvocation('dan', 'delete_address_for_domain');

    const tools = await getAllToolDefinitions('domain_admin', 'dan');
    expect(tools.find((t) => t.name === 'delete_address_for_domain')).toBeUndefined();
  });

  it('promotion respects the role-tier filter (over-tier tools stay hidden)', async () => {
    const { getAllToolDefinitions } = await importTools();
    const { recordCallApiInvocation } = await import('../tools/promotion/index.js');
    // Record direct (recordCallApiInvocation bypasses role enforcement — only
    // listing/dispatch apply roles). get_accesslog is a system_admin-tier tool.
    await recordCallApiInvocation('eve', 'get_accesslog');
    await recordCallApiInvocation('eve', 'get_accesslog');

    // Basic user cannot see system-admin tools, promoted or not
    const tools = await getAllToolDefinitions('user', 'eve');
    expect(tools.find((t) => t.name === 'get_accesslog')).toBeUndefined();
  });

  it('promotion is per-user — alice promoting does not affect bob', async () => {
    const { getAllToolDefinitions } = await importTools();
    const { recordCallApiInvocation } = await import('../tools/promotion/index.js');
    await recordCallApiInvocation('alice', 'get_phones');
    await recordCallApiInvocation('alice', 'get_phones');

    const aliceTools = await getAllToolDefinitions('domain_admin', 'alice');
    const bobTools = await getAllToolDefinitions('domain_admin', 'bob');

    expect(aliceTools.find((t) => t.name === 'get_phones')).toBeDefined();
    expect(bobTools.find((t) => t.name === 'get_phones')).toBeUndefined();
  });

  it('MCP_DISABLE_PROMOTION=true turns the whole feature off', async () => {
    process.env.MCP_DISABLE_PROMOTION = 'true';
    const { getAllToolDefinitions } = await importTools();
    const { recordCallApiInvocation } = await import('../tools/promotion/index.js');
    await recordCallApiInvocation('frank', 'get_phones');
    await recordCallApiInvocation('frank', 'get_phones');

    const tools = await getAllToolDefinitions('domain_admin', 'frank');
    expect(tools.find((t) => t.name === 'get_phones')).toBeUndefined();
  });

  it('only records call_api invocations, not direct tool calls', async () => {
    const { registerAllTools } = await importTools();
    const handlers = new Map<unknown, (req: unknown) => Promise<unknown>>();
    const sendToolListChanged = vi.fn(async () => {});
    const server = {
      setRequestHandler: (s: unknown, h: (req: unknown) => Promise<unknown>) => handlers.set(s, h),
      sendToolListChanged,
    } as never;
    const fakeClient = { request: async () => ({ success: true, data: {} }) };

    registerAllTools(server, fakeClient as never, 'domain_admin', 'grace');
    const callHandler = handlers.get(CallToolRequestSchema) as (req: unknown) => Promise<unknown>;

    // Calling a curated tool directly should NOT trigger promotion (it's
    // already in the catalog).
    await callHandler({ params: { name: 'find_user', arguments: { query: 'alice' } } });
    await callHandler({ params: { name: 'find_user', arguments: { query: 'alice' } } });
    expect(sendToolListChanged).not.toHaveBeenCalled();
  });
});
