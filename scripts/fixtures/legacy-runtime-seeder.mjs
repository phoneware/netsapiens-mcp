import { execSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Keyed commitment hash for secrets/tokens.
 */
function commitHash(value) {
  if (!value || typeof value !== 'string') return '[empty]';
  return createHash('sha256').update(value).digest('hex');
}

let cached240Module = null;
let cached231Module = null;

async function get240Stores(tarball240Path) {
  if (cached240Module) return cached240Module;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seeder-240-'));
  execSync('npm init -y', { cwd: tmp, stdio: 'pipe' });
  execSync(`npm i --legacy-peer-deps ${tarball240Path} @google-cloud/firestore@^8.0.0`, { cwd: tmp, stdio: 'pipe' });

  const tokenStoreModule = await import(path.join(tmp, 'node_modules', 'netsapiens-mcp', 'build', 'auth', 'firestore-token-store.js'));
  const clientsStoreModule = await import(path.join(tmp, 'node_modules', 'netsapiens-mcp', 'build', 'auth', 'firestore-clients-store.js'));

  cached240Module = {
    FirestoreTokenStore: tokenStoreModule.FirestoreTokenStore,
    FirestoreClientsStore: clientsStoreModule.FirestoreClientsStore,
    tempDir: tmp,
  };
  return cached240Module;
}

async function get231Stores(tarball231Path) {
  if (cached231Module) return cached231Module;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seeder-231-'));
  execSync('npm init -y', { cwd: tmp, stdio: 'pipe' });
  execSync(`npm i --legacy-peer-deps ${tarball231Path} @google-cloud/firestore@^8.0.0`, { cwd: tmp, stdio: 'pipe' });

  const storesModule = await import(path.join(tmp, 'node_modules', 'netsapiens-mcp', 'build', 'auth', 'firestore-stores.js'));

  cached231Module = {
    FirestoreTokenStore: storesModule.FirestoreTokenStore,
    FirestoreAuthCodeStore: storesModule.FirestoreAuthCodeStore,
    FirestoreClientsStore: storesModule.FirestoreClientsStore,
    tempDir: tmp,
  };
  return cached231Module;
}

/**
 * Seeds legitimate Firestore source records using actual 2.3.1 and 2.4.0 runtime classes.
 *
 * @param {object} options
 * @param {import('@google-cloud/firestore').Firestore} options.db
 * @param {string} options.namespace - Supported cutover namespace ('mcp', 'pwmcp', 'readonly_mcp')
 * @param {string} [options.tarball240] - Path to 2.4.0 package tarball
 * @param {string} [options.tarball231] - Path to 2.3.1 package tarball
 * @param {number} [options.now] - Fixed timestamp
 * @returns {Promise<object>} Summary of seeded collections and document commitments
 */
export async function seedLegacyRuntimeRecords(options) {
  const {
    db,
    namespace = 'mcp',
    tarball240 = '/tmp/netsapiens-mcp-2.4.0-released.tgz',
    tarball231 = '/tmp/netsapiens-mcp-2.3.1.tgz',
    now = Date.now(),
  } = options;

  if (!fs.existsSync(tarball240)) {
    throw new Error(`2.4.0 tarball missing at ${tarball240}`);
  }
  if (!fs.existsSync(tarball231)) {
    throw new Error(`2.3.1 tarball missing at ${tarball231}`);
  }

  const stores240 = await get240Stores(tarball240);
  const stores231 = await get231Stores(tarball231);

  const seeded = {
    pr56Families: [],
    baseTokens: [],
    authCodes: [],
    resumeTokens: [],
    clients: [],
    documentCommitments: {},
  };

  // ---------------------------------------------------------------------------
  // 1. Seed PR56 records using actual 2.4.0 FirestoreTokenStore
  // ---------------------------------------------------------------------------
  const tokenStore240 = new stores240.FirestoreTokenStore({
    db,
    collection: `${namespace}_tokens`,
  });

  // Client for 2.4.0
  const clientsStore240 = new stores240.FirestoreClientsStore({
    db,
    collection: `${namespace}_oauth_clients`,
  });
  const client240Id = 'client-pr56-legit-' + randomBytes(4).toString('hex');
  const client240Secret = 'sec-pr56-' + randomBytes(16).toString('hex');
  await clientsStore240.registerClient({
    client_id: client240Id,
    client_secret: client240Secret,
    redirect_uris: ['http://127.0.0.1:3000/callback'],
    client_name: 'PR56 Client',
  });
  seeded.clients.push(client240Id);
  seeded.documentCommitments[`${namespace}_oauth_clients/${client240Id}`] = commitHash(client240Secret);

  // 1a. Active PR56 family
  const fam1Id = 'fam-pr56-act-' + randomBytes(4).toString('hex');
  const acc1Tok = 'acc-pr56-act-' + randomBytes(16).toString('hex');
  const ref1Tok = 'ref-pr56-act-' + randomBytes(16).toString('hex');
  const nsAcc1 = 'ns-acc-' + randomBytes(16).toString('hex');
  const nsRef1 = 'ns-ref-' + randomBytes(16).toString('hex');

  await tokenStore240.set({
    accessToken: acc1Tok,
    refreshToken: ref1Tok,
    tokenType: 'Bearer',
    expiresAt: now + 3600_000,
    scope: 'read write',
    clientId: client240Id,
    user: '1001@example.com',
    userRole: 'subscriber',
    nsAccessToken: nsAcc1,
    nsRefreshToken: nsRef1,
    nsExpiresAt: now + 3600_000,
    refreshFamilyId: fam1Id,
  });

  // Ensure upstream grant carries required username/role
  await db.collection(`${namespace}_tokens_upstream`).doc(fam1Id).set({
    grant: {
      nsAccessToken: nsAcc1,
      nsRefreshToken: nsRef1,
      nsExpiresAt: now + 3600_000,
      nsUsername: '1001@example.com',
      nsUserRole: 'subscriber',
      nsApiUrl: 'http://127.0.0.1:3000',
    },
    expiresAt: now + 3600_000,
    updatedAt: now,
  }, { merge: true });

  seeded.pr56Families.push(fam1Id);
  seeded.documentCommitments[`${namespace}_tokens/${acc1Tok}`] = commitHash(acc1Tok);
  seeded.documentCommitments[`${namespace}_tokens_refresh/${ref1Tok}`] = commitHash(ref1Tok);
  seeded.documentCommitments[`${namespace}_tokens_refresh_families/${fam1Id}`] = commitHash(fam1Id);
  seeded.documentCommitments[`${namespace}_tokens_upstream/${fam1Id}`] = commitHash(nsAcc1);

  // 1b. PR56 family with retired fingerprints
  const fam2Id = 'fam-pr56-ret-' + randomBytes(4).toString('hex');
  const acc2Tok = 'acc-pr56-ret-' + randomBytes(16).toString('hex');
  const ref2Tok = 'ref-pr56-ret-' + randomBytes(16).toString('hex');
  const retiredFp = 'fp-retired-' + randomBytes(16).toString('hex');

  await tokenStore240.set({
    accessToken: acc2Tok,
    refreshToken: ref2Tok,
    tokenType: 'Bearer',
    expiresAt: now + 3600_000,
    scope: 'read write',
    clientId: client240Id,
    user: '1002@example.com',
    userRole: 'subscriber',
    nsAccessToken: 'ns-acc-ret-' + randomBytes(8).toString('hex'),
    nsRefreshToken: 'ns-ref-ret-' + randomBytes(8).toString('hex'),
    nsExpiresAt: now + 3600_000,
    refreshFamilyId: fam2Id,
  });

  await db.collection(`${namespace}_tokens_refresh_families`).doc(fam2Id).update({
    retiredRefreshFingerprints: [retiredFp],
  });
  await db.collection(`${namespace}_tokens_upstream`).doc(fam2Id).set({
    grant: {
      nsAccessToken: 'ns-acc-ret-live',
      nsRefreshToken: 'ns-ref-ret-live',
      nsExpiresAt: now + 3600_000,
      nsUsername: '1002@example.com',
      nsUserRole: 'subscriber',
      nsApiUrl: 'http://127.0.0.1:3000',
    },
    expiresAt: now + 3600_000,
    updatedAt: now,
  }, { merge: true });

  seeded.pr56Families.push(fam2Id);

  // 1c. PR56 family with TTL-expired access doc (proves access doc deletion survival)
  const fam3Id = 'fam-pr56-noacc-' + randomBytes(4).toString('hex');
  const acc3Tok = 'acc-pr56-noacc-' + randomBytes(16).toString('hex');
  const ref3Tok = 'ref-pr56-noacc-' + randomBytes(16).toString('hex');

  await tokenStore240.set({
    accessToken: acc3Tok,
    refreshToken: ref3Tok,
    tokenType: 'Bearer',
    expiresAt: now + 3600_000,
    scope: 'read write',
    clientId: client240Id,
    user: '1003@example.com',
    userRole: 'subscriber',
    nsAccessToken: 'ns-acc-noacc',
    nsRefreshToken: 'ns-ref-noacc',
    nsExpiresAt: now + 3600_000,
    refreshFamilyId: fam3Id,
  });

  await db.collection(`${namespace}_tokens_upstream`).doc(fam3Id).set({
    grant: {
      nsAccessToken: 'ns-acc-noacc',
      nsRefreshToken: 'ns-ref-noacc',
      nsExpiresAt: now + 3600_000,
      nsUsername: '1003@example.com',
      nsUserRole: 'subscriber',
      nsApiUrl: 'http://127.0.0.1:3000',
    },
    expiresAt: now + 3600_000,
    updatedAt: now,
  }, { merge: true });

  // Simulate TTL deletion of access doc
  await db.collection(`${namespace}_tokens`).doc(acc3Tok).delete();
  seeded.pr56Families.push(fam3Id);

  // 1d. Seed actual bridge format resume tokens in mcp_resume_tokens
  // (Actual format: doc ID = resumeId, data = { consumedAt, expiresAt, ttlAt }, NO embedded id)
  const resume1Id = 'res-tok-' + randomBytes(12).toString('hex');
  await db.collection(`${namespace}_resume_tokens`).doc(resume1Id).set({
    consumedAt: now - 1000,
    expiresAt: now + 7200_000,
    ttlAt: new Date(now + 7200_000),
  });
  seeded.resumeTokens.push(resume1Id);
  seeded.documentCommitments[`${namespace}_resume_tokens/${resume1Id}`] = commitHash(resume1Id);

  const resume2Id = 'res-tok-second-' + randomBytes(12).toString('hex');
  await db.collection(`${namespace}_resume_tokens`).doc(resume2Id).set({
    consumedAt: now - 2000,
    expiresAt: now + 7200_000,
    ttlAt: new Date(now + 7200_000),
  });
  seeded.resumeTokens.push(resume2Id);
  seeded.documentCommitments[`${namespace}_resume_tokens/${resume2Id}`] = commitHash(resume2Id);
  // ---------------------------------------------------------------------------
  // 2. Seed v2.3.1 base format records using actual 2.3.1 stores
  // ---------------------------------------------------------------------------
  const tokenStore231 = new stores231.FirestoreTokenStore({
    db,
    collection: `${namespace}_tokens`,
  });
  const authCodeStore231 = new stores231.FirestoreAuthCodeStore({
    db,
    collection: `${namespace}_auth_codes`,
  });
  const clientsStore231 = new stores231.FirestoreClientsStore({
    db,
    collection: `${namespace}_oauth_clients`,
  });

  const client231Id = 'client-v231-legit-' + randomBytes(4).toString('hex');
  const client231Secret = 'sec-v231-' + randomBytes(16).toString('hex');
  await clientsStore231.registerClient({
    client_id: client231Id,
    client_secret: client231Secret,
    redirect_uris: ['http://127.0.0.1:3000/callback'],
    client_name: 'v2.3.1 Client',
  });
  seeded.clients.push(client231Id);

  // 2a. Flat base token (NO refreshFamilyId, pointer contains only { accessToken })
  const baseAccTok = 'acc-base-flat-' + randomBytes(16).toString('hex');
  const baseRefTok = 'ref-base-flat-' + randomBytes(16).toString('hex');

  await tokenStore231.set({
    accessToken: baseAccTok,
    refreshToken: baseRefTok,
    tokenType: 'Bearer',
    expiresAt: now + 3600_000,
    scope: 'read write',
    clientId: client231Id,
    user: '1004@example.com',
    nsUsername: '1004@example.com',
    userRole: 'subscriber',
    nsAccessToken: 'ns-acc-base-' + randomBytes(8).toString('hex'),
    nsRefreshToken: 'ns-ref-base-' + randomBytes(8).toString('hex'),
    nsExpiresAt: now + 3600_000,
  });
  seeded.baseTokens.push(baseAccTok);
  seeded.documentCommitments[`${namespace}_tokens/${baseAccTok}`] = commitHash(baseAccTok);
  seeded.documentCommitments[`${namespace}_tokens_refresh/${baseRefTok}`] = commitHash(baseRefTok);

  // 2b. Auth code in mcp_auth_codes
  const authCodeVal = 'code-v231-' + randomBytes(16).toString('hex');
  await authCodeStore231.set(authCodeVal, {
    pending: {
      clientId: client231Id,
      redirectUri: 'http://127.0.0.1:3000/callback',
      codeChallenge: 'chall-' + randomBytes(8).toString('hex'),
      codeChallengeMethod: 'S256',
      scope: 'read write',
      state: 'st-v231',
      createdAt: now,
    },
    nsTokens: {
      access_token: 'ns-acc-code-231',
      refresh_token: 'ns-ref-code-231',
      expires_in: 3600,
      token_type: 'Bearer',
      username: '1004@example.com',
    },
    serverBaseUrl: 'http://127.0.0.1:3000',
    clientId: client231Id,
    expiresAt: now + 300_000,
  });
  seeded.authCodes.push(authCodeVal);
  seeded.documentCommitments[`${namespace}_auth_codes/${authCodeVal}`] = commitHash(authCodeVal);

  return seeded;
}

/**
 * Seeds deliberate malformed legacy records for negative-path tests.
 */
export async function seedMalformedLegacyRecords(options) {
  const { db, namespace = 'mcp', now = Date.now() } = options;
  // Malformed resume token lacking consumedAt
  const badResumeId = 'bad-resume-' + randomBytes(8).toString('hex');
  await db.collection(`${namespace}_resume_tokens`).doc(badResumeId).set({
    expiresAt: now + 7200_000,
    ttlAt: new Date(now + 7200_000),
  });
  // Malformed token lacking nsUsername
  const badTokId = 'bad-tok-' + randomBytes(8).toString('hex');
  await db.collection(`${namespace}_tokens`).doc(badTokId).set({
    accessToken: badTokId,
    refreshToken: 'ref-bad-' + randomBytes(8).toString('hex'),
    tokenType: 'Bearer',
    expiresAt: now + 3600_000,
    clientId: 'client-bad',
  });
  return { badResumeId, badTokId };
}
