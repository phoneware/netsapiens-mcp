import { NetSapiensClient } from '../netsapiens-client.js';

export const toolDefinitions = [
  {
    name: 'list_blocked_numbers',
    description: 'List blocked numbers for a domain or user',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID (optional, for user-level filters)' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'add_blocked_numbers',
    description: 'Add blocked numbers for a domain or user',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID (optional, for user-level filters)' },
        data: { type: 'object', description: 'Number filter data (numbers to block)' },
      },
      required: ['domain', 'data'],
    },
  },
  {
    name: 'delete_blocked_numbers',
    description: 'Delete blocked numbers for a domain or user',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID (optional, for user-level filters)' },
        data: { type: 'object', description: 'Number filter data (numbers to unblock)' },
      },
      required: ['domain'],
    },
  },
];

export async function handleToolCall(client: NetSapiensClient, toolName: string, args: any): Promise<any> {
  switch (toolName) {
    case 'list_blocked_numbers': {
      const result = args.userId
        ? await client.listUserBlockedNumbers(args.domain, args.userId)
        : await client.listDomainBlockedNumbers(args.domain);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Retrieved blocked numbers' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'add_blocked_numbers': {
      const result = args.userId
        ? await client.addUserBlockedNumbers(args.domain, args.userId, args.data)
        : await client.addDomainBlockedNumbers(args.domain, args.data);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Blocked numbers added' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'delete_blocked_numbers': {
      const result = args.userId
        ? await client.deleteUserBlockedNumbers(args.domain, args.userId, args.data)
        : await client.deleteDomainBlockedNumbers(args.domain, args.data);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Blocked numbers deleted' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    default:
      return null;
  }
}
