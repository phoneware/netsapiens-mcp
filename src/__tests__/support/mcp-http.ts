/**
 * A real HTTP MCP endpoint for the access suites: the SDK's streamable HTTP server transport behind node:http, with each
 * bearer token mapped to the auth info a signed-in session carries. Session mode keeps one transport per session.
 * Stateless mode builds a server and a transport per request, as production does. The SDK client connects over HTTP.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from '../../index.js';
import type { AccessEnforcer } from '../../access/types.js';
import { NetSapiensClient } from '../../netsapiens-client.js';
import { serverCapabilities } from '../../server-info.js';

export interface McpHttpOptions {
  readonly enforcer: AccessEnforcer;
  readonly apiUrl: string;
  /** Bearer token to the auth info (the reserved registry keys) that session carries. */
  readonly identities: ReadonlyMap<string, Record<string, unknown>>;
  readonly userIdentity: string;
  /** Whether the server runs stateless. Must match MCP_STATELESS, which the server reads when it builds capabilities. */
  readonly stateless: boolean;
}

export interface McpHttp {
  readonly url: string;
  close(): Promise<void>;
}

function bearerOf(header: string | undefined): string | undefined {
  return header?.match(/^Bearer\s+(.+)$/i)?.[1];
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? undefined : JSON.parse(text);
}

/**
 * Test-only bounded wait. Used where the awaited event is an absence (no notification is sent) and so has no promise
 * to await, or to let an SSE stream deliver a notification the test then observes through a handler.
 */
export function settle(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export async function startMcpHttp(options: McpHttpOptions): Promise<McpHttp> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const buildServer = (): Server => {
    const server = new Server({ name: 'netsapiens-mcp-test', version: '1.0.0' }, { capabilities: serverCapabilities() });
    const client = new NetSapiensClient({ apiUrl: options.apiUrl, apiToken: 'test-token' });
    registerTools(server, client, 'domain_admin', options.userIdentity, undefined, options.enforcer);
    return server;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readJson(req);
    const token = bearerOf(req.headers.authorization);
    const extra = token === undefined ? undefined : options.identities.get(token);
    if (token === undefined || extra === undefined) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"error":"unauthorized"}');
      return;
    }
    Object.assign(req, { auth: { token, clientId: 'test-client', scopes: [], extra } });

    if (options.stateless) {
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId === 'string') {
      const transport = sessions.get(sessionId);
      if (transport === undefined) {
        res.writeHead(404).end();
        return;
      }
      await transport.handleRequest(req, res, body);
      return;
    }
    if (req.method === 'POST' && isInitializeRequest(body)) {
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id: string) => {
          sessions.set(id, transport);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId !== undefined) sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    res.writeHead(400).end();
  };

  const httpServer = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  const listening = Promise.withResolvers<void>();
  httpServer.listen(0, '127.0.0.1', () => listening.resolve());
  await listening.promise;
  const address = httpServer.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    async close(): Promise<void> {
      for (const transport of sessions.values()) await transport.close();
      sessions.clear();
      httpServer.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      httpServer.close(() => closed.resolve());
      await closed.promise;
    },
  };
}

export interface ConnectedClient {
  readonly client: Client;
  close(): Promise<void>;
}

/** Connects an SDK client over HTTP as the bearer token's session. */
export async function connectClient(url: string, token: string): Promise<ConnectedClient> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'netsapiens-mcp-test-client', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

/**
 * Waits for a condition that an SSE notification sets. The notification arrives on a stream with no awaitable handle,
 * so the test polls the handler's counter within a bound.
 */
export async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the condition');
    await settle(20);
  }
}
