import { randomUUID } from 'node:crypto';
import type { FirestoreLike } from '../../store/firestore.js';

export const SUPPORTED_CUTOVER_NAMESPACES = ['mcp', 'pwmcp', 'readonly_mcp'] as const;
export type SupportedCutoverNamespace = (typeof SUPPORTED_CUTOVER_NAMESPACES)[number];

export function isSupportedCutoverNamespace(namespace: string): namespace is SupportedCutoverNamespace {
  return (SUPPORTED_CUTOVER_NAMESPACES as readonly string[]).includes(namespace);
}

export function assertSupportedCutoverNamespace(
  namespace: string,
): asserts namespace is SupportedCutoverNamespace {
  if (!isSupportedCutoverNamespace(namespace)) {
    throw new CutoverFenceError(
      `Unsupported cutover namespace: ${namespace}. Supported namespaces are: ${SUPPORTED_CUTOVER_NAMESPACES.join(', ')}`,
    );
  }
}

export type CutoverFenceState =
  | 'legacy_open'
  | 'closing'
  | 'fenced'
  | 'migrating'
  | 'v3_ready'
  | 'v3_active';

export const ALLOWED_STATE_TRANSITIONS: Readonly<Record<CutoverFenceState, readonly CutoverFenceState[]>> = {
  legacy_open: ['closing'],
  closing: ['fenced', 'legacy_open'],
  fenced: ['migrating', 'closing'],
  migrating: ['v3_ready'],
  v3_ready: ['v3_active'],
  v3_active: [],
};
export interface CutoverFenceControlRecord {
  schemaVersion: 1;
  namespace: string;
  epoch: number;
  state: CutoverFenceState;
  activeOperations: number;
  irreversible: boolean;
  emptyNamespace?: boolean;
  migrationRunId?: string;
  migrationManifestDigest?: string;
  createdAt?: number;
  updatedAt?: number;
  fencedAt?: number;
  migratedAt?: number;
}

export interface CutoverFenceConfig {
  namespace: string;
  enforce: boolean;
}

export type LegacyOperationPhase =
  | 'admitted'
  | 'upstream_pending'
  | 'completed'
  | 'failed';

export interface LegacyOperationRecord {
  schemaVersion: 1;
  id: string;
  namespace: string;
  epoch: number;
  kind: string;
  phase: LegacyOperationPhase;
  createdAt: number;
  updatedAt: number;
  leaseExpiresAt?: number;
  ambiguousRemoteOutcome?: boolean;
  familyId?: string;
  metadata?: Record<string, unknown>;
}

export interface LegacyOperationContext {
  readonly id: string;
  readonly namespace: string;
  readonly epoch: number;
  readonly kind: string;
  isAmbiguousRemoteOutcome(): boolean;
  markAmbiguousRemoteOutcome(reason?: string): void;
  clearAmbiguousRemoteOutcome(): void;
  isCompleted(): boolean;
  markCompleted(): void;
}

export interface LegacyOperationMetadata {
  [key: string]: unknown;
  revision?: string;
  attempt?: number;
  phase?: string;
  reconciled?: boolean;
}

export class CutoverFenceError extends Error {
  readonly kitCode = 'cutover_fence_error';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CutoverFenceError';
  }
}

export class CutoverRefusedError extends Error {
  readonly kitCode = 'cutover_refused';
  readonly retryAfterSeconds: number;
  readonly cutoverState?: string;
  readonly epoch?: number;

  constructor(
    message: string = 'Cutover in progress; operation temporarily unavailable',
    options?: { cause?: unknown; retryAfterSeconds?: number; cutoverState?: string; epoch?: number },
  ) {
    super(message, options);
    this.name = 'CutoverRefusedError';
    this.retryAfterSeconds = options?.retryAfterSeconds ?? 30;
    this.cutoverState = options?.cutoverState;
    this.epoch = options?.epoch;
  }
}

export function stripUndefined<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(stripUndefined) as unknown as T;
  if (typeof value === 'object' && !(value instanceof Date)) {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      if (v !== undefined) out[k] = stripUndefined(v);
    }
    return out as T;
  }
  return value;
}

export function getCutoverFenceDocRef(db: FirestoreLike, namespace: string): any {
  assertSupportedCutoverNamespace(namespace);
  return db.collection(`${namespace}_meta`).doc('cutover_fence');
}

