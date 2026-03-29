/**
 * HTTP transport for the NetSapiens MCP Server.
 *
 * Runs an Express app that serves:
 *   - OAuth 2.1 authorization endpoints (login page, token exchange)
 *   - MCP Streamable HTTP transport at /mcp (bearer-auth gated)
 *   - Health check at /health
 */

import { randomUUID } from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { loadConfig, registerTools } from './index.js';
import { NetSapiensClient } from './netsapiens-client.js';
import { NetSapiensAuthProvider } from './auth/netsapiens-auth-provider.js';
import { logger } from './utils/logger.js';
import type { UserRole } from './auth/roles.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

// ---------------------------------------------------------------------------
// Authenticated request type
// ---------------------------------------------------------------------------

interface AuthenticatedRequest extends IncomingMessage {
  auth?: AuthInfo;
  body?: unknown;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Starts the HTTP-based MCP server with OAuth 2.1 authentication.
 */
export async function startHttpServer(): Promise<void> {
  const config = loadConfig();
  const port = parseInt(process.env.MCP_PORT || '3000', 10);
  const host = process.env.MCP_HOST || '0.0.0.0';

  // The publicly reachable base URL. Needed for OAuth metadata discovery.
  const baseUrl = new URL(process.env.MCP_BASE_URL || `http://localhost:${port}`);
  const mcpUrl = new URL('/mcp', baseUrl);

  // -----------------------------------------------------------------------
  // Auth provider — wraps NS password grant in an authorization code flow
  // -----------------------------------------------------------------------

  const nsClientId = process.env.NETSAPIENS_OAUTH_CLIENT_ID;
  const nsClientSecret = process.env.NETSAPIENS_OAUTH_CLIENT_SECRET;

  if (!nsClientId || !nsClientSecret) {
    throw new Error(
      'HTTP transport requires NETSAPIENS_OAUTH_CLIENT_ID and NETSAPIENS_OAUTH_CLIENT_SECRET ' +
      'to be set (these are the operator-level OAuth credentials for the upstream NS API).'
    );
  }

  const authProvider = new NetSapiensAuthProvider({
    nsApiUrl: config.netsapiens.apiUrl,
    nsClientId,
    nsClientSecret,
  });

  // -----------------------------------------------------------------------
  // Express app
  // -----------------------------------------------------------------------

  const app = express();

  // Trust proxy for rate limiting behind reverse proxies
  app.set('trust proxy', 1);

  // CORS middleware
  const corsOrigin = process.env.MCP_CORS_ORIGIN || '*';
  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', corsOrigin);
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id, Accept');
    res.header('Access-Control-Expose-Headers', 'mcp-session-id');
    if (_req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Body parsing for the login form (URL-encoded) and JSON (MCP / token)
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  // -----------------------------------------------------------------------
  // Rate limiters
  // -----------------------------------------------------------------------

  const rateLimitMessage = { error: 'Too many requests, please try again later' };

  const loginLimiter = rateLimit({
    windowMs: 60_000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: rateLimitMessage,
  });

  const tokenLimiter = rateLimit({
    windowMs: 60_000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: rateLimitMessage,
  });

  const mcpLimiter = rateLimit({
    windowMs: 60_000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: rateLimitMessage,
  });

  // Apply rate limiters to specific paths (before route handlers)
  app.use('/login', loginLimiter);
  app.use('/token', tokenLimiter);
  app.use('/register', tokenLimiter);
  app.use('/mcp', mcpLimiter);

  // -----------------------------------------------------------------------
  // Health check — unauthenticated
  // -----------------------------------------------------------------------

  // Active sessions keyed by session ID (declared early for use in health check)
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: Server }>();

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      activeSessions: sessions.size,
      nsApiUrl: config.netsapiens.apiUrl,
      version: config.version,
    });
  });

  // OAuth endpoints — discovery, authorize, token, register, revoke
  app.use(mcpAuthRouter({
    provider: authProvider,
    issuerUrl: baseUrl,
    resourceServerUrl: mcpUrl,
  }));

  // Login form submission — the authorize() method shows the page, this handles POST
  app.post('/login', async (req, res) => {
    const authId = req.query.auth_id as string;
    const { username, password } = req.body;

    if (!authId || !username || !password) {
      res.status(400).json({ error: 'Missing auth_id, username, or password' });
      return;
    }

    await authProvider.handleLogin(authId, username, password, res);
  });

  // -----------------------------------------------------------------------
  // MCP transport — all routes require bearer auth
  // -----------------------------------------------------------------------

  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(mcpUrl);
  const bearerAuth = requireBearerAuth({
    verifier: authProvider,
    resourceMetadataUrl,
  });

  // POST /mcp — JSON-RPC requests
  app.post('/mcp', bearerAuth, async (req: AuthenticatedRequest, res: ServerResponse) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const body = (req as any).body;

    if (isInitializeRequest(body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      // Create a server + client using the authenticated user's NS token and role
      const extra = req.auth?.extra as Record<string, unknown> | undefined;
      const nsAccessToken = extra?.nsAccessToken as string | undefined;
      const nsUserRole = extra?.nsUserRole as UserRole | undefined;
      const { server } = createAuthenticatedMcpServer(config, nsAccessToken, nsUserRole);

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) sessions.delete(sid);
      };

      await server.connect(transport);

      const sid = transport.sessionId;
      if (sid) {
        sessions.set(sid, { transport, server });
      }

      await transport.handleRequest(req, res, body);
      return;
    }

    if (!sessionId || !sessions.has(sessionId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or missing session ID' }));
      return;
    }

    const session = sessions.get(sessionId)!;
    await session.transport.handleRequest(req, res, body);
  });

  // GET /mcp — SSE stream for server-initiated messages
  app.get('/mcp', bearerAuth, async (req: AuthenticatedRequest, res: ServerResponse) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId || !sessions.has(sessionId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or missing session ID' }));
      return;
    }

    const session = sessions.get(sessionId)!;
    await session.transport.handleRequest(req, res);
  });

  // DELETE /mcp — session termination
  app.delete('/mcp', bearerAuth, async (req: AuthenticatedRequest, res: ServerResponse) => {
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

  // -----------------------------------------------------------------------
  // Start listening
  // -----------------------------------------------------------------------

  app.listen(port, host, () => {
    logger.info('NetSapiens MCP HTTP server started', {
      host,
      port,
      authorize: `${baseUrl.origin}/authorize`,
      mcp: mcpUrl.href,
    });
    if (config.debug) {
      logger.debug('Debug mode enabled', { nsApiUrl: config.netsapiens.apiUrl });
    }
  });
}

// ---------------------------------------------------------------------------
// Helper: create a Server + Client bound to a specific user's NS token
// ---------------------------------------------------------------------------

function createAuthenticatedMcpServer(
  config: ReturnType<typeof loadConfig>,
  nsAccessToken?: string,
  userRole?: UserRole,
) {
  const server = new Server(
    { name: config.name, version: config.version },
    { capabilities: { tools: {} } },
  );

  // Build a client config. If we have a per-user NS access token from the
  // OAuth flow, use that. Otherwise fall back to the operator-level config.
  const clientConfig = nsAccessToken
    ? { apiUrl: config.netsapiens.apiUrl, apiToken: nsAccessToken, timeout: config.netsapiens.timeout }
    : config.netsapiens;

  const client = new NetSapiensClient(clientConfig);
  registerTools(server, client);

  server.onerror = (error) => {
    logger.error('[MCP Error]', { error: String(error) });
  };

  return { server, client };
}
