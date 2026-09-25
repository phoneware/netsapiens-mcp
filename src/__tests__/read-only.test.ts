/**
 * Tests for NetSapiens MCP Read-Only Mode & Cross-Server Isolation (phoneware/monorepo#1129).
 *
 * Covers:
 *  - Tool listing in read-only mode contains NO mutating tools
 *  - Direct tools/call of a mutating tool is refused
 *  - call_api with a non-GET operation is refused
 *  - call_api with a GET operation is permitted
 *  - Cross-server token rejection (serverBaseUrl mismatch returns 401 invalid_token)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Server as HttpServer } from 'node:http';
import { NetSapiensAuthProvider } from '../auth/netsapiens-auth-provider.js';
import { isReadOnlyMode, isToolReadOnly, getAllToolDefinitions, handleToolCall } from '../tools/index.js';
import type { NetSapiensClient } from '../netsapiens-client.js';

const openServers: HttpServer[] = [];

async function importApp(envOverrides: Record<string, string> = {}) {
 vi.resetModules();
 process.env.MCP_TRANSPORT = 'http';
 process.env.MCP_BASE_URL = envOverrides.MCP_BASE_URL || 'https://mcp-readonly.edge.phoneware.cloud';
 process.env.NETSAPIENS_API_URL = 'https://edge.phoneware.cloud';
 process.env.NETSAPIENS_OAUTH_CLIENT_ID = 'op-client-id';
 process.env.NETSAPIENS_OAUTH_CLIENT_SECRET = 'op-client-secret';
 process.env.MCP_SESSION_SECRET = '0123456789abcdef0123456789abcdef';
 process.env.MCP_READ_ONLY = 'true';
 for (const [k, v] of Object.entries(envOverrides)) {
  process.env[k] = v;
 }
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

describe('Read-Only Mode & Cross-Server Isolation', () => {
 beforeEach(() => {
  vi.clearAllMocks();
  process.env.MCP_READ_ONLY = 'true';
 });

 afterEach(async () => {
  delete process.env.MCP_READ_ONLY;
  delete process.env.MCP_TOOL_MODE;
  await closeOpenServers();
 });

 describe('isToolReadOnly classification', () => {
  it('correctly classifies mutating curated tools as not read-only', () => {
   const mutating = [
    'place_call',
    'transfer_call',
    'end_call',
    'forward_voicemail',
    'send_message',
    'agent_login',
    'agent_logout',
    'update_my_answer_rule',
    'switch_queue',
    'find_and_call',
    'schedule_forwarding',
    'provision_user',
    'deprovision_user',
    'provision_call_queue',
    'deprovision_call_queue',
    'set_hold_message',
   ];
   for (const name of mutating) {
    expect(isToolReadOnly(name)).toBe(false);
   }
  });

  it('correctly classifies read-only curated tools as read-only', () => {
   const readOnly = [
    'find_user',
    'find_domain',
    'find_contact',
    'find_phone_number',
    'find_device',
    'recent_calls',
    'call_volume',
    'active_calls',
    'call_details',
    'call_trace',
    'my_voicemails',
    'read_voicemail',
    'list_message_sessions',
    'read_messages',
    'list_queues',
    'queue_status',
    'agent_status',
    'my_devices',
    'my_answer_rules',
    'call_statistics',
    'agent_statistics',
    'diagnose_call',
    'user_profile',
    'queue_health',
    'agent_dashboard',
    'recent_activity_for_number',
    'voicemail_inbox_summary',
    'search_api',
    'call_api',
   ];
   for (const name of readOnly) {
    expect(isToolReadOnly(name)).toBe(true);
   }
  });

  it('correctly classifies generated tools based on verb prefixes', () => {
   expect(isToolReadOnly('get_domains')).toBe(true);
   expect(isToolReadOnly('list_callqueues')).toBe(true);
   expect(isToolReadOnly('post_domains')).toBe(false);
   expect(isToolReadOnly('put_domains_by_domain')).toBe(false);
   expect(isToolReadOnly('delete_domains')).toBe(false);
   expect(isToolReadOnly('patch_domains')).toBe(false);
   expect(isToolReadOnly('v1_create_user')).toBe(false);
   expect(isToolReadOnly('v1_read_user')).toBe(true);
  });
 });

 describe('Tool listing in read-only mode', () => {
  it('curated tool list contains NO mutating tools', async () => {
   process.env.MCP_READ_ONLY = 'true';
   const tools = await getAllToolDefinitions('system_admin');
   const toolNames = new Set(tools.map((t) => t.name));

   // Mutating curated tools MUST NOT appear
   expect(toolNames.has('end_call')).toBe(false);
   expect(toolNames.has('place_call')).toBe(false);
   expect(toolNames.has('send_message')).toBe(false);
   expect(toolNames.has('transfer_call')).toBe(false);
   expect(toolNames.has('switch_queue')).toBe(false);
   expect(toolNames.has('schedule_forwarding')).toBe(false);
   expect(toolNames.has('provision_user')).toBe(false);
   expect(toolNames.has('deprovision_user')).toBe(false);
   expect(toolNames.has('set_hold_message')).toBe(false);
   expect(toolNames.has('update_my_answer_rule')).toBe(false);

   // Read-only tools MUST appear
   expect(toolNames.has('recent_calls')).toBe(true);
   expect(toolNames.has('find_domain')).toBe(true);
   expect(toolNames.has('find_user')).toBe(true);
   expect(toolNames.has('active_calls')).toBe(true);
   expect(toolNames.has('call_volume')).toBe(true);
   expect(toolNames.has('search_api')).toBe(true);
   expect(toolNames.has('call_api')).toBe(true);
  });

  it('full generated tool list in read-only mode excludes all POST/PUT/DELETE/PATCH tools', async () => {
   process.env.MCP_READ_ONLY = 'true';
   process.env.MCP_TOOL_MODE = 'full';
   const tools = await getAllToolDefinitions('system_admin');

   for (const tool of tools) {
    expect(tool.name).not.toMatch(/^(post_|put_|delete_|patch_|create_|update_|remove_|add_|set_|switch_|end_|place_|transfer_|forward_|schedule_|provision_|deprovision_)/);
   }

   // Check that GET operations are present
   expect(tools.some((t) => t.name.startsWith('get_'))).toBe(true);
  });
 });

 describe('Call-time enforcement in read-only mode', () => {
  const fakeClient = {
   request: vi.fn().mockResolvedValue({ success: true, data: [] }),
  } as unknown as NetSapiensClient;

  it('refuses direct execution of a mutating tool with McpError', async () => {
   process.env.MCP_READ_ONLY = 'true';

   await expect(
    handleToolCall(fakeClient, 'end_call', { call_id: '123' }, 'system_admin'),
   ).rejects.toThrow(/not permitted in read-only mode/i);

   await expect(
    handleToolCall(fakeClient, 'place_call', { to: '1001' }, 'system_admin'),
   ).rejects.toThrow(/not permitted in read-only mode/i);

   expect(fakeClient.request).not.toHaveBeenCalled();
  });

  it('refuses call_api when invoking a non-GET operation', async () => {
   process.env.MCP_READ_ONLY = 'true';

   await expect(
    handleToolCall(
     fakeClient,
     'call_api',
     { tool_name: 'post_domains_by_domain_backup', args: {} },
     'system_admin',
    ),
   ).rejects.toThrow(/read-only mode permits GET operations only/i);

   await expect(
    handleToolCall(
     fakeClient,
     'call_api',
     { tool_name: 'delete_domain', args: { domain: 'test' } },
     'system_admin',
    ),
   ).rejects.toThrow(/read-only mode permits GET operations only/i);

   expect(fakeClient.request).not.toHaveBeenCalled();
  });

  it('permits call_api when invoking a GET operation', async () => {
   process.env.MCP_READ_ONLY = 'true';

   const res = await handleToolCall(
    fakeClient,
    'call_api',
    { tool_name: 'get_domains', args: { limit: 10 } },
    'system_admin',
   );

   expect(res).toBeDefined();
  });
 });

 describe('OAuth State Isolation (cross-server token rejection)', () => {
  it('rejects a token issued for the standard server when presented to the read-only server', async () => {
   const standardBaseUrl = 'https://mcp.edge.phoneware.cloud';
   const readOnlyBaseUrl = 'https://mcp-readonly.edge.phoneware.cloud';

   // 1. Create standard auth provider and mint a token with its baseUrl
   const standardProvider = new NetSapiensAuthProvider({
    nsApiUrl: 'https://edge.phoneware.cloud',
    nsClientId: 'cid',
    nsClientSecret: 'csec',
    serverBaseUrl: standardBaseUrl,
   });

   const standardBearer = 'bearer-from-standard-server-12345';
   await (standardProvider as any).tokenStore.set({
    accessToken: standardBearer,
    refreshToken: 'refresh-standard',
    clientId: 'client-std',
    expiresAt: Date.now() + 3600_000,
    nsAccessToken: 'ns-token-std',
    nsUsername: 'alice',
    nsUserRole: 'user',
    serverBaseUrl: standardBaseUrl,
   });

   // 2. Start read-only HTTP server (MCP_BASE_URL=https://mcp-readonly.edge.phoneware.cloud)
   const { app, authProvider: readOnlyProvider } = await importApp({
    MCP_BASE_URL: readOnlyBaseUrl,
    MCP_READ_ONLY: 'true',
   });

   // Populate token into readOnlyProvider's store to simulate shared backend storage
   await (readOnlyProvider as any).tokenStore.set({
    accessToken: standardBearer,
    refreshToken: 'refresh-standard',
    clientId: 'client-std',
    expiresAt: Date.now() + 3600_000,
    nsAccessToken: 'ns-token-std',
    nsUsername: 'alice',
    nsUserRole: 'user',
    serverBaseUrl: standardBaseUrl, // issued by standard server!
   });

   // 3. Present standard bearer to read-only server -> must be rejected with 401 invalid_token!
   const res = await request(app)
    .post('/mcp')
    .set('Authorization', `Bearer ${standardBearer}`)
    .send({
     jsonrpc: '2.0',
     id: 1,
     method: 'tools/list',
     params: {},
    });

   expect(res.status).toBe(401);
   expect(res.headers['www-authenticate']).toContain('invalid_token');
   expect(res.body.error).toBe('invalid_token');
  });

  it('accepts a token issued for the read-only server on the read-only server', async () => {
   const readOnlyBaseUrl = 'https://mcp-readonly.edge.phoneware.cloud';

   const { app, authProvider } = await importApp({
    MCP_BASE_URL: readOnlyBaseUrl,
    MCP_READ_ONLY: 'true',
   });

   const validBearer = 'bearer-from-readonly-server-54321';
   await (authProvider as any).tokenStore.set({
    accessToken: validBearer,
    refreshToken: 'refresh-ro',
    clientId: 'client-ro',
    expiresAt: Date.now() + 3600_000,
    nsAccessToken: 'ns-token-ro',
    nsUsername: 'alice',
    nsUserRole: 'user',
    serverBaseUrl: readOnlyBaseUrl,
   });

   // Present to read-only server -> must succeed (not 401)
   const res = await request(app)
    .post('/mcp')
    .set('Authorization', `Bearer ${validBearer}`)
    .set('Accept', 'application/json, text/event-stream')
    .send({
     jsonrpc: '2.0',
     id: 1,
     method: 'initialize',
     params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0' },
     },
    });

   expect(res.status).toBe(200);
  });
 });
});
