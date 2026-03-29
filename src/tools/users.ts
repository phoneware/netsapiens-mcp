import { NetSapiensClient } from '../netsapiens-client.js';

export const toolDefinitions = [
  {
    name: 'search_users',
    description: 'Search for users in the NetSapiens system',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (username or partial username)' },
        domain: { type: 'string', description: 'Optional specific domain to search in' },
        limit: { type: 'number', description: 'Maximum number of results to return (default: 20)', default: 20 },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_user',
    description: 'Get detailed information about a specific user',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'User ID (username part)' },
        domain: { type: 'string', description: 'Domain name' },
      },
      required: ['userId', 'domain'],
    },
  },
  {
    name: 'create_user',
    description: 'Create a new user in a domain',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        data: { type: 'object', description: 'User data including username, name, email, extension, etc.' },
      },
      required: ['domain', 'data'],
    },
  },
  {
    name: 'update_user',
    description: 'Update an existing user',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID to update' },
        data: { type: 'object', description: 'Updated user data' },
      },
      required: ['domain', 'userId', 'data'],
    },
  },
  {
    name: 'delete_user',
    description: 'Delete a user from a domain',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID to delete' },
      },
      required: ['domain', 'userId'],
    },
  },
  {
    name: 'count_users',
    description: 'Count users in a domain',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'list_users_basic',
    description: 'List basic info on users in a domain',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'get_my_user',
    description: 'Get information about the authenticated user',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_user_devices',
    description: 'Get devices assigned to a specific user',
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
    name: 'manage_user_device',
    description: 'Manage user devices (create, update, delete, get, count)',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'delete', 'get', 'count'], description: 'Action to perform' },
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
        device: { type: 'string', description: 'Device identifier (for update/delete/get)' },
        data: { type: 'object', description: 'Device data for create/update' },
      },
      required: ['action', 'domain', 'userId'],
    },
  },
];

export async function handleToolCall(client: NetSapiensClient, toolName: string, args: any): Promise<any> {
  switch (toolName) {
    case 'search_users': {
      const { query, domain, limit = 20 } = args;
      const result = await client.searchUsers(query, domain, limit);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Found ${result.data?.length || 0} users matching "${query}"${domain ? ` in domain ${domain}` : ''}` : `Search failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'get_user': {
      const result = await client.getUser(args.userId, args.domain);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved user details for ${args.userId}` : `Failed to get user: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'create_user': {
      const result = await client.createUser(args.domain, args.data);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'User created' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'update_user': {
      const result = await client.updateUser(args.domain, args.userId, args.data);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `User ${args.userId} updated` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'delete_user': {
      const result = await client.deleteUser(args.domain, args.userId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `User ${args.userId} deleted` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'count_users': {
      const result = await client.countUsers(args.domain);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Counted users in domain ${args.domain}` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'list_users_basic': {
      const result = await client.listUsersBasic(args.domain);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved basic user list for domain ${args.domain}` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'get_my_user': {
      const result = await client.getMyUser();
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Retrieved my user info' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'get_user_devices': {
      const result = await client.getUserDevices(args.userId, args.domain);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved ${result.data?.length || 0} devices for user ${args.userId}@${args.domain}` : `Failed to get user devices: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'manage_user_device': {
      let result;
      switch (args.action) {
        case 'create': result = await client.createUserDevice(args.domain, args.userId, args.data); break;
        case 'update': result = await client.updateUserDevice(args.domain, args.userId, args.device, args.data); break;
        case 'delete': result = await client.deleteUserDevice(args.domain, args.userId, args.device); break;
        case 'get': result = await client.getUserDevice(args.domain, args.userId, args.device); break;
        case 'count': result = await client.countUserDevices(args.domain, args.userId); break;
        default: return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Unknown action: ${args.action}` }, null, 2) }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Device ${args.action} successful` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    default:
      return null;
  }
}
