import { describe, expect, it } from 'vitest';
import { buildGovernanceTables, type BuildBranch } from '../governance/build.js';
import type { Components, SpecOperation } from '../governance/spec-walk.js';
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
    expect(out.outputs['GET /items']).toBe('ItemList');
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
