import { NetSapiensClient } from '../netsapiens-client.js';

export const toolDefinitions = [
  {
    name: 'get_api_version',
    description: 'Get the NetSapiens API version information',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_access_log',
    description: 'Read the system access log',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum number of records to return' },
        offset: { type: 'number', description: 'Offset for pagination' },
      },
    },
  },
  {
    name: 'get_audit_log',
    description: 'Read the system audit log',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum number of records to return' },
        offset: { type: 'number', description: 'Offset for pagination' },
      },
    },
  },
  {
    name: 'backup_system',
    description: 'Request a full system backup',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'backup_domain',
    description: 'Manually backup a specific domain',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name to backup' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'list_restore_points',
    description: 'Read available restore points',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'restore_domain',
    description: 'Restore a specific domain backup',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain to restore' },
        restorePoint: { type: 'string', description: 'Restore point identifier' },
      },
      required: ['domain', 'restorePoint'],
    },
  },
  {
    name: 'get_insight',
    description: 'Query data from iNSight analytics',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Insight label to query' },
      },
      required: ['label'],
    },
  },
  {
    name: 'manage_api_key',
    description: 'Manage API keys (list, get, create, update, revoke)',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'create', 'update', 'revoke'], description: 'Action to perform' },
        keyId: { type: 'string', description: 'API key ID (required for get/update/revoke)' },
        data: { type: 'object', description: 'Key data for create/update operations' },
      },
      required: ['action'],
    },
  },
  {
    name: 'manage_certificate',
    description: 'Manage SSL certificates (list, get, create, update, delete)',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'create', 'update', 'delete'], description: 'Action to perform' },
        name: { type: 'string', description: 'Certificate common name (required for get/update/delete)' },
        data: { type: 'object', description: 'Certificate data for create/update operations' },
      },
      required: ['action'],
    },
  },
  {
    name: 'manage_configuration',
    description: 'Manage system configurations and config definitions (list, get, create, update, delete, list_definitions, get_definition, create_definition, update_definition, delete_definition)',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'create', 'update', 'delete', 'count', 'list_definitions', 'get_definition', 'create_definition', 'update_definition', 'delete_definition'], description: 'Action to perform' },
        configName: { type: 'string', description: 'Configuration name (for get/update/delete operations)' },
        data: { type: 'object', description: 'Configuration data for create/update operations' },
      },
      required: ['action'],
    },
  },
  {
    name: 'manage_image',
    description: 'Manage system images (get, create, update, delete)',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'create', 'update', 'delete'], description: 'Action to perform' },
        filename: { type: 'string', description: 'Image filename' },
        data: { type: 'object', description: 'Image data for create/update (base64 content)' },
      },
      required: ['action', 'filename'],
    },
  },
  {
    name: 'manage_template',
    description: 'Manage system templates (get, create, update, delete)',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'create', 'update', 'delete'], description: 'Action to perform' },
        filename: { type: 'string', description: 'Template filename' },
        data: { type: 'object', description: 'Template data for create/update' },
      },
      required: ['action', 'filename'],
    },
  },
  {
    name: 'get_sip_flow',
    description: 'Get call trace (SIP flow), cradle-to-grave info, or CSV export for a call',
    inputSchema: {
      type: 'object',
      properties: {
        callId: { type: 'string', description: 'Call ID to trace' },
        format: { type: 'string', enum: ['trace', 'cradle_to_grave', 'csv'], description: 'Output format (default: trace)' },
      },
      required: ['callId'],
    },
  },
  {
    name: 'manage_firebase',
    description: 'Manage Firebase service accounts (list or add)',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add'], description: 'Action to perform' },
        data: { type: 'object', description: 'Firebase service account data for add' },
      },
      required: ['action'],
    },
  },
  {
    name: 'test_connection',
    description: 'Test connectivity to NetSapiens API',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

export async function handleToolCall(client: NetSapiensClient, toolName: string, args: any): Promise<any> {
  switch (toolName) {
    case 'get_api_version': {
      const result = await client.getApiVersion();
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Retrieved API version' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'get_access_log': {
      const result = await client.getAccessLog({ limit: args.limit, offset: args.offset });
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved access log entries` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'get_audit_log': {
      const result = await client.getAuditLog({ limit: args.limit, offset: args.offset });
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved audit log entries` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'backup_system': {
      const result = await client.backupSystem();
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'System backup initiated' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'backup_domain': {
      const result = await client.backupDomain(args.domain);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Backup initiated for domain ${args.domain}` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'list_restore_points': {
      const result = await client.listRestorePoints();
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved restore points` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'restore_domain': {
      const result = await client.restoreDomain(args.domain, args.restorePoint);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Restore initiated for domain ${args.domain}` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'get_insight': {
      const result = await client.getInsight(args.label);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved insight for ${args.label}` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'manage_api_key': {
      let result;
      switch (args.action) {
        case 'list': result = await client.listApiKeys(); break;
        case 'get': result = await client.getApiKey(args.keyId); break;
        case 'create': result = await client.createApiKey(args.data); break;
        case 'update': result = await client.updateApiKey(args.keyId, args.data); break;
        case 'revoke': result = await client.revokeApiKey(args.keyId); break;
        default: return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Unknown action: ${args.action}` }, null, 2) }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `API key ${args.action} successful` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'manage_certificate': {
      let result;
      switch (args.action) {
        case 'list': result = await client.listCertificates(); break;
        case 'get': result = await client.getCertificate(args.name); break;
        case 'create': result = await client.createCertificate(args.data); break;
        case 'update': result = await client.updateCertificate(args.name, args.data); break;
        case 'delete': result = await client.deleteCertificate(args.name); break;
        default: return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Unknown action: ${args.action}` }, null, 2) }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Certificate ${args.action} successful` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'manage_configuration': {
      let result;
      switch (args.action) {
        case 'list': result = await client.listConfigurations(); break;
        case 'get': result = await client.getConfiguration(args.configName); break;
        case 'create': result = await client.createConfiguration(args.data); break;
        case 'update': result = await client.updateConfiguration(args.data); break;
        case 'delete': result = await client.deleteConfiguration(args.configName); break;
        case 'count': result = await client.countConfigurations(); break;
        case 'list_definitions': result = await client.listConfigDefinitions(); break;
        case 'get_definition': result = await client.getConfigDefinition(args.configName); break;
        case 'create_definition': result = await client.createConfigDefinition(args.data); break;
        case 'update_definition': result = await client.updateConfigDefinition(args.configName, args.data); break;
        case 'delete_definition': result = await client.deleteConfigDefinition(args.configName); break;
        default: return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Unknown action: ${args.action}` }, null, 2) }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Configuration ${args.action} successful` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'manage_image': {
      let result;
      switch (args.action) {
        case 'get': result = await client.getImage(args.filename); break;
        case 'create': result = await client.createImage(args.filename, args.data); break;
        case 'update': result = await client.updateImage(args.filename, args.data); break;
        case 'delete': result = await client.deleteImage(args.filename); break;
        default: return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Unknown action: ${args.action}` }, null, 2) }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Image ${args.action} successful` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'manage_template': {
      let result;
      switch (args.action) {
        case 'get': result = await client.getTemplate(args.filename); break;
        case 'create': result = await client.createTemplate(args.filename, args.data); break;
        case 'update': result = await client.updateTemplate(args.filename, args.data); break;
        case 'delete': result = await client.deleteTemplate(args.filename); break;
        default: return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Unknown action: ${args.action}` }, null, 2) }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Template ${args.action} successful` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'get_sip_flow': {
      const result = await client.getSipFlow(args.callId, args.format);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved SIP flow for call ${args.callId}` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'manage_firebase': {
      let result;
      switch (args.action) {
        case 'list': result = await client.listFirebase(); break;
        case 'add': result = await client.addFirebase(args.data); break;
        default: return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Unknown action: ${args.action}` }, null, 2) }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Firebase ${args.action} successful` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'test_connection': {
      const result = await client.testConnection();
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.message || (result.success ? 'Connection successful' : 'Connection failed'), error: result.error }, null, 2) }],
      };
    }
    default:
      return null;
  }
}
