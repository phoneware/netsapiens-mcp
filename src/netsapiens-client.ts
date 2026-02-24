import axios, { AxiosInstance } from 'axios';
import { NetSapiensConfig, NetSapiensApiResponse } from './types/config.js';

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  pathTemplate: string;
  pathParams?: Record<string, string>;
  queryParams?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface GenericApiClient {
  request<T = unknown>(options: RequestOptions): Promise<NetSapiensApiResponse<T>>;
}

function interpolatePath(
  template: string,
  params: Record<string, string> | undefined
): string {
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    if (!params || !(key in params)) {
      throw new Error(`Missing required path parameter: ${key}`);
    }
    return encodeURIComponent(params[key]);
  });
}

function buildQueryString(
  params: Record<string, string | number | boolean | undefined> | undefined
): string {
  if (!params) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

export function createApiClient(
  config: NetSapiensConfig,
  tokenProvider: () => Promise<string>
): GenericApiClient {
  const client: AxiosInstance = axios.create({
    baseURL: `${config.apiUrl}/ns-api/v2`,
    timeout: config.timeout ?? 30000,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'OITVOIP-MCP-Server/1.0.0',
    },
  });

  client.interceptors.request.use(async (reqConfig) => {
    const token = await tokenProvider();
    reqConfig.headers.Authorization = `Bearer ${token}`;
    return reqConfig;
  });

  return {
    async request<T = unknown>(
      options: RequestOptions
    ): Promise<NetSapiensApiResponse<T>> {
      try {
        const path = interpolatePath(options.pathTemplate, options.pathParams);
        const qs = buildQueryString(options.queryParams);
        const url = `${path}${qs}`;

        const response = await client.request<T>({
          method: options.method,
          url,
          data: options.body,
          headers: options.headers,
        });

        return {
          success: true,
          data: response.data,
          message: 'OK',
        };
      } catch (error: any) {
        if (error.response) {
          return {
            success: false,
            error: error.message,
            message: 'Request failed',
          };
        }
        return {
          success: false,
          error: error.message,
          message: 'Network error',
        };
      }
    },
  };
}
