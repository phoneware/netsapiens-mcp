import { resolveDocsBranch, lookupObservation } from './availability.js';
import { logger } from '../utils/logger.js';

export interface VersionInfo {
  origin: string;
  apiVersion: string | null;
  version?: string | null;
  line: string | null;
  docsBranch: string | null;
  branch?: string | null;
  match: 'exact' | 'nearest-lower' | 'newer-than-documented' | 'older-than-documented' | null;
  status: 'ok' | 'stale' | 'unknown';
  state: 'fresh' | 'stale' | 'unknown';
  checkedAt: string;
  lastError?: string;
  v1: 'ok' | 'unavailable';
  v1Keys: Set<string>;
  observation: string | null;
}

const MAX_APIDOC_BYTES = 8 * 1024 * 1024; // 8 MB limit
const VERSION_TIMEOUT_MS = 5000; // 5s timeout
const APIDOC_TIMEOUT_MS = 15000; // 15s timeout
const RETRY_INTERVAL_MS = 60000; // 60s retry on failure

/**
 * Returns the version cache TTL in seconds.
 * Exits with status 1 if NETSAPIENS_VERSION_TTL_SECONDS is set but is not a positive integer.
 */
export function getVersionTtlSeconds(): number {
  const envVal = process.env.NETSAPIENS_VERSION_TTL_SECONDS;
  if (envVal === undefined || envVal === '') {
    return 3600;
  }
  if (!/^\d+$/.test(envVal)) {
    console.error(`ConfigError: NETSAPIENS_VERSION_TTL_SECONDS must be a positive integer, got "${envVal}"`);
    process.exit(1);
  }
  const parsed = parseInt(envVal, 10);
  if (parsed <= 0) {
    console.error(`ConfigError: NETSAPIENS_VERSION_TTL_SECONDS must be a positive integer, got "${envVal}"`);
    process.exit(1);
  }
  return parsed;
}

const versionCache = new Map<string, VersionInfo>();
const inFlightFetches = new Map<string, Promise<VersionInfo>>();
const refreshListeners = new Set<(info: VersionInfo) => void>();

export function onVersionRefreshed(callback: (info: VersionInfo) => void): () => void {
  refreshListeners.add(callback);
  return () => {
    refreshListeners.delete(callback);
  };
}

function normalizeOrigin(urlOrOrigin: string): string {
  try {
    return new URL(urlOrOrigin).origin;
  } catch {
    return urlOrOrigin.replace(/\/+$/, '');
  }
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  return await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
}

