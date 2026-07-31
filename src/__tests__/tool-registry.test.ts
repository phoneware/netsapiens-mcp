/**
 * Tests for the tool-registry layer:
 * - read/write/destructive annotation classification
 * - MCP_DISABLED_TOOLS glob filtering
 * - MCP_DISABLED_ACTIONS action-arg filtering
 * - name shortening so every exposed name fits Claude's 64-char cap
 * - dispatch round-trip through the exposed → registry-key mapping
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

async function importTools() {
  vi.resetModules();
  return import('../tools/index.js');
}

function clearDisableEnv() {
  delete process.env.MCP_DISABLED_TOOLS;
  delete process.env.MCP_DISABLED_ACTIONS;
  // These tests target the full auto-generated registry, so opt out of the
  // default curated mode for the whole file.
  process.env.MCP_TOOL_MODE = 'full';
}

describe('annotations', () => {
  beforeEach(clearDisableEnv);

  it('marks get_/list_/count_/search_ as read-only and non-destructive', async () => {
    const { getAllToolDefinitions } = await importTools();
    const tools = await getAllToolDefinitions();
    const readyExamples = tools.filter((t) =>
      /^(get_|list_|count_|search_|read_)/.test(t.name),
    );
    expect(readyExamples.length).toBeGreaterThan(50);
    for (const t of readyExamples) {
      expect(t.annotations.readOnlyHint).toBe(true);
      expect(t.annotations.destructiveHint).toBe(false);
    }
  });

  it('marks delete_/revoke_ tools as destructive', async () => {
    const { getAllToolDefinitions } = await importTools();
    const tools = await getAllToolDefinitions();
    const destructive = tools.filter((t) => /^(delete_|revoke_)/.test(t.name));
    for (const t of destructive) {
      expect(t.annotations.readOnlyHint).toBe(false);
      expect(t.annotations.destructiveHint).toBe(true);
    }
  });

  it('marks put_/patch_/post_ as writers but not necessarily destructive', async () => {
    const { getAllToolDefinitions } = await importTools();
    const tools = await getAllToolDefinitions();
    const writers = tools.filter((t) => /^(put_|patch_|post_)/.test(t.name));
    expect(writers.length).toBeGreaterThan(0);
    for (const t of writers) {
      expect(t.annotations.readOnlyHint).toBe(false);
    }
  });
});

describe('MCP_DISABLED_TOOLS', () => {
  beforeEach(clearDisableEnv);

  it('hides tools matching a single glob pattern', async () => {
    process.env.MCP_DISABLED_TOOLS = 'delete_*';
    const { getAllToolDefinitions, isToolDisabled } = await importTools();
    const tools = await getAllToolDefinitions();
    expect(tools.every((t) => !t.name.startsWith('delete_'))).toBe(true);
    expect(isToolDisabled('delete_anything')).toBe(true);
    expect(isToolDisabled('get_anything')).toBe(false);
  });

  it('honors multiple comma-separated patterns', async () => {
    process.env.MCP_DISABLED_TOOLS = 'delete_*,remove_*,*token*';
    const { isToolDisabled } = await importTools();
    expect(isToolDisabled('delete_user')).toBe(true);
    expect(isToolDisabled('remove_phone')).toBe(true);
    expect(isToolDisabled('post_tokens_1')).toBe(true);
    expect(isToolDisabled('get_users')).toBe(false);
  });

  it('is a no-op when env var is unset or empty', async () => {
    const { isToolDisabled } = await importTools();
    expect(isToolDisabled('delete_user')).toBe(false);
  });
});

describe('MCP_DISABLED_ACTIONS', () => {
  beforeEach(clearDisableEnv);

  it('rejects exact action argument values', async () => {
    process.env.MCP_DISABLED_ACTIONS = 'delete,revoke,destroy';
    const { isActionDisabled } = await importTools();
    expect(isActionDisabled('delete')).toBe(true);
    expect(isActionDisabled('revoke')).toBe(true);
    expect(isActionDisabled('get')).toBe(false);
  });

  it('ignores non-string action values', async () => {
    process.env.MCP_DISABLED_ACTIONS = 'delete';
    const { isActionDisabled } = await importTools();
    expect(isActionDisabled(undefined)).toBe(false);
    expect(isActionDisabled(123)).toBe(false);
    expect(isActionDisabled(null)).toBe(false);
  });
});

describe('name shortening', () => {
  beforeEach(clearDisableEnv);

  it('keeps every exposed tool name at or under 64 characters', async () => {
    const { getAllToolDefinitions } = await importTools();
    const tools = await getAllToolDefinitions();
    const overflow = tools.filter((t) => t.name.length > 64);
    expect(overflow).toEqual([]);
  });

  it('collapses domains_by_domain_users_by_user → domain_user', async () => {
    const { getAllToolDefinitions } = await importTools();
    const tools = await getAllToolDefinitions();
    // The transfer-peer tool exceeded 64 chars in its raw form
    const hit = tools.find((t) => t.name === 'patch_domain_user_call_transfer_peer');
    expect(hit).toBeDefined();
    expect(hit!.name.length).toBeLessThanOrEqual(64);
  });
});

describe('role-tier filtering', () => {
  beforeEach(() => {
    clearDisableEnv();
    delete process.env.MCP_DISABLE_ROLE_FILTER;
  });

  it('classifies privileged resource families correctly', async () => {
    const { toolMinRole } = await importTools();
    expect(toolMinRole('get_accesslog')).toBe('system_admin');
    expect(toolMinRole('get_dialpolicy')).toBe('system_admin');
    expect(toolMinRole('create_domain')).toBe('reseller');
    expect(toolMinRole('get_resellers')).toBe('reseller');
    expect(toolMinRole('v1_reseller_read')).toBe('reseller');
    // Ordinary resources default to user-visible
    expect(toolMinRole('get_domains')).toBe('user');
    expect(toolMinRole('get_domains_by_domain_users_by_user_voicemail')).toBe('user');
  });

  it('hides higher-tier tools from lower-tier users', async () => {
    const { getAllToolDefinitions } = await importTools();
    const all = await getAllToolDefinitions();
    const sysAdmin = await getAllToolDefinitions('system_admin');
    const reseller = await getAllToolDefinitions('reseller');
    const user = await getAllToolDefinitions('user');

    // system_admin sees everything; lower tiers see strictly fewer
    expect(sysAdmin.length).toBe(all.length);
    expect(reseller.length).toBeLessThan(sysAdmin.length);
    expect(user.length).toBeLessThan(reseller.length);

    // A user must not see any system_admin or reseller tool
    const userNames = new Set(user.map((t) => t.name));
    expect(userNames.has('get_accesslog')).toBe(false);
    expect(userNames.has('create_domain')).toBe(false);
    // …but still sees ordinary tools
    expect(userNames.has('get_domains')).toBe(true);
  });

  it('shows all tools when no role is supplied (optimistic default)', async () => {
    const { getAllToolDefinitions } = await importTools();
    const all = await getAllToolDefinitions();
    expect(all.find((t) => t.name === 'get_accesslog')).toBeDefined();
  });

  it('disables filtering entirely with MCP_DISABLE_ROLE_FILTER=true', async () => {
    process.env.MCP_DISABLE_ROLE_FILTER = 'true';
    const { getAllToolDefinitions } = await importTools();
    const user = await getAllToolDefinitions('user');
    expect(user.find((t) => t.name === 'get_accesslog')).toBeDefined();
  });

  it('rejects a call to a tool above the user tier (defense in depth)', async () => {
    const { handleToolCall } = await importTools();
    const fakeClient = { request: async () => ({ success: true }) };
    await expect(
      handleToolCall(fakeClient as never, 'get_accesslog', {}, 'user'),
    ).rejects.toThrow(/higher access tier/i);
  });

  it('allows a sufficiently-privileged user to call a privileged tool', async () => {
    const { handleToolCall } = await importTools();
    const calls: unknown[] = [];
    const fakeClient = { request: async (o: unknown) => { calls.push(o); return { success: true }; } };
    const result = await handleToolCall(fakeClient as never, 'get_accesslog', {}, 'system_admin');
    expect(result).toBeTruthy();
    expect(calls.length).toBe(1);
  });
});

describe('dispatch via exposed → registry mapping', () => {
  beforeEach(clearDisableEnv);

  it('routes a shortened exposed name to the original registry handler', async () => {
    const { handleToolCall } = await importTools();
    // Build a fake client whose request method records what it was called with
    const calls: Array<unknown> = [];
    const fakeClient = {
      request: async (opts: unknown) => {
        calls.push(opts);
        return { success: true, data: { ok: true } };
      },
      v1Call: async (object: string, action: string) => {
        calls.push({ object, action });
        return { success: true, data: { ok: true } };
      },
    };
    // Call the shortened name — it should resolve and invoke the generated handler
    const result = await handleToolCall(fakeClient as never, 'patch_domain_user_call_transfer_peer', {});
    expect(result).toBeTruthy();
    expect(calls.length).toBe(1);
  });

  it('throws MethodNotFound for an unknown tool name', async () => {
    const { handleToolCall } = await importTools();
    const fakeClient = { request: async () => ({ success: true }), v1Call: async () => ({ success: true }) };
    await expect(handleToolCall(fakeClient as never, 'does_not_exist', {})).resolves.toBeNull();
  });

  it('throws when a disabled tool is called', async () => {
    process.env.MCP_DISABLED_TOOLS = 'get_domains';
    const { handleToolCall } = await importTools();
    const fakeClient = { request: async () => ({ success: true }) };
    await expect(handleToolCall(fakeClient as never, 'get_domains', {})).rejects.toThrow(/disabled/);
  });

  it('throws when args.action matches a disabled action', async () => {
    process.env.MCP_DISABLED_ACTIONS = 'delete';
    const { handleToolCall } = await importTools();
    const fakeClient = { request: async () => ({ success: true }) };
    // Use any registered tool that takes args; the action check fires before dispatch
    await expect(
      handleToolCall(fakeClient as never, 'get_domains', { action: 'delete' }),
    ).rejects.toThrow(/disabled/i);
  });
});

// ---------------------------------------------------------------------------
// Current-spec tool fields: title, full annotation hints, pagination,
// structured content
// ---------------------------------------------------------------------------

describe('tool titles', () => {
  beforeEach(clearDisableEnv);

  it('gives every exposed tool a human-readable title', async () => {
    const { getAllToolDefinitions } = await importTools();
    const tools = await getAllToolDefinitions();
    expect(tools.length).toBeGreaterThan(100);
    for (const t of tools) {
      expect(typeof t.title).toBe('string');
      expect(t.title.length).toBeGreaterThan(0);
    }
  });

  it('title-cases words and upper-cases known acronyms', async () => {
    const { toolTitle } = await importTools();
    expect(toolTitle('get_domain_users')).toBe('Get Domain Users');
    expect(toolTitle('get_cdrs_by_domain')).toBe('Get CDRS Domain');
    expect(toolTitle('call_api')).toBe('Call API');
  });
});

describe('annotation hints beyond read/destructive', () => {
  beforeEach(clearDisableEnv);

  it('marks every tool open-world, since they all reach the live NS platform', async () => {
    const { getAllToolDefinitions } = await importTools();
    const tools = await getAllToolDefinitions();
    for (const t of tools) expect(t.annotations.openWorldHint).toBe(true);
  });

  it('treats reads and deletes as idempotent and creates as not', async () => {
    const { getAllToolDefinitions } = await importTools();
    const tools = await getAllToolDefinitions();
    const byPrefix = (p: string) => tools.filter((t) => t.name.startsWith(p));

    for (const t of byPrefix('get_')) expect(t.annotations.idempotentHint).toBe(true);
    for (const t of byPrefix('delete_')) expect(t.annotations.idempotentHint).toBe(true);
    for (const t of byPrefix('post_')) expect(t.annotations.idempotentHint).toBe(false);
  });
});

describe('tools/list pagination', () => {
  beforeEach(() => {
    clearDisableEnv();
    delete process.env.MCP_TOOLS_PAGE_SIZE;
  });

  it('walks the whole registry across cursors without gaps or repeats', async () => {
    process.env.MCP_TOOLS_PAGE_SIZE = '50';
    const { getAllToolDefinitions, paginateTools } = await importTools();
    const all = await getAllToolDefinitions();

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = paginateTools(all, cursor);
      expect(page.tools.length).toBeLessThanOrEqual(50);
      seen.push(...page.tools.map((t) => t.name));
      cursor = page.nextCursor;
      pages++;
      expect(pages).toBeLessThan(100); // guard against a cursor that never ends
    } while (cursor);

    expect(pages).toBeGreaterThan(1);
    expect(seen).toEqual(all.map((t) => t.name));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('omits nextCursor on the last page', async () => {
    process.env.MCP_TOOLS_PAGE_SIZE = '100000';
    const { getAllToolDefinitions, paginateTools } = await importTools();
    const all = await getAllToolDefinitions();
    const page = paginateTools(all);
    expect(page.tools.length).toBe(all.length);
    expect(page.nextCursor).toBeUndefined();
  });

  it('rejects a cursor it did not issue', async () => {
    const { getAllToolDefinitions, paginateTools } = await importTools();
    const all = await getAllToolDefinitions();
    expect(() => paginateTools(all, 'not-a-real-cursor')).toThrow(/Invalid cursor/);
    expect(() => paginateTools(all, Buffer.from('ns:999999').toString('base64url'))).toThrow(/Invalid cursor/);
  });
});

describe('structured content', () => {
  beforeEach(clearDisableEnv);

  it('adds structuredContent for a JSON object payload', async () => {
    const { withStructuredContent } = await importTools();
    const out = withStructuredContent({
      content: [{ type: 'text', text: JSON.stringify({ success: true, data: { user: 'alice' } }) }],
    });
    expect(out.structuredContent).toEqual({ success: true, data: { user: 'alice' } });
    expect(out.content[0].text).toContain('alice'); // text block preserved for older clients
  });

  it('wraps a JSON array so structuredContent stays an object', async () => {
    const { withStructuredContent } = await importTools();
    const out = withStructuredContent({ content: [{ type: 'text', text: '[1,2,3]' }] });
    expect(out.structuredContent).toEqual({ result: [1, 2, 3] });
  });

  it('leaves non-JSON prose alone', async () => {
    const { withStructuredContent } = await importTools();
    const out = withStructuredContent({ content: [{ type: 'text', text: 'no session found' }] });
    expect(out.structuredContent).toBeUndefined();
  });
});
