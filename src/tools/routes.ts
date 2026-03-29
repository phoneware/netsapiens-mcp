import { NetSapiensClient } from '../netsapiens-client.js';

export const toolDefinitions = [
  {
    name: 'list_routes',
    description: 'List routes in the system',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'create_route',
    description: 'Create a new route',
    inputSchema: {
      type: 'object',
      properties: {
        data: { type: 'object', description: 'Route configuration data' },
      },
      required: ['data'],
    },
  },
  {
    name: 'update_route',
    description: 'Update an existing route',
    inputSchema: {
      type: 'object',
      properties: {
        routeId: { type: 'string', description: 'Route ID' },
        data: { type: 'object', description: 'Updated route data' },
      },
      required: ['routeId', 'data'],
    },
  },
  {
    name: 'delete_route',
    description: 'Delete a route',
    inputSchema: {
      type: 'object',
      properties: {
        routeId: { type: 'string', description: 'Route ID' },
      },
      required: ['routeId'],
    },
  },
  {
    name: 'manage_route_connections',
    description: 'Manage route connections (list, create, update, delete, count)',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'update', 'delete', 'count'], description: 'Action to perform' },
        routeId: { type: 'string', description: 'Route ID (for route-specific connections)' },
        index: { type: 'number', description: 'Connection index (for update/delete)' },
        data: { type: 'object', description: 'Connection data for create/update' },
      },
      required: ['action'],
    },
  },
  {
    name: 'manage_domain_connections',
    description: 'Manage domain connections (list, get, update, delete)',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'update', 'delete'], description: 'Action to perform' },
        domain: { type: 'string', description: 'Domain name' },
        connectionId: { type: 'string', description: 'Connection ID (for get/update/delete)' },
        data: { type: 'object', description: 'Connection data for update' },
      },
      required: ['action', 'domain'],
    },
  },
  {
    name: 'count_routes',
    description: 'Count all routes',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

export async function handleToolCall(client: NetSapiensClient, toolName: string, args: any): Promise<any> {
  switch (toolName) {
    case 'list_routes': {
      const result = await client.listRoutes();
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Retrieved routes' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'create_route': {
      const result = await client.createRoute(args.data);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Route created' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'update_route': {
      const result = await client.updateRoute(args.routeId, args.data);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Route ${args.routeId} updated` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'delete_route': {
      const result = await client.deleteRoute(args.routeId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Route ${args.routeId} deleted` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'manage_route_connections': {
      let result;
      switch (args.action) {
        case 'list': result = await client.listRouteConnections(args.routeId); break;
        case 'create': result = await client.createRouteConnection(args.routeId, args.data); break;
        case 'update': result = await client.updateRouteConnection(args.routeId, args.index, args.data); break;
        case 'delete': result = await client.deleteRouteConnection(args.routeId, args.index); break;
        case 'count': result = await client.countRouteConnections(); break;
        default: return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Unknown action: ${args.action}` }, null, 2) }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Route connection ${args.action} successful` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'manage_domain_connections': {
      let result;
      switch (args.action) {
        case 'list': result = await client.listDomainConnections(args.domain); break;
        case 'get': result = await client.getDomainConnection(args.domain, args.connectionId); break;
        case 'update': result = await client.updateDomainConnection(args.domain, args.connectionId, args.data); break;
        case 'delete': result = await client.deleteDomainConnection(args.domain, args.connectionId); break;
        default: return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Unknown action: ${args.action}` }, null, 2) }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Domain connection ${args.action} successful` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'count_routes': {
      const result = await client.countRoutes();
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Counted routes' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    default:
      return null;
  }
}
