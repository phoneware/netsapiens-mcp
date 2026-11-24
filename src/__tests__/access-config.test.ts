import { describe, expect, it } from 'vitest';
import {
  assertAccessRegistryTransport,
  loadAccessRegistryConfig,
  readAccessRegistryEnv,
  type AccessRegistryEnv,
} from '../access/config.js';

const BEARER: AccessRegistryEnv = {
  MCP_ACCESS_REGISTRY_URL: 'https://registry.example.com',
  MCP_ACCESS_REGISTRY_AUTH: 'bearer',
  MCP_ACCESS_REGISTRY_TOKEN: 'static-token-value',
};

const REGISTRY_NAMES = [
  'MCP_ACCESS_REGISTRY_URL',
  'MCP_ACCESS_REGISTRY_AUTH',
  'MCP_ACCESS_REGISTRY_TOKEN',
  'MCP_ACCESS_REGISTRY_AUDIENCE',
  'MCP_ACCESS_REGISTRY_CONNECTOR',
  'MCP_ACCESS_REGISTRY_MAX_STALE_SECONDS',
  'MCP_ACCESS_REGISTRY_TIMEOUT_MS',
] as const;

const URL_MESSAGE =
  'ConfigError: MCP_ACCESS_REGISTRY_URL must be an absolute https URL with no credentials, query or fragment';
const HTTP_MESSAGE = 'ConfigError: MCP_ACCESS_REGISTRY_URL must use https unless it is a loopback address';
const AUTH_REQUIRED =
  'ConfigError: MCP_ACCESS_REGISTRY_AUTH is required when MCP_ACCESS_REGISTRY_URL is set; use bearer, google-id-token or none';
const AUTH_INVALID = 'ConfigError: MCP_ACCESS_REGISTRY_AUTH must be bearer, google-id-token or none';
const TOKEN_REQUIRED = 'ConfigError: MCP_ACCESS_REGISTRY_TOKEN is required when MCP_ACCESS_REGISTRY_AUTH is bearer';
const TOKEN_INVALID = 'ConfigError: MCP_ACCESS_REGISTRY_TOKEN must be visible ASCII with no spaces';
const AUDIENCE_REQUIRED =
  'ConfigError: MCP_ACCESS_REGISTRY_AUDIENCE is required when MCP_ACCESS_REGISTRY_AUTH is google-id-token';
const AUDIENCE_INVALID = 'ConfigError: MCP_ACCESS_REGISTRY_AUDIENCE must be visible ASCII with no spaces';
const NONE_NOT_LOOPBACK =
  'ConfigError: MCP_ACCESS_REGISTRY_AUTH none is permitted only for a loopback MCP_ACCESS_REGISTRY_URL';
const CONNECTOR_INVALID =
  'ConfigError: MCP_ACCESS_REGISTRY_CONNECTOR must be 1 to 64 letters, digits, periods, underscores or hyphens, starting with a letter or digit';
const STALE_RANGE = 'ConfigError: MCP_ACCESS_REGISTRY_MAX_STALE_SECONDS must be a whole number from 0 to 3600';
const TIMEOUT_RANGE = 'ConfigError: MCP_ACCESS_REGISTRY_TIMEOUT_MS must be a whole number from 500 to 30000';
const STDIO_REFUSAL =
  'ConfigError: MCP_ACCESS_REGISTRY_URL requires MCP_TRANSPORT=http; stdio cannot enforce the access registry, so it would fail open';

