/**
 * Client for the access registry decision endpoint (docs/access-registry.md, "Caching and fail-closed").
 *
 * The client does not decide access. It asks the registry, caches each answer, and reports whether the answer it
 * returns is fresh, revalidated, last known good, or unavailable. A caller treats unavailable as closed.
 * Nothing here reads the environment: config.ts does that and passes plain values in.
 *
 * A text body is parsed with parseRegistryDecisionText, and an embedder's parsed value with parseRegistryDecisionValue.
 */
import { DEFAULT_ACCESS_REGISTRY_MAX_STALE_SECONDS, DEFAULT_ACCESS_REGISTRY_TIMEOUT_MS } from './config.js';
import type { AccessRegistryAuthConfig, EnabledAccessRegistryConfig } from './config.js';
import {
  parseRegistryDecisionText,
  parseRegistryDecisionValue,
  type AccessDecisionV1,
  type ParseRegistryDecisionResult,
  type RegistryDecisionErrorClass,
} from './contract.js';
import type { AccessTier } from './types.js';
import { logger } from '../utils/logger.js';

/** Path of the decision endpoint, appended to the registry base URL. */
export const DECISION_PATH = '/v1/decision';
/** The largest decision or identity token body the client reads. A longer body is oversize. */
export const MAX_BODY_BYTES = 64 * 1024;
/** Cache capacity when none is given. */
export const DEFAULT_MAX_ENTRIES = 10_000;
/** Google's instance metadata endpoint, which mints identity tokens. */
export const METADATA_IDENTITY_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity';

const MIN_TTL_SECONDS = 5;
const MAX_TTL_SECONDS = 300;
/** A minted identity token is replaced this long before its exp claim. */
const TOKEN_REFRESH_MARGIN_MS = 300_000;
/** At most one warning per key in this window. Later errors for that key are logged at debug. */
const WARN_INTERVAL_MS = 60_000;
/** The longest delay setTimeout accepts. */
const MAX_TIMER_MS = 2_147_483_647;
const SAFE_REASON = /^[A-Za-z0-9_.:-]{1,64}$/;
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;

/** Why a registry answer was not used. */
export type RegistryErrorClass =
  | RegistryDecisionErrorClass
  | 'timeout'
  | 'network'
  | 'http_status'
  | 'oversize'
  | 'auth';

/** Where a result came from. Fresh, revalidated and lkg carry a decision. Unavailable carries none. */
export type RegistrySource = 'fresh' | 'revalidated' | 'lkg' | 'unavailable';

/** The facts the registry decides on. Equal queries share one cache entry. */
export interface RegistryQuery {
  readonly platform: string;
  readonly tenant: string;
  readonly subject: string;
  readonly role: string;
  readonly tier: AccessTier;
}

export interface RegistryKey extends RegistryQuery {
  readonly connector: string;
}

export interface RegistryResult {
  readonly source: RegistrySource;
  /** Allow or deny, for fresh, revalidated and lkg. */
  readonly decision?: AccessDecisionV1;
  /** Why the registry answer was not used. Present for lkg and unavailable. */
  readonly errorClass?: RegistryErrorClass;
}

/**
 * What one registry request returned, before the client judges it. A `text` body is the body of a 200 response, which
 * the client parses with parseRegistryDecisionText. A `value` is an already-parsed JSON value an embedder supplies,
 * which the client checks with parseRegistryDecisionValue.
 */
export type RegistryResponse =
  | { readonly kind: 'text'; readonly body: string }
  | { readonly kind: 'value'; readonly value: unknown }
  | { readonly kind: 'not_modified' }
  | { readonly kind: 'failure'; readonly errorClass: RegistryErrorClass; readonly httpStatus?: number };

export interface RegistryRequest {
  readonly key: RegistryKey;
  /** The quoted revision for If-None-Match. Present only when revalidating a cached answer. */
  readonly ifNoneMatch?: string;
  /** Aborted when the client's timeout fires. */
  readonly signal: AbortSignal;
}

/**
 * Makes one registry request. The HTTP transport is the default, and library embedders may supply their own.
 * A throw counts as a network error. A decision arrives as text or as a value; see RegistryResponse.
 */