export function getCutoverOperationsColRef(db: FirestoreLike, namespace: string): any {
  assertSupportedCutoverNamespace(namespace);
  const docRef = db.collection(`${namespace}_meta`).doc('cutover_fence');
  return typeof docRef.collection === 'function'
    ? docRef.collection('operations')
    : db.collection(`${namespace}_meta/cutover_fence/operations`);
}

export function getCutoverOperationDocRef(
  db: FirestoreLike,
  namespace: string,
  operationId: string,
): any {
  assertSupportedCutoverNamespace(namespace);
  return getCutoverOperationsColRef(db, namespace).doc(operationId);
}

export function parseCutoverFenceRecord(data: unknown, namespace: string): CutoverFenceControlRecord {
  assertSupportedCutoverNamespace(namespace);
  if (!data || typeof data !== 'object') {
    throw new CutoverFenceError(
      `Cutover fence control record for namespace ${namespace} is missing or not an object`,
    );
  }
  const record = data as Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    throw new CutoverFenceError(
      `Invalid cutover fence schemaVersion for namespace ${namespace}: expected 1, got ${String(record.schemaVersion)}`,
    );
  }
  if (record.namespace !== namespace) {
    throw new CutoverFenceError(
      `Namespace mismatch in cutover fence control record: expected ${namespace}, got ${String(record.namespace)}`,
    );
  }
  if (typeof record.epoch !== 'number' || !Number.isInteger(record.epoch) || record.epoch < 0) {
    throw new CutoverFenceError(
      `Invalid epoch in cutover fence record for namespace ${namespace}: ${String(record.epoch)}`,
    );
  }
  const validStates: readonly CutoverFenceState[] = [
    'legacy_open',
    'closing',
    'fenced',
    'migrating',
    'v3_ready',
    'v3_active',
  ];
  if (typeof record.state !== 'string' || !validStates.includes(record.state as CutoverFenceState)) {
    throw new CutoverFenceError(
      `Invalid cutover fence state for namespace ${namespace}: ${String(record.state)}`,
    );
  }
  if (
    typeof record.activeOperations !== 'number' ||
    !Number.isInteger(record.activeOperations) ||
    record.activeOperations < 0
  ) {
    throw new CutoverFenceError(
      `Invalid activeOperations in cutover fence record for namespace ${namespace}: ${String(record.activeOperations)}`,
    );
  }
  if (typeof record.irreversible !== 'boolean') {
    throw new CutoverFenceError(
      `Invalid irreversible field in cutover fence record for namespace ${namespace}: expected boolean, got ${typeof record.irreversible}`,
    );
  }

  // Validate state-specific invariants
  if (record.state === 'legacy_open') {
    if (record.irreversible !== false) {
      throw new CutoverFenceError(
        `Invalid cutover fence invariants for namespace ${namespace}: legacy_open cannot have irreversible: true`,
      );
    }
    if (record.migrationRunId !== undefined || record.migrationManifestDigest !== undefined) {
      throw new CutoverFenceError(
        `Invalid cutover fence invariants for namespace ${namespace}: legacy_open cannot have migration markers`,
      );
    }
  } else if (record.state === 'closing' || record.state === 'fenced') {
    if (record.migrationRunId !== undefined || record.migrationManifestDigest !== undefined) {
      throw new CutoverFenceError(
        `Invalid cutover fence invariants for namespace ${namespace}: ${record.state} cannot have migration markers`,
      );
    }
  } else if (record.state === 'migrating') {
    if (typeof record.migrationRunId !== 'string' || !record.migrationRunId) {
      throw new CutoverFenceError(
        `Invalid cutover fence invariants for namespace ${namespace}: migrating requires non-empty migrationRunId`,
      );
    }
    if (record.migrationManifestDigest !== undefined) {
      throw new CutoverFenceError(
        `Invalid cutover fence invariants for namespace ${namespace}: migrating cannot have migrationManifestDigest before v3_ready`,
      );
    }
  } else if (record.state === 'v3_ready') {
    if (typeof record.migrationRunId !== 'string' || !record.migrationRunId) {
      throw new CutoverFenceError(
        `Invalid cutover fence invariants for namespace ${namespace}: v3_ready requires migrationRunId`,
      );
    }
    if (typeof record.migrationManifestDigest !== 'string' || !record.migrationManifestDigest) {
      throw new CutoverFenceError(
        `Invalid cutover fence invariants for namespace ${namespace}: v3_ready requires migrationManifestDigest`,
      );
    }
  } else if (record.state === 'v3_active') {
    if (typeof record.migrationRunId !== 'string' || !record.migrationRunId) {
      throw new CutoverFenceError(
        `Invalid cutover fence invariants for namespace ${namespace}: v3_active requires migrationRunId`,
      );
    }
    if (typeof record.migrationManifestDigest !== 'string' || !record.migrationManifestDigest) {
      throw new CutoverFenceError(
        `Invalid cutover fence invariants for namespace ${namespace}: v3_active requires migrationManifestDigest`,
      );
    }
    // C12: For empty namespaces, irreversible is false in v3_ready and v3_active until first credential mutation
  }

  return {
    schemaVersion: 1,
    namespace,
    epoch: record.epoch,
    state: record.state as CutoverFenceState,
    activeOperations: record.activeOperations,
    irreversible: record.irreversible,
    migrationRunId: typeof record.migrationRunId === 'string' ? record.migrationRunId : undefined,
    migrationManifestDigest:
      typeof record.migrationManifestDigest === 'string' ? record.migrationManifestDigest : undefined,
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : undefined,
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : undefined,
    fencedAt: typeof record.fencedAt === 'number' ? record.fencedAt : undefined,
    migratedAt: typeof record.migratedAt === 'number' ? record.migratedAt : undefined,
  };
}

