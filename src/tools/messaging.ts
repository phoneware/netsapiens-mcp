import { NetSapiensClient } from '../netsapiens-client.js';

export const toolDefinitions = [
  {
    name: 'list_message_sessions',
    description: 'List message sessions at domain or user level',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID (optional, for user-level sessions)' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'get_message_session',
    description: 'Get details of a specific message session',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
        sessionId: { type: 'string', description: 'Message session ID' },
      },
      required: ['domain', 'userId', 'sessionId'],
    },
  },
  {
    name: 'create_message_session',
    description: 'Start a new message session',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
        data: { type: 'object', description: 'Message session data (participants, initial message)' },
      },
      required: ['domain', 'userId', 'data'],
    },
  },
  {
    name: 'update_message_session',
    description: 'Update a message session (participants, name, or leave)',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
        sessionId: { type: 'string', description: 'Message session ID' },
        operation: { type: 'string', enum: ['participants', 'name', 'leave'], description: 'What to update' },
        data: { type: 'object', description: 'Update data' },
      },
      required: ['domain', 'userId', 'sessionId', 'operation'],
    },
  },
  {
    name: 'delete_message_session',
    description: 'Delete a message session',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
        sessionId: { type: 'string', description: 'Message session ID' },
      },
      required: ['domain', 'userId', 'sessionId'],
    },
  },
  {
    name: 'get_messages',
    description: 'Get messages from a message session',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
        sessionId: { type: 'string', description: 'Message session ID' },
      },
      required: ['domain', 'userId', 'sessionId'],
    },
  },
  {
    name: 'send_message',
    description: 'Send a message in a session (chat, group chat, SMS, group SMS, or MMS)',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
        sessionId: { type: 'string', description: 'Message session ID' },
        type: { type: 'string', enum: ['chat', 'group_chat', 'media', 'sms', 'group_sms', 'mms'], description: 'Message type' },
        data: { type: 'object', description: 'Message data (text content, media, recipients)' },
      },
      required: ['domain', 'userId', 'sessionId', 'type', 'data'],
    },
  },
  {
    name: 'manage_sms_numbers',
    description: 'Manage SMS numbers (list, create, update, delete) at domain or user level',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'update', 'delete', 'list_system', 'count_user'], description: 'Action to perform' },
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID (for user-level SMS numbers)' },
        smsNumber: { type: 'string', description: 'SMS number (for update/delete)' },
        data: { type: 'object', description: 'SMS number data for create/update' },
      },
      required: ['action'],
    },
  },
  {
    name: 'manage_sms_blocks',
    description: 'Manage SMS blocks (list, add, update, delete) at domain or system level',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'update', 'delete', 'list_system'], description: 'Action to perform' },
        domain: { type: 'string', description: 'Domain name (for domain-level, omit for system)' },
        blockId: { type: 'string', description: 'Block ID (for update/delete)' },
        data: { type: 'object', description: 'Block data for add/update' },
      },
      required: ['action'],
    },
  },
];

export async function handleToolCall(client: NetSapiensClient, toolName: string, args: any): Promise<any> {
  switch (toolName) {
    case 'list_message_sessions': {
      const result = args.userId
        ? await client.listUserMessageSessions(args.domain, args.userId)
        : await client.listDomainMessageSessions(args.domain);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Retrieved message sessions' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'get_message_session': {
      const result = await client.getMessageSession(args.domain, args.userId, args.sessionId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved session ${args.sessionId}` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'create_message_session': {
      const result = await client.createMessageSession(args.domain, args.userId, args.data);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Message session created' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'update_message_session': {
      const result = await client.updateMessageSession(args.domain, args.userId, args.sessionId, { ...args.data, operation: args.operation });
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Session updated (${args.operation})` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'delete_message_session': {
      const result = await client.deleteMessageSession(args.domain, args.userId, args.sessionId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Session deleted' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'get_messages': {
      const result = await client.getMessages(args.domain, args.userId, args.sessionId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Retrieved messages' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'send_message': {
      const result = await client.sendMessage(args.domain, args.userId, args.sessionId, { ...args.data, type: args.type });
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Message sent (${args.type})` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'manage_sms_numbers': {
      let result;
      switch (args.action) {
        case 'list': result = await client.listSmsNumbers(args.domain); break;
        case 'create': result = await client.createSmsNumber(args.domain, args.data); break;
        case 'update': result = await client.updateSmsNumber(args.domain, args.smsNumber, args.data); break;
        case 'delete': result = await client.deleteSmsNumber(args.domain, args.smsNumber); break;
        case 'list_system': result = await client.listSystemSmsNumbers(); break;
        case 'count_user': result = await client.countUserSmsNumbers(args.domain, args.userId); break;
        default: return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Unknown action: ${args.action}` }, null, 2) }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `SMS numbers ${args.action} successful` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'manage_sms_blocks': {
      let result;
      switch (args.action) {
        case 'list': result = await client.listSmsBlocks(args.domain); break;
        case 'add': result = await client.addSmsBlock(args.domain, args.data); break;
        case 'update': result = await client.updateSmsBlock(args.domain, args.blockId, args.data); break;
        case 'delete': result = await client.deleteSmsBlock(args.domain, args.blockId); break;
        case 'list_system': result = await client.listSystemSmsBlocks(); break;
        default: return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Unknown action: ${args.action}` }, null, 2) }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `SMS blocks ${args.action} successful` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    default:
      return null;
  }
}
