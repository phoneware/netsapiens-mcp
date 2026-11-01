// Copied from @phoneware/mcp-oauth-kit 1.0.0 (phoneware/monorepo packages/mcp-oauth-kit/src/firestore-ledger.ts at 8447d361111612739343ee0fb83a15c328db372d). Edit the canonical file, then re-copy.
import { randomUUID } from 'node:crypto';
import type {
  CollectionReference,
  DocumentReference,
  Firestore,
  Transaction,
} from '@google-cloud/firestore';
import {
  DEFAULT_ACCESS_TOKEN_TTL_MS,
  MAX_RETIRED_REFRESH_FINGERPRINTS,
  REFRESH_RETRY_WINDOW_MS,
  refreshFingerprint,
  type BaseStoredToken,
  type RefreshLookupResult,
  type RefreshRotationResult,
  type StoredRefreshFamily,
  type StoredRefreshRecord,
  type TokenLedger,
} from './ledger.js';
import { StoreUnavailableError, kitCodeOf } from './errors.js';
import { stripUndefined } from './strip-undefined.js';

export function docId(raw: string): string {
  return raw.replace(/[\/.]/g, '_');
}

export interface FirestoreTokenLedgerOptions<T extends BaseStoredToken> {
  db: Firestore;
  collection: string;
  refreshCollection?: string;
  familyCollection?: string;
  linkedFamilyCollections?: string[];
  accessDocExtras?: (token: T) => Record<string, unknown>;
  legacy?: {
    pointerDocs?: boolean;
    embeddedRefreshQuery?: boolean;
    toToken?: (raw: Record<string, unknown>) => T;
    toUpstream?: (raw: Record<string, unknown>) => Record<string, unknown> | undefined;
    upstreamCollection?: string;
  };
  now?: () => number;
}

type LegacyRefreshPointer = { accessToken: string };

export class FirestoreTokenLedger<T extends BaseStoredToken> implements TokenLedger<T> {
  private readonly db: Firestore;
  private readonly collection: string;
  private readonly refreshCollection: string;
  private readonly familyCollection: string;
  private readonly linkedFamilyCollections: string[];
  private readonly accessDocExtras?: (token: T) => Record<string, unknown>;
  private readonly legacy?: FirestoreTokenLedgerOptions<T>['legacy'];
  private readonly nowProvider: () => number;

  constructor(opts: FirestoreTokenLedgerOptions<T>) {
    this.db = opts.db;
    this.collection = opts.collection;
    this.refreshCollection = opts.refreshCollection ?? `${this.collection}_refresh`;
    this.familyCollection = opts.familyCollection ?? `${this.collection}_refresh_families`;
    this.linkedFamilyCollections = opts.linkedFamilyCollections ?? [];
    this.accessDocExtras = opts.accessDocExtras;
    this.legacy = opts.legacy;
    this.nowProvider = opts.now ?? Date.now;
  }

  private wrapError(err: unknown): never {
    if (kitCodeOf(err)) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new StoreUnavailableError(message, { cause: err });
  }

  private accessCol(): CollectionReference {
    return this.db.collection(this.collection);
  }

  private refreshCol(): CollectionReference {
    return this.db.collection(this.refreshCollection);
  }

  private familyCol(): CollectionReference {
    return this.db.collection(this.familyCollection);
  }

  async issue(token: T): Promise<T> {
    try {
      const familyId = token.refreshFamilyId ?? randomUUID();
      const stored: T = { ...token, refreshFamilyId: familyId };
      const extras = this.accessDocExtras ? this.accessDocExtras(stored) : {};
      const accessPayload = stripUndefined({ ...stored, ...extras });

      const batch = this.db.batch();
      batch.set(this.accessCol().doc(docId(stored.accessToken)), accessPayload);
      batch.set(
        this.refreshCol().doc(docId(stored.refreshToken)),
        stripUndefined({
          status: 'active',
          familyId,
          token: stored,
        }),
      );
      batch.set(
        this.familyCol().doc(docId(familyId)),
        stripUndefined({
          id: familyId,
          currentAccessToken: stored.accessToken,
          currentRefreshToken: stored.refreshToken,
          retiredRefreshFingerprints: [],
          updatedAt: this.nowProvider(),
        }),
      );

      await batch.commit();
      return stored;
    } catch (err) {
      this.wrapError(err);
    }
  }

  async getByAccessToken(accessToken: string): Promise<T | undefined> {
    try {
      const snap = await this.accessCol().doc(docId(accessToken)).get();
      if (!snap.exists) return undefined;
      const data = snap.data() as Record<string, unknown>;

      if (!data.refreshFamilyId && (this.legacy?.embeddedRefreshQuery || this.legacy?.pointerDocs)) {
        return await this.adoptLegacyEmbeddedDoc(data);
      }

      return data as unknown as T;
    } catch (err) {
      this.wrapError(err);
    }
  }

