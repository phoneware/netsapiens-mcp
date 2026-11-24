/**
 * Env-unset baseline: the tool surface must not change while no access registry is configured.
 *
 * fixtures/tools-baseline.json records getAllToolDefinitions() for every role, both tool modes and two NetSapiens
 * versions (44.4.10, observed; 46.0.0, newest documented), with every MCP_* variable cleared. Each distinct tool body
 * and each _meta is stored once under a digest of its canonical JSON. Every combination lists its tools as
 * [name, bodyKey, metaKey].
 *
 * A failure means the tool surface changed. If the change is intended, regenerate and review the diff:
 *   ACCESS_BASELINE_REGENERATE=1 npx vitest run src/__tests__/access-baseline.test.ts
 * Never regenerate to clear a failure you have not explained.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { UserRole } from '../auth/roles.js';
import { createAvailabilityContext, lookupObservation, resolveDocsBranch } from '../netsapiens/availability.js';
import type { VersionInfo } from '../netsapiens/version.js';
import { getAllToolDefinitions } from '../tools/index.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/tools-baseline.json', import.meta.url));
const FORMAT = 'netsapiens-mcp tools baseline v2';
const VERSIONS = ['44.4.10', '46.0.0'];
const ROLES: Array<UserRole | undefined> = [undefined, 'user', 'domain_admin', 'reseller', 'system_admin'];
const MODES = ['curated', 'full'];
const MAX_FIELD_LINES = 12;

type Body = Record<string, unknown>;
type Ref = [name: string, bodyKey: string, metaKey: string | null];

interface Surface {
  versionInfo: Record<string, unknown>;
  bodies: Record<string, Body>;
  metas: Record<string, unknown>;
  combos: Record<string, Ref[]>;
}

/** The committed file is persisted data, so it is validated once at the boundary. */
const CommittedSchema = z.object({
  format: z.literal(FORMAT),
  versions: z.array(z.string()),
  versionInfo: z.record(z.string(), z.unknown()),
  roles: z.array(z.string()),
  modes: z.array(z.string()),
  surfaceSha256: z.string(),
  bodies: z.record(z.string(), z.record(z.string(), z.unknown())),
  metas: z.record(z.string(), z.unknown()),
  combos: z.record(z.string(), z.array(z.tuple([z.string(), z.string(), z.string().nullable()]))),
});

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function sortedObject(source: Body): Body {
  const out: Body = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] !== undefined) out[key] = sortKeys(source[key]);
  }
  return out;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  // typeof has narrowed value to an object; JSON-shaped data is a record of unknown members.
  if (value && typeof value === 'object') return sortedObject(value as Body);
  return value;
}

const canonical = (value: unknown): string => JSON.stringify(sortKeys(value));
const digest16 = (value: unknown): string => sha256(canonical(value)).slice(0, 16);

/** Mirrors doFetchOrigin() in src/netsapiens/version.ts without the network. */
function versionFor(apiVersion: string): VersionInfo {
  const { docsBranch, match, line } = resolveDocsBranch(apiVersion);
  return {
    origin: 'https://pbx.example.test',
    apiVersion,
    version: apiVersion,
    line,
    docsBranch,
    branch: docsBranch,
    match,
    status: 'ok',
    state: 'fresh',
    checkedAt: '2026-11-23T00:00:00.000Z',
    v1: 'unavailable',
    v1Keys: new Set<string>(),
    observation: lookupObservation(line, apiVersion),
  };
}

function expandCombo(surface: Surface, refs: readonly Ref[]): Array<{ name: string; tool: Body }> {
  return refs.map(([name, bodyKey, metaKey]) => {
    const body = surface.bodies[bodyKey];
    if (body === undefined) throw new Error(`tools-baseline.json has no body ${bodyKey} for tool ${name}`);
    const tool: Body = { name, ...body };
    if (metaKey !== null) tool._meta = surface.metas[metaKey];
    return { name, tool };
  });
}

/** Builds the surface from the live code, with the same storage rules the committed file uses. */
async function liveSurface(): Promise<Surface> {
  const surface: Surface = { versionInfo: {}, bodies: {}, metas: {}, combos: {} };
  const raw = new Map<string, Body[]>();
  const bodyCanon = new Map<string, string>();
  const metaCanon = new Map<string, string>();
  for (const apiVersion of VERSIONS) {
    const info = versionFor(apiVersion);
    surface.versionInfo[apiVersion] = {
      line: info.line,
      docsBranch: info.docsBranch,
      match: info.match,
      observation: info.observation,
    };
    const ctx = createAvailabilityContext(info);
    for (const mode of MODES) {
      process.env.MCP_TOOL_MODE = mode;
      for (const role of ROLES) {
        // ExposedTool is an interface with optional members; the loops below read it as the plain record it serializes to.
        const list = (await getAllToolDefinitions(role, undefined, ctx)) as unknown as Body[];
        const key = `${mode}|${apiVersion}|${role ?? 'no-role'}`;
        raw.set(key, list);
        surface.combos[key] = list.map((tool): Ref => {
          const { name, _meta, ...body } = tool;
          if (typeof name !== 'string') throw new Error(`a tool in ${key} has no name`);
          const bodyKey = digest16(body);
          const bodyText = canonical(body);
          if (!bodyCanon.has(bodyKey)) {
            bodyCanon.set(bodyKey, bodyText);
            surface.bodies[bodyKey] = sortedObject(body);
          } else if (bodyCanon.get(bodyKey) !== bodyText) {
            throw new Error(`body digest collision at ${bodyKey}`);
          }
          let metaKey: string | null = null;
          if (_meta !== undefined) {
            const metaText = canonical(_meta);
            metaKey = digest16(_meta);
            if (!metaCanon.has(metaKey)) {
              metaCanon.set(metaKey, metaText);
              surface.metas[metaKey] = sortKeys(_meta);
            } else if (metaCanon.get(metaKey) !== metaText) {
              throw new Error(`meta digest collision at ${metaKey}`);
            }
          }
          return [name, bodyKey, metaKey];
        });
      }
    }
  }
  delete process.env.MCP_TOOL_MODE;

  // The stored references must reproduce the raw output exactly, or the comparison below proves less than it claims.
  for (const [key, list] of raw) {
    const expanded = expandCombo(surface, surface.combos[key]).map((entry) => entry.tool);
    if (canonical(expanded) !== canonical(list)) {
      throw new Error(`stored references for ${key} do not reproduce the live tool output`);
    }
  }
  return surface;
}

