import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createMemoryBackend } from '../store/memory.js';
import { createStore, REFRESH_RETRY_WINDOW_MS } from '../store/store.js';
import { deriveStoreKey } from '../store/codec.js';

describe('Historical successor credentials bounding & redaction', () => {
  const secret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const key = deriveStoreKey(secret);

  it('redacts successor ciphertext after retry window during rotation and sweep', async () => {
    const backend = createMemoryBackend();
    const store = createStore(backend, { namespace: `trim_${randomUUID().slice(0, 8)}`, key });

    const tokens1 = { accessToken: `acc_${randomUUID()}`, refreshToken: `ref_${randomUUID()}` };
    const session = await store.sessions.create(tokens1, {
      clientId: 'client-1',
      expiresAt: Date.now() + 3600_000,
      nsAccessToken: 'ns-acc-1',
      nsRefreshToken: 'ns-ref-1',
      nsExpiresAt: Date.now() + 3600_000,
      nsUsername: 'user@example.com',
      nsUserRole: 'admin',
      nsApiUrl: 'https://ns.example.com',
    });

    // 1. Rotate token to create consumed pointer with successorSealed
    const tokens2 = { accessToken: `acc_${randomUUID()}`, refreshToken: `ref_${randomUUID()}` };
    const rotate1 = await store.sessions.rotate(tokens1.refreshToken, { tokens: tokens2, session }, 'client-1', Date.now());
    expect(rotate1.status).toBe('claimed');

    const ref1Id = (backend as any).codec ? (backend as any).codec.id('refresh', tokens1.refreshToken) : Array.from((backend as any).state.refresh.keys())[0];
    const consumedPointer1 = await backend.getRefresh(ref1Id);
    expect(consumedPointer1?.status).toBe('consumed');
    expect(consumedPointer1?.successorSealed).toBeDefined();

    // 2. Advance time past retry window and sweep
    const futureTime = Date.now() + REFRESH_RETRY_WINDOW_MS + 10_000;
    await backend.sweep(futureTime);

    // Verify successorSealed is redacted to undefined
    const sweptPointer = await backend.getRefresh(ref1Id);
    expect(sweptPointer?.status).toBe('consumed');
    expect(sweptPointer?.successorSealed).toBeUndefined();

    // Replay detection still works!
    const replayLookup = await store.sessions.lookupRefresh(tokens1.refreshToken, 'client-1', futureTime);
    expect(replayLookup.status).toBe('replay');

    // Revocation also clears all successorSealed
    const fam = await backend.getFamily(session.refreshFamilyId!);
    expect(fam?.status).toBe('revoked');
    const upstream = await backend.getUpstream(session.refreshFamilyId!);
    expect(upstream).toBeUndefined(); // Upstream credentials deleted on revocation!
  });
});
