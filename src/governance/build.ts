/**
 * Builds the governance field tables and the map from each operation to the table that classifies its response
 * (spec 3.6). Pure: the caller reads the documents and writes the output. Every spec branch contributes. A field is
 * declared when any branch declares it, and an operation maps to the union of what every branch returns for it.
 */
import { CONTENT_KIND_ORDER } from './content-operations.js';
import { componentOf, inlineNames, partsOf, reachedComponents, responseShape, successMedia, type Components, type SchemaNode, type SpecOperation } from './spec-walk.js';
import type { ContentKind, FieldClass } from './types.js';

/** The resource an operation maps to when its response has fields no component names. */
export const INLINE_RESPONSE = 'InlineResponse';

export interface BuildBranch {
  readonly components: Components;
  /** Every operation of the branch, with its normalized key. */
  readonly operations: readonly { readonly key: string; readonly operation: SpecOperation }[];
}

export interface BuildInput {
  readonly branches: readonly BuildBranch[];
  /** Hand-reviewed classes, by component name and field name. They replace what the spec implies. */
  readonly overrides: Readonly<Record<string, Readonly<Record<string, FieldClass>>>>;
  /** Resources the spec does not declare, with their own field classes. */
  readonly customs: Readonly<Record<string, Readonly<Record<string, FieldClass>>>>;
  /** Mapped resources whose schema really declares no fields, each with the reason. Any other empty one is an error. */
  readonly emptyByDesign?: Readonly<Record<string, string>>;
}

export interface BuildOutput {
  readonly fields: Readonly<Record<string, Readonly<Record<string, FieldClass>>>>;
  readonly outputs: Readonly<Record<string, string>>;
}

type Table = Record<string, FieldClass>;
type ContentClass = Extract<FieldClass, { class: 'content' }>;

/** How much a projection removes for each field class: a higher rank removes more. */
const CLASS_RANK: Record<FieldClass['class'], number> = { secret: 5, internal: 4, content: 3, record_id: 2, metadata: 1 };

const CREDENTIAL_EXCEPTIONS = /key-id|can-create-keys|no-key-press|unassigned-key-press|language-token|token-endpoint|token_type|dtmf-mapping|-enabled/i;
const CREDENTIAL_NAME = /(?:^|[-_])(?:password|pin|secret|token|passcode)(?:$|[-_])/i;

/** Whether a field name is a credential by its shape. */
export function isCredentialKeyName(name: string): boolean {
  return !CREDENTIAL_EXCEPTIONS.test(name) && CREDENTIAL_NAME.test(name);
}

/** The class a field takes when no review names one: a secret when its name says so, else metadata. */
function defaultClass(name: string): FieldClass {
  return isCredentialKeyName(name) ? { class: 'secret' } : { class: 'metadata' };
}

/** Content classes in the order decisions report them, with the first kind primary and the rest in alsoKinds. */
function contentClass(kinds: readonly ContentKind[], media: ContentClass['media']): FieldClass {
  const ordered = CONTENT_KIND_ORDER.filter((kind) => kinds.includes(kind));
  const [kind, ...also] = ordered;
  return also.length > 0 ? { class: 'content', kind, media, alsoKinds: also } : { class: 'content', kind, media };
}

function kindsOfClass(cls: ContentClass): ContentKind[] {
  return [cls.kind, ...(cls.alsoKinds ?? [])];
}

/**
 * The class one field takes from two declarations: the stronger class, or the union of two content kinds, which is
 * one field that carries both. Content beside internal, and record IDs of two types, have no order, so the build
 * fails and the overrides reconcile them.
 */
export function mergeFieldClass(composite: string, field: string, a: FieldClass, b: FieldClass): FieldClass {
  if (JSON.stringify(a) === JSON.stringify(b)) return a;
  if (a.class === 'content' && b.class === 'content') return contentClass([...kindsOfClass(a), ...kindsOfClass(b)], a.media);
  const unordered =
    (a.class === 'content' && b.class === 'internal') ||
    (a.class === 'internal' && b.class === 'content') ||
    (a.class === 'record_id' && b.class === 'record_id' && a.recordType !== b.recordType);
  if (unordered) {
    throw new Error(`${composite}: ${field} is ${JSON.stringify(a)} in one member and ${JSON.stringify(b)} in another; reconcile them in overrides.ts`);
  }
  return CLASS_RANK[b.class] > CLASS_RANK[a.class] ? b : a;
}

function mergeInto(target: Table, source: Table, label: string): void {
  for (const [field, incoming] of Object.entries(source)) {
    const current = target[field];
    target[field] = current === undefined ? incoming : mergeFieldClass(label, field, current, incoming);
  }
}

/**
 * The classes a schema declares: its own properties at their default class, and every component it reaches through
 * a reference, an item type or a combinator, with that component's classes as the component declares them.
 */
