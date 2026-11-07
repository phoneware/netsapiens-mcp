import { describe, expect, it } from 'vitest';
import { createGuardedClient, GuardedNetSapiensClient } from '../netsapiens/guarded-client.js';
import { createAvailabilityContext } from '../netsapiens/availability.js';
import type { NetSapiensClient } from '../netsapiens-client.js';
import type { VersionInfo } from '../netsapiens/version.js';

describe('src/netsapiens/guarded-client.ts', () => {
  const version44: VersionInfo = {
    origin: 'http://127.0.0.1:4567',
    apiVersion: '44.4.10',
    line: '44.4',
    docsBranch: '44.4',
    match: 'exact',
    status: 'ok',
    state: 'fresh',
    checkedAt: new Date().toISOString(),
    v1: 'ok',
    v1Keys: new Set(),
    observation: null,
  };

  const availabilityData = {
    schemaVersion: 2 as const,
    branches: ['44.3', '44.4', '45.0', '46.0'],
    observations: [],
    v2: {
      'GET /apikeys/{}': {
        branches: ['44.3', '44.4', '45.0', '46.0'],
        documented: ['44.3', '44.4', '45.0', '46.0'],
        observed: {},
      },
      'GET /health': {
        branches: ['46.0'],
        documented: ['46.0'],
        observed: {},
      },
    },
    v1: {},
  };

  it('permits an available operation and delegates to raw client', async () => {
    const requested: Array<Record<string, unknown>> = [];
    const fakeRawClient = {
      request: async (opts: Record<string, unknown>) => {
        requested.push(opts);
        return { success: true, data: { ok: true } };
      },
    } as unknown as NetSapiensClient;

    const ctx = createAvailabilityContext(version44, availabilityData);
    const guarded = createGuardedClient(fakeRawClient, ctx);

    const result = await guarded.request({
      method: 'GET',
      pathTemplate: '/apikeys/{key}',
      pathParams: { key: '123' },
    });

    expect(result).toEqual({ success: true, data: { ok: true } });
    expect(requested).toHaveLength(1);
    expect(requested[0].pathTemplate).toBe('/apikeys/{key}');
  });

  it('refuses an unavailable operation with the exact error message and sends 0 requests', async () => {
    const requested: Array<Record<string, unknown>> = [];
    const fakeRawClient = {
      request: async (opts: Record<string, unknown>) => {
        requested.push(opts);
        return { success: true, data: { ok: true } };
      },
    } as unknown as NetSapiensClient;

    const ctx = createAvailabilityContext(version44, availabilityData);
    const guarded = createGuardedClient(fakeRawClient, ctx);

    await expect(
      guarded.request({
        method: 'GET',
        pathTemplate: '/health',
      }),
    ).rejects.toThrow("Operation 'GET /health' is not available on this NetSapiens host (reported release: 44.4.10).");

    // Zero upstream requests sent
    expect(requested).toHaveLength(0);
  });

  it('reports "unknown" when apiVersion is null', async () => {
    const requested: Array<Record<string, unknown>> = [];
    const fakeRawClient = {
      request: async (opts: Record<string, unknown>) => {
        requested.push(opts);
        return { success: true };
      },
    } as unknown as NetSapiensClient;

    const unknownVersion: VersionInfo = {
      ...version44,
      apiVersion: null,
      status: 'unknown',
    };
    const ctx = createAvailabilityContext(unknownVersion, availabilityData);
    const guarded = createGuardedClient(fakeRawClient, ctx);

    await expect(
      guarded.request({
        method: 'GET',
        pathTemplate: '/health',
      }),
    ).rejects.toThrow("Operation 'GET /health' is not available on this NetSapiens host (reported release: unknown).");

    expect(requested).toHaveLength(0);
  });

  it('provides access to raw client via rawClient property', () => {
    const fakeRawClient = {
      request: async () => ({ success: true }),
    } as unknown as NetSapiensClient;

    const ctx = createAvailabilityContext(version44, availabilityData);
    const guarded = createGuardedClient(fakeRawClient, ctx);

    expect((guarded as unknown as { rawClient: NetSapiensClient }).rawClient).toBe(fakeRawClient);
  });
});
