import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks
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

// Mock the NetSapiensClient
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
    this.handleRequest = mockHandleRequest;
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

// Mock createMcpExpressApp - build a minimal Express-like app
let registeredRoutes: Record<string, Record<string, Function>> = {};
const mockListen = vi.fn();

vi.mock('@modelcontextprotocol/sdk/server/express.js', () => ({
  createMcpExpressApp: vi.fn(() => {
    registeredRoutes = {};
    return {
      get: (path: string, handler: Function) => {
        if (!registeredRoutes[path]) registeredRoutes[path] = {};
        registeredRoutes[path].get = handler;
      },
      post: (path: string, handler: Function) => {
        if (!registeredRoutes[path]) registeredRoutes[path] = {};
        registeredRoutes[path].post = handler;
      },
      delete: (path: string, handler: Function) => {
        if (!registeredRoutes[path]) registeredRoutes[path] = {};
        registeredRoutes[path].delete = handler;
      },
      listen: mockListen.mockImplementation((_port: number, _host: string, cb?: Function) => {
        if (cb) cb();
      }),
    };
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
] as const;

function mockRes() {
  const res: any = {
    writeHead: vi.fn(),
    end: vi.fn(),
  };
  return res;
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('startHttpServer()', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockOnClose = undefined;
    mockSessionId = 'test-session-id';

    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    process.env.NETSAPIENS_API_TOKEN = 'test-token';
    delete process.env.NETSAPIENS_OAUTH_CLIENT_ID;
    delete process.env.NETSAPIENS_OAUTH_CLIENT_SECRET;
    delete process.env.NETSAPIENS_OAUTH_USERNAME;
    delete process.env.NETSAPIENS_OAUTH_PASSWORD;
    delete process.env.MCP_PORT;
    delete process.env.MCP_HOST;
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

  it('starts the HTTP server on the default port and host', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await startHttpServer();

    expect(mockListen).toHaveBeenCalledWith(3000, '0.0.0.0', expect.any(Function));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('listening on 0.0.0.0:3000'));
    consoleSpy.mockRestore();
  });

  it('uses MCP_PORT and MCP_HOST env vars when set', async () => {
    process.env.MCP_PORT = '8080';
    process.env.MCP_HOST = '127.0.0.1';
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await startHttpServer();

    expect(mockListen).toHaveBeenCalledWith(8080, '127.0.0.1', expect.any(Function));
    consoleSpy.mockRestore();
  });

  it('registers /health, /mcp GET, /mcp POST, and /mcp DELETE routes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await startHttpServer();

    expect(registeredRoutes['/health']?.get).toBeDefined();
    expect(registeredRoutes['/mcp']?.get).toBeDefined();
    expect(registeredRoutes['/mcp']?.post).toBeDefined();
    expect(registeredRoutes['/mcp']?.delete).toBeDefined();
  });

  it('/health returns { status: "ok" }', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await startHttpServer();

    const res = mockRes();
    registeredRoutes['/health'].get({}, res);

    expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ status: 'ok' }));
  });

  it('POST /mcp with initialize request creates a new session', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await startHttpServer();

    const req: any = {
      headers: {},
      body: { method: 'initialize', jsonrpc: '2.0', id: 1 },
    };
    const res = mockRes();

    await registeredRoutes['/mcp'].post(req, res);

    expect(mockConnect).toHaveBeenCalled();
    expect(mockHandleRequest).toHaveBeenCalledWith(req, res, req.body);
  });

  it('POST /mcp without session ID and non-initialize returns 400', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await startHttpServer();

    const req: any = {
      headers: {},
      body: { method: 'tools/list', jsonrpc: '2.0', id: 2 },
    };
    const res = mockRes();

    await registeredRoutes['/mcp'].post(req, res);

    expect(res.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
    expect(res.end).toHaveBeenCalledWith(
      expect.stringContaining('Invalid or missing session ID')
    );
  });

  it('GET /mcp without valid session ID returns 400', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await startHttpServer();

    const req: any = { headers: {} };
    const res = mockRes();

    await registeredRoutes['/mcp'].get(req, res);

    expect(res.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
  });

  it('DELETE /mcp without valid session ID returns 400', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await startHttpServer();

    const req: any = { headers: {} };
    const res = mockRes();

    await registeredRoutes['/mcp'].delete(req, res);

    expect(res.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
  });

  it('DELETE /mcp with valid session ID terminates the session', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await startHttpServer();

    // First create a session via initialize
    const initReq: any = {
      headers: {},
      body: { method: 'initialize', jsonrpc: '2.0', id: 1 },
    };
    await registeredRoutes['/mcp'].post(initReq, mockRes());

    // Now delete it
    const deleteReq: any = {
      headers: { 'mcp-session-id': 'test-session-id' },
    };
    const deleteRes = mockRes();

    await registeredRoutes['/mcp'].delete(deleteReq, deleteRes);

    expect(mockTransportClose).toHaveBeenCalled();
    expect(deleteRes.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
    expect(deleteRes.end).toHaveBeenCalledWith(
      expect.stringContaining('session terminated')
    );
  });

  it('session cleanup on transport close removes from map', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await startHttpServer();

    // Create a session
    const initReq: any = {
      headers: {},
      body: { method: 'initialize', jsonrpc: '2.0', id: 1 },
    };
    await registeredRoutes['/mcp'].post(initReq, mockRes());

    // Trigger the onclose callback
    expect(mockOnClose).toBeDefined();
    mockOnClose!();

    // Now trying to GET with that session ID should fail
    const getReq: any = {
      headers: { 'mcp-session-id': 'test-session-id' },
    };
    const getRes = mockRes();
    await registeredRoutes['/mcp'].get(getReq, getRes);

    expect(getRes.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
  });
});
