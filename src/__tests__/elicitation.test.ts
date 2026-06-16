/**
 * Tests for the destructive-tool confirmation gate (MCP_CONFIRM_DESTRUCTIVE).
 *
 * Uses a fake Server with a recordable elicitInput so we can assert what the
 * user sees and how the dispatcher reacts to accept / decline / cancel /
 * missing capability.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

type ElicitResponse =
  | { action: 'accept'; content?: Record<string, unknown> }
  | { action: 'decline' }
  | { action: 'cancel' }
  | { throwUnsupported: true };

function makeFakeServer(response: ElicitResponse) {
  const elicitInput = vi.fn(async () => {
    if ('throwUnsupported' in response) {
      // Mirror what the SDK throws when the connected client doesn't advertise
      // the elicitation capability — an MCP error with a non-InvalidParams
      // code is what our elicitation helper treats as "unsupported."
      const { McpError, ErrorCode } = await import('@modelcontextprotocol/sdk/types.js');
      throw new McpError(ErrorCode.InvalidRequest, 'Elicitation not supported by client');
    }
    return response;
  });
  // Stub a minimal Server-like object that registerAllTools can attach handlers to.
  const handlers = new Map<unknown, (req: unknown) => Promise<unknown>>();
  const server = {
    elicitInput,
    setRequestHandler: (schema: unknown, handler: (req: unknown) => Promise<unknown>) => {
      handlers.set(schema, handler);
    },
  } as unknown as Server;
  return { server, elicitInput, handlers };
}

async function importTools() {
  vi.resetModules();
  return import('../tools/index.js');
}

function clearEnv() {
  delete process.env.MCP_CONFIRM_DESTRUCTIVE;
  delete process.env.MCP_CONFIRM_FALLBACK;
  delete process.env.MCP_DISABLE_DESTRUCTIVE;
  delete process.env.MCP_DISABLED_TOOLS;
  delete process.env.MCP_TOOL_MODE;
}

describe('MCP_CONFIRM_DESTRUCTIVE — elicitation gate', () => {
  beforeEach(clearEnv);

  it('prompts the user before a destructive composite (end_call) and proceeds on accept', async () => {
    process.env.MCP_CONFIRM_DESTRUCTIVE = 'true';
    const { registerAllTools } = await importTools();
    const { server, elicitInput, handlers } = makeFakeServer({ action: 'accept', content: { confirm: 'yes' } });

    const fakeClient = { request: vi.fn(async () => ({ success: true, data: { ok: true } })) };
    registerAllTools(server, fakeClient as never, 'domain_admin');

    const callHandler = handlers.get(CallToolRequestSchema) as (req: unknown) => Promise<unknown>;
    await callHandler({ params: { name: 'end_call', arguments: { call_id: 'c-1' } } });

    expect(elicitInput).toHaveBeenCalledOnce();
    const call = elicitInput.mock.calls[0][0] as { message: string; requestedSchema: { properties: { confirm: { enum: string[] } } } };
    expect(call.message).toContain('end_call');
    expect(call.message).toContain('c-1');
    expect(call.requestedSchema.properties.confirm.enum).toEqual(['yes', 'no']);
    expect(fakeClient.request).toHaveBeenCalled();
  });

  it('rejects the call when the user declines', async () => {
    process.env.MCP_CONFIRM_DESTRUCTIVE = 'true';
    const { registerAllTools } = await importTools();
    const { server, handlers } = makeFakeServer({ action: 'decline' });

    const fakeClient = { request: vi.fn(async () => ({ success: true })) };
    registerAllTools(server, fakeClient as never, 'domain_admin');

    const callHandler = handlers.get(CallToolRequestSchema) as (req: unknown) => Promise<unknown>;
    await expect(callHandler({ params: { name: 'end_call', arguments: { call_id: 'x' } } })).rejects.toThrow(/declined/i);
    expect(fakeClient.request).not.toHaveBeenCalled();
  });

  it('rejects the call when the user picks "no" inside an accepted form', async () => {
    process.env.MCP_CONFIRM_DESTRUCTIVE = 'true';
    const { registerAllTools } = await importTools();
    const { server, handlers } = makeFakeServer({ action: 'accept', content: { confirm: 'no' } });

    const fakeClient = { request: vi.fn(async () => ({ success: true })) };
    registerAllTools(server, fakeClient as never, 'domain_admin');

    const callHandler = handlers.get(CallToolRequestSchema) as (req: unknown) => Promise<unknown>;
    await expect(callHandler({ params: { name: 'end_call', arguments: { call_id: 'x' } } })).rejects.toThrow(/declined/i);
    expect(fakeClient.request).not.toHaveBeenCalled();
  });

  it('does NOT prompt for a non-destructive composite (find_user)', async () => {
    process.env.MCP_CONFIRM_DESTRUCTIVE = 'true';
    const { registerAllTools } = await importTools();
    const { server, elicitInput, handlers } = makeFakeServer({ action: 'accept', content: { confirm: 'yes' } });

    const fakeClient = { request: vi.fn(async () => ({ success: true, data: [] })) };
    registerAllTools(server, fakeClient as never, 'user');

    const callHandler = handlers.get(CallToolRequestSchema) as (req: unknown) => Promise<unknown>;
    await callHandler({ params: { name: 'find_user', arguments: { query: 'alice' } } });

    expect(elicitInput).not.toHaveBeenCalled();
    expect(fakeClient.request).toHaveBeenCalled();
  });

  it('does NOT prompt when MCP_CONFIRM_DESTRUCTIVE is unset', async () => {
    const { registerAllTools } = await importTools();
    const { server, elicitInput, handlers } = makeFakeServer({ action: 'accept', content: { confirm: 'yes' } });

    const fakeClient = { request: vi.fn(async () => ({ success: true })) };
    registerAllTools(server, fakeClient as never, 'domain_admin');

    const callHandler = handlers.get(CallToolRequestSchema) as (req: unknown) => Promise<unknown>;
    await callHandler({ params: { name: 'end_call', arguments: { call_id: 'x' } } });

    expect(elicitInput).not.toHaveBeenCalled();
    expect(fakeClient.request).toHaveBeenCalled();
  });

  it('MCP_DISABLE_DESTRUCTIVE wins over MCP_CONFIRM_DESTRUCTIVE — never even prompts', async () => {
    process.env.MCP_DISABLE_DESTRUCTIVE = 'true';
    process.env.MCP_CONFIRM_DESTRUCTIVE = 'true';
    const { registerAllTools } = await importTools();
    const { server, elicitInput, handlers } = makeFakeServer({ action: 'accept', content: { confirm: 'yes' } });

    const fakeClient = { request: vi.fn(async () => ({ success: true })) };
    registerAllTools(server, fakeClient as never, 'domain_admin');

    const callHandler = handlers.get(CallToolRequestSchema) as (req: unknown) => Promise<unknown>;
    await expect(callHandler({ params: { name: 'end_call', arguments: { call_id: 'x' } } })).rejects.toThrow(/destructive/i);
    expect(elicitInput).not.toHaveBeenCalled();
    expect(fakeClient.request).not.toHaveBeenCalled();
  });

  it('fails closed when the client does not support elicitation (default fallback)', async () => {
    process.env.MCP_CONFIRM_DESTRUCTIVE = 'true';
    const { registerAllTools } = await importTools();
    const { server, handlers } = makeFakeServer({ throwUnsupported: true });

    const fakeClient = { request: vi.fn(async () => ({ success: true })) };
    registerAllTools(server, fakeClient as never, 'domain_admin');

    const callHandler = handlers.get(CallToolRequestSchema) as (req: unknown) => Promise<unknown>;
    await expect(callHandler({ params: { name: 'end_call', arguments: { call_id: 'x' } } })).rejects.toThrow(
      /does not support confirmation/i,
    );
    expect(fakeClient.request).not.toHaveBeenCalled();
  });

  it('MCP_CONFIRM_FALLBACK=allow lets the call through on unsupported clients', async () => {
    process.env.MCP_CONFIRM_DESTRUCTIVE = 'true';
    process.env.MCP_CONFIRM_FALLBACK = 'allow';
    const { registerAllTools } = await importTools();
    const { server, handlers } = makeFakeServer({ throwUnsupported: true });

    const fakeClient = { request: vi.fn(async () => ({ success: true })) };
    registerAllTools(server, fakeClient as never, 'domain_admin');

    const callHandler = handlers.get(CallToolRequestSchema) as (req: unknown) => Promise<unknown>;
    await callHandler({ params: { name: 'end_call', arguments: { call_id: 'x' } } });
    expect(fakeClient.request).toHaveBeenCalled();
  });
});
