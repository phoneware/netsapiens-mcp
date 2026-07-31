/**
 * Guard against silently-discarded writes.
 *
 * A curated composite hand-writes its request body. If it invents a field name,
 * NetSapiens ignores the unknown key and answers success, so the tool reports
 * that it worked while changing nothing. That is exactly what happened with
 * `schedule_forwarding`, which sent `rule-action` / `forward-destination` for
 * months — names that appear nowhere in the spec and nowhere in the controller
 * source. Tests asserting the invented shape are what let it survive.
 *
 * So: drive every write composite against a recording client, then check each
 * body key against the OpenAPI operation the request actually targets. A field
 * the spec does not declare fails here rather than in production.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CURATED_CATALOG } from '../tools/curated/catalog.js';
import { WORKFLOW_TOOLS } from '../tools/curated/workflows.js';
import type { GenericApiClient } from '../generated/types.js';

interface SpecSchema {
  $ref?: string;
  type?: string;
  required?: string[];
  properties?: Record<string, SpecSchema>;
  items?: SpecSchema;
  allOf?: SpecSchema[];
}
interface SpecOperation {
  requestBody?: { content?: Record<string, { schema?: SpecSchema }> };
}
interface Spec {
  paths: Record<string, Record<string, SpecOperation>>;
  components?: { schemas?: Record<string, SpecSchema> };
}

const spec = JSON.parse(readFileSync('spec/netsapiens-api-v2.json', 'utf8')) as Spec;

function deref(schema: SpecSchema | undefined, depth = 0): SpecSchema | undefined {
  if (!schema || depth > 8) return schema;
  if (schema.$ref) {
    const key = schema.$ref.split('/').pop()!;
    return deref(spec.components?.schemas?.[key], depth + 1);
  }
  return schema;
}

/** Every property name an operation's request body declares, including allOf branches. */
function declaredBodyFields(op: SpecOperation): Set<string> {
  const out = new Set<string>();
  for (const media of Object.values(op.requestBody?.content ?? {})) {
    const schema = deref(media.schema);
    if (!schema) continue;
    const branches = [schema, ...(schema.allOf ?? []).map((b) => deref(b)!)];
    for (const b of branches) {
      for (const k of Object.keys(b?.properties ?? {})) out.add(k);
    }
  }
  return out;
}

/**
 * Match a request's path template to a spec path. Composites use `~` for
 * "the authenticated user / their domain" and their own placeholder names, so
 * compare structurally: same segment count, literals equal, placeholders and
 * `~` matching anything.
 */
