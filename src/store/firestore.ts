import {
  type CutoverFenceControlRecord,
  getCutoverFenceDocRef,
  isSupportedCutoverNamespace,
  CutoverRefusedError,
  CutoverFenceError,
  parseCutoverFenceRecord,
  getCutoverFenceRecord,
  SUPPORTED_CUTOVER_NAMESPACES,
} from '../auth/kit/cutover-fence.js';
import type { AtomicIssueParams, AtomicRedeemAndIssueParams } from './types.js';
import { adoptFirestoreLegacyTokens, ensureFirestoreAdopted } from './firestore-v2-adoption.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { createRegisteredClient, createStore, REFRESH_RETRY_WINDOW_MS } from './store.js';
import type {
  AccessRow,
  AuthCodeRow,
  BackendRotateParams,
  BackendRotateResult,
  FamilyRow,
  McpStore,
  RefreshPointerRow,
  ResumeRow,
  RevokeCondition,
  SessionRow,
  StoreBackend,
  StoreCapabilities,
  UpstreamGrantRow,
} from './types.js';

interface DocumentSnapshotLike {
  readonly id: string;
  readonly exists: boolean;
  data(): Record<string, unknown> | undefined;
}
interface QuerySnapshotLike {
  readonly empty: boolean;
  readonly docs: DocumentSnapshotLike[];
}
interface DocumentReferenceLike {
  readonly id: string;
  get(): Promise<DocumentSnapshotLike>;
  set(data: Record<string, unknown>, options?: { merge?: boolean }): Promise<unknown>;
  delete(): Promise<unknown>;
  collection?(path: string): CollectionLike;
}
interface QueryLike {
  get(): Promise<QuerySnapshotLike>;
  limit(count: number): QueryLike;
}
interface CollectionLike extends QueryLike {
  doc(id: string): DocumentReferenceLike;
  where(field: string, op: '==' | 'in', value: any): QueryLike;
}
interface TransactionLike {
  get(ref: DocumentReferenceLike | QueryLike): Promise<any>;
  set(ref: DocumentReferenceLike, data: Record<string, unknown>, options?: { merge?: boolean }): unknown;
  delete(ref: DocumentReferenceLike): unknown;
}
export interface FirestoreLike {
  collection(path: string): CollectionLike;
  runTransaction<T>(callback: (tx: TransactionLike) => Promise<T>): Promise<T>;
}

export interface FirestoreCollections {
  sessions: string;
  refreshTokens: string;
  refreshFamilies: string;
  upstreamGrants: string;
  retiredRefreshTokens: string;
  meta: string;
  oauthClients: string;
  authCodes: string;
  resumeTokens: string;
  usage: string;
}

export function firestoreCollections(namespace: string): FirestoreCollections {
  return {
    sessions: `${namespace}_sessions`,
    refreshTokens: `${namespace}_refresh`,
    refreshFamilies: `${namespace}_refresh_families`,
    upstreamGrants: `${namespace}_upstream`,
    retiredRefreshTokens: `${namespace}_retired_refresh`,
    meta: `${namespace}_meta`,
    oauthClients: `${namespace}_oauth_clients`,
    authCodes: `${namespace}_auth_codes`,
    resumeTokens: `${namespace}_resume_tokens`,
    usage: `${namespace}_usage`,
  };
}

function defined<T>(value: T): T {
  if (Array.isArray(value)) return value.filter(v => v !== undefined).map(defined) as T;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, defined(v)])) as T;
  }
  return value;
}

