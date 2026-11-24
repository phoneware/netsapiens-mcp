/**
 * Client for the access registry decision endpoint (docs/access-registry.md, "Caching and fail-closed").
 *
 * The client does not decide access. It asks the registry, caches each answer, and reports whether the answer it
 * returns is fresh, revalidated, last known good, or unavailable. A caller treats unavailable as closed.
 * Nothing here reads the environment: config.ts does that and passes plain values in.
 *
 * An answer's age is the larger of its monotonic age and its wall-clock age (see ageOf), so it is never younger than
 * either clock says. The wall clock is also read to check an identity token's exp claim. A text body is parsed with
 * parseRegistryDecisionText, and an embedder's parsed value with parseRegistryDecisionValue.
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

/** Every RegistryErrorClass. The record is exhaustive by type, so a new class must be added here too. */
const ERROR_CLASSES: Readonly<Record<RegistryErrorClass, true>> = {
  invalid_json: true,
  contract: true,
  critical: true,
  timeout: true,
  network: true,
  http_status: true,
  oversize: true,
  auth: true,
};

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
 * A throw counts as a network error. A result of any other shape is a contract error. A decision arrives as text or
 * as a value; see RegistryResponse.
 */
export type FetchDecision = (request: RegistryRequest) => Promise<RegistryResponse>;

/** Returns milliseconds. Each option that takes a clock says whether it is monotonic or wall-clock time. */
export type Clock = () => number;

/** Monotonic milliseconds. It never runs backwards, so it bounds every age from below. */
const monotonicNowMs: Clock = () => performance.now();

/** Wall-clock milliseconds since the epoch. It can step in either direction, and a step back counts as zero in an age. */
const wallNowMs: Clock = () => Date.now();

/** The fetch shape the HTTP transport uses. Tests inject their own. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface RegistryClientOptions {
  readonly connector: string;
  readonly fetchDecision: FetchDecision;
  /** Monotonic milliseconds. Defaults to performance.now. */
  readonly now?: Clock;
  /** Wall-clock milliseconds since the epoch. Defaults to Date.now. It can raise an age, never lower one. */
  readonly wallNow?: Clock;
  /** Per-request timeout in milliseconds. Defaults to 3000. */
  readonly timeoutMs?: number;
  /** Last-known-good window in milliseconds, measured as an age. Defaults to 600000. */
  readonly maxStaleMs?: number;
  /** Most answers held at once. The least recently used is evicted first. Defaults to 10000. */
  readonly maxEntries?: number;
}

/** Both clocks, read together. An age is measured between two readings. */
interface ClockReading {
  /** Monotonic milliseconds. */
  readonly monotonic: number;
  /** Wall-clock milliseconds since the epoch. */
  readonly wall: number;
}

