/**
 * P2, v1 delete actions. A v1 action that deletes, removes, ends or resets is destructive whatever its object, so deny
 * @destructive refuses it at the tool layer (its group) and at the operation layer (the guard judges it as the DELETE it
 * performs). Under access read it is refused as a non-read action. Each refusal asserts that the fake saw no /ns-api/
 * request: the fake logs a request before it routes it.
 */
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getToolCatalogView } from '../access/groups.js';
import { compilePolicy, type CompiledPolicy } from '../access/policy.js';
import { v1OperationKeyOf } from '../governance/content-operations.js';
import { v1ToolRegistry } from '../generated/v1/registry.js';
import { createGuardedClient, createOperationGate, OperationRefusedError } from '../netsapiens/guarded-client.js';
import { NetSapiensClient } from '../netsapiens-client.js';
import { handleToolCall } from '../tools/index.js';
import { policyOf, startFake, type FakeNetSapiens } from './support/enforcement-harness.js';

const HOME = { home: 'example.com', judge: async () => ({ kind: 'allow' as const }) };
const DESTRUCTIVE_VERBS = ['delete', 'remove', 'destroy', 'cancel', 'revoke', 'reset', 'restart', 'reboot', 'restore', 'purge', 'clear', 'terminate'];
const NON_DESTRUCTIVE_VERBS = ['create', 'read', 'list', 'update', 'play', 'send'];

let fake: FakeNetSapiens;

beforeAll(async () => {
  fake = await startFake();
});

afterAll(async () => {
  await fake.close();
});

const client = () => new NetSapiensClient({ apiUrl: fake.origin, apiToken: 'test-token' });
const compiled = (overrides: Parameters<typeof policyOf>[0]): CompiledPolicy => compilePolicy(policyOf(overrides), getToolCatalogView(), 'rev-p2');
const v1Requests = (mark: number): number => fake.requests.slice(mark).filter((request) => request.path === '/ns-api/').length;

/** A client that records every call it is asked to send. A refused call must leave the list empty. */
function recordingClient(): { client: NetSapiensClient; calls: string[] } {
  const calls: string[] = [];
  const raw = {
    async request(opts: { method: string; pathTemplate: string }) {
      calls.push(`${opts.method} ${opts.pathTemplate}`);
      return { success: true };
    },
    async v1Call(object: string, action: string) {
      calls.push(`v1:${object}:${action}`);
      return { success: true };
    },
  };
  return { client: raw as unknown as NetSapiensClient, calls };
}

/** Resolves to the rejection an operation raises, or to undefined when it resolves. */
function refusalOf(pending: Promise<unknown>): Promise<unknown> {
  return pending.then(
    () => undefined,
    (caught: unknown) => caught,
  );
}

describe('P2 v1 delete actions: the tool layer', () => {
  it('refuses a v1 delete reached through call_api under deny @destructive, with no /ns-api/ request', async () => {
    const mark = fake.requests.length;
    await expect(
      handleToolCall(client(), 'call_api', { tool_name: 'v1_message_delete', args: {} }, 'domain_admin', 'alice', undefined, compiled({ tools: { allow: ['*'], deny: ['@destructive'] } }), HOME),
    ).rejects.toBeInstanceOf(McpError);
    expect(v1Requests(mark)).toBe(0);
  });

  it('refuses the same v1 delete under access read, with no /ns-api/ request', async () => {
    const mark = fake.requests.length;
    await expect(
      handleToolCall(client(), 'call_api', { tool_name: 'v1_message_delete', args: {} }, 'domain_admin', 'alice', undefined, compiled({ access: 'read' }), HOME),
    ).rejects.toBeInstanceOf(McpError);
    expect(v1Requests(mark)).toBe(0);
  });

  it('control: with nothing denied the same v1 delete reaches /ns-api/ once', async () => {
    const mark = fake.requests.length;
    await handleToolCall(client(), 'call_api', { tool_name: 'v1_message_delete', args: {} }, 'domain_admin', 'alice', undefined, compiled({}), HOME).catch(() => undefined);
    expect(v1Requests(mark)).toBe(1);
  });

  it('every generated v1 tool with a destructive action carries @destructive in the catalog', () => {
    const destructive: string[] = [];
    for (const [name, def] of v1ToolRegistry) {
      const action = v1OperationKeyOf(def.operation?.key ?? '')?.split(':')[2] ?? '';
      if (DESTRUCTIVE_VERBS.some((verb) => action.startsWith(verb))) destructive.push(name);
    }
    expect(destructive.length).toBeGreaterThan(0);
    for (const name of destructive) expect(getToolCatalogView().lookupTool(name)?.groups).toContain('@destructive');
  });

  it('carries @destructive on the two delete actions that do not lead with the verb', () => {
    expect(getToolCatalogView().lookupTool('v1_audio_link_delete')?.groups).toContain('@destructive');
    expect(getToolCatalogView().lookupTool('v1_callrequest_delete')?.groups).toContain('@destructive');
  });
});

