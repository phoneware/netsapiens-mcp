import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { deriveStoreKey } from '../codec.js';
import { createSqliteStore } from '../sqlite.js';

// Schema versioning for the SQLite store. The version lives in PRAGMA user_version.
// Each upgrade step runs in one transaction, and an open never creates tables on
// its own once the file is at the current version.

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): { get(): any; all(): any[] }; close(): void };
};
const key = deriveStoreKey('sqlite-schema-test-secret-0123456789abcdef');
const dirs: string[] = [];
const freshPath = () => { const dir = mkdtempSync(join(tmpdir(), 'sqlite-schema-')); dirs.push(dir); return join(dir, 'store.sqlite'); };
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

function version(path: string): number {
  const db = new DatabaseSync(path);
  try { return db.prepare('PRAGMA user_version').get().user_version; } finally { db.close(); }
}
function tables(path: string): string[] {
  const db = new DatabaseSync(path);
  try { return db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name); } finally { db.close(); }
}
// Edits go through a file the store already created, so its 0600 mode is kept.
function edit(path: string, sql: string): void {
  const db = new DatabaseSync(path);
  try { db.exec(sql); } finally { db.close(); }
}

describe('SQLite schema versioning', () => {
  it('creates a new file at the current version with the subject tables', async () => {
    const path = freshPath();
    const store = createSqliteStore({ path, namespace: 'mcp', key });
    await store.close();
    expect(version(path)).toBe(3);
    expect(tables(path)).toEqual(expect.arrayContaining(['family_subject_refs', 'guard_documents']));
  });

  it('upgrades a version-2 file in place, keeping its data', async () => {
    const path = freshPath();
    const first = createSqliteStore({ path, namespace: 'mcp', key });
    await first.putGuardDocument('seats', 'seat-keep', { state: 'active' });
    await first.close();

    edit(path, 'DROP TABLE family_subject_refs; DROP TABLE guard_documents; PRAGMA user_version=2;');

    const upgraded = createSqliteStore({ path, namespace: 'mcp', key });
    await upgraded.close();
    expect(version(path)).toBe(3);
    expect(tables(path)).toEqual(expect.arrayContaining(['family_subject_refs', 'guard_documents']));
  });

  it('runs no DDL when the file is already at the current version', async () => {
    const path = freshPath();
    const created = createSqliteStore({ path, namespace: 'mcp', key });
    await created.close();
    edit(path, 'DROP TABLE guard_documents;');

    // At version 3 an open must not recreate a missing table on its own.
    const store = createSqliteStore({ path, namespace: 'mcp', key });
    await store.close();
    expect(tables(path)).not.toContain('guard_documents');
  });

  it('leaves a version-2 file unchanged when its upgrade step fails', async () => {
    const path = freshPath();
    const first = createSqliteStore({ path, namespace: 'mcp', key });
    await first.close();

    // A table the upgrade would create already exists at version 2, so the step fails.
    edit(path, 'DROP TABLE family_subject_refs; CREATE TABLE family_subject_refs (x INTEGER) STRICT; PRAGMA user_version=2;');

    expect(() => createSqliteStore({ path, namespace: 'mcp', key })).toThrow();
    expect(version(path)).toBe(2);
  });

  it('refuses a file from a newer schema version', async () => {
    const path = freshPath();
    const created = createSqliteStore({ path, namespace: 'mcp', key });
    await created.close();
    edit(path, 'PRAGMA user_version=4');
    expect(() => createSqliteStore({ path, namespace: 'mcp', key })).toThrow('Unsupported SQLite schema version 4');
  });
});
