/**
 * HTTP transport for the NetSapiens MCP Server.
 *
 * Runs an Express app that serves:
 *   - OAuth 2.1 authorization endpoints (login page, token exchange)
 *   - MCP Streamable HTTP transport at /mcp (bearer-auth gated)
 *   - Health check at /health
 */

import { randomUUID, createHash } from 'node:crypto';
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

interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: Server;
  client: NetSapiensClient;
}

/**
 * Push the (possibly just-refreshed) NS access token from the verified bearer
 * into the session's long-lived NetSapiensClient. verifyAccessToken refreshes
 * the upstream NS token in the token store, but the client instance was built
 * at session-initialize time — without this sync it keeps using the original
 * token, which NS invalidates on rotation, and every API call 401s for the
 * rest of the session.
 */
function syncSessionNsToken(session: McpSession, req: AuthenticatedRequest): void {
  const extra = req.auth?.extra as Record<string, unknown> | undefined;
  const nsAccessToken = extra?.nsAccessToken as string | undefined;
  if (nsAccessToken) session.client.setApiToken(nsAccessToken);
}

/**
 * Unknown session ID → 404, per the MCP streamable-HTTP spec. 404 (not 400)
 * is the signal a client keys on to transparently start a new session with a
 * fresh InitializeRequest — important here because sessions live in instance
 * memory and are wiped on every deploy or Cloud Run instance restart.
 */
function respondSessionNotFound(res: ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32001, message: 'Session not found' },
    id: null,
  }));
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Build the Express app + auth provider without binding to a port.
 * Used by both `startHttpServer()` and the test harness.
 */
export function createApp(): { app: express.Express; authProvider: NetSapiensAuthProvider; baseUrl: URL; mcpUrl: URL } {
  const config = loadConfig();
  const port = parseInt(process.env.MCP_PORT || '3000', 10);
  const baseUrl = new URL(process.env.MCP_BASE_URL || `http://localhost:${port}`);
  const mcpUrl = new URL('/mcp', baseUrl);

  const nsClientId = process.env.NETSAPIENS_OAUTH_CLIENT_ID;
  const nsClientSecret = process.env.NETSAPIENS_OAUTH_CLIENT_SECRET;

  if (!nsClientId || !nsClientSecret) {
    throw new Error(
      'HTTP transport requires NETSAPIENS_OAUTH_CLIENT_ID and NETSAPIENS_OAUTH_CLIENT_SECRET ' +
      'to be set (these are the operator-level OAuth credentials for the upstream NS API).',
    );
  }

  // Issued bearer lifetime. MCP clients SHOULD refresh on 401 using the
  // refresh token we hand back at /token, but real-world client refresh
  // implementations vary, so a longer-lived bearer keeps far more sessions
  // alive without ever hitting the cliff. Default 7 days; operator-tunable
  // via MCP_TOKEN_LIFETIME_HOURS.
  const tokenLifetimeSec = parseLifetimeHoursToSeconds(process.env.MCP_TOKEN_LIFETIME_HOURS, 24 * 7);
  const authProvider = new NetSapiensAuthProvider({
    nsApiUrl: config.netsapiens.apiUrl,
    nsClientId,
    nsClientSecret,
    tokenLifetimeSec,
  });

  const { app } = wireApp(config, authProvider, baseUrl, mcpUrl);
  return { app, authProvider, baseUrl, mcpUrl };
}

/**
 * Starts the HTTP-based MCP server with OAuth 2.1 authentication.
 */
