import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { parsePlatforms } from '../auth/platforms.js';

const baseEnv = {
 PATH: process.env.PATH,
 HOME: process.env.HOME,
 MCP_TRANSPORT: 'http',
 NETSAPIENS_API_URL: 'https://netsapiens.example.com',
 NETSAPIENS_OAUTH_CLIENT_ID: 'client',
 NETSAPIENS_OAUTH_CLIENT_SECRET: 'secret',
 MCP_SESSION_SECRET: 'a'.repeat(32),
};

function startup(env: Record<string, string | undefined>) {
 return spawnSync(process.execPath, ['build/index.js'], { env: { ...baseEnv, ...env }, encoding: 'utf8', timeout: 5000 });
}

describe('configuration contract', () => {
 it.each([
  [{ NETSAPIENS_API_URL: undefined }, 'NETSAPIENS_API_URL is required'],
  [{ NETSAPIENS_API_URL: 'ftp://example.com' }, 'NETSAPIENS_API_URL must be an http(s) URL'],
  [{ MCP_PLATFORMS: 'x' }, 'MCP_PLATFORMS was removed in 3.0.0; use NETSAPIENS_PLATFORMS'],
  [{ NETSAPIENS_PLATFORMS: 'Label=https://example.com' }, 'NETSAPIENS_PLATFORMS must be a JSON object'],
  [{ MCP_SESSION_SECRET: undefined }, 'MCP_SESSION_SECRET must be at least 32 characters'],
  [{ MCP_SESSION_SECRET: 'x'.repeat(31) }, 'MCP_SESSION_SECRET must be at least 32 characters'],
 ])('rejects invalid startup configuration', (env, message) => {
  const result = startup(env);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(message);
 });

 it('validates ids, origins, entry types and normalizes URLs', () => {
  const primary = 'https://netsapiens.example.com';
  expect(parsePlatforms('{"Other":{"apiUrl":"https://other.example.com/path","label":"Other host"}}', primary)).toEqual([
   { id: 'default', label: 'netsapiens.example.com', apiUrl: primary },
   { id: 'other', label: 'Other host', apiUrl: 'https://other.example.com' },
  ]);
  for (const raw of ['[]', 'null', '{"A":5}', '{"A":"bad"}', '{"A!":"https://a.example.com","A?":"https://b.example.com"}', '{"A":"https://a.example.com","B":"https://a.example.com/path"}', '{"default":"https://other.example.com"}']) {
   expect(() => parsePlatforms(raw, primary)).toThrow();
  }
 });

 it('serves health and displays configured login labels', async () => {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => socket.close((err) => err ? reject(err) : resolve()));
  const server = spawn(process.execPath, ['build/index.js'], { env: { ...baseEnv, MCP_PORT: String(port), MCP_HOST: '127.0.0.1', NETSAPIENS_PLATFORMS: '{"west":{"apiUrl":"https://west.example.com","label":"West office"}}' }, stdio: 'ignore' });
  try {
   const url = `http://127.0.0.1:${port}`;
   let response: Response | undefined;
   for (let i = 0; i < 100; i++) {
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
   server.kill();
  }
 });
});
