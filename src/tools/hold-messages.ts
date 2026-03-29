import { NetSapiensClient } from '../netsapiens-client.js';

export const toolDefinitions = [
  {
    name: 'list_hold_messages',
    description: 'List hold messages at domain or user level',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID (optional, for user-level)' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'create_hold_message',
    description: 'Create a new hold message at domain or user level',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID (optional, for user-level)' },
        data: { type: 'object', description: 'Hold message data' },
      },
      required: ['domain', 'data'],
    },
  },
  {
    name: 'update_hold_message',
    description: 'Update a hold message at domain or user level',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID (optional, for user-level)' },
        index: { type: 'number', description: 'Hold message index' },
        data: { type: 'object', description: 'Updated hold message data' },
      },
      required: ['domain', 'index', 'data'],
    },
  },
  {
    name: 'delete_hold_message',
    description: 'Delete a hold message at domain or user level',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID (optional, for user-level)' },
        index: { type: 'number', description: 'Hold message index' },
      },
      required: ['domain', 'index'],
    },
  },
  {
    name: 'count_hold_messages',
    description: 'Count hold messages at domain or user level',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID (optional, for user-level)' },
      },
      required: ['domain'],
    },
  },
];

export async function handleToolCall(client: NetSapiensClient, toolName: string, args: any): Promise<any> {
  switch (toolName) {
    case 'list_hold_messages': {
      const result = args.userId
        ? await client.listUserHoldMessages(args.domain, args.userId)
        : await client.listDomainHoldMessages(args.domain);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Retrieved hold messages' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'create_hold_message': {
      const result = args.userId
        ? await client.createUserHoldMessage(args.domain, args.userId, args.data)
        : await client.createDomainHoldMessage(args.domain, args.data);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Hold message created' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'update_hold_message': {
      const result = args.userId
        ? await client.updateUserHoldMessage(args.domain, args.userId, args.index, args.data)
        : await client.updateDomainHoldMessage(args.domain, args.index, args.data);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Hold message ${args.index} updated` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'delete_hold_message': {
      const result = args.userId
        ? await client.deleteUserHoldMessage(args.domain, args.userId, args.index)
        : await client.deleteDomainHoldMessage(args.domain, args.index);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Hold message ${args.index} deleted` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'count_hold_messages': {
      const result = args.userId
        ? await client.countUserHoldMessages(args.domain, args.userId)
        : await client.countDomainHoldMessages(args.domain);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Counted hold messages' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    default:
      return null;
  }
}
