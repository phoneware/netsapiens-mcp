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
import { requireBearer } from './auth/kit/bearer.js';
import { UpstreamRevokedError, kitCodeOf, CutoverRefusedError, CutoverFenceError } from './auth/kit/errors.js';
import { TemporarilyUnavailableError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { adoptClientMiddleware } from './auth/kit/adopt-client.js';
import {
  getCutoverFenceRecord,
  withLegacyOperation,
  type CutoverFenceConfig,
  type SupportedCutoverNamespace,
  requestOperationContext,
} from './auth/kit/cutover-fence.js';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { loadConfig, registerTools } from './index.js';
import { NetSapiensClient } from './netsapiens-client.js';
import { NetSapiensAuthProvider } from './auth/netsapiens-auth-provider.js';
import { allowLoopbackRedirectUri } from './auth/loopback-redirect.js';
import { negotiateProtocolVersion } from './http/protocol-version.js';
import {
 SERVER_INSTRUCTIONS,
 isStatelessMode,
 serverCapabilities,
 serverImplementation,
} from './server-info.js';
import { logger } from './utils/logger.js';
import type { UserRole } from './auth/roles.js';
import type { NetSapiensConfig } from './types/config.js';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
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
export interface CreateAppOptions {
 customAuthProvider?: NetSapiensAuthProvider;
 fence?: CutoverFenceConfig;
 validateStartup?: boolean;
}

export function createApp(options?: CreateAppOptions | NetSapiensAuthProvider): { app: express.Express; authProvider: NetSapiensAuthProvider; baseUrl: URL; mcpUrl: URL } {
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

 const customAuthProvider = options && 'handleLogin' in options ? options as NetSapiensAuthProvider : (options as CreateAppOptions | undefined)?.customAuthProvider;
 const explicitFence = (options && !('handleLogin' in options)) ? (options as CreateAppOptions | undefined)?.fence : undefined;
 const fenceEnforce = explicitFence?.enforce ?? (process.env.MCP_FENCE_ENFORCE === 'true' || process.env.MCP_CUTOVER_FENCE === 'true');
 const fenceNamespace = (explicitFence?.namespace ?? process.env.MCP_FENCE_NAMESPACE ?? process.env.MCP_CUTOVER_FENCE_NAMESPACE ?? (process.env.MCP_READ_ONLY === 'true' ? 'readonly_mcp' : 'mcp')) as ('mcp' | 'pwmcp' | 'readonly_mcp');
 const fenceConfig: CutoverFenceConfig | undefined = fenceEnforce
   ? { namespace: fenceNamespace, enforce: true }
   : undefined;

 const tokenLifetimeSec = parseLifetimeHoursToSeconds(process.env.MCP_TOKEN_LIFETIME_HOURS, 24 * 7);
 const authProvider = customAuthProvider ?? new NetSapiensAuthProvider({
  nsApiUrl: config.netsapiens.apiUrl,
  nsClientId,
  nsClientSecret,
  tokenLifetimeSec,
  serverBaseUrl: baseUrl.origin,
  fence: fenceConfig,
 });
 const { app } = wireApp(config, authProvider, baseUrl, mcpUrl);
 return { app, authProvider, baseUrl, mcpUrl };
}

export async function validateBridgeStartup(authProvider: NetSapiensAuthProvider): Promise<void> {
 if (authProvider.fenceConfig?.enforce) {
  if (!authProvider.dbInstance) {
   throw new CutoverFenceError(
    `Bridge startup refused: cutover fence is enforced for namespace ${authProvider.fenceNamespace} but no Firestore database instance is configured`,
   );
  }
  const control = await getCutoverFenceRecord(authProvider.dbInstance, authProvider.fenceNamespace);
  if (!control) {
   throw new CutoverFenceError(
    `Bridge startup refused: cutover fence control record is missing for namespace ${authProvider.fenceNamespace}`,
   );
  }
 }
}

/**
 * Starts the HTTP-based MCP server with OAuth 2.1 authentication.
 *
 * Returns the listening `http.Server` so callers can shut it down (tests
 * especially, which otherwise leak a listener per case and collide on ports.
 */
export async function startHttpServer(options?: CreateAppOptions): Promise<HttpServer> {
 const { app, authProvider, baseUrl, mcpUrl } = createApp(options);
 const config = loadConfig();
 await validateBridgeStartup(authProvider);
 const port = parseInt(process.env.MCP_PORT || '3000', 10);
 const host = process.env.MCP_HOST || '0.0.0.0';

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
   logger.debug('Debug mode enabled');
  }
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
 app.use('/mcp', mcpLimiter);

 // -----------------------------------------------------------------------
 // Health check: unauthenticated
 // -----------------------------------------------------------------------

 // Active sessions keyed by session ID (declared early for use in health check)
 const sessions = new Map<string, McpSession>();

 app.get('/health', (_req, res) => {
  res.json({
   status: 'ok',
   uptime: Math.floor(process.uptime()),
   mode: isStatelessMode() ? 'stateless' : 'session',
   activeSessions: sessions.size,
   nsApiUrl: config.netsapiens.apiUrl,
   version: config.version,
  });
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
   logger.warn('Failed to fetch icon, serving 404');
   res.status(404).end();
  }
 });

 // Publishes the requested loopback redirect_uri for the clients store, which
 // the SDK calls with no request context. Must precede mcpAuthRouter, and is
