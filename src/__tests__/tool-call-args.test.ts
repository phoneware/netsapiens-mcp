import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { handleToolCall } from '../tools/index.js';
import { CURATED_CATALOG } from '../tools/curated/catalog.js';
import { toolRegistry } from '../generated/registry.js';
import { logger } from '../utils/logger.js';
import { NetSapiensClient } from '../netsapiens-client.js';
import { NetSapiensAuthProvider } from '../auth/netsapiens-auth-provider.js';

interface TextBlock {
  type: 'text';
  text: string;
}

interface ToolCallResponse {
  content: TextBlock[];
}

interface CdrResultPayload {
  scope?: string;
  scope_note?: string;
  success?: boolean;
  data?: unknown[];
}

describe('Tool call arguments and scope resolution', () => {
  it('recent_calls with { extension: "290" } is rejected naming extension and pointing at user', async () => {
    const fakeClient = { request: vi.fn(async () => ({ success: true, data: [] })) };

    await expect(
      handleToolCall(fakeClient as never, 'recent_calls', { extension: '290' }, 'domain_admin'),
    ).rejects.toThrow(/extension.*user/i);
  });

  it('call_api dispatching recent_calls with { extension: "290" } rejects with extension hint', async () => {
    const fakeClient = { request: vi.fn(async () => ({ success: true, data: [] })) };

    await expect(
      handleToolCall(
        fakeClient as never,
        'call_api',
        { tool_name: 'recent_calls', args: { extension: '290' } },
        'domain_admin',
      ),
    ).rejects.toThrow(/extension.*user/i);
  });

  it('non-CDR tool with unknown args is rejected naming unknown arg without extension hint', async () => {
    const fakeClient = { request: vi.fn(async () => ({ success: true, data: [] })) };

    let thrownError: McpError | undefined;
    try {
      await handleToolCall(fakeClient as never, 'find_domain', { invalid_param: 'foo' }, 'domain_admin');
    } catch (err) {
      if (err instanceof McpError) thrownError = err;
    }

    expect(thrownError).toBeDefined();
    expect(thrownError?.message).toContain('invalid_param');
    expect(thrownError?.message).toContain('query, limit');
    expect(thrownError?.message).not.toContain('use `user`');
  });

  it('call_api with unknown outer args is rejected', async () => {
    const fakeClient = { request: vi.fn(async () => ({ success: true, data: [] })) };

    await expect(
      handleToolCall(
        fakeClient as never,
        'call_api',
        { tool_name: 'find_user', unexpected_arg: 123 },
        'user',
      ),
    ).rejects.toThrow(/unexpected_arg/);
  });
  it('recent_calls with { user: "290" } hits /domains/{domain}/users/{user}/cdrs with user "290"', async () => {
    const calls: Array<{ pathTemplate: string; pathParams?: Record<string, string> }> = [];
    const fakeClient = {
      request: vi.fn(async (opts: { pathTemplate: string; pathParams?: Record<string, string> }) => {
        calls.push(opts);
        return { success: true, data: [] };
      }),
    };

    await handleToolCall(fakeClient as never, 'recent_calls', { user: '290' }, 'domain_admin');
    expect(calls.length).toBe(1);
    expect(calls[0].pathTemplate).toBe('/domains/{domain}/users/{user}/cdrs');
    expect(calls[0].pathParams?.user).toBe('290');
  });

  it('scope_note is present and correct for each breadth (domain, mine, user)', async () => {
    const fakeClient = { request: vi.fn(async () => ({ success: true, data: [] })) };

    // domain breadth (office manager default or explicit scope="domain")
    const domainRes = (await handleToolCall(
      fakeClient as never,
      'recent_calls',
      { scope: 'domain' },
      'domain_admin',
    )) as ToolCallResponse;
    const domainData: CdrResultPayload = JSON.parse(domainRes.content[0].text);
    expect(domainData.scope).toBe('domain');
    expect(domainData.scope_note).toBe(
      'every call in the domain, not just yours; pass scope="mine" or user="<extension>" to narrow',
    );

    // mine breadth (as domain_admin explicitly narrowing)
    const mineAdminRes = (await handleToolCall(
      fakeClient as never,
      'recent_calls',
      { scope: 'mine' },
      'domain_admin',
    )) as ToolCallResponse;
    const mineAdminData: CdrResultPayload = JSON.parse(mineAdminRes.content[0].text);
    expect(mineAdminData.scope).toBe('mine');
    expect(mineAdminData.scope_note).toBe(
      'only the signed-in user\'s calls; pass scope="domain" for the whole office',
    );

    // mine breadth (as basic user)
    const mineUserRes = (await handleToolCall(
      fakeClient as never,
      'recent_calls',
      {},
      'user',
    )) as ToolCallResponse;
    const mineUserData: CdrResultPayload = JSON.parse(mineUserRes.content[0].text);
    expect(mineUserData.scope).toBe('mine');
    expect(mineUserData.scope_note).toBe('only the signed-in user\'s calls');

    // user breadth (specific extension)
    const userRes = (await handleToolCall(
      fakeClient as never,
      'recent_calls',
      { user: '290' },
      'domain_admin',
    )) as ToolCallResponse;
    const userData: CdrResultPayload = JSON.parse(userRes.content[0].text);
    expect(userData.scope).toBe('user');
    expect(userData.scope_note).toBe('only extension 290');

    // call_volume breadth
    const volRes = (await handleToolCall(
      fakeClient as never,
      'call_volume',
      { scope: 'domain' },
      'domain_admin',
    )) as ToolCallResponse;
    const volData: CdrResultPayload = JSON.parse(volRes.content[0].text);
    expect(volData.scope).toBe('domain');
    expect(volData.scope_note).toBe(
      'every call in the domain, not just yours; pass scope="mine" or user="<extension>" to narrow',
    );
  });

  it('a valid call to every curated and workflow tool with only declared args is not rejected', async () => {
    const fakeClient = {
      request: vi.fn(async () => ({ success: true, data: [] })),
    };

    for (const tool of CURATED_CATALOG) {
      const schema = tool.schema.inputSchema as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      const validArgs: Record<string, unknown> = {};
      if (schema.properties) {
        for (const [propName, propDef] of Object.entries(schema.properties)) {
          const p = propDef as { type?: string; default?: unknown };
          if (schema.required?.includes(propName)) {
            if (p.type === 'number') validArgs[propName] = 1;
            else if (p.type === 'boolean') validArgs[propName] = true;
            else validArgs[propName] = 'test';
          }
        }
      }
      try {
        await handleToolCall(fakeClient as never, tool.schema.name, validArgs, 'super_user');
      } catch (err: unknown) {
        if (err instanceof McpError && err.message.includes('Unknown argument')) {
          throw new Error(`Tool ${tool.schema.name} rejected declared args: ${err.message}`);
        }
      }
    }
  });

  it('confirms each handler accepted names are declared in its schema across the generated registry', () => {
    const undeclaredParams: Array<{ tool: string; params: string[] }> = [];

    for (const [name, def] of toolRegistry) {
      const fnStr = def.handler.toString();
      const props = Object.keys(def.schema.inputSchema?.properties || {});
      const matchPath = fnStr.match(/pathParamNames = \[([^\]]*)\]/);
      const matchQuery = fnStr.match(/queryParamNames = \[([^\]]*)\]/);
      const matchBody = fnStr.match(/bodyParamNames = \[([^\]]*)\]/);
      const readParams: string[] = [];
      for (const m of [matchPath, matchQuery, matchBody]) {
        if (m && m[1]) {
          const names = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
          readParams.push(...names);
        }
      }
      const missing = readParams.filter((p) => !props.includes(p));
      if (missing.length > 0) {
        undeclaredParams.push({ tool: name, params: missing });
      }
    }

    expect(undeclaredParams).toEqual([]);
  });

  it('handleToolCall emits exactly one "Tool call" log with required fields and no argument values', async () => {
    const infoSpy = vi.spyOn(logger, 'info');
    const SENTINEL_VALUE = 'secret-sentinel-xyz-987';
    const fakeClient = { request: vi.fn(async () => ({ success: true, data: [] })) };

    try {
      await handleToolCall(
        fakeClient as never,
        'recent_calls',
        { user: SENTINEL_VALUE, limit: 10 },
        'domain_admin',
        'kevin.johnson',
      );

      const toolCallLogs = infoSpy.mock.calls.filter((call) => call[0] === 'Tool call');
      expect(toolCallLogs.length).toBe(1);

      const [message, context] = toolCallLogs[0];
      expect(message).toBe('Tool call');
      expect(context).toBeDefined();
      expect(context?.tool).toBe('recent_calls');
      expect(context?.role).toBe('domain_admin');
      expect(context?.username).toBe('kevin.johnson');
      expect(context?.argNames).toEqual(['user', 'limit']);
      expect(context?.ok).toBe(true);
      expect(typeof context?.durationMs).toBe('number');
      expect(context?.scope).toBe('user');

      // Assert sentinel value NEVER appears anywhere in the logged object
      const serializedContext = JSON.stringify(context);
      expect(serializedContext).not.toContain(SENTINEL_VALUE);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('NetSapiensClient logs upstream requests: info on success, warn with the NS message on error', async () => {
    const infoSpy = vi.spyOn(logger, 'info');
    const client = new NetSapiensClient({ apiUrl: 'https://example.com' });
    const handlers = (client as unknown as {
      client: {
        interceptors: {
          response: {
            handlers: Array<{
              fulfilled: (res: unknown) => unknown;
              rejected: (err: unknown) => Promise<unknown>;
            }>;
          };
        };
      };
    }).client.interceptors.response.handlers;

    expect(handlers.length).toBeGreaterThan(0);
    const { fulfilled, rejected } = handlers[0];

    // Test success response
    fulfilled({
      status: 200,
      config: {
        method: 'get',
        url: '/domains/~/users',
        metadata: { startTime: Date.now() - 20, pathTemplate: '/domains/{domain}/users' },
      },
    });

    const successLogs = infoSpy.mock.calls.filter((c) => c[0] === 'NetSapiens API request');
    expect(successLogs.length).toBe(1);
    expect(successLogs[0][1]).toEqual({
      method: 'GET',
      pathTemplate: '/domains/{domain}/users',
      status: 200,
      durationMs: expect.any(Number),
    });

    // Test error response: warn level, carrying the NS message that names the failure
    const warnSpy = vi.spyOn(logger, 'warn');
    await expect(
      rejected({
        response: { status: 401, data: { code: 401, message: 'Invalid Scope [APP001]' } },
        config: {
          method: 'get',
          url: '/domains',
          metadata: { startTime: Date.now() - 30, pathTemplate: '/domains' },
        },
      }),
    ).rejects.toBeDefined();

    const errorLogs = warnSpy.mock.calls.filter((c) => c[0] === 'NetSapiens API request');
    expect(errorLogs.length).toBe(1);
    expect(errorLogs[0][1]).toEqual({
      method: 'GET',
      pathTemplate: '/domains',
      url: '/domains',
      status: 401,
      error: 'Invalid Scope [APP001]',
      durationMs: expect.any(Number),
    });
  });

  it('adds username to Detected NS user role log line', async () => {
    const infoSpy = vi.spyOn(logger, 'info');

    vi.spyOn(axios, 'get').mockResolvedValue({
      data: { 'user-scope': 'Domain Admin', user: 'kevin' },
    });

    const provider = new NetSapiensAuthProvider({
      nsApiUrl: 'https://example.com',
      nsClientId: 'test',
      nsClientSecret: 'test',
    });

    try {
      const detectFn = (provider as unknown as {
        detectNsUserRole: (token: string, username?: string) => Promise<string | undefined>;
      }).detectNsUserRole;
      const role = await detectFn.call(provider, 'test-token', 'kevin');
      expect(role).toBe('domain_admin');

      const roleLogs = infoSpy.mock.calls.filter((c) => c[0] === 'Detected NS user role');
      expect(roleLogs.length).toBe(1);
      expect(roleLogs[0][1]?.username).toBe('kevin');
      expect(roleLogs[0][1]?.role).toBe('domain_admin');
    } finally {
      infoSpy.mockRestore();
      vi.restoreAllMocks();
    }
  });
});