export async function startHttpServer(): Promise<void> {
  const { app, baseUrl, mcpUrl } = createApp();
  const config = loadConfig();
  const port = parseInt(process.env.MCP_PORT || '3000', 10);
  const host = process.env.MCP_HOST || '0.0.0.0';

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

/**
 * Parse an hours-valued env var to seconds, clamped to a sane range.
 * Falls back to `defaultHours` when unset or malformed. Min 1 hour, max 90 days.
 */
function parseLifetimeHoursToSeconds(raw: string | undefined, defaultHours: number): number {
  const parsed = raw ? Number.parseFloat(raw) : NaN;
  const hours = Number.isFinite(parsed) && parsed > 0 ? parsed : defaultHours;
  const clamped = Math.min(Math.max(hours, 1), 24 * 90);
  return Math.round(clamped * 3600);
}

function wireApp(
  config: ReturnType<typeof loadConfig>,
  authProvider: NetSapiensAuthProvider,
  baseUrl: URL,
  mcpUrl: URL,
): { app: express.Express; sessions: Map<string, McpSession> } {

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
  const sessions = new Map<string, McpSession>();

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      activeSessions: sessions.size,
      nsApiUrl: config.netsapiens.apiUrl,
      version: config.version,
    });
  });

  // Favicon — fetch MCP_ICON_URL once and cache in memory; serve bytes directly.
  // We proxy instead of redirecting because some clients (Claude included)
  // don't follow redirects for favicon fetches.
  let cachedIcon: { contentType: string; bytes: Buffer; etag: string } | null = null;
  let cachedIconUrl: string | undefined;
  const fetchIcon = async (url: string) => {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Icon fetch failed: ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    const ct = resp.headers.get('content-type') || 'image/png';
    const etag = `"${createHash('sha1').update(buf).digest('hex')}"`;
    return { contentType: ct, bytes: buf, etag };
  };
  app.get(['/favicon.ico', '/favicon.png'], async (req, res) => {
    const iconUrl = process.env.MCP_ICON_URL;
    if (!iconUrl) {
      res.status(404).end();
      return;
    }
    try {
      if (!cachedIcon || cachedIconUrl !== iconUrl) {
        cachedIcon = await fetchIcon(iconUrl);
        cachedIconUrl = iconUrl;
      }
      if (req.headers['if-none-match'] === cachedIcon.etag) {
        res.status(304).end();
        return;
      }
      res.setHeader('Content-Type', cachedIcon.contentType);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('ETag', cachedIcon.etag);
      res.send(cachedIcon.bytes);
    } catch (err) {
      logger.warn('Failed to fetch icon, serving 404', { iconUrl, error: String(err) });
      res.status(404).end();
    }
  });

  // OAuth endpoints — discovery, authorize, token, register, revoke
  app.use(mcpAuthRouter({
    provider: authProvider,
    issuerUrl: baseUrl,
    resourceServerUrl: mcpUrl,
  }));

  // Compatibility: also serve protected-resource metadata at the root path.
  // The SDK mounts it at /.well-known/oauth-protected-resource/mcp (RFC 9728),
  // but some clients still query the root /.well-known/oauth-protected-resource.
  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.json({
      resource: mcpUrl.href,
      authorization_servers: [baseUrl.href],
    });
  });

  // Login form submission — the authorize() method shows the page, this handles POST
  app.post('/login', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
      res.status(400).json({ error: 'Missing username or password' });
      return;
    }

    await authProvider.handleLogin(req, res, username, password);
  });

  // MFA passcode submission (second step when NS requires MFA)
  app.post('/mfa', async (req, res) => {
    const { passcode } = req.body;

    if (!passcode) {
      res.status(400).json({ error: 'Missing passcode' });
      return;
    }

    await authProvider.handleMfa(req, res, passcode);
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
      // Create a server + client using the authenticated user's NS token, role, and identity.
      const extra = req.auth?.extra as Record<string, unknown> | undefined;
      const nsAccessToken = extra?.nsAccessToken as string | undefined;
      const nsUserRole = extra?.nsUserRole as UserRole | undefined;
      const nsUsername = extra?.nsUsername as string | undefined;
      const { server, client } = createAuthenticatedMcpServer(config, nsAccessToken, nsUserRole, nsUsername);

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          sessions.set(sid, { transport, server, client });
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) sessions.delete(sid);
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    if (!sessionId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing session ID' }));
      return;
    }
    if (!sessions.has(sessionId)) {
      respondSessionNotFound(res);
      return;
    }

    const session = sessions.get(sessionId)!;
    syncSessionNsToken(session, req);
    await session.transport.handleRequest(req, res, body);
  });

  // GET /mcp — SSE stream for server-initiated messages
  app.get('/mcp', bearerAuth, async (req: AuthenticatedRequest, res: ServerResponse) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing session ID' }));
      return;
    }
    if (!sessions.has(sessionId)) {
      respondSessionNotFound(res);
      return;
    }

    const session = sessions.get(sessionId)!;
    syncSessionNsToken(session, req);
    await session.transport.handleRequest(req, res);
  });

  // DELETE /mcp — session termination
  app.delete('/mcp', bearerAuth, async (req: AuthenticatedRequest, res: ServerResponse) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing session ID' }));
      return;
    }
    if (!sessions.has(sessionId)) {
      respondSessionNotFound(res);
      return;
    }

    const session = sessions.get(sessionId)!;
    await session.transport.close();
    sessions.delete(sessionId);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'session terminated' }));
  });

  return { app, sessions };
}

// ---------------------------------------------------------------------------
// Helper: create a Server + Client bound to a specific user's NS token
// ---------------------------------------------------------------------------

function createAuthenticatedMcpServer(
  config: ReturnType<typeof loadConfig>,
  nsAccessToken?: string,
  userRole?: UserRole,
  userIdentity?: string,
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
  registerTools(server, client, userRole, userIdentity);

  server.onerror = (error) => {
    logger.error('[MCP Error]', { error: String(error) });
  };

  return { server, client };
}
