// Copied from @phoneware/mcp-oauth-kit 1.0.0 (phoneware/monorepo packages/mcp-oauth-kit/src/cutover-fence.ts at 4ea97b0d2599a3372ea37b47977333c2827c443c). Edit the canonical file, then re-copy.
import { randomUUID } from 'node:crypto';
import type {
  CollectionReference,
  DocumentReference,
  Firestore,
  Transaction,
} from '@google-cloud/firestore';
import { CutoverFenceError, CutoverRefusedError } from './errors.js';
import { stripUndefined } from './strip-undefined.js';

export const SUPPORTED_CUTOVER_NAMESPACES = ['mcp', 'pwmcp', 'readonly_mcp'] as const;
export type SupportedCutoverNamespace = (typeof SUPPORTED_CUTOVER_NAMESPACES)[number];

export function isSupportedCutoverNamespace(namespace: string): namespace is SupportedCutoverNamespace {
  return (SUPPORTED_CUTOVER_NAMESPACES as readonly string[]).includes(namespace);
}

export type CutoverFenceState =
  | 'legacy_open'
  | 'closing'
  | 'fenced'
  | 'migrating'
  | 'v3_ready'
  | 'v3_active';

export interface CutoverFenceControlRecord {
  schemaVersion: 1;
  namespace: string;
  epoch: number;
  state: CutoverFenceState;
  activeOperations: number;
  irreversible: boolean;
  migrationRunId?: string;
  migrationManifestDigest?: string;
  createdAt?: number;
  updatedAt?: number;
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
  metadata?: Record<string, unknown>;
}

export interface LegacyOperationContext {
  readonly id: string;
  readonly namespace: string;
  readonly epoch: number;
  readonly kind: string;
  isAmbiguousRemoteOutcome(): boolean;
  markAmbiguousRemoteOutcome(reason?: string): void;
  isCompleted(): boolean;
  markCompleted(): void;
}

export function getCutoverFenceDocRef(db: Firestore, namespace: string): DocumentReference {
  return db.collection(`${namespace}_meta`).doc('cutover_fence');
}

export function getCutoverOperationsColRef(db: Firestore, namespace: string): CollectionReference {
  return db.collection(`${namespace}_meta`).doc('cutover_fence').collection('operations');
}

export function getCutoverOperationDocRef(
  db: Firestore,
  namespace: string,
  operationId: string,
): DocumentReference {
  return getCutoverOperationsColRef(db, namespace).doc(operationId);
}

export function parseCutoverFenceRecord(data: unknown, namespace: string): CutoverFenceControlRecord {
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
  };
}

export async function readCutoverFenceInTransaction(
  transaction: Transaction,
  db: Firestore,
  namespace: string,
): Promise<CutoverFenceControlRecord> {
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
  db: Firestore,
  namespace: string,
): Promise<CutoverFenceControlRecord | undefined> {
  const ref = getCutoverFenceDocRef(db, namespace);
  const snap = await ref.get();
  if (!snap.exists) return undefined;
  return parseCutoverFenceRecord(snap.data(), namespace);
}

export async function initializeCutoverFence(
  db: Firestore,
  namespace: string,
  options?: {
    initialEpoch?: number;
    initialState?: CutoverFenceState;
    now?: () => number;
  },
): Promise<CutoverFenceControlRecord> {
  const now = options?.now ?? Date.now;
  const ref = getCutoverFenceDocRef(db, namespace);

  return await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (snap.exists) {
      return parseCutoverFenceRecord(snap.data(), namespace);
    }
    const currentTime = now();
    const initial: CutoverFenceControlRecord = {
      schemaVersion: 1,
      namespace,
      epoch: options?.initialEpoch ?? 1,
      state: options?.initialState ?? 'legacy_open',
      activeOperations: 0,
      irreversible: false,
      createdAt: currentTime,
      updatedAt: currentTime,
    };
    transaction.set(ref, stripUndefined(initial as unknown as Record<string, unknown>));
    return initial;
  });
}

