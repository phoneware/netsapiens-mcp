import { createHash, randomUUID } from 'node:crypto';
import { createCodec } from './codec.js';
import { firestoreCollections, type FirestoreLike } from './firestore.js';
import type { AccessRow, FamilyRow, RefreshPointerRow, StoredToken, UpstreamGrantRow } from './types.js';
import { ACCESS_RETENTION_MS, accessAad, familyAad, refreshAad, upstreamAad } from './store.js';
import { StoreUnavailableError } from './codec.js';
import {
  type CutoverFenceControlRecord,
  type CutoverFenceState,
  getCutoverFenceDocRef,
  readCutoverFenceInTransaction,
  getCutoverFenceRecord,
  transitionCutoverFenceState,
  markIrreversibleInTransaction,
  isSupportedCutoverNamespace,
  CutoverFenceError,
  CutoverRefusedError,
  stripUndefined,
} from '../auth/kit/cutover-fence.js';

export {
  type CutoverFenceControlRecord,
  type CutoverFenceState,
  type CutoverFenceConfig,
  type LegacyOperationPhase,
  type LegacyOperationRecord,
  type LegacyOperationContext,
  getCutoverFenceDocRef,
  readCutoverFenceInTransaction,
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
  SUPPORTED_CUTOVER_NAMESPACES,
  isSupportedCutoverNamespace,
} from '../auth/kit/cutover-fence.js';

function defined<T>(value: T): T {
  if (Array.isArray(value)) return value.filter(v => v !== undefined).map(defined) as T;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, defined(v)])) as T;
  }
  return value;
}

export interface FirestoreAdoptionReport {
  scanned: number;
  migrated: number;
  skipped: number;
  errors: number;
}

export interface MigrationManifest {
  schemaVersion: 1;
  runId: string;
  epoch: number;
  namespace: string;
  scanned: number;
  migrated: number;
  skipped: number;
  errors: number;
  classifications: {
    pr56Families: number;
    baseFormatTokens: number;
    authCodes: number;
    resumeTokens: number;
  };
  completedAt: number;
}