  async getByRefreshToken(refreshToken: string): Promise<T | undefined> {
    try {
      const res = await this.lookupRefresh(refreshToken);
      if (res.status === 'active' || res.status === 'retry') {
        return res.token;
      }
      return undefined;
    } catch (err) {
      this.wrapError(err);
    }
  }

  async lookupRefresh(
    refreshToken: string,
    expectedClientId?: string,
    now: number = this.nowProvider(),
  ): Promise<RefreshLookupResult<T>> {
    try {
      const refreshRef = this.refreshCol().doc(docId(refreshToken));
      const snap = await refreshRef.get();

      if (!snap.exists) {
        // Check for legacy embedded doc if enabled
        if (this.legacy?.embeddedRefreshQuery) {
          const legacyMatch = await this.accessCol()
            .where('refreshToken', '==', refreshToken)
            .limit(1)
            .get();
          if (!legacyMatch.empty) {
            const rawDoc = legacyMatch.docs[0]!.data() as Record<string, unknown>;
            if (!rawDoc.refreshFamilyId) {
              const adopted = await this.adoptLegacyEmbeddedDoc(rawDoc);
              if (adopted) {
                if (expectedClientId && adopted.clientId !== expectedClientId) {
                  return { status: 'missing' };
                }
                return {
                  status: 'active',
                  token: adopted,
                  familyId: adopted.refreshFamilyId!,
                };
              }
            }
          }
        }

        const retiredMatch = await this.findFamilyByRetiredFingerprint(refreshToken);
        if (retiredMatch) {
          await this.revokeFamily(retiredMatch);
          return { status: 'replay', familyId: retiredMatch };
        }
        return { status: 'missing' };
      }

      const raw = snap.data() as StoredRefreshRecord<T> | LegacyRefreshPointer;

      if (!('status' in raw)) {
        // Legacy pointer doc
        const legacyAccessSnap = await this.accessCol().doc(docId(raw.accessToken)).get();
        if (!legacyAccessSnap.exists) return { status: 'missing' };
        const adopted = await this.adoptLegacyEmbeddedDoc(
          legacyAccessSnap.data() as Record<string, unknown>,
        );
        if (!adopted) return { status: 'missing' };
        if (expectedClientId && adopted.clientId !== expectedClientId) {
          return { status: 'missing' };
        }
        return { status: 'active', token: adopted, familyId: adopted.refreshFamilyId! };
      }

      if (expectedClientId && raw.token.clientId !== expectedClientId) {
        return { status: 'missing' };
      }

      const familySnap = await this.familyCol().doc(docId(raw.familyId)).get();
      const family = familySnap.exists
        ? (familySnap.data() as StoredRefreshFamily)
        : undefined;

      if (raw.status === 'consumed') {
        const successorSnap = raw.successorRefreshToken
          ? await this.refreshCol().doc(docId(raw.successorRefreshToken)).get()
          : undefined;
        const withinRetryWindow =
          raw.consumedAt !== undefined && now - raw.consumedAt <= REFRESH_RETRY_WINDOW_MS;

        if (
          withinRetryWindow &&
          family?.previousRefreshToken === refreshToken &&
          successorSnap?.exists
        ) {
          const successorRecord = successorSnap.data() as StoredRefreshRecord<T>;
          if (
            successorRecord.status === 'active' &&
            (!expectedClientId || successorRecord.token.clientId === expectedClientId)
          ) {
            return {
              status: 'retry',
              token: successorRecord.token,
              familyId: raw.familyId,
            };
          }
        }

        await this.revokeFamily(raw.familyId);
        return { status: 'replay', familyId: raw.familyId };
      }

      return { status: 'active', token: raw.token, familyId: raw.familyId };
    } catch (err) {
      this.wrapError(err);
    }
  }

