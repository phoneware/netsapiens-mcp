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
  /** Every property name a 2xx JSON response reaches, through references too, except the fields of an envelope component. */
  readonly responseNames: Set<string>;
  /** Non-JSON media types a 2xx response declares. */
  readonly responseMedia: Set<string>;
  /** Whether the method can set a destination: POST, PUT or PATCH. A DELETE removes and sets nothing. */
  readonly writes: boolean;
  /** Every property name a request body reaches, at any depth. */
  readonly bodyNames: Set<string>;
  /** Every body property and parameter name a request reaches. */
  readonly requestNames: Set<string>;
  /** Every string enum value a request property or parameter declares. */
  readonly requestEnumValues: Set<string>;
}

const PRIMITIVE_TYPES: ReadonlySet<string> = new Set(['string', 'number', 'integer', 'boolean']);
const HTTP_METHODS: ReadonlySet<string> = new Set(['get', 'post', 'put', 'patch', 'delete']);
const JSON_MEDIA = 'application/json';

/**
 * Components whose fields are the API's status envelope, not record content. A response that names one contributes
 * none of its fields to the response gate. Each entry gives the reason, as every review in the gates does.
 */
export const ENVELOPE_COMPONENTS: Readonly<Record<string, string>> = {
  SuccessResponse: 'the status envelope of a write: success and a status message, never record content',
  ErrorResponse: 'the error envelope of a failed request: an error code and a message, never record content',
  Error: 'the error envelope of a failed request: a code and a message, never record content',
  FaxError: 'the error envelope of a failed fax request: a code and a message, never fax content',
  EmailTestResponse: 'the result of an e-mail test: a status and a message, not message content',
  EmailValidateResult: 'the result of an e-mail address check: a status and a message, not message content',
  LicfErrorResponse: 'the error envelope of a licence request: a code and a message',
  LicfSuccessResponse: 'the status envelope of a licence request: success and a message',
  MasqueradeErrorResponse: 'the error envelope of a support session request: a code and a message',
  MasqueradeStartResponse: 'the status envelope of a support session start: success and a message',
  MasqueradeV2EndResponse: 'the status envelope of a support session end: success and a message',
  MfaVerifyResponse: 'the status envelope of an MFA check: success and a message',
  NdpErrorResponse: 'the error envelope of a device provisioning request: a code and a message',
  NdpSuccessResponse: 'the status envelope of a device provisioning request: success and a message',
  NmsErrorResponse: 'the error envelope of a network management request: a code and a message',
  NmsSuccessResponse: 'the status envelope of a network management request: success and a message',
  RecordingentrySyncAccepted: 'the status of a recording entry sync that was accepted: a state and a message, never recording content',
  RecordingentrySyncFailure: 'the status of a recording entry sync that failed: a reason and a message, never recording content',
  RecordingentrySyncJob: 'the status of a recording entry sync job: a state and counts, never recording content',
  RecordingentrySyncResult: 'the result of a recording entry sync: counts and a message, never recording content',
  ServiceActionDeferred: 'the status of a deferred service action: a state and a message',
  ServiceNotInstalledError: 'the error of a service that is not installed: a code and a message',
  ServiceTimeoutError: 'the error of a service that timed out: a code and a message',
  SpeechWordBulkResult: 'the result of a speech-word bulk action: counts and a message, not call content',
  SpeechWordRenderResult: 'the result of a speech-word render: a status and a message, not call content',
  TranslationDeleteResponse: 'the status envelope of a translation delete: success and a message',
};

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
 * entered once per walk, so a cycle ends. A component named in skip contributes no properties.
 */
export function forEachProperty(
  node: SchemaNode | undefined,
  components: Components,
  visit: (name: string, schema: SchemaNode) => void,
  seen: Set<string> = new Set(),
  skip: ReadonlySet<string> = new Set(),
): void {
  if (node === undefined) return;
  if (node.$ref !== undefined) {
    const name = componentOf(node.$ref);
    if (seen.has(name) || skip.has(name)) return;
    seen.add(name);
    forEachProperty(components[name], components, visit, seen, skip);
    return;
  }
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    visit(key, child);
    forEachProperty(child, components, visit, seen, skip);
  }
  for (const part of partsOf(node)) forEachProperty(part, components, visit, seen, skip);
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
export function operationFactsOf(method: string, operation: SpecOperation, components: Components): OperationFacts {
  const skip: ReadonlySet<string> = new Set(Object.keys(ENVELOPE_COMPONENTS));
  const responseNames = new Set<string>();
  const responseMedia = new Set<string>();
  for (const [code, response] of Object.entries(operation.responses ?? {})) {
    if (!/^2\d\d$/.test(code)) continue;
    for (const type of Object.keys(response.content ?? {})) if (type !== JSON_MEDIA) responseMedia.add(type);
    forEachProperty(response.content?.[JSON_MEDIA]?.schema, components, (name) => responseNames.add(name), new Set(), skip);
  }
  const bodyNames = new Set<string>();
  const requestNames = new Set<string>();
  const requestEnumValues = new Set<string>();
  const readEnum = (schema: SchemaNode): void => {
    for (const value of enumValuesOf(schema)) if (typeof value === 'string') requestEnumValues.add(value);
  };
  for (const media of Object.values(operation.requestBody?.content ?? {})) {
    if (media.schema === undefined) continue;
    readEnum(media.schema);
    forEachProperty(media.schema, components, (name, schema) => {
      bodyNames.add(name);
      requestNames.add(name);
      readEnum(schema);
    });
  }
  for (const parameter of operation.parameters ?? []) {
    if (parameter.name !== undefined) requestNames.add(parameter.name);
    if (parameter.schema) readEnum(parameter.schema);
  }
  return { responseNames, responseMedia, writes: ['post', 'put', 'patch'].includes(method.toLowerCase()), bodyNames, requestNames, requestEnumValues };
}

/** The union of two operations' facts, for an operation that more than one branch defines. */
export function mergeFacts(a: OperationFacts | undefined, b: OperationFacts): OperationFacts {
  if (a === undefined) return b;
  const union = (x: Set<string>, y: Set<string>): Set<string> => new Set([...x, ...y]);
  return {
    responseNames: union(a.responseNames, b.responseNames),
    responseMedia: union(a.responseMedia, b.responseMedia),
    writes: a.writes || b.writes,
    bodyNames: union(a.bodyNames, b.bodyNames),
    requestNames: union(a.requestNames, b.requestNames),
    requestEnumValues: union(a.requestEnumValues, b.requestEnumValues),
  };
}
