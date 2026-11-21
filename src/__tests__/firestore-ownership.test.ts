import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStoreFromEnv } from '../config/store.js';
import { createFirestoreStore, type FirestoreLike } from '../store/firestore.js';
import { deriveStoreKey } from '../store/codec.js';
import { startHttpServer } from '../http-server.js';
import * as version from '../netsapiens/version.js';

const mocks = vi.hoisted(() => ({
  terminate: vi.fn(),
  collection: vi.fn(),
}));

vi.mock('@google-cloud/firestore', () => ({
  Firestore: class {
    collection = mocks.collection;
    terminate = mocks.terminate;
  },
}));

const secret = 'firestore-ownership-test-secret-0123456789';
const env = { MCP_PERSISTENCE: 'firestore', MCP_SESSION_SECRET: secret, GOOGLE_CLOUD_PROJECT: 'fake-project' };

beforeEach(() => {
  mocks.terminate.mockReset().mockResolvedValue(undefined);
  mocks.collection.mockReset().mockReturnValue({});
});

describe('Firestore client ownership', () => {
  it('terminates the factory-owned client once for concurrent store and factory closes', async () => {
    const gate = Promise.withResolvers<void>();
    mocks.terminate.mockReturnValueOnce(gate.promise);
    const result = await createStoreFromEnv(env);
    let completed = false;
    const first = result.close().then(() => { completed = true; });
    const second = result.store.close();
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.terminate).toHaveBeenCalledTimes(1);
    expect(completed).toBe(false);
    gate.resolve();
    await Promise.all([first, second]);
    await result.close();
    expect(mocks.terminate).toHaveBeenCalledTimes(1);
  });

  it('terminates the factory-owned client when its HTTP listener closes', async () => {
    const keys = ['MCP_TRANSPORT', 'MCP_PORT', 'MCP_HOST', 'MCP_BASE_URL', 'MCP_PERSISTENCE', 'MCP_SESSION_SECRET', 'MCP_MFA_REPLAY_AUDIENCE', 'GOOGLE_CLOUD_PROJECT', 'NETSAPIENS_API_URL', 'NETSAPIENS_OAUTH_CLIENT_ID', 'NETSAPIENS_OAUTH_CLIENT_SECRET'] as const;
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    const warm = vi.spyOn(version, 'warmVersionCache').mockResolvedValue();
    try {
      Object.assign(process.env, {
        MCP_TRANSPORT: 'http', MCP_PORT: '0', MCP_HOST: '127.0.0.1', MCP_BASE_URL: 'http://localhost',
        MCP_PERSISTENCE: 'firestore', MCP_SESSION_SECRET: secret, MCP_MFA_REPLAY_AUDIENCE: 'owned-http',
        GOOGLE_CLOUD_PROJECT: 'fake-project', NETSAPIENS_API_URL: 'https://netsapiens.example.com',
        NETSAPIENS_OAUTH_CLIENT_ID: 'client', NETSAPIENS_OAUTH_CLIENT_SECRET: 'secret',
      });
      const server = await startHttpServer();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await vi.waitFor(() => expect(mocks.terminate).toHaveBeenCalledTimes(1));
    } finally {
      warm.mockRestore();
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });

  it('propagates a termination failure and does not retry teardown', async () => {
    const error = new Error('terminate failed');
    mocks.terminate.mockRejectedValueOnce(error);
    const result = await createStoreFromEnv(env);
    await expect(result.store.close()).rejects.toBe(error);
    await expect(result.close()).rejects.toBe(error);
    expect(mocks.terminate).toHaveBeenCalledTimes(1);
  });

  it('terminates an allocated client if store initialization fails, preserving the original error', async () => {
    const error = new Error('collection initialization failed');
    mocks.collection.mockImplementationOnce(() => { throw error; });
    mocks.terminate.mockRejectedValueOnce(new Error('termination failed'));
    await expect(createStoreFromEnv(env)).rejects.toBe(error);
    expect(mocks.terminate).toHaveBeenCalledTimes(1);
  });

  it('leaves a library caller-supplied Firestore client open', async () => {
    const terminate = vi.fn();
    const borrowed = { collection: vi.fn().mockReturnValue({}), runTransaction: vi.fn(), terminate };
    const store = createFirestoreStore({ db: borrowed as unknown as FirestoreLike, namespace: 'borrowed', key: deriveStoreKey(secret) });
    await store.close();
    expect(terminate).not.toHaveBeenCalled();
  });
});