  async rotate(
    oldRefreshToken: string,
    replacement: T,
    expectedClientId: string,
    now: number = this.nowProvider(),
  ): Promise<RefreshRotationResult<T>> {
    try {
      const oldRef = this.refreshCol().doc(docId(oldRefreshToken));

      const result = await this.db.runTransaction(async (transaction: Transaction) => {
        let oldSnap = await transaction.get(oldRef);

        if (!oldSnap.exists && this.legacy?.embeddedRefreshQuery) {
          const legacyMatch = await this.accessCol()
            .where('refreshToken', '==', oldRefreshToken)
            .limit(1)
            .get();
          if (!legacyMatch.empty) {
            const raw = legacyMatch.docs[0]!.data() as Record<string, unknown>;
            if (!raw.refreshFamilyId) {
              await this.adoptLegacyEmbeddedDocInTransaction(transaction, raw);
              oldSnap = await transaction.get(oldRef);
            }
          }
        }

        if (!oldSnap.exists) {
          return { status: 'missing' } as const;
        }

        let raw = oldSnap.data() as StoredRefreshRecord<T> | LegacyRefreshPointer;
        if (!('status' in raw)) {
          const legacyAccessSnap = await transaction.get(
            this.accessCol().doc(docId(raw.accessToken)),
          );
          if (!legacyAccessSnap.exists) return { status: 'missing' } as const;
          await this.adoptLegacyEmbeddedDocInTransaction(
            transaction,
            legacyAccessSnap.data() as Record<string, unknown>,
          );
          const adoptedSnap = await transaction.get(oldRef);
          if (!adoptedSnap.exists) return { status: 'missing' } as const;
          raw = adoptedSnap.data() as StoredRefreshRecord<T>;
        }

        const oldRecord = raw as StoredRefreshRecord<T>;
        if (oldRecord.token.clientId !== expectedClientId) {
          return { status: 'missing' } as const;
        }

        const familyRef = this.familyCol().doc(docId(oldRecord.familyId));
        const familySnap = await transaction.get(familyRef);
        const family: StoredRefreshFamily = familySnap.exists
          ? {
              ...(familySnap.data() as StoredRefreshFamily),
              retiredRefreshFingerprints:
                (familySnap.data() as StoredRefreshFamily).retiredRefreshFingerprints ?? [],
            }
          : {
              id: oldRecord.familyId,
              currentAccessToken: oldRecord.token.accessToken,
              currentRefreshToken: oldRefreshToken,
              retiredRefreshFingerprints: [],
            };

        if (oldRecord.status === 'consumed') {
          const successor = oldRecord.successorRefreshToken
            ? await transaction.get(
                this.refreshCol().doc(docId(oldRecord.successorRefreshToken)),
              )
            : undefined;

          const withinRetryWindow =
            oldRecord.consumedAt !== undefined && now - oldRecord.consumedAt <= REFRESH_RETRY_WINDOW_MS;

          if (
            withinRetryWindow &&
            family.previousRefreshToken === oldRefreshToken &&
            successor?.exists
          ) {
            const successorRecord = successor.data() as StoredRefreshRecord<T>;
            if (
              successorRecord.status === 'active' &&
              successorRecord.token.clientId === expectedClientId
            ) {
              return { status: 'retry', token: successorRecord.token } as const;
            }
          }

          this.deleteFamilyInTransaction(transaction, familyRef, family);
          return { status: 'replay' } as const;
        }

        // Active refresh token: perform rotation
        const retired = [...family.retiredRefreshFingerprints];
        if (family.previousRefreshToken) {
          retired.push(refreshFingerprint(family.previousRefreshToken));
          transaction.delete(this.refreshCol().doc(docId(family.previousRefreshToken)));
        }
        const boundedRetired = [
          ...new Set(retired.slice(-MAX_RETIRED_REFRESH_FINGERPRINTS)),
        ];

        if (family.previousAccessToken) {
          transaction.delete(this.accessCol().doc(docId(family.previousAccessToken)));
        }
        transaction.delete(this.accessCol().doc(docId(oldRecord.token.accessToken)));

        const stored: T = { ...replacement, refreshFamilyId: oldRecord.familyId };
        const extras = this.accessDocExtras ? this.accessDocExtras(stored) : {};
        const accessPayload = stripUndefined({ ...stored, ...extras });

        transaction.set(oldRef, stripUndefined({
          ...oldRecord,
          status: 'consumed',
          successorRefreshToken: stored.refreshToken,
          consumedAt: now,
        }));
        transaction.set(this.accessCol().doc(docId(stored.accessToken)), accessPayload);
        transaction.set(this.refreshCol().doc(docId(stored.refreshToken)), stripUndefined({
          status: 'active',
          familyId: oldRecord.familyId,
          token: stored,
        }));
        transaction.set(familyRef, stripUndefined({
          id: oldRecord.familyId,
          currentAccessToken: stored.accessToken,
          currentRefreshToken: stored.refreshToken,
          previousAccessToken: oldRecord.token.accessToken,
          previousRefreshToken: oldRefreshToken,
          retiredRefreshFingerprints: boundedRetired,
          updatedAt: now,
        }));

        return { status: 'claimed', token: stored } as const;
      });

      if (result.status !== 'missing') {
        return result;
      }

      const retiredMatch = await this.findFamilyByRetiredFingerprint(oldRefreshToken);
      if (retiredMatch) {
        await this.revokeFamily(retiredMatch);
        return { status: 'replay' };
      }

      return { status: 'missing' };
    } catch (err) {
      this.wrapError(err);
    }
  }

