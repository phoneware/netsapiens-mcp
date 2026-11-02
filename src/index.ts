/**
 * NetSapiens MCP Server
 * Model Context Protocol server for NetSapiens platform integration
 *
 * This server provides AI agents with access to NetSapiens VoIP platform
 * functionality including user management, call records, and system information.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { NetSapiensClient } from './netsapiens-client.js';
import { MCPServerConfig } from './types/config.js';
import { SERVER_INSTRUCTIONS, serverCapabilities, serverImplementation } from './server-info.js';
import { logger } from './utils/logger.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getAllToolDefinitions, registerAllTools } from './tools/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let packageVersion = '2.4.0';
try {
  const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'));
  if (pkg.version) packageVersion = pkg.version;
} catch {
  // default fallback
}
// Configuration - these would typically come from environment variables
export const loadConfig = (): MCPServerConfig => {
  const apiUrl = process.env.NETSAPIENS_API_URL || 'https://edge.phoneware.cloud';
  const transport = process.env.MCP_TRANSPORT || 'stdio';

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

  // Build NetSapiens config
  const netsapiensConfig: any = {
    apiUrl,
    timeout: 30000,
    rateLimit: {
      requests: 100,
      perMilliseconds: 60000 // 100 requests per minute
    }
  };

  // Add OAuth config if provided (takes precedence over API token)
  if (hasOAuth) {
    netsapiensConfig.oauth = {
      clientId: process.env.NETSAPIENS_OAUTH_CLIENT_ID!,
      clientSecret: process.env.NETSAPIENS_OAUTH_CLIENT_SECRET!,
      username: process.env.NETSAPIENS_OAUTH_USERNAME!,
      password: process.env.NETSAPIENS_OAUTH_PASSWORD!
    };
  } else if (hasApiToken) {
    netsapiensConfig.apiToken = process.env.NETSAPIENS_API_TOKEN!;
  }

  return {
    name: 'netsapiens-mcp',
    version: packageVersion,
    netsapiens: netsapiensConfig,
    debug: process.env.DEBUG === 'true'
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
 * Registers tool handlers on a Server instance, wired to the given NetSapiensClient.
 * Delegates to the modular tools system in src/tools/.
 */
export function registerTools(
  server: Server,
  netsapiensClient: NetSapiensClient,
  userRole?: import('./auth/roles.js').UserRole,
  userIdentity?: string,
): void {
  registerAllTools(server, netsapiensClient, userRole, userIdentity);
}

// ---------------------------------------------------------------------------
// NetSapiensMCPServer class (retained for backward compatibility)
// ---------------------------------------------------------------------------

export class NetSapiensMCPServer {
  private server: Server;
  private netsapiensClient: NetSapiensClient;

  constructor(config: MCPServerConfig) {
    this.server = new Server(
      serverImplementation(config),
      {
        capabilities: serverCapabilities(),
        instructions: SERVER_INSTRUCTIONS,
      }
    );

    this.netsapiensClient = new NetSapiensClient(config.netsapiens);
    registerTools(this.server, this.netsapiensClient);
    this.setupErrorHandling();
  }

  private setupErrorHandling(): void {
    this.server.onerror = (error) => {
      logger.error('[MCP Error]', { error: error instanceof Error ? error.name : 'UnknownError' });
    };

    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    const config = loadConfig();
    if (config.debug) {
      logger.debug('NetSapiens MCP Server started successfully');
    }
  }
}

/**
 * Creates a configured MCP Server + NetSapiensClient pair without connecting a transport.
 * Used by both the stdio and HTTP code paths.
 */
export function createMcpServer(config: MCPServerConfig): { server: Server; client: NetSapiensClient } {
  const server = new Server(
    serverImplementation(config),
    { capabilities: serverCapabilities(), instructions: SERVER_INSTRUCTIONS }
  );
  const client = new NetSapiensClient(config.netsapiens);
  registerTools(server, client);

  server.onerror = (error) => {
    logger.error('[MCP Error]', { error: error instanceof Error ? error.name : 'UnknownError' });
  };

  return { server, client };
}

export async function main(): Promise<void> {
  const transport = process.env.MCP_TRANSPORT || 'stdio';

  if (transport === 'http') {
    const { startHttpServer } = await import('./http-server.js');
    await startHttpServer();
  } else {
    const config = loadConfig();
    const server = new NetSapiensMCPServer(config);
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
    const argvUrl = new URL(`file://${process.argv[1]}`).href;
    return import.meta.url === argvUrl;
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main().catch((error) => {
    logger.error('Fatal error starting MCP server', {
      error: error instanceof Error ? error.name : 'UnknownError',
    });
    process.exit(1);
  });
}

export { requireBearer } from './auth/kit/bearer.js';
export {
  StoreUnavailableError,
  UpstreamUnavailableError,
  UpstreamRevokedError,
  kitCodeOf,
  classifyUpstreamTokenResponse,
  toTokenEndpointError,
} from './auth/kit/errors.js';
