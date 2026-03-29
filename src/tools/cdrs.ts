import { NetSapiensClient } from '../netsapiens-client.js';

export const toolDefinitions = [
  {
    name: 'get_cdr_records',
    description: 'Retrieve call detail records (CDR) at system, domain, site, or user level',
    inputSchema: {
      type: 'object',
      properties: {
        startDate: { type: 'string', description: 'Start date for CDR search (YYYY-MM-DD format)' },
        endDate: { type: 'string', description: 'End date for CDR search (YYYY-MM-DD format)' },
        user: { type: 'string', description: 'Specific user to get CDR records for' },
        domain: { type: 'string', description: 'Domain to search in (required if user is specified)' },
        site: { type: 'string', description: 'Site to search in (requires domain)' },
        limit: { type: 'number', description: 'Maximum number of records to return (default: 100)', default: 100 },
      },
    },
  },
  {
    name: 'count_cdr_records',
    description: 'Count CDR records and sum minutes at system, domain, or user level',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name (omit for system level)' },
        user: { type: 'string', description: 'User ID (requires domain)' },
        startDate: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
        endDate: { type: 'string', description: 'End date (YYYY-MM-DD)' },
      },
    },
  },
  {
    name: 'search_cdr_records',
    description: 'Search CDR records for a domain with advanced filters',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        query: { type: 'string', description: 'Search query' },
        startDate: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
        endDate: { type: 'string', description: 'End date (YYYY-MM-DD)' },
        limit: { type: 'number', description: 'Maximum number of records' },
      },
      required: ['domain'],
    },
  },
];

export async function handleToolCall(client: NetSapiensClient, toolName: string, args: any): Promise<any> {
  switch (toolName) {
    case 'get_cdr_records': {
      const result = await client.getCDRRecords({
        startDate: args.startDate,
        endDate: args.endDate,
        user: args.user,
        domain: args.domain,
        limit: args.limit || 100,
      } as any);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved ${result.data?.length || 0} CDR records` : `Failed to get CDR records: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'count_cdr_records': {
      const result = await client.countCDRRecords(args.domain, args.user, args.startDate, args.endDate);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'CDR count retrieved' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'search_cdr_records': {
      const result = await client.searchCDRRecords(args.domain, args.query, args.startDate, args.endDate, args.limit);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved CDR search results` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    default:
      return null;
  }
}
