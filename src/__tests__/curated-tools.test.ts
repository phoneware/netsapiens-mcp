/**
 * Tests for the curated tool catalog + escape hatch + MCP_TOOL_MODE selection.
 *
 * Covers:
 *  - default mode is curated (~30 tools, not 700+)
 *  - MCP_TOOL_MODE=full restores the generated registry
 *  - scope filtering on curated tools (user vs domain_admin)
 *  - search_api ranks matches
 *  - call_api dispatches into the generated registry and honors filters
 *  - composite handlers translate args into the right client.request shape
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

async function importTools() {
  vi.resetModules();
  return import('../tools/index.js');
}

function clearEnv() {
  delete process.env.MCP_TOOL_MODE;
  delete process.env.MCP_DISABLED_TOOLS;
  delete process.env.MCP_DISABLED_ACTIONS;
  delete process.env.MCP_DISABLE_ROLE_FILTER;
  // These were previously left set by whichever test turned them on, so a
  // later test could be silently refused by a filter it never asked for.
  delete process.env.MCP_DISABLE_DESTRUCTIVE;
  delete process.env.MCP_CONFIRM_DESTRUCTIVE;
  delete process.env.MCP_SYNCHRONOUS_WRITES;
}

describe('MCP_TOOL_MODE', () => {
  beforeEach(clearEnv);

  it('defaults to curated mode — ~30 tools, not the full 700+', async () => {
    const { getAllToolDefinitions } = await importTools();
    const tools = await getAllToolDefinitions();
    expect(tools.length).toBeLessThan(50);
    expect(tools.length).toBeGreaterThan(20);
    // search_api and call_api are always present
    expect(tools.find((t) => t.name === 'search_api')).toBeDefined();
    expect(tools.find((t) => t.name === 'call_api')).toBeDefined();
  });

  it('MCP_TOOL_MODE=full restores the generated registry', async () => {
    process.env.MCP_TOOL_MODE = 'full';
    const { getAllToolDefinitions } = await importTools();
    const tools = await getAllToolDefinitions();
    expect(tools.length).toBeGreaterThan(500);
    // search_api / call_api are curated-mode only
    expect(tools.find((t) => t.name === 'search_api')).toBeUndefined();
  });
});

describe('curated scope filtering', () => {
  beforeEach(clearEnv);

  it('a basic user sees self-service + meta tools, no domain-admin ops', async () => {
    const { getAllToolDefinitions } = await importTools();
    const user = await getAllToolDefinitions('user');
    const names = new Set(user.map((t) => t.name));
    // self-service basics
    expect(names.has('find_user')).toBe(true);
    expect(names.has('my_voicemails')).toBe(true);
    expect(names.has('place_call')).toBe(true);
    expect(names.has('search_api')).toBe(true);
    // admin tools hidden
    expect(names.has('end_call')).toBe(false);
    expect(names.has('list_queues')).toBe(false);
    expect(names.has('call_trace')).toBe(false);
  });

  it('a domain_admin sees the full curated set', async () => {
    const { getAllToolDefinitions } = await importTools();
    const admin = await getAllToolDefinitions('domain_admin');
    const names = new Set(admin.map((t) => t.name));
    expect(names.has('list_queues')).toBe(true);
    expect(names.has('end_call')).toBe(true);
    expect(names.has('call_statistics')).toBe(true);
  });

  it('basic user gets rejected at call time if they try a higher-tier curated tool', async () => {
    const { handleToolCall } = await importTools();
    const fakeClient = { request: async () => ({ success: true, data: {} }) };
    await expect(
      handleToolCall(fakeClient as never, 'end_call', { call_id: 'x' }, 'user'),
    ).rejects.toThrow(/higher access tier/i);
  });
});

describe('search_api', () => {
  beforeEach(clearEnv);

  it('returns ranked matches across the full generated registry', async () => {
    const { handleToolCall } = await importTools();
    const fakeClient = { request: async () => ({ success: true }) };
    const result = (await handleToolCall(
      fakeClient as never,
      'search_api',
      { query: 'voicemail' },
      'user',
    )) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total).toBeGreaterThan(0);
    expect(parsed.matches.length).toBeGreaterThan(0);
    expect(parsed.matches[0].name.toLowerCase()).toContain('voicemail');
  });

  it('returns an empty match list for an empty query', async () => {
    const { handleToolCall } = await importTools();
    const fakeClient = { request: async () => ({ success: true }) };
    const result = (await handleToolCall(
      fakeClient as never,
      'search_api',
      { query: '' },
      'user',
    )) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.matches).toEqual([]);
  });
});

describe('call_api', () => {
  beforeEach(clearEnv);

  it('dispatches to a generated tool by name', async () => {
    const { handleToolCall } = await importTools();
    const calls: unknown[] = [];
    const fakeClient = {
      request: async (opts: unknown) => {
        calls.push(opts);
        return { success: true, data: { ok: true } };
      },
    };
    await handleToolCall(
      fakeClient as never,
      'call_api',
      { tool_name: 'get_domains', args: { limit: 5 } },
      'reseller',
    );
    expect(calls.length).toBe(1);
    expect((calls[0] as { method: string }).method).toBe('GET');
  });

  it('honors MCP_DISABLED_TOOLS when invoked via call_api', async () => {
    process.env.MCP_DISABLED_TOOLS = 'get_domains';
    const { handleToolCall } = await importTools();
    const fakeClient = { request: async () => ({ success: true }) };
    await expect(
      handleToolCall(fakeClient as never, 'call_api', { tool_name: 'get_domains', args: {} }, 'reseller'),
    ).rejects.toThrow(/disabled/i);
  });

  it('honors role-tier filter when invoked via call_api', async () => {
    const { handleToolCall } = await importTools();
    const fakeClient = { request: async () => ({ success: true }) };
    await expect(
      handleToolCall(fakeClient as never, 'call_api', { tool_name: 'get_accesslog', args: {} }, 'user'),
    ).rejects.toThrow(/higher access tier/i);
  });

  it('returns a helpful error for an unknown tool_name', async () => {
    const { handleToolCall } = await importTools();
    const fakeClient = { request: async () => ({ success: true }) };
    const result = (await handleToolCall(
      fakeClient as never,
      'call_api',
      { tool_name: 'does_not_exist', args: {} },
      'user',
    )) as { content: Array<{ text: string }> };
    expect(result.content[0].text).toMatch(/not registered/i);
  });
});

describe('semantic filters carry through search_api and call_api', () => {
  beforeEach(() => {
    clearEnv();
    delete process.env.MCP_DISABLE_DESTRUCTIVE;
  });

  it('MCP_DISABLE_DESTRUCTIVE=true blocks end_call (a composite that DELETEs)', async () => {
    process.env.MCP_DISABLE_DESTRUCTIVE = 'true';
    const { handleToolCall, getAllToolDefinitions } = await importTools();
    const tools = await getAllToolDefinitions('domain_admin');
    expect(tools.find((t) => t.name === 'end_call')).toBeUndefined();

    const fakeClient = { request: async () => ({ success: true }) };
    await expect(
      handleToolCall(fakeClient as never, 'end_call', { call_id: 'x' }, 'domain_admin'),
    ).rejects.toThrow(/destructive/i);
  });

  it('search_api hides tools matched by MCP_DISABLED_TOOLS so the model does not surface them', async () => {
    process.env.MCP_DISABLED_TOOLS = 'delete_*';
    const { handleToolCall } = await importTools();
    const fakeClient = { request: async () => ({ success: true }) };
    const result = (await handleToolCall(
      fakeClient as never,
      'search_api',
      { query: 'delete' },
      'domain_admin',
    )) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0].text);
    const leaks = parsed.matches.filter((mt: { name: string }) => mt.name.startsWith('delete_'));
    expect(leaks).toEqual([]);
  });

  it('search_api hides over-tier tools from a basic user', async () => {
    const { handleToolCall } = await importTools();
    const fakeClient = { request: async () => ({ success: true }) };
    const result = (await handleToolCall(
      fakeClient as never,
      'search_api',
      { query: 'auditlog' },
      'user',
    )) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.matches).toEqual([]);
  });

  it('search_api hides destructive tools when MCP_DISABLE_DESTRUCTIVE=true', async () => {
    process.env.MCP_DISABLE_DESTRUCTIVE = 'true';
    const { handleToolCall } = await importTools();
    const fakeClient = { request: async () => ({ success: true }) };
    const result = (await handleToolCall(
      fakeClient as never,
      'search_api',
      { query: 'delete' },
      'domain_admin',
    )) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0].text);
    const leaks = parsed.matches.filter((mt: { name: string }) => /^(delete_|revoke_)/.test(mt.name));
    expect(leaks).toEqual([]);
  });
});

describe('workflow tools (multi-call composites)', () => {
  beforeEach(clearEnv);

  function recorder() {
    const calls: Array<{ method: string; pathTemplate: string; pathParams?: Record<string, string>; body?: unknown; queryParams?: Record<string, unknown> }> = [];
    const client = {
      request: async (o: typeof calls[number]) => {
        calls.push(o);
        return { success: true, data: [] };
      },
    };
    return { client, calls };
  }

  it('diagnose_call fans out to CDR, sipflow, and cradle-to-grave in parallel', async () => {
    const { handleToolCall } = await importTools();
    const { client, calls } = recorder();
    await handleToolCall(client as never, 'diagnose_call', { call_id: 'c-1' }, 'domain_admin');
    const paths = calls.map((c) => c.pathTemplate).sort();
    expect(paths).toContain('/domains/{domain}/users/{user}/calls/{callid}');
    expect(paths).toContain('/sipflow/{callid}');
    expect(paths).toContain('/cradle2grave/{callid}');
  });

  it('user_profile makes five concurrent reads', async () => {
    const { handleToolCall } = await importTools();
    const { client, calls } = recorder();
    await handleToolCall(client as never, 'user_profile', { user: 'alice' }, 'user');
    expect(calls.length).toBe(5);
    const paths = new Set(calls.map((c) => c.pathTemplate));
    expect(paths.has('/domains/{domain}/users/{user}')).toBe(true);
    expect(paths.has('/domains/{domain}/users/{user}/devices')).toBe(true);
    expect(paths.has('/domains/{domain}/users/{user}/answerrules')).toBe(true);
    expect(paths.has('/domains/{domain}/users/{user}/cdrs')).toBe(true);
    expect(paths.has('/domains/{domain}/users/{user}/voicemails')).toBe(true);
  });

  it('queue_health lists queues then fans out per-queue status', async () => {
    const { handleToolCall } = await importTools();
    const calls: Array<{ method: string; pathTemplate: string }> = [];
    const client = {
      request: async (o: { method: string; pathTemplate: string }) => {
        calls.push(o);
        if (o.pathTemplate === '/domains/{domain}/callqueues') {
          return { success: true, data: [{ callqueue: 'support' }, { callqueue: 'sales' }] };
        }
        return { success: true, data: {} };
      },
    };
    await handleToolCall(client as never, 'queue_health', {}, 'domain_admin');
    // 1 list + 2 stats
    expect(calls.length).toBe(3);
    expect(calls[0].pathTemplate).toBe('/domains/{domain}/callqueues');
    expect(calls.slice(1).every((c) => c.pathTemplate === '/domains/{domain}/statistics/callqueues/{queue}')).toBe(true);
  });

  it('switch_queue does logout then login and reports partial-failure clearly', async () => {
    const { handleToolCall } = await importTools();
    const seq: string[] = [];
    const client = {
      request: async (o: { pathTemplate: string }) => {
        seq.push(o.pathTemplate);
        if (o.pathTemplate.endsWith('/login')) return { success: false, error: 'queue full' };
        return { success: true };
      },
    };
    const result = (await handleToolCall(
      client as never,
      'switch_queue',
      { from: 'support', to: 'sales' },
      'user',
    )) as { content: Array<{ text: string }> };
    expect(seq[0]).toContain('logout');
    expect(seq[1]).toContain('login');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.step).toBe('login');
    expect(parsed.note).toMatch(/LOGGED OUT/);
  });

  it('find_and_call filters users client-side (no server-side name filter exists) and returns candidates without calling when multiple matches and confirm=false', async () => {
    const { handleToolCall } = await importTools();
    const calls: Array<{ pathTemplate: string; queryParams?: Record<string, unknown> }> = [];
    const client = {
      request: async (o: { pathTemplate: string; queryParams?: Record<string, unknown> }) => {
        calls.push(o);
        if (o.pathTemplate.includes('/users') && !o.pathTemplate.includes('contacts')) {
          return {
            success: true,
            data: [
              { user: '1001', 'name-first-name': 'Alice' },
              { user: '1002', 'name-first-name': 'Alice', 'name-last-name': 'Second' },
              { user: '1003', 'name-first-name': 'Bob' },
            ],
          };
        }
        return { success: true, data: [] };
      },
    };
    const result = (await handleToolCall(
      client as never,
      'find_and_call',
      { query: 'alice' },
      'user',
    )) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.matches.length).toBe(2);
    // no fabricated `user=`/`contact=` filter param sent — the API doesn't support one
    const userListCall = calls.find((c) => c.pathTemplate === '/domains/{domain}/users');
    expect(userListCall?.queryParams).not.toHaveProperty('user');
  });

  it('find_and_call places the call when confirm=true', async () => {
    const { handleToolCall } = await importTools();
    const placed: Array<{ method: string; body?: unknown }> = [];
    const client = {
      request: async (o: { pathTemplate: string; method: string; body?: unknown }) => {
        if (o.method === 'POST') placed.push(o);
        if (o.pathTemplate.includes('/users') && !o.pathTemplate.includes('contacts') && o.method === 'GET') {
          return {
            success: true,
            data: [
              { user: '1001', 'name-first-name': 'Alice' },
              { user: '1002', 'name-first-name': 'Alice', 'name-last-name': 'Second' },
              { user: '1003', 'name-first-name': 'Bob' },
            ],
          };
        }
        return { success: true, data: [] };
      },
    };
    await handleToolCall(client as never, 'find_and_call', { query: 'alice', confirm: true }, 'user');
    expect(placed.length).toBe(1);
    expect((placed[0].body as { destination: string }).destination).toBe('1001');
  });

  it('voicemail_inbox_summary shapes the list into a condensed structure', async () => {
    const { handleToolCall } = await importTools();
    const client = {
      request: async () => ({
        success: true,
        data: [
          { 'caller-id-number': '15551112222', 'caller-id-name': 'Alice', datetime: '2026-06-12T10:00', duration: 30, 'transcription-text': 'Hey it is Alice', filename: 'vm1' },
          { 'caller-id-number': '15553334444', datetime: '2026-06-12T11:00', duration: 12, filename: 'vm2' },
        ],
      }),
    };
    const result = (await handleToolCall(
      client as never,
      'voicemail_inbox_summary',
      {},
      'user',
    )) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(2);
    expect(parsed.voicemails[0].from).toContain('Alice');
    expect(parsed.voicemails[0].transcript).toBe('Hey it is Alice');
    expect(parsed.voicemails[1].transcript).toBeUndefined();
  });

  it('schedule_forwarding PUTs an answer rule for the default time-frame', async () => {
    const { handleToolCall } = await importTools();
    const captured: Array<{ method: string; pathTemplate: string; body?: unknown }> = [];
    const client = {
      request: async (o: { method: string; pathTemplate: string; body?: unknown }) => {
        captured.push(o);
        return { success: true };
      },
    };
    await handleToolCall(client as never, 'schedule_forwarding', { destination: '4001' }, 'user');
    expect(captured[0].method).toBe('PUT');
    expect(captured[0].pathTemplate).toBe('/domains/~/users/~/answerrules/{timeframe}');
    // `forward-always` is the field NS actually reads. `rule-action` /
    // `forward-destination` appear nowhere in the spec or the controllers, so
    // the old payload was silently discarded.
    const fwd = (captured[0].body as { 'forward-always': { enabled: string; parameters: string[] } })['forward-always'];
    expect(fwd.enabled).toBe('yes');
    expect(fwd.parameters).toEqual(['4001']);
  });

  it('recent_activity_for_number queries CDRs by caller/dialled (not the nonexistent orig-from-uri/term-to-uri) and filters message sessions client-side', async () => {
    const { handleToolCall } = await importTools();
    const calls: Array<{ pathTemplate: string; queryParams?: Record<string, unknown> }> = [];
    const client = {
      request: async (o: { pathTemplate: string; queryParams?: Record<string, unknown> }) => {
        calls.push(o);
        if (o.pathTemplate === '/domains/{domain}/cdrs') {
          return { success: true, data: [{ id: 'call-1' }] };
        }
        return {
          success: true,
          data: [
            { 'messagesession-id': 'match', 'messagesession-remote': '+1 (415) 555-1234' },
            { 'messagesession-id': 'no-match', 'messagesession-remote': '19998887777' },
          ],
        };
      },
    };
    const result = (await handleToolCall(
      client as never,
      'recent_activity_for_number',
      { number: '4155551234' },
      'domain_admin',
    )) as { content: Array<{ text: string }> };

    const cdrCalls = calls.filter((c) => c.pathTemplate === '/domains/{domain}/cdrs');
    expect(cdrCalls.length).toBe(2);
    const cdrQueryKeys = cdrCalls.flatMap((c) => Object.keys(c.queryParams ?? {}));
    expect(cdrQueryKeys).toContain('caller');
    expect(cdrQueryKeys).toContain('dialled');
    expect(cdrQueryKeys).not.toContain('orig-from-uri');
    expect(cdrQueryKeys).not.toContain('term-to-uri');

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.message_sessions.data.map((s: { 'messagesession-id': string }) => s['messagesession-id'])).toEqual(['match']);
  });

  it('recent_activity_for_number sends datetime-end alongside datetime-start (required pair — datetime-start alone is silently ignored) and enforces `since` client-side as a backstop', async () => {
    const { handleToolCall } = await importTools();
    const calls: Array<{ pathTemplate: string; queryParams?: Record<string, unknown> }> = [];
    const client = {
      request: async (o: { pathTemplate: string; queryParams?: Record<string, unknown> }) => {
        calls.push(o);
        if (o.pathTemplate === '/domains/{domain}/cdrs') {
          // Simulate a server that ignores the date bound and returns full history anyway —
          // the client-side isOnOrAfter backstop must still narrow this down.
          return {
            success: true,
            data: [
              { id: 'old-call', 'call-start-datetime': '2020-01-01T00:00:00Z' },
              { id: 'new-call', 'call-start-datetime': '2026-07-15T12:00:00Z' },
            ],
          };
        }
        return { success: true, data: [] };
      },
    };
    const before = Date.now();
    const result = (await handleToolCall(
      client as never,
      'recent_activity_for_number',
      { number: '4155551234', since: '2026-07-01T00:00:00Z' },
      'domain_admin',
    )) as { content: Array<{ text: string }> };
    const after = Date.now();

    const cdrCalls = calls.filter((c) => c.pathTemplate === '/domains/{domain}/cdrs');
    for (const c of cdrCalls) {
      expect(c.queryParams?.['datetime-start']).toBe('2026-07-01T00:00:00Z');
      const until = c.queryParams?.['datetime-end'] as string;
      expect(until).toBeTruthy();
      const untilMs = Date.parse(until);
      expect(untilMs).toBeGreaterThanOrEqual(before);
      expect(untilMs).toBeLessThanOrEqual(after);
    }

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.calls.data.map((c: { id: string }) => c.id)).toEqual(['new-call']);
  });

  it('schedule_forwarding with disable=true disables forward-always', async () => {
    const { handleToolCall } = await importTools();
    const captured: Array<{ body?: unknown }> = [];
    const client = {
      request: async (o: { body?: unknown }) => {
        captured.push(o);
        return { success: true };
      },
    };
    await handleToolCall(client as never, 'schedule_forwarding', { disable: true }, 'user');
    const fwd = (captured[0].body as { 'forward-always': { enabled: string; parameters: string[] } })['forward-always'];
    expect(fwd.enabled).toBe('no');
    expect(fwd.parameters).toEqual([]);
  });

  it('schedule_forwarding with `until` creates the time-frame, then the answer rule pointed at it', async () => {
    const { handleToolCall } = await importTools();
    const calls: Array<{ method: string; pathTemplate: string; body?: Record<string, unknown> }> = [];
    const client = {
      request: async (o: { method: string; pathTemplate: string; body?: Record<string, unknown> }) => {
        calls.push(o);
        return { success: true, data: {} };
      },
    };

    await handleToolCall(
      client as never,
      'schedule_forwarding',
      { destination: '+13035551212', from: '2026-08-03', until: '2026-08-07 17:00' },
      'user',
    );

    expect(calls.map((c) => c.pathTemplate)).toEqual([
      '/domains/~/users/~/timeframes',
      '/domains/~/users/~/answerrules',
    ]);

    // NS takes compact YYYYMMDD / HHMM, not ISO.
    const window = (calls[0].body?.['timeframe-specific-dates-array'] as Array<Record<string, string>>)[0];
    expect(window['timeframe-specific-dates-begin-date']).toBe('20260803');
    expect(window['timeframe-specific-dates-begin-time']).toBe('0000');
    expect(window['timeframe-specific-dates-end-date']).toBe('20260807');
    expect(window['timeframe-specific-dates-end-time']).toBe('1700');
    expect(window['timeframe-recurrence-type']).toBe('doesNotRecur');
    expect(calls[0].body?.['timeframe-type']).toBe('specific-dates');

    // The rule names the time-frame that was just created.
    expect(calls[1].body?.['time-frame']).toBe(calls[0].body?.['timeframe-name']);
    const fwd = calls[1].body?.['forward-always'] as { enabled: string; parameters: string[] };
    expect(fwd.parameters).toEqual(['+13035551212']);
  });

  it('does not create an answer rule when the time-frame failed', async () => {
    const { handleToolCall } = await importTools();
    const calls: string[] = [];
    const client = {
      request: async (o: { pathTemplate: string }) => {
        calls.push(o.pathTemplate);
        return { success: false, error: '409 timeframe exists' };
      },
    };

    const res = (await handleToolCall(
      client as never,
      'schedule_forwarding',
      { destination: '4001', until: '2026-08-07' },
      'user',
    )) as { content: Array<{ text: string }> };

    // A rule pointed at a time-frame that does not exist would apply never,
    // and would read as success.
    expect(calls).toEqual(['/domains/~/users/~/timeframes']);
    expect(JSON.parse(res.content[0].text).ok).toBe(false);
  });

  it('refuses an unreadable date instead of scheduling the wrong window', async () => {
    const { handleToolCall } = await importTools();
    const calls: string[] = [];
    const client = {
      request: async (o: { pathTemplate: string }) => {
        calls.push(o.pathTemplate);
        return { success: true, data: {} };
      },
    };

    const res = (await handleToolCall(
      client as never,
      'schedule_forwarding',
      { destination: '4001', until: 'next Friday' },
      'user',
    )) as { content: Array<{ text: string }> };

    expect(calls).toEqual([]);
    expect(JSON.parse(res.content[0].text).error).toMatch(/Could not read/);
  });

  it('normalises both ISO and compact date forms', async () => {
    const { toNsDateTime } = await import('../tools/curated/workflows.js');
    expect(toNsDateTime('2026-08-07', '2359')).toEqual({ date: '20260807', time: '2359' });
    expect(toNsDateTime('2026-08-07 09:30', '2359')).toEqual({ date: '20260807', time: '0930' });
    expect(toNsDateTime('2026-08-07T09:30', '2359')).toEqual({ date: '20260807', time: '0930' });
    expect(toNsDateTime('20260807', '0000')).toEqual({ date: '20260807', time: '0000' });
    expect(toNsDateTime('sometime soon', '0000')).toBeNull();
    expect(toNsDateTime('', '0000')).toBeNull();
  });
});

describe('composite handlers translate args correctly', () => {
  beforeEach(clearEnv);

  it('find_user fetches /domains/{domain}/users broadly (no server-side name filter exists) and filters client-side', async () => {
    const { handleToolCall } = await importTools();
    const calls: unknown[] = [];
    const fakeClient = {
      request: async (o: unknown) => {
        calls.push(o);
        return {
          success: true,
          data: [
            { user: '1001', 'name-first-name': 'Alice' },
            { user: '1002', 'name-first-name': 'Bob' },
          ],
        };
      },
    };
    const result = (await handleToolCall(fakeClient as never, 'find_user', { query: 'alice' }, 'user')) as {
      content: Array<{ text: string }>;
    };
    const opts = calls[0] as { pathTemplate: string; pathParams: Record<string, string>; queryParams: Record<string, unknown> };
    expect(opts.pathTemplate).toBe('/domains/{domain}/users');
    expect(opts.pathParams.domain).toBe('~');
    // no fabricated `user=` filter — the endpoint doesn't support one
    expect(opts.queryParams).not.toHaveProperty('user');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.data).toEqual([{ user: '1001', 'name-first-name': 'Alice' }]);
  });

  it('find_domain fetches /domains broadly (no server-side name filter exists) and filters client-side', async () => {
    const { handleToolCall } = await importTools();
    const calls: Array<{ pathTemplate: string; queryParams?: Record<string, unknown> }> = [];
    const fakeClient = {
      request: async (o: { pathTemplate: string; queryParams?: Record<string, unknown> }) => {
        calls.push(o);
        return {
          success: true,
          data: [
            { domain: 'acme.com', description: 'Acme Corp' },
            { domain: 'other.com', description: 'Other Inc' },
          ],
        };
      },
    };
    const result = (await handleToolCall(fakeClient as never, 'find_domain', { query: 'acme' }, 'domain_admin')) as {
      content: Array<{ text: string }>;
    };
    expect(calls[0].queryParams).not.toHaveProperty('domain');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.data).toEqual([{ domain: 'acme.com', description: 'Acme Corp' }]);
  });

  it('find_contact fetches contacts broadly (no `contact=` filter exists) and matches name/email/phone client-side', async () => {
    const { handleToolCall } = await importTools();
    const calls: Array<{ pathTemplate: string; queryParams?: Record<string, unknown> }> = [];
    const fakeClient = {
      request: async (o: { pathTemplate: string; queryParams?: Record<string, unknown> }) => {
        calls.push(o);
        return {
          success: true,
          data: [
            { 'unique-id': '1', 'name-first-name': 'Alice', 'phonenumber-cell': '14155551234' },
            { 'unique-id': '2', 'name-first-name': 'Bob', 'phonenumber-cell': '19998887777' },
          ],
        };
      },
    };
    const result = (await handleToolCall(fakeClient as never, 'find_contact', { query: 'alice' }, 'user')) as {
      content: Array<{ text: string }>;
    };
    expect(calls[0].queryParams?.contact).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.data.map((c: { 'unique-id': string }) => c['unique-id'])).toEqual(['1']);
  });

  it('find_phone_number fetches the full domain list (no `phonenumber=` filter exists) and matches client-side', async () => {
    const { handleToolCall } = await importTools();
    const calls: Array<{ pathTemplate: string; queryParams?: Record<string, unknown> }> = [];
    const fakeClient = {
      request: async (o: { pathTemplate: string; queryParams?: Record<string, unknown> }) => {
        calls.push(o);
        return {
          success: true,
          data: [{ phonenumber: '14155551234' }, { phonenumber: '19998887777' }],
        };
      },
    };
    const result = (await handleToolCall(fakeClient as never, 'find_phone_number', { number: '4155551234' }, 'domain_admin')) as {
      content: Array<{ text: string }>;
    };
    expect(calls[0].queryParams?.phonenumber).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.data).toEqual([{ phonenumber: '14155551234' }]);
  });

  it('find_device fetches the full domain list (no `device=` filter exists) and matches client-side', async () => {
    const { handleToolCall } = await importTools();
    const calls: Array<{ pathTemplate: string; queryParams?: Record<string, unknown> }> = [];
    const fakeClient = {
      request: async (o: { pathTemplate: string; queryParams?: Record<string, unknown> }) => {
        calls.push(o);
        return {
          success: true,
          data: [
            { device: 'mac-1', user: '1001' },
            { device: 'mac-2', user: '1002' },
          ],
        };
      },
    };
    const result = (await handleToolCall(fakeClient as never, 'find_device', { query: '1001' }, 'domain_admin')) as {
      content: Array<{ text: string }>;
    };
    expect(calls[0].queryParams?.device).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.data).toEqual([{ device: 'mac-1', user: '1001' }]);
  });

  it('recent_calls, call_statistics, and agent_statistics send `datetime-start` + `datetime-end` (not the nonexistent `start-time-after`) for `since`', async () => {
    // `datetime-start`/`datetime-end` are a required pair on these endpoints —
    // sending `datetime-start` alone is silently ignored by the live API
    // (confirmed against production data), so `datetime-end` must always be
    // sent alongside it.
    const { handleToolCall } = await importTools();
    const calls: Array<{ queryParams?: Record<string, unknown> }> = [];
    const fakeClient = {
      request: async (o: { queryParams?: Record<string, unknown> }) => {
        calls.push(o);
        return { success: true, data: [] };
      },
    };
    const before = Date.now();
    await handleToolCall(fakeClient as never, 'recent_calls', { since: '2026-01-01T00:00:00Z' }, 'user');
    await handleToolCall(fakeClient as never, 'call_statistics', { since: '2026-01-01T00:00:00Z' }, 'domain_admin');
    await handleToolCall(fakeClient as never, 'agent_statistics', { since: '2026-01-01T00:00:00Z' }, 'domain_admin');
    const after = Date.now();
    expect(calls.length).toBe(3);
    for (const c of calls) {
      expect(c.queryParams).toHaveProperty('datetime-start', '2026-01-01T00:00:00Z');
      expect(c.queryParams).not.toHaveProperty('start-time-after');
      const until = c.queryParams?.['datetime-end'] as string;
      expect(until).toBeTruthy();
      const untilMs = Date.parse(until);
      expect(untilMs).toBeGreaterThanOrEqual(before);
      expect(untilMs).toBeLessThanOrEqual(after);
    }
  });

  it('recent_calls omits datetime-start/datetime-end entirely when no `since` is given', async () => {
    const { handleToolCall } = await importTools();
    const calls: Array<{ queryParams?: Record<string, unknown> }> = [];
    const fakeClient = {
      request: async (o: { queryParams?: Record<string, unknown> }) => {
        calls.push(o);
        return { success: true, data: [] };
      },
    };
    await handleToolCall(fakeClient as never, 'recent_calls', {}, 'user');
    expect(calls[0].queryParams?.['datetime-start']).toBeUndefined();
    expect(calls[0].queryParams?.['datetime-end']).toBeUndefined();
  });

  it('place_call POSTs the destination to /domains/{domain}/users/{user}/calls', async () => {
    const { handleToolCall } = await importTools();
    const calls: unknown[] = [];
    const fakeClient = {
      request: async (o: unknown) => {
        calls.push(o);
        return { success: true };
      },
    };
    await handleToolCall(fakeClient as never, 'place_call', { to: '15551234567' }, 'user');
    const opts = calls[0] as { method: string; body: { destination: string }; pathParams: Record<string, string> };
    expect(opts.method).toBe('POST');
    expect(opts.body.destination).toBe('15551234567');
    expect(opts.pathParams.user).toBe('~');
  });

  it('transfer_call uses the /transfer/peer path for type=peer', async () => {
    const { handleToolCall } = await importTools();
    const calls: unknown[] = [];
    const fakeClient = {
      request: async (o: unknown) => {
        calls.push(o);
        return { success: true };
      },
    };
    await handleToolCall(
      fakeClient as never,
      'transfer_call',
      { call_id: 'c1', to: '4001', type: 'peer' },
      'domain_admin',
    );
    const opts = calls[0] as { pathTemplate: string };
    expect(opts.pathTemplate).toContain('/transfer/peer');
  });
});

// ---------------------------------------------------------------------------
// Multi-step write orchestration
// ---------------------------------------------------------------------------

describe('synchronous writes', () => {
  beforeEach(() => {
    clearEnv();
    delete process.env.MCP_SYNCHRONOUS_WRITES;
  });

  it('defaults synchronous=yes on a generated write that accepts it', async () => {
    const { handleToolCall } = await importTools();
    const bodies: unknown[] = [];
    const client = {
      request: async (o: { body?: unknown }) => {
        bodies.push(o.body);
        return { success: true, data: {} };
      },
    };
    await handleToolCall(
      client as never,
      'call_api',
      { tool_name: 'create_user', args: { domain: 'd.com', user: '1001' } },
      'system_admin',
    );
    expect((bodies[0] as Record<string, unknown>)?.synchronous).toBe('yes');
  });

  it('never overrides an explicit synchronous value', async () => {
    const { handleToolCall } = await importTools();
    const bodies: unknown[] = [];
    const client = {
      request: async (o: { body?: unknown }) => {
        bodies.push(o.body);
        return { success: true, data: {} };
      },
    };
    await handleToolCall(
      client as never,
      'call_api',
      { tool_name: 'create_user', args: { domain: 'd.com', user: '1001', synchronous: 'no' } },
      'system_admin',
    );
    expect((bodies[0] as Record<string, unknown>)?.synchronous).toBe('no');
  });

  it('leaves the body alone when MCP_SYNCHRONOUS_WRITES=false', async () => {
    process.env.MCP_SYNCHRONOUS_WRITES = 'false';
    const { handleToolCall } = await importTools();
    const bodies: unknown[] = [];
    const client = {
      request: async (o: { body?: unknown }) => {
        bodies.push(o.body);
        return { success: true, data: {} };
      },
    };
    await handleToolCall(
      client as never,
      'call_api',
      { tool_name: 'create_user', args: { domain: 'd.com', user: '1001' } },
      'system_admin',
    );
    expect((bodies[0] as Record<string, unknown>)?.synchronous).toBeUndefined();
  });

  it('does not add synchronous to a read', async () => {
    const { handleToolCall } = await importTools();
    const seen: Array<Record<string, unknown>> = [];
    const client = {
      request: async (o: Record<string, unknown>) => {
        seen.push(o);
        return { success: true, data: [] };
      },
    };
    await handleToolCall(client as never, 'call_api', { tool_name: 'get_users', args: { domain: 'd.com' } }, 'domain_admin');
    expect(seen[0]?.body).toBeUndefined();
  });
});

describe('provision_user', () => {
  beforeEach(clearEnv);

  it('runs user, device, and DID in order with synchronous writes', async () => {
    const { handleToolCall } = await importTools();
    const calls: Array<{ method: string; pathTemplate: string; body?: Record<string, unknown> }> = [];
    const client = {
      request: async (o: { method: string; pathTemplate: string; body?: Record<string, unknown> }) => {
        calls.push(o);
        return { success: true, data: {} };
      },
    };

    await handleToolCall(
      client as never,
      'provision_user',
      {
        domain: 'acme.com', user: '1001', first_name: 'Ada', last_name: 'Lovelace',
        email: 'ada@acme.com', device: '1001a', phone_number: '+13035551212',
      },
      'domain_admin',
    );

    const writes = calls.filter((c) => c.method === 'POST').map((c) => c.pathTemplate);
    expect(writes).toEqual([
      '/domains/{domain}/users',
      '/domains/{domain}/users/{user}/devices',
      '/domains/{domain}/phonenumbers',
    ]);
    expect(calls[0].body?.synchronous).toBe('yes');
    expect(calls[1].body?.synchronous).toBe('yes');
    // The DID is routed at the new user, which is what makes it reachable.
    expect(calls[2].body?.['dial-rule-translation-destination-user']).toBe('1001');
    // Ends with a read-back of the user it just created.
    expect(calls[calls.length - 1].method).toBe('GET');
  });

  it('stops after a failed user create rather than orphaning a device', async () => {
    const { handleToolCall } = await importTools();
    const calls: string[] = [];
    const client = {
      request: async (o: { pathTemplate: string }) => {
        calls.push(o.pathTemplate);
        return { success: false, error: '409 UID already exists.' };
      },
    };

    const res = (await handleToolCall(
      client as never,
      'provision_user',
      { user: '1001', first_name: 'A', last_name: 'B', email: 'a@b.com', device: '1001a', phone_number: '+13035551212' },
      'domain_admin',
    )) as { content: Array<{ text: string }> };

    expect(calls).toEqual(['/domains/{domain}/users']);
    const body = JSON.parse(res.content[0].text);
    expect(body.ok).toBe(false);
    expect(body.note).toMatch(/no device or phone number/i);
  });

  it('flags what is still unconfigured when only the user is created', async () => {
    const { handleToolCall } = await importTools();
    const client = { request: async () => ({ success: true, data: {} }) };
    const res = (await handleToolCall(
      client as never,
      'provision_user',
      { user: '1001', first_name: 'A', last_name: 'B', email: 'a@b.com' },
      'domain_admin',
    )) as { content: Array<{ text: string }> };

    const body = JSON.parse(res.content[0].text);
    expect(body.still_unconfigured.join(' ')).toMatch(/device/);
    expect(body.still_unconfigured.join(' ')).toMatch(/DID/);
  });
});

describe('deprovision_user', () => {
  beforeEach(clearEnv);

  /** A domain with one DID routed to 1001 and one queue membership for them. */
  function domainWithLeftovers() {
    const calls: Array<{ method: string; pathTemplate: string; pathParams?: Record<string, string> }> = [];
    const client = {
      request: async (o: { method: string; pathTemplate: string; pathParams?: Record<string, string> }) => {
        calls.push(o);
        if (o.pathTemplate === '/domains/{domain}/phonenumbers' && o.method === 'GET') {
          return {
            success: true,
            data: [
              { phonenumber: '+13035551212', 'dial-rule-translation-destination-user': '1001' },
              { phonenumber: '+13035559999', 'dial-rule-translation-destination-user': '1002' },
            ],
          };
        }
        if (o.pathTemplate === '/domains/{domain}/agents' && o.method === 'GET') {
          return {
            success: true,
            data: [
              { 'callqueue-agent-id': '1001@acme.com', callqueue: 'support' },
              { 'callqueue-agent-id': '1002@acme.com', callqueue: 'sales' },
            ],
          };
        }
        return { success: true, data: {} };
      },
    };
    return { client, calls };
  }

  it('deletes the user, then releases their DID and queue membership', async () => {
    const { handleToolCall } = await importTools();
    const { client, calls } = domainWithLeftovers();

    await handleToolCall(client as never, 'deprovision_user', { domain: 'acme.com', user: '1001' }, 'domain_admin');

    const deletes = calls.filter((c) => c.method === 'DELETE');
    expect(deletes.map((c) => c.pathTemplate)).toEqual([
      '/domains/{domain}/users/{user}',
      '/domains/{domain}/phonenumbers/{phonenumber}',
      '/domains/{domain}/callqueues/{callqueue}/agents/{callqueue-agent-id}',
    ]);
    // Only this user's leftovers — 1002's number and queue row are untouched.
    expect(deletes[1].pathParams?.phonenumber).toBe('+13035551212');
    expect(deletes[2].pathParams?.['callqueue-agent-id']).toBe('1001@acme.com');
    expect(deletes[2].pathParams?.callqueue).toBe('support');
  });

  it('dry_run reports the plan and writes nothing', async () => {
    const { handleToolCall } = await importTools();
    const { client, calls } = domainWithLeftovers();

    const res = (await handleToolCall(
      client as never,
      'deprovision_user',
      { domain: 'acme.com', user: '1001', dry_run: true },
      'domain_admin',
    )) as { content: Array<{ text: string }> };

    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    const body = JSON.parse(res.content[0].text);
    expect(body.dry_run).toBe(true);
    expect(body.plan.phone_numbers_to_release).toEqual(['+13035551212']);
    expect(body.plan.queue_memberships_to_remove).toEqual([{ queue: 'support', agent_id: '1001@acme.com' }]);
  });

  it('warns when the inventory read failed, so leftovers are not silently missed', async () => {
    const { handleToolCall } = await importTools();
    const client = {
      request: async (o: { method: string; pathTemplate: string }) => {
        if (o.method === 'GET') return { success: false, error: '403 forbidden' };
        return { success: true, data: {} };
      },
    };

    const res = (await handleToolCall(
      client as never,
      'deprovision_user',
      { domain: 'acme.com', user: '1001' },
      'domain_admin',
    )) as { content: Array<{ text: string }> };

    const body = JSON.parse(res.content[0].text);
    expect(body.inventory_warnings.length).toBe(2);
    expect(body.inventory_warnings.join(' ')).toMatch(/may still exist/);
  });

  it('is classified destructive so the confirm gate and disable toggle catch it', async () => {
    const { isToolDestructive } = await importTools();
    expect(isToolDestructive('deprovision_user')).toBe(true);
    expect(isToolDestructive('provision_user')).toBe(false);
  });
});

