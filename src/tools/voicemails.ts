import { NetSapiensClient } from '../netsapiens-client.js';

export const toolDefinitions = [
  {
    name: 'get_user_voicemails',
    description: 'Get voicemails for a user, optionally filtered by folder',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'User ID' },
        domain: { type: 'string', description: 'Domain name' },
        folder: { type: 'string', description: 'Voicemail folder (e.g., new, saved, trash)' },
      },
      required: ['userId', 'domain'],
    },
  },
  {
    name: 'get_voicemail',
    description: 'Get a specific voicemail',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
        folder: { type: 'string', description: 'Voicemail folder' },
        filename: { type: 'string', description: 'Voicemail filename' },
      },
      required: ['domain', 'userId', 'folder', 'filename'],
    },
  },
  {
    name: 'delete_voicemail',
    description: 'Delete a voicemail',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
        folder: { type: 'string', description: 'Voicemail folder' },
        filename: { type: 'string', description: 'Voicemail filename' },
      },
      required: ['domain', 'userId', 'folder', 'filename'],
    },
  },
  {
    name: 'forward_voicemail',
    description: 'Forward a voicemail to another user',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
        folder: { type: 'string', description: 'Voicemail folder' },
        filename: { type: 'string', description: 'Voicemail filename' },
        toUser: { type: 'string', description: 'Recipient user ID' },
      },
      required: ['domain', 'userId', 'folder', 'filename', 'toUser'],
    },
  },
  {
    name: 'save_voicemail',
    description: 'Move a voicemail to the saved folder',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
        folder: { type: 'string', description: 'Current voicemail folder' },
        filename: { type: 'string', description: 'Voicemail filename' },
      },
      required: ['domain', 'userId', 'folder', 'filename'],
    },
  },
  {
    name: 'count_voicemails',
    description: 'Count voicemails for a user in a specific folder',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
        folder: { type: 'string', description: 'Voicemail folder' },
      },
      required: ['domain', 'userId', 'folder'],
    },
  },
  {
    name: 'manage_voicemail_reminders',
    description: 'Manage voicemail reminders for a user (list, create, update, delete, count)',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'update', 'delete', 'count'], description: 'Action to perform' },
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
        data: { type: 'object', description: 'Reminder data for create/update' },
      },
      required: ['action', 'domain', 'userId'],
    },
  },
];

export async function handleToolCall(client: NetSapiensClient, toolName: string, args: any): Promise<any> {
  switch (toolName) {
    case 'get_user_voicemails': {
      const result = args.folder
        ? await client.getUserVoicemailsByFolder(args.domain, args.userId, args.folder)
        : await client.getUserVoicemails(args.userId, args.domain);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved ${result.data?.length || 0} voicemails for user ${args.userId}@${args.domain}` : `Failed to get user voicemails: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'get_voicemail': {
      const result = await client.getVoicemail(args.domain, args.userId, args.folder, args.filename);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved voicemail` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'delete_voicemail': {
      const result = await client.deleteVoicemail(args.domain, args.userId, args.folder, args.filename);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Voicemail deleted' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'forward_voicemail': {
      const result = await client.forwardVoicemail(args.domain, args.userId, args.folder, args.filename, args.toUser);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Voicemail forwarded to ${args.toUser}` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'save_voicemail': {
      const result = await client.saveVoicemail(args.domain, args.userId, args.folder, args.filename);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Voicemail saved' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'count_voicemails': {
      const result = await client.countVoicemails(args.domain, args.userId, args.folder);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Counted voicemails' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'manage_voicemail_reminders': {
      let result;
      switch (args.action) {
        case 'list': result = await client.listVoicemailReminders(args.domain, args.userId); break;
        case 'create': result = await client.createVoicemailReminder(args.domain, args.userId, args.data); break;
        case 'update': result = await client.updateVoicemailReminders(args.domain, args.userId, args.data); break;
        case 'delete': result = await client.deleteVoicemailReminders(args.domain, args.userId); break;
        case 'count': result = await client.countVoicemailReminders(args.domain, args.userId); break;
        default: return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Unknown action: ${args.action}` }, null, 2) }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Voicemail reminder ${args.action} successful` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    default:
      return null;
  }
}
