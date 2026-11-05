// The Firestore surface this store uses, declared without importing the SDK. Import-free by design: the
// protected assembly's type check reads this file, so it must never pull in the SDK, the store, or the auth
// modules. Type-only.

export interface DocumentSnapshotLike {
  readonly id: string;
  readonly exists: boolean;
  data(): Record<string, unknown> | undefined;
}
export interface QuerySnapshotLike {
  readonly empty: boolean;
  readonly docs: DocumentSnapshotLike[];
}
export interface DocumentReferenceLike {
  readonly id: string;
  get(): Promise<DocumentSnapshotLike>;
  set(data: Record<string, unknown>, options?: { merge?: boolean }): Promise<unknown>;
  delete(): Promise<unknown>;
  collection?(path: string): CollectionLike;
}
export interface QueryLike {
  get(): Promise<QuerySnapshotLike>;
  limit(count: number): QueryLike;
  orderBy(field: any, directionStr?: 'asc' | 'desc'): QueryLike;
  startAt(...fieldValues: any[]): QueryLike;
  endBefore(...fieldValues: any[]): QueryLike;
  where(field: string, op: any, value: any): QueryLike;
}
export interface CollectionLike extends QueryLike {
  doc(id: string): DocumentReferenceLike;
  where(field: string, op: any, value: any): QueryLike;
  orderBy(field: any, directionStr?: 'asc' | 'desc'): QueryLike;
  startAt(...fieldValues: any[]): QueryLike;
  endBefore(...fieldValues: any[]): QueryLike;
}
export interface TransactionLike {
  get(ref: DocumentReferenceLike | QueryLike): Promise<any>;
  set(ref: DocumentReferenceLike, data: Record<string, unknown>, options?: { merge?: boolean }): unknown;
  delete(ref: DocumentReferenceLike): unknown;
}
export interface FirestoreLike {
  collection(path: string): CollectionLike;
  // readOnly transactions take no write locks. Inspect, verify and status use them.
  runTransaction<T>(callback: (tx: TransactionLike) => Promise<T>, options?: { readOnly?: boolean }): Promise<T>;
}
