import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Firestore, Transaction } from '@google-cloud/firestore';
import { CutoverFenceError, UpstreamUnavailableError, kitCodeOf } from './errors.js';
import { FirestoreTokenLedger, docId, type FirestoreTokenLedgerOptions } from './firestore-ledger.js';
import { FirestoreUpstreamGrantStore, RefreshSupersededError, type EnsureFreshOptions, type StoredUpstreamRecord } from './upstream-grant.js';
import { MAX_RETIRED_REFRESH_FINGERPRINTS, refreshFingerprint, type BaseStoredToken, type StoredRefreshFamily, type StoredRefreshRecord } from './ledger.js';
import { canonicalJsonStringify, checkMutationGuardInTransaction, claimUpstreamGrantInTransaction, getCutoverFenceDocRef, getCutoverOperationDocRef, operationStorageId, readCutoverFenceInTransaction, requireFenceIdentityKey, startMonotonicTimer, type CutoverFenceConfig, type LegacyOperationContext, type PendingClaim } from './cutover-fence.js';
import { stripUndefined } from './strip-undefined.js';

declare const completionBrand: unique symbol;
export type UpstreamCompletionReceipt = Readonly<{ [completionBrand]: true }>;
export type CompletionTarget =
  | { kind: 'rotate'; refreshToken: string; clientId: string }
  | { kind: 'access_update'; accessToken: string }
  | { kind: 'grant_only' };
export type EnsureFreshResult<G> = { grant: G; completion: UpstreamCompletionReceipt | null };

