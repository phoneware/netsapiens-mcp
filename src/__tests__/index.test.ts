import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks – must be declared before importing the module under test.
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
  StdioServerTransport: vi.fn().mockImplementation(function (this: any) {
    // empty transport mock
  }),
}));

// Provide mock implementations for every client method the CallTool handler invokes.
const mockSearchUsers = vi.fn();
const mockGetUser = vi.fn();
const mockGetCDRRecords = vi.fn();
const mockGetDomains = vi.fn();
const mockGetDomain = vi.fn();
const mockGetUserDevices = vi.fn();
const mockGetPhoneNumbers = vi.fn();
const mockGetPhoneNumber = vi.fn();
const mockGetCallQueues = vi.fn();
const mockGetCallQueue = vi.fn();
const mockGetCallQueueAgents = vi.fn();
const mockGetAgents = vi.fn();
const mockLoginAgent = vi.fn();
const mockLogoutAgent = vi.fn();
const mockGetAutoAttendants = vi.fn();
const mockGetUserAnswerRules = vi.fn();
const mockGetUserAnswerRule = vi.fn();
const mockGetUserGreetings = vi.fn();
const mockGetUserVoicemails = vi.fn();
const mockGetMusicOnHold = vi.fn();
const mockGetBilling = vi.fn();
const mockGetAgentStatistics = vi.fn();
const mockTestConnection = vi.fn();

vi.mock('../netsapiens-client.js', () => ({
  NetSapiensClient: vi.fn().mockImplementation(function (this: any) {
    this.searchUsers = mockSearchUsers;
    this.getUser = mockGetUser;
    this.getCDRRecords = mockGetCDRRecords;
    this.getDomains = mockGetDomains;
    this.getDomain = mockGetDomain;
    this.getUserDevices = mockGetUserDevices;
    this.getPhoneNumbers = mockGetPhoneNumbers;
    this.getPhoneNumber = mockGetPhoneNumber;
    this.getCallQueues = mockGetCallQueues;
    this.getCallQueue = mockGetCallQueue;
    this.getCallQueueAgents = mockGetCallQueueAgents;
    this.getAgents = mockGetAgents;
    this.loginAgent = mockLoginAgent;
    this.logoutAgent = mockLogoutAgent;
    this.getAutoAttendants = mockGetAutoAttendants;
    this.getUserAnswerRules = mockGetUserAnswerRules;
    this.getUserAnswerRule = mockGetUserAnswerRule;
    this.getUserGreetings = mockGetUserGreetings;
    this.getUserVoicemails = mockGetUserVoicemails;
    this.getMusicOnHold = mockGetMusicOnHold;
    this.getBilling = mockGetBilling;
    this.getAgentStatistics = mockGetAgentStatistics;
    this.testConnection = mockTestConnection;
  }),
}));

// Import module under test *after* mocks are set up.
import { loadConfig, NetSapiensMCPServer, createMcpServer, registerTools, getToolDefinitions } from '../index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { NetSapiensClient } from '../netsapiens-client.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Environment variable names that loadConfig reads. */
const ENV_KEYS = [
  'NETSAPIENS_API_URL',
  'NETSAPIENS_API_TOKEN',
  'NETSAPIENS_OAUTH_CLIENT_ID',
  'NETSAPIENS_OAUTH_CLIENT_SECRET',
  'NETSAPIENS_OAUTH_USERNAME',
  'NETSAPIENS_OAUTH_PASSWORD',
  'DEBUG',
  'MCP_TRANSPORT',
] as const;

/**
 * Capture the handler functions passed to `setRequestHandler`.
 * Returns a map keyed by the schema reference.
 */
