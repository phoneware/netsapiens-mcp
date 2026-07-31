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
    /**
     * Send as multipart/form-data with one file part instead of JSON. Only the
     * hold-message endpoints need this: they accept nothing but an upload and,
     * unlike greetings and music-on-hold, have no text-to-speech or base64
     * variant to fall back on.
     */
    multipart?: { field: string; filename: string; base64: string; contentType?: string };
  }): Promise<NetSapiensApiResponse<T>>;
}

export interface ToolDefinition {
  schema: { name: string; description: string; inputSchema: object };
  handler: (args: Record<string, unknown>, client: GenericApiClient) => Promise<CallToolResult>;
}
