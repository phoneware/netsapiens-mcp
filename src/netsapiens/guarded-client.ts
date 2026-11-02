import type { NetSapiensClient } from '../netsapiens-client.js';
import type { GenericApiClient, NetSapiensApiResponse } from '../generated/types.js';
import { normalizeOperationKey } from './operation-key.js';
import type { AvailabilityContext } from './availability.js';

export class GuardedNetSapiensClient implements GenericApiClient {
  constructor(
    public readonly rawClient: NetSapiensClient,
    public readonly availabilityContext: AvailabilityContext,
  ) {}

  async request<T = unknown>(opts: {
    method: string;
    pathTemplate: string;
    pathParams?: Record<string, string>;
    queryParams?: Record<string, unknown>;
    body?: unknown;
    multipart?: { field: string; filename: string; base64: string; contentType?: string };
  }): Promise<NetSapiensApiResponse<T>> {
    const key = normalizeOperationKey(opts.method, opts.pathTemplate);
    if (!this.availabilityContext.isAvailable(key)) {
      const version = this.availabilityContext.versionInfo?.apiVersion ?? 'unknown';
      throw new Error(`Operation '${key}' is not available on this NetSapiens host (reported release: ${version}).`);
    }
    return this.rawClient.request<T>(opts);
  }
}

/**
 * Creates a guarded wrapper around a NetSapiensClient.
 * Intercepts `request(...)` to assert that the operation is available on the host
 * before any HTTP call is dispatched.
 */
export function createGuardedClient(
  rawClient: NetSapiensClient,
  availabilityContext: AvailabilityContext,
): NetSapiensClient {
  // If already a guarded proxy, avoid double-wrapping
  const targetClient = '__rawClient' in rawClient && rawClient.__rawClient
    ? (rawClient.__rawClient as NetSapiensClient)
    : rawClient;
  return new Proxy(targetClient, {
    get(target, prop, receiver) {
      if (prop === '__rawClient' || prop === 'rawClient') {
        return target;
      }
      if (prop === '__availabilityContext' || prop === 'availabilityContext') {
        return availabilityContext;
      }
      if (prop === 'request') {
        return async function guardedRequest<T = unknown>(opts: {
          method: string;
          pathTemplate: string;
          pathParams?: Record<string, string>;
          queryParams?: Record<string, unknown>;
          body?: unknown;
          multipart?: { field: string; filename: string; base64: string; contentType?: string };
        }): Promise<NetSapiensApiResponse<T>> {
          const key = normalizeOperationKey(opts.method, opts.pathTemplate);
          if (!availabilityContext.isAvailable(key)) {
            const version = availabilityContext.versionInfo?.apiVersion ?? 'unknown';
            throw new Error(`Operation '${key}' is not available on this NetSapiens host (reported release: ${version}).`);
          }
          return target.request<T>(opts);
        };
      }
      const val = Reflect.get(target, prop, receiver);
      if (typeof val === 'function') {
        return val.bind(target);
      }
      return val;
    },
  });
}