export class FirestoreClientsStore implements OAuthRegisteredClientsStore {
  private readonly namespace?: string;
  constructor(private readonly options: { db: FirestoreLike; collection: string; namespace?: string }) {
    this.namespace = options.namespace ?? this.resolveNamespace(options.collection);
  }
  private resolveNamespace(col: string): string | undefined {
    for (const ns of SUPPORTED_CUTOVER_NAMESPACES) {
      if (col === ns || col.startsWith(`${ns}_`)) return ns;
    }
    return undefined;
  }
  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const ns = this.namespace;
    if (ns && isSupportedCutoverNamespace(ns)) {
      const control = await getCutoverFenceRecord(this.options.db, ns);
      if (!control || control.state !== 'v3_active') {
        throw new CutoverRefusedError(
          `Cutover state is ${control?.state ?? 'uninitialized'}; operations require v3_active for namespace ${ns}`,
          { cutoverState: control?.state, epoch: control?.epoch },
        );
      }
    }
    const doc = await this.options.db.collection(this.options.collection).doc(clientId).get();
    return doc.exists ? (doc.data() as OAuthClientInformationFull) : undefined;
  }
  async registerClient(client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>): Promise<OAuthClientInformationFull> {
    const full = createRegisteredClient(client);
    const ns = this.namespace;
    if (ns && isSupportedCutoverNamespace(ns)) {
      await this.options.db.runTransaction(async (tx) => {
        const controlRef = getCutoverFenceDocRef(this.options.db, ns);
        const snap = await tx.get(controlRef);
        if (!snap.exists) {
          throw new CutoverFenceError(`Cutover fence control record missing for namespace: ${ns}. Mutations refused.`);
        }
        const control = parseCutoverFenceRecord(snap.data(), ns);
        if (control.state !== 'v3_active') {
          throw new CutoverRefusedError(
            `Cutover state is ${control.state}; v3 mutations require v3_active for namespace ${ns}`,
            { cutoverState: control.state, epoch: control.epoch },
          );
        }
        if (!control.irreversible) {
          tx.set(controlRef, { irreversible: true, updatedAt: Date.now() }, { merge: true });
        }
        tx.set(this.options.db.collection(this.options.collection).doc(full.client_id), defined(full));
      });
    } else {
      await this.options.db.collection(this.options.collection).doc(full.client_id).set(defined(full));
    }
    return full;
  }
}

export interface FirestoreBackend extends StoreBackend { }
export class FirestoreBackend implements StoreBackend {
  readonly name = 'firestore';
  readonly capabilities: StoreCapabilities = { persistent: true, multiInstance: true, exclusive: false, expiry: 'ttl-policy' };
  readonly db: FirestoreLike;
  readonly collections: FirestoreCollections;

  getAccess!: StoreBackend['getAccess'];
  putAccess!: StoreBackend['putAccess'];
  deleteAccess!: StoreBackend['deleteAccess'];

  getRefresh!: StoreBackend['getRefresh'];
  putRefresh!: StoreBackend['putRefresh'];
  deleteRefresh!: StoreBackend['deleteRefresh'];

  getFamily!: StoreBackend['getFamily'];
  putFamily!: StoreBackend['putFamily'];

  getUpstream!: StoreBackend['getUpstream'];
  putUpstream!: StoreBackend['putUpstream'];
  updateUpstream!: StoreBackend['updateUpstream'];
  atomicIssue!: StoreBackend['atomicIssue'];
  atomicRotate!: StoreBackend['atomicRotate'];
  atomicRevokeFamily!: StoreBackend['atomicRevokeFamily'];
  findFamilyByRetiredId!: NonNullable<StoreBackend['findFamilyByRetiredId']>;

  putAuthCode!: StoreBackend['putAuthCode'];
  getAuthCode!: StoreBackend['getAuthCode'];
  takeAuthCode!: StoreBackend['takeAuthCode'];
  atomicRedeemCodeAndIssue!: NonNullable<StoreBackend['atomicRedeemCodeAndIssue']>;
  insertResumeIfAbsent!: StoreBackend['insertResumeIfAbsent'];
  incrementUsage!: StoreBackend['incrementUsage'];
  listUsage!: StoreBackend['listUsage'];
  getClient!: StoreBackend['getClient'];
  putClient!: StoreBackend['putClient'];
  sweep!: StoreBackend['sweep'];
  close!: StoreBackend['close'];

