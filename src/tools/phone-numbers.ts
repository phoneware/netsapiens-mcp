import { NetSapiensClient } from '../netsapiens-client.js';

export const toolDefinitions = [
  {
    name: 'get_phone_numbers',
    description: 'Get phone numbers for a domain',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        limit: { type: 'number', description: 'Maximum number of results (optional)' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'get_phone_number',
    description: 'Get details of a specific phone number',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        phoneNumber: { type: 'string', description: 'Phone number to lookup' },
      },
      required: ['domain', 'phoneNumber'],
    },
  },
  {
    name: 'add_phone_number',
    description: 'Add a phone number to a domain',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        data: { type: 'object', description: 'Phone number data including the number, description, and routing' },
      },
      required: ['domain', 'data'],
    },
  },
  {
    name: 'update_phone_number',
    description: 'Update a phone number in a domain (or route to call queue/user/offnet/available)',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        phoneNumber: { type: 'string', description: 'Phone number to update' },
        data: { type: 'object', description: 'Updated phone number data' },
      },
      required: ['domain', 'data'],
    },
  },
  {
    name: 'remove_phone_number',
    description: 'Remove a phone number from a domain',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        phoneNumber: { type: 'string', description: 'Phone number to remove' },
      },
      required: ['domain', 'phoneNumber'],
    },
  },
  {
    name: 'count_phone_numbers',
    description: 'Count phone numbers for a domain or system-wide',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name (omit for system count)' },
      },
    },
  },
  {
    name: 'list_system_phone_numbers',
    description: 'Get all phone numbers system-wide or for a reseller',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum number of results' },
        offset: { type: 'number', description: 'Offset for pagination' },
      },
    },
  },
];

export async function handleToolCall(client: NetSapiensClient, toolName: string, args: any): Promise<any> {
  switch (toolName) {
    case 'get_phone_numbers': {
      const result = await client.getPhoneNumbers(args.domain, args.limit);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved ${result.data?.length || 0} phone numbers for domain ${args.domain}` : `Failed to get phone numbers: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'get_phone_number': {
      const result = await client.getPhoneNumber(args.domain, args.phoneNumber);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved phone number details for ${args.phoneNumber}` : `Failed to get phone number: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'add_phone_number': {
      const result = await client.addPhoneNumber(args.domain, args.data);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Phone number added' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'update_phone_number': {
      const result = await client.updatePhoneNumber(args.domain, args.phoneNumber, args.data);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Phone number updated` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'remove_phone_number': {
      const result = await client.removePhoneNumber(args.domain, args.phoneNumber);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Phone number ${args.phoneNumber} removed` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'count_phone_numbers': {
      const result = args.domain ? await client.countPhoneNumbers(args.domain) : await client.countSystemPhoneNumbers();
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Counted phone numbers' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'list_system_phone_numbers': {
      const result = await client.listSystemPhoneNumbers(args.limit, args.offset);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Retrieved system phone numbers' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    default:
      return null;
  }
}
