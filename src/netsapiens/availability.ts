// @ts-ignore TS2823: Node 24 runtime supports import attributes with { type: 'json' }
import defaultAvailability from '../generated/availability.json' with { type: 'json' };
import type { VersionInfo } from './version.js';

export interface V2AvailabilityEntry {
  branches: string[];
  documented: string[];
  observed: Record<string, 'present' | 'absent'>;
}

export interface V1AvailabilityEntry {
  branches: string[];
  documented: string[];
}

export interface ObservationInfo {
  apiVersion: string;
  line: string;
  probedAt?: string;
  source?: string;
}

export interface AvailabilityData {
  schemaVersion: 2;
  branches: string[];
  observations: ObservationInfo[];
  v2: Record<string, V2AvailabilityEntry>;
  v1: Record<string, V1AvailabilityEntry>;
}

export const availability: AvailabilityData = defaultAvailability as unknown as AvailabilityData;

export interface DocsBranchResolution {
  docsBranch: string | null;
  match: 'exact' | 'nearest-lower' | 'newer-than-documented' | 'older-than-documented' | null;
  line: string | null;
}

export interface AvailabilityMeta {
  documented: boolean;
  observed?: 'present' | 'absent';
  branch: string;
  docsBranch: string;
  basis: 'documented' | 'observed' | 'baseline' | 'host-apidoc';
  status?: string;
  observation: string | null;
  hostVersion?: string | null;
  operations?: readonly string[];
}

export interface AvailabilityContext {
  versionInfo: VersionInfo;
  availability: AvailabilityData;
  isAvailable(key: string): boolean;
  getToolAvailability(
    toolOrKey: string | { operation?: { key?: string; family?: string }; schema?: { name?: string }; operations?: readonly string[] },
  ): AvailabilityMeta;
}

/**
 * Numeric version comparison helper (e.g. 44.4.10 vs 44.4.8).
 */
export function compareVersions(a: string, b: string): number {
  const segsA = a.split('.').map((s) => {
    const num = parseInt(s, 10);
    return Number.isNaN(num) ? 0 : num;
  });
  const segsB = b.split('.').map((s) => {
    const num = parseInt(s, 10);
    return Number.isNaN(num) ? 0 : num;
  });
  const maxLen = Math.max(segsA.length, segsB.length);
  for (let i = 0; i < maxLen; i++) {
    const valA = segsA[i] ?? 0;
    const valB = segsB[i] ?? 0;
    if (valA !== valB) return valA - valB;
  }
  return 0;
}

/**
 * Pure branch mapping:
 * - docsBranch is the highest branch <= the host's major.minor.
 * - match is 'exact', 'nearest-lower', 'newer-than-documented' (uses 46.0),
 *   or 'older-than-documented' (treated as unknown).
 */
export function resolveDocsBranch(
  apiVersion: string | null | undefined,
  branches: string[] = availability.branches,
): DocsBranchResolution {
  if (!apiVersion) {
    return { docsBranch: null, match: null, line: null };
  }
  const match = String(apiVersion).match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) {
    return { docsBranch: null, match: null, line: null };
  }
  const major = parseInt(match[1], 10);
  const minor = parseInt(match[2], 10);
  const line = `${major}.${minor}`;

  const parsedBranches = branches
    .map((b) => {
      const bMatch = b.match(/^(\d+)\.(\d+)/);
      if (!bMatch) return null;
      return {
        raw: b,
        major: parseInt(bMatch[1], 10),
        minor: parseInt(bMatch[2], 10),
      };
    })
    .filter((b): b is { raw: string; major: number; minor: number } => b !== null)
    .sort((a, b) => {
      if (a.major !== b.major) return a.major - b.major;
      return a.minor - b.minor;
    });

  if (parsedBranches.length === 0) {
    return { docsBranch: null, match: null, line };
  }

  const lowest = parsedBranches[0];
  const highest = parsedBranches[parsedBranches.length - 1];

  // Older than documented
  if (major < lowest.major || (major === lowest.major && minor < lowest.minor)) {
    return { docsBranch: null, match: 'older-than-documented', line };
  }

  // Newer than documented
  if (major > highest.major || (major === highest.major && minor > highest.minor)) {
    return { docsBranch: highest.raw, match: 'newer-than-documented', line };
  }

  // Find candidates <= major.minor
  const candidates = parsedBranches.filter(
    (b) => b.major < major || (b.major === major && b.minor <= minor),
  );
  const best = candidates[candidates.length - 1];

  const isExact = best.major === major && best.minor === minor;
  return {
    docsBranch: best.raw,
    match: isExact ? 'exact' : 'nearest-lower',
    line,
  };
}

