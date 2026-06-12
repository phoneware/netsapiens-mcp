import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface NetSapiensApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface GenericApiClient {
  request<T = unknown>(options: {
    method: string;
    pathTemplate: string;
    pathParams?: Record<string, string>;
    queryParams?: Record<string, unknown>;
    body?: unknown;
  }): Promise<NetSapiensApiResponse<T>>;
}

export interface ToolDefinition {
  schema: { name: string; description: string; inputSchema: object };
  handler: (args: Record<string, unknown>, client: GenericApiClient) => Promise<CallToolResult>;
}