describe('provision_call_queue', () => {
  beforeEach(clearEnv);

  it('creates the queue, then adds each agent, then routes the DID', async () => {
    const { handleToolCall } = await importTools();
    const calls: Array<{ method: string; pathTemplate: string; body?: Record<string, unknown> }> = [];
    const client = {
      request: async (o: { method: string; pathTemplate: string; body?: Record<string, unknown> }) => {
        calls.push(o);
        return { success: true, data: {} };
      },
    };

    await handleToolCall(
      client as never,
      'provision_call_queue',
      { domain: 'acme.com', callqueue: 'support', agents: ['1001', '1002@acme.com'], phone_number: '+13035551212' },
      'domain_admin',
    );

    expect(calls.map((c) => c.pathTemplate)).toEqual([
      '/domains/{domain}/callqueues',
      '/domains/{domain}/callqueues/{callqueue}/agents',
      '/domains/{domain}/callqueues/{callqueue}/agents',
      '/domains/{domain}/phonenumbers',
    ]);
    expect(calls[0].body?.synchronous).toBe('yes');
    // Bare extensions get qualified; already-qualified ids are left alone.
    expect(calls[1].body?.['callqueue-agent-id']).toBe('1001@acme.com');
    expect(calls[2].body?.['callqueue-agent-id']).toBe('1002@acme.com');
    expect(calls[3].body?.['dial-rule-translation-destination-user']).toBe('support');
  });

  it('does not add agents when the queue itself failed', async () => {
    const { handleToolCall } = await importTools();
    const calls: string[] = [];
    const client = {
      request: async (o: { pathTemplate: string }) => {
        calls.push(o.pathTemplate);
        return { success: false, error: '409 already exists' };
      },
    };

    const res = (await handleToolCall(
      client as never,
      'provision_call_queue',
      { callqueue: 'support', agents: ['1001'] },
      'domain_admin',
    )) as { content: Array<{ text: string }> };

    expect(calls).toEqual(['/domains/{domain}/callqueues']);
    expect(JSON.parse(res.content[0].text).ok).toBe(false);
  });

  it('warns that an unstaffed queue answers nothing', async () => {
    const { handleToolCall } = await importTools();
    const client = { request: async () => ({ success: true, data: {} }) };
    const res = (await handleToolCall(
      client as never,
      'provision_call_queue',
      { callqueue: 'support' },
      'domain_admin',
    )) as { content: Array<{ text: string }> };

    const missing = JSON.parse(res.content[0].text).still_unconfigured.join(' ');
    expect(missing).toMatch(/no agents/);
    expect(missing).toMatch(/no DID/);
  });
});

