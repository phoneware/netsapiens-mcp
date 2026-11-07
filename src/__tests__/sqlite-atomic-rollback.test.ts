import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSqliteBackend } from '../store/sqlite.js';
import { deriveStoreKey } from '../store/codec.js';
import type { AtomicIssueParams } from '../store/types.js';

describe('SQLite atomicIssue rollback integrity', () => {
  const secret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const key = deriveStoreKey(secret);

  it('rolls back all table inserts when a failure occurs on upstream_grants insert', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nsmcp-atomic-rollback-'));
    const path = join(dir, 'store.db');

    const backend = createSqliteBackend({ path, namespace: 'test', key });

    // Install trigger on upstream_grants that aborts with an error
    (backend as any).db.exec("CREATE TRIGGER fail_upstream BEFORE INSERT ON upstream_grants BEGIN SELECT RAISE(ABORT, 'forced upstream failure'); END;");

    const familyId = randomUUID();
    const accessId = 'a'.repeat(64);
    const refreshId = 'b'.repeat(64);

    const params: AtomicIssueParams = {
      accessRow: { id: accessId, familyId, expiresAt: Date.now() + 3600_000, retainUntil: Date.now() + 86400_000, sealed: 'sealed-acc' },
      refreshRow: { id: refreshId, familyId, status: 'active', generation: 1 },
      familyRow: { id: familyId, generation: 1, status: 'active', activeRefreshId: refreshId, currentAccessTokenId: accessId, updatedAt: Date.now(), sealed: 'sealed-fam' },
      upstreamRow: { id: familyId, grantVersion: 1, updatedAt: Date.now(), sealed: 'sealed-up' },
    };

    // atomicIssue should synchronously throw the error from the trigger
    await expect(backend.atomicIssue(params)).rejects.toThrow('forced upstream failure');

    // Verify all four tables are completely empty (clean rollback)
    const accessCount = ((backend as any).db.prepare('SELECT count(*) as count FROM sessions').get() as any).count;
    const refreshCount = ((backend as any).db.prepare('SELECT count(*) as count FROM refresh_tokens').get() as any).count;
    const familyCount = ((backend as any).db.prepare('SELECT count(*) as count FROM refresh_families').get() as any).count;
    const upstreamCount = ((backend as any).db.prepare('SELECT count(*) as count FROM upstream_grants').get() as any).count;

    expect(accessCount).toBe(0);
    expect(refreshCount).toBe(0);
    expect(familyCount).toBe(0);
    expect(upstreamCount).toBe(0);

    await backend.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
