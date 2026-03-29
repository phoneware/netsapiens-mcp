import { NetSapiensClient } from '../netsapiens-client.js';

export const toolDefinitions = [
  {
    name: 'get_domains',
    description: 'Get list of domains in the NetSapiens system',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_domain',
    description: 'Get detailed information about a specific domain',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name to retrieve information for' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'create_domain',
    description: 'Create a new domain',
    inputSchema: {
      type: 'object',
      properties: {
        data: { type: 'object', description: 'Domain data including domain name, description, and configuration' },
      },
      required: ['data'],
    },
  },
  {
    name: 'update_domain',
    description: 'Update an existing domain',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        data: { type: 'object', description: 'Updated domain data' },
      },
      required: ['domain', 'data'],
    },
  },
  {
    name: 'delete_domain',
    description: 'Delete a domain',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name to delete' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'count_domains',
    description: 'Count domains or check if a specific domain exists',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Optional domain name to check existence' },
      },
    },
  },
  {
    name: 'get_my_domain',
    description: 'Get information about the authenticated user\'s domain',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_billing',
    description: 'Get billing information for a domain',
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
    case 'get_domains': {
      const result = await client.getDomains();
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved ${result.data?.length || 0} domains` : `Failed to get domains: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'get_domain': {
      const result = await client.getDomain(args.domain);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved domain information for ${args.domain}` : `Failed to get domain: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'create_domain': {
      const result = await client.createDomain(args.data);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Domain created' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'update_domain': {
      const result = await client.updateDomain(args.domain, args.data);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Domain ${args.domain} updated` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'delete_domain': {
      const result = await client.deleteDomain(args.domain);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Domain ${args.domain} deleted` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'count_domains': {
      const result = args.domain ? await client.domainExists(args.domain) : await client.countDomains();
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? (args.domain ? `Domain ${args.domain} existence checked` : `Counted domains`) : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'get_my_domain': {
      const result = await client.getMyDomain();
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Retrieved my domain info' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'get_billing': {
      const result = await client.getBilling(args.domain);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved billing information for domain ${args.domain}` : `Failed to get billing information: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    default:
      return null;
  }
}
