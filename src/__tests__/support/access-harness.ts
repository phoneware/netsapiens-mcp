/**
 * An HTTP harness for the access registry: the real Express app over a fake NetSapiens in token mode, an in-process
 * registry, a controllable clock, and an in-memory store whose code writes can be counted. Each harness restores the
 * environment it changed when it closes.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { vi, type MockInstance } from 'vitest';
import type { Response } from 'express';
import { startFakeNetSapiens } from '../../../scripts/fake-netsapiens/index.mjs';
import { createAccessEnforcer } from '../../access/enforcer.js';
import type { AccessEnforcer } from '../../access/types.js';
import type { NetSapiensAuthProvider } from '../../auth/netsapiens-auth-provider.js';
import type { AuthHooks } from '../../auth/types.js';
import { createApp, type CreatedHttpApp } from '../../http-server.js';
import { deriveStoreKey } from '../../store/codec.js';
import { createMemoryStore } from '../../store/memory.js';
import type { McpStore } from '../../store/types.js';
import { FakeClock, FakeRegistry, registryConfig, wireDecision, type Answer } from './access-registry-fake.js';

export const NS_SECRET = '0123456789abcdef0123456789abcdef';
/** A machine API key: NetSapiens refuses the user lookup for it and answers the key lookup instead. */
export const API_KEY = 'key-ops-7f3a';

/** The NetSapiens user behind each token. Carol's record has no domain. */
export const NS_USERS: Readonly<Record<string, Record<string, string>>> = {
  'tok-alice': { login: 'alice@domain.com', user: 'alice', domain: 'domain.com', 'user-scope': 'Office Manager' },
  'tok-bob': { login: 'bob@domain.com', user: 'bob', domain: 'domain.com', 'user-scope': 'Office Manager' },
  'tok-carol': { login: 'carol', user: 'carol', 'user-scope': 'Office Manager' },
};

/** The identity lookups a sign-in or a token check makes. Anything else is tool traffic. */
const IDENTITY_PATHS: Readonly<Record<string, true>> = {
  '/ns-api/v2/domains/~/users/~': true,
  '/ns-api/v2/apikeys/~': true,
};

interface RouteContext {
  readonly token: string | null;
}

function userLookup(token: string | null): { status: number; body: Record<string, unknown> } {
  const record = token === null || !Object.hasOwn(NS_USERS, token) ? undefined : NS_USERS[token];
  if (record === undefined) return { status: 401, body: { code: 401, message: 'Unauthorized' } };
  return { status: 200, body: record };
}

/** Routes that make the API key look like a key: no user record behind the user lookup. */
function apiKeyRoutes() {
  return [
    {
      method: 'GET',
      path: '/ns-api/v2/domains/~/users/~',
      handler: ({ token }: RouteContext) =>
        token === API_KEY
          ? { status: 400, body: { code: 400, message: 'Domain cannot be expanded for this credential' } }
          : userLookup(token),
    },
    {
      method: 'GET',
      path: '/ns-api/v2/apikeys/~',
      handler: ({ token }: RouteContext) =>
        token === API_KEY
          ? { status: 200, body: { 'key-id': 'key-ops', description: 'ops key', 'user-scope': 'Office Manager' } }
          : { status: 401, body: { code: 401, message: 'Unauthorized' } },
    },
  ];
}

export interface FakeNs {
  readonly origin: string;
  readonly requests: ReadonlyArray<{ readonly method: string; readonly path: string }>;
  close(): Promise<void>;
}

export async function startFakeNs(): Promise<FakeNs> {
  return startFakeNetSapiens({
    apiVersion: '44.4.10',
    tokens: NS_USERS,
    routeModules: [apiKeyRoutes()],
  });
}

/** Requests that are not identity lookups. A refusal must leave this list empty. */
export function toolTraffic(fake: FakeNs): string[] {
  return fake.requests.map((request) => request.path).filter((path) => !Object.hasOwn(IDENTITY_PATHS, path));
}

export interface HarnessOptions {
  readonly hooks?: AuthHooks;
  /** Set false for an unset registry: the app is built without an enforcer. */
  readonly registry?: boolean;
  /** Wraps the enforcer, for a test that must change what it reports. */
  readonly wrapAccess?: (access: AccessEnforcer) => AccessEnforcer;
  readonly stateless?: boolean;
  readonly maxStaleSeconds?: number;
  /** Reuse a store or a NetSapiens fake that another harness created. */
  readonly store?: McpStore;
  readonly fake?: FakeNs;
  /** Variables set after the defaults, for configuration tests. */
  readonly env?: Readonly<Record<string, string>>;
  /** A caller-built provider, which the app must refuse to combine with a registry. */
  readonly authProvider?: NetSapiensAuthProvider;
}