describe('deprovision_call_queue', () => {
  beforeEach(clearEnv);

  function queueWithLeftovers() {
    const calls: Array<{ method: string; pathTemplate: string; pathParams?: Record<string, string> }> = [];
    const client = {
      request: async (o: { method: string; pathTemplate: string; pathParams?: Record<string, string> }) => {
        calls.push(o);
        if (o.method === 'GET' && o.pathTemplate.endsWith('/agents')) {
          return { success: true, data: [{ 'callqueue-agent-id': '1001@acme.com' }, { 'callqueue-agent-id': '1002@acme.com' }] };
        }
        if (o.method === 'GET' && o.pathTemplate === '/domains/{domain}/phonenumbers') {
          return {
            success: true,
            data: [
              { phonenumber: '+13035551212', 'dial-rule-translation-destination-user': 'support' },
              { phonenumber: '+13035559999', 'dial-rule-translation-destination-user': 'sales' },
            ],
          };
        }
        return { success: true, data: {} };
      },
    };
    return { client, calls };
  }

  it('removes agents before the queue, then releases the DID', async () => {
    const { handleToolCall } = await importTools();
    const { client, calls } = queueWithLeftovers();

    await handleToolCall(client as never, 'deprovision_call_queue', { domain: 'acme.com', callqueue: 'support' }, 'domain_admin');

    const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => c.pathTemplate);
    // Agents first — once the queue row is gone their endpoint has no queue to address.
    expect(deletes).toEqual([
      '/domains/{domain}/callqueues/{callqueue}/agents/{callqueue-agent-id}',
      '/domains/{domain}/callqueues/{callqueue}/agents/{callqueue-agent-id}',
      '/domains/{domain}/callqueues/{callqueue}',
      '/domains/{domain}/phonenumbers/{phonenumber}',
    ]);
    const released = calls.filter((c) => c.pathTemplate === '/domains/{domain}/phonenumbers/{phonenumber}');
    expect(released[0].pathParams?.phonenumber).toBe('+13035551212');
  });

  it('dry_run reports agents and numbers without deleting', async () => {
    const { handleToolCall } = await importTools();
    const { client, calls } = queueWithLeftovers();

    const res = (await handleToolCall(
      client as never,
      'deprovision_call_queue',
      { domain: 'acme.com', callqueue: 'support', dry_run: true },
      'domain_admin',
    )) as { content: Array<{ text: string }> };

    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    const plan = JSON.parse(res.content[0].text).plan;
    expect(plan.agents_to_remove).toEqual(['1001@acme.com', '1002@acme.com']);
    expect(plan.phone_numbers_to_release).toEqual(['+13035551212']);
  });

  it('is classified destructive', async () => {
    const { isToolDestructive } = await importTools();
    expect(isToolDestructive('deprovision_call_queue')).toBe(true);
    expect(isToolDestructive('provision_call_queue')).toBe(false);
  });
});