export async function adoptFirestoreLegacyTokens(options: {
  db: FirestoreLike;
  namespace: string;
  key: Uint8Array;
  dryRun?: boolean;
  expectedEpoch?: number;
  now?: () => number;
}): Promise<FirestoreAdoptionReport> {
  const { db, namespace, key, dryRun = false } = options;
  const nowProvider = options.now ?? Date.now;
  const codec = createCodec(key);
  const v3Cols = firestoreCollections(namespace);

  const report: FirestoreAdoptionReport = {
    scanned: 0,
    migrated: 0,
    skipped: 0,
    errors: 0,
  };

  const classifications = {
    pr56Families: 0,
    baseFormatTokens: 0,
    authCodes: 0,
    resumeTokens: 0,
  };

  const isControlled = isSupportedCutoverNamespace(namespace);
  const initialControl = isControlled ? await getCutoverFenceRecord(db, namespace) : undefined;
  let currentEpoch = options.expectedEpoch ?? initialControl?.epoch ?? 1;
  let runId: string = randomUUID();

  // C7: Validate fence state machine
  if (isControlled && initialControl) {
    if (initialControl.state !== 'fenced' && initialControl.state !== 'migrating') {
      throw new CutoverFenceError(
        `Cannot migrate namespace ${namespace}: state is ${initialControl.state}; must be fenced or migrating`,
      );
    }
    if (options.expectedEpoch !== undefined && initialControl.epoch !== options.expectedEpoch) {
      throw new CutoverFenceError(
        `Epoch mismatch for namespace ${namespace}: expected ${options.expectedEpoch}, got ${initialControl.epoch}`,
      );
    }
    currentEpoch = initialControl.epoch;

    if (initialControl.state === 'fenced') {
      await transitionCutoverFenceState(db, namespace, {
        fromState: 'fenced',
        toState: 'migrating',
        expectedEpoch: currentEpoch,
        migrationRunId: runId,
        now: nowProvider,
      });
    } else if (initialControl.migrationRunId) {
      runId = initialControl.migrationRunId;
    }
  }

  const legacyTokensCol = `${namespace}_tokens`;
  const legacyRefreshCol = `${namespace}_tokens_refresh`;
  const legacyFamiliesCol = `${namespace}_tokens_refresh_families`;
  const legacyUpstreamCol = `${namespace}_tokens_upstream`;
  const legacyAuthCodesCol = `${namespace}_auth_codes`;
  const legacyResumeCol = `${namespace}_resume_tokens`;

  // 1. Adopt established PR56 refresh families
  try {
    const familiesSnap = await db.collection(legacyFamiliesCol).get();
    for (const famDoc of familiesSnap.docs) {
      report.scanned++;
      const familyId = famDoc.id;

      try {
        const outcome = await db.runTransaction(async (tx) => {
          if (isControlled && initialControl) {
            const ctrl = await readCutoverFenceInTransaction(tx, db, namespace);
            if (ctrl.epoch !== currentEpoch || (ctrl.state !== 'migrating' && ctrl.state !== 'fenced')) {
              throw new CutoverFenceError(`Cutover state changed concurrently during family migration`);
            }
            // Latch irreversible on first v3 mutation
            await markIrreversibleInTransaction(tx, db, namespace, currentEpoch, nowProvider);
          }

          // Check if already migrated inside transaction
          const existingV3 = await tx.get(db.collection(v3Cols.refreshFamilies).doc(familyId));
          if (existingV3.exists) {
            return 'skipped';
          }

          // Read source legacy family inside transaction
          const famSnap = await tx.get(db.collection(legacyFamiliesCol).doc(familyId));
          if (!famSnap.exists) return 'skipped';
          const famData = famSnap.data() as Record<string, unknown>;

          // Read active refresh pointer inside transaction (AUTHORITATIVE FOR CLIENT BINDING)
          const currentRefreshToken = famData.currentRefreshToken as string | undefined;
          const refSnap = currentRefreshToken
            ? await tx.get(db.collection(legacyRefreshCol).doc(currentRefreshToken))
            : null;
          const refData = (refSnap?.exists ? refSnap.data() : null) as Record<string, unknown> | null;
          const embeddedToken = (refData?.token as Record<string, unknown> | undefined) ?? {};

          // Read upstream grant doc inside transaction (nested { grant: { ... } } or flat)
          const upSnap = await tx.get(db.collection(legacyUpstreamCol).doc(familyId));
          const upData = (upSnap.exists ? upSnap.data() : {}) as Record<string, unknown>;
          const grant = (upData.grant as Record<string, unknown> | undefined) ?? upData;

          // Read access doc inside transaction (may be absent due to Firestore TTL)
          const accessId = (famData.currentAccessToken as string | undefined) ?? (embeddedToken.accessToken as string | undefined);
          const accSnap = accessId ? await tx.get(db.collection(legacyTokensCol).doc(accessId)) : null;
          const accData = (accSnap?.exists ? accSnap.data() : null) as Record<string, unknown> | null;

          const clientId = (embeddedToken.clientId as string | undefined) ??
            (accData?.clientId as string | undefined) ??
            (famData.clientId as string | undefined);

          if (!clientId) {
            throw new Error(`Cannot adopt PR56 family ${familyId}: client binding missing across pointer, access, and family docs`);
          }

          const now = nowProvider();
          const generation = typeof famData.generation === 'number' ? (famData.generation as number) : 1;
          const grantVersion = typeof upData.grantVersion === 'number' ? (upData.grantVersion as number) : 1;

          const rawAccessId = accessId || randomUUID();
          const newAccessId = codec.id('session', rawAccessId);
          const rawRefreshId = currentRefreshToken || (embeddedToken.refreshToken as string | undefined) || randomUUID();
          const newRefreshId = codec.id('refresh', rawRefreshId);

          const expiresAt = typeof accData?.expiresAt === 'number'
            ? (accData.expiresAt as number)
            : (typeof embeddedToken.expiresAt === 'number' ? (embeddedToken.expiresAt as number) : now + 3600_000);
          const retainUntil = expiresAt + ACCESS_RETENTION_MS;

          const serverBaseUrl = (embeddedToken.serverBaseUrl as string | undefined) ??
            (accData?.serverBaseUrl as string | undefined) ??
            (famData.serverBaseUrl as string | undefined);

          const extra = (embeddedToken.extra as Record<string, string> | undefined) ??
            (accData?.extra as Record<string, string> | undefined) ??
            {};

          const nsAccessToken = (grant.nsAccessToken ?? grant.access_token ?? embeddedToken.nsAccessToken ?? accData?.nsAccessToken) as string | undefined;
          const nsRefreshToken = (grant.nsRefreshToken ?? grant.refresh_token ?? embeddedToken.nsRefreshToken ?? accData?.nsRefreshToken) as string | undefined;
          const nsUsername = (grant.nsUsername ?? grant.username ?? embeddedToken.nsUsername ?? accData?.nsUsername) as string | undefined;
          const nsUserRole = (grant.nsUserRole ?? grant.user_role ?? grant.userRole ?? embeddedToken.nsUserRole ?? accData?.nsUserRole) as string | undefined;
          const nsApiUrl = (grant.nsApiUrl ?? grant.api_url ?? grant.apiUrl ?? embeddedToken.nsApiUrl ?? accData?.nsApiUrl) as string | undefined;

          if (!nsAccessToken && !nsRefreshToken) {
            throw new Error(`Cannot adopt PR56 family ${familyId}: upstream NetSapiens credentials missing`);
          }
          if (!nsUsername) {
            throw new Error(`Cannot adopt PR56 family ${familyId}: NetSapiens username missing`);
          }

          const nsExpiresAt = typeof upData.expiresAt === 'number'
            ? (upData.expiresAt as number)
            : (typeof grant.expires_in === 'number'
              ? now + (grant.expires_in as number) * 1000
              : (typeof accData?.nsExpiresAt === 'number' ? (accData.nsExpiresAt as number) : (typeof embeddedToken.nsExpiresAt === 'number' ? (embeddedToken.nsExpiresAt as number) : undefined)));

          const retiredFingerprints = Array.isArray(famData.retiredRefreshFingerprints)
            ? (famData.retiredRefreshFingerprints as string[])
            : [];

          const familyRow: FamilyRow = {
            id: familyId,
            generation,
            status: (famData.status === 'revoked' ? 'revoked' : 'active'),
            activeRefreshId: newRefreshId,
            currentAccessTokenId: newAccessId,
            updatedAt: now,
            sealed: codec.seal({
              clientId,
              serverBaseUrl,
              extra,
              retiredRefreshIds: retiredFingerprints,
            }, familyAad({ id: familyId, generation })),
          };

          const upstreamRow: UpstreamGrantRow = {
            id: familyId,
            grantVersion,
            nsExpiresAt,
            updatedAt: now,
            sealed: codec.seal({
              nsAccessToken: nsAccessToken || '',
              nsRefreshToken,
              nsUsername,
              nsUserRole,
              nsApiUrl,
            }, upstreamAad({ id: familyId, grantVersion })),
          };

          const accessRow: AccessRow = {
            id: newAccessId,
            familyId,
            expiresAt,
            retainUntil,
            sealed: codec.seal({
              familyId,
              clientId,
              serverBaseUrl,
              extra,
            }, accessAad({ id: newAccessId, familyId })),
          };

          const refreshRow: RefreshPointerRow = {
            id: newRefreshId,
            familyId,
            status: 'active',
            generation,
          };

          let prevRefreshRow: RefreshPointerRow | undefined;
          if (famData.previousRefreshToken && currentRefreshToken && rawAccessId) {
            const prevRefreshId = codec.id('refresh', famData.previousRefreshToken as string);
            const prevRefDoc = await tx.get(db.collection(legacyRefreshCol).doc(famData.previousRefreshToken as string));
            const prevData = prevRefDoc.exists ? (prevRefDoc.data() as Record<string, unknown>) : null;
            const consumedAt = typeof prevData?.consumedAt === 'number' ? (prevData.consumedAt as number) : now;

            prevRefreshRow = {
              id: prevRefreshId,
              familyId,
              status: 'consumed',
              generation: Math.max(1, generation - 1),
              consumedAt,
              successorSealed: codec.seal({
                accessToken: rawAccessId,
                refreshToken: currentRefreshToken,
              }, `successor:${prevRefreshId}`),
            };
          }

          if (!dryRun) {
            tx.set(db.collection(v3Cols.refreshFamilies).doc(familyId), defined({ ...familyRow, v: 2 }));
            tx.set(db.collection(v3Cols.upstreamGrants).doc(familyId), defined({ ...upstreamRow, v: 2 }));
            tx.set(db.collection(v3Cols.refreshTokens).doc(newRefreshId), defined({ ...refreshRow, v: 2 }));
            tx.set(db.collection(v3Cols.sessions).doc(newAccessId), defined({ ...accessRow, v: 2, ttlAt: new Date(retainUntil) }));
            if (prevRefreshRow) {
              tx.set(db.collection(v3Cols.refreshTokens).doc(prevRefreshRow.id), defined({ ...prevRefreshRow, v: 2 }));
            }
            for (const fp of retiredFingerprints) {
              tx.set(db.collection(v3Cols.retiredRefreshTokens).doc(fp), {
                familyId,
                retiredAt: now,
              });
            }
          }
          return 'migrated';
        });

        if (outcome === 'skipped') {
          report.skipped++;
        } else {
          report.migrated++;
          classifications.pr56Families++;
        }
      } catch (err: unknown) {
        report.errors++;
      }
    }
  } catch (err: unknown) {
    report.errors++;
  }

  // 2. Adopt unattached base-format token documents
  try {
    const tokensSnap = await db.collection(legacyTokensCol).get();
    for (const tokDoc of tokensSnap.docs) {
      report.scanned++;
      const accessToken = tokDoc.id;
      const accessId = codec.id('session', accessToken);

      try {
        const outcome = await db.runTransaction(async (tx) => {
          if (isControlled && initialControl) {
            const ctrl = await readCutoverFenceInTransaction(tx, db, namespace);
            if (ctrl.epoch !== currentEpoch || (ctrl.state !== 'migrating' && ctrl.state !== 'fenced')) {
              throw new CutoverFenceError(`Cutover state changed concurrently during token migration`);
            }
            await markIrreversibleInTransaction(tx, db, namespace, currentEpoch, nowProvider);
          }

          const existingV3Access = await tx.get(db.collection(v3Cols.sessions).doc(accessId));
          if (existingV3Access.exists) {
            return 'skipped';
          }

          const legacyTokSnap = await tx.get(db.collection(legacyTokensCol).doc(accessToken));
          if (!legacyTokSnap.exists) {
            return 'skipped';
          }
          const tokData = legacyTokSnap.data();
          if (!tokData || !tokData.refreshToken) {
            return 'skipped';
          }

          const clientId = tokData.clientId as string | undefined;
          if (!clientId) {
            throw new Error(`Cannot adopt legacy token ${accessToken}: clientId is missing`);
          }

          const nsAccessToken = tokData.nsAccessToken as string | undefined;
          const nsRefreshToken = tokData.nsRefreshToken as string | undefined;
          if (!nsAccessToken && !nsRefreshToken) {
            throw new Error(`Cannot adopt legacy token ${accessToken}: upstream tokens missing`);
          }

          const familyId = (tokData.refreshFamilyId as string) || randomUUID();
          const refreshId = codec.id('refresh', tokData.refreshToken as string);
          const now = nowProvider();
          const expiresAt = typeof tokData.expiresAt === 'number' ? (tokData.expiresAt as number) : now + 3600_000;
          const retainUntil = expiresAt + ACCESS_RETENTION_MS;
          const generation = 1;
          const grantVersion = 1;

          const accessRow: AccessRow = {
            id: accessId,
            familyId,
            expiresAt,
            retainUntil,
            sealed: codec.seal({
              familyId,
              clientId,
              serverBaseUrl: tokData.serverBaseUrl as string | undefined,
              extra: (tokData.extra ?? (tokData.seatId ? { seatId: String(tokData.seatId) } : {})) as Record<string, string>,
            }, accessAad({ id: accessId, familyId })),
          };

          const refreshRow: RefreshPointerRow = {
            id: refreshId,
            familyId,
            status: 'active',
            generation,
          };

          const familyRow: FamilyRow = {
            id: familyId,
            generation,
            status: 'active',
            activeRefreshId: refreshId,
            currentAccessTokenId: accessId,
            updatedAt: now,
            sealed: codec.seal({
              clientId,
              serverBaseUrl: tokData.serverBaseUrl as string | undefined,
              extra: (tokData.extra ?? (tokData.seatId ? { seatId: String(tokData.seatId) } : {})) as Record<string, string>,
              retiredRefreshIds: [],
            }, familyAad({ id: familyId, generation })),
          };

          const upstreamRow: UpstreamGrantRow = {
            id: familyId,
            grantVersion,
            nsExpiresAt: typeof tokData.nsExpiresAt === 'number' ? (tokData.nsExpiresAt as number) : undefined,
            updatedAt: now,
            sealed: codec.seal({
              nsAccessToken: nsAccessToken || '',
              nsRefreshToken,
              nsUsername: (tokData.nsUsername ?? '') as string,
              nsUserRole: tokData.nsUserRole as string | undefined,
              nsApiUrl: tokData.nsApiUrl as string | undefined,
            }, upstreamAad({ id: familyId, grantVersion })),
          };

          if (!dryRun) {
            tx.set(db.collection(v3Cols.refreshFamilies).doc(familyId), defined({ ...familyRow, v: 2 }));
            tx.set(db.collection(v3Cols.upstreamGrants).doc(familyId), defined({ ...upstreamRow, v: 2 }));
            tx.set(db.collection(v3Cols.refreshTokens).doc(refreshId), defined({ ...refreshRow, v: 2 }));
            tx.set(db.collection(v3Cols.sessions).doc(accessId), defined({ ...accessRow, v: 2, ttlAt: new Date(retainUntil) }));
          }
          return 'migrated';
        });

        if (outcome === 'skipped') {
          report.skipped++;
        } else {
          report.migrated++;
          classifications.baseFormatTokens++;
        }
      } catch (err: unknown) {
        report.errors++;
      }
    }
  } catch (err: unknown) {
    report.errors++;
  }

  // 3. Convert legacy authorization codes
  try {
    const authCodesSnap = await db.collection(legacyAuthCodesCol).get().catch(() => null);
    if (authCodesSnap && !authCodesSnap.empty) {
      for (const codeDoc of authCodesSnap.docs) {
        const rawCode = codeDoc.id;
        const codeData = codeDoc.data();
        if (!codeData) continue;

        const expiresAt = typeof codeData.expiresAt === 'number'
          ? (codeData.expiresAt as number)
          : (typeof codeData.expires_at === 'number' ? (codeData.expires_at as number) : 0);

        if (expiresAt > nowProvider()) {
          try {
            await db.runTransaction(async (tx) => {
              const hmacId = codec.id('code', rawCode);
              const payload = {
                pending: {
                  clientId: codeData.clientId ?? codeData.client_id,
                  codeChallenge: codeData.codeChallenge ?? codeData.code_challenge,
                  redirectUri: codeData.redirectUri ?? codeData.redirect_uri,
                  createdAt: codeData.createdAt ?? codeData.created_at ?? nowProvider(),
                },
                nsTokens: codeData.nsTokens ?? { access_token: codeData.nsAccessToken ?? '' },
                extra: codeData.extra,
                serverBaseUrl: codeData.serverBaseUrl,
              };

              if (!dryRun) {
                tx.set(db.collection(v3Cols.authCodes).doc(hmacId), {
                  id: hmacId,
                  expiresAt,
                  sealed: codec.seal(payload, `code:${hmacId}`),
                  v: 2,
                  ttlAt: new Date(expiresAt),
                });
                tx.delete(db.collection(legacyAuthCodesCol).doc(rawCode));
              }
            });
            classifications.authCodes++;
          } catch {
            report.errors++;
          }
        }
      }
    }
  } catch {
    // Non-fatal if auth_codes collection not present
  }

  // 4. Retain resume tokens
  try {
    const resumeSnap = await db.collection(legacyResumeCol).get().catch(() => null);
    if (resumeSnap && !resumeSnap.empty) {
      for (const rDoc of resumeSnap.docs) {
        const rData = rDoc.data();
        if (!rData) continue;
        const expiresAt = typeof rData.expiresAt === 'number' ? (rData.expiresAt as number) : 0;
        if (expiresAt > nowProvider()) {
          try {
            await db.runTransaction(async (tx) => {
              if (!dryRun) {
                tx.set(db.collection(v3Cols.resumeTokens).doc(rDoc.id), {
                  id: rDoc.id,
                  consumedAt: rData.consumedAt ?? nowProvider(),
                  expiresAt,
                  v: 2,
                  ttlAt: new Date(expiresAt),
                });
              }
            });
            classifications.resumeTokens++;
          } catch {
            report.errors++;
          }
        }
      }
    }
  } catch {
    // Non-fatal if resume_tokens collection not present
  }

  // 5. Compute manifest & finalize
  const manifest: MigrationManifest = {
    schemaVersion: 1,
    runId,
    epoch: currentEpoch,
    namespace,
    scanned: report.scanned,
    migrated: report.migrated,
    skipped: report.skipped,
    errors: report.errors,
    classifications,
    completedAt: nowProvider(),
  };

  const manifestJson = JSON.stringify(manifest);
  const manifestDigest = createHash('sha256').update(manifestJson).digest('hex');

  if (!dryRun && report.errors === 0) {
    // Store migration manifest
    await db.collection(`${namespace}_meta`).doc(`migration_manifest_${currentEpoch}`).set(manifest as unknown as Record<string, unknown>);

    // Store v2_adopted marker
    await db.collection(`${namespace}_meta`).doc('v2_adopted').set({
      adoptedAt: nowProvider(),
      runId,
      epoch: currentEpoch,
      manifestDigest,
      ...report,
    });

    // Advance fence state to v3_ready
    if (isControlled && initialControl) {
      await transitionCutoverFenceState(db, namespace, {
        fromState: 'migrating',
        toState: 'v3_ready',
        expectedEpoch: currentEpoch,
        migrationRunId: runId,
        migrationManifestDigest: manifestDigest,
        now: nowProvider,
      });
    }
  }

  return report;
}

export async function ensureFirestoreAdopted(options: {
  db: FirestoreLike;
  namespace: string;
  key: Uint8Array;
  now?: () => number;
}): Promise<void> {
  const { db, namespace, key } = options;
  const nowProvider = options.now ?? Date.now;
  const markerDoc = db.collection(`${namespace}_meta`).doc('v2_adopted');
  const snap = await markerDoc.get();
  if (snap.exists) return;

  // Read without swallowing errors: network or permission failure MUST fail closed
  const legacyFamiliesSnap = await db.collection(`${namespace}_tokens_refresh_families`).get();
  const legacyTokensSnap = await db.collection(`${namespace}_tokens`).get();

  const hasLegacy = !legacyFamiliesSnap.empty || !legacyTokensSnap.empty;
  if (!hasLegacy) {
    await markerDoc.set({ adoptedAt: nowProvider(), skipped: true, scanned: 0, migrated: 0, errors: 0 });
    return;
  }

  const report = await adoptFirestoreLegacyTokens({ db, namespace, key, now: nowProvider });
  if (report.errors > 0) {
    throw new StoreUnavailableError(`Firestore legacy adoption failed with ${report.errors} error(s); cannot start`);
  }
}