export interface Harness extends CreatedHttpApp {
  readonly fake: FakeNs;
  readonly registry: FakeRegistry;
  readonly clock: FakeClock;
  /** Counts every authorization code the provider stores. */
  readonly authCodePuts: MockInstance;
  close(): Promise<void>;
}

const openHarnesses: Harness[] = [];

/** Closes every harness a test opened, restoring the environment, and forgets them. */
export async function closeHarnesses(): Promise<void> {
  await Promise.all(openHarnesses.splice(0).map((harness) => harness.close()));
}

function restoreEnv(saved: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  Object.assign(process.env, saved);
}

/** Sets the variables the HTTP app reads when it is created. Registry variables are cleared first. */
function setServerEnv(fake: FakeNs, stateless: boolean): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('MCP_ACCESS_REGISTRY_')) delete process.env[key];
  }
  process.env.MCP_TRANSPORT = 'http';
  process.env.MCP_BASE_URL = 'http://localhost';
  process.env.NETSAPIENS_API_URL = fake.origin;
  process.env.NETSAPIENS_AUTH_MODE = 'token';
  process.env.MCP_SESSION_SECRET = NS_SECRET;
  process.env.MCP_PERSISTENCE = 'memory';
  process.env.MCP_STATELESS = stateless ? 'true' : 'false';
  delete process.env.NETSAPIENS_PLATFORMS;
  delete process.env.MCP_SECOND_FACTOR_POLICY;
  delete process.env.MCP_CONFIRM_DESTRUCTIVE;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const savedEnv = { ...process.env };
  const ownsFake = options.fake === undefined;
  const fake = options.fake ?? (await startFakeNs());
  const ownsStore = options.store === undefined;
  const store = options.store ?? createMemoryStore({ namespace: 'test', key: deriveStoreKey(NS_SECRET) });
  const registry = new FakeRegistry();
  const clock = new FakeClock();
  setServerEnv(fake, options.stateless ?? true);
  Object.assign(process.env, options.env ?? {});

  const real = createAccessEnforcer(registryConfig(options.maxStaleSeconds), {
    fetchDecision: registry.fetchDecision,
    now: clock.monotonic,
    wallNow: clock.wall,
  });
  const withRegistry = options.registry ?? true;
  const access = withRegistry ? (options.wrapAccess ? options.wrapAccess(real) : real) : undefined;

  let created: CreatedHttpApp;
  try {
    created = await createApp({ store, access, hooks: options.hooks, authProvider: options.authProvider });
  } catch (error) {
    restoreEnv(savedEnv);
    if (ownsStore) await store.close();
    if (ownsFake) await fake.close();
    throw error;
  }
  const authCodePuts = vi.spyOn(store.authCodes, 'put');

  const harness: Harness = {
    ...created,
    fake,
    registry,
    clock,
    authCodePuts,
    async close() {
      const index = openHarnesses.indexOf(harness);
      if (index !== -1) openHarnesses.splice(index, 1);
      restoreEnv(savedEnv);
      if (ownsStore) await store.close();
      if (ownsFake) await fake.close();
    },
  };
  openHarnesses.push(harness);
  return harness;
}

/** A test double for the Express response methods the provider uses when it refuses or redirects. */
export function captureResponse(): { readonly res: Response; readonly seen: { status: number; html: string; location: string } } {
  const seen = { status: 200, html: '', location: '' };
  const res = {
    status(code: number) {
      seen.status = code;
      return res;
    },
    set() {
      return res;
    },
    type() {
      return res;
    },
    send(body: string) {
      seen.html = body;
      return res;
    },
    redirect(url: string) {
      seen.location = url;
      return res;
    },
  };
  return { res: res as unknown as Response, seen };
}

/** A registry on loopback that answers from a function of the query, for the environment-configured path. */
export async function startLoopbackRegistry(answer: (query: URLSearchParams) => Answer): Promise<{
  readonly url: string;
  readonly queries: URLSearchParams[];
  close(): Promise<void>;
}> {
  const queries: URLSearchParams[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    queries.push(url.searchParams);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(wireDecision(answer(url.searchParams))));
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', () => listening.resolve());
  await listening.promise;
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    queries,
    close() {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      return closed.promise;
    },
  };
}
