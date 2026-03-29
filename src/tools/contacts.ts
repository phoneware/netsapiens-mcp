import { NetSapiensClient } from '../netsapiens-client.js';

export const toolDefinitions = [
  {
    name: 'list_contacts',
    description: 'List contacts at domain (shared) or user level',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID (optional, for user contacts)' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'get_contact',
    description: 'Get a specific contact',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID (optional, for user contacts)' },
        contactId: { type: 'string', description: 'Contact ID' },
      },
      required: ['domain', 'contactId'],
    },
  },
  {
    name: 'create_contact',
    description: 'Create a contact (shared domain or user)',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID (optional, for user contacts)' },
        data: { type: 'object', description: 'Contact data' },
      },
      required: ['domain', 'data'],
    },
  },
  {
    name: 'update_contact',
    description: 'Update a contact',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID (optional, for user contacts)' },
        contactId: { type: 'string', description: 'Contact ID' },
        data: { type: 'object', description: 'Updated contact data' },
      },
      required: ['domain', 'contactId', 'data'],
    },
  },
  {
    name: 'delete_contact',
    description: 'Delete a contact',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID (optional, for user contacts)' },
        contactId: { type: 'string', description: 'Contact ID' },
      },
      required: ['domain', 'contactId'],
    },
  },
  {
    name: 'count_contacts',
    description: 'Count contacts for a user',
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
    case 'list_contacts': {
      const result = args.userId
        ? await client.listUserContacts(args.domain, args.userId)
        : await client.listDomainContacts(args.domain);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Retrieved contacts' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'get_contact': {
      const result = args.userId
        ? await client.getUserContact(args.domain, args.userId, args.contactId)
        : await client.getDomainContact(args.domain, args.contactId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved contact ${args.contactId}` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'create_contact': {
      const result = args.userId
        ? await client.createUserContact(args.domain, args.userId, args.data)
        : await client.createDomainContact(args.domain, args.data);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Contact created' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'update_contact': {
      const result = args.userId
        ? await client.updateUserContact(args.domain, args.userId, args.contactId, args.data)
        : await client.updateDomainContact(args.domain, args.contactId, args.data);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Contact updated` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'delete_contact': {
      const result = args.userId
        ? await client.deleteUserContact(args.domain, args.userId, args.contactId)
        : await client.deleteDomainContact(args.domain, args.contactId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Contact deleted' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'count_contacts': {
      const result = await client.countUserContacts(args.domain, args.userId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Counted contacts' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    default:
      return null;
  }
}