export type FetchDecision = (request: RegistryRequest) => Promise<RegistryResponse>;

export type Clock = () => number;

/** The fetch shape the HTTP transport uses. Tests inject their own. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface RegistryClientOptions {
  readonly connector: string;
  readonly fetchDecision: FetchDecision;
  /** Milliseconds since the epoch. Defaults to Date.now. */
  readonly now?: Clock;
  /** Per-request timeout in milliseconds. Defaults to 3000. */
  readonly timeoutMs?: number;
  /** Last-known-good window in milliseconds. Defaults to 600000. */
  readonly maxStaleMs?: number;
  /** Most answers held at once. The least recently used is evicted first. Defaults to 10000. */
  readonly maxEntries?: number;
}

interface CacheEntry {
  readonly decision: AccessDecisionV1;
  /** Send time of the request that last confirmed the decision. */
  readonly validatedAt: number;
  /** How long the entry stays fresh after validatedAt. */
  readonly freshForMs: number;
}

interface Outcome {
  readonly source: RegistrySource;
  readonly decision?: AccessDecisionV1;
  readonly errorClass?: RegistryErrorClass;
  readonly httpStatus?: number;
  readonly latencyMs?: number;
  readonly ageMs?: number;
}

type Judgement =
  | { readonly ok: true; readonly httpStatus?: number; readonly entry: CacheEntry }
  | { readonly ok: false; readonly errorClass: RegistryErrorClass; readonly httpStatus?: number };

/** A bounded map that evicts the least recently used key once it is full. */
class LruCache<V> {
  private readonly capacity: number;
  private readonly entries = new Map<string, V>();

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }
}

export class RegistryClient {
  private readonly connector: string;
  private readonly fetchDecision: FetchDecision;
  private readonly clock: Clock;
  private readonly timeoutMs: number;
  private readonly maxStaleMs: number;
  private readonly cache: LruCache<CacheEntry>;
  private readonly lastWarning: LruCache<number>;
  /** One pending registry round trip per cache key. Concurrent callers share it. */
  private readonly inflight = new Map<string, Promise<RegistryResult>>();

