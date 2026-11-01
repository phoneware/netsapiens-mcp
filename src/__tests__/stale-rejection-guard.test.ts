import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import axios from 'axios';
import { NetSapiensAuthProvider } from '../auth/netsapiens-auth-provider.js';
import { createMemoryBackend } from '../store/memory.js';
import { createStore } from '../store/store.js';
import { deriveStoreKey } from '../store/codec.js';

describe('Stale-grant conditional revocation protection', () => {
  const secret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const key = deriveStoreKey(secret);

  it('forceRefreshUpstream does not revoke newer grant when peer won a race', async () => {
    const backend = createMemoryBackend();
    const store = createStore(backend, { namespace: `stale_test_${randomUUID().slice(0, 8)}`, key });
    const provider = new NetSapiensAuthProvider({
      platforms: [{ id: 'default', label: 'Default', apiUrl: 'https://ns.example.com' }],
      nsApiUrl: 'https://ns.example.com',
      nsClientId: 'test-client',
      nsClientSecret: 'test-secret',
      serverBaseUrl: 'http://localhost:3000',
      store,
    });

    const tokens = { accessToken: `acc_${randomUUID()}`, refreshToken: `ref_${randomUUID()}` };
    const session = await store.sessions.create(tokens, {
      clientId: 'client-1',
      expiresAt: Date.now() + 3600_000,
      nsAccessToken: 'ns-acc-1',
      nsRefreshToken: 'ns-ref-1',
      nsExpiresAt: Date.now() - 1000,
      nsUsername: 'user@example.com',
      nsUserRole: 'admin',
      nsApiUrl: 'https://ns.example.com',
    });

    const familyId = session.refreshFamilyId!;

    // Peer bumps grant version to 2
    await backend.updateUpstream(familyId, (cur: any) => ({
      ...cur,
      grantVersion: 2,
      nsAccessToken: 'ns-acc-peer-winner',
    }));

    // Local node had lease expired and rejected with 400 invalid_grant
    vi.spyOn(axios, 'post').mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 400, data: { error: 'invalid_grant' } },
    });

    // Run forceRefreshUpstream
    const result = await provider.forceRefreshUpstream(tokens.accessToken);
    expect(result).toBeUndefined();

    // Verify family is STILL ACTIVE and was NOT revoked because grantVersion was bumped by peer!
    const family = await backend.getFamily(familyId);
    expect(family).toBeDefined();
    expect(family?.status).toBe('active');

    // Upstream grant is still intact with peer's winning token
    const upstream = await backend.getUpstream(familyId);
    expect(upstream).toBeDefined();
    expect(upstream?.grantVersion).toBe(2);
  });
});
