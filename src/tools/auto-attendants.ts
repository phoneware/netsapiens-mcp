import { NetSapiensClient } from '../netsapiens-client.js';

export const toolDefinitions = [
  {
    name: 'get_auto_attendants',
    description: 'Get auto attendants for a domain',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'create_auto_attendant',
    description: 'Create a new auto attendant in a domain',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        data: { type: 'object', description: 'Auto attendant configuration data' },
      },
      required: ['domain', 'data'],
    },
  },
  {
    name: 'get_user_auto_attendant',
    description: 'Get a specific auto attendant for a user',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
        prompt: { type: 'string', description: 'Auto attendant prompt name' },
      },
      required: ['domain', 'userId', 'prompt'],
    },
  },
  {
    name: 'update_user_auto_attendant',
    description: 'Update a specific auto attendant for a user',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
        prompt: { type: 'string', description: 'Auto attendant prompt name' },
        data: { type: 'object', description: 'Updated auto attendant data' },
      },
      required: ['domain', 'userId', 'prompt', 'data'],
    },
  },
  {
    name: 'delete_user_auto_attendant',
    description: 'Delete a specific auto attendant for a user',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
        prompt: { type: 'string', description: 'Auto attendant prompt name' },
      },
      required: ['domain', 'userId', 'prompt'],
    },
  },
];

export async function handleToolCall(client: NetSapiensClient, toolName: string, args: any): Promise<any> {
  switch (toolName) {
    case 'get_auto_attendants': {
      const result = await client.getAutoAttendants(args.domain);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved ${result.data?.length || 0} auto attendants for domain ${args.domain}` : `Failed to get auto attendants: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'create_auto_attendant': {
      const result = await client.createAutoAttendant(args.domain, args.data);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Auto attendant created' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'get_user_auto_attendant': {
      const result = await client.getUserAutoAttendant(args.domain, args.userId, args.prompt);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved auto attendant ${args.prompt}` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'update_user_auto_attendant': {
      const result = await client.updateUserAutoAttendant(args.domain, args.userId, args.prompt, args.data);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Auto attendant ${args.prompt} updated` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'delete_user_auto_attendant': {
      const result = await client.deleteUserAutoAttendant(args.domain, args.userId, args.prompt);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Auto attendant ${args.prompt} deleted` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    default:
      return null;
  }
}