  constructor(options: RegistryClientOptions) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_ACCESS_REGISTRY_TIMEOUT_MS;
    const maxStaleMs = options.maxStaleMs ?? DEFAULT_ACCESS_REGISTRY_MAX_STALE_SECONDS * 1000;
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!(timeoutMs > 0 && timeoutMs <= MAX_TIMER_MS) || !(maxStaleMs >= 0) || !(maxEntries >= 1)) {
      throw new RangeError('RegistryClient: timeoutMs must be positive, maxStaleMs not negative, maxEntries at least 1');
    }
    this.connector = options.connector;
    this.fetchDecision = options.fetchDecision;
    this.clock = options.now ?? Date.now;
    this.timeoutMs = timeoutMs;
    this.maxStaleMs = maxStaleMs;
    this.cache = new LruCache<CacheEntry>(maxEntries);
    this.lastWarning = new LruCache<number>(maxEntries);
  }

  /** Answers held in the cache. For diagnostics and tests. */
  get cacheSize(): number {
    return this.cache.size;
  }

  /**
   * The registry's answer for a query: from the cache while it is fresh, otherwise from the registry. A stale answer
   * is revalidated, and concurrent callers for one key share one request.
   */
  async decide(query: RegistryQuery): Promise<RegistryResult> {
    const key: RegistryKey = {
      connector: this.connector,
      platform: query.platform,
      tenant: query.tenant,
      subject: query.subject,
      role: query.role,
      tier: query.tier,
    };
    const id = JSON.stringify([key.connector, key.platform, key.tenant, key.subject, key.role, key.tier]);
    const entry = this.cache.get(id);
    const at = this.clock();
    if (entry !== undefined && at < entry.validatedAt + entry.freshForMs) {
      this.report(key, id, 'debug', { source: 'fresh', decision: entry.decision, ageMs: at - entry.validatedAt });
      return { source: 'fresh', decision: entry.decision };
    }
    let pending = this.inflight.get(id);
    if (pending === undefined) {
      pending = this.refresh(key, id, entry).finally(() => {
        this.inflight.delete(id);
      });
      this.inflight.set(id, pending);
    }
    return pending;
  }

  /** One registry round trip for a key, then the cache and the fail-closed rules. Never rejects. */
  private async refresh(key: RegistryKey, id: string, previous: CacheEntry | undefined): Promise<RegistryResult> {
    const startedAt = this.clock();
    const ifNoneMatch = previous === undefined ? undefined : `"${previous.decision.revision}"`;
    const response = await this.attempt(key, ifNoneMatch);
    const latencyMs = this.clock() - startedAt;
    const judged = interpret(response, previous, startedAt);
    if (judged.ok) {
      this.cache.set(id, judged.entry);
      const source: RegistrySource = previous === undefined ? 'fresh' : 'revalidated';
      this.report(key, id, 'info', {
        source,
        decision: judged.entry.decision,
        httpStatus: judged.httpStatus,
        latencyMs,
        ageMs: previous === undefined ? undefined : startedAt - previous.validatedAt,
      });
      return { source, decision: judged.entry.decision };
    }
    const at = this.clock();
    const ageMs = previous === undefined ? undefined : at - previous.validatedAt;
    if (previous !== undefined && at < previous.validatedAt + this.maxStaleMs) {
      this.report(key, id, 'warn', {
        source: 'lkg',
        decision: previous.decision,
        errorClass: judged.errorClass,
        httpStatus: judged.httpStatus,
        latencyMs,
        ageMs,
      });
      return { source: 'lkg', decision: previous.decision, errorClass: judged.errorClass };
    }
    if (previous !== undefined) this.cache.delete(id);
    this.report(key, id, 'warn', {
      source: 'unavailable',
      errorClass: judged.errorClass,
      httpStatus: judged.httpStatus,
      latencyMs,
      ageMs,
    });
    return { source: 'unavailable', errorClass: judged.errorClass };
  }

  /** One call to the transport, bounded by the timeout. Never rejects. */
  private async attempt(key: RegistryKey, ifNoneMatch: string | undefined): Promise<RegistryResponse> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<RegistryResponse>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ kind: 'failure', errorClass: 'timeout' });
      }, this.timeoutMs);
    });
    const answered = Promise.resolve()
      .then(() => this.fetchDecision({ key, ifNoneMatch, signal: controller.signal }))
      .catch((): RegistryResponse => ({ kind: 'failure', errorClass: 'network' }));
    try {
      return await Promise.race([answered, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Writes the "Access registry" event. Warnings are limited to one per key per minute. */
  private report(key: RegistryKey, id: string, level: 'debug' | 'info' | 'warn', outcome: Outcome): void {
    let effective = level;
    if (level === 'warn') {
      const at = this.clock();
      const last = this.lastWarning.get(id);
      if (last !== undefined && at - last < WARN_INTERVAL_MS) {
        effective = 'debug';
      } else {
        this.lastWarning.set(id, at);
      }
    }
    // The reason is the parser's sanitized copy. Only plain identifier text is logged; anything else is unrecognised.
    const { decision } = outcome;
    let reason: string | undefined;
    if (decision?.decision === 'deny') reason = SAFE_REASON.test(decision.reason) ? decision.reason : 'unrecognised';
    logger[effective]('Access registry', {
      connector: key.connector,
      platform: key.platform,
      tenant: key.tenant,
      subject: key.subject,
      role: key.role,
      tier: key.tier,
      source: outcome.source,
      decision: decision?.decision,
      reason,
      revision: decision?.revision,
      httpStatus: outcome.httpStatus,
      latencyMs: outcome.latencyMs,
      ageMs: outcome.ageMs,
      errorClass: outcome.errorClass,
    });
  }
}

export interface HttpFetchOptions {
  readonly baseUrl: string;
  readonly auth: AccessRegistryAuthConfig;
  /** The fetch to use. Defaults to the global fetch. */
  readonly fetch?: FetchLike;
  /** The identity token endpoint. Defaults to Google's metadata service. Tests point it at a fake. */
  readonly metadataUrl?: string;
  readonly now?: Clock;
  /** Timeout for the identity token request, in milliseconds. Defaults to 3000. */
  readonly timeoutMs?: number;
}

/**
 * The HTTP transport. Redirects are never followed, so the bearer token only goes to the configured registry.
 * Every response is mapped to a RegistryResponse. A 200 body leaves as text for the client to parse; no other body is kept.
 */
export function createHttpFetchDecision(options: HttpFetchOptions): FetchDecision {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const fetchFn: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const clock: Clock = options.now ?? Date.now;
  const credential = credentialSource(options.auth, {
    fetch: fetchFn,
    metadataUrl: options.metadataUrl ?? METADATA_IDENTITY_URL,
    clock,
    timeoutMs: options.timeoutMs ?? DEFAULT_ACCESS_REGISTRY_TIMEOUT_MS,
  });
  return async ({ key, ifNoneMatch, signal }) => {
    let token: string | undefined;
    try {
      token = await credential();
    } catch {
      return { kind: 'failure', errorClass: 'auth' };
    }
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    if (ifNoneMatch !== undefined) headers['If-None-Match'] = ifNoneMatch;
    let response: Response;
    try {
      response = await fetchFn(decisionUrl(baseUrl, key), { method: 'GET', headers, redirect: 'manual', signal });
    } catch {
      return { kind: 'failure', errorClass: signal.aborted ? 'timeout' : 'network' };
    }
    return readRegistryResponse(response, signal);
  };
}

/** Replacements for the parts an enabled configuration would otherwise build. Tests and embedders use these. */
export interface AccessRegistryClientDeps {
  /** Replaces the HTTP transport. Library embedders supply their own decision source here. */
  readonly fetchDecision?: FetchDecision;
  readonly fetch?: FetchLike;
  readonly metadataUrl?: string;
  readonly now?: Clock;
  readonly maxEntries?: number;
}

/** Builds the client that an enabled registry configuration describes. */
export function createAccessRegistryClient(
  config: EnabledAccessRegistryConfig,
  deps: AccessRegistryClientDeps = {},
): RegistryClient {
  const now: Clock = deps.now ?? Date.now;
  return new RegistryClient({
    connector: config.connector,
    fetchDecision:
      deps.fetchDecision ??
      createHttpFetchDecision({
        baseUrl: config.baseUrl,
        auth: config.auth,
        fetch: deps.fetch,
        metadataUrl: deps.metadataUrl,
        now,
        timeoutMs: config.timeoutMs,
      }),
    now,
    timeoutMs: config.timeoutMs,
    maxStaleMs: config.maxStaleSeconds * 1000,
    maxEntries: deps.maxEntries,
  });
}

/**
 * Judges one response against the cached answer it may revalidate. A parser result is judged by its errorClass,
 * never by its message: the message is written for people, so its wording can change.
 */
function interpret(response: RegistryResponse, previous: CacheEntry | undefined, startedAt: number): Judgement {
  if (response.kind === 'text') {
    if (Buffer.byteLength(response.body, 'utf8') > MAX_BODY_BYTES) {
      return { ok: false, errorClass: 'oversize', httpStatus: 200 };
    }
    return judgeDecision(parseRegistryDecisionText(response.body), 200, startedAt);
  }
  if (response.kind === 'value') {
    return judgeDecision(parseRegistryDecisionValue(response.value), undefined, startedAt);
  }
  if (response.kind === 'not_modified') {
    // A 304 answers only the conditional request this client sends, and that request needs a cached answer.
    if (previous === undefined) return { ok: false, errorClass: 'http_status', httpStatus: 304 };
    return { ok: true, httpStatus: 304, entry: { ...previous, validatedAt: startedAt } };
  }
  return { ok: false, errorClass: response.errorClass, httpStatus: response.httpStatus };
}

/** Turns a parser result into a cache entry, or into the error class the parser reported. */
function judgeDecision(parsed: ParseRegistryDecisionResult, httpStatus: number | undefined, startedAt: number): Judgement {
  if (!parsed.ok) return { ok: false, errorClass: parsed.errorClass, httpStatus };
  const freshForMs = Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, parsed.decision.ttlSeconds)) * 1000;
  return { ok: true, httpStatus, entry: { decision: parsed.decision, validatedAt: startedAt, freshForMs } };
}

