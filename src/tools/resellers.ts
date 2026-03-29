import { NetSapiensClient } from '../netsapiens-client.js';

export const toolDefinitions = [
  {
    name: 'list_resellers',
    description: 'Get list of resellers in the NetSapiens system',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum number of results' },
        offset: { type: 'number', description: 'Offset for pagination' },
      },
    },
  },
  {
    name: 'get_reseller',
    description: 'Get detailed information about a specific reseller',
    inputSchema: {
      type: 'object',
      properties: {
        reseller: { type: 'string', description: 'Reseller identifier' },
      },
      required: ['reseller'],
    },
  },
  {
    name: 'create_reseller',
    description: 'Create a new reseller',
    inputSchema: {
      type: 'object',
      properties: {
        data: { type: 'object', description: 'Reseller data including name, description, and configuration' },
      },
      required: ['data'],
    },
  },
  {
    name: 'update_reseller',
    description: 'Update an existing reseller',
    inputSchema: {
      type: 'object',
      properties: {
        reseller: { type: 'string', description: 'Reseller identifier' },
        data: { type: 'object', description: 'Updated reseller data' },
      },
      required: ['reseller', 'data'],
    },
  },
  {
    name: 'delete_reseller',
    description: 'Delete a reseller',
    inputSchema: {
      type: 'object',
      properties: {
        reseller: { type: 'string', description: 'Reseller identifier' },
      },
      required: ['reseller'],
    },
  },
  {
    name: 'get_reseller_stats',
    description: 'Get reseller statistics (device count, quotas, schedule count)',
    inputSchema: {
      type: 'object',
      properties: {
        reseller: { type: 'string', description: 'Reseller identifier' },
        stat: { type: 'string', enum: ['devices_count', 'quotas', 'quotas_count', 'schedule_count', 'count'], description: 'Statistic to retrieve' },
      },
      required: ['reseller', 'stat'],
    },
  },
];

export async function handleToolCall(client: NetSapiensClient, toolName: string, args: any): Promise<any> {
  switch (toolName) {
    case 'list_resellers': {
      const result = await client.listResellers(args.limit, args.offset);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved resellers` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'get_reseller': {
      const result = await client.getReseller(args.reseller);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved reseller ${args.reseller}` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'create_reseller': {
      const result = await client.createReseller(args.data);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Reseller created' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'update_reseller': {
      const result = await client.updateReseller(args.reseller, args.data);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Reseller ${args.reseller} updated` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'delete_reseller': {
      const result = await client.deleteReseller(args.reseller);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Reseller ${args.reseller} deleted` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'get_reseller_stats': {
      const result = await client.getResellerStats(args.reseller, args.stat);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved ${args.stat} for reseller ${args.reseller}` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    default:
      return null;
  }
}