export async function readCutoverFenceInTransaction(
  transaction: any,
  db: FirestoreLike,
  namespace: string,
): Promise<CutoverFenceControlRecord> {
  assertSupportedCutoverNamespace(namespace);
  const ref = getCutoverFenceDocRef(db, namespace);
  const snap = await transaction.get(ref);
  if (!snap.exists) {
    throw new CutoverFenceError(
      `Cutover fence control record missing for namespace: ${namespace}`,
    );
  }
  return parseCutoverFenceRecord(snap.data(), namespace);
}

export async function getCutoverFenceRecord(
  db: FirestoreLike,
  namespace: string,
): Promise<CutoverFenceControlRecord | undefined> {
  assertSupportedCutoverNamespace(namespace);
  const ref = getCutoverFenceDocRef(db, namespace);
  const snap = await ref.get();
  if (!snap.exists) return undefined;
  return parseCutoverFenceRecord(snap.data(), namespace);
}

export async function initializeCutoverFence(
  db: FirestoreLike,
  namespace: string,
  options?: {
    initialEpoch?: number;
    initialState?: CutoverFenceState;
    migrationRunId?: string;
    migrationManifestDigest?: string;
    now?: () => number;
  },
): Promise<CutoverFenceControlRecord> {
  assertSupportedCutoverNamespace(namespace);
  const now = options?.now ?? Date.now;
  const ref = getCutoverFenceDocRef(db, namespace);

  return await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (snap.exists) {
      return parseCutoverFenceRecord(snap.data(), namespace);
    }
    const markerSnap = await transaction.get(db.collection(`${namespace}_meta`).doc('v2_adopted'));
    if (markerSnap.exists && (options?.initialState ?? 'legacy_open') === 'legacy_open') {
      throw new CutoverFenceError(
        `Cannot initialize legacy_open for namespace ${namespace}: v2_adopted marker exists in database`,
      );
    }
    const currentTime = now();
    const state = options?.initialState ?? 'legacy_open';
    const isV3 = state === 'v3_ready' || state === 'v3_active';
    const initial: CutoverFenceControlRecord = {
      schemaVersion: 1,
      namespace,
      epoch: options?.initialEpoch ?? 1,
      state,
      activeOperations: 0,
      irreversible: isV3 ? true : false,
      migrationRunId: isV3 ? (options?.migrationRunId ?? 'bootstrap') : undefined,
      migrationManifestDigest: isV3 ? (options?.migrationManifestDigest ?? 'bootstrap') : undefined,
      createdAt: currentTime,
      updatedAt: currentTime,
      migratedAt: isV3 ? currentTime : undefined,
    };
    transaction.set(ref, stripUndefined(initial as unknown as Record<string, unknown>));
    return initial;
  });
}


