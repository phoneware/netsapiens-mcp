import { NetSapiensClient } from '../netsapiens-client.js';

export const toolDefinitions = [
  {
    name: 'list_dial_policies',
    description: 'List dial policies at domain or system level',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name (omit for system level)' },
      },
    },
  },
  {
    name: 'manage_dial_policy',
    description: 'Manage dial policies (get, create, update, delete)',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'create', 'update', 'delete'], description: 'Action to perform' },
        domain: { type: 'string', description: 'Domain name (omit for system level)' },
        policy: { type: 'string', description: 'Policy identifier (for get/update/delete)' },
        data: { type: 'object', description: 'Policy data for create/update' },
      },
      required: ['action'],
    },
  },
  {
    name: 'manage_dial_permissions',
    description: 'Manage permissions within a dial policy (list, get, add, update, delete)',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'add', 'update', 'delete'], description: 'Action to perform' },
        domain: { type: 'string', description: 'Domain name (omit for system level)' },
        policy: { type: 'string', description: 'Policy identifier' },
        permissionId: { type: 'string', description: 'Permission ID (for get/update/delete)' },
        data: { type: 'object', description: 'Permission data for add/update' },
      },
      required: ['action', 'policy'],
    },
  },
];

export async function handleToolCall(client: NetSapiensClient, toolName: string, args: any): Promise<any> {
  switch (toolName) {
    case 'list_dial_policies': {
      const result = args.domain
        ? await client.listDomainDialPolicies(args.domain)
        : await client.listSystemDialPolicies();
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Retrieved dial policies' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'manage_dial_policy': {
      let result;
      const isDomain = !!args.domain;
      switch (args.action) {
        case 'get': result = isDomain ? await client.getDomainDialPolicy(args.domain, args.policy) : await client.getSystemDialPolicy(args.policy); break;
        case 'create': result = isDomain ? await client.createDomainDialPolicy(args.domain, args.data) : await client.createSystemDialPolicy(args.data); break;
        case 'update': result = isDomain ? await client.updateDomainDialPolicy(args.domain, args.policy, args.data) : await client.updateSystemDialPolicy(args.policy, args.data); break;
        case 'delete': result = isDomain ? await client.deleteDomainDialPolicy(args.domain, args.policy) : await client.deleteSystemDialPolicy(args.policy); break;
        default: return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Unknown action: ${args.action}` }, null, 2) }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Dial policy ${args.action} successful` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'manage_dial_permissions': {
      let result;
      const isDomain = !!args.domain;
      switch (args.action) {
        case 'list': result = isDomain ? await client.listDomainDialPermissions(args.domain, args.policy) : await client.listSystemDialPermissions(args.policy); break;
        case 'get': result = isDomain ? await client.getDomainDialPermission(args.domain, args.policy, args.permissionId) : await client.getSystemDialPermission(args.policy, args.permissionId); break;
        case 'add': result = isDomain ? await client.addDomainDialPermission(args.domain, args.policy, args.data) : await client.addSystemDialPermission(args.policy, args.data); break;
        case 'update': result = isDomain ? await client.updateDomainDialPermission(args.domain, args.policy, args.permissionId, args.data) : await client.updateSystemDialPermission(args.policy, args.permissionId, args.data); break;
        case 'delete': result = isDomain ? await client.deleteDomainDialPermission(args.domain, args.policy, args.permissionId) : await client.deleteSystemDialPermission(args.policy, args.permissionId); break;
        default: return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Unknown action: ${args.action}` }, null, 2) }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Dial permission ${args.action} successful` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    default:
      return null;
  }
}
