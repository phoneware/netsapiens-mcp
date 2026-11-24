import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { buildGovernanceTables, type BuildBranch } from '../governance/build.js';
import { forEachProperty, inlineNames, type Components, type SchemaNode, type SpecOperation } from '../governance/spec-walk.js';
import type { FieldClass } from '../governance/types.js';

const TRANSCRIPT: FieldClass = { class: 'content', kind: 'transcript', media: 'text' };
const AI_SUMMARY: FieldClass = { class: 'content', kind: 'ai_summary', media: 'text' };

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const jsonResponse = (schema: unknown): SpecOperation => ({
  responses: { '200': { content: { 'application/json': { schema: schema as never } } } },
});

function branch(components: Components, operations: readonly { key: string; op: SpecOperation }[]): BuildBranch {
  return { components, operations: operations.map(({ key, op }) => ({ key, operation: op })) };
}

const NO_CUSTOMS = {};

describe('builder: list components and allOf merges declare their item fields', () => {
  it('gives a list of references the fields of its item, with the item overrides applied', () => {
    const out = buildGovernanceTables({
      branches: [
        branch(
          {
            Item: { type: 'object', properties: { id: { type: 'string' }, 'file-transcript-text': { type: 'string' } } },
            ItemList: { type: 'array', items: ref('Item') },
          },
          [{ key: 'GET /items', op: jsonResponse(ref('ItemList')) }],
        ),
      ],
      overrides: { Item: { 'file-transcript-text': TRANSCRIPT } },
      customs: NO_CUSTOMS,
    });
    expect(Object.keys(out.fields.ItemList).sort()).toEqual(['file-transcript-text', 'id']);
    expect(out.fields.ItemList['file-transcript-text']).toEqual(TRANSCRIPT);
    expect(out.outputs['GET /items']).toBe('Union(Item,ItemList)');
  });

  it('flattens an allOf into the union of the fields of every part', () => {
    const out = buildGovernanceTables({
      branches: [
        branch(
          {
            Base: { type: 'object', properties: { id: { type: 'string' } } },
            Merged: { allOf: [ref('Base'), { type: 'object', properties: { extra: { type: 'string' } } }] },
          },
          [],
        ),
      ],
      overrides: {},
      customs: NO_CUSTOMS,
    });
    expect(Object.keys(out.fields.Merged).sort()).toEqual(['extra', 'id']);
  });

  it('keeps the fields a component declares in any branch, not only the last', () => {
    const out = buildGovernanceTables({
      branches: [
        branch({ Thing: { type: 'object', properties: { a: { type: 'string' } } } }, []),
        branch({ Thing: { type: 'object', properties: { b: { type: 'string' } } } }, []),
      ],
      overrides: {},
      customs: NO_CUSTOMS,
    });
    expect(Object.keys(out.fields.Thing).sort()).toEqual(['a', 'b']);
  });
});

describe('builder: an operation maps to every branch that defines it', () => {
  it('takes the union of the components each branch returns, so an older host is covered', () => {
    const out = buildGovernanceTables({
      branches: [
        branch({ Old: { type: 'object', properties: { id: { type: 'string' }, transcription: { type: 'string' } } } }, [
          { key: 'GET /v', op: jsonResponse(ref('Old')) },
        ]),
        branch({ New: { type: 'object', properties: { id: { type: 'string' } } } }, [{ key: 'GET /v', op: jsonResponse(ref('New')) }]),
      ],
      overrides: { Old: { transcription: TRANSCRIPT } },
      customs: NO_CUSTOMS,
    });
    expect(out.outputs['GET /v']).toBe('Union(New,Old)');
    expect(out.fields['Union(New,Old)'].transcription).toEqual(TRANSCRIPT);
    expect(out.fields.New).not.toHaveProperty('transcription');
  });

  it('merges two content kinds on one field into the primary kind and alsoKinds, without failing', () => {
    const out = buildGovernanceTables({
      branches: [
        branch({ A: { type: 'object', properties: { f: { type: 'string' } } }, B: { type: 'object', properties: { f: { type: 'string' } } } }, [
          { key: 'GET /ab', op: jsonResponse({ oneOf: [ref('A'), ref('B')] }) },
        ]),
      ],
      overrides: { A: { f: TRANSCRIPT }, B: { f: AI_SUMMARY } },
      customs: NO_CUSTOMS,
    });
    expect(out.fields['Union(A,B)'].f).toEqual({ class: 'content', kind: 'transcript', media: 'text', alsoKinds: ['ai_summary'] });
  });

  it('maps an inline object response to InlineResponse, classing credential names as secrets', () => {
    const out = buildGovernanceTables({
      branches: [
        branch({}, [
          {
            key: 'GET /inline',
            op: jsonResponse({ type: 'object', properties: { password: { type: 'string' }, message: { type: 'string' } } }),
          },
        ]),
      ],
      overrides: {},
      customs: NO_CUSTOMS,
    });
    expect(out.outputs['GET /inline']).toBe('InlineResponse');
    expect(out.fields.InlineResponse.password).toEqual({ class: 'secret' });
    expect(out.fields.InlineResponse.message).toEqual({ class: 'metadata' });
  });

  it('leaves a non-JSON response unmapped, because its fields are not known', () => {
    const out = buildGovernanceTables({
      branches: [branch({}, [{ key: 'GET /file', op: { responses: { '200': { content: { 'audio/wav': {} } } } } }])],
      overrides: {},
      customs: NO_CUSTOMS,
    });
    expect(out.outputs).not.toHaveProperty('GET /file');
  });

  it('refuses a mapped resource whose field table is empty, unless the schema is whitelisted', () => {
    const input = {
      branches: [branch({ Empty: { type: 'object' } }, [{ key: 'GET /empty', op: jsonResponse(ref('Empty')) }])],
      overrides: {},
      customs: NO_CUSTOMS,
    };
    expect(() => buildGovernanceTables(input)).toThrow(/empty field table/);
    const whitelisted = buildGovernanceTables({ ...input, emptyByDesign: { Empty: 'a free-form object with no declared fields' } });
    expect(whitelisted.outputs['GET /empty']).toBe('Empty');
  });

  it('gives identical output on every run', () => {
    const input = {
      branches: [branch({ X: { type: 'object', properties: { id: { type: 'string' } } } }, [{ key: 'GET /x', op: jsonResponse(ref('X')) }])],
      overrides: {},
      customs: NO_CUSTOMS,
    };
    expect(buildGovernanceTables(input)).toEqual(buildGovernanceTables(input));
  });
});

