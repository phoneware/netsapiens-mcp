/**
 * Tests for two small but important HTTP surface bits:
 *   - /favicon.ico proxy (fetches MCP_ICON_URL, serves bytes, supports ETag/304)
 *   - /.well-known/oauth-protected-resource compat route at the root path
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import axios from 'axios';

vi.mock('axios');
const mockedAxios = axios as unknown as {
  post: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  isAxiosError: (err: unknown) => boolean;
};
mockedAxios.create = vi.fn(() => ({
  interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
  request: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
})) as unknown as typeof mockedAxios.create;
mockedAxios.isAxiosError = () => false;

const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000100' +
    '0d0a2db40000000049454e44ae426082',
  'hex',
);

async function importApp() {
  vi.resetModules();
  process.env.MCP_TRANSPORT = 'http';
  process.env.MCP_BASE_URL = 'http://localhost';
  process.env.NETSAPIENS_API_URL = 'https://ns.example.com';
  process.env.NETSAPIENS_OAUTH_CLIENT_ID = 'op';
  process.env.NETSAPIENS_OAUTH_CLIENT_SECRET = 'secret';
  process.env.MCP_SESSION_SECRET = '0123456789abcdef0123456789abcdef';
  delete process.env.MCP_PERSISTENCE;
  const mod = await import('../http-server.js');
  return mod.createApp();
}

describe('/favicon proxy', () => {
  beforeEach(() => {
    // Mock the global fetch that the favicon route uses
    (globalThis as any).fetch = vi.fn(async () => ({
      ok: true,
      headers: { get: (h: string) => (h === 'content-type' ? 'image/png' : null) },
      arrayBuffer: async () => PNG_BYTES.buffer.slice(PNG_BYTES.byteOffset, PNG_BYTES.byteOffset + PNG_BYTES.byteLength),
    }));
  });

  afterEach(() => {
    delete process.env.MCP_ICON_URL;
    vi.clearAllMocks();
  });

  it('returns 404 when MCP_ICON_URL is not set', async () => {
    const { app } = await importApp();
    await request(app).get('/favicon.ico').expect(404);
    await request(app).get('/favicon.png').expect(404);
  });

  it('fetches MCP_ICON_URL once and serves the bytes with content-type + ETag', async () => {
    process.env.MCP_ICON_URL = 'https://cdn.example.com/logo.png';
    const { app } = await importApp();

    const first = await request(app).get('/favicon.ico').expect(200);
    expect(first.headers['content-type']).toMatch(/image\/png/);
    expect(first.headers.etag).toBeTruthy();
    expect((first.body as Buffer).length).toBe(PNG_BYTES.length);

    // Second request returns 304 when If-None-Match matches
    const second = await request(app)
      .get('/favicon.ico')
      .set('If-None-Match', first.headers.etag as string)
      .expect(304);
    expect(second.body).toEqual({});

    // Underlying fetch was only called once (cache hit on second request)
    expect(((globalThis as any).fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('falls back to 404 when the upstream fetch fails', async () => {
    process.env.MCP_ICON_URL = 'https://cdn.example.com/missing.png';
    (globalThis as any).fetch = vi.fn(async () => ({ ok: false, status: 500 }));
    const { app } = await importApp();
    await request(app).get('/favicon.ico').expect(404);
  });
});

describe('/.well-known/oauth-protected-resource compatibility', () => {
  it('serves the same metadata at the root and at the SDK path-specific URL', async () => {
    const { app } = await importApp();

    const root = await request(app).get('/.well-known/oauth-protected-resource').expect(200);
    const nested = await request(app).get('/.well-known/oauth-protected-resource/mcp').expect(200);

    // Both should point at the same MCP resource URL and list at least one auth server
    expect(root.body.resource).toContain('/mcp');
    expect(nested.body.resource).toContain('/mcp');
    expect(Array.isArray(root.body.authorization_servers)).toBe(true);
    expect(root.body.authorization_servers.length).toBeGreaterThan(0);
  });
});
