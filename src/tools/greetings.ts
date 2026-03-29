import { NetSapiensClient } from '../netsapiens-client.js';

export const toolDefinitions = [
  {
    name: 'get_user_greetings',
    description: 'Get greetings for a user',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'User ID' },
        domain: { type: 'string', description: 'Domain name' },
      },
      required: ['userId', 'domain'],
    },
  },
  {
    name: 'get_greeting',
    description: 'Get a specific greeting for a user',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
        index: { type: 'number', description: 'Greeting index' },
      },
      required: ['domain', 'userId', 'index'],
    },
  },
  {
    name: 'create_greeting',
    description: 'Create a new greeting from TTS (text-to-speech)',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
        data: { type: 'object', description: 'Greeting data including TTS text, voice, language' },
      },
      required: ['domain', 'userId', 'data'],
    },
  },
  {
    name: 'update_greeting',
    description: 'Update an existing greeting',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
        index: { type: 'number', description: 'Greeting index' },
        data: { type: 'object', description: 'Updated greeting data' },
      },
      required: ['domain', 'userId', 'index', 'data'],
    },
  },
  {
    name: 'delete_greeting',
    description: 'Delete a greeting for a user',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
        index: { type: 'number', description: 'Greeting index to delete' },
      },
      required: ['domain', 'userId', 'index'],
    },
  },
  {
    name: 'count_greetings',
    description: 'Count greetings for a user',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
      },
      required: ['domain', 'userId'],
    },
  },
];

export async function handleToolCall(client: NetSapiensClient, toolName: string, args: any): Promise<any> {
  switch (toolName) {
    case 'get_user_greetings': {
      const result = await client.getUserGreetings(args.userId, args.domain);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved ${result.data?.length || 0} greetings for user ${args.userId}@${args.domain}` : `Failed to get user greetings: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'get_greeting': {
      const result = await client.getGreeting(args.domain, args.userId, args.index);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved greeting ${args.index}` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'create_greeting': {
      const result = await client.createGreeting(args.domain, args.userId, args.data);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Greeting created' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'update_greeting': {
      const result = await client.updateGreeting(args.domain, args.userId, args.index, args.data);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Greeting ${args.index} updated` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'delete_greeting': {
      const result = await client.deleteGreeting(args.domain, args.userId, args.index);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Greeting ${args.index} deleted` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'count_greetings': {
      const result = await client.countGreetings(args.domain, args.userId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Counted greetings' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    default:
      return null;
  }
}
