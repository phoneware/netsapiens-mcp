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
import { parsePlatforms } from './auth/platforms.js';
import { allowLoopbackRedirectUri } from './auth/loopback-redirect.js';
import { negotiateProtocolVersion } from './http/protocol-version.js';
import {
 SERVER_INSTRUCTIONS,
 isStatelessMode,
 serverCapabilities,
 serverImplementation,
} from './server-info.js';
import { createStoreFromEnv } from './config/store.js';
import { setUsageStore } from './tools/promotion/usage-store.js';
import type { McpStore } from './store/types.js';
import { logger } from './utils/logger.js';
import type { UserRole } from './auth/roles.js';
import type { NetSapiensConfig, MCPServerConfig } from './types/config.js';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { getVersionInfo, getCachedVersionInfo, warmVersionCache, getVersionTtlSeconds, type VersionInfo } from './netsapiens/version.js';
import { createAvailabilityContext, type AvailabilityContext } from './netsapiens/availability.js';
import { createGuardedClient } from './netsapiens/guarded-client.js';
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
 availabilityContext?: AvailabilityContext;
 nsApiUrl?: string;
 lastVersionInfo?: VersionInfo;
}

/**
 * Push the (possibly just-refreshed) NS access token from the verified bearer
 * into the session's long-lived NetSapiensClient. verifyAccessToken refreshes
 * the upstream NS token in the token store, but the client instance was built
 * at session-initialize time: without this sync it keeps using the original
 * token, which NS invalidates on rotation, and every API call 401s for the
 * rest of the session.
 */
function syncSessionNsToken(session: McpSession, req: AuthenticatedRequest): void {
 const extra = req.auth?.extra as Record<string, unknown> | undefined;
 const nsAccessToken = extra?.nsAccessToken as string | undefined;
 const nsApiUrl = extra?.nsApiUrl as string | undefined;
 if (nsAccessToken) session.client.setApiToken(nsAccessToken);
 if (nsApiUrl) session.client.setApiUrl(nsApiUrl);
}

/**
 * Unknown session ID → 404, per the MCP streamable-HTTP spec. 404 (not 400)
 * is the signal a client keys on to transparently start a new session with a
 * fresh InitializeRequest: important here because sessions live in instance
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

/**
 * Streamable HTTP says a server that offers no SSE stream (or no client-driven
 * session termination) at the MCP endpoint answers 405 with an Allow header.
 * That is exactly the stateless case: there is no session to stream on or to
 * delete, and a compliant client treats 405 as "don't retry".
 */