/** Construction and the supplied transport and mapping are privileged application setup. */
export function createBoundFencedRuntime<G, T extends BaseStoredToken>(options: {
  db: Firestore;
  fence: CutoverFenceConfig;
  ledger: Omit<FirestoreTokenLedgerOptions<T>, 'db' | 'fence' | 'mapCommittedGrant'>;
  refresh: (grant: G) => Promise<{ grant: G; expiresAt?: number }>;
  validateGrant: (grant: unknown) => G;
  applyGrant: (token: T, grant: G) => T;
  now?: () => number;
}) {
  const { db, refresh, validateGrant, applyGrant } = options;
  if (!options.fence.enforce) throw new CutoverFenceError('Bound runtime requires an enforced fence');
  const key = Uint8Array.from(requireFenceIdentityKey(options.fence));
  const fence = { ...options.fence, identityKey: key };
  const namespace = fence.namespace;
  const now = options.now ?? Date.now;
  const accessDocExtras = options.ledger.accessDocExtras;
  const collection = `${namespace}_tokens`;
  if (options.ledger.collection !== collection ||
      (options.ledger.refreshCollection && options.ledger.refreshCollection !== `${collection}_refresh`) ||
      (options.ledger.familyCollection && options.ledger.familyCollection !== `${collection}_refresh_families`)) {
    throw new CutoverFenceError('Bound runtime requires canonical token collections');
  }
  const baseLedger = new FirestoreTokenLedger<T>({ ...options.ledger, db, fence, mapCommittedGrant: (token, grant) => applyGrant(token, validateGrant(grant)) });
  const baseGrant = new FirestoreUpstreamGrantStore<G>({ db, collection: `${collection}_upstream`, fence, now });
  const familyRef = (id: string) => db.collection(`${collection}_refresh_families`).doc(docId(id));
  const grantRef = (id: string) => db.collection(`${collection}_upstream`).doc(docId(id));
  const refreshRef = (id: string) => db.collection(`${collection}_refresh`).doc(docId(id));
  const accessRef = (id: string) => db.collection(collection).doc(docId(id));
  type Entry = { claim: PendingClaim; operation: LegacyOperationContext; target: CompletionTarget; encoded: string; expiresAt?: number; reserved: boolean; consumed: boolean };
  const receipts = new WeakMap<object, Entry>();
  function track<R>(operation: LegacyOperationContext | undefined, work: () => Promise<R>): Promise<R> {
    return operation?.trackWriter ? operation.trackWriter(work) : work();
  }

  function snapshot<V>(value: V): V { return structuredClone(value); }
  function noHeld(record: StoredUpstreamRecord<G>, currentNow: number) {
    if (record.ambiguousOutcome || record.ambiguousRemoteOutcome) {
      throw new UpstreamUnavailableError('Upstream grant has an unresolved ambiguous outcome');
    }
    if (record.leaseOwner && (!record.leaseUntil || record.leaseUntil <= currentNow)) {
      throw new UpstreamUnavailableError('Upstream grant has an unresolved expired lease');
    }
    if (record.operationId != null || record.ambiguousOperationId != null || record.leaseOwner != null ||
        record.leaseUntil != null || record.leaseExpiresAt != null) {
      throw new UpstreamUnavailableError('Upstream grant has an unresolved claim');
    }
  }
  function validateTarget(target: CompletionTarget) {
    if (!target || !['rotate', 'access_update', 'grant_only'].includes(target.kind) ||
        (target.kind === 'rotate' && (!target.refreshToken || !target.clientId)) ||
        (target.kind === 'access_update' && !target.accessToken)) throw new CutoverFenceError('Invalid completion target');
  }
  async function assertTarget(tx: Transaction, family: StoredRefreshFamily, target: CompletionTarget) {
    const pointerSnap = await tx.get(refreshRef(family.currentRefreshToken));
    const pointer = pointerSnap.data() as StoredRefreshRecord<T> | undefined;
    if (!pointer || pointer.status !== 'active' || pointer.familyId !== family.id) throw new CutoverFenceError('Active refresh pointer changed');
    if (target.kind === 'rotate' && (family.currentRefreshToken !== target.refreshToken || pointer.token.clientId !== target.clientId)) {
      throw new RefreshSupersededError('Refresh token changed before upstream claim');
    }
    if (target.kind === 'access_update') {
      if (family.currentAccessToken !== target.accessToken) throw new RefreshSupersededError('Access token changed before upstream claim');
      const access = await tx.get(accessRef(target.accessToken));
      if (!access.exists || (access.data() as T).refreshFamilyId !== family.id) throw new RefreshSupersededError('Access token changed before upstream claim');
    }
    return pointer;
  }
  async function readPending(tx: Transaction, entry: Entry) {
    const { claim, operation } = entry;
    const timer = startMonotonicTimer();
    const control = await readCutoverFenceInTransaction(tx, db, namespace);
    const opRef = getCutoverOperationDocRef(db, namespace, operation.id, key);
    const opSnap = await tx.get(opRef);
    const grantSnap = await tx.get(grantRef(claim.familyId));
    const familySnap = await tx.get(familyRef(claim.familyId));
    const op = opSnap.data();
    const grant = grantSnap.data() as (StoredUpstreamRecord<G> & { stagedGrant?: { grant: G; encoded: string; expiresAt?: number } }) | undefined;
    const family = familySnap.data() as StoredRefreshFamily | undefined;
    if (['fenced', 'migrating', 'v3_ready', 'v3_active'].includes(control.state) || control.epoch !== operation.epoch ||
        control.operationIdentityVersion !== 1 || control.operationIdentityKeyCheck !== operation.identityKeyCheck ||
        operation.namespace !== namespace || operation.storageId !== operationStorageId(namespace, operation.id, key) ||
        operation.storageId !== claim.storageId || operation.id !== claim.operationId || operation.isCompleted() ||
        !op || op.schemaVersion !== 1 || op.operationIdentityVersion !== 1 || op.id !== claim.storageId ||
        op.operationId !== claim.storageId || op.namespace !== namespace || op.epoch !== operation.epoch ||
        op.kind !== operation.kind || op.phase !== 'upstream_pending' || op.familyId !== claim.familyId || op.ambiguousRemoteOutcome === true ||
        !grant || grant.operationId !== claim.storageId || grant.ambiguousOperationId !== claim.storageId ||
        grant.leaseOwner !== claim.ownerStorageId || grant.familyGeneration !== claim.familyGeneration ||
        grant.grantVersion !== claim.grantVersion || grant.leaseUntil !== claim.leaseExpiresAt ||
        grant.leaseExpiresAt !== claim.leaseExpiresAt || grant.ambiguousOutcome || grant.ambiguousRemoteOutcome ||
        !family || family.id !== claim.familyId || (family.generation ?? 1) !== claim.familyGeneration) {
      throw new CutoverFenceError('Pending upstream claim changed');
    }
    const pointer = await assertTarget(tx, family, entry.target);
    timer.assertUnderDeadline('bound pending reads');
    return { timer, control, opRef, grant, family, pointer };
  }
  async function holdAmbiguous(claim: PendingClaim, operation: LegacyOperationContext, reason: 'upstream_timeout' | 'upstream_transport_error' | 'upstream_untrusted_definitive' | 'local_commit_failure') {
    operation.markAmbiguousRemoteOutcome(reason);
    await db.runTransaction(async tx => {
      const timer = startMonotonicTimer();
      const control = await readCutoverFenceInTransaction(tx, db, namespace);
      const opRef = getCutoverOperationDocRef(db, namespace, operation.id, key);
      const opSnap = await tx.get(opRef);
      const grantSnap = await tx.get(grantRef(claim.familyId));
      const op = opSnap.data();
      const grant = grantSnap.data() as StoredUpstreamRecord<G> | undefined;
      if ((control.state !== 'legacy_open' && control.state !== 'closing') ||
          control.epoch !== operation.epoch || control.operationIdentityVersion !== 1 ||
          control.operationIdentityKeyCheck !== operation.identityKeyCheck ||
          operation.namespace !== namespace || operation.storageId !== operationStorageId(namespace, operation.id, key) ||
          operation.id !== claim.operationId || operation.storageId !== claim.storageId ||
          !op || op.schemaVersion !== 1 || op.operationIdentityVersion !== 1 ||
          op.id !== claim.storageId || op.operationId !== claim.storageId || op.namespace !== namespace ||
          op.kind !== operation.kind || op.epoch !== operation.epoch || op.phase !== 'upstream_pending' ||
          op.familyId !== claim.familyId || !grant || grant.operationId !== claim.storageId ||
          grant.ambiguousOperationId !== claim.storageId || grant.leaseOwner !== claim.ownerStorageId ||
          grant.familyGeneration !== claim.familyGeneration || grant.grantVersion !== claim.grantVersion ||
          grant.leaseUntil !== claim.leaseExpiresAt || grant.leaseExpiresAt !== claim.leaseExpiresAt) {
        throw new CutoverFenceError('Pending upstream claim changed before ambiguity could be recorded');
      }
      timer.assertUnderDeadline('bound ambiguity before write');
      tx.update(grantRef(claim.familyId), { ambiguousOutcome: true, ambiguousReason: reason, ambiguousAt: now() });
      timer.assertUnderDeadline('bound ambiguity before return');
    });
  }
  async function ensureFreshImpl(familyId: string, opts: EnsureFreshOptions & { operation: LegacyOperationContext; target: CompletionTarget }): Promise<EnsureFreshResult<G>> {
    if (typeof opts === 'function' || !opts || !opts.operation) throw new CutoverFenceError('Bound refresh requires options and a durable operation');
    validateTarget(opts.target);
    if (!familyId || docId(familyId) !== familyId) throw new CutoverFenceError('Invalid family id');
    const target = snapshot(opts.target);
    const operation = opts.operation;
    const claimOwner = randomUUID();
    const waitMs = opts.waitMs ?? 10_000;
    const pollIntervalMs = opts.pollIntervalMs ?? 100;
    if (!Number.isFinite(waitMs) || waitMs < 0 || !Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
      throw new CutoverFenceError('Invalid upstream wait or poll interval');
    }
    const inspect = (afterWaiting: boolean, previousUpdatedAt?: number) => db.runTransaction(async tx => {
      const timer = startMonotonicTimer();
      await checkMutationGuardInTransaction(tx, { db, namespace, operation, identityKey: key, timer, completeOperation: false });
      const [grantSnap, familySnap] = await Promise.all([tx.get(grantRef(familyId)), tx.get(familyRef(familyId))]);
      const current = grantSnap.data() as StoredUpstreamRecord<G> | undefined;
      const family = familySnap.data() as StoredRefreshFamily | undefined;
      if (!current || !family || family.id !== familyId) throw new CutoverFenceError('Upstream grant or family missing');
      const currentNow = afterWaiting ? now() : opts.now ?? now();
      await assertTarget(tx, family, target);
      if (current.ambiguousOutcome || current.ambiguousRemoteOutcome) {
        throw new UpstreamUnavailableError('Upstream grant has an unresolved ambiguous outcome');
      }
      if (current.leaseOwner && current.leaseUntil && current.leaseUntil > currentNow) {
        if (typeof current.operationId !== 'string' || !current.operationId ||
            current.ambiguousOperationId !== current.operationId || current.leaseExpiresAt !== current.leaseUntil ||
            !Number.isSafeInteger(current.leaseUntil) || !Number.isSafeInteger(current.grantVersion) ||
            !Number.isSafeInteger(current.familyGeneration) || current.familyGeneration !== (family.generation ?? 1)) {
          throw new UpstreamUnavailableError('Upstream grant has an unresolved lease binding');
        }
        timer.assertUnderDeadline('bound peer lease');
        return { status: 'leased' as const, updatedAt: current.updatedAt ?? 0 };
      }
      noHeld(current, currentNow);
      if (afterWaiting) {
        if ((current.updatedAt ?? 0) <= (previousUpdatedAt ?? 0)) {
          throw new UpstreamUnavailableError('Upstream refresh ended without a replacement grant');
        }
        timer.assertUnderDeadline('bound peer completion');
        return { status: 'fresh' as const, grant: current.grant };
      }
      if (!opts.force && current.expiresAt && current.expiresAt - (opts.skewMs ?? 300_000) > currentNow) {
        timer.assertUnderDeadline('bound fresh grant');
        return { status: 'fresh' as const, grant: current.grant };
      }
      const claim = await claimUpstreamGrantInTransaction(tx, db, {
        namespace, epoch: operation.epoch, familyId, operationId: operation.id, identityKey: key,
        claimOwner, expectedKind: operation.kind, expectedFamilyGeneration: opts.expectedFamilyGeneration ?? family.generation ?? 1,
        expectedGrantVersion: opts.expectedGrantVersion ?? current.grantVersion ?? current.version ?? 1,
        leaseMs: opts.leaseMs ?? 30_000, nowProvider: now, timer,
      });
      return { status: 'claimed' as const, grant: current.grant, claim };
    });
    let result = await inspect(false);
    if (result.status === 'leased') {
      const previousUpdatedAt = result.updatedAt;
      const deadline = performance.now() + waitMs;
      while (result.status === 'leased' && performance.now() < deadline) {
        await sleep(Math.min(pollIntervalMs, 2_147_483_647, Math.max(1, deadline - performance.now())));
        result = await inspect(true, previousUpdatedAt);
      }
      if (result.status === 'leased') throw new UpstreamUnavailableError('Timed out waiting for upstream token refresh');
    }
    if (result.status === 'fresh') return { grant: result.grant, completion: null };
    operation.markAmbiguousRemoteOutcome('remote_grant_in_flight');
    let returned: { grant: G; expiresAt?: number };
    try {
      returned = await refresh(snapshot(result.grant));
      if (!returned || (returned.expiresAt !== undefined && (!Number.isFinite(returned.expiresAt) || returned.expiresAt <= 0))) throw new Error('Invalid provider expiry');
      returned = { grant: validateGrant(returned.grant), expiresAt: returned.expiresAt };
    } catch (cause) {
      const reason = kitCodeOf(cause) === 'upstream_revoked'
        ? 'upstream_untrusted_definitive'
        : cause instanceof Error && /timeout|timed out|econnreset|econnrefused|408|504/i.test(`${cause.name} ${cause.message} ${'code' in cause && typeof cause.code === 'string' ? cause.code : ''}`)
          ? 'upstream_timeout'
          : 'upstream_transport_error';
      try {
        await holdAmbiguous(result.claim, operation, reason);
      } catch (markError) {
        throw new UpstreamUnavailableError('Upstream grant outcome is unresolved; ambiguity could not be recorded', { cause: markError });
      }
      throw new UpstreamUnavailableError('Upstream grant outcome is unresolved', { cause });
    }
    try {
      const stagedGrant = stripUndefined(snapshot(returned.grant));
      const encoded = canonicalJsonStringify(stagedGrant);
      const returnedGrant = snapshot(stagedGrant);
      const entry: Entry = { claim: result.claim, operation, target, encoded, expiresAt: returned.expiresAt, reserved: false, consumed: false };
      await db.runTransaction(async tx => {
        const { timer, grant } = await readPending(tx, entry);
        if (grant.stagedGrant != null) throw new CutoverFenceError('A staged grant already exists');
        timer.assertUnderDeadline('bound staging before write');
        tx.update(grantRef(familyId), { stagedGrant: stripUndefined({ grant: stagedGrant, encoded, expiresAt: returned.expiresAt }) });
        timer.assertUnderDeadline('bound staging before return');
      });
      const receipt = Object.freeze({}) as UpstreamCompletionReceipt;
      receipts.set(receipt, entry);
      return { grant: returnedGrant, completion: receipt };
    } catch (cause) {
      try {
        await holdAmbiguous(result.claim, operation, 'local_commit_failure');
      } catch (markError) {
        throw new UpstreamUnavailableError('Upstream grant staging is unresolved; ambiguity could not be recorded', { cause: markError });
      }
      throw new UpstreamUnavailableError('Upstream grant staging outcome is unresolved', { cause });
    }
  }
  async function ensureFresh(familyId: string, opts: EnsureFreshOptions & { operation: LegacyOperationContext; target: CompletionTarget }): Promise<EnsureFreshResult<G>> {
    if (typeof opts === 'function' || !opts || !opts.operation) throw new CutoverFenceError('Bound refresh requires options and a durable operation');
    const stableOptions = { ...opts, target: snapshot(opts.target) };
    return track(opts.operation, () => ensureFreshImpl(familyId, stableOptions));
  }

  async function finalizeImpl(receipt: UpstreamCompletionReceipt, operation: LegacyOperationContext, replacement?: T) {
    const entry = receipt && typeof receipt === 'object' ? receipts.get(receipt) : undefined;
    if (!entry || entry.operation !== operation || entry.reserved || entry.consumed) throw new CutoverFenceError('Invalid or consumed upstream receipt');
    const replacementSnapshot = replacement === undefined ? undefined : snapshot(replacement);
    entry.reserved = true;
    try {
      const result = await db.runTransaction(async tx => {
        const { timer, control, opRef, grant, family, pointer } = await readPending(tx, entry);
        if (grant.stagedGrant?.encoded !== entry.encoded || canonicalJsonStringify(grant.stagedGrant.grant) !== entry.encoded || grant.stagedGrant?.expiresAt !== entry.expiresAt || control.activeOperations <= 0) {
          throw new CutoverFenceError('Staged grant or operation count changed');
        }
        const staged = snapshot(grant.stagedGrant!.grant);
        let output: T | G = staged;
        let oldRecord: StoredRefreshRecord<T> | undefined;
        if (entry.target.kind === 'rotate') {
          if (!replacementSnapshot || replacementSnapshot.clientId !== entry.target.clientId || !replacementSnapshot.accessToken || !replacementSnapshot.refreshToken ||
              docId(replacementSnapshot.accessToken) === docId(family.currentAccessToken) ||
              docId(replacementSnapshot.refreshToken) === docId(family.currentRefreshToken)) throw new CutoverFenceError('Rotation replacement does not match target');
          const [oldSnap, nextAccess, nextRefresh] = await Promise.all([
            tx.get(refreshRef(entry.target.refreshToken)), tx.get(accessRef(replacementSnapshot.accessToken)), tx.get(refreshRef(replacementSnapshot.refreshToken)),
          ]);
          oldRecord = oldSnap.data() as StoredRefreshRecord<T> | undefined;
          if (!oldRecord || oldRecord.status !== 'active' || oldRecord.familyId !== family.id || oldRecord.token.clientId !== entry.target.clientId || nextAccess.exists || nextRefresh.exists) throw new CutoverFenceError('Rotation target changed');
          const mapped = applyGrant(snapshot(replacementSnapshot), snapshot(staged));
          if (mapped.clientId !== replacementSnapshot.clientId || mapped.accessToken !== replacementSnapshot.accessToken || mapped.refreshToken !== replacementSnapshot.refreshToken) throw new CutoverFenceError('Grant mapping changed token identity');
          output = { ...mapped, refreshFamilyId: family.id };
        } else if (entry.target.kind === 'access_update') {
          const access = await tx.get(accessRef(entry.target.accessToken));
          if (!access.exists) throw new CutoverFenceError('Access target disappeared');
          const current = access.data() as T;
          if (!pointer.token || pointer.token.accessToken !== current.accessToken ||
              pointer.token.refreshToken !== current.refreshToken || pointer.token.clientId !== current.clientId ||
              current.refreshToken !== family.currentRefreshToken) throw new CutoverFenceError('Access and refresh records do not match');
          const mapped = applyGrant({ ...current }, snapshot(staged));
          if (mapped.accessToken !== current.accessToken || mapped.refreshToken !== current.refreshToken || mapped.clientId !== current.clientId || mapped.refreshFamilyId !== current.refreshFamilyId) throw new CutoverFenceError('Grant mapping changed token identity');
          output = mapped;
        }
        const stamp = now();
        timer.assertUnderDeadline('bound completion before write');
        if (entry.target.kind === 'rotate') {
          const stored = output as T;
          const retired = [...(family.retiredRefreshFingerprints ?? [])];
          if (family.previousRefreshToken) { retired.push(refreshFingerprint(family.previousRefreshToken)); tx.delete(refreshRef(family.previousRefreshToken)); }
          if (family.previousAccessToken) tx.delete(accessRef(family.previousAccessToken));
          tx.delete(accessRef(oldRecord!.token.accessToken));
          tx.set(refreshRef(entry.target.refreshToken), stripUndefined({ ...oldRecord, status: 'consumed', successorRefreshToken: stored.refreshToken, consumedAt: stamp }));
          tx.set(accessRef(stored.accessToken), stripUndefined({ ...stored, ...(accessDocExtras?.(stored) ?? {}) }));
          tx.set(refreshRef(stored.refreshToken), stripUndefined({ status: 'active', familyId: family.id, token: stored }));
          tx.set(familyRef(family.id), stripUndefined({ ...family, generation: (family.generation ?? 1) + 1, currentAccessToken: stored.accessToken, currentRefreshToken: stored.refreshToken, previousAccessToken: oldRecord!.token.accessToken, previousRefreshToken: entry.target.refreshToken, retiredRefreshFingerprints: [...new Set(retired.slice(-MAX_RETIRED_REFRESH_FINGERPRINTS))], updatedAt: stamp }));
        } else if (entry.target.kind === 'access_update') {
          const stored = output as T;
          tx.set(accessRef(entry.target.accessToken), stripUndefined({ ...stored, ...(accessDocExtras?.(stored) ?? {}) }));
          tx.set(refreshRef(family.currentRefreshToken), stripUndefined({ ...pointer, token: output as T }));
        }
        tx.update(grantRef(family.id), stripUndefined({ grant: staged, grantVersion: claimNextVersion(grant, staged), expiresAt: entry.expiresAt ?? null, stagedGrant: null, leaseUntil: null, leaseExpiresAt: null, leaseOwner: null, ambiguousOutcome: null, ambiguousReason: null, ambiguousAt: null, ambiguousOperationId: null, operationId: null, updatedAt: Math.max(stamp, (grant.updatedAt ?? 0) + 1) }));
        tx.set(opRef, { phase: 'completed', ambiguousRemoteOutcome: false, updatedAt: stamp }, { merge: true });
        tx.set(getCutoverFenceDocRef(db, namespace), { activeOperations: control.activeOperations - 1, updatedAt: stamp }, { merge: true });
        timer.assertUnderDeadline('bound completion before return');
        return output;
      });
      entry.consumed = true;
      operation.markCompleted();
      operation.clearAmbiguousRemoteOutcome();
      return result;
    } finally { entry.reserved = false; }
  }
  function finalize(receipt: UpstreamCompletionReceipt, operation: LegacyOperationContext, replacement?: T) {
    const stableReplacement = replacement === undefined ? undefined : snapshot(replacement);
    return track(operation, () => finalizeImpl(receipt, operation, stableReplacement));
  }
  function claimNextVersion(record: StoredUpstreamRecord<G>, grant: G) {
    const version = record.grantVersion ?? record.version ?? 1;
    const next = version + (canonicalJsonStringify(stripUndefined(record.grant)) === canonicalJsonStringify(stripUndefined(grant)) ? 0 : 1);
    if (!Number.isSafeInteger(next) || next < 1) throw new CutoverFenceError('Invalid grant version');
    return next;
  }
  return {
    grants: {
      put: (familyId: string, grant: G, expiresAt?: number, opts?: { operation?: LegacyOperationContext; completeOperation?: boolean }) => {
        const stableGrant = snapshot(grant);
        return track(opts?.operation, () => baseGrant.put(familyId, stableGrant, expiresAt, opts));
      },
      get: baseGrant.get.bind(baseGrant),
      delete: (familyId: string, opts?: { operation?: LegacyOperationContext }) =>
        track(opts?.operation, () => baseGrant.delete(familyId, opts)),
      ensureFresh,
      finalizeGrant: async (receipt: UpstreamCompletionReceipt, operation: LegacyOperationContext) => {
        const entry = receipts.get(receipt);
        if (!entry || entry.target.kind !== 'grant_only') throw new CutoverFenceError('Receipt target is not grant-only');
        return await finalize(receipt, operation) as G;
      },
      finalizeAccess: async (receipt: UpstreamCompletionReceipt, operation: LegacyOperationContext) => {
        const entry = receipts.get(receipt);
        if (!entry || entry.target.kind !== 'access_update') throw new CutoverFenceError('Receipt target is not access update');
        return await finalize(receipt, operation) as T;
      } },
    ledger: {
      issue: baseLedger.issue.bind(baseLedger),
      getByAccessToken: (token: string, opts?: { operation?: LegacyOperationContext }) =>
        track(opts?.operation, () => baseLedger.getByAccessToken(token, opts)),
      lookupRefresh: (token: string, clientId?: string, at?: number, opts?: { operation?: LegacyOperationContext }) =>
        track(opts?.operation, () => baseLedger.lookupRefresh(token, clientId, at, opts)),
      revokeFamily: (familyId: string, opts?: { operation?: LegacyOperationContext }) =>
        track(opts?.operation, () => baseLedger.revokeFamily(familyId, opts)),
      revokeByToken: (token: string, opts?: { operation?: LegacyOperationContext }) =>
        track(opts?.operation, () => baseLedger.revokeByToken(token, opts)),
      rotate: async (oldRefreshToken: string, replacement: T, clientId: string, at?: number, opts?: { operation?: LegacyOperationContext; completeOperation?: boolean; upstreamCompletion?: UpstreamCompletionReceipt | null }) => {
        const stableReplacement = snapshot(replacement);
        if (!opts?.upstreamCompletion) return track(opts?.operation, () => baseLedger.rotate(oldRefreshToken, stableReplacement, clientId, at, opts));
        const entry = receipts.get(opts.upstreamCompletion);
        if (!entry || entry.target.kind !== 'rotate' || entry.target.refreshToken !== oldRefreshToken || entry.target.clientId !== clientId || !opts.operation) throw new CutoverFenceError('Receipt does not match rotation');
        return { status: 'claimed' as const, token: await finalize(opts.upstreamCompletion, opts.operation, stableReplacement) as T };
      } },
  };
}