/**
 * Pure observation lookup:
 * - Observations used: those with the same major.minor as the host;
 * - The highest observed version <= the host version, otherwise the lowest in that line.
 */
export function lookupObservation(
  line: string | null | undefined,
  apiVersion: string | null | undefined,
  observations: ObservationInfo[] = availability.observations,
): string | null {
  if (!line || !apiVersion) return null;

  const inLine = observations.filter((o) => {
    if (o.line) return o.line === line;
    const match = o.apiVersion.match(/^(\d+\.\d+)/);
    return match ? match[1] === line : false;
  });

  if (inLine.length === 0) return null;

  const sorted = [...inLine].sort((a, b) => compareVersions(a.apiVersion, b.apiVersion));
  const leq = sorted.filter((o) => compareVersions(o.apiVersion, apiVersion) <= 0);

  if (leq.length > 0) {
    return leq[leq.length - 1].apiVersion;
  }
  return sorted[0].apiVersion;
}

/**
 * Pure availability check for an OperationKey.
 */
export function isAvailable(
  key: string,
  versionInfo: {
    apiVersion?: string | null;
    docsBranch?: string | null;
    match?: string | null;
    status?: string;
    observation?: string | null;
    v1?: string;
    v1Keys?: Set<string>;
  },
  availabilityData: AvailabilityData = availability,
): boolean {
  // Check v1 tools
  if (availabilityData.v1 && key in availabilityData.v1) {
    if (versionInfo.v1 === 'ok' && versionInfo.v1Keys && versionInfo.v1Keys.has(key)) {
      return true;
    }
    return false;
  }

  // Check v2 operations
  const v2Entry = availabilityData.v2?.[key];
  if (!v2Entry) {
    return false;
  }

  const method = key.split(' ')[0].toUpperCase();

  // Rule 1: If the method is GET and an observation covers the key, the observation decides.
  if (method === 'GET' && versionInfo.observation) {
    const observedResult = v2Entry.observed?.[versionInfo.observation];
    if (observedResult !== undefined) {
      return observedResult === 'present';
    }
  }

  // Rule 2: If status is unknown or the host is older than documented, the key must be in baseline.
  if (versionInfo.status === 'unknown' || versionInfo.match === 'older-than-documented') {
    return (
      Array.isArray(v2Entry.documented) &&
      availabilityData.branches.every((b) => v2Entry.documented.includes(b))
    );
  }

  // Rule 3: documented must include docsBranch.
  if (versionInfo.docsBranch && Array.isArray(v2Entry.documented)) {
    return v2Entry.documented.includes(versionInfo.docsBranch);
  }

  return false;
}

/**
 * Compute availability metadata for a tool or operation key.
 */
export function getAvailabilityMeta(
  toolOrKey:
    | string
    | {
        operation?: { key?: string; family?: string };
        schema?: { name?: string };
        operations?: readonly string[];
      },
  versionInfo: {
    apiVersion?: string | null;
    docsBranch?: string | null;
    match?: string | null;
    status?: string;
    observation?: string | null;
    v1?: string;
    v1Keys?: Set<string>;
  },
  availabilityData: AvailabilityData = availability,
): AvailabilityMeta {
  const branch = versionInfo.docsBranch ?? '';
  const observation = versionInfo.observation ?? null;
  const hostVersion = versionInfo.apiVersion ?? null;
  const status = versionInfo.status ?? 'unknown';

  let key: string | null = null;
  let operations: readonly string[] | undefined;

  if (typeof toolOrKey === 'string') {
    key = toolOrKey;
  } else if (toolOrKey.operation?.key) {
    key = toolOrKey.operation.key;
  } else if (toolOrKey.operations) {
    operations = toolOrKey.operations;
    key = operations[0] ?? null;
  }

  if (!key) {
    return {
      documented: true,
      branch,
      docsBranch: branch,
      basis: 'documented',
      status,
      observation,
      hostVersion,
      operations,
    };
  }

  // v1 key
  if (availabilityData.v1 && key in availabilityData.v1) {
    const isAvail = Boolean(
      versionInfo.v1 === 'ok' && versionInfo.v1Keys && versionInfo.v1Keys.has(key),
    );
    return {
      documented: Boolean(
        versionInfo.docsBranch && availabilityData.v1[key]?.documented?.includes(versionInfo.docsBranch),
      ),
      branch,
      docsBranch: branch,
      basis: 'host-apidoc',
      status,
      observation,
      hostVersion,
      operations,
    };
  }

  const v2Entry = availabilityData.v2?.[key];
  const method = key.split(' ')[0].toUpperCase();
  const documented = Boolean(
    versionInfo.docsBranch && v2Entry?.documented?.includes(versionInfo.docsBranch),
  );
  const observed =
    versionInfo.observation && v2Entry?.observed
      ? v2Entry.observed[versionInfo.observation]
      : undefined;

  let basis: 'documented' | 'observed' | 'baseline' | 'host-apidoc' = 'documented';

  if (method === 'GET' && versionInfo.observation && observed !== undefined) {
    basis = 'observed';
  } else if (versionInfo.status === 'unknown' || versionInfo.match === 'older-than-documented') {
    basis = 'baseline';
  } else {
    basis = 'documented';
  }

  return {
    documented,
    observed,
    branch,
    docsBranch: branch,
    basis,
    status,
    observation,
    hostVersion,
    operations,
  };
}

