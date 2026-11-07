export type DocumentDataLike = Record<string, unknown>;

export type WhereFilterOpLike =
  | '<' | '<=' | '==' | '!=' | '>=' | '>'
  | 'array-contains' | 'in' | 'not-in' | 'array-contains-any';

export interface DocumentSnapshotLike {
  readonly id: string;
  readonly exists: boolean;
  data(): DocumentDataLike | undefined;
}
export interface QueryDocumentSnapshotLike extends DocumentSnapshotLike {
  data(): DocumentDataLike;
}
export interface QuerySnapshotLike {
  readonly empty: boolean;
  readonly size: number;
  readonly docs: QueryDocumentSnapshotLike[];
}
export interface DocumentReferenceLike {
  readonly id: string;
  get(): Promise<DocumentSnapshotLike>;
  set(data: DocumentDataLike, options?: { merge?: boolean }): Promise<unknown>;
  delete(): Promise<unknown>;
  collection(path: string): CollectionLike;
}
export interface QueryLike {
  get(): Promise<QuerySnapshotLike>;
  limit(count: number): QueryLike;
  orderBy(field: unknown, direction?: 'asc' | 'desc'): QueryLike;
  where(field: string, op: WhereFilterOpLike, value: unknown): QueryLike;
  startAt(...values: unknown[]): QueryLike;
  endBefore(...values: unknown[]): QueryLike;
}
export interface CollectionLike extends QueryLike {
  doc(id: string): DocumentReferenceLike;
}
export interface TransactionLike {
  get(ref: DocumentReferenceLike): Promise<DocumentSnapshotLike>;
  get(query: QueryLike): Promise<QuerySnapshotLike>;
  set(ref: DocumentReferenceLike, data: DocumentDataLike, options?: { merge?: boolean }): unknown;
  delete(ref: DocumentReferenceLike): unknown;
}
export interface FirestoreLike {
  collection(path: string): CollectionLike;
  runTransaction<T>(callback: (transaction: TransactionLike) => Promise<T>, options?: { readOnly?: boolean }): Promise<T>;
}
export interface FieldPathAdapter {
  documentId(): unknown;
}
