import { NetSapiensClient } from '../netsapiens-client.js';

export const toolDefinitions = [
  {
    name: 'list_timeframes',
    description: 'List timeframes at domain or user level',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID (optional, for user-level timeframes)' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'get_timeframe',
    description: 'Get a specific timeframe',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID (optional, for user-level)' },
        timeframeId: { type: 'string', description: 'Timeframe ID' },
      },
      required: ['domain', 'timeframeId'],
    },
  },
  {
    name: 'create_timeframe',
    description: 'Create a new timeframe (always, specific dates, days of week, holidays, or custom)',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID (optional, for user-level)' },
        type: { type: 'string', enum: ['always', 'specific_dates', 'days_of_week', 'holidays', 'custom'], description: 'Type of timeframe to create' },
        data: { type: 'object', description: 'Timeframe data (name, date ranges, days, holiday config, etc.)' },
      },
      required: ['domain', 'type', 'data'],
    },
  },
  {
    name: 'update_timeframe',
    description: 'Update a timeframe (replace, update entries, add entries, or convert type)',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID (optional, for user-level)' },
        timeframeId: { type: 'string', description: 'Timeframe ID' },
        operation: { type: 'string', enum: ['replace', 'update', 'add', 'convert'], description: 'Update operation type' },
        data: { type: 'object', description: 'Updated timeframe data' },
      },
      required: ['domain', 'timeframeId', 'operation', 'data'],
    },
  },
  {
    name: 'delete_timeframe',
    description: 'Delete a timeframe or specific entries within it',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID (optional, for user-level)' },
        timeframeId: { type: 'string', description: 'Timeframe ID' },
        entryType: { type: 'string', enum: ['timeframe', 'date_range', 'holiday', 'entry'], description: 'What to delete (default: entire timeframe)' },
      },
      required: ['domain', 'timeframeId'],
    },
  },
];

export async function handleToolCall(client: NetSapiensClient, toolName: string, args: any): Promise<any> {
  switch (toolName) {
    case 'list_timeframes': {
      const result = args.userId
        ? await client.listUserTimeframes(args.domain, args.userId)
        : await client.listTimeframes(args.domain);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Retrieved timeframes' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'get_timeframe': {
      const result = args.userId
        ? await client.getUserTimeframe(args.domain, args.userId, args.timeframeId)
        : await client.getTimeframe(args.domain, args.timeframeId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved timeframe ${args.timeframeId}` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'create_timeframe': {
      const result = args.userId
        ? await client.createUserTimeframe(args.domain, args.userId, { ...args.data, type: args.type })
        : await client.createTimeframe(args.domain, { ...args.data, type: args.type });
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Timeframe created (${args.type})` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'update_timeframe': {
      const result = args.userId
        ? await client.updateUserTimeframe(args.domain, args.userId, args.timeframeId, { ...args.data, operation: args.operation })
        : await client.updateTimeframe(args.domain, args.timeframeId, { ...args.data, operation: args.operation });
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Timeframe ${args.timeframeId} updated (${args.operation})` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'delete_timeframe': {
      const entryType = args.entryType || 'timeframe';
      const result = args.userId
        ? await client.deleteUserTimeframe(args.domain, args.userId, args.timeframeId)
        : await client.deleteTimeframe(args.domain, args.timeframeId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Timeframe ${entryType} deleted` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    default:
      return null;
  }
}
