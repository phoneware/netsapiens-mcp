import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { deriveStoreKey } from '../codec.js';
import { createMemoryStore } from '../memory.js';
import { createSqliteStore } from '../sqlite.js';
import type { SubjectDescriptor } from '../subject-descriptor.js';
import type { AuthCodeData, McpStore, StoredToken } from '../types.js';

// Subject guards and keyed subject references on the stores that own their guard
// documents. The store is constructed with the bound descriptor, as the runtime does.
// Firestore reads application-owned guard documents and has its own emulator suite.

const key = deriveStoreKey('subject-guard-test-secret-0123456789abcdef');
const descriptor: SubjectDescriptor = { allow: ['active'], collection: 'seats', extraKey: 'seat', field: 'state' };
const dirs: string[] = [];
const freshPath = () => { const dir = mkdtempSync(join(tmpdir(), 'subject-guard-')); dirs.push(dir); return join(dir, 'store.sqlite'); };
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const guard = (documentId: string) => ({ collection: 'seats', documentId, field: 'state', allow: ['active'] });
const stored = {
  clientId: 'c', expiresAt: Date.now() + 60_000, nsAccessToken: 'ns-a', nsRefreshToken: 'ns-r',
  nsExpiresAt: Date.now() + 3_600_000, nsUsername: 'alice', serverBaseUrl: 'http://localhost:3000',
} as unknown as StoredToken;

async function redeemFor(store: McpStore, code: string, seat: string, token: string) {
  await store.authCodes.put(code, { clientId: 'c', pending: { clientId: 'c' }, nsTokens: {} } as unknown as AuthCodeData);
  return store.authCodes.redeemAndIssue(
    code,
    { clientId: 'c' },
    { accessToken: `acc-${token}`, refreshToken: `ref-${token}` },
    stored,
    undefined,
    { extraKey: 'seat', value: seat, guard: guard(seat) },
  );
}

describe('subject guard on memory store', () => {
  it('refuses issuance until the guard allows the subject, and does not consume the code', async () => {
    const store = createMemoryStore({ namespace: 'mcp', key, subjectDescriptor: descriptor });
    try {
      expect(await redeemFor(store, 'code-guard-1', 'seat-g1', 'g1')).toBeUndefined();
      await store.putGuardDocument('seats', 'seat-g1', { state: 'active' });
      expect(await redeemFor(store, 'code-guard-1', 'seat-g1', 'g1b')).toBeDefined();
    } finally {
      await store.close();
    }
  });

  it('revokes a subject in bounded, idempotent pages and leaves other subjects alone', async () => {
    const store = createMemoryStore({ namespace: 'mcp', key, subjectDescriptor: descriptor });
    try {
      await store.putGuardDocument('seats', 'seat-r1', { state: 'active' });
      await store.putGuardDocument('seats', 'seat-r2', { state: 'active' });
      for (const n of [1, 2, 3]) expect(await redeemFor(store, `code-r1-${n}`, 'seat-r1', `r1-${n}`)).toBeDefined();
      expect(await redeemFor(store, 'code-r2-1', 'seat-r2', 'r2-1')).toBeDefined();

      expect(await store.revokeSubject('seat', 'seat-r1', { limit: 2 })).toEqual({ revoked: 2, more: true });
      expect(await store.revokeSubject('seat', 'seat-r1', { limit: 2 })).toEqual({ revoked: 1, more: false });
      expect(await store.revokeSubject('seat', 'seat-r1', { limit: 2 })).toEqual({ revoked: 0, more: false });

      expect(await store.sessions.get('acc-r1-1')).toBeUndefined();
      expect(await store.sessions.get('acc-r2-1')).toBeDefined();
    } finally {
      await store.close();
    }
  });

  it('refuses a new issuance for a subject whose guard no longer allows it', async () => {
    const store = createMemoryStore({ namespace: 'mcp', key, subjectDescriptor: descriptor });
    try {
      await store.putGuardDocument('seats', 'seat-x', { state: 'revoked' });
      expect(await redeemFor(store, 'code-x-1', 'seat-x', 'x1')).toBeUndefined();
    } finally {
      await store.close();
    }
  });

  it('refuses revocation when the store was built without a descriptor', async () => {
    const store = createMemoryStore({ namespace: 'mcp', key });
    try {
      await expect(store.revokeSubject('seat', 'seat-n', { limit: 1 })).rejects.toThrow('no subject descriptor');
    } finally {
      await store.close();
    }
  });
});

describe('subject guard on sqlite store', () => {
  it('refuses issuance until the stored guard allows the subject', async () => {
    const store = createSqliteStore({ path: freshPath(), namespace: 'mcp', key, subjectDescriptor: descriptor });
    try {
      expect(await redeemFor(store, 'code-s-1', 'seat-s', 's1')).toBeUndefined();
      await store.putGuardDocument('seats', 'seat-s', { state: 'active' });
      expect(await redeemFor(store, 'code-s-1', 'seat-s', 's1b')).toBeDefined();
    } finally {
      await store.close();
    }
  });

  it('persists the guard and subject references across reopen, and revokes after reopen', async () => {
    const path = freshPath();
    const first = createSqliteStore({ path, namespace: 'mcp', key, subjectDescriptor: descriptor });
    await first.putGuardDocument('seats', 'seat-p', { state: 'active' });
    expect(await redeemFor(first, 'code-p-1', 'seat-p', 'p1')).toBeDefined();
    await first.close();

    const second = createSqliteStore({ path, namespace: 'mcp', key, subjectDescriptor: descriptor });
    try {
      expect(await second.revokeSubject('seat', 'seat-p', { limit: 10 })).toEqual({ revoked: 1, more: false });
      expect(await second.sessions.get('acc-p1')).toBeUndefined();
    } finally {
      await second.close();
    }
  });
});
