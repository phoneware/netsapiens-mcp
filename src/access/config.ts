/**
 * Access registry configuration (docs/access-registry.md, "Auth modes"; spec section 3.9).
 *
 * The registry is off unless MCP_ACCESS_REGISTRY_URL is set. Once it is set, every registry variable is validated
 * here, and a malformed or unrecognised value is a ConfigError rather than a silent default. Only
 * readAccessRegistryEnv reads these variables from the process environment.
 */

export const DEFAULT_ACCESS_REGISTRY_CONNECTOR = 'netsapiens-mcp';
export const DEFAULT_ACCESS_REGISTRY_MAX_STALE_SECONDS = 600;
export const DEFAULT_ACCESS_REGISTRY_TIMEOUT_MS = 3000;

/** The raw registry variables. Undefined means the variable is not set. */
export interface AccessRegistryEnv {
  readonly MCP_ACCESS_REGISTRY_URL?: string;
  readonly MCP_ACCESS_REGISTRY_AUTH?: string;
  readonly MCP_ACCESS_REGISTRY_TOKEN?: string;
  readonly MCP_ACCESS_REGISTRY_AUDIENCE?: string;
  readonly MCP_ACCESS_REGISTRY_CONNECTOR?: string;
  readonly MCP_ACCESS_REGISTRY_MAX_STALE_SECONDS?: string;
  readonly MCP_ACCESS_REGISTRY_TIMEOUT_MS?: string;
}

export type AccessRegistryAuthConfig =
  | { readonly mode: 'none' }
  | { readonly mode: 'bearer'; readonly token: string }
  | { readonly mode: 'google-id-token'; readonly audience: string };

export interface EnabledAccessRegistryConfig {
  readonly enabled: true;
  /** Registry base URL without a trailing slash. The decision path is appended to it. */
  readonly baseUrl: string;
  readonly auth: AccessRegistryAuthConfig;
  readonly connector: string;
  /** Last-known-good window in seconds, 0 to 3600. Local only: the registry cannot extend it. */
  readonly maxStaleSeconds: number;
  readonly timeoutMs: number;
}

export type AccessRegistryConfig = { readonly enabled: false } | EnabledAccessRegistryConfig;

const MAX_STALE_SECONDS_MAX = 3600;
const TIMEOUT_MS_MIN = 500;
const TIMEOUT_MS_MAX = 30_000;
const CONNECTOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;

/** Loopback host names, as the redirect rules in redirect.ts accept them. */
const LOOPBACK_HOSTS: Record<string, true> = { localhost: true, '127.0.0.1': true, '[::1]': true, '::1': true };

/** Reads the registry variables from the process environment. This is the only place that does. */
export function readAccessRegistryEnv(): AccessRegistryEnv {
  return {
    MCP_ACCESS_REGISTRY_URL: process.env.MCP_ACCESS_REGISTRY_URL,
    MCP_ACCESS_REGISTRY_AUTH: process.env.MCP_ACCESS_REGISTRY_AUTH,
    MCP_ACCESS_REGISTRY_TOKEN: process.env.MCP_ACCESS_REGISTRY_TOKEN,
    MCP_ACCESS_REGISTRY_AUDIENCE: process.env.MCP_ACCESS_REGISTRY_AUDIENCE,
    MCP_ACCESS_REGISTRY_CONNECTOR: process.env.MCP_ACCESS_REGISTRY_CONNECTOR,
    MCP_ACCESS_REGISTRY_MAX_STALE_SECONDS: process.env.MCP_ACCESS_REGISTRY_MAX_STALE_SECONDS,
    MCP_ACCESS_REGISTRY_TIMEOUT_MS: process.env.MCP_ACCESS_REGISTRY_TIMEOUT_MS,
  };
}

/**
 * Validates the registry variables. Returns the disabled configuration when MCP_ACCESS_REGISTRY_URL is unset, and
 * then ignores every other registry variable. Throws a ConfigError for anything malformed.
 */
