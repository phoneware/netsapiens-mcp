// Copied from @phoneware/mcp-oauth-kit 1.0.0 (phoneware/monorepo packages/mcp-oauth-kit/src/redirect-policy.ts at 8447d361111612739343ee0fb83a15c328db372d). Edit the canonical file, then re-copy.
/**
 * Default redirect targets permitted in addition to RFC 8252 loopback URIs.
 */
export const DEFAULT_REDIRECT_ALLOWLIST: readonly string[] = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
];

function isLoopback(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}

/**
 * Validates whether an OAuth redirect URI is permitted.
 *
 * Loopback is matched by host only (with any port) per RFC 8252 section 7.3,
 * supporting http and https.
 *
 * Remote redirect URIs must use https, contain no userinfo credentials, and
 * match an allowlisted URI exactly by protocol, host, and normalized path.
 */
export function isAllowedRedirectUri(
  raw: string,
  allowlist: readonly string[] = DEFAULT_REDIRECT_ALLOWLIST,
): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  // Redirect URIs carrying embedded credentials are never permitted.
  if (url.username || url.password) {
    return false;
  }

  if (isLoopback(url.hostname)) {
    return url.protocol === 'http:' || url.protocol === 'https:';
  }

  if (url.protocol !== 'https:') {
    return false;
  }

  const candidatePath = url.pathname.replace(/\/+$/, '');

  return allowlist.some((entry) => {
    let allowed: URL;
    try {
      allowed = new URL(entry);
    } catch {
      return false;
    }
    const allowedPath = allowed.pathname.replace(/\/+$/, '');
    return (
      allowed.protocol === url.protocol &&
      allowed.host === url.host &&
      allowedPath === candidatePath
    );
  });
}

/**
 * Validates that a client_id string is an opaque URL-safe identifier between 8 and 128 characters.
 */
export function isPlausibleClientId(value: string): boolean {
  return /^[A-Za-z0-9._~-]{8,128}$/.test(value);
}