function classesOf(
  node: SchemaNode | undefined,
  components: Components,
  stack: ReadonlySet<string>,
  overrides: BuildInput['overrides'],
  label: string,
): Table {
  const table: Table = {};
  if (node === undefined) return table;
  if (node.$ref !== undefined) {
    const name = componentOf(node.$ref);
    if (stack.has(name)) return table;
    return componentTable(name, components, new Set([...stack, name]), overrides);
  }
  if (node.items !== undefined) mergeInto(table, classesOf(node.items, components, stack, overrides, label), label);
  for (const part of partsOf(node)) mergeInto(table, classesOf(part, components, stack, overrides, label), label);
  for (const field of Object.keys(node.properties ?? {})) mergeInto(table, { [field]: defaultClass(field) }, label);
  return table;
}

/** The table one component declares in one branch: what its schema reaches, then its reviewed overrides. */
function componentTable(name: string, components: Components, stack: ReadonlySet<string>, overrides: BuildInput['overrides']): Table {
  const table = classesOf(components[name], components, stack, overrides, name);
  for (const [field, cls] of Object.entries(overrides[name] ?? {})) table[field] = cls;
  return table;
}

interface Mapping {
  media: boolean;
  readonly components: Set<string>;
  inline: boolean;
  readonly inlineNames: Set<string>;
}

function sorted<T>(record: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
}

/** Builds the tables and the operation map. Throws when a mapping cannot be classified as written. */
export function buildGovernanceTables(input: BuildInput): BuildOutput {
  const { branches, overrides, customs, emptyByDesign = {} } = input;
  const fields: Record<string, Table> = {};

  // 1. Every component's table, merged over the branches that declare it.
  const names = [...new Set(branches.flatMap((branch) => Object.keys(branch.components)))].sort();
  for (const name of names) {
    const table: Table = {};
    for (const branch of branches) {
      if (!Object.hasOwn(branch.components, name)) continue;
      mergeInto(table, componentTable(name, branch.components, new Set([name]), overrides), name);
    }
    fields[name] = table;
  }

  // 2. Resources the spec does not declare.
  for (const [name, table] of Object.entries(customs)) fields[name] = { ...table };
  for (const resource of Object.keys(overrides)) {
    if (!Object.hasOwn(fields, resource)) throw new Error(`Override resource "${resource}" does not exist in generated schemas`);
  }

  // 3. Each operation's mapping, unioned over every branch that defines it. Media that is not JSON leaves it unmapped.
  const mapping = new Map<string, Mapping>();
  for (const branch of branches) {
    for (const { key, operation } of branch.operations) {
      const entry = mapping.get(key) ?? { media: false, components: new Set<string>(), inline: false, inlineNames: new Set<string>() };
      mapping.set(key, entry);
      const success = successMedia(operation);
      if (success === undefined) continue;
      if (success.nonJson) {
        entry.media = true;
        continue;
      }
      for (const found of reachedComponents(success.schema, branch.components)) entry.components.add(found);
      if (responseShape(success.schema).inline) entry.inline = true;
      for (const found of inlineNames(success.schema)) entry.inlineNames.add(found);
    }
  }

  const outputs: Record<string, string> = {};
  const inlineFields = new Set<string>();
  let anyInline = false;
  for (const key of [...mapping.keys()].sort()) {
    const entry = mapping.get(key);
    if (entry === undefined || entry.media) continue;
    const members = [...entry.components, ...(entry.inline ? [INLINE_RESPONSE] : [])].sort();
    if (entry.inline) {
      anyInline = true;
      for (const found of entry.inlineNames) inlineFields.add(found);
    }
    if (members.length === 0) continue;
    outputs[key] = members.length === 1 ? members[0] : `Union(${members.join(',')})`;
  }

  // 4. The inline response table: each field an inline response names, at its default class.
  if (anyInline) fields[INLINE_RESPONSE] = Object.fromEntries([...inlineFields].sort().map((name) => [name, defaultClass(name)]));

  // 5. The composite tables, merged from their members.
  for (const resource of new Set(Object.values(outputs))) {
    if (!resource.startsWith('Union(')) continue;
    const table: Table = {};
    for (const member of resource.slice('Union('.length, -1).split(',')) {
      const memberTable = fields[member];
      if (memberTable === undefined) throw new Error(`${resource}: ${member} is not a generated resource`);
      mergeInto(table, memberTable, resource);
    }
    fields[resource] = table;
  }

  // 6. A mapped resource must exist, and must declare fields unless its schema is whitelisted as empty. Every failure
  // is reported together, so one regeneration shows them all.
  const problems: string[] = [];
  for (const resource of new Set(Object.values(outputs))) {
    const table = fields[resource];
    if (table === undefined) problems.push(`${resource} is mapped but is not a generated resource`);
    else if (Object.keys(table).length === 0 && !Object.hasOwn(emptyByDesign, resource)) {
      problems.push(`${resource}: empty field table for a mapped operation; list it in emptyByDesign with a reason`);
    }
  }
  if (problems.length > 0) throw new Error(problems.sort().join('\n'));

  return { fields: sorted(fields), outputs: sorted(outputs) };
}