  constructor(options: { db: FirestoreLike; namespace: string; key?: Uint8Array }) {
    const { db, namespace, key } = options;
    this.db = db;
    const names = this.collections = firestoreCollections(namespace);
    const sessions = db.collection(names.sessions);
    const refreshTokens = db.collection(names.refreshTokens);
    const refreshFamilies = db.collection(names.refreshFamilies);
    const upstreamGrants = db.collection(names.upstreamGrants);
    const codes = db.collection(names.authCodes);
    const resumes = db.collection(names.resumeTokens);
    const usage = db.collection(names.usage);
    const clients = db.collection(names.oauthClients);
    const retiredTokens = db.collection(names.retiredRefreshTokens);

    const accessData = ({ id: _id, ...row }: AccessRow) => defined({ ...row, v: 2, ttlAt: new Date(row.retainUntil) });
    const refreshData = ({ id: _id, ...row }: RefreshPointerRow) => defined({ ...row, v: 2 });
    const familyData = ({ id: _id, ...row }: FamilyRow) => defined({ ...row, v: 2 });
    const upstreamData = ({ id: _id, ...row }: UpstreamGrantRow) => defined({ ...row, v: 2 });
    const codeData = ({ id: _id, ...row }: AuthCodeRow) => defined({ ...row, v: 2, ttlAt: new Date(row.expiresAt) });
    const resumeData = ({ id: _id, ...row }: ResumeRow) => defined({ ...row, v: 2, ttlAt: new Date(row.expiresAt) });

    let adoptionPromise: Promise<void> | null = null;
    const ensureAdopted = async () => {
      if (!key) return;
      if (!adoptionPromise) {
        adoptionPromise = ensureFirestoreAdopted({ db, namespace, key }).catch((err) => {
          adoptionPromise = null;
          throw err;
        });
      }
      return adoptionPromise;
    };

    const assertV3Active = async (tx?: any) => {
      if (!isSupportedCutoverNamespace(namespace)) return;
      const controlRef = getCutoverFenceDocRef(db, namespace);
      const snap = tx ? await tx.get(controlRef) : await controlRef.get();
      if (!snap || !snap.exists) {
        throw new CutoverFenceError(
          `Cutover fence control record missing for namespace: ${namespace}. Operations refused.`,
        );
      }
      const control = parseCutoverFenceRecord(snap.data(), namespace);
      if (control.state !== 'v3_active') {
        throw new CutoverRefusedError(
          `Cutover state is ${control.state}; v3 operations require v3_active for namespace ${namespace}`,
          { cutoverState: control.state, epoch: control.epoch },
        );
      }
    };
    const assertV3ActiveInTransaction = assertV3Active;

    const latchIrreversibleInTransaction = async (tx: any) => {
      if (!isSupportedCutoverNamespace(namespace)) return;
      const controlRef = getCutoverFenceDocRef(db, namespace);
      const snap = await tx.get(controlRef);
      if (snap.exists) {
        const control = parseCutoverFenceRecord(snap.data(), namespace);
        if (!control.irreversible) {
          tx.set(controlRef, { irreversible: true, updatedAt: Date.now() }, { merge: true });
        }
      }
    };

    const backend: StoreBackend = {
      name: 'firestore',
      capabilities: this.capabilities,

      async getAccess(id: string) {
        await assertV3Active();
        await ensureAdopted();
        const snap = await sessions.doc(id).get();
        return snap.exists ? ({ ...snap.data(), id } as unknown as AccessRow) : undefined;
      },
      async putAccess(row) {
        return db.runTransaction(async tx => {
          await assertV3ActiveInTransaction(tx);
          await latchIrreversibleInTransaction(tx);
          tx.set(sessions.doc(row.id), accessData(row));
        });
      },
      async deleteAccess(id) {
        return db.runTransaction(async tx => {
          await assertV3ActiveInTransaction(tx);
          const snap = await tx.get(sessions.doc(id));
          if (snap.exists) {
            await latchIrreversibleInTransaction(tx);
            tx.delete(sessions.doc(id));
          }
        });
      },

      async getRefresh(id: string) {
        await assertV3Active();
        await ensureAdopted();
        const snap = await refreshTokens.doc(id).get();
        return snap.exists ? ({ ...snap.data(), id } as unknown as RefreshPointerRow) : undefined;
      },
      async putRefresh(row) {
        return db.runTransaction(async tx => {
          await assertV3ActiveInTransaction(tx);
          await latchIrreversibleInTransaction(tx);
          tx.set(refreshTokens.doc(row.id), refreshData(row));
        });
      },
      async deleteRefresh(id) {
        return db.runTransaction(async tx => {
          await assertV3ActiveInTransaction(tx);
          const snap = await tx.get(refreshTokens.doc(id));
          if (snap.exists) {
            await latchIrreversibleInTransaction(tx);
            tx.delete(refreshTokens.doc(id));
          }
        });
      },
      async atomicIssue(params: AtomicIssueParams): Promise<void> {
        return db.runTransaction(async tx => {
          await assertV3ActiveInTransaction(tx);
          await latchIrreversibleInTransaction(tx);
          tx.set(sessions.doc(params.accessRow.id), accessData(params.accessRow));
          tx.set(refreshTokens.doc(params.refreshRow.id), refreshData(params.refreshRow));
          tx.set(refreshFamilies.doc(params.familyRow.id), familyData(params.familyRow));
          tx.set(upstreamGrants.doc(params.upstreamRow.id), upstreamData(params.upstreamRow));
        });
      },

      async getFamily(id) {
        await assertV3Active();
        await ensureAdopted();
        const snap = await refreshFamilies.doc(id).get();
        return snap.exists ? ({ ...snap.data(), id } as unknown as FamilyRow) : undefined;
      },
      async putFamily(row) {
        return db.runTransaction(async tx => {
          await assertV3ActiveInTransaction(tx);
          await latchIrreversibleInTransaction(tx);
          tx.set(refreshFamilies.doc(row.id), familyData(row));
        });
      },

      async getUpstream(id) {
        await assertV3Active();
        await ensureAdopted();
        const snap = await upstreamGrants.doc(id).get();
        return snap.exists ? ({ ...snap.data(), id } as unknown as UpstreamGrantRow) : undefined;
      },
      async putUpstream(row) {
        return db.runTransaction(async tx => {
          await assertV3ActiveInTransaction(tx);
          await latchIrreversibleInTransaction(tx);
          tx.set(upstreamGrants.doc(row.id), upstreamData(row));
        });
      },
      async updateUpstream(id, mutate) {
        const ref = upstreamGrants.doc(id);
        return db.runTransaction(async tx => {
          await assertV3ActiveInTransaction(tx);
          const snap = await tx.get(ref);
          if (!snap.exists) return undefined;
          const current = { ...snap.data(), id } as UpstreamGrantRow;
          const next = mutate(current);
          if (next === undefined) return undefined;
          await latchIrreversibleInTransaction(tx);
          if (next === null) { tx.delete(ref); return undefined; }
          tx.set(ref, upstreamData(next));
          return next;
        });
      },
      async findFamilyByRetiredId(retiredId: string): Promise<FamilyRow | undefined> {
        await assertV3Active();
        await ensureAdopted();
        const doc = await retiredTokens.doc(retiredId).get();
        if (doc.exists) {
          const famId = (doc.data() as { familyId: string }).familyId;
          const famSnap = await refreshFamilies.doc(famId).get();
          return famSnap.exists ? ({ ...famSnap.data(), id: famId } as unknown as FamilyRow) : undefined;
        }
        return undefined;
      },

      async atomicRotate(params: BackendRotateParams): Promise<BackendRotateResult> {
        const oldRefDoc = refreshTokens.doc(params.oldRefreshId);
        return db.runTransaction(async tx => {
          await assertV3ActiveInTransaction(tx);

          // All reads first
          const oldSnap = await tx.get(oldRefDoc);
          if (!oldSnap.exists) {
            let retiredDoc = await tx.get(retiredTokens.doc(params.oldRefreshId));
            if (!retiredDoc.exists && params.legacyFingerprint) {
              retiredDoc = await tx.get(retiredTokens.doc(params.legacyFingerprint));
            }
            if (retiredDoc.exists) {
              const famId = (retiredDoc.data() as { familyId: string }).familyId;
              const famDoc = refreshFamilies.doc(famId);
              const famSnap = await tx.get(famDoc);
              let refDocs: any[] = [];
              if (famSnap.exists) {
                const refQuerySnap = await tx.get(refreshTokens.where('familyId', '==', famId));
                refDocs = refQuerySnap.docs;
              }
              // All reads done. Now writes.
              if (famSnap.exists) {
                await latchIrreversibleInTransaction(tx);
                const fam = { ...famSnap.data(), id: famDoc.id } as FamilyRow;
                tx.set(famDoc, familyData({ ...fam, status: 'revoked', revokedAt: params.now, generation: fam.generation + 1, updatedAt: params.now }));
                if (fam.currentAccessTokenId) tx.delete(sessions.doc(fam.currentAccessTokenId));
                tx.delete(upstreamGrants.doc(famId));
                for (const doc of refDocs) {
                  const data = doc.data() as unknown as RefreshPointerRow;
                  tx.set(refreshTokens.doc(doc.id), refreshData({ ...data, status: 'consumed', consumedAt: params.now, successorSealed: undefined }));
                }
              }
              return { status: 'replay', familyId: famId };
            }
            return { status: 'missing' };
          }

          const oldRef = { ...oldSnap.data(), id: params.oldRefreshId } as RefreshPointerRow;
          const famDoc = refreshFamilies.doc(oldRef.familyId);
          const famSnap = await tx.get(famDoc);
          if (!famSnap.exists) return { status: 'missing' };

          const fam = { ...famSnap.data(), id: famDoc.id } as FamilyRow;
          if (fam.status !== 'active') return { status: 'missing' };

          const upDoc = upstreamGrants.doc(fam.id);
          const upSnap = params.newUpstreamSealed ? await tx.get(upDoc) : null;

          if (oldRef.status === 'consumed') {
            const withinRetry = oldRef.consumedAt !== undefined && params.now - oldRef.consumedAt <= REFRESH_RETRY_WINDOW_MS;
            if (withinRetry && oldRef.successorSealed) {
              return {
                status: 'retry',
                familyId: fam.id,
                generation: fam.generation,
                successorSealed: oldRef.successorSealed,
              };
            }
            // Late replay - read query before writing
            const refQuerySnap = await tx.get(refreshTokens.where('familyId', '==', fam.id));
            await latchIrreversibleInTransaction(tx);
            tx.set(famDoc, familyData({ ...fam, status: 'revoked', revokedAt: params.now, generation: fam.generation + 1, updatedAt: params.now }));
            if (fam.currentAccessTokenId) {
              tx.delete(sessions.doc(fam.currentAccessTokenId));
            }
            for (const doc of refQuerySnap.docs) {
              const data = doc.data() as unknown as RefreshPointerRow;
              tx.set(refreshTokens.doc(doc.id), refreshData({ ...data, status: 'consumed', consumedAt: params.now, successorSealed: undefined }));
            }
            return { status: 'replay', familyId: fam.id };
          }

          // Active rotation path - read older consumed pointers before writing
          const oldPastRef = await tx.get(refreshTokens.where('familyId', '==', fam.id));

          // All reads finished. Now perform all writes.
          await latchIrreversibleInTransaction(tx);
          const nextGen = fam.generation + 1;

          // 1. Consume old refresh
          tx.set(oldRefDoc, refreshData({
            ...oldRef,
            status: 'consumed',
            consumedAt: params.now,
            successorSealed: params.newSuccessorSealed,
          }));

          // Prune older consumed pointers' successorSealed
          for (const doc of oldPastRef.docs) {
            const d = doc.data() as unknown as RefreshPointerRow;
            if (d && d.consumedAt && params.now - d.consumedAt > REFRESH_RETRY_WINDOW_MS && d.successorSealed) {
              tx.set(refreshTokens.doc(doc.id), refreshData({ ...d, successorSealed: undefined }));
            }
          }

          if (params.retiredFingerprint) {
            tx.set(retiredTokens.doc(params.retiredFingerprint), { familyId: fam.id, retiredAt: params.now });
          }

          // 2. Put new refresh
          tx.set(refreshTokens.doc(params.newRefreshRow.id), refreshData({
            ...params.newRefreshRow,
            familyId: fam.id,
            generation: nextGen,
          }));

          // 3. Delete old access doc
          if (fam.currentAccessTokenId) {
            tx.delete(sessions.doc(fam.currentAccessTokenId));
          }

          // 4. Put new access doc
          tx.set(sessions.doc(params.newAccessRow.id), accessData({
            ...params.newAccessRow,
            familyId: fam.id,
          }));

          // 5. Update family
          tx.set(famDoc, familyData({
            ...fam,
            generation: nextGen,
            activeRefreshId: params.newRefreshRow.id,
            currentAccessTokenId: params.newAccessRow.id,
            sealed: params.newFamilySealed,
            updatedAt: params.now,
          }));

          // 6. Update upstream if provided
          if (params.newUpstreamSealed) {
            const currentUp = upSnap && upSnap.exists ? (upSnap.data() as unknown as UpstreamGrantRow) : undefined;
            const nextGrantVersion = (currentUp?.grantVersion ?? 0) + 1;
            tx.set(upDoc, upstreamData({
              id: fam.id,
              grantVersion: nextGrantVersion,
              nsExpiresAt: params.newNsExpiresAt,
              updatedAt: params.now,
              sealed: params.newUpstreamSealed,
            }));
          }

          return {
            status: 'claimed',
            familyId: fam.id,
            generation: nextGen,
          };
        });
      },

      async atomicRevokeFamily(familyId: string, condition?: RevokeCondition): Promise<'revoked' | 'stale' | 'missing'> {
        const famDoc = refreshFamilies.doc(familyId);
        return db.runTransaction(async tx => {
          await assertV3ActiveInTransaction(tx);
          const famSnap = await tx.get(famDoc);
          if (!famSnap.exists) return 'missing';

          const fam = { ...famSnap.data(), id: famDoc.id } as FamilyRow;
          if (fam.status !== 'active') return 'stale';

          if (condition?.expectedFamilyGeneration !== undefined && fam.generation !== condition.expectedFamilyGeneration) {
            return 'stale';
          }

          if (condition?.expectedUpstreamGrantVersion !== undefined) {
            const upSnap = await tx.get(upstreamGrants.doc(familyId));
            if (upSnap.exists && (upSnap.data() as unknown as UpstreamGrantRow).grantVersion !== condition.expectedUpstreamGrantVersion) {
              return 'stale';
            }
          }
          if (condition?.expectedLeaseOwner !== undefined) {
            const upSnap = await tx.get(upstreamGrants.doc(familyId));
            if (upSnap.exists && (upSnap.data() as unknown as UpstreamGrantRow).leaseOwner !== condition.expectedLeaseOwner) {
              return 'stale';
            }
          }

          const refQuerySnap = await tx.get(refreshTokens.where('familyId', '==', familyId));

          // All reads complete. Now writes.
          await latchIrreversibleInTransaction(tx);
          const now = Date.now();
          tx.set(famDoc, familyData({ ...fam, status: 'revoked', revokedAt: now, generation: fam.generation + 1, updatedAt: now }));

          if (fam.currentAccessTokenId) {
            tx.delete(sessions.doc(fam.currentAccessTokenId));
          }
          tx.delete(upstreamGrants.doc(familyId));
          for (const doc of refQuerySnap.docs) {
            const data = doc.data() as unknown as RefreshPointerRow;
            tx.set(refreshTokens.doc(doc.id), refreshData({ ...data, status: 'consumed', consumedAt: now, successorSealed: undefined }));
          }
          return 'revoked';
        });
      },

      async getSession(id: string): Promise<SessionRow | undefined> {
        await assertV3Active();
        const snap = await sessions.doc(id).get();
        if (!snap.exists) return undefined;
        const data = snap.data() as unknown as AccessRow;
        const upSnap = data.familyId ? await upstreamGrants.doc(data.familyId).get() : undefined;
        const upData = upSnap?.exists ? (upSnap.data() as unknown as UpstreamGrantRow) : undefined;
        return {
          id,
          refreshId: data.familyId,
          expiresAt: data.expiresAt,
          retainUntil: data.retainUntil,
          nsExpiresAt: upData?.nsExpiresAt,
          leaseOwner: upData?.leaseOwner,
          leaseUntil: upData?.leaseUntil,
          sealed: data.sealed,
        };
      },
      async findSessionByRefreshId(refreshId: string): Promise<SessionRow | undefined> {
        await assertV3Active();
        const refSnap = await refreshTokens.doc(refreshId).get();
        if (!refSnap.exists) return undefined;
        const refData = refSnap.data() as unknown as RefreshPointerRow;
        const famSnap = await refreshFamilies.doc(refData.familyId).get();
        if (!famSnap.exists) return undefined;
        const famData = famSnap.data() as unknown as FamilyRow;
        const accSnap = await sessions.doc(famData.currentAccessTokenId).get();
        if (!accSnap.exists) return undefined;
        const accData = accSnap.data() as unknown as AccessRow;
        const upSnap = accData.familyId ? await upstreamGrants.doc(accData.familyId).get() : undefined;
        const upData = upSnap?.exists ? (upSnap.data() as unknown as UpstreamGrantRow) : undefined;
        return {
          id: accData.id,
          refreshId: accData.familyId,
          expiresAt: accData.expiresAt,
          retainUntil: accData.retainUntil,
          nsExpiresAt: upData?.nsExpiresAt,
          leaseOwner: upData?.leaseOwner,
          leaseUntil: upData?.leaseUntil,
          sealed: accData.sealed,
        };
      },
      async putSession(row) {
        return db.runTransaction(async tx => {
          await assertV3ActiveInTransaction(tx);
          await latchIrreversibleInTransaction(tx);
          tx.set(sessions.doc(row.id), defined({ ...row, v: 2, ttlAt: new Date(row.retainUntil) }));
        });
      },
      async updateSession(id, mutate) {
        return db.runTransaction(async tx => {
          await assertV3ActiveInTransaction(tx);
          const ref = sessions.doc(id);
          const snap = await tx.get(ref);
          if (!snap.exists) return undefined;
          const data = snap.data() as unknown as AccessRow;
          const upRef = data.familyId ? upstreamGrants.doc(data.familyId) : undefined;
          const upSnap = upRef ? await tx.get(upRef) : undefined;
          const upData = upSnap?.exists ? (upSnap.data() as unknown as UpstreamGrantRow) : undefined;

          const current: SessionRow = {
            id,
            refreshId: data.familyId,
            expiresAt: data.expiresAt,
            retainUntil: data.retainUntil,
            nsExpiresAt: upData?.nsExpiresAt,
            leaseOwner: upData?.leaseOwner,
            leaseUntil: upData?.leaseUntil,
            sealed: data.sealed,
          };

          const next = mutate(current);
          if (next === undefined) return undefined;
          await latchIrreversibleInTransaction(tx);
          if (next === null) {
            tx.delete(ref);
            if (upRef) tx.delete(upRef);
            return undefined;
          }

          if (upRef && upSnap?.exists && (next.leaseOwner !== upData?.leaseOwner || next.leaseUntil !== upData?.leaseUntil || next.nsExpiresAt !== upData?.nsExpiresAt)) {
            tx.set(upRef, upstreamData({
              ...upData!,
              leaseOwner: next.leaseOwner,
              leaseUntil: next.leaseUntil,
              nsExpiresAt: next.nsExpiresAt,
            }));
          }

          tx.set(ref, accessData({
            id,
            familyId: data.familyId,
            expiresAt: next.expiresAt,
            retainUntil: next.retainUntil,
            sealed: next.sealed,
          }));

          return next;
        });
      },
      async deleteSession(id) {
        return db.runTransaction(async tx => {
          await assertV3ActiveInTransaction(tx);
          const snap = await tx.get(sessions.doc(id));
          if (snap.exists) {
            await latchIrreversibleInTransaction(tx);
            tx.delete(sessions.doc(id));
          }
        });
      },

      async putAuthCode(row) {
        return db.runTransaction(async tx => {
          await assertV3ActiveInTransaction(tx);
          await latchIrreversibleInTransaction(tx);
          tx.set(codes.doc(row.id), codeData(row));
        });
      },
      async getAuthCode(id) {
        await assertV3Active();
        const snap = await codes.doc(id).get();
        return snap.exists ? { ...snap.data(), id } as AuthCodeRow : undefined;
      },
      async takeAuthCode(id) {
        const ref = codes.doc(id);
        return db.runTransaction(async tx => {
          await assertV3ActiveInTransaction(tx);
          const snap = await tx.get(ref);
          if (!snap.exists) return undefined;
          await latchIrreversibleInTransaction(tx);
          const current = { ...snap.data(), id } as AuthCodeRow;
          tx.delete(ref);
          return current;
        });
      },
      async atomicRedeemCodeAndIssue(params: AtomicRedeemAndIssueParams): Promise<AuthCodeRow | undefined> {
        return db.runTransaction(async tx => {
          await assertV3ActiveInTransaction(tx);
          const codeRef = codes.doc(params.codeId);
          const codeSnap = await tx.get(codeRef);
          if (!codeSnap.exists) return undefined;
          const current = { ...codeSnap.data(), id: params.codeId } as AuthCodeRow;

          if (current.expiresAt <= params.now) {
            return undefined;
          }
          if (params.expectedSealed && current.sealed !== params.expectedSealed) {
            return undefined;
          }

          await latchIrreversibleInTransaction(tx);
          tx.delete(codeRef);
          tx.set(sessions.doc(params.issue.accessRow.id), accessData(params.issue.accessRow));
          tx.set(refreshTokens.doc(params.issue.refreshRow.id), refreshData(params.issue.refreshRow));
          tx.set(refreshFamilies.doc(params.issue.familyRow.id), familyData(params.issue.familyRow));
          tx.set(upstreamGrants.doc(params.issue.upstreamRow.id), upstreamData(params.issue.upstreamRow));

          return current;
        });
      },
      async insertResumeIfAbsent(row, now) {
        const ref = resumes.doc(row.id);
        return db.runTransaction(async tx => {
          await assertV3ActiveInTransaction(tx);
          const snap = await tx.get(ref);
          if (snap.exists && (snap.data() as unknown as ResumeRow).expiresAt > now) return false;
          await latchIrreversibleInTransaction(tx);
          tx.set(ref, resumeData(row));
          return true;
        });
      },
      async incrementUsage(userHash, toolName, now) {
        const id = `${userHash}__${toolName}`;
        const ref = usage.doc(id);
        for (let attempt = 0; attempt < 15; attempt++) {
          try {
            await db.runTransaction(async tx => {
              await assertV3ActiveInTransaction(tx);
              const snap = await tx.get(ref);
              const current = snap.exists ? (snap.data() as { count: number; lastUsed: number }) : { count: 0, lastUsed: now };
              tx.set(ref, { userHash, toolName, count: current.count + 1, lastUsed: now });
            });
            return;
          } catch (err) {
            if (attempt === 14) throw err;
            await new Promise(r => setTimeout(r, 15 + Math.random() * 40 * (attempt + 1)));
          }
        }
      },
      async listUsage(userHash) {
        const snap = await usage.where('userHash', '==', userHash).get();
        return snap.docs.map(doc => {
          const data = doc.data() as { toolName: string; count: number; lastUsed: number };
          return { toolName: data.toolName, count: data.count, lastUsed: data.lastUsed };
        });
      },
      async getClient(id) {
        await assertV3Active();
        const snap = await clients.doc(id).get();
        return snap.exists ? snap.data() as OAuthClientInformationFull : undefined;
      },
      async putClient(client) {
        return db.runTransaction(async tx => {
          await assertV3ActiveInTransaction(tx);
          await latchIrreversibleInTransaction(tx);
          tx.set(clients.doc(client.client_id), defined(client));
        });
      },
      async sweep(now) {
        return db.runTransaction(async tx => {
          await assertV3ActiveInTransaction(tx);
          const snap = await tx.get(refreshTokens.where('status', '==', 'consumed'));
          let count = 0;
          const toUpdate: any[] = [];
          for (const doc of snap.docs) {
            const data = doc.data() as unknown as RefreshPointerRow;
            if (data && typeof data.consumedAt === 'number' && now - data.consumedAt > REFRESH_RETRY_WINDOW_MS && data.successorSealed) {
              toUpdate.push(doc.id);
            }
          }
          if (toUpdate.length > 0) {
            await latchIrreversibleInTransaction(tx);
            for (const id of toUpdate) {
              const d = snap.docs.find((doc: any) => doc.id === id)!.data() as unknown as RefreshPointerRow;
              tx.set(refreshTokens.doc(id), defined({ ...d, successorSealed: undefined }));
              count++;
            }
          }
          return count;
        });
      },
      async close() { },
    };

    Object.assign(this, backend);
  }
}

export function createFirestoreBackend(options: { db: FirestoreLike; namespace: string; key?: Uint8Array }): FirestoreBackend {
  return new FirestoreBackend(options);
}

export function createFirestoreStore(options: { db: FirestoreLike; namespace: string; key: Uint8Array }): McpStore {
  return createStore(createFirestoreBackend(options), { namespace: options.namespace, key: options.key });
}
export {
  adoptFirestoreLegacyTokens,
  computeSourceInventoryDigest,
  ensureFirestoreAdopted,
  type FirestoreAdoptionReport,
  type MigrationManifest,
  type CutoverFenceControlRecord,
  type CutoverFenceState,
  getCutoverFenceRecord,
  initializeCutoverFence,
  transitionCutoverFenceState,
  markIrreversibleInTransaction,
  withLegacyOperation,
  releaseLegacyOperation,
  markOperationAmbiguous,
  checkMutationGuardInTransaction,
  isLegacyMutationPermittedInTransaction,
  CutoverFenceError,
  CutoverRefusedError,
} from './firestore-v2-adoption.js';
