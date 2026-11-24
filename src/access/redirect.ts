/**
 * Redirect URIs permitted by a registry platform list (docs/access-registry.md, "Platforms and redirect URIs").
 *
 * Host rules follow the monorepo's mcp-oauth-kit redirect policy: loopback is matched by host on any port,
 * anything else must be https with the same host and a trailing-slash-normalized path. This module also refuses
 * fragments, and any raw control character, space or backslash, which never appear in a valid URI.
 */

export const LOOPBACK_ENTRY = 'loopback';
export const ANY_ENTRY = '*';

const LOOPBACK_HOSTNAMES: Record<string, true> = {
  localhost: true,
  '127.0.0.1': true,
  '[::1]': true,
  '::1': true,
};

const FORBIDDEN_RAW_CHARS = /[\u0000-\u0020\u007f\\]/;

/** Userinfo in the authority of an absolute URI, even when empty. */
const USERINFO_IN_AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i;

/** Parses an absolute URI that carries no userinfo, no fragment and no forbidden raw character. */
function parseAbsoluteUri(raw: string): URL | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined;
  if (FORBIDDEN_RAW_CHARS.test(raw) || raw.includes('#') || USERINFO_IN_AUTHORITY.test(raw)) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.username !== '' || url.password !== '') return undefined;
  return url;
}

export type PlatformEntry =
  | { readonly kind: 'any' }
  | { readonly kind: 'loopback' }
  | { readonly kind: 'https'; readonly host: string; readonly path: string };

/** Parses one registry platform entry, or returns undefined when it is none of the three forms. */
export function parsePlatformEntry(entry: string): PlatformEntry | undefined {
  if (typeof entry !== 'string') return undefined;
  if (entry === ANY_ENTRY) return { kind: 'any' };
  if (entry === LOOPBACK_ENTRY) return { kind: 'loopback' };
  // A registered callback with a query names a different endpoint than a match that ignores the query, so it is refused.
  if (entry.includes('?')) return undefined;
  const url = parseAbsoluteUri(entry);
  if (url === undefined || url.protocol !== 'https:') return undefined;
  return { kind: 'https', host: url.host, path: url.pathname.replace(/\/+$/, '') };
}

export function isValidPlatformEntry(entry: string): boolean {
  return parsePlatformEntry(entry) !== undefined;
}

export interface RedirectMatcher {
  allows(uri: string): boolean;
}

/**
 * Builds a matcher from parsed platform entries.
 * - "*" accepts any valid URI.
 * - "loopback" accepts http or https on localhost, 127.0.0.1, [::1] or ::1, on any port and path.
 * - An https entry accepts an https URI with the same host and the same trailing-slash-normalized path.
 * A query on the candidate is ignored, as it is in the monorepo policy.
 */
export function buildRedirectMatcher(entries: readonly PlatformEntry[]): RedirectMatcher {
  const acceptsAny = entries.some((entry) => entry.kind === 'any');
  const acceptsLoopback = entries.some((entry) => entry.kind === 'loopback');
  const httpsEntries = entries.filter((entry): entry is Extract<PlatformEntry, { kind: 'https' }> => entry.kind === 'https');
  return {
    allows(uri: string): boolean {
      const candidate = parseAbsoluteUri(uri);
      if (candidate === undefined) return false;
      if (acceptsAny) return true;
      if (
        acceptsLoopback &&
        (candidate.protocol === 'http:' || candidate.protocol === 'https:') &&
        LOOPBACK_HOSTNAMES[candidate.hostname] === true
      ) {
        return true;
      }
      if (candidate.protocol !== 'https:') return false;
      const path = candidate.pathname.replace(/\/+$/, '');
      return httpsEntries.some((entry) => entry.host === candidate.host && entry.path === path);
    },
  };
}
