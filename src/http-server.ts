/**
 * HTTP transport for the NetSapiens MCP Server.
 *
 * Runs an Express app that exposes the MCP protocol over Streamable HTTP,
 * following the official SDK pattern from simpleStreamableHttp.ts.
 */

import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig, createMcpServer } from './index.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Starts the HTTP-based MCP server.
 */
export async function startHttpServer(): Promise<void> {
  const config = loadConfig();
  const port = parseInt(process.env.MCP_PORT || '3000', 10);
  const host = process.env.MCP_HOST || '0.0.0.0';

  const app = createMcpExpressApp({ host });

  // Active sessions keyed by session ID
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: Server }>();

  // Health check endpoint
  app.get('/health', (_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  });

  // Handle MCP POST requests (JSON-RPC)
  app.post('/mcp', async (req: IncomingMessage & { body?: unknown }, res: ServerResponse) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const body = (req as any).body;

    // If this is an initialization request, create a new session
    if (isInitializeRequest(body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      const { server } = createMcpServer(config);

      // Clean up session when transport closes
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          sessions.delete(sid);
        }
      };

      await server.connect(transport);

      // Store the session after connection so sessionId is available
      const sid = transport.sessionId;
      if (sid) {
        sessions.set(sid, { transport, server });
      }

      await transport.handleRequest(req, res, body);
      return;
    }

    // For non-initialization requests, route to existing session
    if (!sessionId || !sessions.has(sessionId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or missing session ID' }));
      return;
    }

    const session = sessions.get(sessionId)!;
    await session.transport.handleRequest(req, res, body);
  });

  // Handle MCP GET requests (SSE stream for server-initiated messages)
  app.get('/mcp', async (req: IncomingMessage, res: ServerResponse) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId || !sessions.has(sessionId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or missing session ID' }));
      return;
    }

    const session = sessions.get(sessionId)!;
    await session.transport.handleRequest(req, res);
  });

  // Handle MCP DELETE requests (session termination)
  app.delete('/mcp', async (req: IncomingMessage, res: ServerResponse) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId || !sessions.has(sessionId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or missing session ID' }));
      return;
    }

    const session = sessions.get(sessionId)!;
    await session.transport.close();
    sessions.delete(sessionId);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'session terminated' }));
  });

  app.listen(port, host, () => {
    console.error(`NetSapiens MCP HTTP server listening on ${host}:${port}`);
    if (config.debug) {
      console.error(`NetSapiens API URL: ${config.netsapiens.apiUrl}`);
    }
  });
}
