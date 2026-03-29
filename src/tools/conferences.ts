import { NetSapiensClient } from '../netsapiens-client.js';

export const toolDefinitions = [
  {
    name: 'list_conferences',
    description: 'List conferences in a domain',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'get_conference',
    description: 'Get details of a specific conference',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        conference: { type: 'string', description: 'Conference ID' },
      },
      required: ['domain', 'conference'],
    },
  },
  {
    name: 'create_conference',
    description: 'Create a new conference in a domain',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        data: { type: 'object', description: 'Conference configuration data' },
      },
      required: ['domain', 'data'],
    },
  },
  {
    name: 'update_conference',
    description: 'Update an existing conference',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        conference: { type: 'string', description: 'Conference ID' },
        data: { type: 'object', description: 'Updated conference data' },
      },
      required: ['domain', 'conference', 'data'],
    },
  },
  {
    name: 'delete_conference',
    description: 'Delete a conference',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        conference: { type: 'string', description: 'Conference ID' },
      },
      required: ['domain', 'conference'],
    },
  },
  {
    name: 'count_conferences',
    description: 'Count conferences in a domain',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'manage_conference_participant',
    description: 'Manage conference participants (list, add, update, remove)',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'update', 'remove'], description: 'Action to perform' },
        domain: { type: 'string', description: 'Domain name' },
        conference: { type: 'string', description: 'Conference ID' },
        participant: { type: 'string', description: 'Participant ID (for update/remove)' },
        data: { type: 'object', description: 'Participant data for add/update' },
      },
      required: ['action', 'domain', 'conference'],
    },
  },
  {
    name: 'get_conference_cdr',
    description: 'Get CDR records for a conference',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        conference: { type: 'string', description: 'Conference ID' },
      },
      required: ['domain', 'conference'],
    },
  },
];

export async function handleToolCall(client: NetSapiensClient, toolName: string, args: any): Promise<any> {
  switch (toolName) {
    case 'list_conferences': {
      const result = await client.listConferences(args.domain);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved conferences for domain ${args.domain}` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'get_conference': {
      const result = await client.getConference(args.domain, args.conference);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved conference ${args.conference}` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'create_conference': {
      const result = await client.createConference(args.domain, args.data);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Conference created' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'update_conference': {
      const result = await client.updateConference(args.domain, args.conference, args.data);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Conference ${args.conference} updated` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'delete_conference': {
      const result = await client.deleteConference(args.domain, args.conference);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Conference ${args.conference} deleted` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'count_conferences': {
      const result = await client.countConferences(args.domain);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Counted conferences` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'manage_conference_participant': {
      let result;
      switch (args.action) {
        case 'list': result = await client.listConferenceParticipants(args.domain, args.conference); break;
        case 'add': result = await client.addConferenceParticipant(args.domain, args.conference, args.data); break;
        case 'update': result = await client.updateConferenceParticipant(args.domain, args.conference, args.participant, args.data); break;
        case 'remove': result = await client.removeConferenceParticipant(args.domain, args.conference, args.participant); break;
        default: return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Unknown action: ${args.action}` }, null, 2) }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Participant ${args.action} successful` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'get_conference_cdr': {
      const result = await client.getConferenceCdr(args.domain, args.conference);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved conference CDR` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    default:
      return null;
  }
}