describe('P2 v1 delete actions: the operation guard judges a destructive v1 action as a DELETE', () => {
  it.each(DESTRUCTIVE_VERBS)('refuses v1 action %s under deny @destructive, with zero requests', async (verb) => {
    const raw = recordingClient();
    const gate = createOperationGate({ policy: compiled({ tools: { allow: ['*'], deny: ['@destructive'] } }), foreignStrip: new Set() });
    const error = await refusalOf(createGuardedClient(raw.client, undefined, { gate }).v1Call('thing', verb, {}));
    expect(error).toBeInstanceOf(OperationRefusedError);
    expect((error as OperationRefusedError).reason).toBe('destructive');
    expect(raw.calls).toEqual([]);
  });

  it.each(['link_delete', 'delWakeUp'])('refuses v1 action %s, a delete that does not lead with its verb, under deny @destructive', async (action) => {
    const raw = recordingClient();
    const gate = createOperationGate({ policy: compiled({ tools: { allow: ['*'], deny: ['@destructive'] } }), foreignStrip: new Set() });
    const error = await refusalOf(createGuardedClient(raw.client, undefined, { gate }).v1Call('thing', action, {}));
    expect(error).toBeInstanceOf(OperationRefusedError);
    expect((error as OperationRefusedError).reason).toBe('destructive');
    expect(raw.calls).toEqual([]);
  });

  it.each(['deliver', 'deliveryStatus', 'delay'])('sends v1 action %s under deny @destructive: a del prefix alone is not a delete (control)', async (action) => {
    const raw = recordingClient();
    const gate = createOperationGate({ policy: compiled({ tools: { allow: ['*'], deny: ['@destructive'] } }), foreignStrip: new Set() });
    await createGuardedClient(raw.client, undefined, { gate }).v1Call('thing', action, {});
    expect(raw.calls).toEqual([`v1:thing:${action}`]);
  });

  it.each(NON_DESTRUCTIVE_VERBS)('sends v1 action %s under deny @destructive (control)', async (verb) => {
    const raw = recordingClient();
    const gate = createOperationGate({ policy: compiled({ tools: { allow: ['*'], deny: ['@destructive'] } }), foreignStrip: new Set() });
    await createGuardedClient(raw.client, undefined, { gate }).v1Call('thing', verb, {});
    expect(raw.calls).toEqual([`v1:thing:${verb}`]);
  });

  it.each(DESTRUCTIVE_VERBS)('refuses v1 action %s under access read, with zero requests', async (verb) => {
    const raw = recordingClient();
    const gate = createOperationGate({ policy: compiled({ access: 'read' }), foreignStrip: new Set() });
    const error = await refusalOf(createGuardedClient(raw.client, undefined, { gate }).v1Call('thing', verb, {}));
    expect(error).toBeInstanceOf(OperationRefusedError);
    expect(raw.calls).toEqual([]);
  });
});
