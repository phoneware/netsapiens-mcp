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
  // tools/list_changed needs a stream back to the client, which only exists in
  // session mode. Promotion notifications are tested there.
  process.env.MCP_STATELESS = 'false';
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

  it('fires sendToolListChanged when a promoted tool decays out of the window', async () => {
    // Tiny window so the test can move "time" without real waits.
    process.env.MCP_PROMOTE_WINDOW_DAYS = '0.0001'; // ~8.6 seconds
    process.env.MCP_PROMOTE_THRESHOLD = '2';

    const { registerAllTools } = await importTools();
    const { recordCallApiInvocation } = await import('../tools/promotion/index.js');
    const handlers = new Map<unknown, (req: unknown) => Promise<unknown>>();
    const sendToolListChanged = vi.fn(async () => {});
    const server = {
      setRequestHandler: (s: unknown, h: (req: unknown) => Promise<unknown>) => handlers.set(s, h),
      sendToolListChanged,
    } as never;
    const fakeClient = { request: async () => ({ success: true, data: {} }) };

    registerAllTools(server, fakeClient as never, 'domain_admin', 'hank');
    const callHandler = handlers.get(CallToolRequestSchema) as (req: unknown) => Promise<unknown>;

    // Promote get_devices: two calls cross the threshold.
    await callHandler({ params: { name: 'call_api', arguments: { tool_name: 'get_devices', args: {} } } });
    await callHandler({ params: { name: 'call_api', arguments: { tool_name: 'get_devices', args: {} } } });
    expect(sendToolListChanged).toHaveBeenCalledTimes(1);

    // Drop the in-memory record's lastUsed so the next reconcile sees the
    // tool as decayed. This mimics the wall-clock window sliding past.
    const { _resetUsageStoreForTests, InMemoryUsageStore } = await import('../tools/promotion/usage-store.js');
    const store = new InMemoryUsageStore();
    await store.recordCall('hank', 'get_devices');
    await store.recordCall('hank', 'get_devices');
    // Manually backdate lastUsed below the window by mutating the store.
    const usage = await store.getUserUsage('hank');
    const rec = usage.get('get_devices')!;
    // Replace store contents via re-record and then mutate via private access.
    // Easier: swap in a fresh store with pre-dated records.
    const aged = new InMemoryUsageStore();
    await aged.recordCall('hank', 'get_devices');
    await aged.recordCall('hank', 'get_devices');
    const agedMap = await aged.getUserUsage('hank');
    const agedRec = agedMap.get('get_devices')!;
    agedRec.lastUsed = Date.now() - 60_000; // 1 minute ago, well past 8.6s window
    // Reinstall the aged store. (recordCallApiInvocation reads via singleton.)
    _resetUsageStoreForTests({
      async recordCall(user: string, tool: string) { void user; void tool; },
      async getUserUsage(user: string) {
        if (user === 'hank') return new Map([['get_devices', agedRec]]);
        return new Map();
      },
    });
    void rec; // silence unused warning in the unused branch
    void usage;
    void recordCallApiInvocation;

    // Make a fresh tool call — reconciler should diff the snapshot and fire.
    sendToolListChanged.mockClear();
    await callHandler({ params: { name: 'find_user', arguments: { query: 'a' } } });
    expect(sendToolListChanged).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire sendToolListChanged when the promoted set is unchanged', async () => {
    process.env.MCP_PROMOTE_THRESHOLD = '2';
    const { registerAllTools } = await importTools();
    const handlers = new Map<unknown, (req: unknown) => Promise<unknown>>();
    const sendToolListChanged = vi.fn(async () => {});
    const server = {
      setRequestHandler: (s: unknown, h: (req: unknown) => Promise<unknown>) => handlers.set(s, h),
      sendToolListChanged,
    } as never;
    const fakeClient = { request: async () => ({ success: true, data: {} }) };

    registerAllTools(server, fakeClient as never, 'domain_admin', 'ivy');
    const callHandler = handlers.get(CallToolRequestSchema) as (req: unknown) => Promise<unknown>;

    // Cross the threshold once (fires).
    await callHandler({ params: { name: 'call_api', arguments: { tool_name: 'get_devices', args: {} } } });
    await callHandler({ params: { name: 'call_api', arguments: { tool_name: 'get_devices', args: {} } } });
    expect(sendToolListChanged).toHaveBeenCalledTimes(1);

    // Many subsequent non-changing calls should NOT spam list_changed.
    sendToolListChanged.mockClear();
    for (let i = 0; i < 5; i++) {
      await callHandler({ params: { name: 'find_user', arguments: { query: 'x' } } });
    }
    expect(sendToolListChanged).not.toHaveBeenCalled();
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
