import { NetSapiensClient } from '../netsapiens-client.js';

export const toolDefinitions = [
  {
    name: 'list_phones',
    description: 'List MAC addresses (phones) at domain or system level',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name (omit for system level)' },
      },
    },
  },
  {
    name: 'manage_phone',
    description: 'Manage phone MAC addresses (get, add, update, remove) at domain or system level',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'add', 'update', 'remove'], description: 'Action to perform' },
        domain: { type: 'string', description: 'Domain name (omit for system level)' },
        mac: { type: 'string', description: 'MAC address (for get)' },
        data: { type: 'object', description: 'Phone data for add/update' },
      },
      required: ['action'],
    },
  },
  {
    name: 'manage_phone_config',
    description: 'Manage phone configurations (get, create, update, delete, count)',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'create', 'update', 'delete', 'count'], description: 'Action to perform' },
        domain: { type: 'string', description: 'Domain name' },
        mac: { type: 'string', description: 'MAC address (for get/update/delete)' },
        data: { type: 'object', description: 'Configuration data for create/update' },
      },
      required: ['action', 'domain'],
    },
  },
  {
    name: 'manage_phone_template',
    description: 'Manage phone templates (list, get, create, update, delete, count)',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'create', 'update', 'delete', 'count'], description: 'Action to perform' },
        domain: { type: 'string', description: 'Domain name' },
        name: { type: 'string', description: 'Template name (for get/update/delete)' },
        data: { type: 'object', description: 'Template data for create/update' },
      },
      required: ['action', 'domain'],
    },
  },
  {
    name: 'list_device_profiles',
    description: 'List device profiles or get a specific device profile',
    inputSchema: {
      type: 'object',
      properties: {
        make: { type: 'string', description: 'Phone manufacturer (for specific profile)' },
        model: { type: 'string', description: 'Phone model (for specific profile, requires make)' },
      },
    },
  },
  {
    name: 'list_phone_models',
    description: 'Get list of supported/provisionable phone models',
    inputSchema: {
      type: 'object',
      properties: {
        vendor: { type: 'string', description: 'Filter by vendor (optional)' },
        model: { type: 'string', description: 'Get details of specific model (optional)' },
      },
    },
  },
];

export async function handleToolCall(client: NetSapiensClient, toolName: string, args: any): Promise<any> {
  switch (toolName) {
    case 'list_phones': {
      const result = args.domain
        ? await client.listDomainPhones(args.domain)
        : await client.listSystemPhones();
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Retrieved phones' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'manage_phone': {
      let result;
      if (args.domain) {
        switch (args.action) {
          case 'get': result = await client.getDomainPhone(args.domain, args.mac); break;
          case 'add': result = await client.addDomainPhone(args.domain, args.data); break;
          case 'update': result = await client.updateDomainPhone(args.domain, args.data); break;
          case 'remove': result = await client.removeDomainPhone(args.domain, args.data); break;
          default: return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Unknown action: ${args.action}` }, null, 2) }] };
        }
      } else {
        switch (args.action) {
          case 'get': result = await client.getSystemPhone(args.mac); break;
          case 'add': result = await client.addSystemPhone(args.data); break;
          case 'update': result = await client.updateSystemPhone(args.data); break;
          case 'remove': result = await client.removeSystemPhone(args.data); break;
          default: return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Unknown action: ${args.action}` }, null, 2) }] };
        }
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Phone ${args.action} successful` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'manage_phone_config': {
      let result;
      switch (args.action) {
        case 'get': result = await client.getPhoneConfig(args.domain, args.mac); break;
        case 'create': result = await client.createPhoneConfig(args.domain, args.data); break;
        case 'update': result = await client.updatePhoneConfig(args.domain, args.mac, args.data); break;
        case 'delete': result = await client.deletePhoneConfig(args.domain, args.mac); break;
        case 'count': result = await client.countPhoneConfigs(args.domain); break;
        default: return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Unknown action: ${args.action}` }, null, 2) }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Phone config ${args.action} successful` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'manage_phone_template': {
      let result;
      switch (args.action) {
        case 'list': result = await client.listPhoneTemplates(args.domain); break;
        case 'get': result = await client.getPhoneTemplate(args.domain, args.name); break;
        case 'create': result = await client.createPhoneTemplate(args.domain, args.data); break;
        case 'update': result = await client.updatePhoneTemplate(args.domain, args.name, args.data); break;
        case 'delete': result = await client.deletePhoneTemplate(args.domain, args.name); break;
        case 'count': result = await client.countPhoneTemplates(args.domain); break;
        default: return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Unknown action: ${args.action}` }, null, 2) }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Phone template ${args.action} successful` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'list_device_profiles': {
      const result = args.make && args.model
        ? await client.getDeviceProfile(args.make, args.model)
        : await client.listDeviceProfiles();
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Retrieved device profiles' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'list_phone_models': {
      const result = args.model
        ? await client.getPhoneModelDetails(args.model)
        : args.vendor
          ? await client.listPhoneModelsByVendor(args.vendor)
          : await client.listPhoneModels();
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Retrieved phone models' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    default:
      return null;
  }
}