  async revokeFamily(familyId: string): Promise<void> {
    try {
      const familyRef = this.familyCol().doc(docId(familyId));
      await this.db.runTransaction(async (transaction: Transaction) => {
        const familySnap = await transaction.get(familyRef);
        if (!familySnap.exists) return;
        const family = familySnap.data() as StoredRefreshFamily;
        this.deleteFamilyInTransaction(transaction, familyRef, family);
      });
    } catch (err) {
      this.wrapError(err);
    }
  }

  async revokeByToken(token: string): Promise<void> {
    try {
      const accessSnap = await this.accessCol().doc(docId(token)).get();
      if (accessSnap.exists) {
        const data = accessSnap.data() as Record<string, unknown>;
        if (typeof data.refreshFamilyId === 'string') {
          await this.revokeFamily(data.refreshFamilyId);
        } else {
          await this.accessCol().doc(docId(token)).delete();
        }
        return;
      }

      const refreshSnap = await this.refreshCol().doc(docId(token)).get();
      if (refreshSnap.exists) {
        const raw = refreshSnap.data() as Record<string, unknown>;
        if (typeof raw.familyId === 'string') {
          await this.revokeFamily(raw.familyId);
          return;
        }
      }

      const retiredMatch = await this.findFamilyByRetiredFingerprint(token);
      if (retiredMatch) {
        await this.revokeFamily(retiredMatch);
      }
    } catch (err) {
      this.wrapError(err);
    }
  }

  private deleteFamilyInTransaction(
    transaction: Transaction,
    familyRef: DocumentReference,
    family: StoredRefreshFamily,
  ): void {
    if (family.currentAccessToken) {
      transaction.delete(this.accessCol().doc(docId(family.currentAccessToken)));
    }
    if (family.currentRefreshToken) {
      transaction.delete(this.refreshCol().doc(docId(family.currentRefreshToken)));
    }
    if (family.previousAccessToken) {
      transaction.delete(this.accessCol().doc(docId(family.previousAccessToken)));
    }
    if (family.previousRefreshToken) {
      transaction.delete(this.refreshCol().doc(docId(family.previousRefreshToken)));
    }
    for (const linkedCol of this.linkedFamilyCollections) {
      transaction.delete(this.db.collection(linkedCol).doc(docId(family.id)));
    }
    transaction.delete(familyRef);
  }

  private async findFamilyByRetiredFingerprint(refreshToken: string): Promise<string | undefined> {
    const fingerprint = refreshFingerprint(refreshToken);
    const matches = await this.familyCol()
      .where('retiredRefreshFingerprints', 'array-contains', fingerprint)
      .limit(1)
      .get();
    if (matches.empty) return undefined;
    return matches.docs[0]!.id;
  }

  private async adoptLegacyEmbeddedDoc(raw: Record<string, unknown>): Promise<T | undefined> {
    return await this.db.runTransaction(async (transaction: Transaction) => {
      return await this.adoptLegacyEmbeddedDocInTransaction(transaction, raw);
    });
  }

  private async adoptLegacyEmbeddedDocInTransaction(
    transaction: Transaction,
    raw: Record<string, unknown>,
  ): Promise<T | undefined> {
    const tokenObj = (this.legacy?.toToken ? this.legacy.toToken(raw) : raw) as unknown as T;
    if (!tokenObj.accessToken || !tokenObj.refreshToken) {
      return undefined;
    }

    const accessRef = this.accessCol().doc(docId(tokenObj.accessToken));
    const accessSnap = await transaction.get(accessRef);
    if (!accessSnap.exists) return undefined;

    const currentData = accessSnap.data() as Record<string, unknown>;
    if (currentData.refreshFamilyId) {
      return currentData as unknown as T;
    }

    const familyId = randomUUID();
    const migrated: T = { ...tokenObj, refreshFamilyId: familyId };
    const extras = this.accessDocExtras ? this.accessDocExtras(migrated) : {};

    transaction.set(accessRef, stripUndefined({ ...migrated, ...extras }));
    transaction.set(
      this.refreshCol().doc(docId(migrated.refreshToken)),
      stripUndefined({
        status: 'active',
        familyId,
        token: migrated,
      }),
    );
    transaction.set(
      this.familyCol().doc(docId(familyId)),
      stripUndefined({
        id: familyId,
        currentAccessToken: migrated.accessToken,
        currentRefreshToken: migrated.refreshToken,
        retiredRefreshFingerprints: [],
        updatedAt: this.nowProvider(),
      }),
    );

    if (this.legacy?.toUpstream && this.legacy?.upstreamCollection) {
      const upstreamData = this.legacy.toUpstream(raw);
      if (upstreamData) {
        transaction.set(
          this.db.collection(this.legacy.upstreamCollection).doc(docId(familyId)),
          stripUndefined({
            ...upstreamData,
            updatedAt: this.nowProvider(),
          }),
        );
      }
    }

    return migrated;
  }
}