/**
 * SDK Version Gate:
 * Verified for @modelcontextprotocol/sdk ^1.32.1 (pinned runtime 1.32.2).
 * Pinned SDK handlers (token, authorize, revoke, register) await provider/store
 * async work before calling response.end().
 */
export const SUPPORTED_MCP_SDK_VERSIONS = ['1.32.1', '1.32.2'];

const cutoverAdmissionMiddleware = (endpointName: string): express.RequestHandler => {
  return async (req, res, next) => {
   if (!authProvider.fenceConfig?.enforce || !authProvider.dbInstance) {
    return next();
   }
   try {
    const control = await getCutoverFenceRecord(authProvider.dbInstance, authProvider.fenceNamespace);
    if (!control || control.state !== 'legacy_open') {
     res.setHeader('Retry-After', '5');
     return res.status(503).json({
      error: 'temporarily_unavailable',
      error_description: control
       ? `Cutover state is ${control.state}; ${endpointName} is temporarily unavailable`
       : `Cutover fence control record is missing for namespace ${authProvider.fenceNamespace}`,
     });
    }

    await withLegacyOperation(
     {
      db: authProvider.dbInstance,
      namespace: authProvider.fenceNamespace as SupportedCutoverNamespace,
      kind: endpointName,
      now: authProvider.nowProvider,
     },
     async (opCtx) => {
      (req as any).cutoverOperation = opCtx;
      // Whole-task lifecycle: starts at 1 covering the route execution itself
      let activeTasks = 1;
      let closedToNewTasks = false;
      let resolveQuiescence: (() => void) | undefined;

      const checkQuiescent = () => {
       if (closedToNewTasks && activeTasks === 0) {
        if (resolveQuiescence) {
         const r = resolveQuiescence;
         resolveQuiescence = undefined;
         r();
        }
       }
      };

      (opCtx as any).enterWriter = () => {
       if (closedToNewTasks) {
        throw new CutoverFenceError('Operation is closed to new tasks; mutation rejected');
       }
       activeTasks++;
      };

      (opCtx as any).exitWriter = () => {
       activeTasks--;
       if (activeTasks < 0) {
        throw new CutoverFenceError('Active tasks underflow in operation lifecycle');
       }
       checkQuiescent();
      };

      // Thunk registration: enterWriter is called BEFORE fn() is invoked
      (opCtx as any).trackWriter = async <T>(fn: () => Promise<T>): Promise<T> => {
       (opCtx as any).enterWriter();
       try {
        return await fn();
       } finally {
        (opCtx as any).exitWriter();
       }
      };

      const quiescencePromise = new Promise<void>((resolve) => {
       resolveQuiescence = resolve;
      });

      // Transport close ONLY notes transport loss
      res.once('close', () => {
       // Transport disconnected
      });
      let handlerSettled = false;
      let failSafeTimer: NodeJS.Timeout | undefined;
      const markHandlerSettled = () => {
       if (!handlerSettled) {
        handlerSettled = true;
        clearTimeout(failSafeTimer);
        closedToNewTasks = true;
        activeTasks--;
        if (activeTasks < 0) {
         throw new CutoverFenceError('Active tasks underflow on handler completion');
        }
        checkQuiescent();
       }
      };
      failSafeTimer = setTimeout(() => { markHandlerSettled(); }, 30_000);
      (req as any).signalHandlerComplete = markHandlerSettled;
      res.once('finish', markHandlerSettled);
      const origEnd = res.end.bind(res);
      res.end = (...args: any[]) => {
       const ret = (origEnd as any)(...args);
       markHandlerSettled();
       return ret;
      };

      if (req.method === 'GET' && endpointName === 'mcp') {
       const origWriteHead = res.writeHead.bind(res);
       res.writeHead = (...args: any[]) => {
        const ret = (origWriteHead as any)(...args);
        markHandlerSettled();
        return ret;
       };
      }


      requestOperationContext.run(opCtx, () => {
       next();
      });

      await quiescencePromise;
     },
    );
   } catch (err: unknown) {
    if (res.headersSent) return;
    if (err instanceof CutoverRefusedError || kitCodeOf(err) === 'cutover_refused') {
     const retryAfter = (err && typeof err === 'object' && 'retryAfterSeconds' in err && typeof (err as { retryAfterSeconds: unknown }).retryAfterSeconds === 'number')
      ? (err as { retryAfterSeconds: number }).retryAfterSeconds
      : 5;
     res.setHeader('Retry-After', String(retryAfter));
     return res.status(503).json({
      error: 'temporarily_unavailable',
      error_description: err instanceof Error ? err.message : 'Cutover in progress; operation temporarily unavailable',
     });
    }
    return next(err);
   }
  };
 };

 // HTTP cutover admission precedes ALL mutating middleware, including client adoption (C9.1)
 app.use('/register', cutoverAdmissionMiddleware('register'));
 app.use('/token', cutoverAdmissionMiddleware('token'));
 app.use('/revoke', cutoverAdmissionMiddleware('revoke'));
 app.use('/authorize', cutoverAdmissionMiddleware('authorize'));
 app.use('/login', cutoverAdmissionMiddleware('login'));
 app.use('/mfa', cutoverAdmissionMiddleware('mfa'));

 app.use('/authorize', allowLoopbackRedirectUri());
 app.use(
  '/authorize',
  adoptClientMiddleware({
   clientsStore: authProvider.clientsStore,
   serverName: 'NetSapiens MCP',
  }),
 );
 // Intercept /token and /revoke responses to map temporarily_unavailable to HTTP 503 + Retry-After: 5
 app.use(['/token', '/revoke'], (_req, res, next) => {
  const origStatus = res.status.bind(res);
  const origJson = res.json.bind(res);
  let currentStatus = 200;

  res.status = (code: number) => {
   currentStatus = code;
   return res;
  };

  res.json = (body: any) => {
   if (body && typeof body === 'object' && body.error === 'temporarily_unavailable') {
    res.setHeader('Retry-After', '5');
    origStatus(503);
    return origJson(body);
   }
   origStatus(currentStatus);
   return origJson(body);
  };

  next();
 });
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
  try {
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
  } finally {
   (req as any).signalHandlerComplete?.();
  }
 });

 // MFA passcode submission (second step when NS requires MFA)
 app.post('/mfa', async (req, res) => {
  try {
   const { passcode } = req.body;

   if (!passcode) {
    res.status(400).json({ error: 'Missing passcode' });
    return;
   }

   await authProvider.handleMfa(req, res, passcode);
  } finally {
   (req as any).signalHandlerComplete?.();
  }
 });

 // -----------------------------------------------------------------------
 // MCP transport: all routes require bearer auth
 // -----------------------------------------------------------------------

 const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(mcpUrl);
 const bearerAuth = requireBearer({
  verifier: authProvider,
  resourceMetadataUrl,
  now: authProvider.nowProvider,
 });
 app.use('/mcp', cutoverAdmissionMiddleware('mcp'));
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
  try {
   const sessionId = req.headers['mcp-session-id'] as string | undefined;
   const body = (req as any).body;

   if (isStatelessMode()) {
    const { server, client } = createAuthenticatedMcpServerForRequest(config, req, authProvider);
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
    const { server, client } = createAuthenticatedMcpServerForRequest(config, req, authProvider);

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
  } finally {
   (req as any).signalHandlerComplete?.();
  }
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
  try {
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
  } finally {
   (req as any).signalHandlerComplete?.();
  }
 });

 // Cutover fence and transient store error handler
 app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) {
   return next(err);
  }
  const code = kitCodeOf(err);
  if (code === 'cutover_refused' || err instanceof CutoverRefusedError) {
   const retryAfter = (err && typeof err === 'object' && 'retryAfterSeconds' in err && typeof (err as { retryAfterSeconds: unknown }).retryAfterSeconds === 'number')
    ? (err as { retryAfterSeconds: number }).retryAfterSeconds
    : 30;
   res.setHeader('Retry-After', String(retryAfter));
   return res.status(503).json({
    error: 'temporarily_unavailable',
    error_description: err instanceof Error ? err.message : 'Cutover in progress; operation temporarily unavailable',
   });
  }
  if (err instanceof TemporarilyUnavailableError || code === 'store_unavailable' || code === 'upstream_unavailable' || code === 'cutover_fence_error' || err instanceof CutoverFenceError) {
   return res.status(503).json({
    error: 'temporarily_unavailable',
    error_description: err instanceof Error ? err.message : 'Service temporarily unavailable',
   });
  }
  return next(err);
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
 nsApiUrl?: string,
 authProvider?: NetSapiensAuthProvider,
 bearerToken?: string,
) {
 const server = new Server(
  serverImplementation(config),
  { capabilities: serverCapabilities(), instructions: SERVER_INSTRUCTIONS },
 );

 // Build a client config. If we have a per-user NS access token from the
 // OAuth flow, use that. Otherwise fall back to the operator-level config.
 const clientConfig: NetSapiensConfig = nsAccessToken
  ? {
   apiUrl: nsApiUrl || config.netsapiens.apiUrl,
   apiToken: nsAccessToken,
   timeout: config.netsapiens.timeout,
   onUnauthorized: async () => {
    if (authProvider && bearerToken) {
     try {
      const newNsToken = await authProvider.forceRefreshUpstream(bearerToken);
      if (newNsToken) {
       client.setApiToken(newNsToken);
      }
     } catch (err) {
      if (err instanceof UpstreamRevokedError || kitCodeOf(err) === 'upstream_revoked') {
     await authProvider.invalidateToken(bearerToken);
      }
     }
    }
   },
  }
  : config.netsapiens;

 const client = new NetSapiensClient(clientConfig);
 registerTools(server, client, userRole, userIdentity);

 server.onerror = (error) => {
  logger.error('[MCP Error]', { error: error instanceof Error ? error.name : 'UnknownError' });
 };

 return { server, client };
}

/**
 * Same as `createAuthenticatedMcpServer`, but pulls the NS token, role, and
 * identity straight off the verified bearer. Both the stateless and the
 * session path build their server this way, so they cannot drift.
 */
function createAuthenticatedMcpServerForRequest(
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