export interface CutoverTransitionParams {
  fromState?: CutoverFenceState | CutoverFenceState[];
  toState: CutoverFenceState;
  expectedEpoch: number;
  nextEpoch?: number;
  emptyNamespace?: boolean;
  migrationRunId?: string;
  migrationManifestDigest?: string;
  allowIdempotent?: boolean;
  now?: () => number;
}

export async function transitionCutoverFenceState(
  db: FirestoreLike,
  namespace: string,
  params: CutoverTransitionParams,
): Promise<CutoverFenceControlRecord> {
  assertSupportedCutoverNamespace(namespace);
  const now = params.now ?? Date.now;
  const ref = getCutoverFenceDocRef(db, namespace);

  return await db.runTransaction(async (transaction: any) => {
    const current = await readCutoverFenceInTransaction(transaction, db, namespace);

    if (current.epoch !== params.expectedEpoch) {
      throw new CutoverFenceError(
        `Epoch mismatch for namespace ${namespace}: expected ${params.expectedEpoch}, got ${current.epoch}`,
      );
    }

    if (current.state === params.toState) {
      if (params.migrationRunId && current.migrationRunId !== params.migrationRunId) {
        throw new CutoverFenceError(
          `Idempotent transition failed for namespace ${namespace}: migrationRunId mismatch`,
        );
      }
      if (
        params.migrationManifestDigest &&
        current.migrationManifestDigest !== params.migrationManifestDigest
      ) {
        throw new CutoverFenceError(
          `Idempotent transition failed for namespace ${namespace}: migrationManifestDigest mismatch`,
        );
      }
      if (params.allowIdempotent !== false) {
        return current;
      }
      throw new CutoverFenceError(
        `Cutover fence for namespace ${namespace} already in target state ${params.toState}`,
      );
    }

    // Verify allowed state transition according to the strict state graph
    const allowed = ALLOWED_STATE_TRANSITIONS[current.state];
    if (!allowed.includes(params.toState)) {
      throw new CutoverFenceError(
        `Invalid state transition for namespace ${namespace}: cannot transition from ${current.state} to ${params.toState}`,
      );
    }

    if (params.fromState) {
      const fromList = Array.isArray(params.fromState) ? params.fromState : [params.fromState];
      if (!fromList.includes(current.state)) {
        throw new CutoverFenceError(
          `Invalid caller fromState for namespace ${namespace}: current state is ${current.state}, expected one of ${fromList.join(', ')}`,
        );
      }
    }

    if (params.toState === 'fenced') {
      if (current.activeOperations !== 0) {
        throw new CutoverFenceError(
          `Cannot transition to fenced for namespace ${namespace}: activeOperations is ${current.activeOperations}`,
        );
      }
      const pendingOps = await transaction.get(
        getCutoverOperationsColRef(db, namespace).where('phase', 'in', ['admitted', 'upstream_pending']).limit(1),
      );
      if (!pendingOps.empty) {
        throw new CutoverFenceError(
          `Cannot transition to fenced for namespace ${namespace}: active or pending operations exist`,
        );
      }
      const ambiguousOps = await transaction.get(
        getCutoverOperationsColRef(db, namespace).where('ambiguousRemoteOutcome', '==', true).limit(1),
      );
      if (!ambiguousOps.empty) {
        throw new CutoverFenceError(
          `Cannot transition to fenced for namespace ${namespace}: unresolved ambiguous remote operations exist`,
        );
      }
    } else if (params.toState === 'legacy_open') {
      const markerSnap = await transaction.get(db.collection(`${namespace}_meta`).doc('v2_adopted'));
      if (markerSnap.exists) {
        throw new CutoverFenceError(
          `Cannot return to legacy_open for namespace ${namespace}: v2_adopted marker exists`,
        );
      }
      if (current.emptyNamespace) {
        throw new CutoverFenceError(
          `Cannot return to legacy_open for namespace ${namespace}: emptyNamespace cutover completed`,
        );
      }
      if (current.irreversible) {
        throw new CutoverFenceError(
          `Cannot return to legacy_open for namespace ${namespace}: irreversible migration latch is engaged`,
        );
      }
      if (current.activeOperations !== 0) {
        throw new CutoverFenceError(
          `Cannot return to legacy_open for namespace ${namespace}: activeOperations is ${current.activeOperations}`,
        );
      }
      if (current.migrationRunId) {
        throw new CutoverFenceError(
          `Cannot return to legacy_open for namespace ${namespace}: migration run record exists`,
        );
      }
    } else if (params.toState === 'migrating') {
      if (!params.migrationRunId || typeof params.migrationRunId !== 'string') {
        throw new CutoverFenceError(
          `Cannot transition to migrating for namespace ${namespace}: non-empty migrationRunId is required`,
        );
      }
    } else if (params.toState === 'v3_ready') {
      if (!current.migrationRunId) {
        throw new CutoverFenceError(
          `Cannot transition to v3_ready for namespace ${namespace}: current state has no migrationRunId`,
        );
      }
      if (params.migrationRunId && current.migrationRunId !== params.migrationRunId) {
        throw new CutoverFenceError(
          `Cannot transition to v3_ready for namespace ${namespace}: migrationRunId mismatch`,
        );
      }
      if (!params.migrationManifestDigest || typeof params.migrationManifestDigest !== 'string') {
        throw new CutoverFenceError(
          `Cannot transition to v3_ready for namespace ${namespace}: non-empty migrationManifestDigest is required`,
        );
      }
      if (params.emptyNamespace === true) {
        const markerSnap = await transaction.get(db.collection(`${namespace}_meta`).doc('v2_adopted'));
        if (!markerSnap.exists) {
          throw new CutoverFenceError(
            `Cannot transition to v3_ready with emptyNamespace for ${namespace}: v2_adopted marker is missing`,
          );
        }
        const mData = markerSnap.data();
        const markerRunId = mData?.migrationRunId ?? mData?.runId;
        if (markerRunId !== (params.migrationRunId ?? current.migrationRunId)) {
          throw new CutoverFenceError(
            `Cannot transition to v3_ready with emptyNamespace for ${namespace}: marker runId mismatch`,
          );
        }
        if (mData?.emptyNamespace !== true && mData?.empty !== true) {
          throw new CutoverFenceError(
            `Cannot transition to v3_ready with emptyNamespace for ${namespace}: marker is not marked empty`,
          );
        }
      } else {
        if (!current.irreversible) {
          throw new CutoverFenceError(
            `Cannot transition to v3_ready for namespace ${namespace}: irreversible latch must have been engaged by the first credential write during migration`,
          );
        }
      }
    } else if (params.toState === 'v3_active') {
      if (!current.migrationRunId || !current.migrationManifestDigest) {
        throw new CutoverFenceError(
          `Cannot transition to v3_active for namespace ${namespace}: missing migrationRunId or migrationManifestDigest`,
        );
      }
      if (params.migrationRunId && current.migrationRunId !== params.migrationRunId) {
        throw new CutoverFenceError(
          `Cannot transition to v3_active for namespace ${namespace}: migrationRunId mismatch`,
        );
      }
      if (
        params.migrationManifestDigest &&
        current.migrationManifestDigest !== params.migrationManifestDigest
      ) {
        throw new CutoverFenceError(
          `Cannot transition to v3_active for namespace ${namespace}: migrationManifestDigest mismatch`,
        );
      }
    }

    const nextEpoch = params.nextEpoch !== undefined ? params.nextEpoch : current.epoch;
    if (nextEpoch < current.epoch) {
      throw new CutoverFenceError(
        `Next epoch (${nextEpoch}) cannot be less than current epoch (${current.epoch})`,
      );
    }

    const currentTime = now();
    const updated: CutoverFenceControlRecord = {
      ...current,
      state: params.toState,
      epoch: nextEpoch,
      irreversible: current.irreversible,
      emptyNamespace: params.emptyNamespace ?? current.emptyNamespace,
      migrationRunId: params.migrationRunId ?? current.migrationRunId,
      migrationManifestDigest: params.migrationManifestDigest ?? current.migrationManifestDigest,
      updatedAt: currentTime,
      fencedAt: params.toState === 'fenced' ? currentTime : current.fencedAt,
      migratedAt: params.toState === 'v3_ready' ? currentTime : current.migratedAt,
    };

    transaction.set(ref, stripUndefined(updated as unknown as Record<string, unknown>));
    return updated;
  });
}