interface CacheEntry {
  readonly decision: AccessDecisionV1;
  /** The clock readings taken when the request that confirmed the decision was sent. */
  readonly validatedAt: ClockReading;
  /** How old an answer may be, in milliseconds, and still be fresh. */
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
  private readonly wallClock: Clock;
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
    this.clock = options.now ?? monotonicNowMs;
    this.wallClock = options.wallNow ?? wallNowMs;
    this.timeoutMs = timeoutMs;
    this.maxStaleMs = maxStaleMs;
    this.cache = new LruCache<CacheEntry>(maxEntries);
    this.lastWarning = new LruCache<number>(maxEntries);
  }

  /** Answers held in the cache. For diagnostics and tests. */
  get cacheSize(): number {
    return this.cache.size;
  }

  /** Both clocks, read together. */
  private readClocks(): ClockReading {
    return { monotonic: this.clock(), wall: this.wallClock() };
  }

  /**
   * The registry's answer for a query: from the cache while it is fresh, otherwise from the registry. A stale answer
   * is revalidated, and concurrent callers for one key share one request. An answer whose age is unknown, because the
   * monotonic clock reads earlier than its validation, is stale and is never last known good.
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
    const age = entry === undefined ? undefined : ageOf(entry, this.readClocks());
    if (entry !== undefined && age !== undefined && age < entry.freshForMs) {
      this.report(key, id, 'debug', { source: 'fresh', decision: entry.decision, ageMs: age });
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
    const sentAt = this.readClocks();
    const ifNoneMatch = previous === undefined ? undefined : `"${previous.decision.revision}"`;
    const response = await this.attempt(key, ifNoneMatch);
    const latencyMs = elapsedMs(sentAt.monotonic, this.clock());
    const judged = judgeSafely(response, previous, sentAt);
    if (judged.ok) {
      this.cache.set(id, judged.entry);
      const source: RegistrySource = previous === undefined ? 'fresh' : 'revalidated';
      this.report(key, id, 'info', {
        source,
        decision: judged.entry.decision,
        httpStatus: judged.httpStatus,
        latencyMs,
        ageMs: previous === undefined ? undefined : ageOf(previous, sentAt),
      });
      return { source, decision: judged.entry.decision };
    }
    const now = this.readClocks();
    const ageMs = previous === undefined ? undefined : ageOf(previous, now);
    if (previous !== undefined && ageMs !== undefined && ageMs < this.maxStaleMs) {
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

  /**
   * One call to the transport, bounded by the timeout. Never rejects. A rejection is a network error, and whatever the
   * source resolves with is checked by asRegistryResponse, which maps a value of the wrong shape to a contract error.
   */
  private async attempt(key: RegistryKey, ifNoneMatch: string | undefined): Promise<RegistryResponse> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<RegistryResponse>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'failure', errorClass: 'timeout' }), this.timeoutMs);
    });
    const signal = AbortSignal.timeout(this.timeoutMs);
    const answered = Promise.resolve()
      .then(() => this.fetchDecision({ key, ifNoneMatch, signal }))
      .then(asRegistryResponse, (): RegistryResponse => ({ kind: 'failure', errorClass: 'network' }));
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
      // A clock that went backwards since the last warning has no measurable interval, so it does not silence one.
      const since = last === undefined ? undefined : elapsedMs(last, at);
      if (since !== undefined && since < WARN_INTERVAL_MS) {
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
  /** Wall-clock milliseconds since the epoch. Read only to check an identity token's exp claim. Defaults to Date.now. */
  readonly wallNow?: Clock;
  /** Timeout for the identity token request, in milliseconds. Defaults to 3000. */
  readonly timeoutMs?: number;
}

/**
 * The HTTP transport. Redirects are never followed, so the bearer token only goes to the configured registry.
 * Every response is mapped to a RegistryResponse. A 200 body leaves as text for the client to parse; no other body is kept.
 */
export function createHttpFetchDecision(options: HttpFetchOptions): FetchDecision {
  let baseEnd = options.baseUrl.length;
  while (baseEnd > 0 && options.baseUrl.charCodeAt(baseEnd - 1) === 47) baseEnd--;
  const baseUrl = options.baseUrl.slice(0, baseEnd);
  const fetchFn: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const credential = credentialSource(options.auth, {
    fetch: fetchFn,
    metadataUrl: options.metadataUrl ?? METADATA_IDENTITY_URL,
    wallNow: options.wallNow ?? wallNowMs,
    timeoutMs: options.timeoutMs ?? DEFAULT_ACCESS_REGISTRY_TIMEOUT_MS,
  });
  return async ({ key, ifNoneMatch, signal }) => {
    let token: string | undefined;
    try {
      token = await credential.current();
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
    const result = await readRegistryResponse(response, signal);
    // The registry refused the credential, so it is not reused. A static bearer token is never cached, so it stays.
    if (token !== undefined && result.kind === 'failure' && result.errorClass === 'auth') credential.rejected(token);
    return result;
  };
}

/** Replacements for the parts an enabled configuration would otherwise build. Tests and embedders use these. */
export interface AccessRegistryClientDeps {
  /** Replaces the HTTP transport. Library embedders supply their own decision source here. */
  readonly fetchDecision?: FetchDecision;
  readonly fetch?: FetchLike;
  readonly metadataUrl?: string;
  /** Monotonic milliseconds. Defaults to performance.now. */
  readonly now?: Clock;
  /** Wall-clock milliseconds since the epoch. Defaults to Date.now. Used for ages and for identity token expiry. */
  readonly wallNow?: Clock;
  readonly maxEntries?: number;
}

/** Builds the client that an enabled registry configuration describes. */
export function createAccessRegistryClient(
  config: EnabledAccessRegistryConfig,
  deps: AccessRegistryClientDeps = {},
): RegistryClient {
  return new RegistryClient({
    connector: config.connector,
    fetchDecision:
      deps.fetchDecision ??
      createHttpFetchDecision({
        baseUrl: config.baseUrl,
        auth: config.auth,
        fetch: deps.fetch,
        metadataUrl: deps.metadataUrl,
        wallNow: deps.wallNow,
        timeoutMs: config.timeoutMs,
      }),
    now: deps.now,
    wallNow: deps.wallNow,
    timeoutMs: config.timeoutMs,
    maxStaleMs: config.maxStaleSeconds * 1000,
    maxEntries: deps.maxEntries,
  });
}

/**
 * Judges one response against the cached answer it may revalidate. A parser result is judged by its errorClass,
 * never by its message: the message is written for people, so its wording can change.
 */
function interpret(response: RegistryResponse, previous: CacheEntry | undefined, sentAt: ClockReading): Judgement {
  if (response.kind === 'text') {
    if (Buffer.byteLength(response.body, 'utf8') > MAX_BODY_BYTES) {
      return { ok: false, errorClass: 'oversize', httpStatus: 200 };
    }
    return judgeDecision(parseRegistryDecisionText(response.body), 200, sentAt);
  }
  if (response.kind === 'value') {
    return judgeDecision(parseRegistryDecisionValue(response.value), undefined, sentAt);
  }
  if (response.kind === 'not_modified') {
    // A 304 answers only the conditional request this client sends, and that request needs a cached answer.
    if (previous === undefined) return { ok: false, errorClass: 'http_status', httpStatus: 304 };
    return { ok: true, httpStatus: 304, entry: { ...previous, validatedAt: sentAt } };
  }
  return { ok: false, errorClass: response.errorClass, httpStatus: response.httpStatus };
}

/**
 * Judges a checked response, and never throws. Anything that goes wrong while judging, such as a getter that throws
 * inside an embedder's value, is a contract error.
 */
function judgeSafely(response: RegistryResponse, previous: CacheEntry | undefined, sentAt: ClockReading): Judgement {
  try {
    return interpret(response, previous, sentAt);
  } catch {
    return { ok: false, errorClass: 'contract' };
  }
}

/** Turns a parser result into a cache entry, or into the error class the parser reported. */
function judgeDecision(parsed: ParseRegistryDecisionResult, httpStatus: number | undefined, sentAt: ClockReading): Judgement {
  if (!parsed.ok) return { ok: false, errorClass: parsed.errorClass, httpStatus };
  const freshForMs = Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, parsed.decision.ttlSeconds)) * 1000;
  return { ok: true, httpStatus, entry: { decision: parsed.decision, validatedAt: sentAt, freshForMs } };
}

