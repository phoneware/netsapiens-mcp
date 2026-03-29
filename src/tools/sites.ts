import { NetSapiensClient } from '../netsapiens-client.js';

export const toolDefinitions = [
  {
    name: 'list_sites',
    description: 'List sites in a domain',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        basic: { type: 'boolean', description: 'If true, return basic info only (list endpoint)' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'get_site',
    description: 'Get details of a specific site in a domain',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        site: { type: 'string', description: 'Site identifier' },
      },
      required: ['domain', 'site'],
    },
  },
  {
    name: 'create_site',
    description: 'Create a new site in a domain',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        data: { type: 'object', description: 'Site data' },
      },
      required: ['domain', 'data'],
    },
  },
  {
    name: 'update_site',
    description: 'Update a site in a domain',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        site: { type: 'string', description: 'Site identifier' },
        data: { type: 'object', description: 'Updated site data' },
      },
      required: ['domain', 'site', 'data'],
    },
  },
  {
    name: 'count_sites',
    description: 'Count sites in a domain',
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
    case 'list_sites': {
      const result = args.basic ? await client.listSitesBasic(args.domain) : await client.listSites(args.domain);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved sites for domain ${args.domain}` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'get_site': {
      const result = await client.getSite(args.domain, args.site);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved site ${args.site}` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'create_site': {
      const result = await client.createSite(args.domain, args.data);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Site created' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'update_site': {
      const result = await client.updateSite(args.domain, args.site, args.data);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Site ${args.site} updated` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'count_sites': {
      const result = await client.countSites(args.domain);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Counted sites for domain ${args.domain}` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    default:
      return null;
  }
}
