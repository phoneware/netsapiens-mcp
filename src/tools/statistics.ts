import { NetSapiensClient } from '../netsapiens-client.js';

export const toolDefinitions = [
  {
    name: 'get_agent_statistics',
    description: 'Get agent statistics for a domain (all queues, per queue, or specific agent)',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        agentId: { type: 'string', description: 'Specific agent ID (optional)' },
        queueId: { type: 'string', description: 'Specific call queue ID (optional)' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'get_queue_statistics',
    description: 'Get call queue statistics (aggregate, per-queue, or specific queue)',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        type: { type: 'string', enum: ['aggregate', 'per_queue', 'specific'], description: 'Statistics type' },
        queueId: { type: 'string', description: 'Call queue ID (required for specific type)' },
      },
      required: ['domain', 'type'],
    },
  },
  {
    name: 'get_dnis_statistics',
    description: 'Get DNIS statistics for all queues or a specific queue',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        queueId: { type: 'string', description: 'Call queue ID (optional, for specific queue)' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'get_agent_log',
    description: 'Get agent log for a domain',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'get_abandoned_calls',
    description: 'Get abandoned calls for all queues or a specific queue',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        queueId: { type: 'string', description: 'Call queue ID (optional, for specific queue)' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'get_queued_calls',
    description: 'Read or add queued calls for a queue',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'add'], description: 'Action to perform' },
        domain: { type: 'string', description: 'Domain name' },
        queueId: { type: 'string', description: 'Call queue ID' },
        data: { type: 'object', description: 'Call data for add action' },
      },
      required: ['action', 'domain', 'queueId'],
    },
  },
];

export async function handleToolCall(client: NetSapiensClient, toolName: string, args: any): Promise<any> {
  switch (toolName) {
    case 'get_agent_statistics': {
      const result = args.agentId
        ? await client.getAgentStatistics(args.domain, args.agentId)
        : args.queueId
          ? await client.getAgentStatisticsForQueue(args.domain, args.queueId)
          : await client.getAgentStatistics(args.domain);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved agent statistics for domain ${args.domain}${args.agentId ? ` (agent: ${args.agentId})` : ''}${args.queueId ? ` (queue: ${args.queueId})` : ''}` : `Failed to get agent statistics: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'get_queue_statistics': {
      let result;
      switch (args.type) {
        case 'aggregate': result = await client.getQueueStatisticsAggregate(args.domain); break;
        case 'per_queue': result = await client.getQueueStatisticsPerQueue(args.domain); break;
        case 'specific': result = await client.getQueueStatistics(args.domain, args.queueId); break;
        default: return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Unknown type: ${args.type}` }, null, 2) }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved queue statistics (${args.type})` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'get_dnis_statistics': {
      const result = args.queueId
        ? await client.getDnisStatisticsForQueue(args.domain, args.queueId)
        : await client.getDnisStatistics(args.domain);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Retrieved DNIS statistics' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'get_agent_log': {
      const result = await client.getAgentLog(args.domain);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Retrieved agent log' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'get_abandoned_calls': {
      const result = args.queueId
        ? await client.getAbandonedCallsForQueue(args.domain, args.queueId)
        : await client.getAbandonedCalls(args.domain);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Retrieved abandoned calls' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'get_queued_calls': {
      const result = args.action === 'add'
        ? await client.addQueuedCall(args.domain, args.queueId, args.data)
        : await client.getQueuedCalls(args.domain, args.queueId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Queued calls ${args.action} successful` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    default:
      return null;
  }
}
