/**
 * Tests for NetSapiens Token Sign-In (phoneware/monorepo#1128).
 *
 * Covers:
 *  - Platform allowlist configuration and refusal of unauthorized hosts (SSRF prevention)
 *  - Rendering of platform picker and token field on the login page
 *  - Token sign-in with user token (resolves scope via /domains/~/users/~)
 *  - Token sign-in with machine API key (resolves scope via /apikeys/~)
 *  - Refusal of invalid tokens on upstream 401
 *  - Upstream host routing per token-session
 *  - Expired token with no refresh path returning HTTP 401 invalid_token
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createHash, randomBytes } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import axios from 'axios';
import { getAllowedPlatforms, isPlatformAllowed, parsePlatformsConfig } from '../auth/platforms.js';

vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

function pkceChallenge(verifier: string): string {
 return createHash('sha256').update(verifier).digest('base64url');
}

function hiddenField(html: string, name: string): string | undefined {
 return html.match(new RegExp(`name="${name}" value="([^"]+)"`))?.[1];
}
const openServers: HttpServer[] = [];

async function importApp() {
 vi.resetModules();
 process.env.MCP_TRANSPORT = 'http';
 process.env.MCP_BASE_URL = 'http://localhost';
 process.env.NETSAPIENS_API_URL = 'https://edge.phoneware.cloud';
 process.env.NETSAPIENS_OAUTH_CLIENT_ID = 'op-client-id';
 process.env.NETSAPIENS_OAUTH_CLIENT_SECRET = 'op-client-secret';
 process.env.MCP_SESSION_SECRET = '0123456789abcdef0123456789abcdef';
 delete process.env.MCP_PERSISTENCE;

 // Dynamic import required because env vars must be applied before loadConfig initializes.
 const mod = await import('../http-server.js');
 const created = mod.createApp();
 const server = created.app.listen(0);
 openServers.push(server);
 return { ...created, app: server as unknown as typeof created.app };
}

async function closeOpenServers(): Promise<void> {
 await Promise.all(
  openServers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
 );
}

describe('NetSapiens Token Sign-In', () => {
 let createdClients: Array<{ baseURL?: string }> = [];

 beforeEach(() => {
  vi.clearAllMocks();
  createdClients = [];
  delete process.env.NETSAPIENS_PLATFORMS;
  delete process.env.MCP_PLATFORMS;

  mockedAxios.create = vi.fn((cfg?: { baseURL?: string }) => {
   const client = {
    defaults: { baseURL: cfg?.baseURL },
    interceptors: {
     request: { use: vi.fn() },
     response: { use: vi.fn() },
    },
    request: vi.fn().mockResolvedValue({ data: [] }),
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: vi.fn().mockResolvedValue({ data: [] }),
   };
   createdClients.push(cfg || {});
   return client;
  }) as unknown as typeof mockedAxios.create;
 });
 afterEach(async () => {
  await closeOpenServers();
 });

 describe('Platform allowlist', () => {
  it('always includes Phoneware Edge by default', () => {
   const platforms = getAllowedPlatforms();
   expect(platforms.some((p) => p.apiUrl === 'https://edge.phoneware.cloud')).toBe(true);
   expect(platforms.some((p) => p.apiUrl === 'https://vps.phoneware.us')).toBe(true);
   expect(platforms.some((p) => p.apiUrl === 'https://mars.phoneware.cloud')).toBe(true);
  });

  it('injects Edge even when operator allowlist omits it', () => {
   const parsed = parsePlatformsConfig('Custom=https://custom.example.com');
   expect(parsed.some((p) => p.apiUrl === 'https://edge.phoneware.cloud')).toBe(true);
   expect(parsed.some((p) => p.apiUrl === 'https://custom.example.com')).toBe(true);
  });

  it('refuses unknown hosts before making any network request (SSRF check)', () => {
   expect(isPlatformAllowed('https://evil.attacker.com')).toBe(false);
   expect(isPlatformAllowed('http://169.254.169.254/latest/meta-data')).toBe(false);
   expect(isPlatformAllowed('https://edge.phoneware.cloud')).toBe(true);
   expect(isPlatformAllowed('https://vps.phoneware.us')).toBe(true);
  });
 });

 describe('Hosted Login Page', () => {
  it('renders tabs and platform select with allowed platforms', async () => {
   const { app } = await importApp();

   // Register public client
   const reg = await request(app)
    .post('/register')
    .send({
     redirect_uris: ['http://localhost/cb'],
     client_name: 'test-client',
     token_endpoint_auth_method: 'none',
    })
    .expect(201);

   // Request login page
   const auth = await request(app)
    .get('/authorize')
    .query({
     response_type: 'code',
     client_id: reg.body.client_id,
     redirect_uri: 'http://localhost/cb',
     code_challenge: pkceChallenge('verifier123'),
     code_challenge_method: 'S256',
    })
    .expect(200);

   expect(auth.text).toContain('Sign in with a NetSapiens token');
   expect(auth.text).toContain('name="platform"');
   expect(auth.text).toContain('name="token"');
   expect(auth.text).toContain('https://edge.phoneware.cloud');
   expect(auth.text).toContain('https://vps.phoneware.us');
   expect(auth.text).toContain('https://mars.phoneware.cloud');
  });
 });

 describe('Token sign-in authentication flow', () => {
  it('refuses sign-in with unauthorized platform without calling network', async () => {
   const { app } = await importApp();
   const reg = await request(app)
    .post('/register')
    .send({ redirect_uris: ['http://localhost/cb'], client_name: 't', token_endpoint_auth_method: 'none' })
    .expect(201);

   const auth = await request(app)
    .get('/authorize')
    .query({
     response_type: 'code',
     client_id: reg.body.client_id,
     redirect_uri: 'http://localhost/cb',
     code_challenge: pkceChallenge('verifier123'),
     code_challenge_method: 'S256',
    })
    .expect(200);

   const authState = hiddenField(auth.text, 'auth_state')!;

   // Post token with unauthorized platform
   const login = await request(app)
    .post('/login')
    .type('form')
    .send({
     platform: 'https://attacker.example.com',
     token: 'some-token',
     auth_state: authState,
    })
    .expect(200);

   expect(login.text).toContain('Selected platform is not recognized or not allowed');
   expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('authenticates user token via /domains/~/users/~ and issues code', async () => {
   const { app } = await importApp();
   const verifier = 'my-token-verifier-123456789012345678901234';
   const reg = await request(app)
    .post('/register')
    .send({ redirect_uris: ['http://localhost/cb'], client_name: 't', token_endpoint_auth_method: 'none' })
    .expect(201);

   const auth = await request(app)
    .get('/authorize')
    .query({
     response_type: 'code',
     client_id: reg.body.client_id,
     redirect_uri: 'http://localhost/cb',
     code_challenge: pkceChallenge(verifier),
     code_challenge_method: 'S256',
    })
    .expect(200);

   const authState = hiddenField(auth.text, 'auth_state')!;

   // Mock user read on Viirtue
   mockedAxios.get = vi.fn().mockImplementation((url: string) => {
    if (url === 'https://vps.phoneware.us/ns-api/v2/domains/~/users/~') {
     return Promise.resolve({
      data: {
       login: 'alice@domain.com',
       user: 'alice',
       domain: 'domain.com',
       'user-scope': 'Office Manager',
      },
     });
    }
    return Promise.reject(new Error(`Unexpected GET ${url}`));
   });

   const login = await request(app)
    .post('/login')
    .type('form')
    .send({
     platform: 'https://vps.phoneware.us',
     token: 'viirtue-user-token',
     auth_state: authState,
    })
    .expect(302);

   const redirectUrl = new URL(login.headers.location as string);
   const code = redirectUrl.searchParams.get('code')!;
   expect(code).toBeTruthy();

   // Exchange authorization code for MCP bearer
   const tokenResp = await request(app)
    .post('/token')
    .type('form')
    .send({
     grant_type: 'authorization_code',
     code,
     code_verifier: verifier,
     client_id: reg.body.client_id,
     redirect_uri: 'http://localhost/cb',
    })
    .expect(200);

   expect(tokenResp.body.access_token).toBeTruthy();
  });

  it('authenticates machine API key via fallback to /apikeys/~ when /domains/~/users/~ 400s', async () => {
   const { app } = await importApp();
   const verifier = 'my-token-verifier-123456789012345678901234';
   const reg = await request(app)
    .post('/register')
    .send({ redirect_uris: ['http://localhost/cb'], client_name: 't', token_endpoint_auth_method: 'none' })
    .expect(201);

   const auth = await request(app)
    .get('/authorize')
    .query({
     response_type: 'code',
     client_id: reg.body.client_id,
     redirect_uri: 'http://localhost/cb',
     code_challenge: pkceChallenge(verifier),
     code_challenge_method: 'S256',
    })
    .expect(200);

   const authState = hiddenField(auth.text, 'auth_state')!;

   // Mock user read: 400 Unable to expand domain, followed by /apikeys/~ returning 200
   mockedAxios.get = vi.fn().mockImplementation((url: string) => {
    if (url === 'https://edge.phoneware.cloud/ns-api/v2/domains/~/users/~') {
     const err = new Error('Request failed with status code 400');
     (err as any).response = { status: 400, data: { message: 'Unable to expand domain from token' } };
     return Promise.reject(err);
    }
    if (url === 'https://edge.phoneware.cloud/ns-api/v2/apikeys/~') {
     return Promise.resolve({
      data: {
       description: 'Operator Key',
       'key-id': 'nss_test123',
       'user-scope': 'Super User',
      },
     });
    }
    return Promise.reject(new Error(`Unexpected GET ${url}`));
   });

   const login = await request(app)
    .post('/login')
    .type('form')
    .send({
     platform: 'https://edge.phoneware.cloud',
     token: 'nss_valid_api_key',
     auth_state: authState,
    })
    .expect(302);

   const redirectUrl = new URL(login.headers.location as string);
   const code = redirectUrl.searchParams.get('code')!;
   expect(code).toBeTruthy();

   const tokenResp = await request(app)
    .post('/token')
    .type('form')
    .send({
     grant_type: 'authorization_code',
     code,
     code_verifier: verifier,
     client_id: reg.body.client_id,
     redirect_uri: 'http://localhost/cb',
    })
    .expect(200);

   expect(tokenResp.body.access_token).toBeTruthy();
  });

  it('rejects sign-in when upstream NetSapiens returns 401 Unauthorized', async () => {
   const { app } = await importApp();
   const reg = await request(app)
    .post('/register')
    .send({ redirect_uris: ['http://localhost/cb'], client_name: 't', token_endpoint_auth_method: 'none' })
    .expect(201);

   const auth = await request(app)
    .get('/authorize')
    .query({
     response_type: 'code',
     client_id: reg.body.client_id,
     redirect_uri: 'http://localhost/cb',
     code_challenge: pkceChallenge('verifier123'),
     code_challenge_method: 'S256',
    })
    .expect(200);

   const authState = hiddenField(auth.text, 'auth_state')!;

   mockedAxios.get = vi.fn().mockImplementation(() => {
    const err = new Error('Request failed with status code 401');
    (err as any).response = { status: 401, data: { message: 'The access token provided is invalid.' } };
    return Promise.reject(err);
   });

   const login = await request(app)
    .post('/login')
    .type('form')
    .send({
     platform: 'https://edge.phoneware.cloud',
     token: 'bad-token',
     auth_state: authState,
    })
    .expect(200);

   expect(login.text).toContain('Invalid NetSapiens token or API key');
  });
 });

 describe('Session Host Routing', () => {
  it('routes API calls to the authenticated platform host, not Edge default', async () => {
   const { app } = await importApp();
   const verifier = 'routing-verifier-12345678901234567890';
   const reg = await request(app)
    .post('/register')
    .send({ redirect_uris: ['http://localhost/cb'], client_name: 't', token_endpoint_auth_method: 'none' })
    .expect(201);

   const auth = await request(app)
    .get('/authorize')
    .query({
     response_type: 'code',
     client_id: reg.body.client_id,
     redirect_uri: 'http://localhost/cb',
     code_challenge: pkceChallenge(verifier),
     code_challenge_method: 'S256',
    })
    .expect(200);

   const authState = hiddenField(auth.text, 'auth_state')!;

   // Authenticate with MCU platform
   mockedAxios.get = vi.fn().mockResolvedValue({
    data: { login: 'mcu-admin@test.com', 'user-scope': 'Reseller' },
   });

   const login = await request(app)
    .post('/login')
    .type('form')
    .send({
     platform: 'https://mars.phoneware.cloud',
     token: 'mcu-token-xyz',
     auth_state: authState,
    })
    .expect(302);

   const code = new URL(login.headers.location as string).searchParams.get('code')!;

   const tokenResp = await request(app)
    .post('/token')
    .type('form')
    .send({
     grant_type: 'authorization_code',
     code,
     code_verifier: verifier,
     client_id: reg.body.client_id,
     redirect_uri: 'http://localhost/cb',
    })
    .expect(200);

   const mcpBearer = tokenResp.body.access_token;

   // Initialize MCP session
   await request(app)
    .post('/mcp')
    .set('Authorization', `Bearer ${mcpBearer}`)
    .set('Accept', 'application/json, text/event-stream')
    .send({
     jsonrpc: '2.0',
     id: 1,
     method: 'initialize',
     params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0' },
     },
    })
    .expect(200);

   // Verify that NetSapiensClient was constructed targeting MCU platform!
   expect(createdClients.length).toBeGreaterThan(0);
   const mcuClient = createdClients.find((c) => c.baseURL?.includes('mars.phoneware.cloud'));
   expect(mcuClient).toBeDefined();
   expect(mcuClient?.baseURL).toBe('https://mars.phoneware.cloud/ns-api/v2');
   expect(mcuClient?.baseURL).not.toContain('edge.phoneware.cloud');
  });
 });
 describe('Expiring token behavior', () => {
  it('returns HTTP 401 invalid_token when upstream token is expired with no refresh path', async () => {
   const { app, authProvider } = await importApp();

   // Create an already-expired token directly in the tokenStore with no refresh token
   const expiredMcpToken = 'expired-mcp-bearer-' + randomBytes(8).toString('hex');
   await (authProvider as any).tokenStore.set({
    accessToken: expiredMcpToken,
    refreshToken: 'dummy-refresh',
    clientId: 'client-1',
    expiresAt: Date.now() + 3600_000, // MCP token itself is unexpired
    nsAccessToken: 'expiring-portal-token',
    // nsRefreshToken is UNDEFINED (no refresh path!)
    nsExpiresAt: Date.now() - 10_000, // Upstream token already expired
    nsUsername: 'bob',
    nsUserRole: 'user',
    nsApiUrl: 'https://edge.phoneware.cloud',
   });

   // Calling /mcp must return 401 with WWW-Authenticate containing invalid_token
   const res = await request(app)
    .post('/mcp')
    .set('Authorization', `Bearer ${expiredMcpToken}`)
    .send({
     jsonrpc: '2.0',
     id: 1,
     method: 'tools/list',
     params: {},
    })
    .expect(401);

   expect(res.headers['www-authenticate']).toContain('invalid_token');
   expect(res.body.error).toBe('invalid_token');
  });
 });
});
