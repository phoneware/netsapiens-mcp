import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import Ajv, { type ValidateFunction } from 'ajv';
import { callsRoute, addCall, getCallsList } from '../../scripts/fake-netsapiens/routes/calls.mjs';
import { NetSapiensClient } from '../netsapiens-client.js';
import { CURATED_CATALOG } from '../tools/curated/catalog.js';
import type { GenericApiClient } from '../generated/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const activeFakes: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (activeFakes.length > 0) {
    const fake = activeFakes.pop();
    if (fake) await fake.close();
  }
});

describe('transfer_call (Contract C7)', () => {
  const transferCallTool = CURATED_CATALOG.find((t) => t.schema.name === 'transfer_call')!;

  it('1. Blind sends {"call-term-user": "<to>"} and fake state shows transfer', async () => {
    const fake = await startFakeNetSapiens({
      apiVersion: '44.4.10',
      tokens: { 'test-token': { user: '1001', domain: 'example.com' } },
      routeModules: [callsRoute],
    });
    activeFakes.push(fake);

    addCall(fake.state, {
      call_id: 'call-100',
      'call-session-id': 'sess-100',
      'core-server': 'core1.example.com',
      user: '1001',
      domain: 'example.com',
      status: 'active',
    });

    const client = new NetSapiensClient({ apiUrl: fake.origin, apiToken: 'test-token' });

    const result = await transferCallTool.handler(
      { call_id: 'call-100', to: '1002' },
      client as unknown as GenericApiClient,
      'domain_admin',
    );

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);

    // Verify request logged
    const patchReq = fake.requests.find((r) => r.method === 'PATCH');
    expect(patchReq).toBeDefined();
    expect(patchReq!.path).toBe('/ns-api/v2/domains/~/users/~/calls/call-100/transfer');
    expect(patchReq!.body).toEqual({ 'call-term-user': '1002' });

    // Verify state in fake shows transfer
    const calls = getCallsList(fake.state);
    const transferredCall = calls.find((c) => c.call_id === 'call-100');
    expect(transferredCall).toBeDefined();
    expect(transferredCall!['call-term-user']).toBe('1002');
    expect(transferredCall!.status).toBe('transferred');
    expect(transferredCall!.transferType).toBe('blind');
    expect(fake.state.transfers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'blind',
          callId: 'call-100',
          to: '1002',
        }),
      ]),
    );
  });

  it('2. Attended reads consultation call, sends hostname and call-destination-session-id; legs merge', async () => {
    const fake = await startFakeNetSapiens({
      apiVersion: '44.4.10',
      tokens: { 'test-token': { user: '1001', domain: 'example.com' } },
      routeModules: [callsRoute],
    });
    activeFakes.push(fake);

    addCall(fake.state, {
      call_id: 'call-main',
      'call-session-id': 'sess-main-1',
      'core-server': 'core1.example.com',
      user: '1001',
      domain: 'example.com',
      status: 'active',
    });

    addCall(fake.state, {
      call_id: 'call-consult',
      'call-session-id': 'sess-consult-2',
      'core-server': 'core2.example.com',
      user: '1001',
      domain: 'example.com',
      status: 'active',
    });

    const client = new NetSapiensClient({ apiUrl: fake.origin, apiToken: 'test-token' });

    const result = await transferCallTool.handler(
      { call_id: 'call-main', consult_call_id: 'call-consult', type: 'attended' },
      client as unknown as GenericApiClient,
      'domain_admin',
    );

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);

    // Verify requests: GET consult call, then PATCH main call
    expect(fake.requests.length).toBe(2);
    const getReq = fake.requests[0];
    expect(getReq.method).toBe('GET');
    expect(getReq.path).toBe('/ns-api/v2/domains/~/users/~/calls/call-consult');

    const patchReq = fake.requests[1];
    expect(patchReq.method).toBe('PATCH');
    expect(patchReq.path).toBe('/ns-api/v2/domains/~/users/~/calls/call-main/transfer');
    expect(patchReq.body).toEqual({
      hostname: 'core2.example.com',
      'call-destination-session-id': 'sess-consult-2',
    });
    expect((patchReq.body as Record<string, unknown>)['call-term-user']).toBeUndefined();

    // Verify legs merged in fake state
    const calls = getCallsList(fake.state);
    const mainCall = calls.find((c) => c.call_id === 'call-main');
    const consultCall = calls.find((c) => c.call_id === 'call-consult');
    expect(mainCall!.status).toBe('merged');
    expect(mainCall!['merged-with-session-id']).toBe('sess-consult-2');
    expect(consultCall!.status).toBe('merged');
    expect(consultCall!['merged-with-session-id']).toBe('sess-main-1');

    expect(fake.state.merges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'attended',
          sourceCallId: 'call-main',
          targetSessionId: 'sess-consult-2',
          hostname: 'core2.example.com',
        }),
      ]),
    );
  });

  it('3. Unknown consult_call_id returns isError and fake logs zero PATCHes', async () => {
    const fake = await startFakeNetSapiens({
      apiVersion: '44.4.10',
      tokens: { 'test-token': { user: '1001', domain: 'example.com' } },
      routeModules: [callsRoute],
    });
    activeFakes.push(fake);

    addCall(fake.state, {
      call_id: 'call-main',
      'call-session-id': 'sess-main-1',
      'core-server': 'core1.example.com',
      user: '1001',
      domain: 'example.com',
      status: 'active',
    });

    const client = new NetSapiensClient({ apiUrl: fake.origin, apiToken: 'test-token' });

    const result = await transferCallTool.handler(
      { call_id: 'call-main', consult_call_id: 'call-nonexistent', type: 'attended' },
      client as unknown as GenericApiClient,
      'domain_admin',
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Consultation call not found');

    const patchReqs = fake.requests.filter((r) => r.method === 'PATCH');
    expect(patchReqs.length).toBe(0);
  });

  it('4. Missing to or consult_call_id returns isError with zero requests', async () => {
    const fake = await startFakeNetSapiens({
      apiVersion: '44.4.10',
      tokens: { 'test-token': { user: '1001', domain: 'example.com' } },
      routeModules: [callsRoute],
    });
    activeFakes.push(fake);

    const client = new NetSapiensClient({ apiUrl: fake.origin, apiToken: 'test-token' });

    // 4a. Blind without 'to'
    const resBlind = await transferCallTool.handler(
      { call_id: 'call-main', type: 'blind' },
      client as unknown as GenericApiClient,
      'domain_admin',
    );
    expect(resBlind.isError).toBe(true);
    expect(resBlind.content[0].text).toContain('Blind transfer requires destination');
    expect(fake.requests.length).toBe(0);

    // 4b. Attended without 'consult_call_id'
    const resAttended = await transferCallTool.handler(
      { call_id: 'call-main', type: 'attended' },
      client as unknown as GenericApiClient,
      'domain_admin',
    );
    expect(resAttended.isError).toBe(true);
    expect(resAttended.content[0].text).toContain('Attended transfer requires consult_call_id');
    expect(fake.requests.length).toBe(0);

    // 4c. Consultation call missing core-server or call-session-id
    addCall(fake.state, {
      call_id: 'call-broken-consult',
      // missing core-server and call-session-id
      user: '1001',
      domain: 'example.com',
    });
    const resBroken = await transferCallTool.handler(
      { call_id: 'call-main', consult_call_id: 'call-broken-consult', type: 'attended' },
      client as unknown as GenericApiClient,
      'domain_admin',
    );
    expect(resBroken.isError).toBe(true);
    expect(resBroken.content[0].text).toContain('missing core-server or call-session-id');
    const patchReqs = fake.requests.filter((r) => r.method === 'PATCH');
    expect(patchReqs.length).toBe(0);
  });

  it('5. Every PATCH body validates (ajv) against vendored CallActions schema', () => {
    for (const b of branches) {
      const specPath = resolve(__dirname, `../../spec/v2/${b}.json`);
      const spec = JSON.parse(readFileSync(specPath, 'utf8'));
      schemas[b] = spec.components.schemas.CallActions;
    }

    const ajv = new Ajv({ strict: false });
    const validators: Record<string, ValidateFunction> = {};
    for (const b of branches) {
      validators[b] = ajv.compile(schemas[b]);
    }

    const blindBody = { 'call-term-user': '1002' };
    const attendedBody = {
      hostname: 'core1.example.com',
      'call-destination-session-id': '20260901143000012345',
    };

    // Blind validates against all 4 branches: 44.3, 44.4, 45.0, 46.0
    for (const b of branches) {
      const valid = validators[b](blindBody);
      expect(valid, `blind transfer should validate against ${b} CallActions`).toBe(true);
    }

    // Attended validates against 44.4, 45.0, 46.0
    for (const b of ['44.4', '45.0', '46.0']) {
      const valid = validators[b](attendedBody);
      expect(valid, `attended transfer should validate against ${b} CallActions`).toBe(true);
    }

    // On 44.3, attended transfer body fails because 44.3 marks 'call-term-user' required
    const valid443 = validators['44.3'](attendedBody);
    expect(valid443, 'attended transfer without call-term-user should fail on 44.3').toBe(false);
  });

  describe('mutations', () => {
    it('mutation 1: sending destination for blind receives 400 from fake NetSapiens with 46.0 error message', async () => {
      const fake = await startFakeNetSapiens({
        apiVersion: '46.0.0',
        tokens: { 'test-token': { user: '1001', domain: 'example.com' } },
        routeModules: [callsRoute],
      });
      activeFakes.push(fake);

      addCall(fake.state, {
        call_id: 'c1',
        'call-session-id': 's1',
        'core-server': 'core1.example.com',
        user: '1001',
        domain: 'example.com',
      });

      // Direct PATCH with legacy destination field
      const res = await fetch(`${fake.origin}/ns-api/v2/domains/example.com/users/1001/calls/c1/transfer`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ destination: '1002' }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as { code: number; message: string };
      expect(data).toEqual({
        code: 400,
        message: 'Neither `call-term-user` nor both `hostname` and `call-destination-session-id` were sent.',
      });
    });

    it('mutation 2: sending to /transfer/peer returns 404 No Route Found', async () => {
      const fake = await startFakeNetSapiens({
        apiVersion: '44.4.10',
        tokens: { 'test-token': { user: '1001', domain: 'example.com' } },
        routeModules: [callsRoute],
      });
      activeFakes.push(fake);

      const res = await fetch(`${fake.origin}/ns-api/v2/domains/example.com/users/1001/calls/c1/transfer/peer`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ destination: '1002' }),
      });

      expect(res.status).toBe(404);
      const data = (await res.json()) as { message: string };
      expect(data).toEqual({ message: 'No Route Found' });
    });
  });
});