export async function markIrreversibleInTransaction(
  transaction: any,
  db: FirestoreLike,
  namespace: string,
  expectedEpoch: number,
  migrationRunId?: string,
  nowProvider: () => number = Date.now,
): Promise<CutoverFenceControlRecord> {
  assertSupportedCutoverNamespace(namespace);
  const current = await readCutoverFenceInTransaction(transaction, db, namespace);
  if (current.state !== 'migrating' && current.state !== 'v3_ready' && current.state !== 'v3_active') {
    throw new CutoverFenceError(
      `Cannot set irreversible latch for namespace ${namespace}: state must be 'migrating', 'v3_ready', or 'v3_active', got '${current.state}'`,
    );
  }
  if (current.epoch !== expectedEpoch) {
    throw new CutoverFenceError(
      `Epoch mismatch when setting irreversible latch for namespace ${namespace}: expected ${expectedEpoch}, got ${current.epoch}`,
    );
  }
  if (migrationRunId && current.migrationRunId !== migrationRunId) {
    throw new CutoverFenceError(
      `migrationRunId mismatch when setting irreversible latch: expected ${migrationRunId}, got ${current.migrationRunId}`,
    );
  }
  if (current.irreversible) {
    return current;
  }
  const currentTime = nowProvider();
  const updated: CutoverFenceControlRecord = {
    ...current,
    irreversible: true,
    updatedAt: currentTime,
  };
  const ref = getCutoverFenceDocRef(db, namespace);
  transaction.set(ref, stripUndefined(updated as unknown as Record<string, unknown>), { merge: true });
  return updated;
}

