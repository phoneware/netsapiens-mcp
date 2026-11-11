#!/usr/bin/env node
/**
 * Entry point for the NetSapiens MCP server.
 *
 * Reads configuration from the environment, builds an MCP server around a
 * NetSapiensClient, and serves it over stdio or HTTP depending on
 * MCP_TRANSPORT.
 */
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { normalizePlatformUrl } from './auth/platforms.js';
import type { UserRole } from './auth/roles.js';
import { createAvailabilityContext } from './netsapiens/availability.js';
import type { AvailabilityContext } from './netsapiens/availability.js';
import { createGuardedClient } from './netsapiens/guarded-client.js';
import { getVersionInfo } from './netsapiens/version.js';
import { NetSapiensClient } from './netsapiens-client.js';
import { SERVER_INSTRUCTIONS, serverCapabilities, serverImplementation } from './server-info.js';
import { createMemoryStore } from './store/memory.js';
import { getAllToolDefinitions, registerAllTools } from './tools/index.js';
import { setUsageStore } from './tools/promotion/usage-store.js';
import type { MCPServerConfig, NetSapiensConfig } from './types/config.js';
import { logger } from './utils/logger.js';

const packageMetadata: unknown = createRequire(import.meta.url)('../package.json');
if (!packageMetadata || typeof packageMetadata !== 'object' || !('version' in packageMetadata) || typeof packageMetadata.version !== 'string') {
 throw new Error('Invalid package version');
}
const packageVersion = packageMetadata.version;
const REQUEST_TIMEOUT_MS = 30_000;

/** Reads the process environment into a server configuration, or throws a ConfigError. */
export const loadConfig = (): MCPServerConfig => {
 const rawApiUrl = process.env.NETSAPIENS_API_URL;
 if (!rawApiUrl) throw new Error('ConfigError: NETSAPIENS_API_URL is required (your NetSapiens host, for example https://netsapiens.example.com)');
 let apiUrl: string;
 try { apiUrl = normalizePlatformUrl(rawApiUrl); } catch { throw new Error(`ConfigError: NETSAPIENS_API_URL must be an http(s) URL, got "${rawApiUrl}"`); }
 const transport = process.env.MCP_TRANSPORT || 'stdio';
 const rawTtl = process.env.NETSAPIENS_VERSION_TTL_SECONDS;
 if (rawTtl !== undefined && rawTtl !== '') {
  if (!/^\d+$/.test(rawTtl) || parseInt(rawTtl, 10) <= 0) {
   throw new Error(`ConfigError: NETSAPIENS_VERSION_TTL_SECONDS must be a positive integer, got "${rawTtl}"`);
  }
 }
 if (process.env.MCP_PLATFORMS !== undefined) throw new Error('ConfigError: MCP_PLATFORMS was removed in 3.0.0; use NETSAPIENS_PLATFORMS');
 if (transport !== 'http' && process.env.NETSAPIENS_PLATFORMS !== undefined) console.error('warn: NETSAPIENS_PLATFORMS is ignored in stdio mode');

 // In HTTP mode, per-user auth is handled by the browser login flow.
 // We only need the API URL and operator-level client credentials (validated in http-server.ts).
 const isHttp = transport === 'http';

 // Check if OAuth credentials are provided (full set for stdio mode)
 const hasOAuth = !!(
  process.env.NETSAPIENS_OAUTH_CLIENT_ID &&
  process.env.NETSAPIENS_OAUTH_CLIENT_SECRET &&
  process.env.NETSAPIENS_OAUTH_USERNAME &&
  process.env.NETSAPIENS_OAUTH_PASSWORD
 );

 // Check if API token is provided
 const hasApiToken = !!process.env.NETSAPIENS_API_TOKEN;

 // Stdio mode requires authentication credentials upfront
 if (!isHttp && !hasOAuth && !hasApiToken) {
  throw new Error(
   'Authentication required: Either provide NETSAPIENS_API_TOKEN or OAuth credentials ' +
   '(NETSAPIENS_OAUTH_CLIENT_ID, NETSAPIENS_OAUTH_CLIENT_SECRET, ' +
   'NETSAPIENS_OAUTH_USERNAME, NETSAPIENS_OAUTH_PASSWORD)'
  );
 }

 // When both are present, OAuth credentials win over the static token.
 const auth: Pick<NetSapiensConfig, 'oauth' | 'apiToken'> = hasOAuth
  ? {
   oauth: {
    clientId: process.env.NETSAPIENS_OAUTH_CLIENT_ID!,
    clientSecret: process.env.NETSAPIENS_OAUTH_CLIENT_SECRET!,
    username: process.env.NETSAPIENS_OAUTH_USERNAME!,
    password: process.env.NETSAPIENS_OAUTH_PASSWORD!,
   },
  }
  : hasApiToken
   ? { apiToken: process.env.NETSAPIENS_API_TOKEN! }
   : {};

 return {
  name: 'netsapiens-mcp',
  version: packageVersion,
  netsapiens: {
   apiUrl,
   timeout: REQUEST_TIMEOUT_MS,
   rateLimit: { requests: 100, perMilliseconds: 60_000 },
   ...auth,
  },
  debug: process.env.DEBUG === 'true',
 };
};

