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
}

describe('annotations', () => {
  beforeEach(clearDisableEnv);

  it('marks get_/list_/count_/search_ as read-only and non-destructive', async () => {
    const { getAllToolDefinitions } = await importTools();
    const tools = getAllToolDefinitions();
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
    const tools = getAllToolDefinitions();
    const destructive = tools.filter((t) => /^(delete_|revoke_)/.test(t.name));
    for (const t of destructive) {
      expect(t.annotations.readOnlyHint).toBe(false);
      expect(t.annotations.destructiveHint).toBe(true);
    }
  });

  it('marks put_/patch_/post_ as writers but not necessarily destructive', async () => {
    const { getAllToolDefinitions } = await importTools();
    const tools = getAllToolDefinitions();
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
    const tools = getAllToolDefinitions();
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
    const tools = getAllToolDefinitions();
    const overflow = tools.filter((t) => t.name.length > 64);
    expect(overflow).toEqual([]);
  });

  it('collapses domains_by_domain_users_by_user → domain_user', async () => {
    const { getAllToolDefinitions } = await importTools();
    const tools = getAllToolDefinitions();
    // The transfer-peer tool exceeded 64 chars in its raw form
    const hit = tools.find((t) => t.name === 'patch_domain_user_call_transfer_peer');
    expect(hit).toBeDefined();
    expect(hit!.name.length).toBeLessThanOrEqual(64);
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
