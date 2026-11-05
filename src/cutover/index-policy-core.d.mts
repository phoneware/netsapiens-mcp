// Type declarations for the byte-identical shared reader in index-policy-core.mjs.
// Compile-time only; not part of the cleared source handoff.

export interface ReadFirestoreAdminIndexesOptions {
  readonly project: string;
  readonly database: '(default)';
  readonly collectionGroups: readonly string[];
  readonly requiredFields: Readonly<Record<string, readonly string[]>>;
  readonly accessToken: string;
  readonly fetchFn?: typeof fetch;
}

export function readFirestoreAdminIndexes(options: ReadFirestoreAdminIndexesOptions): Promise<unknown>;

export function projectIndexObservation(input: {
  readonly databaseResource: string;
  readonly collectionGroups: readonly string[];
  readonly observation: unknown;
}): { readonly policy: unknown; readonly coverage: unknown };