/**
 * The age of a cached answer at `now`, in milliseconds: the larger of its monotonic age and its wall-clock age, where a
 * wall-clock age below zero counts as zero. So the answer is never younger than either clock says. A backwards wall step
 * cannot make it fresher, because the monotonic age keeps growing. A forward wall jump, or a machine that slept while the
 * monotonic clock stood still, ages it sooner, so it is revalidated sooner. A monotonic age below zero means the answer
 * was validated after the monotonic clock reads, so its age is unknown: the result is undefined, and callers treat that
 * as stale and never last known good. A reading that is not a finite number is unknown too.
 */
function ageOf(entry: CacheEntry, now: ClockReading): number | undefined {
  const monotonic = now.monotonic - entry.validatedAt.monotonic;
  const wall = now.wall - entry.validatedAt.wall;
  if (!Number.isFinite(monotonic) || monotonic < 0 || !Number.isFinite(wall)) return undefined;
  return Math.max(monotonic, Math.max(0, wall));
}

/** What a decision source resolves with when it is not one of the four response shapes. */
const CONTRACT_FAILURE: RegistryResponse = { kind: 'failure', errorClass: 'contract' };

/**
 * Checks what a decision source resolved with. Nothing from a source is trusted: a value outside the four response
 * shapes is a contract error. It never throws, even when a getter does, so a shape cannot make a caller see a rejection.
 */
function asRegistryResponse(raw: unknown): RegistryResponse {
  try {
    return responseOf(raw) ?? CONTRACT_FAILURE;
  } catch {
    return CONTRACT_FAILURE;
  }
}

/** The response a value has, or undefined when it has none of the four shapes. */
function responseOf(raw: unknown): RegistryResponse | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const kind: unknown = 'kind' in raw ? raw.kind : undefined;
  if (kind === 'text') {
    const body: unknown = 'body' in raw ? raw.body : undefined;
    return typeof body === 'string' ? { kind: 'text', body } : undefined;
  }
  if (kind === 'value') return 'value' in raw ? { kind: 'value', value: raw.value } : undefined;
  if (kind === 'not_modified') return { kind: 'not_modified' };
  if (kind === 'failure') {
    const errorClass: unknown = 'errorClass' in raw ? raw.errorClass : undefined;
    const httpStatus: unknown = 'httpStatus' in raw ? raw.httpStatus : undefined;
    return isErrorClass(errorClass) ? { kind: 'failure', errorClass, httpStatus: statusOf(httpStatus) } : undefined;
  }
  return undefined;
}

