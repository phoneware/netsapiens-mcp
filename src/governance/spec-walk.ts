/**
 * Reads the OpenAPI shapes that the governance generator and the content gates share (spec 3.6). Pure: the caller
 * parses the documents. A reference is followed through arrays, maps (additionalProperties), allOf, oneOf and anyOf,
 * so a list component declares the fields of its item component, a map of records declares the fields of its values,
 * and a merged component declares the fields of every part.
 */

/** A schema as the document states it. Only the keys this walk reads are typed. */
export interface SchemaNode {
  readonly $ref?: string;
  readonly type?: string;
  readonly enum?: readonly unknown[];
  readonly properties?: Readonly<Record<string, SchemaNode>>;
  readonly items?: SchemaNode;
  readonly additionalProperties?: SchemaNode | boolean;
  readonly allOf?: readonly SchemaNode[];
  readonly oneOf?: readonly SchemaNode[];
  readonly anyOf?: readonly SchemaNode[];
}

/** The component schemas of one spec branch, by name. */
export type Components = Readonly<Record<string, SchemaNode>>;

/** One media type of a request or response: its schema, when it has one. */
export interface MediaObject {
  readonly schema?: SchemaNode;
}

/** One operation of a path item, as far as this walk reads it. */
export interface SpecOperation {
  readonly responses?: Readonly<Record<string, { readonly content?: Readonly<Record<string, MediaObject>> }>>;
  readonly requestBody?: { readonly content?: Readonly<Record<string, MediaObject>> };
  readonly parameters?: readonly { readonly name?: string; readonly schema?: SchemaNode }[];
}

/** One OpenAPI document of a spec branch. */
export interface SpecDocument {
  readonly paths?: Readonly<Record<string, Readonly<Record<string, SpecOperation>>>>;
  readonly components?: { readonly schemas?: Components };
}

/** What a response schema is built from: the components it names, and whether it has fields no component names. */
export interface ResponseShape {
  readonly components: Set<string>;
  readonly inline: boolean;
}

/** What an operation's request and responses carry, at any depth, merged across the branches that define it. */
export interface OperationFacts {
  /** Every property name a 2xx JSON response reaches, through references too. */
  readonly responseNames: Set<string>;
  /** Non-JSON media types a 2xx response declares. */
  readonly responseMedia: Set<string>;
  /** Every property and parameter name a request reaches. */
  readonly requestNames: Set<string>;
  /** Every string enum value a request property or parameter declares. */
  readonly requestEnumValues: Set<string>;
}

const PRIMITIVE_TYPES: ReadonlySet<string> = new Set(['string', 'number', 'integer', 'boolean']);
const HTTP_METHODS: ReadonlySet<string> = new Set(['get', 'post', 'put', 'patch', 'delete']);
const JSON_MEDIA = 'application/json';

/** The component a $ref names. */
export function componentOf(ref: string): string {
  return ref.split('/').pop() ?? ref;
}

/**
 * The schemas a schema is built from, in order: its item type, the value type of a map, and every part of allOf,
 * oneOf and anyOf. Traversals that follow what a schema contains read through this list.
 */
export function partsOf(node: SchemaNode): readonly SchemaNode[] {
  const parts: SchemaNode[] = [];
  if (node.items !== undefined) parts.push(node.items);
  if (typeof node.additionalProperties === 'object') parts.push(node.additionalProperties);
  parts.push(...(node.allOf ?? []), ...(node.oneOf ?? []), ...(node.anyOf ?? []));
  return parts;
}

/**
 * Visits every property a schema declares at any depth, following references and combinators. A component is
 * entered once per walk, so a cycle ends.
 */
export function forEachProperty(
  node: SchemaNode | undefined,
  components: Components,
  visit: (name: string, schema: SchemaNode) => void,
  seen: Set<string> = new Set(),
): void {
  if (node === undefined) return;
  if (node.$ref !== undefined) {
    const name = componentOf(node.$ref);
    if (seen.has(name)) return;
    seen.add(name);
    forEachProperty(components[name], components, visit, seen);
    return;
  }
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    visit(key, child);
    forEachProperty(child, components, visit, seen);
  }
  for (const part of partsOf(node)) forEachProperty(part, components, visit, seen);
}

/** Every component a schema reaches, directly or through other components, at any depth. */
export function reachedComponents(
  node: SchemaNode | undefined,
  components: Components,
  found: Set<string> = new Set(),
): Set<string> {
  if (node === undefined) return found;
  if (node.$ref !== undefined) {
    const name = componentOf(node.$ref);
    if (found.has(name)) return found;
    found.add(name);
    reachedComponents(components[name], components, found);
    return found;
  }
  for (const child of Object.values(node.properties ?? {})) reachedComponents(child, components, found);
  for (const part of partsOf(node)) reachedComponents(part, components, found);
  return found;
}

