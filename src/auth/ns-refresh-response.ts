import { UpstreamUnavailableError } from './kit/errors.js';

export interface NsRefreshResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

/** A malformed upstream success is ambiguous, not proof that a refresh succeeded. */
export function parseNsRefreshResponse(data: unknown): NsRefreshResponse {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new UpstreamUnavailableError('Upstream refresh returned an invalid token response');
  }
  const { access_token, refresh_token, expires_in } = data as Record<string, unknown>;
  if (typeof access_token !== 'string' || !access_token.trim()
    || typeof expires_in !== 'number' || !Number.isSafeInteger(expires_in) || expires_in <= 0
    || (refresh_token != null && (typeof refresh_token !== 'string' || !refresh_token.trim()))) {
    throw new UpstreamUnavailableError('Upstream refresh returned an invalid token response');
  }
  return typeof refresh_token === 'string'
    ? { access_token, refresh_token, expires_in }
    : { access_token, expires_in };
}
