/**
 * The request path module, against independent oracles: the WHATWG URL parser (which axios uses), the expansion the
 * client made before the module existed, and every template the generated tools send.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { toolRegistry as v2Registry } from '../generated/registry.js';
import { normalizeOperationKey } from '../netsapiens/operation-key.js';
import {
  expandPathTemplate,
  finalPathBelowBase,
  operationKeyOfFinalPath,
  pathParameterRefusal,
  pathValueRefusal,
  V2_BASE_PATH,
} from '../netsapiens/request-path.js';

/** The expansion as NetSapiensClient.request wrote it before the module existed. Kept here as the oracle. */
function legacyExpansion(template: string, pathParams: Record<string, string> | undefined): string {
  let url = template;
  if (pathParams) {
    for (const [key, value] of Object.entries(pathParams)) {
      if (value === undefined || value === null) continue;
      url = url.replace(new RegExp(`\\{${key}\\}`, 'g'), encodeURIComponent(String(value)));
    }
  }
  return url;
}

/** Whether WHATWG, which axios uses, removes the value as a dot segment when it is one path segment. */
function whatwgRemovesSegment(value: string): boolean {
  const url = new URL(`http://h/a/${value}/z`);
  return url.pathname !== `/a/${value}/z`;
}

/** A deterministic sequence of strings over an alphabet that stresses dots, percent escapes and slashes. */
function samples(alphabet: string[], length: number, count: number, seed: number): string[] {
  let state = seed;
  const next = (): number => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state;
  };
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const size = 1 + (next() % length);
    let text = '';
    for (let j = 0; j < size; j++) text += alphabet[next() % alphabet.length];
    out.push(text);
  }
  return out;
}

describe('pathValueRefusal', () => {
  it.each(['', '.', '..', '%2e', '%2E', '%2e%2e', '%2E%2E', '.%2e', '%2e.', '%252e%252e'])(
    'refuses the dot-like value %j in every mode',
    (value) => {
      expect(pathValueRefusal(value, false)).toBe(value === '' ? 'empty' : 'dot_segment');
      expect(pathValueRefusal(value, true)).toBe(value === '' ? 'empty' : 'dot_segment');
    },
  );

  it.each([
    ['a/b', 'separator'],
    ['a\\b', 'separator'],
    ['a%2Fb', 'separator'],
    ['a%2fb', 'separator'],
    ['a%5Cb', 'separator'],
    ['a%5cb', 'separator'],
    ['..%2f', 'separator'],
    ['a\u0000b', 'control'],
    ['a\u001fb', 'control'],
    ['a\nb', 'control'],
    ['a\u007fb', 'control'],
  ])('refuses %j only in registry (strict) mode, as %s', (value, reason) => {
    expect(pathValueRefusal(value, true)).toBe(reason);
    expect(pathValueRefusal(value, false)).toBeUndefined();
  });

  it.each(['example.com', '1001', 'a.b..c', '...', '.hidden', 'x..', '~', '*', 'a-b_c', '100%', 'count'])(
    'lets the legitimate value %j through in both modes',
    (value) => {
      expect(pathValueRefusal(value, false)).toBeUndefined();
      expect(pathValueRefusal(value, true)).toBeUndefined();
    },
  );

  it('refuses every value that WHATWG removes as a dot segment (soundness against an independent parser)', () => {
    // Every sequence of up to three dot-related tokens. Each token is a dot, an encoded dot, an encoded slash or a
    // letter, so every dot-like form the parser could remove, encoded or not, appears in the enumeration.
    const tokens = ['.', '%2e', '%2E', '.%2e', '%2e.', '%252e', '%2f', 'x', '/'];
    const values = [...tokens];
    for (const first of tokens) for (const second of tokens) values.push(first + second);
    for (const first of tokens) for (const second of tokens) for (const third of tokens) values.push(first + second + third);
    // A value with a slash is never one segment: encodeURIComponent encodes the slash before the URL is parsed.
    const segments = values.filter((value) => !value.includes('/'));
    const removed = segments.filter(whatwgRemovesSegment);
    expect(removed).toContain('%2e');
    expect(removed).toContain('%2e%2e');
    for (const value of segments) {
      if (!whatwgRemovesSegment(value)) continue;
      expect(pathValueRefusal(value, false), `value ${JSON.stringify(value)}`).toBeDefined();
    }
  });

  it('accepts every value over an alphabet with no dots and no escapes (completeness on ordinary values)', () => {
    const alphabet = ['a', 'b', 'c', '1', '2', '_', '-', '~', '*', 'x'];
    for (const value of samples(alphabet, 8, 2000, 11)) {
      expect(pathValueRefusal(value, true), `value ${JSON.stringify(value)}`).toBeUndefined();
    }
  });
});

describe('pathParameterRefusal', () => {
  it('ignores parameters that were not supplied, and names the first refused one', () => {
    expect(pathParameterRefusal({ a: undefined as unknown as string, b: 'x' }, true)).toBeUndefined();
    expect(pathParameterRefusal({ a: 'ok', b: '..', c: '' }, false)).toEqual({ name: 'b', reason: 'dot_segment' });
  });
});

