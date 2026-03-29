import { NetSapiensClient } from '../netsapiens-client.js';

export const toolDefinitions = [
  {
    name: 'get_call_queues',
    description: 'Get call queues for a domain',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
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
        domain: { type: 'string', description: 'Domain name' },
        queueId: { type: 'string', description: 'Call queue ID' },
      },
      required: ['domain', 'queueId'],
    },
  },
  {
    name: 'create_call_queue',
    description: 'Create a new call queue in a domain',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        data: { type: 'object', description: 'Call queue configuration data' },
      },
      required: ['domain', 'data'],
    },
  },
  {
    name: 'update_call_queue',
    description: 'Update an existing call queue',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        queueId: { type: 'string', description: 'Call queue ID' },
        data: { type: 'object', description: 'Updated call queue data' },
      },
      required: ['domain', 'queueId', 'data'],
    },
  },
  {
    name: 'delete_call_queue',
    description: 'Delete a call queue',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        queueId: { type: 'string', description: 'Call queue ID' },
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
        domain: { type: 'string', description: 'Domain name' },
        queueId: { type: 'string', description: 'Call queue ID' },
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
        domain: { type: 'string', description: 'Domain name' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'manage_queue_agent',
    description: 'Manage agents in a call queue (get, add, update, remove)',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'add', 'update', 'remove'], description: 'Action to perform' },
        domain: { type: 'string', description: 'Domain name' },
        queueId: { type: 'string', description: 'Call queue ID' },
        agentId: { type: 'string', description: 'Agent ID (required for get/update/remove)' },
        data: { type: 'object', description: 'Agent data for add/update' },
      },
      required: ['action', 'domain', 'queueId'],
    },
  },
  {
    name: 'login_agent',
    description: 'Login an agent to a call queue',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        queueId: { type: 'string', description: 'Call queue ID' },
        agentId: { type: 'string', description: 'Agent ID' },
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
        domain: { type: 'string', description: 'Domain name' },
        queueId: { type: 'string', description: 'Call queue ID' },
        agentId: { type: 'string', description: 'Agent ID' },
      },
      required: ['domain', 'queueId', 'agentId'],
    },
  },
  {
    name: 'agent_single_call',
    description: 'Set agent to single-call (one-call) mode in a call queue',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        queueId: { type: 'string', description: 'Call queue ID' },
        agentId: { type: 'string', description: 'Agent ID' },
      },
      required: ['domain', 'queueId', 'agentId'],
    },
  },
  {
    name: 'set_agent_status',
    description: 'Set agent offline status across all queues',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        agentId: { type: 'string', description: 'Agent ID' },
        status: { type: 'string', description: 'Status to set' },
      },
      required: ['domain', 'agentId', 'status'],
    },
  },
  {
    name: 'get_queue_agent_count',
    description: 'Count agents in a call queue',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        queueId: { type: 'string', description: 'Call queue ID' },
      },
      required: ['domain', 'queueId'],
    },
  },
];

export async function handleToolCall(client: NetSapiensClient, toolName: string, args: any): Promise<any> {
  switch (toolName) {
    case 'get_call_queues': {
      const result = await client.getCallQueues(args.domain);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved ${result.data?.length || 0} call queues for domain ${args.domain}` : `Failed to get call queues: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'get_call_queue': {
      const result = await client.getCallQueue(args.domain, args.queueId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved call queue details for ${args.queueId}` : `Failed to get call queue: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'create_call_queue': {
      const result = await client.createCallQueue(args.domain, args.data);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Call queue created' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'update_call_queue': {
      const result = await client.updateCallQueue(args.domain, args.queueId, args.data);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Call queue ${args.queueId} updated` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'delete_call_queue': {
      const result = await client.deleteCallQueue(args.domain, args.queueId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Call queue ${args.queueId} deleted` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'get_call_queue_agents': {
      const result = await client.getCallQueueAgents(args.domain, args.queueId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved ${result.data?.length || 0} agents for call queue ${args.queueId}` : `Failed to get call queue agents: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'get_agents': {
      const result = await client.getAgents(args.domain);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved ${result.data?.length || 0} agents for domain ${args.domain}` : `Failed to get agents: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'manage_queue_agent': {
      let result;
      switch (args.action) {
        case 'get': result = await client.getQueueAgent(args.domain, args.queueId, args.agentId); break;
        case 'add': result = await client.addQueueAgent(args.domain, args.queueId, args.data); break;
        case 'update': result = await client.updateQueueAgent(args.domain, args.queueId, args.agentId, args.data); break;
        case 'remove': result = await client.removeQueueAgent(args.domain, args.queueId, args.agentId); break;
        default: return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Unknown action: ${args.action}` }, null, 2) }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Queue agent ${args.action} successful` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'login_agent': {
      const result = await client.loginAgent(args.domain, args.queueId, args.agentId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.message || (result.success ? 'Agent logged in successfully' : 'Failed to login agent'), data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'logout_agent': {
      const result = await client.logoutAgent(args.domain, args.queueId, args.agentId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.message || (result.success ? 'Agent logged out successfully' : 'Failed to logout agent'), data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'agent_single_call': {
      const result = await client.agentSingleCall(args.domain, args.queueId, args.agentId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Agent set to single-call mode' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'set_agent_status': {
      const result = await client.setAgentStatus(args.domain, args.agentId, args.status);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Agent status set to ${args.status}` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'get_queue_agent_count': {
      const result = await client.countQueueAgents(args.domain, args.queueId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Counted agents in queue ${args.queueId}` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    default:
      return null;
  }
}
