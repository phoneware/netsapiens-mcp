import { canonicalJson } from '../cutover/dsse-verifier-core.mjs';
import { CutoverRefusedError } from './errors.js';

// Firestore field-path escaping is not implemented here. Any segment outside
// this plain-identifier grammar is refused rather than interpreted.
const SIMPLE_SEGMENT = /^[_A-Za-z][_A-Za-z0-9]*$/;

// Settled Firestore document limits, with the 80% operating ceiling.
export const INDEX_ENTRY_BUDGET = Math.floor(40_000 * 0.8);
export const INDEX_BYTE_BUDGET = Math.floor(8 * 1024 * 1024 * 0.8);
export const DOCUMENT_BYTE_BUDGET = Math.floor(1024 * 1024 * 0.8);
export const DOCUMENT_DEPTH_BUDGET = Math.floor(20 * 0.8);

export interface SignedIndexRoot {
  readonly source: string;
  readonly indexes: readonly unknown[];
}

export interface SignedCollectionPolicy {
  readonly collectionGroup: string;
  readonly overrides: ReadonlyArray<{ readonly fieldPath: string; readonly indexes: readonly unknown[] }>;
  readonly composites: ReadonlyArray<{ readonly fields: ReadonlyArray<{ readonly fieldPath: string }> }>;
  readonly ttl: ReadonlyArray<unknown>;
}

export interface SignedIndexPolicy {
  readonly default: SignedIndexRoot;
  readonly collections: readonly SignedCollectionPolicy[];
}

export interface FreshEffectiveField {
  readonly fieldPath: string;
  readonly indexes: readonly unknown[];
  readonly source: string;
  readonly chain: readonly string[];
}

export interface FreshCollectionCoverage {
  readonly collectionGroup: string;
  readonly effectiveFields: readonly FreshEffectiveField[];
}

export interface ConcretePaths {
  // Concrete field path -> number of index entries each root mode can produce
  // for that path in one document (array elements multiply).
  readonly multiplicity: ReadonlyMap<string, number>;
  readonly maxDepth: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function isLeaf(value: unknown): boolean {
  return value === null ||
    typeof value === 'string' ||
    typeof value === 'number' && Number.isFinite(value) ||
    typeof value === 'boolean' ||
    value instanceof Date ||
    value instanceof Uint8Array;
}

// Derives every concrete field path a document write produces. Unsupported
// values, segment names, or nesting refuse; nothing is guessed.
export function concreteFieldPaths(document: unknown): ConcretePaths {
  if (!isPlainObject(document)) throw new CutoverRefusedError('Concrete coverage requires a plain document object');
  const multiplicity = new Map<string, number>();
  let maxDepth = 0;
  const visit = (value: unknown, path: string, mult: number, depth: number): void => {
    if (value === undefined) return;
    if (path !== '') {
      multiplicity.set(path, Math.max(multiplicity.get(path) ?? 0, mult));
      maxDepth = Math.max(maxDepth, depth);
    }
    if (Array.isArray(value)) {
      const childMult = mult * Math.max(1, value.length);
      for (const element of value) visit(element, path, childMult, depth);
      return;
    }
    if (isPlainObject(value)) {
      for (const key of Object.keys(value)) {
        if (value[key] === undefined) continue;
        if (!SIMPLE_SEGMENT.test(key)) throw new CutoverRefusedError('Unsupported Firestore field path segment');
        visit(value[key], path === '' ? key : `${path}.${key}`, mult, depth + 1);
      }
      return;
    }
    if (isLeaf(value)) return;
    throw new CutoverRefusedError('Unsupported Firestore value type in document');
  };
  visit(document, '', 1, 0);
  return { multiplicity, maxDepth };
}

// Size estimate only, not a canonical encoding. Dates and bytes serialize as Firestore stores them.
function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value, (_key, item: unknown) => (item instanceof Uint8Array ? Buffer.from(item).toString('base64') : item)), 'utf8');
}

function canonicalIndexList(indexes: readonly unknown[]): string {
  return canonicalJson(indexes.map((index) => canonicalJson(index)).sort());
}

function resourceName(databaseResource: string, collectionGroup: string, fieldPath: string): string {
  return `${databaseResource}/collectionGroups/${collectionGroup}/fields/${fieldPath}`;
}

function collectionPolicy(policy: SignedIndexPolicy, collectionGroup: string): SignedCollectionPolicy {
  const found = policy.collections.filter((entry) => entry.collectionGroup === collectionGroup);
  if (found.length !== 1) throw new CutoverRefusedError('Signed index policy does not cover the collection group exactly once');
  return found[0];
}