export function loadAccessRegistryConfig(env: AccessRegistryEnv = readAccessRegistryEnv()): AccessRegistryConfig {
  if (env.MCP_ACCESS_REGISTRY_URL === undefined) return { enabled: false };
  const url = parseRegistryUrl(env.MCP_ACCESS_REGISTRY_URL);
  return {
    enabled: true,
    baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, '')}`,
    auth: parseAuth(env, url),
    connector: parseConnector(env.MCP_ACCESS_REGISTRY_CONNECTOR),
    maxStaleSeconds: parseWholeNumber(
      'MCP_ACCESS_REGISTRY_MAX_STALE_SECONDS',
      env.MCP_ACCESS_REGISTRY_MAX_STALE_SECONDS,
      DEFAULT_ACCESS_REGISTRY_MAX_STALE_SECONDS,
      0,
      MAX_STALE_SECONDS_MAX,
    ),
    timeoutMs: parseWholeNumber(
      'MCP_ACCESS_REGISTRY_TIMEOUT_MS',
      env.MCP_ACCESS_REGISTRY_TIMEOUT_MS,
      DEFAULT_ACCESS_REGISTRY_TIMEOUT_MS,
      TIMEOUT_MS_MIN,
      TIMEOUT_MS_MAX,
    ),
  };
}

/**
 * Refuses a registry configured under a transport that cannot enforce it. Stdio would run without the registry, so
 * it would fail open; the server exits instead. Called before any other startup work.
 */
export function assertAccessRegistryTransport(transport: string, env: AccessRegistryEnv = readAccessRegistryEnv()): void {
  if (env.MCP_ACCESS_REGISTRY_URL !== undefined && transport !== 'http') {
    throw configError(
      'MCP_ACCESS_REGISTRY_URL requires MCP_TRANSPORT=http; stdio cannot enforce the access registry, so it would fail open',
    );
  }
}

function configError(message: string): Error {
  return new Error(`ConfigError: ${message}`);
}

function parseRegistryUrl(raw: string): URL {
  if (raw !== raw.trim() || raw.includes('?') || raw.includes('#')) throw invalidRegistryUrl();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalidRegistryUrl();
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw invalidRegistryUrl();
  if (url.username !== '' || url.password !== '') throw invalidRegistryUrl();
  if (url.protocol === 'http:' && LOOPBACK_HOSTS[url.hostname] !== true) {
    throw configError('MCP_ACCESS_REGISTRY_URL must use https unless it is a loopback address');
  }
  return url;
}

function invalidRegistryUrl(): Error {
  return configError('MCP_ACCESS_REGISTRY_URL must be an absolute https URL with no credentials, query or fragment');
}

function parseAuth(env: AccessRegistryEnv, url: URL): AccessRegistryAuthConfig {
  const mode = env.MCP_ACCESS_REGISTRY_AUTH;
  if (mode === undefined) {
    throw configError(
      'MCP_ACCESS_REGISTRY_AUTH is required when MCP_ACCESS_REGISTRY_URL is set; use bearer, google-id-token or none',
    );
  }
  if (mode === 'bearer') {
    const token = env.MCP_ACCESS_REGISTRY_TOKEN;
    if (token === undefined || token === '') {
      throw configError('MCP_ACCESS_REGISTRY_TOKEN is required when MCP_ACCESS_REGISTRY_AUTH is bearer');
    }
    if (!VISIBLE_ASCII.test(token)) throw configError('MCP_ACCESS_REGISTRY_TOKEN must be visible ASCII with no spaces');
    return { mode: 'bearer', token };
  }
  if (mode === 'google-id-token') {
    const audience = env.MCP_ACCESS_REGISTRY_AUDIENCE;
    if (audience === undefined || audience === '') {
      throw configError('MCP_ACCESS_REGISTRY_AUDIENCE is required when MCP_ACCESS_REGISTRY_AUTH is google-id-token');
    }
    if (!VISIBLE_ASCII.test(audience)) {
      throw configError('MCP_ACCESS_REGISTRY_AUDIENCE must be visible ASCII with no spaces');
    }
    return { mode: 'google-id-token', audience };
  }
  if (mode === 'none') {
    if (LOOPBACK_HOSTS[url.hostname] !== true) {
      throw configError('MCP_ACCESS_REGISTRY_AUTH none is permitted only for a loopback MCP_ACCESS_REGISTRY_URL');
    }
    return { mode: 'none' };
  }
  throw configError('MCP_ACCESS_REGISTRY_AUTH must be bearer, google-id-token or none');
}

function parseConnector(raw: string | undefined): string {
  if (raw === undefined) return DEFAULT_ACCESS_REGISTRY_CONNECTOR;
  if (!CONNECTOR_PATTERN.test(raw)) {
    throw configError(
      'MCP_ACCESS_REGISTRY_CONNECTOR must be 1 to 64 letters, digits, periods, underscores or hyphens, starting with a letter or digit',
    );
  }
  return raw;
}

function parseWholeNumber(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw configError(`${name} must be a whole number from ${min} to ${max}`);
  }
  return value;
}
