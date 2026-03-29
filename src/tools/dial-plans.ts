import { NetSapiensClient } from '../netsapiens-client.js';

export const toolDefinitions = [
  {
    name: 'list_dial_plans',
    description: 'List dial plans at domain or system level',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name (omit for system level)' },
      },
    },
  },
  {
    name: 'create_dial_plan',
    description: 'Create a dial plan at domain or system level',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name (omit for system level)' },
        data: { type: 'object', description: 'Dial plan data' },
      },
      required: ['data'],
    },
  },
  {
    name: 'update_dial_plan',
    description: 'Update a dial plan in a domain',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        dialplan: { type: 'string', description: 'Dial plan identifier' },
        data: { type: 'object', description: 'Updated dial plan data' },
      },
      required: ['domain', 'dialplan', 'data'],
    },
  },
  {
    name: 'delete_dial_plan',
    description: 'Delete a dial plan from a domain',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        dialplan: { type: 'string', description: 'Dial plan identifier' },
      },
      required: ['domain', 'dialplan'],
    },
  },
  {
    name: 'manage_dial_rules',
    description: 'Manage dial rules within a dial plan (list, get, create, update, delete)',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'create', 'update', 'delete', 'count'], description: 'Action to perform' },
        domain: { type: 'string', description: 'Domain name' },
        dialplan: { type: 'string', description: 'Dial plan identifier' },
        dialrule: { type: 'string', description: 'Dial rule identifier (for get/update/delete)' },
        data: { type: 'object', description: 'Dial rule data for create/update' },
      },
      required: ['action', 'domain', 'dialplan'],
    },
  },
];

export async function handleToolCall(client: NetSapiensClient, toolName: string, args: any): Promise<any> {
  switch (toolName) {
    case 'list_dial_plans': {
      const result = args.domain
        ? await client.listDomainDialPlans(args.domain)
        : await client.listSystemDialPlans();
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Retrieved dial plans' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'create_dial_plan': {
      const result = args.domain
        ? await client.createDomainDialPlan(args.domain, args.data)
        : await client.createSystemDialPlan(args.data);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Dial plan created' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'update_dial_plan': {
      const result = await client.updateDialPlan(args.domain, args.dialplan, args.data);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Dial plan ${args.dialplan} updated` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'delete_dial_plan': {
      const result = await client.deleteDialPlan(args.domain, args.dialplan);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Dial plan ${args.dialplan} deleted` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'manage_dial_rules': {
      let result;
      switch (args.action) {
        case 'list': result = await client.listDialRules(args.domain, args.dialplan); break;
        case 'get': result = await client.getDialRule(args.domain, args.dialplan, args.dialrule); break;
        case 'create': result = await client.createDialRule(args.domain, args.dialplan, args.data); break;
        case 'update': result = await client.updateDialRule(args.domain, args.dialplan, args.dialrule, args.data); break;
        case 'delete': result = await client.deleteDialRule(args.domain, args.dialplan, args.dialrule); break;
        case 'count': result = await client.countDialRules(args.domain, args.dialplan); break;
        default: return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Unknown action: ${args.action}` }, null, 2) }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Dial rule ${args.action} successful` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    default:
      return null;
  }
}
