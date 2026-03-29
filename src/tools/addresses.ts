import { NetSapiensClient } from '../netsapiens-client.js';

export const toolDefinitions = [
  {
    name: 'list_addresses',
    description: 'List addresses for a domain or user',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID (optional, for user-level addresses)' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'create_address',
    description: 'Create an address for a domain or user',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID (optional, for user-level)' },
        data: { type: 'object', description: 'Address data' },
      },
      required: ['domain', 'data'],
    },
  },
  {
    name: 'update_address',
    description: 'Update an address',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID (optional, for user-level)' },
        addressId: { type: 'string', description: 'Address ID' },
        data: { type: 'object', description: 'Updated address data' },
      },
      required: ['domain', 'addressId', 'data'],
    },
  },
  {
    name: 'delete_address',
    description: 'Delete an address',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID (optional, for user-level)' },
        addressId: { type: 'string', description: 'Address ID' },
      },
      required: ['domain', 'addressId'],
    },
  },
  {
    name: 'validate_address',
    description: 'Validate an address for a domain',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        data: { type: 'object', description: 'Address data to validate' },
      },
      required: ['domain', 'data'],
    },
  },
  {
    name: 'manage_address_endpoints',
    description: 'Manage address endpoints (list, create, update, delete)',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'update', 'delete'], description: 'Action to perform' },
        domain: { type: 'string', description: 'Domain name' },
        endpoint: { type: 'string', description: 'Endpoint identifier (for update/delete)' },
        data: { type: 'object', description: 'Endpoint data for create/update' },
      },
      required: ['action', 'domain'],
    },
  },
  {
    name: 'count_addresses',
    description: 'Count addresses for a domain',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
      },
      required: ['domain'],
    },
  },
];

export async function handleToolCall(client: NetSapiensClient, toolName: string, args: any): Promise<any> {
  switch (toolName) {
    case 'list_addresses': {
      const result = args.userId
        ? await client.listUserAddresses(args.domain, args.userId)
        : await client.listDomainAddresses(args.domain);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Retrieved addresses' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'create_address': {
      const result = args.userId
        ? await client.createUserAddress(args.domain, args.userId, args.data)
        : await client.createDomainAddress(args.domain, args.data);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Address created' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'update_address': {
      const result = args.userId
        ? await client.updateUserAddress(args.domain, args.userId, args.addressId, args.data)
        : await client.updateDomainAddress(args.domain, args.addressId, args.data);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Address updated' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'delete_address': {
      const result = args.userId
        ? await client.deleteUserAddress(args.domain, args.userId, args.addressId)
        : await client.deleteDomainAddress(args.domain, args.addressId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Address deleted' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'validate_address': {
      const result = await client.validateAddress(args.domain, args.data);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Address validated' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'manage_address_endpoints': {
      let result;
      switch (args.action) {
        case 'list': result = await client.listAddressEndpoints(args.domain); break;
        case 'create': result = await client.createAddressEndpoint(args.domain, args.data); break;
        case 'update': result = await client.updateAddressEndpoint(args.domain, args.endpoint, args.data); break;
        case 'delete': result = await client.deleteAddressEndpoint(args.domain, args.endpoint); break;
        default: return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Unknown action: ${args.action}` }, null, 2) }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Address endpoint ${args.action} successful` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'count_addresses': {
      const result = await client.countAddresses(args.domain);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Counted addresses' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    default:
      return null;
  }
}