async function readJsonWithLimit<T>(res: Response, maxBytes: number): Promise<T> {
  const cl = res.headers.get('content-length');
  if (cl && parseInt(cl, 10) > maxBytes) {
    throw new Error(`Response size exceeds limit of ${maxBytes} bytes`);
  }
  if (!res.body) {
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error(`Response size exceeds limit of ${maxBytes} bytes`);
    }
    return JSON.parse(text) as T;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new Error(`Response size exceeds limit of ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const buf = Buffer.concat(chunks);
  return JSON.parse(buf.toString('utf8')) as T;
}

/**
 * Fetch and build version info for an origin.
 */
async function doFetchOrigin(origin: string): Promise<VersionInfo> {
  let apiVersion: string | null = null;
  let line: string | null = null;
  let docsBranch: string | null = null;
  let match: VersionInfo['match'] = null;
  let observation: string | null = null;
  let v1Status: 'ok' | 'unavailable' = 'unavailable';
  const v1Keys = new Set<string>();
  let lastError: string | undefined;

  // 1. Fetch /version
  try {
    const versionUrl = `${origin}/ns-api/v2/version`;
    const res = await fetchWithTimeout(versionUrl, VERSION_TIMEOUT_MS);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${versionUrl}`);
    }
    const data = (await res.json()) as Record<string, unknown>;
    const rawVersion = typeof data?.apiversion === 'string'
      ? data.apiversion
      : typeof data?.version === 'string'
        ? data.version
        : null;

    if (!rawVersion || !/^\d+\.\d+(?:\.\d+)?/.test(rawVersion)) {
      throw new Error(`Unparseable apiVersion: ${rawVersion}`);
    }

    apiVersion = rawVersion;
    const branchRes = resolveDocsBranch(apiVersion);
    docsBranch = branchRes.docsBranch;
    match = branchRes.match;
    line = branchRes.line;
    observation = lookupObservation(line, apiVersion);
  } catch (err: unknown) {
    lastError = err instanceof Error ? err.message : String(err);
  }

  // 2. Fetch /apidoc if /version succeeded
  if (apiVersion) {
    try {
      const apidocUrl = `${origin}/ns-api/webroot/apidoc/api_data.json`;
      const res = await fetchWithTimeout(apidocUrl, APIDOC_TIMEOUT_MS);
      if (res.ok) {
        const apidoc = await readJsonWithLimit<unknown>(res, MAX_APIDOC_BYTES);
        if (Array.isArray(apidoc)) {
          v1Status = 'ok';
          for (const item of apidoc) {
            if (item && typeof item === 'object' && typeof item.type === 'string' && typeof item.url === 'string') {
              v1Keys.add(`${item.type.toUpperCase()} ${item.url}`);
            }
          }
        }
      }
    } catch {
      v1Status = 'unavailable';
    }
  }

  const nowIso = new Date().toISOString();

  // If /version failed
  if (!apiVersion) {
    const existing = versionCache.get(origin);
    if (existing && existing.status !== 'unknown' && existing.apiVersion) {
      // Keep last good value with status: 'stale'
      const stale: VersionInfo = {
        ...existing,
        status: 'stale',
        state: 'stale',
        checkedAt: nowIso,
        lastError,
      };
      versionCache.set(origin, stale);
      return stale;
    }

    // Origin has never succeeded: status: 'unknown'
    const unknownInfo: VersionInfo = {
      origin,
      apiVersion: null,
      version: null,
      line: null,
      docsBranch: null,
      branch: null,
      match: null,
      status: 'unknown',
      state: 'unknown',
      checkedAt: nowIso,
      lastError,
      v1: 'unavailable',
      v1Keys: new Set(),
      observation: null,
    };
    versionCache.set(origin, unknownInfo);
    return unknownInfo;
  }

  const freshInfo: VersionInfo = {
    origin,
    apiVersion,
    version: apiVersion,
    line,
    docsBranch,
    branch: docsBranch,
    match,
    status: 'ok',
    state: 'fresh',
    checkedAt: nowIso,
    v1: v1Status,
    v1Keys,
    observation,
  };
  versionCache.set(origin, freshInfo);
  for (const listener of refreshListeners) {
    try {
      listener(freshInfo);
    } catch {
      // ignore listener errors
    }
  }
  return freshInfo;
}

/**
 * Get version info for a NetSapiens origin.
 * Single-flight per origin; caches based on TTL and 60s retry backoff.
 */
export async function getVersionInfo(urlOrOrigin: string): Promise<VersionInfo> {
  const origin = normalizeOrigin(urlOrOrigin);
  const ttlMs = getVersionTtlSeconds() * 1000;
  const now = Date.now();

  const cached = versionCache.get(origin);
  if (cached) {
    const ageMs = now - new Date(cached.checkedAt).getTime();
    if (cached.status === 'ok' && ageMs < ttlMs) {
      return cached;
    }
    if ((cached.status === 'stale' || cached.status === 'unknown') && ageMs < RETRY_INTERVAL_MS) {
      return cached;
    }
  }

  const existingInFlight = inFlightFetches.get(origin);
  if (existingInFlight) {
    return existingInFlight;
  }

  const fetchPromise = doFetchOrigin(origin).finally(() => {
    inFlightFetches.delete(origin);
  });
  inFlightFetches.set(origin, fetchPromise);
  return fetchPromise;
}

/**
 * Reads the version cache ONLY. Never triggers an upstream fetch.
 */
export function getCachedVersionInfo(urlOrOrigin: string): VersionInfo | null {
  const origin = normalizeOrigin(urlOrOrigin);
  return versionCache.get(origin) ?? null;
}

/**
 * Warms the version cache for the provided origins without blocking.
 */
export async function warmVersionCache(origins: string[]): Promise<void> {
  await Promise.allSettled(
    origins.map(async (origin) => {
      try {
        await getVersionInfo(origin);
      } catch (err) {
        logger.warn('Failed to warm version cache', { origin, error: String(err) });
      }
    }),
  );
}

/**
 * Clear the version cache (for tests).
 */
export function clearVersionCache(): void {
  versionCache.clear();
  inFlightFetches.clear();
}

/**
 * Manually set an entry in the version cache (for tests).
 */
export function setVersionCacheEntry(urlOrOrigin: string, info: VersionInfo): void {
  const origin = normalizeOrigin(urlOrOrigin);
  versionCache.set(origin, info);
}
