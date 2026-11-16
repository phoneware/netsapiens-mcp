/**
 * How a user proves who they are to this server.
 *
 * - `oauth`: the operator provisions a NetSapiens OAuth client. Users sign in with a
 *   username and password (and MFA), or paste a token. The server can refresh the
 *   upstream token itself.
 * - `token`: no OAuth client exists. Users paste a NetSapiens API key or token for
 *   their own user. The server holds no upstream credential and never refreshes: a
 *   revoked or expired key ends the session.
 */
export type AuthMode = 'oauth' | 'token';

export function parseAuthMode(raw: string | undefined): AuthMode {
 if (raw === undefined || raw.trim() === '') return 'oauth';
 const value = raw.trim().toLowerCase();
 if (value === 'oauth' || value === 'token') return value;
 throw new Error(`ConfigError: NETSAPIENS_AUTH_MODE must be oauth or token, got "${raw}"`);
}
