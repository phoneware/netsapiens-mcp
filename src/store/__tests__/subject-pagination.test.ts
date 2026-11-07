import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { deriveStoreKey } from '../codec.js';
import { createMemoryStore } from '../memory.js';
import { createSqliteStore } from '../sqlite.js';
import type { SubjectDescriptor } from '../subject-descriptor.js';
import type { AuthCodeData, McpStore, StoredToken } from '../types.js';

// Bounded subject revocation past one page, and repeated SQLite reopens of a version-3 file.
// The store is constructed with the bound flat descriptor, as the runtime does.

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => { prepare(sql: string): { get(): any }; close(): void };
};
const key = deriveStoreKey('subject-pagination-test-secret-0123456789abcdef');
const descriptor: SubjectDescriptor = { allow: ['active'], collection: 'seats', extraKey: 'seat', field: 'state' };
const dirs: string[] = [];
const freshPath = () => { const dir = mkdtempSync(join(tmpdir(), 'subject-pagination-')); dirs.push(dir); return join(dir, 'store.sqlite'); };
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const guard = (documentId: string) => ({ collection: 'seats', documentId, field: 'state', allow: ['active'] });
const stored = {
  clientId: 'c', expiresAt: Date.now() + 60_000, nsAccessToken: 'ns-a', nsRefreshToken: 'ns-r',
  nsExpiresAt: Date.now() + 3_600_000, nsUsername: 'alice', serverBaseUrl: 'http://localhost:3000',
} as unknown as StoredToken;

async function issue(store: McpStore, seat: string, n: number): Promise<void> {
  const code = `code-${seat}-${n}`;
  await store.authCodes.put(code, { clientId: 'c', pending: { clientId: 'c' }, nsTokens: {} } as unknown as AuthCodeData);
  const redeemed = await store.authCodes.redeemAndIssue(
    code,
    { clientId: 'c' },
    { accessToken: `acc-${seat}-${n}`, refreshToken: `ref-${seat}-${n}` },
    stored,
    undefined,
    { extraKey: 'seat', value: seat, guard: guard(seat) },
  );
  expect(redeemed).toBeDefined();
}

function version(path: string): number {
  const db = new DatabaseSync(path);
  try { return db.prepare('PRAGMA user_version').get().user_version; } finally { db.close(); }
}

describe('subject revocation past one page on memory store', () => {
  it('revokes more active families than one page, one bounded page per call', async () => {
    const store = createMemoryStore({ namespace: 'mcp', key, subjectDescriptor: descriptor });
    try {
      await store.putGuardDocument('seats', 'seat-m', { state: 'active' });
      for (let n = 1; n <= 5; n++) await issue(store, 'seat-m', n);
      expect(await store.revokeSubject('seat', 'seat-m', { limit: 2 })).toEqual({ revoked: 2, more: true });
      expect(await store.revokeSubject('seat', 'seat-m', { limit: 2 })).toEqual({ revoked: 2, more: true });
      expect(await store.revokeSubject('seat', 'seat-m', { limit: 2 })).toEqual({ revoked: 1, more: false });
      expect(await store.revokeSubject('seat', 'seat-m', { limit: 2 })).toEqual({ revoked: 0, more: false });
      for (let n = 1; n <= 5; n++) expect(await store.sessions.get(`acc-seat-m-${n}`)).toBeUndefined();
    } finally {
      await store.close();
    }
  });
});

describe('subject revocation past one page on sqlite store', () => {
  it('revokes more active families than one page, one bounded page per call', async () => {
    const store = createSqliteStore({ path: freshPath(), namespace: 'mcp', key, subjectDescriptor: descriptor });
    try {
      await store.putGuardDocument('seats', 'seat-s', { state: 'active' });
      for (let n = 1; n <= 5; n++) await issue(store, 'seat-s', n);
      expect(await store.revokeSubject('seat', 'seat-s', { limit: 2 })).toEqual({ revoked: 2, more: true });
      expect(await store.revokeSubject('seat', 'seat-s', { limit: 2 })).toEqual({ revoked: 2, more: true });
      expect(await store.revokeSubject('seat', 'seat-s', { limit: 2 })).toEqual({ revoked: 1, more: false });
      expect(await store.revokeSubject('seat', 'seat-s', { limit: 2 })).toEqual({ revoked: 0, more: false });
      for (let n = 1; n <= 5; n++) expect(await store.sessions.get(`acc-seat-s-${n}`)).toBeUndefined();
    } finally {
      await store.close();
    }
  });
});

describe('sqlite version-3 file across repeated reopens', () => {
  it('keeps version 3 and its subject data over several opens, and revokes once', async () => {
    const path = freshPath();
    const first = createSqliteStore({ path, namespace: 'mcp', key, subjectDescriptor: descriptor });
    await first.putGuardDocument('seats', 'seat-r', { state: 'active' });
    await issue(first, 'seat-r', 1);
    await first.close();

    expect(version(path)).toBe(3);
    for (let open = 0; open < 3; open++) {
      const store = createSqliteStore({ path, namespace: 'mcp', key, subjectDescriptor: descriptor });
      try {
        const expected = open === 0 ? { revoked: 1, more: false } : { revoked: 0, more: false };
        expect(await store.revokeSubject('seat', 'seat-r', { limit: 10 })).toEqual(expected);
      } finally {
        await store.close();
      }
      expect(version(path)).toBe(3);
    }
  });
});