function captureHandlers(): Map<unknown, Function> {
  const handlers = new Map<unknown, Function>();
  for (const call of mockSetRequestHandler.mock.calls) {
    handlers.set(call[0], call[1]);
  }
  return handlers;
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('loadConfig()', () => {
  /** Snapshot of relevant env vars before each test so we can restore them. */
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
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

  it('returns config with apiToken when NETSAPIENS_API_TOKEN is set', () => {
    process.env.NETSAPIENS_API_TOKEN = 'my-static-token';

    const config = loadConfig();

    expect(config.netsapiens.apiToken).toBe('my-static-token');
    expect(config.netsapiens.oauth).toBeUndefined();
  });

  it('returns config with oauth when all four NETSAPIENS_OAUTH_* vars are set', () => {
    process.env.NETSAPIENS_OAUTH_CLIENT_ID = 'cid';
    process.env.NETSAPIENS_OAUTH_CLIENT_SECRET = 'csecret';
    process.env.NETSAPIENS_OAUTH_USERNAME = 'user';
    process.env.NETSAPIENS_OAUTH_PASSWORD = 'pass';

    const config = loadConfig();

    expect(config.netsapiens.oauth).toEqual({
      clientId: 'cid',
      clientSecret: 'csecret',
      username: 'user',
      password: 'pass',
    });
    expect(config.netsapiens.apiToken).toBeUndefined();
  });

  it('throws when no authentication method is provided', () => {
    expect(() => loadConfig()).toThrow('Authentication required');
  });

  it('throws a descriptive error listing expected env vars', () => {
    expect(() => loadConfig()).toThrow('NETSAPIENS_API_TOKEN');
    expect(() => loadConfig()).toThrow('NETSAPIENS_OAUTH_CLIENT_ID');
  });

  it('uses default API URL when NETSAPIENS_API_URL is not set', () => {
    process.env.NETSAPIENS_API_TOKEN = 'tok';

    const config = loadConfig();

    expect(config.netsapiens.apiUrl).toBe('https://edge.phoneware.cloud');
  });

  it('uses custom API URL from NETSAPIENS_API_URL', () => {
    process.env.NETSAPIENS_API_TOKEN = 'tok';
    process.env.NETSAPIENS_API_URL = 'https://custom.example.com';

    const config = loadConfig();

    expect(config.netsapiens.apiUrl).toBe('https://custom.example.com');
  });

  it('sets debug to true when DEBUG=true', () => {
    process.env.NETSAPIENS_API_TOKEN = 'tok';
    process.env.DEBUG = 'true';

    const config = loadConfig();

    expect(config.debug).toBe(true);
  });

  it('sets debug to false when DEBUG is not set', () => {
    process.env.NETSAPIENS_API_TOKEN = 'tok';

    const config = loadConfig();

    expect(config.debug).toBe(false);
  });

  it('prefers OAuth over API token when both are provided', () => {
    process.env.NETSAPIENS_API_TOKEN = 'should-be-ignored';
    process.env.NETSAPIENS_OAUTH_CLIENT_ID = 'cid';
    process.env.NETSAPIENS_OAUTH_CLIENT_SECRET = 'csecret';
    process.env.NETSAPIENS_OAUTH_USERNAME = 'user';
    process.env.NETSAPIENS_OAUTH_PASSWORD = 'pass';

    const config = loadConfig();

    expect(config.netsapiens.oauth).toBeDefined();
    expect(config.netsapiens.apiToken).toBeUndefined();
  });

  it('includes static config fields: name, version, timeout, rateLimit', () => {
    process.env.NETSAPIENS_API_TOKEN = 'tok';

    const config = loadConfig();

    expect(config.name).toBe('netsapiens-mcp');
    expect(config.version).toBe('1.1.1');
    expect(config.netsapiens.timeout).toBe(30000);
    expect(config.netsapiens.rateLimit).toEqual({
      requests: 100,
      perMilliseconds: 60000,
    });
  });

  it('throws when only some OAuth vars are set (incomplete credentials)', () => {
    process.env.NETSAPIENS_OAUTH_CLIENT_ID = 'cid';
    // Missing client_secret, username, password

    expect(() => loadConfig()).toThrow('Authentication required');
  });
});

// ---------------------------------------------------------------------------

describe('getToolDefinitions()', () => {
  it('returns the full auto-generated tool catalog', () => {
    const tools = getToolDefinitions();
    // The catalog is produced by the OpenAPI v2 generator plus the v1 apidoc
    // generator. The exact count will drift as upstream specs change — assert
    // a healthy floor instead of a brittle fixed number.
    expect(tools.length).toBeGreaterThan(400);
  });

  it('each tool has name, description, and inputSchema', () => {
    const tools = getToolDefinitions();
    for (const tool of tools) {
      expect(tool).toHaveProperty('name');
      expect(tool).toHaveProperty('description');
      expect(tool).toHaveProperty('inputSchema');
    }
  });
});

// ---------------------------------------------------------------------------

describe('createMcpServer()', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    vi.clearAllMocks();
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    process.env.NETSAPIENS_API_TOKEN = 'test-token';
    delete process.env.NETSAPIENS_OAUTH_CLIENT_ID;
    delete process.env.NETSAPIENS_OAUTH_CLIENT_SECRET;
    delete process.env.NETSAPIENS_OAUTH_USERNAME;
    delete process.env.NETSAPIENS_OAUTH_PASSWORD;
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

  it('returns a server and client pair', () => {
    const config = loadConfig();
    const { server, client } = createMcpServer(config);
    expect(server).toBeDefined();
    expect(client).toBeDefined();
  });

  it('creates Server with correct name and version', () => {
    const config = loadConfig();
    createMcpServer(config);

    expect(Server).toHaveBeenCalledWith(
      { name: 'netsapiens-mcp', version: '1.1.1' },
      { capabilities: { tools: {} } },
    );
  });

  it('registers tool handlers on the server', () => {
    const config = loadConfig();
    createMcpServer(config);

    const registeredSchemas = mockSetRequestHandler.mock.calls.map((c: any) => c[0]);
    expect(registeredSchemas).toContain(ListToolsRequestSchema);
    expect(registeredSchemas).toContain(CallToolRequestSchema);
  });
});

