import { afterAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { parsePlatforms } from '../auth/platforms.js';
import { NetSapiensAuthProvider } from '../auth/netsapiens-auth-provider.js';
import { createMemoryStore } from '../store/memory.js';
import { deriveStoreKey } from '../store/codec.js';
import { loadAccessRegistryConfig } from '../access/config.js';

const home = mkdtempSync(join(tmpdir(), 'nsmcp-config-test-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const args = ['--import', 'tsx', 'src/index.ts'];
const baseEnv = {
 PATH: process.env.PATH,
 HOME: home,
 TMPDIR: home,
 MCP_TRANSPORT: 'http',
 NETSAPIENS_API_URL: 'https://netsapiens.example.com',
 NETSAPIENS_OAUTH_CLIENT_ID: 'client',
 NETSAPIENS_OAUTH_CLIENT_SECRET: 'secret',
 MCP_SESSION_SECRET: 'a'.repeat(32),
 MCP_MFA_REPLAY_AUDIENCE: 'config-contract-test-store',
};

function startup(env: Record<string, string | undefined>) {
 return spawnSync(process.execPath, args, { env: { ...baseEnv, ...env }, encoding: 'utf8', timeout: 5000 });
}

describe('configuration contract', () => {
 it.each([
  [{ NETSAPIENS_API_URL: undefined }, 'ConfigError: NETSAPIENS_API_URL is required (your NetSapiens host, for example https://netsapiens.example.com)'],
  [{ NETSAPIENS_API_URL: 'ftp://example.com' }, 'ConfigError: NETSAPIENS_API_URL must be an http(s) URL, got "ftp://example.com"'],
  [{ MCP_PLATFORMS: 'x' }, 'ConfigError: MCP_PLATFORMS was removed in 3.0.0; use NETSAPIENS_PLATFORMS'],
  [{ NETSAPIENS_PLATFORMS: 'Label=https://example.com' }, 'ConfigError: NETSAPIENS_PLATFORMS must be a JSON object'],
  [{ MCP_SESSION_SECRET: undefined }, 'ConfigError: MCP_SESSION_SECRET must be at least 32 characters'],
  [{ MCP_SESSION_SECRET: 'x'.repeat(31) }, 'ConfigError: MCP_SESSION_SECRET must be at least 32 characters'],
  [{ MCP_MFA_REPLAY_AUDIENCE: 'invalid audience' }, 'ConfigError: replayAudience must be a stable replay-store identity'],
  [{ MCP_TRANSPORT: 'stdio', MCP_ACCESS_REGISTRY_URL: 'https://registry.example.com' }, 'ConfigError: MCP_ACCESS_REGISTRY_URL requires MCP_TRANSPORT=http; stdio cannot enforce the access registry, so it would fail open'],
  [{ MCP_TRANSPORT: undefined, MCP_ACCESS_REGISTRY_URL: 'https://registry.example.com' }, 'ConfigError: MCP_ACCESS_REGISTRY_URL requires MCP_TRANSPORT=http; stdio cannot enforce the access registry, so it would fail open'],
 ])('rejects invalid startup configuration', (env, message) => {
  const result = startup(env);
  expect(result.status).toBe(1);
  expect(result.stderr.split(/\r?\n/)).toContain(message);
 });

 const REGISTRY_BASE = {
   MCP_ACCESS_REGISTRY_URL: 'https://registry.example.com',
   MCP_ACCESS_REGISTRY_AUTH: 'bearer',
   MCP_ACCESS_REGISTRY_TOKEN: 'static-token-value',
 };
 it.each([
   [{ MCP_ACCESS_REGISTRY_URL: 'registry.example.com' }, 'ConfigError: MCP_ACCESS_REGISTRY_URL must be an absolute https URL with no credentials, query or fragment'],
   [{ MCP_ACCESS_REGISTRY_URL: 'http://registry.example.com' }, 'ConfigError: MCP_ACCESS_REGISTRY_URL must use https unless it is a loopback address'],
   [{ MCP_ACCESS_REGISTRY_AUTH: undefined }, 'ConfigError: MCP_ACCESS_REGISTRY_AUTH is required when MCP_ACCESS_REGISTRY_URL is set; use bearer, google-id-token or none'],
   [{ MCP_ACCESS_REGISTRY_AUTH: 'Bearer' }, 'ConfigError: MCP_ACCESS_REGISTRY_AUTH must be bearer, google-id-token or none'],
   [{ MCP_ACCESS_REGISTRY_TOKEN: undefined }, 'ConfigError: MCP_ACCESS_REGISTRY_TOKEN is required when MCP_ACCESS_REGISTRY_AUTH is bearer'],
   [{ MCP_ACCESS_REGISTRY_TOKEN: 'two words' }, 'ConfigError: MCP_ACCESS_REGISTRY_TOKEN must be visible ASCII with no spaces'],
   [{ MCP_ACCESS_REGISTRY_AUTH: 'google-id-token', MCP_ACCESS_REGISTRY_TOKEN: undefined }, 'ConfigError: MCP_ACCESS_REGISTRY_AUDIENCE is required when MCP_ACCESS_REGISTRY_AUTH is google-id-token'],
   [{ MCP_ACCESS_REGISTRY_AUTH: 'google-id-token', MCP_ACCESS_REGISTRY_AUDIENCE: 'two words' }, 'ConfigError: MCP_ACCESS_REGISTRY_AUDIENCE must be visible ASCII with no spaces'],
   [{ MCP_ACCESS_REGISTRY_AUTH: 'none' }, 'ConfigError: MCP_ACCESS_REGISTRY_AUTH none is permitted only for a loopback MCP_ACCESS_REGISTRY_URL'],
   [{ MCP_ACCESS_REGISTRY_CONNECTOR: 'two words' }, 'ConfigError: MCP_ACCESS_REGISTRY_CONNECTOR must be 1 to 64 letters, digits, periods, underscores or hyphens, starting with a letter or digit'],
   [{ MCP_ACCESS_REGISTRY_MAX_STALE_SECONDS: '3601' }, 'ConfigError: MCP_ACCESS_REGISTRY_MAX_STALE_SECONDS must be a whole number from 0 to 3600'],
   [{ MCP_ACCESS_REGISTRY_TIMEOUT_MS: '499' }, 'ConfigError: MCP_ACCESS_REGISTRY_TIMEOUT_MS must be a whole number from 500 to 30000'],
 ])('rejects invalid access registry configuration', (override, message) => {
   expect(() => loadAccessRegistryConfig({ ...REGISTRY_BASE, ...override })).toThrow(new Error(message));
 });

 it('validates ids, origins, entry types and normalizes URLs', () => {
  const primary = 'https://netsapiens.example.com';
  expect(parsePlatforms('{"Other":{"apiUrl":"https://other.example.com/path","label":"Other host"}}', primary)).toEqual([
   { id: 'default', label: 'netsapiens.example.com', apiUrl: primary },
   { id: 'other', label: 'Other host', apiUrl: 'https://other.example.com' },
  ]);
  for (const raw of ['', ' \t ']) expect(parsePlatforms(raw, primary)).toEqual(parsePlatforms(undefined, primary));
  for (const raw of ['[]', 'null', '{"A":5}', '{"A":"bad"}', '{"A!":"https://a.example.com","A?":"https://b.example.com"}', '{"A":"https://a.example.com","B":"https://a.example.com/path"}', '{"default":"https://other.example.com"}']) {
   expect(() => parsePlatforms(raw, primary)).toThrow();
  }
 });

 it('requires a nonempty platform list containing the upstream origin', () => {
  const store = createMemoryStore({ namespace: 'test', key: deriveStoreKey('a'.repeat(32)) });
  const options = { nsApiUrl: 'https://netsapiens.example.com', nsClientId: 'client', nsClientSecret: 'secret', store };
  expect(() => new NetSapiensAuthProvider({ ...options, platforms: [] })).toThrow('platforms must contain at least one platform');
  expect(() => new NetSapiensAuthProvider({ ...options, platforms: [{ id: 'other', label: 'Other', apiUrl: 'https://other.example.com' }] })).toThrow('nsApiUrl must be in platforms');
 });

 it('serves health and displays configured login labels', async () => {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const port = address.port;
  socket.close();
  await once(socket, 'close');
  const server = spawn(process.execPath, args, { env: { ...baseEnv, MCP_PORT: String(port), MCP_HOST: '127.0.0.1', NETSAPIENS_PLATFORMS: '{"west":{"apiUrl":"https://west.example.com","label":"West office"}}' }, stdio: ['ignore', 'ignore', 'pipe'] });
  try {
   const url = `http://127.0.0.1:${port}`;
   let response: Response | undefined;
   for (let i = 0; i < 100; i++) {
    // The child is a real process; fake timers cannot control its listener startup.
    try { response = await fetch(`${url}/health`); break; } catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
   }
   expect(response?.status).toBe(200);
   const registration = await fetch(`${url}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://localhost/cb'], client_name: 'test', token_endpoint_auth_method: 'none' }) });
   expect(registration.status).toBe(201);
   const client = await registration.json() as { client_id: string };
   const params = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'http://localhost/cb', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' });
   const login = await fetch(`${url}/authorize?${params}`);
   expect(login.status).toBe(200);
   expect(await login.text()).toContain('West office');
  } finally {
   if (server.exitCode === null && server.signalCode === null) {
    const exited = once(server, 'exit');
    server.kill();
    await exited;
   }
  }
 });
});
