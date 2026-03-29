import { NetSapiensClient } from '../netsapiens-client.js';

export const toolDefinitions = [
  {
    name: 'manage_video_company',
    description: 'Manage Iotum video company for a domain (get, create, update, delete)',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'create', 'update', 'delete'], description: 'Action to perform' },
        domain: { type: 'string', description: 'Domain name' },
        data: { type: 'object', description: 'Company data for create/update' },
      },
      required: ['action', 'domain'],
    },
  },
  {
    name: 'list_video_hosts',
    description: 'List Iotum video hosts in a domain',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'list_video_products',
    description: 'List Iotum video products (available or current)',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        type: { type: 'string', enum: ['available', 'current'], description: 'Product listing type' },
      },
      required: ['domain', 'type'],
    },
  },
  {
    name: 'manage_video_subscription',
    description: 'Manage Iotum video subscriptions (create, update, delete)',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'delete'], description: 'Action to perform' },
        domain: { type: 'string', description: 'Domain name' },
        slug: { type: 'string', description: 'Product slug (for create/delete)' },
        data: { type: 'object', description: 'Subscription data for update' },
      },
      required: ['action', 'domain'],
    },
  },
  {
    name: 'list_meetings',
    description: 'List meetings for a user',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
      },
      required: ['domain', 'userId'],
    },
  },
  {
    name: 'get_meeting',
    description: 'Get details of a specific meeting',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
        meetingId: { type: 'string', description: 'Meeting ID' },
      },
      required: ['domain', 'userId', 'meetingId'],
    },
  },
  {
    name: 'create_meeting',
    description: 'Create a meeting',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
        data: { type: 'object', description: 'Meeting data' },
      },
      required: ['domain', 'userId', 'data'],
    },
  },
  {
    name: 'update_meeting',
    description: 'Update a meeting',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
        meetingId: { type: 'string', description: 'Meeting ID' },
        data: { type: 'object', description: 'Updated meeting data' },
      },
      required: ['domain', 'userId', 'meetingId', 'data'],
    },
  },
  {
    name: 'delete_meeting',
    description: 'Delete a meeting',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
        meetingId: { type: 'string', description: 'Meeting ID' },
      },
      required: ['domain', 'userId', 'meetingId'],
    },
  },
  {
    name: 'manage_meeting_logs',
    description: 'Manage meeting log events (create or read)',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'create'], description: 'Action to perform' },
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
        meetingId: { type: 'string', description: 'Meeting ID' },
        instanceId: { type: 'string', description: 'Meeting instance ID' },
        data: { type: 'object', description: 'Log event data for create' },
      },
      required: ['action', 'domain', 'userId', 'meetingId', 'instanceId'],
    },
  },
];

export async function handleToolCall(client: NetSapiensClient, toolName: string, args: any): Promise<any> {
  switch (toolName) {
    case 'manage_video_company': {
      let result;
      switch (args.action) {
        case 'get': result = await client.getVideoCompany(args.domain); break;
        case 'create': result = await client.createVideoCompany(args.domain, args.data); break;
        case 'update': result = await client.updateVideoCompany(args.domain, args.data); break;
        case 'delete': result = await client.deleteVideoCompany(args.domain); break;
        default: return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Unknown action: ${args.action}` }, null, 2) }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Video company ${args.action} successful` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'list_video_hosts': {
      const result = await client.listVideoHosts(args.domain);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Retrieved video hosts' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'list_video_products': {
      const result = args.type === 'available'
        ? await client.listAvailableVideoProducts(args.domain)
        : await client.listVideoProducts(args.domain);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Retrieved video products' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'manage_video_subscription': {
      let result;
      switch (args.action) {
        case 'create': result = await client.createVideoSubscription(args.domain, args.slug); break;
        case 'update': result = await client.updateVideoSubscriptions(args.domain, args.data); break;
        case 'delete': result = await client.deleteVideoSubscription(args.domain, args.slug); break;
        default: return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Unknown action: ${args.action}` }, null, 2) }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Video subscription ${args.action} successful` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'list_meetings': {
      const result = await client.listMeetings(args.domain, args.userId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Retrieved meetings' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'get_meeting': {
      const result = await client.getMeeting(args.domain, args.userId, args.meetingId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved meeting ${args.meetingId}` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'create_meeting': {
      const result = await client.createMeeting(args.domain, args.userId, args.data);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Meeting created' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'update_meeting': {
      const result = await client.updateMeeting(args.domain, args.userId, args.meetingId, args.data);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Meeting ${args.meetingId} updated` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'delete_meeting': {
      const result = await client.deleteMeeting(args.domain, args.userId, args.meetingId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Meeting ${args.meetingId} deleted` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'manage_meeting_logs': {
      const result = args.action === 'create'
        ? await client.createMeetingLog(args.domain, args.userId, args.meetingId, args.instanceId, args.data)
        : await client.getMeetingLogs(args.domain, args.userId, args.meetingId, args.instanceId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Meeting logs ${args.action} successful` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    default:
      return null;
  }
}
