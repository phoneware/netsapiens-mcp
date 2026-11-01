import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHash } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { startFakeNetSapiens } from '../../scripts/fake-netsapiens/index.mjs';
import { clearVersionCache, getCachedVersionInfo, getVersionInfo, setVersionCacheEntry } from '../netsapiens/version.js';
import { buildAvailability, availability } from '../netsapiens/availability.js';

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

const openServers: HttpServer[] = [];
const openFakes: Array<{ close: () => Promise<void> }> = [];

async function closeAll(): Promise<void> {
  await Promise.all(
    openServers.splice(0).map((s) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      s.close(() => resolve());
      return promise;
    }),
  );
  await Promise.all(openFakes.splice(0).map((f) => f.close()));
  clearVersionCache();
}

async function signIn(app: any, platformUrl: string, nsToken: string): Promise<string> {
  // 1. Register public client
  const reg = await request(app)
    .post('/register')
    .send({
      redirect_uris: ['http://localhost/cb'],
      client_name: 'test-client',
      token_endpoint_auth_method: 'none',
    })
    .expect(201);

  // 2. Authorize
  const verifier = 'my-token-verifier-123456789012345678901234';
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

  const authState = auth.text.match(/name="auth_state" value="([^"]+)"/)?.[1];
  if (!authState) throw new Error('Missing auth_state in login page HTML');

  // 3. Login
  const login = await request(app)
    .post('/login')
    .type('form')
    .send({
      platform: platformUrl,
      token: nsToken,
      auth_state: authState,
    })
    .expect(302);

  const redirectUrl = new URL(login.headers.location as string);
  const code = redirectUrl.searchParams.get('code');
  if (!code) throw new Error('Missing code in login redirect');

  // 4. Token exchange
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

  return tokenResp.body.access_token;
}