export interface CutoverTransitionParams {
  fromState: CutoverFenceState | CutoverFenceState[];
  toState: CutoverFenceState;
  expectedEpoch: number;
  nextEpoch?: number;
  migrationRunId?: string;
  migrationManifestDigest?: string;
  allowIdempotent?: boolean;
  now?: () => number;
}

export async function transitionCutoverFenceState(
  db: Firestore,
  namespace: string,
  params: CutoverTransitionParams,
): Promise<CutoverFenceControlRecord> {
  const now = params.now ?? Date.now;
  const ref = getCutoverFenceDocRef(db, namespace);

  return await db.runTransaction(async (transaction) => {
    const current = await readCutoverFenceInTransaction(transaction, db, namespace);

    if (current.epoch !== params.expectedEpoch) {
      throw new CutoverFenceError(
        `Epoch mismatch for namespace ${namespace}: expected ${params.expectedEpoch}, got ${current.epoch}`,
      );
    }

    if (current.state === params.toState) {
      if (params.allowIdempotent !== false) {
        return current;
      }
      throw new CutoverFenceError(
        `Cutover fence for namespace ${namespace} already in target state ${params.toState}`,
      );
    }

    const fromList = Array.isArray(params.fromState) ? params.fromState : [params.fromState];
    if (!fromList.includes(current.state)) {
      throw new CutoverFenceError(
        `Invalid state transition for namespace ${namespace}: cannot transition from ${current.state} to ${params.toState}`,
      );
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
      if (!params.migrationRunId) {
        throw new CutoverFenceError(
          `Cannot transition to migrating for namespace ${namespace}: migrationRunId is required`,
        );
      }
    } else if (params.toState === 'v3_ready') {
      if (!params.migrationManifestDigest) {
        throw new CutoverFenceError(
          `Cannot transition to v3_ready for namespace ${namespace}: migrationManifestDigest is required`,
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
      migrationRunId: params.migrationRunId ?? current.migrationRunId,
      migrationManifestDigest: params.migrationManifestDigest ?? current.migrationManifestDigest,
      updatedAt: currentTime,
    };

    transaction.set(ref, stripUndefined(updated as unknown as Record<string, unknown>));
    return updated;
  });
}

export async function markIrreversibleInTransaction(
  transaction: Transaction,
  db: Firestore,
  namespace: string,
  expectedEpoch: number,
  nowProvider: () => number = Date.now,
): Promise<CutoverFenceControlRecord> {
  const current = await readCutoverFenceInTransaction(transaction, db, namespace);
  if (current.epoch !== expectedEpoch) {
    throw new CutoverFenceError(
      `Epoch mismatch when setting irreversible latch for namespace ${namespace}: expected ${expectedEpoch}, got ${current.epoch}`,
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
  db: Firestore;
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

  const opRecord = await options.db.runTransaction(async (transaction) => {
    const control = await readCutoverFenceInTransaction(transaction, options.db, options.namespace);

    if (control.state !== 'legacy_open') {
      throw new CutoverRefusedError(
        `Cutover state is ${control.state}; admissions closed for namespace ${options.namespace}`,
        { cutoverState: control.state, epoch: control.epoch },
      );
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
  db: Firestore,
  ctx: LegacyOperationContext,
  terminalPhase: 'completed' | 'failed',
  nowProvider: () => number = Date.now,
): Promise<void> {
  const controlRef = getCutoverFenceDocRef(db, ctx.namespace);
  const opRef = getCutoverOperationDocRef(db, ctx.namespace, ctx.id);
  const currentTime = nowProvider();

  await db.runTransaction(async (transaction) => {
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
  db: Firestore,
  ctx: LegacyOperationContext,
  nowProvider: () => number = Date.now,
): Promise<void> {
  const opRef = getCutoverOperationDocRef(db, ctx.namespace, ctx.id);
  const currentTime = nowProvider();

  await db.runTransaction(async (transaction) => {
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
  db: Firestore;
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
  transaction: Transaction,
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
    if (options.operation) {
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
  transaction: Transaction,
  db: Firestore,
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