/**
 * The property names a schema declares outside every component it reaches: the fields an inline object carries.
 * A reference is not entered, because the component it names classifies its own fields.
 */
export function inlineNames(node: SchemaNode | undefined, names: Set<string> = new Set()): Set<string> {
  if (node === undefined || node.$ref !== undefined) return names;
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    names.add(key);
    inlineNames(child, names);
  }
  for (const part of partsOf(node)) inlineNames(part, names);
  return names;
}

/**
 * The components a response schema names directly, and whether it has an inline object. A primitive value has no
 * fields. Anything else that is not a reference (an object with properties, a free-form object, an array of
 * either) is inline. An absent schema has neither.
 */
export function responseShape(node: SchemaNode | undefined): ResponseShape {
  const components = new Set<string>();
  let inline = false;
  const visit = (current: SchemaNode | undefined, depth: number): void => {
    if (current === undefined || depth > 32) return;
    if (current.$ref !== undefined) {
      components.add(componentOf(current.$ref));
      return;
    }
    if (current.properties !== undefined) inline = true;
    const parts = partsOf(current);
    for (const part of parts) visit(part, depth + 1);
    const isPrimitive = current.type !== undefined && PRIMITIVE_TYPES.has(current.type);
    if (current.properties === undefined && parts.length === 0 && !isPrimitive) inline = true;
  };
  visit(node, 0);
  return { components, inline };
}

/** The enum values a property declares, on the property itself or on its array items. */
export function enumValuesOf(schema: SchemaNode): readonly unknown[] {
  return schema.enum ?? schema.items?.enum ?? [];
}

/** Calls visit with each operation of a document, with its lowercase method and its path template. */
export function forEachOperation(
  doc: SpecDocument,
  visit: (method: string, path: string, operation: SpecOperation) => void,
): void {
  for (const [path, methods] of Object.entries(doc.paths ?? {})) {
    for (const [method, operation] of Object.entries(methods)) {
      if (HTTP_METHODS.has(method)) visit(method, path, operation);
    }
  }
}

/**
 * The media of an operation's lowest 2xx response: whether any type other than JSON is declared, and the JSON schema.
 * Undefined when the operation has no 2xx response.
 */
export function successMedia(operation: SpecOperation): { readonly nonJson: boolean; readonly schema: SchemaNode | undefined } | undefined {
  const codes = Object.keys(operation.responses ?? {})
    .filter((code) => /^2\d\d$/.test(code))
    .sort();
  const first = codes[0];
  if (first === undefined) return undefined;
  const content = operation.responses?.[first]?.content ?? {};
  return {
    nonJson: Object.keys(content).some((type) => type !== JSON_MEDIA),
    schema: content[JSON_MEDIA]?.schema,
  };
}

/** What one operation's request and 2xx responses carry. */
export function operationFactsOf(operation: SpecOperation, components: Components): OperationFacts {
  const responseNames = new Set<string>();
  const responseMedia = new Set<string>();
  for (const [code, response] of Object.entries(operation.responses ?? {})) {
    if (!/^2\d\d$/.test(code)) continue;
    for (const type of Object.keys(response.content ?? {})) if (type !== JSON_MEDIA) responseMedia.add(type);
    forEachProperty(response.content?.[JSON_MEDIA]?.schema, components, (name) => responseNames.add(name));
  }
  const requestNames = new Set<string>();
  const requestEnumValues = new Set<string>();
  const readEnum = (schema: SchemaNode): void => {
    for (const value of enumValuesOf(schema)) if (typeof value === 'string') requestEnumValues.add(value);
  };
  const bodies: SchemaNode[] = [];
  for (const media of Object.values(operation.requestBody?.content ?? {})) if (media.schema) bodies.push(media.schema);
  for (const body of bodies) {
    readEnum(body);
    forEachProperty(body, components, (name, schema) => {
      requestNames.add(name);
      readEnum(schema);
    });
  }
  for (const parameter of operation.parameters ?? []) {
    if (parameter.name !== undefined) requestNames.add(parameter.name);
    if (parameter.schema) readEnum(parameter.schema);
  }
  return { responseNames, responseMedia, requestNames, requestEnumValues };
}

/** The union of two operations' facts, for an operation that more than one branch defines. */
export function mergeFacts(a: OperationFacts | undefined, b: OperationFacts): OperationFacts {
  if (a === undefined) return b;
  const union = (x: Set<string>, y: Set<string>): Set<string> => new Set([...x, ...y]);
  return {
    responseNames: union(a.responseNames, b.responseNames),
    responseMedia: union(a.responseMedia, b.responseMedia),
    requestNames: union(a.requestNames, b.requestNames),
    requestEnumValues: union(a.requestEnumValues, b.requestEnumValues),
  };
}