/** A chain whose every level is an allOf of the level below it, twice, so the paths below each level double. */
function doubledChain(levels: number): Components {
  const components: Record<string, SchemaNode> = { [`C${levels}`]: { type: 'object', properties: { id: { type: 'string' } } } };
  for (let level = levels - 1; level >= 0; level--) components[`C${level}`] = { allOf: [ref(`C${level + 1}`), ref(`C${level + 1}`)] };
  return components;
}

/** An inline object nested the given number of levels, each one a property of the one above it. */
function nestedObject(levels: number): SchemaNode {
  let node: SchemaNode = { type: 'string' };
  for (let level = 0; level < levels; level++) node = { type: 'object', properties: { next: node } };
  return node;
}

/** An inline allOf nested the given number of levels, around one object with a single field. */
function nestedAllOf(levels: number): SchemaNode {
  let node: SchemaNode = { type: 'object', properties: { id: { type: 'string' } } };
  for (let level = 0; level < levels; level++) node = { allOf: [node] };
  return node;
}

describe('builder: walks stay linear and refuse nesting past the limit (review finding 5)', () => {
  it('builds a doubled allOf chain of 22 levels in linear time', () => {
    const started = performance.now();
    const out = buildGovernanceTables({
      branches: [branch(doubledChain(22), [{ key: 'GET /chain', op: jsonResponse(ref('C0')) }])],
      overrides: {},
      customs: NO_CUSTOMS,
    });
    expect(performance.now() - started).toBeLessThan(3000);
    expect(out.fields.C0).toEqual({ id: { class: 'metadata' } });
  });

  it('builds an array nested 22 levels in linear time, walking each item type once', () => {
    const components: Record<string, SchemaNode> = { L0: { type: 'object', properties: { id: { type: 'string' } } } };
    for (let level = 1; level <= 22; level++) components[`L${level}`] = { type: 'array', items: ref(`L${level - 1}`) };
    const started = performance.now();
    const out = buildGovernanceTables({ branches: [branch(components, [])], overrides: {}, customs: NO_CUSTOMS });
    expect(performance.now() - started).toBeLessThan(3000);
    expect(out.fields.L22).toEqual({ id: { class: 'metadata' } });
  });

  it('keeps the fields of a cycle: each member reaches every field of the others, and the walk ends', () => {
    const out = buildGovernanceTables({
      branches: [
        branch(
          {
            A: { allOf: [ref('B')], properties: { a: { type: 'string' } } },
            B: { allOf: [ref('A')], properties: { b: { type: 'string' } } },
            R: { allOf: [ref('A')] },
          },
          [],
        ),
      ],
      overrides: {},
      customs: NO_CUSTOMS,
    });
    expect(Object.keys(out.fields.A).sort()).toEqual(['a', 'b']);
    expect(Object.keys(out.fields.B).sort()).toEqual(['a', 'b']);
    expect(Object.keys(out.fields.R).sort()).toEqual(['a', 'b']);
  });

  it('keeps each branch apart: a name two branches define merges their fields, and no table leaks between them', () => {
    const out = buildGovernanceTables({
      branches: [
        branch({ Shared: { properties: { one: { type: 'string' } } }, Holder: { allOf: [ref('Shared')] } }, []),
        branch({ Shared: { properties: { two: { type: 'string' } } }, Holder: { allOf: [ref('Shared')] } }, []),
      ],
      overrides: {},
      customs: NO_CUSTOMS,
    });
    expect(Object.keys(out.fields.Shared).sort()).toEqual(['one', 'two']);
    expect(Object.keys(out.fields.Holder).sort()).toEqual(['one', 'two']);
  });

  it('refuses an allOf nested past the limit with a clear error, not a stack overflow', () => {
    const input = { branches: [branch({ Deep: nestedAllOf(300) }, [])], overrides: {}, customs: NO_CUSTOMS };
    expect(() => buildGovernanceTables(input)).toThrow(/nests deeper than 256 levels/);
  });

  it('refuses a response nested past the limit, in the walks that read its fields', () => {
    const input = { branches: [branch({}, [{ key: 'GET /deep', op: jsonResponse(nestedObject(300)) }])], overrides: {}, customs: NO_CUSTOMS };
    expect(() => buildGovernanceTables(input)).toThrow(/nests deeper than 256 levels/);
  });

  it('still reads a response nested 200 levels deep, and the spec walks read the same depth', () => {
    const out = buildGovernanceTables({
      branches: [branch({}, [{ key: 'GET /deep', op: jsonResponse(nestedObject(200)) }])],
      overrides: {},
      customs: NO_CUSTOMS,
    });
    expect(out.outputs['GET /deep']).toBe('InlineResponse');
    expect(inlineNames(nestedObject(200))).toEqual(new Set(['next']));
    expect(() => forEachProperty(nestedObject(300), {}, () => undefined)).toThrow(/nests deeper than 256 levels/);
    expect(() => inlineNames(nestedObject(300))).toThrow(/nests deeper than 256 levels/);
  });
});
