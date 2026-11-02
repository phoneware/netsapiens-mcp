import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import axios from 'axios';
import { createApp } from '../http-server.js';
import { createMemoryBackend } from '../store/memory.js';
import { createStore, upstreamAad } from '../store/store.js';
import { createCodec, deriveStoreKey } from '../store/codec.js';

describe('/token HTTP interleaving: stale lease-stolen race protection', () => {
  const secret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const key = deriveStoreKey(secret);
  const codec = createCodec(key);

  it('proves that a stale rejection on /token does NOT revoke the family if lease was claimed by peer before commit', async () => {
    process.env.MCP_TRANSPORT = 'http';
    process.env.NETSAPIENS_OAUTH_CLIENT_ID = 'test-client';
    process.env.NETSAPIENS_OAUTH_CLIENT_SECRET = 'test-secret';
    process.env.NETSAPIENS_API_URL = 'https://ns.example.com';

    const backend = createMemoryBackend();
    const store = createStore(backend, { namespace: `interleave_${randomUUID().slice(0, 8)}`, key });
    const { app } = await createApp({ store });

    const client = await store.clients.registerClient({
      client_name: 'Test Client',
      redirect_uris: ['http://localhost/cb'],
      token_endpoint_auth_method: 'none',
    } as any);

    const tokens = { accessToken: `acc_${randomUUID()}`, refreshToken: `ref_${randomUUID()}` };
    const session = await store.sessions.create(tokens, {
      clientId: client.client_id,
      expiresAt: Date.now() + 3600_000,
      nsAccessToken: 'ns-acc-1',
      nsRefreshToken: 'ns-ref-1',
      nsExpiresAt: Date.now() - 1000, // Upstream expired, triggers refreshUpstream
      nsUsername: 'user@example.com',
      nsUserRole: 'admin',
      nsApiUrl: 'https://ns.example.com',
    });

    const familyId = session.refreshFamilyId!;

    // Node A calls /token. While Axios is in flight, Peer B claims the lease (leaseOwner becomes ownerB)
    // but Peer B has NOT committed grantVersion 2 yet!
    const ownerB = 'peer-b-lease-owner';
    const axiosSpy = vi.spyOn(axios, 'post').mockImplementationOnce(async () => {
      // Peer B claims the lease before Node A's call returns!
      await backend.updateUpstream(familyId, (cur) => ({
        ...cur,
        leaseOwner: ownerB,
        leaseUntil: Date.now() + 10_000,
      }));

      // Node A's call fails with 400 invalid_grant
      const err: any = new Error('Request failed with status code 400');
      err.isAxiosError = true;
      err.response = { status: 400, data: { error: 'invalid_grant', error_description: 'Token revoked' } };
      throw err;
    });

    // Node A's /token request executes
    const res = await request(app)
      .post('/token')
      .send(`grant_type=refresh_token&refresh_token=${tokens.refreshToken}&client_id=${client.client_id}`);

    expect(axiosSpy).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(400);

    // CRITICAL ASSERTION: The family MUST NOT BE REVOKED by Node A's stale rejection!
    // If provider had an unfenced second revokeFamily, the family was wrongly revoked.
    const family = await backend.getFamily(familyId);
    expect(family?.status).toBe('active');

    // Peer B then commits grantVersion 2 with its new token
    const newSealed = codec.seal({
      nsAccessToken: 'ns-acc-peer-winner',
      nsRefreshToken: 'ns-ref-peer-winner',
      nsUsername: 'user@example.com',
      nsUserRole: 'admin',
      nsApiUrl: 'https://ns.example.com',
    }, upstreamAad({ id: familyId, grantVersion: 2 }));

    await backend.updateUpstream(familyId, (cur) => ({
      ...cur,
      grantVersion: 2,
      sealed: newSealed,
      leaseOwner: undefined,
      leaseUntil: undefined,
    }));

    // Verify family and peer B's grant survive
    const finalFamily = await backend.getFamily(familyId);
    expect(finalFamily?.status).toBe('active');
    const finalUpstream = await backend.getUpstream(familyId);
    expect(finalUpstream?.grantVersion).toBe(2);
  });

  it('proves that a definitive rejection on true owner DOES revoke the family and credentials', async () => {
    process.env.MCP_TRANSPORT = 'http';
    process.env.NETSAPIENS_OAUTH_CLIENT_ID = 'test-client';
    process.env.NETSAPIENS_OAUTH_CLIENT_SECRET = 'test-secret';
    process.env.NETSAPIENS_API_URL = 'https://ns.example.com';

    const backend = createMemoryBackend();
    const store = createStore(backend, { namespace: `clean_rej_${randomUUID().slice(0, 8)}`, key });
    const { app } = await createApp({ store });

    const client = await store.clients.registerClient({
      client_name: 'Test Client',
      redirect_uris: ['http://localhost/cb'],
      token_endpoint_auth_method: 'none',
    } as any);

    const tokens = { accessToken: `acc_${randomUUID()}`, refreshToken: `ref_${randomUUID()}` };
    const session = await store.sessions.create(tokens, {
      clientId: client.client_id,
      expiresAt: Date.now() + 3600_000,
      nsAccessToken: 'ns-acc-1',
      nsRefreshToken: 'ns-ref-1',
      nsExpiresAt: Date.now() - 1000,
      nsUsername: 'user@example.com',
      nsUserRole: 'admin',
      nsApiUrl: 'https://ns.example.com',
    });

    const familyId = session.refreshFamilyId!;

    // True owner refresh fails with 400 invalid_grant without any concurrent peer
    vi.spyOn(axios, 'post').mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 400, data: { error: 'invalid_grant', error_description: 'Token revoked' } },
    });

    const res = await request(app)
      .post('/token')
      .send(`grant_type=refresh_token&refresh_token=${tokens.refreshToken}&client_id=${client.client_id}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');

    // On true owner, store cleanly revokes the family and deletes upstream credentials!
    const family = await backend.getFamily(familyId);
    expect(family?.status).toBe('revoked');
    const upstream = await backend.getUpstream(familyId);
    expect(upstream).toBeUndefined();
  });
});
