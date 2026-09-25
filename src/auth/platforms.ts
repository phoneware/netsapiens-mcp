/**
 * NetSapiens platform allowlist and resolution.
 *
 * Defines the NetSapiens API hosts that this MCP server is permitted to target.
 * Platforms come from an operator allowlist (NETSAPIENS_PLATFORMS or MCP_PLATFORMS).
 * Phoneware Edge is ALWAYS present and cannot be omitted. Unknown hosts are
 * refused before any network request is issued, preventing SSRF.
 */

export interface NetSapiensPlatform {
 id: string;
 label: string;
 apiUrl: string;
}

/** Default Edge URL fallback if not set in environment. */
export const DEFAULT_EDGE_API_URL = 'https://edge.phoneware.cloud';

/** Known partner NetSapiens hosts discovered in phoneware topology. */
export const DEFAULT_PLATFORMS: NetSapiensPlatform[] = [
 { id: 'edge', label: 'Phoneware Edge', apiUrl: 'https://edge.phoneware.cloud' },
 { id: 'viirtue', label: 'Viirtue', apiUrl: 'https://vps.phoneware.us' },
 { id: 'mcu', label: 'MCU', apiUrl: 'https://mars.phoneware.cloud' },
];

/**
 * Normalizes a URL: trims whitespace, strips trailing slashes, and verifies
 * it parses as a valid http: or https: URL.
 */
export function normalizePlatformUrl(raw: string): string {
 const trimmed = raw.trim().replace(/\/+$/, '');
 const parsed = new URL(trimmed);
 if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
  throw new Error(`Unsupported protocol for NetSapiens platform URL: ${parsed.protocol}`);
 }
 return parsed.origin;
}

/**
 * Parses the operator environment allowlist.
 * Supports:
 *  - JSON object: '{"Edge":"https://edge.phoneware.cloud","Viirtue":"https://vps.phoneware.us"}'
 *  - Comma-delimited key=value pairs: 'Edge=https://edge.phoneware.cloud,Viirtue=https://vps.phoneware.us'
 */
export function parsePlatformsConfig(raw?: string): NetSapiensPlatform[] {
 const platforms: NetSapiensPlatform[] = [];
 const edgeApiUrl = normalizePlatformUrl(process.env.NETSAPIENS_API_URL || DEFAULT_EDGE_API_URL);

 if (!raw || !raw.trim()) {
  // Return default platforms, ensuring Edge uses the configured NETSAPIENS_API_URL
  return DEFAULT_PLATFORMS.map((p) =>
   p.id === 'edge' ? { ...p, apiUrl: edgeApiUrl } : { ...p, apiUrl: normalizePlatformUrl(p.apiUrl) }
  );
 }

 const trimmed = raw.trim();
 if (trimmed.startsWith('{')) {
  try {
   const parsed = JSON.parse(trimmed);
   for (const [key, val] of Object.entries(parsed)) {
    if (typeof val === 'string') {
     const normUrl = normalizePlatformUrl(val);
     platforms.push({
      id: key.toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
      label: key,
      apiUrl: normUrl,
     });
    } else if (typeof val === 'object' && val !== null && 'apiUrl' in val) {
     const obj = val as { label?: string; apiUrl: string };
     platforms.push({
      id: key.toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
      label: obj.label || key,
      apiUrl: normalizePlatformUrl(obj.apiUrl),
     });
    }
   }
  } catch (err) {
   throw new Error(`Malformed JSON in NETSAPIENS_PLATFORMS: ${err}`);
  }
 } else {
  // Comma-separated pairs: Label=URL,Label2=URL2
  const entries = trimmed.split(',');
  for (const entry of entries) {
   const eqIdx = entry.indexOf('=');
   const colonIdx = entry.indexOf(':');
   const splitIdx = eqIdx !== -1 ? eqIdx : colonIdx;
   if (splitIdx !== -1) {
    const label = entry.slice(0, splitIdx).trim();
    const urlStr = entry.slice(splitIdx + 1).trim();
    if (label && urlStr) {
     platforms.push({
      id: label.toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
      label,
      apiUrl: normalizePlatformUrl(urlStr),
     });
    }
   }
  }
 }

 // Edge must ALWAYS be present
 const hasEdge = platforms.some((p) => {
  try {
   return normalizePlatformUrl(p.apiUrl) === edgeApiUrl || p.id === 'edge';
  } catch {
   return false;
  }
 });

 if (!hasEdge) {
  platforms.unshift({
   id: 'edge',
   label: 'Phoneware Edge',
   apiUrl: edgeApiUrl,
  });
 }

 return platforms;
}

/**
 * Returns the currently active list of allowed platforms from the environment.
 */
export function getAllowedPlatforms(): NetSapiensPlatform[] {
 const envVal = process.env.NETSAPIENS_PLATFORMS || process.env.MCP_PLATFORMS;
 return parsePlatformsConfig(envVal);
}

/**
 * Matches an input string (label, id, or API URL) against the allowed platforms.
 */
export function getPlatform(input: string): NetSapiensPlatform | undefined {
 if (!input || typeof input !== 'string') return undefined;
 const trimmed = input.trim();
 const allowed = getAllowedPlatforms();

 // Try matching by normalized URL first
 try {
  const normalizedInputUrl = normalizePlatformUrl(trimmed);
  const byUrl = allowed.find((p) => {
   try {
    return normalizePlatformUrl(p.apiUrl) === normalizedInputUrl;
   } catch {
    return false;
   }
  });
  if (byUrl) return byUrl;
 } catch {
  // Not a valid URL, fall through to id/label matching
 }

 // Try matching by id or label (case-insensitive)
 const lower = trimmed.toLowerCase();
 return allowed.find((p) => p.id.toLowerCase() === lower || p.label.toLowerCase() === lower);
}

/**
 * Returns true if the given API URL is in the operator allowlist.
 */
export function isPlatformAllowed(apiUrl: string): boolean {
 if (!apiUrl || typeof apiUrl !== 'string') return false;
 try {
  const target = normalizePlatformUrl(apiUrl);
  const allowed = getAllowedPlatforms();
  return allowed.some((p) => {
   try {
    return normalizePlatformUrl(p.apiUrl) === target;
   } catch {
    return false;
   }
  });
 } catch {
  return false;
 }
}