function decisionUrl(baseUrl: string, key: RegistryKey): string {
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ['connector', key.connector],
    ['platform', key.platform],
    ['tenant', key.tenant],
    ['subject', key.subject],
    ['role', key.role],
    ['tier', key.tier],
  ];
  const query = pairs.map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('&');
  return `${baseUrl}${DECISION_PATH}?${query}`;
}

/** Maps a response from the decision endpoint. Status 200 carries answers, 304 confirms one, and all else is an error. */
async function readRegistryResponse(response: Response, signal: AbortSignal): Promise<RegistryResponse> {
  try {
    if (response.status === 200) {
      const body = await readBounded(response, MAX_BODY_BYTES);
      if (body === undefined) return { kind: 'failure', errorClass: 'oversize', httpStatus: 200 };
      return { kind: 'text', body };
    }
    await discard(response);
    if (response.status === 304) return { kind: 'not_modified' };
    const errorClass: RegistryErrorClass = response.status === 401 || response.status === 403 ? 'auth' : 'http_status';
    return { kind: 'failure', errorClass, httpStatus: response.status };
  } catch {
    return { kind: 'failure', errorClass: signal.aborted ? 'timeout' : 'network', httpStatus: response.status };
  }
}

/** Reads a body of at most limit bytes. Returns undefined when it is longer, and stops reading at that point. */
async function readBounded(response: Response, limit: number): Promise<string | undefined> {
  if (Number(response.headers.get('content-length') ?? 0) > limit) {
    await discard(response);
    return undefined;
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Drops a body that nothing will read. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing reads the body, so a failed cancel has nothing to report.
  }
}

