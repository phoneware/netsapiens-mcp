import type { MCPServerConfig, NetSapiensConfig } from '../types/config.js';
import type { OAuthConfig, OAuthTokens } from '../oauth-manager.js';

// ── Static token config ──
export const STATIC_TOKEN_CONFIG: NetSapiensConfig = {
  apiUrl: 'https://api.example.com',
  apiToken: 'test-static-token',
  timeout: 5000,
};

// ── OAuth config ──
export const OAUTH_NS_CONFIG: NetSapiensConfig = {
  apiUrl: 'https://api.example.com',
  oauth: {
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    username: 'testuser',
    password: 'testpass',
  },
  timeout: 5000,
};

export const OAUTH_CONFIG: OAuthConfig = {
  apiUrl: 'https://api.example.com',
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  username: 'testuser',
  password: 'testpass',
};

// ── MCP server configs ──
export const MCP_CONFIG_STATIC: MCPServerConfig = {
  name: 'test-mcp',
  version: '0.0.1',
  netsapiens: STATIC_TOKEN_CONFIG,
  debug: false,
};

export const MCP_CONFIG_OAUTH: MCPServerConfig = {
  name: 'test-mcp',
  version: '0.0.1',
  netsapiens: OAUTH_NS_CONFIG,
  debug: false,
};

// ── Mock token responses ──
export const MOCK_TOKEN_RESPONSE: OAuthTokens = {
  access_token: 'mock-access-token',
  refresh_token: 'mock-refresh-token',
  expires_in: 3600,
  token_type: 'Bearer',
  expires_at: Date.now() + 3600 * 1000,
};

export const MOCK_EXPIRED_TOKENS: OAuthTokens = {
  access_token: 'expired-access-token',
  refresh_token: 'old-refresh-token',
  expires_in: 3600,
  token_type: 'Bearer',
  expires_at: Date.now() - 1000, // already expired
};

export const MOCK_FRESH_TOKENS: OAuthTokens = {
  access_token: 'fresh-access-token',
  refresh_token: 'fresh-refresh-token',
  expires_in: 7200,
  token_type: 'Bearer',
  expires_at: Date.now() + 7200 * 1000,
};

// ── Mock API responses ──
export const MOCK_USERS = [
  { user: 'john', domain: 'example.com', first_name: 'John', last_name: 'Doe' },
  { user: 'jane', domain: 'example.com', first_name: 'Jane', last_name: 'Smith' },
];

export const MOCK_DOMAINS = [
  { domain: 'example.com', description: 'Test Domain', status: 'active' },
  { domain: 'other.com', description: 'Other Domain', status: 'active' },
];

export const MOCK_CDR_RECORDS = [
  { call_id: 'c1', caller: '1001', callee: '1002', duration: 120, disposition: 'answered' },
  { call_id: 'c2', caller: '1003', callee: '1001', duration: 60, disposition: 'answered' },
];

export const MOCK_DEVICES = [
  { object: 'device', mac: 'AA:BB:CC:DD:EE:FF', user: 'john', domain: 'example.com' },
];

export const MOCK_PHONE_NUMBERS = [
  { phonenumber: '15551234567', domain: 'example.com', user: 'john' },
];

export const MOCK_CALL_QUEUES = [
  { object: 'callqueue', domain: 'example.com', name: 'Support', status: 'active' },
];

export const MOCK_AGENTS = [
  { object: 'agent', agent: 'agent1', domain: 'example.com', status: 'available' },
];