export interface WithLegacyOperationOptions {
  db: FirestoreLike;
  namespace: string;
  kind: string;
  operationId?: string;
  leaseMs?: number;
  metadata?: Record<string, unknown>;
  now?: () => number;
}

export async function withLegacyOperation<R>(
  options: WithLegacyOperationOptions,
  fn: (ctx: LegacyOperationContext) => Promise<R>,
): Promise<R> {
  const now = options.now ?? Date.now;
  const opId = options.operationId ?? randomUUID();
  const controlRef = getCutoverFenceDocRef(options.db, options.namespace);
  const opRef = getCutoverOperationDocRef(options.db, options.namespace, opId);

  const opRecord = await options.db.runTransaction(async (transaction: any) => {
    const control = await readCutoverFenceInTransaction(transaction, options.db, options.namespace);

    if (control.state !== 'legacy_open' || control.irreversible) {
      throw new CutoverRefusedError(
        `Cutover state is ${control.state} (irreversible=${control.irreversible}); admissions closed for namespace ${options.namespace}`,
        { cutoverState: control.state, epoch: control.epoch },
      );
    }

    const existingOp = await transaction.get(opRef);
    if (existingOp.exists) {
      const existingRecord = existingOp.data() as LegacyOperationRecord;
      throw new CutoverFenceError(
        `Operation ID ${opId} already exists in phase ${existingRecord.phase}; duplicate admission rejected`,
      );
    }
    if (!options.kind || typeof options.kind !== 'string' || options.kind.length > 64 || !/^[a-zA-Z0-9_-]+$/.test(options.kind)) {
      throw new CutoverFenceError(
        `Invalid operation kind: kind must be an alphanumeric identifier up to 64 chars, got '${options.kind}'`,
      );
    }
    const forbiddenKindTerms = ['password', 'secret', 'credential'];
    if (forbiddenKindTerms.some((t) => options.kind.toLowerCase().includes(t))) {
      throw new CutoverFenceError(`Operation kind must not contain sensitive credential terms: '${options.kind}'`);
    }

    if (options.metadata) {
      const allowedKeys = ['revision', 'attempt', 'phase', 'reconciled'];
      for (const [key, value] of Object.entries(options.metadata)) {
        if (!allowedKeys.includes(key)) {
          throw new CutoverFenceError(
            `Operation metadata key '${key}' is not in the allowlist (${allowedKeys.join(', ')})`,
          );
        }
        if (typeof value === 'string') {
          if (value.length > 64) {
            throw new CutoverFenceError(`Operation metadata value for '${key}' exceeds 64 chars`);
          }
          const forbiddenTerms = ['bearer', 'secret', 'token', 'password', 'jwt', 'auth'];
          if (forbiddenTerms.some((term) => value.toLowerCase().includes(term))) {
            throw new CutoverFenceError(`Operation metadata value for '${key}' must not contain sensitive fragments`);
          }
        } else if (typeof value !== 'number' && typeof value !== 'boolean') {
          throw new CutoverFenceError(`Operation metadata value for '${key}' must be primitive (string, number, boolean)`);
        }
      }
    }
    const currentTime = now();
    const createdRecord: LegacyOperationRecord = {
      schemaVersion: 1,
      id: opId,
      namespace: options.namespace,
      epoch: control.epoch,
      kind: options.kind,
      phase: 'admitted',
      createdAt: currentTime,
      updatedAt: currentTime,
      leaseExpiresAt: options.leaseMs ? currentTime + options.leaseMs : undefined,
      ambiguousRemoteOutcome: false,
      metadata: options.metadata ? stripUndefined(options.metadata) : undefined,
    };

    transaction.set(
      controlRef,
      { activeOperations: control.activeOperations + 1, updatedAt: currentTime },
      { merge: true },
    );
    transaction.set(opRef, stripUndefined(createdRecord as unknown as Record<string, unknown>));

    return createdRecord;
  });

  let ambiguous = false;
  let completed = false;

  const ctx: LegacyOperationContext = {
    id: opId,
    namespace: options.namespace,
    epoch: opRecord.epoch,
    kind: options.kind,
    isAmbiguousRemoteOutcome: () => ambiguous,
    markAmbiguousRemoteOutcome: () => {
      ambiguous = true;
    },
    clearAmbiguousRemoteOutcome: () => {
      ambiguous = false;
    },
    isCompleted: () => completed,
    markCompleted: () => {
      completed = true;
    },
  };

  try {
    const result = await fn(ctx);
    if (!ctx.isCompleted() && !ctx.isAmbiguousRemoteOutcome()) {
      await releaseLegacyOperation(options.db, ctx, 'completed', now);
    }
    return result;
  } catch (err) {
    if (ctx.isAmbiguousRemoteOutcome()) {
      await markOperationAmbiguous(options.db, ctx, now).catch(() => {});
    } else if (!ctx.isCompleted()) {
      await releaseLegacyOperation(options.db, ctx, 'failed', now).catch(() => {});
    }
    throw err;
  }
}