function findSpecPath(pathTemplate: string): string[] {
  const want = pathTemplate.split('/').filter(Boolean);
  const isWild = (seg: string) => seg === '~' || (seg.startsWith('{') && seg.endsWith('}'));
  return Object.keys(spec.paths).filter((candidate) => {
    // `/timeframes` and `/timeframes#1` are the same HTTP path; the spec splits
    // them because NetSapiens distinguishes the variants by body shape.
    const got = candidate.replace(/#\d+$/, '').split('/').filter(Boolean);
    if (got.length !== want.length) return false;
    return got.every((seg, i) => isWild(seg) || isWild(want[i]) || seg === want[i]);
  });
}

interface Recorded {
  method: string;
  pathTemplate: string;
  body?: Record<string, unknown>;
}

/** A client that records requests and returns plausible empty successes. */
function recordingClient(recorded: Recorded[]): GenericApiClient {
  return {
    request: async (o: Recorded) => {
      recorded.push(o);
      return { success: true, data: [] };
    },
  } as unknown as GenericApiClient;
}

/**
 * Representative arguments per composite. Only composites that write are
 * listed; reads cannot silently discard a field.
 */
const WRITE_CASES: Array<{ tool: string; args: Record<string, unknown> }> = [
  { tool: 'schedule_forwarding', args: { destination: '4001' } },
  { tool: 'schedule_forwarding', args: { destination: '4001', until: '2026-08-07 17:00' } },
  { tool: 'provision_user', args: { user: '1001', first_name: 'A', last_name: 'B', email: 'a@b.com', device: '1001a', phone_number: '+13035551212' } },
  { tool: 'provision_call_queue', args: { callqueue: 'support', agents: ['1001'], phone_number: '+13035551212' } },
];

const ALL = [...CURATED_CATALOG, ...WORKFLOW_TOOLS];

describe('curated composites only send fields the API declares', () => {
  for (const { tool, args } of WRITE_CASES) {
    it(`${tool} — ${Object.keys(args).join(', ')}`, async () => {
      const def = ALL.find((t) => t.schema.name === tool);
      expect(def, `${tool} is not in the catalog`).toBeTruthy();

      const recorded: Recorded[] = [];
      await def!.handler(args, recordingClient(recorded));

      const writes = recorded.filter((r) => r.body && ['POST', 'PUT', 'PATCH'].includes(r.method.toUpperCase()));
      expect(writes.length, 'expected this case to perform at least one write').toBeGreaterThan(0);

      for (const w of writes) {
        const candidates = findSpecPath(w.pathTemplate);
        expect(candidates.length, `no spec path matches ${w.pathTemplate}`).toBeGreaterThan(0);

        // A template can match several spec variants (the `#1`/`#2` suffixed
        // ones). A field declared by any matching variant is legitimate.
        const declared = new Set<string>();
        for (const p of candidates) {
          const op = spec.paths[p][w.method.toLowerCase()];
          if (!op) continue;
          for (const f of declaredBodyFields(op)) declared.add(f);
        }
        expect(declared.size, `no ${w.method} operation declared for ${w.pathTemplate}`).toBeGreaterThan(0);

        for (const key of Object.keys(w.body!)) {
          expect(
            declared.has(key),
            `${tool} sends "${key}" to ${w.method} ${w.pathTemplate}, which the spec does not declare. ` +
              `NetSapiens ignores unknown keys and still answers success, so this would silently do nothing. ` +
              `Declared: ${[...declared].sort().join(', ')}`,
          ).toBe(true);
        }
      }
    });
  }
});

describe('multipart-only operations are marked unreachable', () => {
  /** Operations whose only request body is multipart/form-data. */
  function multipartOnlyPaths(): string[] {
    const out: string[] = [];
    for (const [p, item] of Object.entries(spec.paths)) {
      for (const [m, op] of Object.entries(item)) {
        const content = op.requestBody?.content;
        if (!content) continue;
        const keys = Object.keys(content);
        if (keys.length === 1 && keys[0] === 'multipart/form-data') out.push(`${m.toUpperCase()} ${p}`);
      }
    }
    return out.sort();
  }

  it('the hard-coded list still matches the spec', async () => {
    const { MULTIPART_ONLY_OPERATIONS } = await import('../tools/multipart.js');
    // Derived from the spec so the constant cannot drift silently when the
    // vendored spec is updated.
    expect([...MULTIPART_ONLY_OPERATIONS].sort()).toEqual(multipartOnlyPaths());
  });

  /** True when some variant of the same path offers a JSON body for this method. */
  function hasJsonSibling(entry: string): boolean {
    const [method, path] = entry.split(' ');
    const base = path.replace(/#\d+$/, '');
    return Object.keys(spec.paths)
      .filter((p) => p.replace(/#\d+$/, '') === base)
      .some((p) => Boolean(spec.paths[p][method.toLowerCase()]?.requestBody?.content?.['application/json']));
  }

  it('greetings, music-on-hold and images can be done without an upload', () => {
    const steerable = multipartOnlyPaths().filter((e) => /greeting|moh|image/.test(e));
    expect(steerable.length).toBeGreaterThan(0);
    for (const entry of steerable) {
      expect(hasJsonSibling(entry), `${entry} lost its JSON alternative`).toBe(true);
    }
  });

  it('hold messages have no alternative, so they need real multipart support', () => {
    // Documented rather than asserted away: /msg is upload-only in the API, and
    // uploading is the only way to set a hold message. If NetSapiens ever adds
    // a TTS variant this test fails and the client-side upload path can go.
    const msg = multipartOnlyPaths().filter((e) => /\/msg/.test(e));
    expect(msg.length).toBe(4);
    for (const entry of msg) {
      expect(hasJsonSibling(entry), `${entry} now has a JSON alternative`).toBe(false);
    }
  });
});