/**
 * Creates an AvailabilityContext instance wrapping versionInfo and availabilityData.
 */
export function createAvailabilityContext(
  versionInfo: VersionInfo,
  availabilityData: AvailabilityData = availability,
): AvailabilityContext {
  return {
    versionInfo,
    availability: availabilityData,
    isAvailable(key: string): boolean {
      return isAvailable(key, versionInfo, availabilityData);
    },
    getToolAvailability(toolOrKey): AvailabilityMeta {
      return getAvailabilityMeta(toolOrKey, versionInfo, availabilityData);
    },
  };
}

/**
 * Default availability context (permissive fallback when no host context is supplied).
 */
export function getDefaultAvailabilityContext(): AvailabilityContext {
  const versionInfo: VersionInfo = {
    origin: 'default',
    apiVersion: '46.0.0',
    version: '46.0.0',
    line: '46.0',
    docsBranch: '46.0',
    branch: '46.0',
    match: 'exact',
    status: 'ok',
    state: 'fresh',
    checkedAt: new Date().toISOString(),
    v1: 'ok',
    v1Keys: new Set(),
    observation: null,
  };
  return createAvailabilityContext(versionInfo, availability);
}

/**
 * buildAvailability compatibility helper.
 * Clones or overrides availability data for testing and dynamic observation additions.
 */
export function buildAvailability(
  overrides?: Partial<AvailabilityData> & {
    extraPresent?: Record<string, string[]>;
    extraAbsent?: Record<string, string[]>;
    observations?: ObservationInfo[];
    repoRoot?: string;
  },
): AvailabilityData {
  const baseBranches = overrides?.branches ?? availability.branches;
  const baseObservations = overrides?.observations ?? availability.observations;

  const base: AvailabilityData = {
    schemaVersion: 2,
    branches: [...baseBranches],
    observations: [...baseObservations],
    v2: JSON.parse(JSON.stringify(overrides?.v2 ?? availability.v2)),
    v1: JSON.parse(JSON.stringify(overrides?.v1 ?? availability.v1)),
  };

  if (overrides?.extraPresent) {
    for (const [obsVersion, keys] of Object.entries(overrides.extraPresent)) {
      for (const rawKey of keys) {
        const key = rawKey.trim();
        if (!base.v2[key]) {
          base.v2[key] = { branches: [], documented: [], observed: {} };
        }
        if (!base.v2[key].observed) {
          base.v2[key].observed = {};
        }
        base.v2[key].observed[obsVersion] = 'present';
      }
    }
  }

  if (overrides?.extraAbsent) {
    for (const [obsVersion, keys] of Object.entries(overrides.extraAbsent)) {
      for (const rawKey of keys) {
        const key = rawKey.trim();
        if (!base.v2[key]) {
          base.v2[key] = { branches: [], documented: [], observed: {} };
        }
        if (!base.v2[key].observed) {
          base.v2[key].observed = {};
        }
        base.v2[key].observed[obsVersion] = 'absent';
      }
    }
  }

  return base;
}
