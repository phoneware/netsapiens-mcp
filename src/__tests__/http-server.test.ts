import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';

// ---------------------------------------------------------------------------
// Module mocks — must come before importing the module under test
// ---------------------------------------------------------------------------

const mockSetRequestHandler = vi.fn();
const mockConnect = vi.fn();
const mockClose = vi.fn();

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: vi.fn().mockImplementation(function (this: any) {
    this.setRequestHandler = mockSetRequestHandler;
    this.connect = mockConnect;
    this.close = mockClose;
    this.onerror = null;
  }),
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn(),
}));

vi.mock('../netsapiens-client.js', () => ({
  NetSapiensClient: vi.fn().mockImplementation(function (this: any) {
    this.searchUsers = vi.fn();
    this.getUser = vi.fn();
    this.getCDRRecords = vi.fn();
    this.getDomains = vi.fn();
    this.getDomain = vi.fn();
    this.getUserDevices = vi.fn();
    this.getPhoneNumbers = vi.fn();
    this.getPhoneNumber = vi.fn();
    this.getCallQueues = vi.fn();
    this.getCallQueue = vi.fn();
    this.getCallQueueAgents = vi.fn();
    this.getAgents = vi.fn();
    this.loginAgent = vi.fn();
    this.logoutAgent = vi.fn();
    this.getAutoAttendants = vi.fn();
    this.getUserAnswerRules = vi.fn();
    this.getUserAnswerRule = vi.fn();
    this.getUserGreetings = vi.fn();
    this.getUserVoicemails = vi.fn();
    this.getMusicOnHold = vi.fn();
    this.getBilling = vi.fn();
    this.getAgentStatistics = vi.fn();
    this.testConnection = vi.fn();
  }),
}));

// Mock StreamableHTTPServerTransport
const mockHandleRequest = vi.fn();
const mockTransportClose = vi.fn();
let mockSessionId = 'test-session-id';
let mockOnClose: (() => void) | undefined;

vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: vi.fn().mockImplementation(function (this: any) {
    this.handleRequest = mockHandleRequest.mockImplementation((_req: any, res: any) => {
      // End the response so the HTTP request doesn't hang
      if (res && typeof res.end === 'function' && !res.writableEnded) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      }
    });
    this.close = mockTransportClose;
    Object.defineProperty(this, 'sessionId', {
      get: () => mockSessionId,
    });
    Object.defineProperty(this, 'onclose', {
      get: () => mockOnClose,
      set: (fn: (() => void) | undefined) => { mockOnClose = fn; },
    });
  }),
}));

vi.mock('@modelcontextprotocol/sdk/types.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    isInitializeRequest: vi.fn((body: any) => {
      return body?.method === 'initialize';
    }),
  };
});

// Mock the auth router and bearer auth middleware so we don't need real OAuth
vi.mock('@modelcontextprotocol/sdk/server/auth/router.js', () => ({
  mcpAuthRouter: vi.fn(() => {
    // Return a no-op middleware
    return (_req: any, _res: any, next: any) => next();
  }),
  getOAuthProtectedResourceMetadataUrl: vi.fn(() => 'http://localhost:3000/.well-known/oauth-protected-resource/mcp'),
}));

vi.mock('@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js', () => ({
  requireBearerAuth: vi.fn(() => {
    // Return middleware that always passes with mock auth info
    return (req: any, _res: any, next: any) => {
      req.auth = {
        token: 'test-bearer-token',
        clientId: 'test-client',
        scopes: [],
        extra: { nsAccessToken: 'ns-token-123', nsUsername: 'testuser' },
      };
      next();
    };
  }),
}));

// Mock the auth provider
vi.mock('../auth/netsapiens-auth-provider.js', () => ({
  NetSapiensAuthProvider: vi.fn().mockImplementation(function (this: any) {
    this.clientsStore = { getClient: vi.fn() };
    this.handleLogin = vi.fn();
  }),
}));