/** The exact text the regeneration writes. The final comparison fails if the committed bytes differ from it. */
function serialize(surface: Surface): string {
  const surfaceSha256 = sha256(canonical(surface.combos));
  const combosText = Object.entries(surface.combos)
    .map(([key, refs]) => `    ${JSON.stringify(key)}: [\n${refs.map((r) => `      ${JSON.stringify(r)}`).join(',\n')}\n    ]`)
    .join(',\n');
  return (
    '{\n' +
    `  "format": ${JSON.stringify(FORMAT)},\n` +
    `  "versions": ${JSON.stringify(VERSIONS)},\n` +
    `  "versionInfo": ${JSON.stringify(surface.versionInfo, null, 2).replace(/\n/g, '\n  ')},\n` +
    `  "roles": ${JSON.stringify(ROLES.map((role) => role ?? 'no-role'))},\n` +
    `  "modes": ${JSON.stringify(MODES)},\n` +
    `  "surfaceSha256": ${JSON.stringify(surfaceSha256)},\n` +
    `  "bodies": ${JSON.stringify(surface.bodies, null, 2).replace(/\n/g, '\n  ')},\n` +
    `  "metas": ${JSON.stringify(surface.metas, null, 2).replace(/\n/g, '\n  ')},\n` +
    `  "combos": {\n${combosText}\n  }\n` +
    '}\n'
  );
}

/** Line diff of one tool's JSON, limited to the lines that differ. */
function fieldDifference(before: unknown, after: unknown): string[] {
  const a = JSON.stringify(sortKeys(before), null, 2).split('\n');
  const b = JSON.stringify(sortKeys(after), null, 2).split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return [
    ...a.slice(start, endA).slice(0, MAX_FIELD_LINES).map((line) => `      - ${line}`),
    ...b.slice(start, endB).slice(0, MAX_FIELD_LINES).map((line) => `      + ${line}`),
  ];
}

function diffSurfaces(committed: Surface, live: Surface): string[] {
  const lines: string[] = [];
  const keys = [...new Set([...Object.keys(committed.combos), ...Object.keys(live.combos)])];
  for (const key of keys) {
    const before = committed.combos[key];
    const after = live.combos[key];
    if (before === undefined || after === undefined) {
      lines.push(before === undefined ? `+ ${key} is new` : `- ${key} was removed`);
      continue;
    }
    const a = expandCombo(committed, before);
    const b = expandCombo(live, after);
    const identical = a.length === b.length && a.every((entry, i) => canonical(entry.tool) === canonical(b[i].tool));
    if (identical) continue;

    const section: string[] = [`~ ${key}: ${a.length} tools committed, ${b.length} live`];
    const beforeByName = new Map(a.map((entry) => [entry.name, entry.tool] as const));
    const afterByName = new Map(b.map((entry) => [entry.name, entry.tool] as const));
    for (const [name, tool] of beforeByName) {
      const next = afterByName.get(name);
      if (next === undefined) {
        section.push(`  - ${name}`);
      } else if (canonical(tool) !== canonical(next)) {
        section.push(`  ~ ${name}`, ...fieldDifference(tool, next));
      }
    }
    for (const name of afterByName.keys()) {
      if (!beforeByName.has(name)) section.push(`  + ${name}`);
    }
    if (section.length === 1) section.push('  ! same tools, different order');
    lines.push(...section);
  }
  return lines;
}

describe('env-unset tool surface baseline', () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeAll(() => {
    savedEnv = { ...process.env };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('MCP_')) delete process.env[key];
    }
  });

  afterAll(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('MCP_')) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  });

  it('matches the committed baseline for every role, mode and version', async () => {
    const live = await liveSurface();
    if (process.env.ACCESS_BASELINE_REGENERATE === '1') {
      writeFileSync(FIXTURE, serialize(live));
      return;
    }

    const committedText = readFileSync(FIXTURE, 'utf8');
    const raw: unknown = JSON.parse(committedText);
    const parsed = CommittedSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`fixtures/tools-baseline.json has the wrong shape: ${parsed.error.message}`);
    const committed = parsed.data;

    for (const [key, body] of Object.entries(committed.bodies)) {
      expect(digest16(body), `committed body ${key} does not match its digest`).toBe(key);
    }
    for (const [key, meta] of Object.entries(committed.metas)) {
      expect(digest16(meta), `committed meta ${key} does not match its digest`).toBe(key);
    }
    expect(sha256(canonical(committed.combos)), 'surfaceSha256 does not match the committed combinations').toBe(
      committed.surfaceSha256,
    );

    const differences = diffSurfaces(committed, live);
    if (differences.length > 0) {
      throw new Error(
        ['The tool surface differs from fixtures/tools-baseline.json (env unset):', ...differences].join('\n'),
      );
    }
    expect(
      serialize(live) === committedText,
      'fixtures/tools-baseline.json is not the canonical serialization of the live surface; regenerate it deliberately',
    ).toBe(true);
  });
});
