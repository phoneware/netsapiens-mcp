/**
 * NetSapiens MCP Server
 * Model Context Protocol server for NetSapiens platform integration
 *
 * This server provides AI agents with access to NetSapiens VoIP platform
 * functionality including user management, call records, and system information.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { NetSapiensClient } from './netsapiens-client.js';
import { MCPServerConfig } from './types/config.js';

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
 */
export function getToolDefinitions() {
  return [
    {
      name: 'search_users',
      description: 'Search for users in the NetSapiens system',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query (username or partial username)',
          },
          domain: {
            type: 'string',
            description: 'Optional specific domain to search in',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results to return (default: 20)',
            default: 20,
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'get_user',
      description: 'Get detailed information about a specific user',
      inputSchema: {
        type: 'object',
        properties: {
          userId: {
            type: 'string',
            description: 'User ID (username part)',
          },
          domain: {
            type: 'string',
            description: 'Domain name',
          },
        },
        required: ['userId', 'domain'],
      },
    },
    {
      name: 'get_cdr_records',
      description: 'Retrieve call detail records (CDR)',
      inputSchema: {
        type: 'object',
        properties: {
          startDate: {
            type: 'string',
            description: 'Start date for CDR search (YYYY-MM-DD format)',
          },
          endDate: {
            type: 'string',
            description: 'End date for CDR search (YYYY-MM-DD format)',
          },
          user: {
            type: 'string',
            description: 'Specific user to get CDR records for',
          },
          domain: {
            type: 'string',
            description: 'Domain to search in (required if user is specified)',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of records to return (default: 100)',
            default: 100,
          },
        },
      },
    },
    {
      name: 'get_domains',
      description: 'Get list of domains in the NetSapiens system',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'get_domain',
      description: 'Get detailed information about a specific domain',
      inputSchema: {
        type: 'object',
        properties: {
          domain: {
            type: 'string',
            description: 'Domain name to retrieve information for',
          },
        },
        required: ['domain'],
      },
    },
    {
      name: 'get_user_devices',
      description: 'Get devices assigned to a specific user',
      inputSchema: {
        type: 'object',
        properties: {
          userId: {
            type: 'string',
            description: 'User ID',
          },
          domain: {
            type: 'string',
            description: 'Domain name',
          },
        },
        required: ['userId', 'domain'],
      },
    },
    {
      name: 'get_phone_numbers',
      description: 'Get phone numbers for a domain',
      inputSchema: {
        type: 'object',
        properties: {
          domain: {
            type: 'string',
            description: 'Domain name',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results (optional)',
          },
        },
        required: ['domain'],
      },
    },
    {
      name: 'get_phone_number',
      description: 'Get details of a specific phone number',
      inputSchema: {
        type: 'object',
        properties: {
          domain: {
            type: 'string',
            description: 'Domain name',
          },
          phoneNumber: {
            type: 'string',
            description: 'Phone number to lookup',
          },
        },
        required: ['domain', 'phoneNumber'],
      },
    },
    {
      name: 'get_call_queues',
      description: 'Get call queues for a domain',
      inputSchema: {
        type: 'object',
        properties: {
          domain: {
            type: 'string',
            description: 'Domain name',
          },
        },
        required: ['domain'],
      },
    },
    {
      name: 'get_call_queue',
      description: 'Get details of a specific call queue',
      inputSchema: {
        type: 'object',
        properties: {
          domain: {
            type: 'string',
            description: 'Domain name',
          },
          queueId: {
            type: 'string',
            description: 'Call queue ID',
          },
        },
        required: ['domain', 'queueId'],
      },
    },
    {
      name: 'get_call_queue_agents',
      description: 'Get agents assigned to a call queue',
      inputSchema: {
        type: 'object',
        properties: {
          domain: {
            type: 'string',
            description: 'Domain name',
          },
          queueId: {
            type: 'string',
            description: 'Call queue ID',
          },
        },
        required: ['domain', 'queueId'],
      },
    },
    {
      name: 'get_agents',
      description: 'Get agents for a domain',
      inputSchema: {
        type: 'object',
        properties: {
          domain: {
            type: 'string',
            description: 'Domain name',
          },
        },
        required: ['domain'],
      },
    },
    {
      name: 'login_agent',
      description: 'Login an agent to a call queue',
      inputSchema: {
        type: 'object',
        properties: {
          domain: {
            type: 'string',
            description: 'Domain name',
          },
          queueId: {
            type: 'string',
            description: 'Call queue ID',
          },
          agentId: {
            type: 'string',
            description: 'Agent ID',
          },
        },
        required: ['domain', 'queueId', 'agentId'],
      },
    },
    {
      name: 'logout_agent',
      description: 'Logout an agent from a call queue',
      inputSchema: {
        type: 'object',
        properties: {
          domain: {
            type: 'string',
            description: 'Domain name',
          },
          queueId: {
            type: 'string',
            description: 'Call queue ID',
          },
          agentId: {
            type: 'string',
            description: 'Agent ID',
          },
        },
        required: ['domain', 'queueId', 'agentId'],
      },
    },
    {
      name: 'get_auto_attendants',
      description: 'Get auto attendants for a domain',
      inputSchema: {
        type: 'object',
        properties: {
          domain: {
            type: 'string',
            description: 'Domain name',
          },
        },
        required: ['domain'],
      },
    },
    {
      name: 'get_user_answer_rules',
      description: 'Get answer rules for a user',
      inputSchema: {
        type: 'object',
        properties: {
          userId: {
            type: 'string',
            description: 'User ID',
          },
          domain: {
            type: 'string',
            description: 'Domain name',
          },
        },
        required: ['userId', 'domain'],
      },
    },
    {
      name: 'get_user_answer_rule',
      description: 'Get specific answer rule for a user',
      inputSchema: {
        type: 'object',
        properties: {
          userId: {
            type: 'string',
            description: 'User ID',
          },
          domain: {
            type: 'string',
            description: 'Domain name',
          },
          timeframe: {
            type: 'string',
            description: 'Timeframe for the answer rule',
          },
        },
        required: ['userId', 'domain', 'timeframe'],
      },
    },
    {
      name: 'get_user_greetings',
      description: 'Get greetings for a user',
      inputSchema: {
        type: 'object',
        properties: {
          userId: {
            type: 'string',
            description: 'User ID',
          },
          domain: {
            type: 'string',
            description: 'Domain name',
          },
        },
        required: ['userId', 'domain'],
      },
    },
    {
      name: 'get_user_voicemails',
      description: 'Get voicemails for a user',
      inputSchema: {
        type: 'object',
        properties: {
          userId: {
            type: 'string',
            description: 'User ID',
          },
          domain: {
            type: 'string',
            description: 'Domain name',
          },
        },
        required: ['userId', 'domain'],
      },
    },
    {
      name: 'get_music_on_hold',
      description: 'Get music on hold files for a domain',
      inputSchema: {
        type: 'object',
        properties: {
          domain: {
            type: 'string',
            description: 'Domain name',
          },
        },
        required: ['domain'],
      },
    },
    {
      name: 'get_billing',
      description: 'Get billing information for a domain',
      inputSchema: {
        type: 'object',
        properties: {
          domain: {
            type: 'string',
            description: 'Domain name',
          },
        },
        required: ['domain'],
      },
    },
    {
      name: 'get_agent_statistics',
      description: 'Get agent statistics for a domain',
      inputSchema: {
        type: 'object',
        properties: {
          domain: {
            type: 'string',
            description: 'Domain name',
          },
          agentId: {
            type: 'string',
            description: 'Optional specific agent ID',
          },
        },
        required: ['domain'],
      },
    },
    {
      name: 'test_connection',
      description: 'Test connectivity to NetSapiens API',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ];
}

/**
 * Registers tool handlers on a Server instance, wired to the given NetSapiensClient.
 */
export function registerTools(server: Server, netsapiensClient: NetSapiensClient): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: getToolDefinitions() };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'search_users':
          return await handleSearchUsers(netsapiensClient, args);
        case 'get_user':
          return await handleGetUser(netsapiensClient, args);
        case 'get_cdr_records':
          return await handleGetCDRRecords(netsapiensClient, args);
        case 'get_domains':
          return await handleGetDomains(netsapiensClient, args);
        case 'get_domain':
          return await handleGetDomain(netsapiensClient, args);
        case 'get_user_devices':
          return await handleGetUserDevices(netsapiensClient, args);
        case 'get_phone_numbers':
          return await handleGetPhoneNumbers(netsapiensClient, args);
        case 'get_phone_number':
          return await handleGetPhoneNumber(netsapiensClient, args);
        case 'get_call_queues':
          return await handleGetCallQueues(netsapiensClient, args);
        case 'get_call_queue':
          return await handleGetCallQueue(netsapiensClient, args);
        case 'get_call_queue_agents':
          return await handleGetCallQueueAgents(netsapiensClient, args);
        case 'get_agents':
          return await handleGetAgents(netsapiensClient, args);
        case 'login_agent':
          return await handleLoginAgent(netsapiensClient, args);
        case 'logout_agent':
          return await handleLogoutAgent(netsapiensClient, args);
        case 'get_auto_attendants':
          return await handleGetAutoAttendants(netsapiensClient, args);
        case 'get_user_answer_rules':
          return await handleGetUserAnswerRules(netsapiensClient, args);
        case 'get_user_answer_rule':
          return await handleGetUserAnswerRule(netsapiensClient, args);
        case 'get_user_greetings':
          return await handleGetUserGreetings(netsapiensClient, args);
        case 'get_user_voicemails':
          return await handleGetUserVoicemails(netsapiensClient, args);
        case 'get_music_on_hold':
          return await handleGetMusicOnHold(netsapiensClient, args);
        case 'get_billing':
          return await handleGetBilling(netsapiensClient, args);
        case 'get_agent_statistics':
          return await handleGetAgentStatistics(netsapiensClient, args);
        case 'test_connection':
          return await handleTestConnection(netsapiensClient, args);
        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${name}`
          );
      }
    } catch (error) {
      if (error instanceof McpError) {
        throw error;
      }
      throw new McpError(
        ErrorCode.InternalError,
        `Error executing tool ${name}: ${error}`
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Tool handler functions
// ---------------------------------------------------------------------------

async function handleSearchUsers(client: NetSapiensClient, args: any) {
  const { query, domain, limit = 20 } = args;

  if (!query) {
    throw new McpError(ErrorCode.InvalidParams, 'Query parameter is required');
  }

  const result = await client.searchUsers(query, domain, limit);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: result.success,
          message: result.success
            ? `Found ${result.data?.length || 0} users matching "${query}"${domain ? ` in domain ${domain}` : ''}`
            : `Search failed: ${result.error}`,
          data: result.data,
          error: result.error
        }, null, 2),
      },
    ],
  };
}

async function handleGetUser(client: NetSapiensClient, args: any) {
  const { userId, domain } = args;

  if (!userId || !domain) {
    throw new McpError(ErrorCode.InvalidParams, 'userId and domain parameters are required');
  }

  const result = await client.getUser(userId, domain);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: result.success,
          message: result.success
            ? `Retrieved user details for ${userId}`
            : `Failed to get user: ${result.error}`,
          data: result.data,
          error: result.error
        }, null, 2),
      },
    ],
  };
}

async function handleGetCDRRecords(client: NetSapiensClient, args: any) {
  const { startDate, endDate, user, domain, limit = 100 } = args;

  const result = await client.getCDRRecords({
    startDate,
    endDate,
    user,
    domain,
    limit
  });

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: result.success,
          message: result.success
            ? `Retrieved ${result.data?.length || 0} CDR records`
            : `Failed to get CDR records: ${result.error}`,
          data: result.data,
          error: result.error
        }, null, 2),
      },
    ],
  };
}

async function handleGetDomains(client: NetSapiensClient, _args: any) {
  const result = await client.getDomains();

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: result.success,
          message: result.success
            ? `Retrieved ${result.data?.length || 0} domains`
            : `Failed to get domains: ${result.error}`,
          data: result.data,
          error: result.error
        }, null, 2),
      },
    ],
  };
}

async function handleGetDomain(client: NetSapiensClient, args: any) {
  const { domain } = args;

  if (!domain) {
    throw new McpError(ErrorCode.InvalidParams, 'domain parameter is required');
  }

  const result = await client.getDomain(domain);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: result.success,
          message: result.success
            ? `Retrieved domain information for ${domain}`
            : `Failed to get domain: ${result.error}`,
          data: result.data,
          error: result.error
        }, null, 2),
      },
    ],
  };
}

async function handleGetUserDevices(client: NetSapiensClient, args: any) {
  const { userId, domain } = args;

  if (!userId || !domain) {
    throw new McpError(ErrorCode.InvalidParams, 'userId and domain parameters are required');
  }

  const result = await client.getUserDevices(userId, domain);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: result.success,
          message: result.success
            ? `Retrieved ${result.data?.length || 0} devices for user ${userId}@${domain}`
            : `Failed to get user devices: ${result.error}`,
          data: result.data,
          error: result.error
        }, null, 2),
      },
    ],
  };
}

async function handleGetPhoneNumbers(client: NetSapiensClient, args: any) {
  const { domain, limit } = args;

  if (!domain) {
    throw new McpError(ErrorCode.InvalidParams, 'domain parameter is required');
  }

  const result = await client.getPhoneNumbers(domain, limit);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: result.success,
          message: result.success
            ? `Retrieved ${result.data?.length || 0} phone numbers for domain ${domain}`
            : `Failed to get phone numbers: ${result.error}`,
          data: result.data,
          error: result.error
        }, null, 2),
      },
    ],
  };
}

async function handleGetPhoneNumber(client: NetSapiensClient, args: any) {
  const { domain, phoneNumber } = args;

  if (!domain || !phoneNumber) {
    throw new McpError(ErrorCode.InvalidParams, 'domain and phoneNumber parameters are required');
  }

  const result = await client.getPhoneNumber(domain, phoneNumber);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: result.success,
          message: result.success
            ? `Retrieved phone number details for ${phoneNumber}`
            : `Failed to get phone number: ${result.error}`,
          data: result.data,
          error: result.error
        }, null, 2),
      },
    ],
  };
}

async function handleGetCallQueues(client: NetSapiensClient, args: any) {
  const { domain } = args;

  if (!domain) {
    throw new McpError(ErrorCode.InvalidParams, 'domain parameter is required');
  }

  const result = await client.getCallQueues(domain);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: result.success,
          message: result.success
            ? `Retrieved ${result.data?.length || 0} call queues for domain ${domain}`
            : `Failed to get call queues: ${result.error}`,
          data: result.data,
          error: result.error
        }, null, 2),
      },
    ],
  };
}

async function handleGetCallQueue(client: NetSapiensClient, args: any) {
  const { domain, queueId } = args;

  if (!domain || !queueId) {
    throw new McpError(ErrorCode.InvalidParams, 'domain and queueId parameters are required');
  }

  const result = await client.getCallQueue(domain, queueId);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: result.success,
          message: result.success
            ? `Retrieved call queue details for ${queueId}`
            : `Failed to get call queue: ${result.error}`,
          data: result.data,
          error: result.error
        }, null, 2),
      },
    ],
  };
}

async function handleGetCallQueueAgents(client: NetSapiensClient, args: any) {
  const { domain, queueId } = args;

  if (!domain || !queueId) {
    throw new McpError(ErrorCode.InvalidParams, 'domain and queueId parameters are required');
  }

  const result = await client.getCallQueueAgents(domain, queueId);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: result.success,
          message: result.success
            ? `Retrieved ${result.data?.length || 0} agents for call queue ${queueId}`
            : `Failed to get call queue agents: ${result.error}`,
          data: result.data,
          error: result.error
        }, null, 2),
      },
    ],
  };
}

async function handleGetAgents(client: NetSapiensClient, args: any) {
  const { domain } = args;

  if (!domain) {
    throw new McpError(ErrorCode.InvalidParams, 'domain parameter is required');
  }

  const result = await client.getAgents(domain);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: result.success,
          message: result.success
            ? `Retrieved ${result.data?.length || 0} agents for domain ${domain}`
            : `Failed to get agents: ${result.error}`,
          data: result.data,
          error: result.error
        }, null, 2),
      },
    ],
  };
}

async function handleLoginAgent(client: NetSapiensClient, args: any) {
  const { domain, queueId, agentId } = args;

  if (!domain || !queueId || !agentId) {
    throw new McpError(ErrorCode.InvalidParams, 'domain, queueId, and agentId parameters are required');
  }

  const result = await client.loginAgent(domain, queueId, agentId);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: result.success,
          message: result.message || (result.success ? 'Agent logged in successfully' : 'Failed to login agent'),
          data: result.data,
          error: result.error
        }, null, 2),
      },
    ],
  };
}

async function handleLogoutAgent(client: NetSapiensClient, args: any) {
  const { domain, queueId, agentId } = args;

  if (!domain || !queueId || !agentId) {
    throw new McpError(ErrorCode.InvalidParams, 'domain, queueId, and agentId parameters are required');
  }

  const result = await client.logoutAgent(domain, queueId, agentId);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: result.success,
          message: result.message || (result.success ? 'Agent logged out successfully' : 'Failed to logout agent'),
          data: result.data,
          error: result.error
        }, null, 2),
      },
    ],
  };
}

async function handleGetAutoAttendants(client: NetSapiensClient, args: any) {
  const { domain } = args;

  if (!domain) {
    throw new McpError(ErrorCode.InvalidParams, 'domain parameter is required');
  }

  const result = await client.getAutoAttendants(domain);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: result.success,
          message: result.success
            ? `Retrieved ${result.data?.length || 0} auto attendants for domain ${domain}`
            : `Failed to get auto attendants: ${result.error}`,
          data: result.data,
          error: result.error
        }, null, 2),
      },
    ],
  };
}

async function handleGetUserAnswerRules(client: NetSapiensClient, args: any) {
  const { userId, domain } = args;

  if (!userId || !domain) {
    throw new McpError(ErrorCode.InvalidParams, 'userId and domain parameters are required');
  }

  const result = await client.getUserAnswerRules(userId, domain);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: result.success,
          message: result.success
            ? `Retrieved ${result.data?.length || 0} answer rules for user ${userId}@${domain}`
            : `Failed to get answer rules: ${result.error}`,
          data: result.data,
          error: result.error
        }, null, 2),
      },
    ],
  };
}

async function handleGetUserAnswerRule(client: NetSapiensClient, args: any) {
  const { userId, domain, timeframe } = args;

  if (!userId || !domain || !timeframe) {
    throw new McpError(ErrorCode.InvalidParams, 'userId, domain, and timeframe parameters are required');
  }

  const result = await client.getUserAnswerRule(userId, domain, timeframe);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: result.success,
          message: result.success
            ? `Retrieved answer rule for ${userId}@${domain} timeframe ${timeframe}`
            : `Failed to get answer rule: ${result.error}`,
          data: result.data,
          error: result.error
        }, null, 2),
      },
    ],
  };
}

async function handleGetUserGreetings(client: NetSapiensClient, args: any) {
  const { userId, domain } = args;

  if (!userId || !domain) {
    throw new McpError(ErrorCode.InvalidParams, 'userId and domain parameters are required');
  }

  const result = await client.getUserGreetings(userId, domain);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: result.success,
          message: result.success
            ? `Retrieved ${result.data?.length || 0} greetings for user ${userId}@${domain}`
            : `Failed to get user greetings: ${result.error}`,
          data: result.data,
          error: result.error
        }, null, 2),
      },
    ],
  };
}

async function handleGetUserVoicemails(client: NetSapiensClient, args: any) {
  const { userId, domain } = args;

  if (!userId || !domain) {
    throw new McpError(ErrorCode.InvalidParams, 'userId and domain parameters are required');
  }

  const result = await client.getUserVoicemails(userId, domain);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: result.success,
          message: result.success
            ? `Retrieved ${result.data?.length || 0} voicemails for user ${userId}@${domain}`
            : `Failed to get user voicemails: ${result.error}`,
          data: result.data,
          error: result.error
        }, null, 2),
      },
    ],
  };
}

async function handleGetMusicOnHold(client: NetSapiensClient, args: any) {
  const { domain } = args;

  if (!domain) {
    throw new McpError(ErrorCode.InvalidParams, 'domain parameter is required');
  }

  const result = await client.getMusicOnHold(domain);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: result.success,
          message: result.success
            ? `Retrieved ${result.data?.length || 0} music on hold files for domain ${domain}`
            : `Failed to get music on hold: ${result.error}`,
          data: result.data,
          error: result.error
        }, null, 2),
      },
    ],
  };
}

async function handleGetBilling(client: NetSapiensClient, args: any) {
  const { domain } = args;

  if (!domain) {
    throw new McpError(ErrorCode.InvalidParams, 'domain parameter is required');
  }

  const result = await client.getBilling(domain);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: result.success,
          message: result.success
            ? `Retrieved billing information for domain ${domain}`
            : `Failed to get billing information: ${result.error}`,
          data: result.data,
          error: result.error
        }, null, 2),
      },
    ],
  };
}

async function handleGetAgentStatistics(client: NetSapiensClient, args: any) {
  const { domain, agentId } = args;

  if (!domain) {
    throw new McpError(ErrorCode.InvalidParams, 'domain parameter is required');
  }

  const result = await client.getAgentStatistics(domain, agentId);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: result.success,
          message: result.success
            ? `Retrieved agent statistics for domain ${domain}${agentId ? ` (agent: ${agentId})` : ''}`
            : `Failed to get agent statistics: ${result.error}`,
          data: result.data,
          error: result.error
        }, null, 2),
      },
    ],
  };
}

async function handleTestConnection(client: NetSapiensClient, _args: any) {
  const result = await client.testConnection();

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: result.success,
          message: result.message || (result.success ? 'Connection successful' : 'Connection failed'),
          error: result.error
        }, null, 2),
      },
    ],
  };
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
      console.error('[MCP Error]', error);
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
      console.error('NetSapiens MCP Server started successfully');
      console.error(`NetSapiens API URL: ${config.netsapiens.apiUrl}`);
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
    console.error('[MCP Error]', error);
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