interface CredentialDeps {
  readonly fetch: FetchLike;
  readonly metadataUrl: string;
  readonly clock: Clock;
  readonly timeoutMs: number;
}

/** Yields the credential for one request: none, the static bearer token, or a metadata identity token. */
function credentialSource(auth: AccessRegistryAuthConfig, deps: CredentialDeps): () => Promise<string | undefined> {
  if (auth.mode === 'none') return async () => undefined;
  if (auth.mode === 'bearer') {
    const token = auth.token;
    return async () => token;
  }
  return identityTokens(auth.audience, deps);
}

/**
 * Mints a Google identity token and reuses it until 300 seconds before its exp claim. Concurrent callers share one
 * mint. No dependency is added: the token and its expiry come from the metadata response itself.
 */
function identityTokens(audience: string, deps: CredentialDeps): () => Promise<string | undefined> {
  let held: { readonly token: string; readonly refreshAt: number } | undefined;
  let minting: Promise<string> | undefined;

  async function mint(): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
    try {
      const url = `${deps.metadataUrl}?audience=${encodeURIComponent(audience)}&format=full`;
      const response = await deps.fetch(url, {
        method: 'GET',
        headers: { 'Metadata-Flavor': 'Google' },
        redirect: 'manual',
        signal: controller.signal,
      });
      if (response.status !== 200) {
        await discard(response);
        throw new Error(`identity token request answered ${response.status}`);
      }
      const token = (await readBounded(response, MAX_BODY_BYTES))?.trim();
      const expiresAt = token === undefined ? undefined : tokenExpiryMs(token);
      if (token === undefined || expiresAt === undefined || !VISIBLE_ASCII.test(token)) {
        throw new Error('identity token response is not a token with an exp claim');
      }
      held = { token, refreshAt: expiresAt - TOKEN_REFRESH_MARGIN_MS };
      return token;
    } finally {
      clearTimeout(timer);
    }
  }

  return () => {
    if (held !== undefined && deps.clock() < held.refreshAt) return Promise.resolve(held.token);
    if (minting === undefined) {
      minting = mint().finally(() => {
        minting = undefined;
      });
    }
    return minting;
  };
}

/** The exp claim of a JWT in milliseconds, or undefined when there is none. The signature is not verified here. */
function tokenExpiryMs(token: string): number | undefined {
  const segments = token.split('.');
  if (segments.length !== 3) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
    if (typeof claims !== 'object' || claims === null || !('exp' in claims)) return undefined;
    const exp = claims.exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}
