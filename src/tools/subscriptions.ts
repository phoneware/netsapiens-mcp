import { NetSapiensClient } from '../netsapiens-client.js';

export const toolDefinitions = [
  {
    name: 'list_subscriptions',
    description: 'List event subscriptions at domain or system level',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name (omit for system level)' },
      },
    },
  },
  {
    name: 'get_subscription',
    description: 'Get a specific event subscription by ID',
    inputSchema: {
      type: 'object',
      properties: {
        subscriptionId: { type: 'string', description: 'Subscription ID' },
      },
      required: ['subscriptionId'],
    },
  },
  {
    name: 'create_subscription',
    description: 'Create a new event subscription',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name (omit for system level)' },
        data: { type: 'object', description: 'Subscription data (event type, callback URL, etc.)' },
      },
      required: ['data'],
    },
  },
  {
    name: 'update_subscription',
    description: 'Update an event subscription',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name (omit for system level)' },
        subscriptionId: { type: 'string', description: 'Subscription ID' },
        data: { type: 'object', description: 'Updated subscription data' },
      },
      required: ['subscriptionId', 'data'],
    },
  },
  {
    name: 'delete_subscription',
    description: 'Delete an event subscription',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name (omit for system level)' },
        subscriptionId: { type: 'string', description: 'Subscription ID' },
      },
      required: ['subscriptionId'],
    },
  },
];

export async function handleToolCall(client: NetSapiensClient, toolName: string, args: any): Promise<any> {
  switch (toolName) {
    case 'list_subscriptions': {
      const result = args.domain
        ? await client.listDomainSubscriptions(args.domain)
        : await client.listSystemSubscriptions();
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Retrieved subscriptions' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'get_subscription': {
      const result = await client.getSubscription(args.subscriptionId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved subscription ${args.subscriptionId}` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'create_subscription': {
      const result = args.domain
        ? await client.createDomainSubscription(args.domain, args.data)
        : await client.createSystemSubscription(args.data);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Subscription created' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'update_subscription': {
      const result = args.domain
        ? await client.updateDomainSubscription(args.domain, args.subscriptionId, args.data)
        : await client.updateSystemSubscription(args.subscriptionId, args.data);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Subscription updated` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'delete_subscription': {
      const result = args.domain
        ? await client.deleteDomainSubscription(args.domain, args.subscriptionId)
        : await client.deleteSystemSubscription(args.subscriptionId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Subscription deleted' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    default:
      return null;
  }
}