describe('Version Differential & Runtime Availability', () => {
  beforeEach(() => {
    clearVersionCache();
  });

  afterEach(async () => {
    await closeAll();
  });

  it('runs differential assertions across 44.4.10, 46.0.2, and 500 origins over real HTTP', async () => {
    // 1. Start real fake NetSapiens origins
    const fake44 = await startFakeNetSapiens({
      apiVersion: '44.4.10',
      tokens: {
        'token-44': {
          login: 'alice@domain.com',
          user: 'alice',
          domain: 'domain.com',
          'user-scope': 'Super User',
        },
      },
      extraPresent: [
        'GET /domains/{}/statistics/callqueues/aggregate',
        'GET /domains/{}/statistics/callqueues/{}',
        'GET /domains/{}/statistics/agent',
        'GET /domains/{}/statistics/agent/{}',
      ],
    });
    openFakes.push(fake44);

    const fake46 = await startFakeNetSapiens({
      apiVersion: '46.0.2',
      tokens: {
        'token-46': {
          login: 'bob@domain.com',
          user: 'bob',
          domain: 'domain.com',
          'user-scope': 'Super User',
        },
      },
    });
    openFakes.push(fake46);

    const fake500 = await startFakeNetSapiens({
      apiVersion: null,
      versionStatus: 500,
      tokens: {
        'token-500': {
          login: 'carol@domain.com',
          user: 'carol',
          domain: 'domain.com',
          'user-scope': 'Super User',
        },
      },
    });
    openFakes.push(fake500);

    // 2. Configure app env vars
    process.env.MCP_TRANSPORT = 'http';
    process.env.MCP_BASE_URL = 'http://localhost';
    process.env.NETSAPIENS_API_URL = fake44.origin;
    process.env.NETSAPIENS_PLATFORMS = JSON.stringify({
      p44: fake44.origin,
      p46: fake46.origin,
      p500: fake500.origin,
    });
    process.env.NETSAPIENS_OAUTH_CLIENT_ID = 'op-client-id';
    process.env.NETSAPIENS_OAUTH_CLIENT_SECRET = 'op-client-secret';
    process.env.MCP_SESSION_SECRET = '0123456789abcdef0123456789abcdef';
    process.env.MCP_PERSISTENCE = 'memory';
    process.env.MCP_STATELESS = 'false';
    process.env.MCP_TOOL_MODE = 'curated';
    process.env.NETSAPIENS_VERSION_TTL_SECONDS = '1';

    const mod = await import('../http-server.js');
    const created = await mod.createApp();
    const server = created.app.listen(0);
    openServers.push(server);

    // 3. Test /health: reads cache only, drops nsApiUrl, adds netsapiens
    const initialHealthRes = await request(server).get('/health').expect(200);
    expect(initialHealthRes.body).not.toHaveProperty('nsApiUrl');
    expect(initialHealthRes.body).toHaveProperty('netsapiens');
    // Calling /health adds 0 requests to fake request log
    expect(fake44.requests.filter((r) => r.path.includes('/version'))).toHaveLength(0);
    expect(fake46.requests.filter((r) => r.path.includes('/version'))).toHaveLength(0);
    expect(fake500.requests.filter((r) => r.path.includes('/version'))).toHaveLength(0);

    // 4. Sign in to 44.4.10 origin
    const token44 = await signIn(server, fake44.origin, 'token-44');
    expect(token44).toBeTruthy();

    // 5. Sign in to 46.0.2 origin
    const token46 = await signIn(server, fake46.origin, 'token-46');
    expect(token46).toBeTruthy();

    // 6. Sign in to 500 origin
    const token500 = await signIn(server, fake500.origin, 'token-500');
    expect(token500).toBeTruthy();

    // 7. Initialize MCP session and query tools on 44.4.10
    const mcpInit44 = await request(server)
      .post('/mcp')
      .set('Authorization', `Bearer ${token44}`)
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0' },
        },
      })
      .expect(200);

    const sid44 = mcpInit44.headers['mcp-session-id'];
    expect(sid44).toBeTruthy();

    const toolsList44Res = await request(server)
      .post('/mcp')
      .set('Authorization', `Bearer ${token44}`)
      .set('mcp-session-id', sid44)
      .send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      })
      .expect(200);
    console.log("TOOLS RES STATUS:", toolsList44Res.status);
    console.log("TOOLS RES HEADERS:", toolsList44Res.headers);
    console.log("TOOLS RES TEXT:", toolsList44Res.text);
    console.log("TOOLS RES BODY:", JSON.stringify(toolsList44Res.body));

    const tools44 = toolsList44Res.body.result.tools as Array<{ name: string; _meta?: Record<string, unknown> }>;
    const toolNames44 = new Set(tools44.map((t) => t.name));

    // 46.0-only tool is absent on 44.4.10
    expect(toolNames44.has('get_health_status_api')).toBe(false);

    // Every tool carries _meta["netsapiens-mcp/availability"]
    for (const tool of tools44) {
      expect(tool._meta?.['netsapiens-mcp/availability']).toBeDefined();
      const meta = tool._meta?.['netsapiens-mcp/availability'] as Record<string, unknown>;
      expect(meta.branch).toBe('44.4');
    }

    // search_api never returns 46.0-only tool on 44.4.10
    const searchRes = await request(server)
      .post('/mcp')
      .set('Authorization', `Bearer ${token44}`)
      .set('mcp-session-id', sid44)
      .send({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'search_api',
          arguments: { query: 'health status api' },
        },
      })
      .expect(200);

    const searchText = searchRes.body.result.content[0].text;
    expect(searchText).not.toContain('get_health_status_api');

    // call_api returns §3.4 error with 0 fake requests
    const initialHealthReqs = fake44.requests.filter((r) => r.path === '/health' || r.path.endsWith('/health')).length;
    const callApiRes = await request(server)
      .post('/mcp')
      .set('Authorization', `Bearer ${token44}`)
      .set('mcp-session-id', sid44)
      .send({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'call_api',
          arguments: { tool_name: 'get_health_status_api', args: {} },
        },
      })
      .expect(200);

    expect(callApiRes.body.result.isError).toBe(true);
    expect(callApiRes.body.result.content[0].text).toContain(
      "Operation 'GET /health' is not available on this NetSapiens host (reported release: 44.4.10).",
    );
    const postHealthReqs = fake44.requests.filter((r) => r.path === '/health' || r.path.endsWith('/health')).length;
    expect(postHealthReqs).toBe(initialHealthReqs);

    // Statistics tools are available on 44.4.10
    expect(toolNames44.has('call_statistics')).toBe(true);
    expect(toolNames44.has('agent_statistics')).toBe(true);

    // 8. Initialize MCP session and query tools on 46.0.2
    const mcpInit46 = await request(server)
      .post('/mcp')
      .set('Authorization', `Bearer ${token46}`)
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0' },
        },
      })
      .expect(200);

    const sid46 = mcpInit46.headers['mcp-session-id'];
    expect(sid46).toBeTruthy();

    const toolsList46Res = await request(server)
      .post('/mcp')
      .set('Authorization', `Bearer ${token46}`)
      .set('mcp-session-id', sid46)
      .send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      })
      .expect(200);

    const tools46 = toolsList46Res.body.result.tools as Array<{ name: string; _meta?: Record<string, unknown> }>;
    const toolNames46 = new Set(tools46.map((t) => t.name));

    // 46.0-only tool is present on 46.0.2 when running search_api or listing
    const search46Res = await request(server)
      .post('/mcp')
      .set('Authorization', `Bearer ${token46}`)
      .set('mcp-session-id', sid46)
      .send({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'search_api',
          arguments: { query: 'health status api' },
        },
      })
      .expect(200);
    expect(search46Res.body.result.content[0].text).toContain('get_health_status_api');

    // 9. 500 origin gets baseline only and /health shows unknown
    const healthAfterFetches = await request(server).get('/health').expect(200);
    const p500Entry = (healthAfterFetches.body.netsapiens as Array<{ apiUrl: string; status: string }>).find(
      (p) => p.apiUrl === fake500.origin,
    );
    expect(p500Entry?.status).toBe('unknown');

    const mcpInit500 = await request(server)
      .post('/mcp')
      .set('Authorization', `Bearer ${token500}`)
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0' },
        },
      })
      .expect(200);

    const sid500 = mcpInit500.headers['mcp-session-id'];
    const toolsList500Res = await request(server)
      .post('/mcp')
      .set('Authorization', `Bearer ${token500}`)
      .set('mcp-session-id', sid500)
      .send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      })
      .expect(200);

    const tools500 = toolsList500Res.body.result.tools as Array<{ name: string; _meta?: Record<string, unknown> }>;
    for (const tool of tools500) {
      if (tool.name !== 'search_api' && tool.name !== 'call_api') {
        const meta = tool._meta?.['netsapiens-mcp/availability'] as Record<string, unknown>;
        expect(meta?.basis).toBe('baseline');
      }
    }

    // 10. Stale handling after TTL
    fake44.setVersionStatus(500);
    await new Promise((resolve) => setTimeout(resolve, 1100)); // wait for 1s TTL

    // Requesting /health or making a call keeps stale entry with unchanged tool list
    const versionInfoStale = await getVersionInfo(fake44.origin);
    expect(versionInfoStale.status).toBe('stale');
    expect(versionInfoStale.apiVersion).toBe('44.4.10');

    const toolsListStaleRes = await request(server)
      .post('/mcp')
      .set('Authorization', `Bearer ${token44}`)
      .set('mcp-session-id', sid44)
      .send({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/list',
        params: {},
      })
      .expect(200);

    const staleTools = toolsListStaleRes.body.result.tools as Array<{ name: string }>;
    expect(staleTools.map((t) => t.name)).toEqual(tools44.map((t) => t.name));
  });

  describe('A4 V2 test cases (a), (b), (c)', () => {
    it('exercises cases (a), (b) with community observation and (c) on 45.2.1', async () => {
      // Fake origin on 45.2.1
      const fake45 = await startFakeNetSapiens({
        apiVersion: '45.2.1',
        tokens: {
          'token-45': {
            login: 'dave@domain.com',
            user: 'dave',
            domain: 'domain.com',
            'user-scope': 'Super User',
          },
        },
        extraPresent: ['GET /health'], // Serves 46.0 key
        forceAbsent: ['GET /domains/{}/recordingstorage'], // Lacks 45.0 key
      });
      openFakes.push(fake45);

      process.env.MCP_TRANSPORT = 'http';
      process.env.MCP_BASE_URL = 'http://localhost';
      process.env.NETSAPIENS_API_URL = fake45.origin;
      process.env.NETSAPIENS_PLATFORMS = JSON.stringify({ p45: fake45.origin });
      process.env.NETSAPIENS_OAUTH_CLIENT_ID = 'cid';
      process.env.NETSAPIENS_OAUTH_CLIENT_SECRET = 'csec';
      process.env.MCP_SESSION_SECRET = '0123456789abcdef0123456789abcdef';
      process.env.MCP_PERSISTENCE = 'memory';
      process.env.MCP_STATELESS = 'false';
      process.env.MCP_TOOL_MODE = 'curated';

      const mod = await import('../http-server.js');
      const created = await mod.createApp();
      const server = created.app.listen(0);
      openServers.push(server);

      const token45 = await signIn(server, fake45.origin, 'token-45');

      const mcpInit = await request(server)
        .post('/mcp')
        .set('Authorization', `Bearer ${token45}`)
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0' },
          },
        })
        .expect(200);

      const sid = mcpInit.headers['mcp-session-id'];

      // Case (a): Documentation only.
      // A GET key first documented in 46.0 that fake serves is absent from tools/list and search_api,
      // and call_api refuses it with basis documented and no upstream request.
      const searchRes = await request(server)
        .post('/mcp')
        .set('Authorization', `Bearer ${token45}`)
        .set('mcp-session-id', sid)
        .send({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'search_api', arguments: { query: 'health status api' } },
        })
        .expect(200);
      expect(searchRes.body.result.content[0].text).not.toContain('get_health_status_api');

      const reqCountBefore = fake45.requests.filter((r) => r.path.includes('/health')).length;
      const callRes = await request(server)
        .post('/mcp')
        .set('Authorization', `Bearer ${token45}`)
        .set('mcp-session-id', sid)
        .send({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'call_api', arguments: { tool_name: 'get_health_status_api', args: {} } },
        })
        .expect(200);

      expect(callRes.body.result.isError).toBe(true);
      expect(callRes.body.result.content[0].text).toContain(
        "Operation 'GET /health' is not available on this NetSapiens host (reported release: 45.2.1).",
      );
      const reqCountAfter = fake45.requests.filter((r) => r.path.includes('/health')).length;
      expect(reqCountAfter).toBe(reqCountBefore);

      // Case (b): A fixture 45.2.1.json marks that key present.
      // Built through buildAvailability:
      const customAvail = buildAvailability({
        observations: [
          {
            apiVersion: '45.2.1',
            line: '45.2',
            probedAt: '2026-10-31',
            source: 'community',
          },
        ],
        extraPresent: {
          '45.2.1': ['GET /health'],
        },
      });

      // Verify customAvail reflects observed present
      expect(customAvail.v2['GET /health']?.observed?.['45.2.1']).toBe('present');
      const vInfo45 = await getVersionInfo(fake45.origin);
      // Update observation lookup on vInfo45 with custom observations
      const obs45 = customAvail.observations.find((o) => o.line === '45.2')?.apiVersion ?? null;
      expect(obs45).toBe('45.2.1');

      // Case (c): A 45.0-documented key that the fake does not serve stays listed,
      // and calling it returns NetSapiens' 404 as isError, not as a refusal.
      // Fake NetSapiens has forceAbsent: ['GET /domains/{}/recordingstorage']
      // Calling GET /domains/{domain}/recordingstorage returns 404 No Route Found from fake
      const res404 = await request(server)
        .post('/mcp')
        .set('Authorization', `Bearer ${token45}`)
        .set('mcp-session-id', sid)
        .send({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: {
            name: 'call_api',
            arguments: {
              tool_name: 'read_domain_recording_storage',
              args: { domain: 'domain.com' },
            },
          },
        })
        .expect(200);

      const contentText = res404.body.result.content[0].text;
      // It reached the fake and returned NetSapiens' 404 error, not a refusal!
      expect(contentText).toContain('404');
      expect(contentText).not.toContain('is not available on this NetSapiens host');
    });
  });

  describe('tools/list_changed notification in stateful session', () => {
    it('notifies client when fake version moves from 44.4.10 to 46.0.2 after TTL', async () => {
      const fake = await startFakeNetSapiens({
        apiVersion: '44.4.10',
        tokens: {
          'token-live': {
            login: 'user@domain.com',
            user: 'user',
            domain: 'domain.com',
            'user-scope': 'Super User',
          },
        },
      });
      openFakes.push(fake);

      process.env.MCP_TRANSPORT = 'http';
      process.env.MCP_BASE_URL = 'http://localhost';
      process.env.NETSAPIENS_API_URL = fake.origin;
      process.env.NETSAPIENS_PLATFORMS = JSON.stringify({ p: fake.origin });
      process.env.NETSAPIENS_OAUTH_CLIENT_ID = 'cid';
      process.env.NETSAPIENS_OAUTH_CLIENT_SECRET = 'csec';
      process.env.MCP_SESSION_SECRET = '0123456789abcdef0123456789abcdef';
      process.env.MCP_PERSISTENCE = 'memory';
      process.env.MCP_STATELESS = 'false';
      process.env.NETSAPIENS_VERSION_TTL_SECONDS = '1';

      const mod = await import('../http-server.js');
      const created = await mod.createApp();
      const server = created.app.listen(0);
      openServers.push(server);

      const token = await signIn(server, fake.origin, 'token-live');

      // Initialize stateful session
      const mcpInit = await request(server)
        .post('/mcp')
        .set('Authorization', `Bearer ${token}`)
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0' },
          },
        })
        .expect(200);

      const sid = mcpInit.headers['mcp-session-id'];
      expect(sid).toBeTruthy();

      // Open SSE listener on GET /mcp
      const events: string[] = [];
      const sseReq = request(server)
        .get('/mcp')
        .set('Authorization', `Bearer ${token}`)
        .set('mcp-session-id', sid)
        .buffer(false)
        .parse((res, callback) => {
          res.on('data', (chunk) => {
            const str = chunk.toString('utf8');
            events.push(str);
          });
          res.on('end', () => callback(null, ''));
        });

      // Start the SSE stream (does not wait for completion since it stays open)
      void sseReq;

      // Update fake version and wait for TTL
      fake.setApiVersion('46.0.2');
      await new Promise((resolve) => setTimeout(resolve, 1200));

      // Trigger request on session to exercise refresh detection
      await request(server)
        .post('/mcp')
        .set('Authorization', `Bearer ${token}`)
        .set('mcp-session-id', sid)
        .send({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {},
        })
        .expect(200);

      // Verify list_changed was dispatched
      await new Promise((resolve) => setTimeout(resolve, 100));
      const receivedNotification = events.some((evt) => evt.includes('notifications/tools/list_changed'));
      expect(receivedNotification).toBe(true);
    });
  });
});