function isErrorClass(value: unknown): value is RegistryErrorClass {
  return typeof value === 'string' && Object.hasOwn(ERROR_CLASSES, value);
}

/** An HTTP status a source reports, when it is a whole number from 100 to 599. Anything else is not reported. */
function statusOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

/** Milliseconds from one monotonic reading to a later one, or undefined when the clock went backwards or is not a number. */
function elapsedMs(from: number, to: number): number | undefined {
  const value = to - from;
  return Number.isFinite(value) && value >= 0 ? value : undefined;
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
  /** Wall-clock milliseconds since the epoch, for the exp claim. */
  readonly wallNow: Clock;
  readonly timeoutMs: number;
}

/** The credential for each registry request, and the record of one the registry refused. */
interface Credential {
  /** The credential for the next request, or undefined when the mode sends none. Rejects when none can be obtained. */
  current(): Promise<string | undefined>;
  /** The registry refused a request that carried this token. A held identity token is dropped when it is this one. */
  rejected(token: string): void;
}

/** The credential for the configured auth mode. A static bearer token is never cached, so a refusal changes nothing. */
function credentialSource(auth: AccessRegistryAuthConfig, deps: CredentialDeps): Credential {
  if (auth.mode === 'none') return { current: async () => undefined, rejected: () => undefined };
  if (auth.mode === 'bearer') {
    const token = auth.token;
    return { current: async () => token, rejected: () => undefined };
  }
  return identityTokens(auth.audience, deps);
}

/** An identity token as minted, with the wall-clock times that bound its life. */
interface HeldToken {
  readonly token: string;
  /** Wall-clock time when the mint request was sent. The token was issued no earlier than this. */
  readonly mintedAtMs: number;
  /** The exp claim, in milliseconds since the epoch. */
  readonly expiresAtMs: number;
}

/**
 * Mints a Google identity token and reuses it until 300 seconds before its exp claim. Concurrent callers share one
 * mint. A token is reused only while its remaining life is above the refresh margin and no more than its own
 * lifetime, so a wall clock that has gone back since the mint forces a new token. A token the registry refuses is
 * dropped, and the next attempt mints a new one. No dependency is added: the token and its expiry come from the
 * metadata response itself.
 */
function identityTokens(audience: string, deps: CredentialDeps): Credential {
  let held: HeldToken | undefined;
  let minting: Promise<string> | undefined;

  async function mint(): Promise<string> {
    const mintedAtMs = deps.wallNow();
    const signal = AbortSignal.timeout(deps.timeoutMs);
    const url = `${deps.metadataUrl}?audience=${encodeURIComponent(audience)}&format=full`;
    const response = await deps.fetch(url, {
      method: 'GET',
      headers: { 'Metadata-Flavor': 'Google' },
      redirect: 'manual',
      signal,
    });
    if (response.status !== 200) {
      await discard(response);
      throw new Error(`identity token request answered ${response.status}`);
    }
    const token = (await readBounded(response, MAX_BODY_BYTES))?.trim();
    const expiresAtMs = token === undefined ? undefined : tokenExpiryMs(token);
    if (token === undefined || expiresAtMs === undefined || !(expiresAtMs > mintedAtMs) || !VISIBLE_ASCII.test(token)) {
      throw new Error('identity token response is not a token with an exp claim later than its mint');
    }
    held = { token, mintedAtMs, expiresAtMs };
    return token;
  }

  return {
    current: () => {
      if (held !== undefined && isReusable(held, deps.wallNow())) return Promise.resolve(held.token);
      if (minting === undefined) {
        minting = mint().finally(() => {
          minting = undefined;
        });
      }
      return minting;
    },
    rejected: (token: string) => {
      if (held?.token === token) held = undefined;
    },
  };
}

/**
 * A held token is reused only while its remaining life is above the refresh margin and no more than its own lifetime.
 * Remaining life above the lifetime means the wall clock went back after the mint, so the token is minted again.
 */
function isReusable(held: HeldToken, atMs: number): boolean {
  const lifetimeMs = held.expiresAtMs - held.mintedAtMs;
  const remainingMs = held.expiresAtMs - atMs;
  return remainingMs > TOKEN_REFRESH_MARGIN_MS && remainingMs <= lifetimeMs;
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