export async function releaseLegacyOperation(
  db: FirestoreLike,
  ctx: LegacyOperationContext,
  terminalPhase: 'completed' | 'failed',
  nowProvider: () => number = Date.now,
): Promise<void> {
  const controlRef = getCutoverFenceDocRef(db, ctx.namespace);
  const opRef = getCutoverOperationDocRef(db, ctx.namespace, ctx.id);
  const currentTime = nowProvider();

  await db.runTransaction(async (transaction: any) => {
    const controlSnap = await transaction.get(controlRef);
    const opSnap = await transaction.get(opRef);

    if (controlSnap.exists) {
      const control = parseCutoverFenceRecord(controlSnap.data(), ctx.namespace);
      const newActive = Math.max(0, control.activeOperations - 1);
      transaction.set(
        controlRef,
        { activeOperations: newActive, updatedAt: currentTime },
        { merge: true },
      );
    }

    if (opSnap.exists) {
      transaction.set(
        opRef,
        { phase: terminalPhase, updatedAt: currentTime },
        { merge: true },
      );
    }
  });

  ctx.markCompleted();
}

export async function markOperationAmbiguous(
  db: FirestoreLike,
  ctx: LegacyOperationContext,
  nowProvider: () => number = Date.now,
): Promise<void> {
  const opRef = getCutoverOperationDocRef(db, ctx.namespace, ctx.id);
  const currentTime = nowProvider();

  await db.runTransaction(async (transaction: any) => {
    const opSnap = await transaction.get(opRef);
    if (opSnap.exists) {
      transaction.set(
        opRef,
        {
          phase: 'upstream_pending',
          ambiguousRemoteOutcome: true,
          updatedAt: currentTime,
        },
        { merge: true },
      );
    }
  });
}

export interface GuardMutationOptions {
  db: FirestoreLike;
  namespace: string;
  operation?: LegacyOperationContext;
  completeOperation?: boolean;
  now?: () => number;
}

export interface GuardMutationResult {
  control: CutoverFenceControlRecord;
  operation?: LegacyOperationRecord;
  bufferCompletion: (now?: number) => void;
}

