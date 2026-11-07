import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import axios from 'axios';
import { NetSapiensAuthProvider } from '../auth/netsapiens-auth-provider.js';
import { createMemoryBackend } from '../store/memory.js';
import { createStore, upstreamAad } from '../store/store.js';
import { createCodec, deriveStoreKey } from '../store/codec.js';

describe('Stale-grant conditional revocation protection', () => {
  const secret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const key = deriveStoreKey(secret);
  const codec = createCodec(key);

  it('forceRefreshUpstream does not revoke newer grant when peer won race while refresh was in flight', async () => {
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

    // When axios.post is called by Node A, simulate peer B winning the race and committing grantVersion 2
    const axiosSpy = vi.spyOn(axios, 'post').mockImplementationOnce(async () => {
      // Peer B commits grantVersion 2 with valid sealed data
      const peerSealed = codec.seal({
        nsAccessToken: 'ns-acc-peer-winner',
        nsRefreshToken: 'ns-ref-peer-winner',
        nsUsername: 'user@example.com',
        nsUserRole: 'admin',
        nsApiUrl: 'https://ns.example.com',
      }, upstreamAad({ id: familyId, grantVersion: 2 }));

      await backend.updateUpstream(familyId, (cur) => ({
        ...cur,
        grantVersion: 2,
        sealed: peerSealed,
        leaseOwner: undefined,
        leaseUntil: undefined,
      }));

      // Node A's old refresh token was rejected by NetSapiens as 400 invalid_grant
      const err: any = new Error('Request failed with status code 400');
      err.isAxiosError = true;
      err.response = { status: 400, data: { error: 'invalid_grant', error_description: 'Token revoked' } };
      throw err;
    });

    // Run forceRefreshUpstream on Node A
    const result = await provider.forceRefreshUpstream(tokens.accessToken);
    expect(result).toBeUndefined();

    // Verify axios WAS actually called (non-vacuous!)
    expect(axiosSpy).toHaveBeenCalledTimes(1);

    // Verify family is STILL ACTIVE and was NOT revoked because grantVersion was 2 (peer won!)
    const family = await backend.getFamily(familyId);
    expect(family).toBeDefined();
    expect(family?.status).toBe('active');

    // Upstream grant is intact with peer's winning token and version 2
    const upstream = await backend.getUpstream(familyId);
    expect(upstream).toBeDefined();
    expect(upstream?.grantVersion).toBe(2);
    const decodedUpstream = codec.open<any>(upstream!.sealed, upstreamAad({ id: familyId, grantVersion: 2 }));
    expect(decodedUpstream.nsAccessToken).toBe('ns-acc-peer-winner');
  });

  it('rejects revocation when lease was stolen by another instance before commit', async () => {
    const backend = createMemoryBackend();
    const store = createStore(backend, { namespace: `stale_lease_${randomUUID().slice(0, 8)}`, key });

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
    const ownerA = 'lease-owner-node-a';
    const ownerB = 'lease-owner-node-b';

    // Node A acquired lease
    await backend.updateUpstream(familyId, (cur) => ({
      ...cur,
      leaseOwner: ownerA,
      leaseUntil: Date.now() + 5000,
    }));

    // Lease expires / Node B steals lease
    await backend.updateUpstream(familyId, (cur) => ({
      ...cur,
      leaseOwner: ownerB,
      leaseUntil: Date.now() + 5000,
    }));

    // Node A attempts revocation with expectedLeaseOwner: ownerA
    const revokeOutcome = await backend.atomicRevokeFamily(familyId, {
      expectedFamilyGeneration: 1,
      expectedUpstreamGrantVersion: 1,
      expectedLeaseOwner: ownerA,
    });

    // Revocation rejected as stale because lease was stolen by ownerB!
    expect(revokeOutcome).toBe('stale');

    const family = await backend.getFamily(familyId);
    expect(family?.status).toBe('active');
  });
});
