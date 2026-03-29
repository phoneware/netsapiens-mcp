import { NetSapiensClient } from '../netsapiens-client.js';

export const toolDefinitions = [
  {
    name: 'get_music_on_hold',
    description: 'Get music on hold files for a domain or user',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID (optional, for user-level MOH)' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'create_music_on_hold',
    description: 'Create music on hold from TTS (text-to-speech) at domain or user level',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID (optional, for user-level)' },
        data: { type: 'object', description: 'MOH data including TTS text, voice, language' },
      },
      required: ['domain', 'data'],
    },
  },
  {
    name: 'update_music_on_hold',
    description: 'Update music on hold at domain or user level',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID (optional, for user-level)' },
        index: { type: 'number', description: 'MOH index' },
        data: { type: 'object', description: 'Updated MOH data' },
      },
      required: ['domain', 'index', 'data'],
    },
  },
  {
    name: 'delete_music_on_hold',
    description: 'Delete music on hold at domain or user level',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID (optional, for user-level)' },
        index: { type: 'number', description: 'MOH index to delete' },
      },
      required: ['domain', 'index'],
    },
  },
  {
    name: 'count_music_on_hold',
    description: 'Count music on hold files at domain or user level',
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
    case 'get_music_on_hold': {
      const result = args.userId
        ? await client.getUserMusicOnHold(args.domain, args.userId)
        : await client.getMusicOnHold(args.domain);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved ${result.data?.length || 0} music on hold files for domain ${args.domain}` : `Failed to get music on hold: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'create_music_on_hold': {
      const result = args.userId
        ? await client.createUserMusicOnHold(args.domain, args.userId, args.data)
        : await client.createMusicOnHold(args.domain, args.data);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Music on hold created' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'update_music_on_hold': {
      const result = args.userId
        ? await client.updateUserMusicOnHold(args.domain, args.userId, args.index, args.data)
        : await client.updateMusicOnHold(args.domain, args.index, args.data);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Music on hold ${args.index} updated` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'delete_music_on_hold': {
      const result = args.userId
        ? await client.deleteUserMusicOnHold(args.domain, args.userId, args.index)
        : await client.deleteMusicOnHold(args.domain, args.index);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Music on hold ${args.index} deleted` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'count_music_on_hold': {
      const result = args.userId
        ? await client.countUserMusicOnHold(args.domain, args.userId)
        : await client.countMusicOnHold(args.domain);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Counted music on hold' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    default:
      return null;
  }
}
