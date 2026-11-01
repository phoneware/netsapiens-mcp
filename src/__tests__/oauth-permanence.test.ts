import { describe, expect, it, vi } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import type { InternalAxiosRequestConfig } from 'axios';
import axios from 'axios';
import { createApp } from '../http-server.js';
import { runPermanenceContract, type PermanenceHarness } from './test-support/permanence-contract.js';

interface MemoryHarnessBacking {
  envSnapshot: Record<string, string | undefined>;
}

function createBaseMemoryHarness(): PermanenceHarness<MemoryHarnessBacking> {
  const openServers: HttpServer[] = [];
  let virtualNow = Date.now();

  return {
    name: 'NetSapiens Base API (Memory)',
    newBacking: async () => ({
      envSnapshot: { ...process.env },
    }),
    createInstance: async () => {
      process.env.MCP_TRANSPORT = 'http';
      process.env.MCP_BASE_URL = 'http://localhost';
      process.env.NETSAPIENS_API_URL = 'https://ns.example.com';
      process.env.NETSAPIENS_OAUTH_CLIENT_ID = 'op-client-id';
      process.env.NETSAPIENS_OAUTH_CLIENT_SECRET = 'op-client-secret';
      process.env.MCP_SESSION_SECRET = '0123456789abcdef0123456789abcdef';
      process.env.MCP_TOKEN_LIFETIME_HOURS = '1';
      delete process.env.MCP_PERSISTENCE;

      const created = createApp();
      const server = created.app.listen(0);
      openServers.push(server);
      const port = (server.address() as { port: number }).port;
      const url = `http://127.0.0.1:${port}`;
      created.baseUrl.href = url;

      return {
        url,
        close: async () => {
          const { promise, resolve } = Promise.withResolvers<void>();
          server.close(() => resolve());
          await promise;
        },
      };
    },
    signIn: async (instanceUrl) => {
      vi.spyOn(axios, 'post').mockImplementation(async (url: string) => {
        if (url.includes('/ns-api/v2/tokens')) {
          return {
            data: {
              access_token: 'mock-ns-access-token',
              refresh_token: 'mock-ns-refresh-token',
              expires_in: 3600,
            },
            status: 200,
            statusText: 'OK',
            headers: {},
            config: {} as unknown as InternalAxiosRequestConfig,
          };
        }
        return {
          data: {},
          status: 200,
          statusText: 'OK',
          headers: {},
          config: {} as unknown as InternalAxiosRequestConfig,
        };
      });

      vi.spyOn(axios, 'get').mockImplementation(async () => {
        return {
          data: {
            'user-scope': 'Reseller',
            user: 'alice',
            domain: 'example.com',
            email: 'alice@example.com',
            'name-full-name': 'Alice User',
          },
          status: 200,
          statusText: 'OK',
          headers: {},
          config: {} as unknown as InternalAxiosRequestConfig,
        };
      });

      // Register a client
      const regRes = await fetch(`${instanceUrl}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'permanence-test-client',
          redirect_uris: ['http://127.0.0.1:9099/callback'],
        }),
      });
      const reg = (await regRes.json()) as { client_id: string; client_secret?: string };

      // Get authorize page
      const authRes = await fetch(
        `${instanceUrl}/authorize?response_type=code&client_id=${reg.client_id}&redirect_uri=http://127.0.0.1:9099/callback&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256`,
      );
      const authHtml = await authRes.text();
      const authStateMatch = authHtml.match(/name="auth_state"\s+value="([^"]+)"/);
      const authState = authStateMatch ? authStateMatch[1] : '';

      // Submit login
      const loginParams = new URLSearchParams({
        username: 'alice@example.com',
        password: 'password123',
        auth_state: authState,
      });

      const loginRes = await fetch(`${instanceUrl}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: loginParams.toString(),
        redirect: 'manual',
      });

      const location = loginRes.headers.get('location') || '';
      const code = new URL(location, 'http://127.0.0.1:9099').searchParams.get('code') || '';

      // Exchange code for token
      const tokenParams = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
        client_id: reg.client_id,
        redirect_uri: 'http://127.0.0.1:9099/callback',
      });
      if (reg.client_secret) {
        tokenParams.set('client_secret', reg.client_secret);
      }

      const tokenRes = await fetch(`${instanceUrl}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenParams.toString(),
      });
      const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string; expires_in: number };

      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        clientId: reg.client_id,
        expiresIn: tokens.expires_in,
      };
    },
    setNow: (now: number) => {
      virtualNow = now;
      vi.setSystemTime(now);
    },
    getNow: () => virtualNow,
    supportsAdoption: false,
    supportsRegistration: true,
  };
}

describe('OAuth Permanence Contract (Base API)', () => {
  it('runs full contract against base API and fails on step d (refresh after expired verify returns 400)', async () => {
    vi.useFakeTimers();
    try {
      const harness = createBaseMemoryHarness();
      await expect(runPermanenceContract(harness)).rejects.toThrow('step d: refresh must return 200');
    } finally {
      vi.useRealTimers();
    }
  });
});