describe('access registry configuration', () => {
  it('is disabled when the URL is unset, and ignores every other registry variable', () => {
    expect(loadAccessRegistryConfig({})).toEqual({ enabled: false });
    expect(
      loadAccessRegistryConfig({
        MCP_ACCESS_REGISTRY_AUTH: 'magic',
        MCP_ACCESS_REGISTRY_TOKEN: 'two words',
        MCP_ACCESS_REGISTRY_CONNECTOR: '',
        MCP_ACCESS_REGISTRY_MAX_STALE_SECONDS: 'soon',
        MCP_ACCESS_REGISTRY_TIMEOUT_MS: '1',
      }),
    ).toEqual({ enabled: false });
  });

  it('applies the documented defaults to a bearer configuration', () => {
    expect(loadAccessRegistryConfig(BEARER)).toEqual({
      enabled: true,
      baseUrl: 'https://registry.example.com',
      auth: { mode: 'bearer', token: 'static-token-value' },
      connector: 'netsapiens-mcp',
      maxStaleSeconds: 600,
      timeoutMs: 3000,
    });
  });

  it('reads every value it is given', () => {
    expect(
      loadAccessRegistryConfig({
        ...BEARER,
        MCP_ACCESS_REGISTRY_CONNECTOR: 'lab.connector_1',
        MCP_ACCESS_REGISTRY_MAX_STALE_SECONDS: '120',
        MCP_ACCESS_REGISTRY_TIMEOUT_MS: '4500',
      }),
    ).toMatchObject({ connector: 'lab.connector_1', maxStaleSeconds: 120, timeoutMs: 4500 });
  });

  it('normalizes the base URL: lowercase host, default port dropped, trailing slash dropped, path kept', () => {
    expect(
      loadAccessRegistryConfig({ ...BEARER, MCP_ACCESS_REGISTRY_URL: 'HTTPS://Registry.Example.com:443/prefix/' }),
    ).toMatchObject({ baseUrl: 'https://registry.example.com/prefix' });
    expect(
      loadAccessRegistryConfig({ ...BEARER, MCP_ACCESS_REGISTRY_URL: 'https://registry.example.com:8443' }),
    ).toMatchObject({ baseUrl: 'https://registry.example.com:8443' });
  });

  it('accepts the google identity token mode with an audience', () => {
    expect(
      loadAccessRegistryConfig({
        MCP_ACCESS_REGISTRY_URL: 'https://registry.example.com',
        MCP_ACCESS_REGISTRY_AUTH: 'google-id-token',
        MCP_ACCESS_REGISTRY_AUDIENCE: 'https://registry.example.com/',
      }),
    ).toMatchObject({ enabled: true, auth: { mode: 'google-id-token', audience: 'https://registry.example.com/' } });
  });

  it.each(['http://127.0.0.1:8080', 'http://localhost:9000/registry', 'http://[::1]:7000', 'https://localhost'])(
    'accepts auth none for the loopback URL %s',
    (url) => {
      expect(loadAccessRegistryConfig({ MCP_ACCESS_REGISTRY_URL: url, MCP_ACCESS_REGISTRY_AUTH: 'none' })).toMatchObject({
        enabled: true,
        auth: { mode: 'none' },
      });
    },
  );

  it.each([
    [{ MCP_ACCESS_REGISTRY_MAX_STALE_SECONDS: '0' }, { maxStaleSeconds: 0 }],
    [{ MCP_ACCESS_REGISTRY_MAX_STALE_SECONDS: '3600' }, { maxStaleSeconds: 3600 }],
    [{ MCP_ACCESS_REGISTRY_TIMEOUT_MS: '500' }, { timeoutMs: 500 }],
    [{ MCP_ACCESS_REGISTRY_TIMEOUT_MS: '30000' }, { timeoutMs: 30000 }],
    [{ MCP_ACCESS_REGISTRY_CONNECTOR: 'c'.repeat(64) }, { connector: 'c'.repeat(64) }],
  ])('accepts the bound %o', (patch, expected) => {
    expect(loadAccessRegistryConfig({ ...BEARER, ...patch })).toMatchObject(expected);
  });

  it.each([
    [{ MCP_ACCESS_REGISTRY_URL: 'registry.example.com' }, URL_MESSAGE],
    [{ MCP_ACCESS_REGISTRY_URL: 'ftp://registry.example.com' }, URL_MESSAGE],
    [{ MCP_ACCESS_REGISTRY_URL: '' }, URL_MESSAGE],
    [{ MCP_ACCESS_REGISTRY_URL: ' https://registry.example.com' }, URL_MESSAGE],
    [{ MCP_ACCESS_REGISTRY_URL: 'https://user:secret@registry.example.com' }, URL_MESSAGE],
    [{ MCP_ACCESS_REGISTRY_URL: 'https://registry.example.com/?x=1' }, URL_MESSAGE],
    [{ MCP_ACCESS_REGISTRY_URL: 'https://registry.example.com/#x' }, URL_MESSAGE],
    [{ MCP_ACCESS_REGISTRY_URL: 'http://registry.example.com' }, HTTP_MESSAGE],
    [{ MCP_ACCESS_REGISTRY_URL: 'http://10.0.0.5' }, HTTP_MESSAGE],
    [{ MCP_ACCESS_REGISTRY_AUTH: undefined }, AUTH_REQUIRED],
    [{ MCP_ACCESS_REGISTRY_AUTH: '' }, AUTH_INVALID],
    [{ MCP_ACCESS_REGISTRY_AUTH: 'Bearer' }, AUTH_INVALID],
    [{ MCP_ACCESS_REGISTRY_AUTH: 'basic' }, AUTH_INVALID],
    [{ MCP_ACCESS_REGISTRY_TOKEN: undefined }, TOKEN_REQUIRED],
    [{ MCP_ACCESS_REGISTRY_TOKEN: '' }, TOKEN_REQUIRED],
    [{ MCP_ACCESS_REGISTRY_TOKEN: 'two words' }, TOKEN_INVALID],
    [{ MCP_ACCESS_REGISTRY_TOKEN: 'caf\u00e9' }, TOKEN_INVALID],
    [{ MCP_ACCESS_REGISTRY_TOKEN: 'line\n' }, TOKEN_INVALID],
    [{ MCP_ACCESS_REGISTRY_AUTH: 'google-id-token', MCP_ACCESS_REGISTRY_TOKEN: undefined }, AUDIENCE_REQUIRED],
    [{ MCP_ACCESS_REGISTRY_AUTH: 'google-id-token', MCP_ACCESS_REGISTRY_AUDIENCE: '' }, AUDIENCE_REQUIRED],
    [{ MCP_ACCESS_REGISTRY_AUTH: 'google-id-token', MCP_ACCESS_REGISTRY_AUDIENCE: 'two words' }, AUDIENCE_INVALID],
    [{ MCP_ACCESS_REGISTRY_AUTH: 'none' }, NONE_NOT_LOOPBACK],
    [{ MCP_ACCESS_REGISTRY_CONNECTOR: '' }, CONNECTOR_INVALID],
    [{ MCP_ACCESS_REGISTRY_CONNECTOR: 'two words' }, CONNECTOR_INVALID],
    [{ MCP_ACCESS_REGISTRY_CONNECTOR: '-leading' }, CONNECTOR_INVALID],
    [{ MCP_ACCESS_REGISTRY_CONNECTOR: 'c'.repeat(65) }, CONNECTOR_INVALID],
    [{ MCP_ACCESS_REGISTRY_MAX_STALE_SECONDS: '-1' }, STALE_RANGE],
    [{ MCP_ACCESS_REGISTRY_MAX_STALE_SECONDS: '3601' }, STALE_RANGE],
    [{ MCP_ACCESS_REGISTRY_MAX_STALE_SECONDS: '10s' }, STALE_RANGE],
    [{ MCP_ACCESS_REGISTRY_MAX_STALE_SECONDS: '' }, STALE_RANGE],
    [{ MCP_ACCESS_REGISTRY_TIMEOUT_MS: '499' }, TIMEOUT_RANGE],
    [{ MCP_ACCESS_REGISTRY_TIMEOUT_MS: '30001' }, TIMEOUT_RANGE],
    [{ MCP_ACCESS_REGISTRY_TIMEOUT_MS: '3e3' }, TIMEOUT_RANGE],
  ])('refuses %o with its ConfigError', (patch, message) => {
    expect(() => loadAccessRegistryConfig({ ...BEARER, ...patch })).toThrow(new Error(message));
  });

  it('reads the registry variables from the process environment', () => {
    const saved = REGISTRY_NAMES.map((name) => [name, process.env[name]] as const);
    try {
      process.env.MCP_ACCESS_REGISTRY_URL = 'https://registry.example.com';
      process.env.MCP_ACCESS_REGISTRY_AUTH = 'bearer';
      process.env.MCP_ACCESS_REGISTRY_TOKEN = 'env-token';
      process.env.MCP_ACCESS_REGISTRY_AUDIENCE = 'env-audience';
      process.env.MCP_ACCESS_REGISTRY_CONNECTOR = 'env-connector';
      process.env.MCP_ACCESS_REGISTRY_MAX_STALE_SECONDS = '30';
      process.env.MCP_ACCESS_REGISTRY_TIMEOUT_MS = '1000';
      expect(readAccessRegistryEnv()).toEqual({
        MCP_ACCESS_REGISTRY_URL: 'https://registry.example.com',
        MCP_ACCESS_REGISTRY_AUTH: 'bearer',
        MCP_ACCESS_REGISTRY_TOKEN: 'env-token',
        MCP_ACCESS_REGISTRY_AUDIENCE: 'env-audience',
        MCP_ACCESS_REGISTRY_CONNECTOR: 'env-connector',
        MCP_ACCESS_REGISTRY_MAX_STALE_SECONDS: '30',
        MCP_ACCESS_REGISTRY_TIMEOUT_MS: '1000',
      });
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('refuses a registry configured under a transport other than http, before anything else runs', () => {
    expect(() => assertAccessRegistryTransport('stdio', BEARER)).toThrow(new Error(STDIO_REFUSAL));
    expect(() => assertAccessRegistryTransport('HTTP', BEARER)).toThrow(new Error(STDIO_REFUSAL));
    expect(() => assertAccessRegistryTransport('http', BEARER)).not.toThrow();
  });

  it('does not refuse stdio when the registry URL is unset', () => {
    expect(() => assertAccessRegistryTransport('stdio', {})).not.toThrow();
    expect(() => assertAccessRegistryTransport('stdio', { MCP_ACCESS_REGISTRY_AUTH: 'magic' })).not.toThrow();
  });
});