export async function checkMutationGuardInTransaction(
  transaction: any,
  options: GuardMutationOptions,
): Promise<GuardMutationResult> {
  const control = await readCutoverFenceInTransaction(transaction, options.db, options.namespace);

  if (['fenced', 'migrating', 'v3_ready', 'v3_active'].includes(control.state)) {
    throw new CutoverRefusedError(
      `Cutover state is ${control.state}; mutations refused for namespace ${options.namespace}`,
      { cutoverState: control.state, epoch: control.epoch },
    );
  }

  let opRecord: LegacyOperationRecord | undefined;

  if (control.state === 'closing') {
    if (!options.operation) {
      throw new CutoverRefusedError(
        `Cutover is closing; unadmitted mutation refused for namespace ${options.namespace}`,
        { cutoverState: control.state, epoch: control.epoch },
      );
    }
    if (options.operation.epoch !== control.epoch) {
      throw new CutoverFenceError(
        `Operation epoch mismatch during closing for namespace ${options.namespace}: expected ${control.epoch}, got ${options.operation.epoch}`,
      );
    }
    const opRef = getCutoverOperationDocRef(options.db, options.namespace, options.operation.id);
    const opSnap = await transaction.get(opRef);
    if (!opSnap.exists) {
      throw new CutoverFenceError(
        `Operation record ${options.operation.id} missing during closing`,
      );
    }
    opRecord = opSnap.data() as LegacyOperationRecord;
    if (opRecord.epoch !== control.epoch) {
      throw new CutoverFenceError(
        `Operation record epoch mismatch: expected ${control.epoch}, got ${opRecord.epoch}`,
      );
    }
    if (opRecord.phase !== 'admitted' && opRecord.phase !== 'upstream_pending') {
      throw new CutoverFenceError(
        `Operation ${options.operation.id} is in phase ${opRecord.phase}; mutation not permitted`,
      );
    }
  } else if (control.state === 'legacy_open') {
    if (!options.operation) {
      throw new CutoverFenceError(
        `Durable operation context is required for fence-enforced mutations in namespace ${options.namespace}`,
      );
    }
    if (options.operation.epoch !== control.epoch) {
      throw new CutoverFenceError(
        `Operation epoch mismatch: expected ${control.epoch}, got ${options.operation.epoch}`,
      );
    }
    const opRef = getCutoverOperationDocRef(options.db, options.namespace, options.operation.id);
    const opSnap = await transaction.get(opRef);
    if (!opSnap.exists) {
      throw new CutoverFenceError(
        `Operation record ${options.operation.id} missing`,
      );
    }
    opRecord = opSnap.data() as LegacyOperationRecord;
    if (opRecord.epoch !== control.epoch) {
      throw new CutoverFenceError(
        `Operation record epoch mismatch: expected ${control.epoch}, got ${opRecord.epoch}`,
      );
    }
    if (opRecord.phase !== 'admitted' && opRecord.phase !== 'upstream_pending') {
      throw new CutoverFenceError(
        `Operation ${options.operation.id} is already in phase ${opRecord.phase}; cannot be reused for mutation`,
      );
    }
  }

  const shouldComplete = options.operation && options.completeOperation !== false;
  const opToComplete = options.operation;

  return {
    control,
    operation: opRecord,
    bufferCompletion: (customNow?: number) => {
      if (!shouldComplete || !opToComplete) return;
      const currentTime = customNow ?? (options.now ? options.now() : Date.now());
      const controlRef = getCutoverFenceDocRef(options.db, options.namespace);
      const opRef = getCutoverOperationDocRef(options.db, options.namespace, opToComplete.id);

      transaction.set(
        opRef,
        { phase: 'completed', updatedAt: currentTime },
        { merge: true },
      );
      transaction.set(
        controlRef,
        {
          activeOperations: Math.max(0, control.activeOperations - 1),
          updatedAt: currentTime,
        },
        { merge: true },
      );
      opToComplete.markCompleted();
    },
  };
}

export async function isLegacyMutationPermittedInTransaction(
  transaction: any,
  db: FirestoreLike,
  namespace: string,
  operation?: LegacyOperationContext,
): Promise<{ permitted: boolean; control: CutoverFenceControlRecord }> {
  const control = await readCutoverFenceInTransaction(transaction, db, namespace);
  if (['fenced', 'migrating', 'v3_ready', 'v3_active'].includes(control.state)) {
    return { permitted: false, control };
  }
  if (control.state === 'closing') {
    if (!operation || operation.epoch !== control.epoch) {
      return { permitted: false, control };
    }
  }
  return { permitted: true, control };
}