/**
 * Returns the list of tool definitions exposed by this MCP server.
 * Delegates to the modular tools system in src/tools/.
 */
export function getToolDefinitions() {
 return getAllToolDefinitions();
}

/**
 * Registers every tool handler on `server`, bound to `client`. The tool
 * system itself lives in src/tools/.
 */
export function registerTools(
 server: Server,
 client: NetSapiensClient,
 userRole?: UserRole,
 userIdentity?: string,
 availabilityContext?: AvailabilityContext,
): void {
 registerAllTools(server, client, userRole, userIdentity, availabilityContext);
}

/**
 * Builds an MCP Server and the NetSapiensClient behind it, without attaching
 * a transport. The stdio and HTTP paths both start here.
 */
export function createMcpServer(
 config: MCPServerConfig,
 context?: AvailabilityContext,
): { server: Server; client: NetSapiensClient } {
 const server = new Server(
  serverImplementation(config),
  { capabilities: serverCapabilities(), instructions: SERVER_INSTRUCTIONS },
 );
 const rawClient = new NetSapiensClient(config.netsapiens);
 const client = context ? createGuardedClient(rawClient, context) : rawClient;
 registerTools(server, client, undefined, undefined, context);

 server.onerror = (error) => {
  logger.error('[MCP Error]', { error: String(error) });
 };

 return { server, client };
}

/** Stdio server wrapper. Kept for callers that import the class directly. */
export class NetSapiensMCPServer {
 private server: Server;
 private netsapiensClient: NetSapiensClient;

 constructor(config: MCPServerConfig, context?: AvailabilityContext) {
  const built = createMcpServer(config, context);
  this.server = built.server;
  this.netsapiensClient = built.client;

  const shutdown = async (): Promise<void> => {
   await this.server.close();
   process.exit(0);
  };
  process.on('SIGINT', shutdown);
 }

 /** Connects over stdio and, in debug mode, logs the upstream host. */
 async run(): Promise<void> {
  await this.server.connect(new StdioServerTransport());

  const config = loadConfig();
  if (config.debug) {
   logger.debug('NetSapiens MCP Server started successfully', { nsApiUrl: config.netsapiens.apiUrl });
  }
 }
}

export async function main(): Promise<void> {
 const transport = process.env.MCP_TRANSPORT || 'stdio';

 if (transport === 'http') {
  const { startHttpServer } = await import('./http-server.js');
  await startHttpServer();
 } else {
  if (process.env.MCP_PERSISTENCE !== undefined) console.error('warn: MCP_PERSISTENCE is ignored in stdio mode');
  if (process.env.MCP_STORE_NAMESPACE !== undefined) console.error('warn: MCP_STORE_NAMESPACE is ignored in stdio mode');
  if (process.env.MCP_STORE_PATH !== undefined) console.error('warn: MCP_STORE_PATH is ignored in stdio mode');
  if (process.env.MCP_SESSION_SECRET !== undefined) console.error('warn: MCP_SESSION_SECRET is ignored in stdio mode');
  const stdioStore = createMemoryStore({ namespace: 'stdio', key: randomBytes(32) });
  setUsageStore(stdioStore.usage);

  const config = loadConfig();
  const origin = new URL(config.netsapiens.apiUrl).origin;
  const versionInfo = await getVersionInfo(origin);
  const context = createAvailabilityContext(versionInfo);
  const server = new NetSapiensMCPServer(config, context);
  await server.run();
 }
}

/**
 * Only auto-run when this file is the actual entrypoint — not when imported
 * from tests. Compares the resolved CLI argv path against import.meta.url.
 */
function isEntrypoint(): boolean {
 if (typeof process === 'undefined' || !process.argv?.[1]) return false;
 try {
  const realArgv = realpathSync(process.argv[1]);
  return realArgv === fileURLToPath(import.meta.url);
 } catch {
  return false;
 }
}

if (isEntrypoint()) {
 main().catch((error) => {
  if (error instanceof Error && error.message.startsWith('ConfigError: ')) console.error(error.message);
  logger.error('Fatal error starting MCP server', {
   error: error instanceof Error ? error.message : String(error),
   stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
 });
}