describe('expandPathTemplate', () => {
  it('expands every placeholder exactly as the client always has (oracle: the legacy loop)', () => {
    const templates = [
      '/domains/{domain}/servicecode/{type}/{code}',
      '/domains/{domain}/users/{user}number-filters',
      '/sipflow/download/{k}.txt',
      '/holidays/{country}/{region}/{year}',
    ];
    const values = ['clinic.example', '1001', 'a/b', 'a\\b', '100%', 'x y', '{domain}', 'é', '$&', '..', ''];
    for (const template of templates) {
      for (const value of values) {
        const params: Record<string, string> = { domain: value, type: value, code: value, user: value, k: value, country: value, region: value, year: value };
        expect(expandPathTemplate(template, params)).toBe(legacyExpansion(template, params));
      }
    }
  });
});

describe('finalPathBelowBase', () => {
  it('returns the path the HTTP layer sends below the API base', () => {
    expect(finalPathBelowBase('/domains/a.b/cdrs')).toBe('/domains/a.b/cdrs');
    expect(finalPathBelowBase('/')).toBe('/');
  });

  it.each(['/domains/a/../b', '/../../x', '/domains/a/./b', '/domains/%2e%2e/x'])(
    'reports no path when %s normalizes, so the request cannot be checked as sent',
    (expanded) => {
      expect(finalPathBelowBase(expanded)).toBeUndefined();
    },
  );

  it('reports no path for a value that does not start at the origin-relative root', () => {
    expect(finalPathBelowBase('domains/a')).toBeUndefined();
    expect(V2_BASE_PATH).toBe('/ns-api/v2');
  });
});

describe('operationKeyOfFinalPath', () => {
  const SERVICECODE = '/domains/{domain}/servicecode/{type}/{code}';

  it('keys the path it sends as the template keys it', () => {
    expect(operationKeyOfFinalPath('get', SERVICECODE, '/domains/clinic.example/servicecode/1001/x')).toBe(
      'GET /domains/{}/servicecode/{}/{}',
    );
  });

  it('refuses the reviewer demo: the sent path has fewer segments than the template', () => {
    expect(operationKeyOfFinalPath('GET', SERVICECODE, '/domains/clinic.example/servicecode/../transcriptions')).toBeUndefined();
  });

  it('refuses a template whose literal segments collapse, although its values are harmless', () => {
    expect(operationKeyOfFinalPath('GET', '/domains/{domain}/../{x}', '/domains/a/../b')).toBeUndefined();
  });

  it('refuses an empty placeholder segment', () => {
    expect(operationKeyOfFinalPath('GET', '/domains/{domain}/x', '/domains//x')).toBeUndefined();
  });

  it('keys a value that equals a sibling literal as the placeholder, not as the literal', () => {
    expect(operationKeyOfFinalPath('GET', '/domains/{domain}/users/{user}', '/domains/a/users/count')).toBe(
      'GET /domains/{}/users/{}',
    );
  });

  it('keys a mixed segment as the template writes it', () => {
    expect(operationKeyOfFinalPath('GET', '/domains/{domain}/users/{user}number-filters', '/domains/a/users/1001number-filters')).toBe(
      'GET /domains/{}/users/{user}number-filters',
    );
  });
});

/** Every pathTemplate literal in the generated tool sources. */
function generatedTemplates(): string[] {
  const directories = [new URL('../generated/tools/', import.meta.url), new URL('../generated/', import.meta.url)];
  const templates = new Set<string>();
  for (const directory of directories) {
    for (const entry of readdirSync(directory)) {
      if (!entry.endsWith('.ts')) continue;
      const source = readFileSync(new URL(entry, directory), 'utf8');
      for (const match of source.matchAll(/pathTemplate: '([^']*)'/g)) templates.add(match[1]);
    }
  }
  return [...templates];
}

describe('every generated operation keeps its own key for ordinary values', () => {
  const operationKeys = new Set<string>();
  for (const definition of v2Registry.values()) {
    if (definition.operation?.key !== undefined) operationKeys.add(definition.operation.key);
  }
  const ordinary = ['clinic.example', '1001', 'a.b..c', '~', '*', 'count', 'a-b_c', 'x'];

  it('finds the generated templates and operations', () => {
    expect(generatedTemplates().length).toBeGreaterThan(300);
    expect(operationKeys.size).toBeGreaterThan(300);
  });

  it('sends each template to the endpoint its key names, for every ordinary value', () => {
    const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
    let checked = 0;
    for (const template of generatedTemplates()) {
      if (!template.startsWith('/')) continue;
      for (const method of METHODS) {
        const key = normalizeOperationKey(method, template);
        if (!operationKeys.has(key)) continue;
        checked++;
        const placeholders = [...template.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]);
        for (const value of ordinary) {
          const pathParams = Object.fromEntries(placeholders.map((name) => [name, value]));
          const expanded = expandPathTemplate(template, pathParams);
          expect(operationKeyOfFinalPath(method, template, expanded), `${key} with ${value}`).toBe(key);
        }
        // A dot-segment value that is a whole segment is refused: its key must not survive. A value with a literal
        // beside it (such as "{user}number-filters") stays one segment, so the key stays; the value rule refuses it.
        for (const name of placeholders) {
          const pathParams = Object.fromEntries(placeholders.map((other) => [other, other === name ? '..' : 'x']));
          const wholeSegment = template.split('/').includes(`{${name}}`);
          const keyed = operationKeyOfFinalPath(method, template, expandPathTemplate(template, pathParams));
          if (wholeSegment) {
            expect(keyed, `${key} with .. at ${name}`).toBeUndefined();
          } else {
            expect(keyed, `${key} with .. beside a literal at ${name}`).toBe(key);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(300);
  });
});