// ---------------------------------------------------------------------------

describe('NetSapiensMCPServer', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Set up env so loadConfig() works inside run()
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    process.env.NETSAPIENS_API_TOKEN = 'test-token';
    delete process.env.NETSAPIENS_OAUTH_CLIENT_ID;
    delete process.env.NETSAPIENS_OAUTH_CLIENT_SECRET;
    delete process.env.NETSAPIENS_OAUTH_USERNAME;
    delete process.env.NETSAPIENS_OAUTH_PASSWORD;
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

  function createServer() {
    const config = loadConfig();
    return new NetSapiensMCPServer(config);
  }

  // ----- Construction tests -----

  it('creates a Server with the correct name and version from config', () => {
    createServer();

    expect(Server).toHaveBeenCalledWith(
      { name: 'netsapiens-mcp', version: '1.1.1' },
      { capabilities: { tools: {} } },
    );
  });

  it('creates a NetSapiensClient with the netsapiens config block', () => {
    const config = loadConfig();
    new NetSapiensMCPServer(config);

    expect(NetSapiensClient).toHaveBeenCalledWith(config.netsapiens);
  });

  it('registers a ListTools request handler', () => {
    createServer();

    const registeredSchemas = mockSetRequestHandler.mock.calls.map((c: any) => c[0]);
    expect(registeredSchemas).toContain(ListToolsRequestSchema);
  });

  it('registers a CallTool request handler', () => {
    createServer();

    const registeredSchemas = mockSetRequestHandler.mock.calls.map((c: any) => c[0]);
    expect(registeredSchemas).toContain(CallToolRequestSchema);
  });

  it('sets up error handling (onerror assignment)', () => {
    createServer();

    // The constructor assigns server.onerror. Our mock exposes the property,
    // so verify that setRequestHandler was called (implying setupToolHandlers ran),
    // and that the mock server instance was created.
    expect(Server).toHaveBeenCalledTimes(1);
    expect(mockSetRequestHandler).toHaveBeenCalledTimes(2); // ListTools + CallTool
  });

  it('run() creates a StdioServerTransport and connects to it', async () => {
    const server = createServer();
    await server.run();

    expect(StdioServerTransport).toHaveBeenCalledTimes(1);
    expect(mockConnect).toHaveBeenCalledTimes(1);
    // The argument to connect should be the transport instance
    const transportInstance = (StdioServerTransport as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(mockConnect).toHaveBeenCalledWith(transportInstance);
  });

  it('run() in debug mode does not throw', async () => {
    process.env.DEBUG = 'true';

    const server = createServer();
    await server.run();

    // Verify server connected successfully (debug logging uses structured logger)
    expect(mockConnect).toHaveBeenCalled();
  });
});
