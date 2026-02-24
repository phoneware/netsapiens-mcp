#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { createApiClient } from './netsapiens-client.js';
import { OAuthManager } from './oauth-manager.js';
import toolRegistry from './generated/registry.js';

interface ServerConfig {
  name: string;
  version: string;
  apiUrl: string;
  apiToken?: string;
  oauth?: {
    clientId: string;
    clientSecret: string;
    username?: string;
    password?: string;
  };
  timeout: number;
  debug: boolean;
}

function loadConfig(): ServerConfig {
  const apiToken = process.env.NETSAPIENS_API_TOKEN;
  const clientId = process.env.NETSAPIENS_CLIENT_ID;
  const clientSecret = process.env.NETSAPIENS_CLIENT_SECRET;
  const username = process.env.NETSAPIENS_USERNAME;
  const password = process.env.NETSAPIENS_PASSWORD;

  if (!apiToken && !(clientId && clientSecret)) {
    throw new Error(
      'Authentication required. Set NETSAPIENS_API_TOKEN for static token auth, ' +
      'or NETSAPIENS_CLIENT_ID + NETSAPIENS_CLIENT_SECRET for OAuth.'
    );
  }

  return {
    name: 'oitvoip-mcp-server',
    version: '1.0.0',
    apiUrl: process.env.NETSAPIENS_API_URL || 'https://api.ucaasnetwork.com',
    apiToken: apiToken || undefined,
    oauth: clientId && clientSecret ? {
      clientId,
      clientSecret,
      username: username || undefined,
      password: password || undefined,
    } : undefined,
    timeout: 30000,
    debug: process.env.DEBUG === 'true',
  };
}

async function main() {
  const config = loadConfig();

  let tokenProvider: () => Promise<string>;
  let oauthManager: OAuthManager | null = null;

  if (config.oauth) {
    oauthManager = new OAuthManager(config.apiUrl, config.oauth);
    await oauthManager.authenticate();
    tokenProvider = () => oauthManager!.getAccessToken();
  } else {
    tokenProvider = async () => config.apiToken!;
  }

  const apiClient = createApiClient(
    { apiUrl: config.apiUrl, timeout: config.timeout },
    tokenProvider,
  );

  const server = new Server(
    { name: config.name, version: config.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Array.from(toolRegistry.values()).map((t) => t.schema),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolRegistry.get(name);
    if (!tool) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    try {
      return await tool.handler(args ?? {}, apiClient);
    } catch (error) {
      if (error instanceof McpError) throw error;
      throw new McpError(
        ErrorCode.InternalError,
        `Error executing tool ${name}: ${error}`,
      );
    }
  });

  server.onerror = (error) => {
    console.error('[MCP Error]', error);
  };

  process.on('SIGINT', async () => {
    await server.close();
    process.exit(0);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  if (config.debug) {
    console.error('OITVOIP MCP Server started successfully');
    console.error(`API URL: ${config.apiUrl}`);
    console.error(`Tools registered: ${toolRegistry.size}`);
  }
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