function respondMethodNotAllowed(res: ServerResponse, message: string): void {
 res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
 res.end(JSON.stringify({
  jsonrpc: '2.0',
  error: { code: -32000, message },
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
export async function createApp(options?: { store?: McpStore }): Promise<{
 app: express.Express;
 authProvider: NetSapiensAuthProvider;
 baseUrl: URL;
 mcpUrl: URL;
 store: McpStore;
 platforms: readonly NetSapiensPlatform[];
}> {
 const config = loadConfig();
 const platforms = parsePlatforms(process.env.NETSAPIENS_PLATFORMS, config.netsapiens.apiUrl);
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

 let store: McpStore;
 if (options?.store) {
  store = options.store;
 } else {
  const storeResult = await createStoreFromEnv();
  store = storeResult.store;
 }
 setUsageStore(store.usage);

 const tokenLifetimeSec = parseLifetimeHoursToSeconds(process.env.MCP_TOKEN_LIFETIME_HOURS, 24 * 7);
 const authProvider = new NetSapiensAuthProvider({
  nsApiUrl: config.netsapiens.apiUrl,
  platforms,
  nsClientId,
  nsClientSecret,
  tokenLifetimeSec,
  serverBaseUrl: baseUrl.origin,
  store,
 });

 const { app } = wireApp(config, authProvider, baseUrl, mcpUrl, store, platforms);
 return { app, authProvider, baseUrl, mcpUrl, store, platforms };
}

/**
 * Starts the HTTP-based MCP server with OAuth 2.1 authentication.
 *
 * Returns the listening `http.Server` so callers can shut it down (tests
 * especially, which otherwise leak a listener per case and collide on ports.
 */
export async function startHttpServer(): Promise<HttpServer> {
 const { app, baseUrl, mcpUrl, store, platforms } = await createApp();
 const config = loadConfig();
 const port = parseInt(process.env.MCP_PORT || '3000', 10);
 const host = process.env.MCP_HOST || '0.0.0.0';

 const onShutdown = async () => {
  try {
   await store.close();
  } catch (err) {
   logger.error('Error closing store on shutdown', { error: String(err) });
  }
  process.exit(0);
 };
 process.once('SIGINT', onShutdown);
 process.once('SIGTERM', onShutdown);

 const httpServer = app.listen(port, host, () => {
  logger.info('NetSapiens MCP HTTP server started', {
   host,
   port,
   mode: isStatelessMode() ? 'stateless' : 'session',
   authorize: `${baseUrl.origin}/authorize`,
   mcp: mcpUrl.href,
  });
  if (isStatelessMode() && process.env.MCP_CONFIRM_DESTRUCTIVE === 'true') {
   logger.warn(
    'MCP_CONFIRM_DESTRUCTIVE is on but MCP_STATELESS was forced true. ' +
    'Elicitation prompts need a session to reach the client, so destructive ' +
    'calls will fall back to MCP_CONFIRM_FALLBACK (default: refuse). ' +
    'Set MCP_STATELESS=false to keep the confirmation gate.',
   );
  }
  if (config.debug) {
   logger.debug('Debug mode enabled', { nsApiUrl: config.netsapiens.apiUrl });
  }
  const origins = [...new Set(platforms.map((p) => new URL(p.apiUrl).origin))];
  void warmVersionCache(origins).catch((err) => {
   logger.warn('Failed to warm version cache on startup', { error: String(err) });
  });
 });

 httpServer.on('close', () => {
  process.removeListener('SIGINT', onShutdown);
  process.removeListener('SIGTERM', onShutdown);
 });

 return httpServer;
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
 config: MCPServerConfig,
 authProvider: NetSapiensAuthProvider,
 baseUrl: URL,
 mcpUrl: URL,
 store: McpStore,
 platforms: readonly NetSapiensPlatform[],
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
  // `mcp-protocol-version` is required on every non-initialize request since
  // the 2025-06-18 revision, and `last-event-id` is what a browser client
  // sends to resume a broken SSE stream. Omitting either from the preflight
  // allowlist breaks browser-hosted clients outright.
  res.header(
   'Access-Control-Allow-Headers',
   'Content-Type, Authorization, mcp-session-id, mcp-protocol-version, last-event-id, Accept',
  );
  res.header('Access-Control-Expose-Headers', 'mcp-session-id, mcp-protocol-version');
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
 app.use('/mcp', (req, _res, next) => {
  const accept = req.headers['accept'];
  if (!accept) {
   req.headers['accept'] = 'application/json, text/event-stream';
  } else if (!accept.includes('text/event-stream')) {
   req.headers['accept'] = `${accept}, text/event-stream`;
  }
  next();
 });
 app.use('/mcp', mcpLimiter);

 // -----------------------------------------------------------------------
 // Health check: unauthenticated
 // -----------------------------------------------------------------------

 // Active sessions keyed by session ID (declared early for use in health check)
 const sessions = new Map<string, McpSession>();

 app.get('/health', (_req, res) => {
  try {
   const netsapiensList = platforms.map((p) => {
   const origin = new URL(p.apiUrl).origin;
   const cached = getCachedVersionInfo(origin);
   return {
    platform: p.id,
    label: p.label,
    apiUrl: p.apiUrl,
    apiVersion: cached?.apiVersion ?? null,
    version: cached?.apiVersion ?? null,
    docsBranch: cached?.docsBranch ?? null,
    branch: cached?.docsBranch ?? null,
    match: cached?.match ?? null,
    status: cached?.status ?? 'unknown',
    checkedAt: cached?.checkedAt ?? null,
    v1: cached?.v1 ?? 'unavailable',
    observation: cached?.observation ?? null,
   };
  });
  const indexMap: Record<string, (typeof netsapiensList)[number]> = {};
  for (const item of netsapiensList) {
   indexMap[item.apiUrl] = item;
   try {
    indexMap[new URL(item.apiUrl).origin] = item;
   } catch {
    // ignore unparseable URL
   }
  }
  const indexedNetsapiens = Object.assign(netsapiensList, indexMap);

  res.json({
   status: 'ok',
   uptime: Math.floor(process.uptime()),
   mode: isStatelessMode() ? 'stateless' : 'session',
   activeSessions: sessions.size,
   version: config.version,
   store: {
    backend: store.backend,
    namespace: store.namespace,
    persistent: store.capabilities.persistent,
    multiInstance: store.capabilities.multiInstance,
   },
   netsapiens: indexedNetsapiens,
   });
  } catch (err) {
   console.error('ERROR IN /health:', err);
   res.status(500).json({ error: String(err) });
  }
 });

 // Favicon: fetch MCP_ICON_URL once and cache in memory; serve bytes directly.
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

 // Publishes the requested loopback redirect_uri for the clients store, which
 // the SDK calls with no request context. Must precede mcpAuthRouter, and is
 // scoped to /authorize so every other endpoint keeps exact redirect matching.
 app.use('/authorize', allowLoopbackRedirectUri());

 // OAuth endpoints: discovery, authorize, token, register, revoke
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

 // Login form submission: the authorize() method shows the page, this handles POST
 app.post('/login', async (req, res) => {
  const { token, platform, username, password } = req.body;

  if (token) {
   if (!platform) {
    res.status(400).json({ error: 'Missing platform' });
    return;
   }
   await authProvider.handleTokenLogin(req, res, String(platform), String(token));
   return;
  }

  if (!username || !password) {
   res.status(400).json({ error: 'Missing username or password' });
   return;
  }

  await authProvider.handleLogin(req, res, String(username), String(password));
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
 // MCP transport: all routes require bearer auth
 // -----------------------------------------------------------------------

 const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(mcpUrl);
 const bearerAuth = requireBearerAuth({
  verifier: authProvider,
  resourceMetadataUrl,
 });
 // Protocol negotiation shim for clients speaking newer versions than our SDK
 app.use('/mcp', (req, _res, next) => {
  const negotiated = negotiateProtocolVersion(req);
  if (negotiated) {
   logger.warn('Negotiated a protocol version down', negotiated);
  }
  next();
 });


 // POST /mcp: JSON-RPC requests
 app.post('/mcp', bearerAuth, async (req: AuthenticatedRequest, res: ServerResponse) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  const body = (req as any).body;

  // Stateless: build a throwaway server + transport for this one request and
  // tear it down when the response closes. Every request carries its own
  // bearer, so the NS client is rebuilt from that bearer each time and no
  // cross-request state exists to go stale or to be pinned to an instance.
  if (isStatelessMode()) {
   const { server, client } = await createAuthenticatedMcpServerForRequest(config, req, authProvider);
   void client;
   const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

   res.on('close', () => {
    void Promise.resolve(transport.close()).catch(() => { });
    void Promise.resolve(server.close()).catch(() => { });
   });

   await server.connect(transport);
   await transport.handleRequest(req, res, body);
   return;
  }

  if (isInitializeRequest(body)) {
   // Create a server + client using the authenticated user's NS token, role, and identity.
   const { server, client, availabilityContext, versionInfo } = await createAuthenticatedMcpServerForRequest(config, req, authProvider);
   const extra = req.auth?.extra as Record<string, unknown> | undefined;
   const nsApiUrl = (extra?.nsApiUrl as string | undefined) || config.netsapiens.apiUrl;

   const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid: string) => {
     sessions.set(sid, { transport, server, client, availabilityContext, nsApiUrl, lastVersionInfo: versionInfo });
     ensureSessionWatcher();
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
  if (session.nsApiUrl && session.lastVersionInfo) {
   try {
    const origin = new URL(session.nsApiUrl).origin;
    const current = await getVersionInfo(origin);
    if (
     current.apiVersion !== session.lastVersionInfo.apiVersion ||
     current.docsBranch !== session.lastVersionInfo.docsBranch ||
     !setsEqual(current.v1Keys, session.lastVersionInfo.v1Keys)
    ) {
     session.lastVersionInfo = current;
     if (session.availabilityContext) {
      session.availabilityContext.versionInfo = current;
     }
     await session.server.sendToolListChanged();
    }
   } catch {
   }
  }
  await session.transport.handleRequest(req, res, body);
 });

 // GET /mcp: SSE stream for server-initiated messages
 app.get('/mcp', bearerAuth, async (req: AuthenticatedRequest, res: ServerResponse) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  if (isStatelessMode()) {
   respondMethodNotAllowed(res, 'This server runs stateless; no server-initiated SSE stream is offered');
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
  await session.transport.handleRequest(req, res);
 });

 // DELETE /mcp: session termination
 app.delete('/mcp', bearerAuth, async (req: AuthenticatedRequest, res: ServerResponse) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  if (isStatelessMode()) {
   respondMethodNotAllowed(res, 'This server runs stateless; there is no session to terminate');
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

function setsEqual(a: Set<string>, b: Set<string>): boolean {
 if (a.size !== b.size) return false;
 for (const v of a) if (!b.has(v)) return false;
 return true;
}

let sessionWatcherTimer: NodeJS.Timeout | null = null;
function ensureSessionWatcher() {
 if (sessionWatcherTimer) return;
 sessionWatcherTimer = setInterval(async () => {
  if (sessions.size === 0) {
   if (sessionWatcherTimer) {
    clearInterval(sessionWatcherTimer);
    sessionWatcherTimer = null;
   }
   return;
  }
  for (const session of sessions.values()) {
   if (!session.nsApiUrl || !session.lastVersionInfo) continue;
   try {
    const origin = new URL(session.nsApiUrl).origin;
    const current = await getVersionInfo(origin);
    if (
     current.apiVersion !== session.lastVersionInfo.apiVersion ||
     current.docsBranch !== session.lastVersionInfo.docsBranch ||
     !setsEqual(current.v1Keys, session.lastVersionInfo.v1Keys)
    ) {
     session.lastVersionInfo = current;
     if (session.availabilityContext) {
      session.availabilityContext.versionInfo = current;
     }
     await session.server.sendToolListChanged();
    }
   } catch {
    // ignore background polling errors
   }
  }
 }, Math.min(1000, getVersionTtlSeconds() * 1000));
 sessionWatcherTimer.unref();
}

async function createAuthenticatedMcpServer(
 config: ReturnType<typeof loadConfig>,
 nsAccessToken?: string,
 userRole?: UserRole,
 userIdentity?: string,
 nsApiUrl?: string,
 authProvider?: NetSapiensAuthProvider,
 bearerToken?: string,
) {
 const server = new Server(
  serverImplementation(config),
  { capabilities: serverCapabilities(), instructions: SERVER_INSTRUCTIONS },
 );

 const targetApiUrl = nsApiUrl || config.netsapiens.apiUrl;
 const origin = new URL(targetApiUrl).origin;
 const versionInfo = await getVersionInfo(origin);
 const availabilityContext = createAvailabilityContext(versionInfo);

 // Build a client config. If we have a per-user NS access token from the
 // OAuth flow, use that. Otherwise fall back to the operator-level config.
 const clientConfig: NetSapiensConfig = nsAccessToken
  ? {
   apiUrl: targetApiUrl,
   apiToken: nsAccessToken,
   timeout: config.netsapiens.timeout,
   onUnauthorized: async () => {
    if (authProvider && bearerToken) {
     await authProvider.invalidateToken(bearerToken);
    }
   },
  }
  : { ...config.netsapiens, apiUrl: targetApiUrl };

 const client = new NetSapiensClient(clientConfig);
 const guardedClient = createGuardedClient(client, availabilityContext);
 registerTools(server, guardedClient, userRole, userIdentity, availabilityContext);

 server.onerror = (error) => {
  logger.error('[MCP Error]', { error: String(error) });
 };

 return { server, client: guardedClient, availabilityContext, versionInfo };
}

async function createAuthenticatedMcpServerForRequest(
 config: ReturnType<typeof loadConfig>,
 req: AuthenticatedRequest,
 authProvider?: NetSapiensAuthProvider,
) {
 const extra = req.auth?.extra as Record<string, unknown> | undefined;
 return createAuthenticatedMcpServer(
  config,
  extra?.nsAccessToken as string | undefined,
  extra?.nsUserRole as UserRole | undefined,
  extra?.nsUsername as string | undefined,
  extra?.nsApiUrl as string | undefined,
  authProvider,
  req.auth?.token,
 );
}