import { startHttpServer } from '../http-server.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  'NETSAPIENS_API_URL',
  'NETSAPIENS_API_TOKEN',
  'NETSAPIENS_OAUTH_CLIENT_ID',
  'NETSAPIENS_OAUTH_CLIENT_SECRET',
  'NETSAPIENS_OAUTH_USERNAME',
  'NETSAPIENS_OAUTH_PASSWORD',
  'DEBUG',
  'MCP_TRANSPORT',
  'MCP_PORT',
  'MCP_HOST',
  'MCP_BASE_URL',
] as const;

/** Make a simple HTTP request to localhost */
function request(
  port: number,
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const reqHeaders: Record<string, string> = {
      ...options.headers,
    };
    let bodyStr: string | undefined;
    if (options.body) {
      bodyStr = JSON.stringify(options.body);
      reqHeaders['content-type'] = 'application/json';
      reqHeaders['accept'] = 'application/json, text/event-stream';
    }

    const req = http.request(
      { hostname: '127.0.0.1', port, path, method, headers: reqHeaders },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startHttpServer()', () => {
  let savedEnv: Record<string, string | undefined>;
  // Use a different port per test to avoid EADDRINUSE
  let testPort: number;
  let server: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockOnClose = undefined;
    mockSessionId = 'test-session-id';

    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    process.env.NETSAPIENS_API_TOKEN = 'test-token';
    process.env.NETSAPIENS_OAUTH_CLIENT_ID = 'test-ns-client-id';
    process.env.NETSAPIENS_OAUTH_CLIENT_SECRET = 'test-ns-client-secret';
    delete process.env.MCP_HOST;
    delete process.env.MCP_BASE_URL;

    // Pick a random high port for each test
    testPort = 30000 + Math.floor(Math.random() * 10000);
    process.env.MCP_PORT = String(testPort);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it('starts the HTTP server and responds to /health', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await startHttpServer();

    const res = await request(testPort, 'GET', '/health');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
    expect(body).toHaveProperty('uptime');
    expect(body).toHaveProperty('activeSessions');
    expect(body).toHaveProperty('nsApiUrl');
    expect(body).toHaveProperty('version');

    consoleSpy.mockRestore();
  });

  it('returns 401 or routes through bearerAuth on POST /mcp', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await startHttpServer();

    // Our mock bearerAuth always passes, so we should get to the MCP handler.
    // With an initialize request, it should create a session.
    const res = await request(testPort, 'POST', '/mcp', {
      body: { method: 'initialize', jsonrpc: '2.0', id: 1 },
      headers: { authorization: 'Bearer test-token' },
    });

    // The mock transport.handleRequest doesn't write a response, so we may get
    // an empty response. The key assertion is that mockConnect was called
    // (meaning a session was created).
    expect(mockConnect).toHaveBeenCalled();
  });

  it('rejects POST /mcp without session ID for non-initialize requests', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await startHttpServer();

    const res = await request(testPort, 'POST', '/mcp', {
      body: { method: 'tools/list', jsonrpc: '2.0', id: 2 },
      headers: { authorization: 'Bearer test-token' },
    });

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid or missing session ID' });
  });

  it('rejects GET /mcp without valid session ID', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await startHttpServer();

    const res = await request(testPort, 'GET', '/mcp', {
      headers: { authorization: 'Bearer test-token' },
    });

    expect(res.status).toBe(400);
  });

  it('rejects DELETE /mcp without valid session ID', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await startHttpServer();

    const res = await request(testPort, 'DELETE', '/mcp', {
      headers: { authorization: 'Bearer test-token' },
    });

    expect(res.status).toBe(400);
  });

  it('throws when NETSAPIENS_OAUTH_CLIENT_ID is missing', async () => {
    delete process.env.NETSAPIENS_OAUTH_CLIENT_ID;

    await expect(startHttpServer()).rejects.toThrow('NETSAPIENS_OAUTH_CLIENT_ID');
  });

  it('throws when NETSAPIENS_OAUTH_CLIENT_SECRET is missing', async () => {
    delete process.env.NETSAPIENS_OAUTH_CLIENT_SECRET;

    await expect(startHttpServer()).rejects.toThrow('NETSAPIENS_OAUTH_CLIENT_SECRET');
  });
});
