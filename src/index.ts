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
import { logger } from './utils/logger.js';
import { getAllToolDefinitions, registerAllTools } from './tools/index.js';

// Configuration - these would typically come from environment variables
export const loadConfig = (): MCPServerConfig => {
  const apiUrl = process.env.NETSAPIENS_API_URL || 'https://edge.phoneware.cloud';

  // Check if OAuth credentials are provided
  const hasOAuth = !!(
    process.env.NETSAPIENS_OAUTH_CLIENT_ID &&
    process.env.NETSAPIENS_OAUTH_CLIENT_SECRET &&
    process.env.NETSAPIENS_OAUTH_USERNAME &&
    process.env.NETSAPIENS_OAUTH_PASSWORD
  );

  // Check if API token is provided
  const hasApiToken = !!process.env.NETSAPIENS_API_TOKEN;

  // Require at least one authentication method
  if (!hasOAuth && !hasApiToken) {
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
  } else {
    // Use API token
    netsapiensConfig.apiToken = process.env.NETSAPIENS_API_TOKEN!;
  }

  return {
    name: 'netsapiens-mcp',
    version: '1.1.1',
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
export function registerTools(server: Server, netsapiensClient: NetSapiensClient): void {
  registerAllTools(server, netsapiensClient);
}

// ---------------------------------------------------------------------------
// NetSapiensMCPServer class (retained for backward compatibility)
// ---------------------------------------------------------------------------

export class NetSapiensMCPServer {
  private server: Server;
  private netsapiensClient: NetSapiensClient;

  constructor(config: MCPServerConfig) {
    this.server = new Server(
      {
        name: config.name,
        version: config.version,
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.netsapiensClient = new NetSapiensClient(config.netsapiens);
    registerTools(this.server, this.netsapiensClient);
    this.setupErrorHandling();
  }

  private setupErrorHandling(): void {
    this.server.onerror = (error) => {
      logger.error('[MCP Error]', { error: String(error) });
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
      logger.debug('NetSapiens MCP Server started successfully', { nsApiUrl: config.netsapiens.apiUrl });
    }
  }
}

/**
 * Creates a configured MCP Server + NetSapiensClient pair without connecting a transport.
 * Used by both the stdio and HTTP code paths.
 */
export function createMcpServer(config: MCPServerConfig): { server: Server; client: NetSapiensClient } {
  const server = new Server(
    { name: config.name, version: config.version },
    { capabilities: { tools: {} } }
  );
  const client = new NetSapiensClient(config.netsapiens);
  registerTools(server, client);

  server.onerror = (error) => {
    logger.error('[MCP Error]', { error: String(error) });
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
