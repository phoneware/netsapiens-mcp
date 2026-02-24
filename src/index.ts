#!/usr/bin/env node

/**
 * OITVOIP MCP Server
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
import { createApiClient, GenericApiClient } from './netsapiens-client.js';
import { MCPServerConfig } from './types/config.js';

// Configuration - these would typically come from environment variables
const getConfig = (): MCPServerConfig => {
  const apiToken = process.env.NETSAPIENS_API_TOKEN;
  if (!apiToken) {
    throw new Error('NETSAPIENS_API_TOKEN environment variable is required');
  }
  
  return {
    name: 'oitvoip-mcp-server',
    version: '1.0.0',
    netsapiens: {
      apiUrl: process.env.NETSAPIENS_API_URL || 'https://api.ucaasnetwork.com',
      apiToken: apiToken,
      timeout: 30000,
      rateLimit: {
        requests: 100,
        perMilliseconds: 60000 // 100 requests per minute
      }
    },
    debug: process.env.DEBUG === 'true'
  };
};

const config: MCPServerConfig = getConfig();

class OITVOIPMCPServer {
  private server: Server;
  private apiClient: GenericApiClient;

  constructor() {
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

    this.apiClient = createApiClient(config.netsapiens, async () => config.netsapiens.apiToken);
    this.setupToolHandlers();
    this.setupErrorHandling();
  }

  private setupToolHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
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
        ],
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'search_users':
            return await this.handleSearchUsers(args);
          case 'get_user':
            return await this.handleGetUser(args);
          case 'get_cdr_records':
            return await this.handleGetCDRRecords(args);
          case 'get_domains':
            return await this.handleGetDomains(args);
          case 'get_domain':
            return await this.handleGetDomain(args);
          case 'get_user_devices':
            return await this.handleGetUserDevices(args);
          case 'get_phone_numbers':
            return await this.handleGetPhoneNumbers(args);
          case 'get_phone_number':
            return await this.handleGetPhoneNumber(args);
          case 'get_call_queues':
            return await this.handleGetCallQueues(args);
          case 'get_call_queue':
            return await this.handleGetCallQueue(args);
          case 'get_call_queue_agents':
            return await this.handleGetCallQueueAgents(args);
          case 'get_agents':
            return await this.handleGetAgents(args);
          case 'login_agent':
            return await this.handleLoginAgent(args);
          case 'logout_agent':
            return await this.handleLogoutAgent(args);
          case 'get_auto_attendants':
            return await this.handleGetAutoAttendants(args);
          case 'get_user_answer_rules':
            return await this.handleGetUserAnswerRules(args);
          case 'get_user_answer_rule':
            return await this.handleGetUserAnswerRule(args);
          case 'get_user_greetings':
            return await this.handleGetUserGreetings(args);
          case 'get_user_voicemails':
            return await this.handleGetUserVoicemails(args);
          case 'get_music_on_hold':
            return await this.handleGetMusicOnHold(args);
          case 'get_billing':
            return await this.handleGetBilling(args);
          case 'get_agent_statistics':
            return await this.handleGetAgentStatistics(args);
          case 'test_connection':
            return await this.handleTestConnection(args);
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

  private formatResult(result: any) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  private async handleSearchUsers(args: any) {
    const { query, domain, limit = 20 } = args;
    if (!query) {
      throw new McpError(ErrorCode.InvalidParams, 'Query parameter is required');
    }
    const endpoint = domain ? `/domains/${domain}/users` : '/domains/~/users/~';
    const result = await this.apiClient.request({ method: 'GET', pathTemplate: endpoint, queryParams: { user: query, limit } });
    return this.formatResult(result);
  }

  private async handleGetUser(args: any) {
    const { userId, domain } = args;
    if (!userId || !domain) {
      throw new McpError(ErrorCode.InvalidParams, 'userId and domain parameters are required');
    }
    const result = await this.apiClient.request({ method: 'GET', pathTemplate: '/domains/{domain}/users/{userId}', pathParams: { domain, userId } });
    return this.formatResult(result);
  }

  private async handleGetCDRRecords(args: any) {
    const { startDate, endDate, user, domain, limit = 100 } = args;
    let pathTemplate = '/cdrs';
    const pathParams: Record<string, string> = {};
    if (user && domain) {
      pathTemplate = '/domains/{domain}/users/{user}/cdrs';
      pathParams.domain = domain;
      pathParams.user = user;
    } else if (domain) {
      pathTemplate = '/domains/{domain}/cdrs';
      pathParams.domain = domain;
    }
    const result = await this.apiClient.request({ method: 'GET', pathTemplate, pathParams, queryParams: { start_time: startDate, end_time: endDate, limit } });
    return this.formatResult(result);
  }

  private async handleGetDomains(_args: any) {
    const result = await this.apiClient.request({ method: 'GET', pathTemplate: '/domains' });
    return this.formatResult(result);
  }

  private async handleGetDomain(args: any) {
    const { domain } = args;
    if (!domain) {
      throw new McpError(ErrorCode.InvalidParams, 'domain parameter is required');
    }
    const result = await this.apiClient.request({ method: 'GET', pathTemplate: '/domains/{domain}', pathParams: { domain } });
    return this.formatResult(result);
  }

  private async handleGetUserDevices(args: any) {
    const { userId, domain } = args;
    if (!userId || !domain) {
      throw new McpError(ErrorCode.InvalidParams, 'userId and domain parameters are required');
    }
    const result = await this.apiClient.request({ method: 'GET', pathTemplate: '/domains/{domain}/users/{userId}/devices', pathParams: { domain, userId } });
    return this.formatResult(result);
  }

  private async handleGetPhoneNumbers(args: any) {
    const { domain, limit } = args;
    if (!domain) {
      throw new McpError(ErrorCode.InvalidParams, 'domain parameter is required');
    }
    const result = await this.apiClient.request({ method: 'GET', pathTemplate: '/domains/{domain}/phonenumbers', pathParams: { domain }, queryParams: { limit } });
    return this.formatResult(result);
  }

  private async handleGetPhoneNumber(args: any) {
    const { domain, phoneNumber } = args;
    if (!domain || !phoneNumber) {
      throw new McpError(ErrorCode.InvalidParams, 'domain and phoneNumber parameters are required');
    }
    const result = await this.apiClient.request({ method: 'GET', pathTemplate: '/domains/{domain}/phonenumbers/{phoneNumber}', pathParams: { domain, phoneNumber } });
    return this.formatResult(result);
  }

  private async handleGetCallQueues(args: any) {
    const { domain } = args;
    if (!domain) {
      throw new McpError(ErrorCode.InvalidParams, 'domain parameter is required');
    }
    const result = await this.apiClient.request({ method: 'GET', pathTemplate: '/domains/{domain}/callqueues', pathParams: { domain } });
    return this.formatResult(result);
  }

  private async handleGetCallQueue(args: any) {
    const { domain, queueId } = args;
    if (!domain || !queueId) {
      throw new McpError(ErrorCode.InvalidParams, 'domain and queueId parameters are required');
    }
    const result = await this.apiClient.request({ method: 'GET', pathTemplate: '/domains/{domain}/callqueues/{queueId}', pathParams: { domain, queueId } });
    return this.formatResult(result);
  }

  private async handleGetCallQueueAgents(args: any) {
    const { domain, queueId } = args;
    if (!domain || !queueId) {
      throw new McpError(ErrorCode.InvalidParams, 'domain and queueId parameters are required');
    }
    const result = await this.apiClient.request({ method: 'GET', pathTemplate: '/domains/{domain}/callqueues/{queueId}/agents', pathParams: { domain, queueId } });
    return this.formatResult(result);
  }

  private async handleGetAgents(args: any) {
    const { domain } = args;
    if (!domain) {
      throw new McpError(ErrorCode.InvalidParams, 'domain parameter is required');
    }
    const result = await this.apiClient.request({ method: 'GET', pathTemplate: '/domains/{domain}/agents', pathParams: { domain } });
    return this.formatResult(result);
  }

  private async handleLoginAgent(args: any) {
    const { domain, queueId, agentId } = args;
    if (!domain || !queueId || !agentId) {
      throw new McpError(ErrorCode.InvalidParams, 'domain, queueId, and agentId parameters are required');
    }
    const result = await this.apiClient.request({ method: 'POST', pathTemplate: '/domains/{domain}/callqueues/{queueId}/agents/{agentId}/login', pathParams: { domain, queueId, agentId } });
    return this.formatResult(result);
  }

  private async handleLogoutAgent(args: any) {
    const { domain, queueId, agentId } = args;
    if (!domain || !queueId || !agentId) {
      throw new McpError(ErrorCode.InvalidParams, 'domain, queueId, and agentId parameters are required');
    }
    const result = await this.apiClient.request({ method: 'POST', pathTemplate: '/domains/{domain}/callqueues/{queueId}/agents/{agentId}/logout', pathParams: { domain, queueId, agentId } });
    return this.formatResult(result);
  }

  private async handleGetAutoAttendants(args: any) {
    const { domain } = args;
    if (!domain) {
      throw new McpError(ErrorCode.InvalidParams, 'domain parameter is required');
    }
    const result = await this.apiClient.request({ method: 'GET', pathTemplate: '/domains/{domain}/autoattendants', pathParams: { domain } });
    return this.formatResult(result);
  }

  private async handleGetUserAnswerRules(args: any) {
    const { userId, domain } = args;
    if (!userId || !domain) {
      throw new McpError(ErrorCode.InvalidParams, 'userId and domain parameters are required');
    }
    const result = await this.apiClient.request({ method: 'GET', pathTemplate: '/domains/{domain}/users/{userId}/answerrules', pathParams: { domain, userId } });
    return this.formatResult(result);
  }

  private async handleGetUserAnswerRule(args: any) {
    const { userId, domain, timeframe } = args;
    if (!userId || !domain || !timeframe) {
      throw new McpError(ErrorCode.InvalidParams, 'userId, domain, and timeframe parameters are required');
    }
    const result = await this.apiClient.request({ method: 'GET', pathTemplate: '/domains/{domain}/users/{userId}/answerrules/{timeframe}', pathParams: { domain, userId, timeframe } });
    return this.formatResult(result);
  }

  private async handleGetUserGreetings(args: any) {
    const { userId, domain } = args;
    if (!userId || !domain) {
      throw new McpError(ErrorCode.InvalidParams, 'userId and domain parameters are required');
    }
    const result = await this.apiClient.request({ method: 'GET', pathTemplate: '/domains/{domain}/users/{userId}/greetings', pathParams: { domain, userId } });
    return this.formatResult(result);
  }

  private async handleGetUserVoicemails(args: any) {
    const { userId, domain } = args;
    if (!userId || !domain) {
      throw new McpError(ErrorCode.InvalidParams, 'userId and domain parameters are required');
    }
    const result = await this.apiClient.request({ method: 'GET', pathTemplate: '/domains/{domain}/users/{userId}/voicemail', pathParams: { domain, userId } });
    return this.formatResult(result);
  }

  private async handleGetMusicOnHold(args: any) {
    const { domain } = args;
    if (!domain) {
      throw new McpError(ErrorCode.InvalidParams, 'domain parameter is required');
    }
    const result = await this.apiClient.request({ method: 'GET', pathTemplate: '/domains/{domain}/moh', pathParams: { domain } });
    return this.formatResult(result);
  }

  private async handleGetBilling(args: any) {
    const { domain } = args;
    if (!domain) {
      throw new McpError(ErrorCode.InvalidParams, 'domain parameter is required');
    }
    const result = await this.apiClient.request({ method: 'GET', pathTemplate: '/domains/{domain}/billing', pathParams: { domain } });
    return this.formatResult(result);
  }

  private async handleGetAgentStatistics(args: any) {
    const { domain, agentId } = args;
    if (!domain) {
      throw new McpError(ErrorCode.InvalidParams, 'domain parameter is required');
    }
    const pathTemplate = agentId
      ? '/domains/{domain}/statistics/agent/{agentId}'
      : '/domains/{domain}/statistics/agent';
    const pathParams: Record<string, string> = { domain };
    if (agentId) pathParams.agentId = agentId;
    const result = await this.apiClient.request({ method: 'GET', pathTemplate, pathParams });
    return this.formatResult(result);
  }

  private async handleTestConnection(_args: any) {
    const result = await this.apiClient.request({ method: 'GET', pathTemplate: '/domains', queryParams: { limit: 1 } });
    return this.formatResult(result);
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
    
    if (config.debug) {
      console.error('OITVOIP MCP Server started successfully');
      console.error(`NetSapiens API URL: ${config.netsapiens.apiUrl}`);
    }
  }
}

// Start the server
const server = new OITVOIPMCPServer();
server.run().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});