/**
 * Pattern matching cost and semantics for tools.allow and tools.deny.
 *
 * The matcher must take time linear in the name, so a hostile pattern cannot stall a call, and names longer than
 * the limit are refused before any pattern is tried. The reference below is a regular expression; it is the oracle
 * on short inputs only, where it cannot blow up.
 */
import { describe, expect, it } from 'vitest';
import type { AccessPolicyV1 } from '../access/contract.js';
import { compilePolicy } from '../access/policy.js';
import { toolRegistry } from '../generated/registry.js';
import { v1ToolRegistry } from '../generated/v1/registry.js';
import { CURATED_CATALOG } from '../tools/curated/catalog.js';

/** Tool names longer than this are refused as not_allowed before any pattern is tried. */
const NAME_LIMIT = 256;

/** Generous bound for one decision. The fixed matcher takes well under a millisecond on these inputs. */
const BUDGET_MS = 250;

const NO_CATALOG = {
  lookupTool: () => undefined,
  lookupOperation: () => undefined,
};

const ALL_CONTENT_ALLOW = {
  call_recording: 'allow',
  transcript: 'allow',
  voicemail: 'allow',
  sms_text: 'allow',
  ai_summary: 'allow',
  fax_page: 'allow',
} as const;

function policyWith(allow: readonly string[], deny: readonly string[] = []): AccessPolicyV1 {
  return {
    tools: { allow: [...allow], deny: [...deny] },
    access: 'write',
    content: ALL_CONTENT_ALLOW,
    unclassifiedOutput: 'allow',
    platforms: [],
  };
}

function timed<T>(run: () => T): { readonly value: T; readonly elapsedMs: number } {
  const started = performance.now();
  const value = run();
  return { value, elapsedMs: performance.now() - started };
}

/** Seeded generator, so the random cases are the same on every run. */
function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PATTERN_CHARACTERS = ['a', 'b', '_', '.', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\', '*', '*', '*'];
const NAME_CHARACTERS = ['a', 'b', '_', '.', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\', '*', '\n'];

function randomText(next: () => number, alphabet: readonly string[], length: number): string {
  let text = '';
  for (let i = 0; i < length; i++) {
    text += alphabet[Math.floor(next() * alphabet.length)];
  }
  return text;
}

/** A name the pattern matches: each star becomes a random run of characters. */
function instantiate(next: () => number, pattern: string): string {
  const [head, ...rest] = pattern.split('*');
  let name = head;
  for (const piece of rest) {
    name += randomText(next, NAME_CHARACTERS, Math.floor(next() * 3)) + piece;
  }
  return name;
}

/** The oracle: each literal piece escaped, each star widened to any run of characters, anchored at both ends. */
function referenceMatches(pattern: string, name: string): boolean {
  const body = pattern
    .split('*')
    .map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s\\S]*');
  return new RegExp(`^${body}$`).test(name);
}

describe('glob matching time', () => {
  const hostile = compilePolicy(policyWith(['*'], ['*a*a*a*a*b']), NO_CATALOG, 'r1');

  it('decides the measured 100-character name well under the budget', () => {
    const { value, elapsedMs } = timed(() => hostile.toolDecision('a'.repeat(100)));
    expect(elapsedMs).toBeLessThan(BUDGET_MS);
    expect(value).toEqual({ allowed: true });
  });

  it('decides the measured 200-character name well under the budget', () => {
    const { value, elapsedMs } = timed(() => hostile.toolDecision('a'.repeat(200)));
    expect(elapsedMs).toBeLessThan(BUDGET_MS);
    expect(value).toEqual({ allowed: true });
  });

  it('refuses the measured 400-character name well under the budget, without matching it', () => {
    const { value, elapsedMs } = timed(() => hostile.toolDecision('a'.repeat(400)));
    expect(elapsedMs).toBeLessThan(BUDGET_MS);
    expect(value).toEqual({ allowed: false, reason: 'not_allowed' });
  });

  it('refuses the measured 256,000-character name against *_get_*_list well under the budget', () => {
    const listing = compilePolicy(policyWith(['*'], ['*_get_*_list']), NO_CATALOG, 'r1');
    const { value, elapsedMs } = timed(() => listing.toolDecision('_get_x'.repeat(42667)));
    expect(elapsedMs).toBeLessThan(BUDGET_MS);
    expect(value).toEqual({ allowed: false, reason: 'not_allowed' });
  });
});

describe('tool name length', () => {
  it('refuses a 257-character name even when every tool is allowed and nothing is denied', () => {
    const everything = compilePolicy(policyWith(['*'], []), NO_CATALOG, 'r1');
    expect(everything.toolDecision('a'.repeat(NAME_LIMIT + 1))).toEqual({ allowed: false, reason: 'not_allowed' });
  });

  it('still decides a name exactly at the limit', () => {
    const everything = compilePolicy(policyWith(['*'], []), NO_CATALOG, 'r1');
    expect(everything.toolDecision('a'.repeat(NAME_LIMIT))).toEqual({ allowed: true });
  });

  it('ships no tool whose name is longer than the limit, so the limit refuses no real tool', () => {
    const names = [
      ...CURATED_CATALOG.map((tool) => tool.schema.name),
      ...toolRegistry.keys(),
      ...v1ToolRegistry.keys(),
    ];
    expect(Math.max(...names.map((name) => name.length))).toBeLessThanOrEqual(NAME_LIMIT);
  });
});

describe('glob semantics', () => {
  it.each([
    ['*', '', true],
    ['**', '', true],
    ['a*', 'a', true],
    ['*a', 'a', true],
    ['a*a', 'a', false],
    ['a**b', 'ab', true],
    ['*a*a*b', 'aab', true],
    ['*a*a*b', 'ab', false],
    ['a*b*c', 'abc', true],
    ['a*bb*b', 'abb', false],
    ['get_*', 'get_domains', true],
    ['get_*', 'Get_domains', false],
    ['*.*', 'a.b', true],
    ['a?b', 'a?b', true],
    ['a?b', 'axb', false],
    ['*', 'line\nbreak', true],
  ])('pattern %j decides name %j as %s', (pattern, name, expected) => {
    const policy = compilePolicy(policyWith([pattern]), NO_CATALOG, 'r1');
    expect(policy.toolDecision(name).allowed).toBe(expected);
  });

  it('agrees with a reference regular expression on thousands of random pattern and name pairs', () => {
    const next = mulberry32(20261123);
    let matched = 0;
    let unmatched = 0;
    for (let i = 0; i < 1500; i++) {
      const pattern = randomText(next, PATTERN_CHARACTERS, 1 + Math.floor(next() * 8));
      const policy = compilePolicy(policyWith([pattern]), NO_CATALOG, 'r1');
      const names = [instantiate(next, pattern), randomText(next, NAME_CHARACTERS, Math.floor(next() * 9))];
      for (const name of names) {
        const expected = referenceMatches(pattern, name);
        expect(
          policy.toolDecision(name).allowed,
          `pattern ${JSON.stringify(pattern)}, name ${JSON.stringify(name)}`,
        ).toBe(expected);
        if (expected) matched++;
        else unmatched++;
      }
    }
    expect(matched).toBeGreaterThan(500);
    expect(unmatched).toBeGreaterThan(500);
  });
});