// The root a concrete field inherits is its own explicit override if one is
// signed, otherwise the signed database default. No prefix or parent guessing.
export function signedRootFor(policy: SignedIndexPolicy, collectionGroup: string, fieldPath: string, databaseResource: string): SignedIndexRoot {
  const override = collectionPolicy(policy, collectionGroup).overrides.find((entry) => entry.fieldPath === fieldPath);
  if (override) {
    return { source: resourceName(databaseResource, collectionGroup, fieldPath), indexes: override.indexes };
  }
  return policy.default;
}

// Every concrete field must have a fresh authenticated effective record whose
// inheritance chain is exactly the signed root, with identical index modes.
export function assertConcreteCoverage(input: {
  readonly policy: SignedIndexPolicy;
  readonly databaseResource: string;
  readonly collectionGroup: string;
  readonly paths: ReadonlyMap<string, number>;
  readonly fresh: FreshCollectionCoverage;
}): void {
  const { policy, databaseResource, collectionGroup, paths, fresh } = input;
  if (fresh.collectionGroup !== collectionGroup) throw new CutoverRefusedError('Fresh coverage is for a different collection group');
  const effective = new Map<string, FreshEffectiveField>();
  for (const entry of fresh.effectiveFields) {
    if (effective.has(entry.fieldPath)) throw new CutoverRefusedError('Duplicate fresh effective field observation');
    effective.set(entry.fieldPath, entry);
  }
  const defaultRoot = policy.default;
  for (const fieldPath of paths.keys()) {
    const root = signedRootFor(policy, collectionGroup, fieldPath, databaseResource);
    const explicit = root !== defaultRoot;
    const resource = resourceName(databaseResource, collectionGroup, fieldPath);
    const entry = effective.get(fieldPath);
    if (!entry) throw new CutoverRefusedError('Concrete field is not covered by fresh authenticated observation');
    const expectedChain = explicit ? [resource] : [resource, defaultRoot.source];
    if (entry.source !== root.source ||
      entry.chain.length !== expectedChain.length ||
      entry.chain.some((name, index) => name !== expectedChain[index])) {
      throw new CutoverRefusedError('Concrete field inheritance does not resolve to its signed root');
    }
    if (canonicalIndexList(entry.indexes) !== canonicalIndexList(root.indexes)) {
      throw new CutoverRefusedError('Concrete field index modes differ from the signed policy');
    }
  }
}

// Conservative per-document index cost: every concrete path contributes each
// signed mode of its root once per array element; every composite contributes
// one entry per document. Bytes assume each entry carries the whole document.
export function estimateDocumentIndexCost(input: {
  readonly policy: SignedIndexPolicy;
  readonly databaseResource: string;
  readonly collectionGroup: string;
  readonly paths: ReadonlyMap<string, number>;
  readonly documentBytes: number;
}): { readonly entries: number; readonly bytes: number } {
  const { policy, databaseResource, collectionGroup, paths, documentBytes } = input;
  let entries = 0;
  let bytes = 0;
  for (const [fieldPath, mult] of paths) {
    const root = signedRootFor(policy, collectionGroup, fieldPath, databaseResource);
    const modes = root.indexes.length * mult;
    entries += modes;
    bytes += modes * (Buffer.byteLength(fieldPath, 'utf8') + 8 + documentBytes);
  }
  const composites = collectionPolicy(policy, collectionGroup).composites;
  for (const composite of composites) {
    const pathBytes = composite.fields.reduce((sum, field) => sum + Buffer.byteLength(field.fieldPath, 'utf8'), 0);
    entries += 1;
    bytes += pathBytes + 8 + documentBytes;
  }
  return { entries, bytes };
}

// Refuses a document before any buffered write when any settled budget is exceeded.
export function assertDocumentBudget(input: {
  readonly document: unknown;
  readonly policy: SignedIndexPolicy;
  readonly databaseResource: string;
  readonly collectionGroup: string;
}): void {
  const { document, policy, databaseResource, collectionGroup } = input;
  const documentBytes = serializedBytes(document);
  if (documentBytes > DOCUMENT_BYTE_BUDGET) throw new CutoverRefusedError('Prospective document exceeds the byte budget');
  const { multiplicity, maxDepth } = concreteFieldPaths(document);
  if (maxDepth > DOCUMENT_DEPTH_BUDGET) throw new CutoverRefusedError('Prospective document exceeds the depth budget');
  const cost = estimateDocumentIndexCost({ policy, databaseResource, collectionGroup, paths: multiplicity, documentBytes });
  if (cost.entries > INDEX_ENTRY_BUDGET || cost.bytes > INDEX_BYTE_BUDGET) {
    throw new CutoverRefusedError('Prospective document exceeds the index budget');
  }
}
