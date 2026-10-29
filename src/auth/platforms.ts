export interface NetSapiensPlatform {
 id: string;
 label: string;
 apiUrl: string;
}

export function normalizePlatformUrl(raw: string): string {
 const url = new URL(raw.trim());
 if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Expected an http(s) URL');
 return url.origin;
}

export function parsePlatforms(raw: string | undefined, defaultApiUrl: string): NetSapiensPlatform[] {
 const origin = normalizePlatformUrl(defaultApiUrl);
 let values: unknown = {};
 if (raw !== undefined) {
  try { values = JSON.parse(raw); } catch { throw new Error('ConfigError: NETSAPIENS_PLATFORMS must be a JSON object'); }
 }
 if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('ConfigError: NETSAPIENS_PLATFORMS must be a JSON object');
 const result: NetSapiensPlatform[] = [];
 const ids = new Set<string>();
 const origins = new Set<string>();
 for (const [key, value] of Object.entries(values)) {
  const id = key.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  if (!id || ids.has(id)) throw new Error(`ConfigError: NETSAPIENS_PLATFORMS duplicate or invalid id: ${key}`);
  const item = typeof value === 'string' ? { apiUrl: value, label: key } : value;
  if (!item || typeof item !== 'object' || typeof item.apiUrl !== 'string' || (item.label !== undefined && typeof item.label !== 'string')) throw new Error(`ConfigError: NETSAPIENS_PLATFORMS invalid entry: ${key}`);
  let apiUrl: string;
  try { apiUrl = normalizePlatformUrl(item.apiUrl); } catch { throw new Error(`ConfigError: NETSAPIENS_PLATFORMS invalid URL: ${key}`); }
  if (origins.has(apiUrl)) throw new Error(`ConfigError: NETSAPIENS_PLATFORMS duplicate origin: ${key}`);
  if (id === 'default' && apiUrl !== origin) throw new Error(`ConfigError: NETSAPIENS_PLATFORMS default has a different origin: ${key}`);
  ids.add(id); origins.add(apiUrl);
  result.push({ id, label: item.label ?? key, apiUrl });
 }
 if (!origins.has(origin)) result.unshift({ id: 'default', label: new URL(origin).hostname, apiUrl: origin });
 return result;
}

export function resolvePlatform(platforms: readonly NetSapiensPlatform[], input: string): NetSapiensPlatform | undefined {
 if (!input || typeof input !== 'string') return undefined;
 const value = input.trim();
 try {
  const origin = normalizePlatformUrl(value);
  return platforms.find((p) => p.apiUrl === origin);
 } catch {
  const lower = value.toLowerCase();
  return platforms.find((p) => p.id.toLowerCase() === lower || p.label.toLowerCase() === lower);
 }
}

export function isPlatformAllowed(platforms: readonly NetSapiensPlatform[], apiUrl: string): boolean {
 try { return platforms.some((p) => p.apiUrl === normalizePlatformUrl(apiUrl)); } catch { return false; }
}
