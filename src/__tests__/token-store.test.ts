import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TokenStore } from '../auth/token-store.js';
import type { StoredToken } from '../auth/token-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToken(overrides?: Partial<StoredToken>): StoredToken {
  return {
    accessToken: 'at-' + Math.random().toString(36).slice(2),
    refreshToken: 'rt-' + Math.random().toString(36).slice(2),
    clientId: 'client-1',
    expiresAt: Date.now() + 3600_000,
    nsAccessToken: 'ns-at',
    nsRefreshToken: 'ns-rt',
    nsUsername: 'testuser',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TokenStore', () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'token-store-test-'));
    storePath = join(tempDir, 'tokens.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('stores and retrieves tokens by access token', () => {
    const store = new TokenStore(storePath);
    const token = makeToken();

    store.set(token);
    expect(store.get(token.accessToken)).toEqual(token);
  });

  it('stores and retrieves tokens by refresh token', () => {
    const store = new TokenStore(storePath);
    const token = makeToken();

    store.set(token);
    expect(store.getByRefreshToken(token.refreshToken)).toEqual(token);
  });

  it('returns undefined for missing tokens', () => {
    const store = new TokenStore(storePath);

    expect(store.get('nonexistent')).toBeUndefined();
    expect(store.getByRefreshToken('nonexistent')).toBeUndefined();
  });

  it('deletes tokens by access token', () => {
    const store = new TokenStore(storePath);
    const token = makeToken();

    store.set(token);
    store.delete(token.accessToken);

    expect(store.get(token.accessToken)).toBeUndefined();
    expect(store.getByRefreshToken(token.refreshToken)).toBeUndefined();
  });

  it('deletes tokens by refresh token', () => {
    const store = new TokenStore(storePath);
    const token = makeToken();

    store.set(token);
    store.deleteByRefreshToken(token.refreshToken);

    expect(store.get(token.accessToken)).toBeUndefined();
    expect(store.getByRefreshToken(token.refreshToken)).toBeUndefined();
  });

  it('reports correct size', () => {
    const store = new TokenStore(storePath);
    expect(store.size).toBe(0);

    store.set(makeToken());
    expect(store.size).toBe(1);

    store.set(makeToken());
    expect(store.size).toBe(2);
  });

  it('persists tokens to disk', () => {
    const token = makeToken();

    // Write
    const store1 = new TokenStore(storePath);
    store1.set(token);
    expect(existsSync(storePath)).toBe(true);

    // Read back with a new instance
    const store2 = new TokenStore(storePath);
    expect(store2.get(token.accessToken)).toEqual(token);
    expect(store2.getByRefreshToken(token.refreshToken)).toEqual(token);
  });

  it('sets file permissions to 0o600', () => {
    const store = new TokenStore(storePath);
    store.set(makeToken());

    const stats = statSync(storePath);
    // Check owner read/write only (0o600 = 33152 in decimal on most systems)
    const mode = stats.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('creates parent directory if missing', () => {
    const nestedPath = join(tempDir, 'nested', 'dir', 'tokens.json');
    const store = new TokenStore(nestedPath);
    store.set(makeToken());

    expect(existsSync(nestedPath)).toBe(true);
  });

  it('cleans up expired tokens', () => {
    const store = new TokenStore(storePath);

    const expired = makeToken({ expiresAt: Date.now() - 1000 });
    const valid = makeToken({ expiresAt: Date.now() + 3600_000 });

    store.set(expired);
    store.set(valid);
    expect(store.size).toBe(2);

    store.cleanup();
    expect(store.size).toBe(1);
    expect(store.get(expired.accessToken)).toBeUndefined();
    expect(store.get(valid.accessToken)).toEqual(valid);
  });

  it('handles corrupt file gracefully', () => {
    // Write garbage to the file
    const { writeFileSync, mkdirSync } = require('node:fs');
    const dir = require('node:path').dirname(storePath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(storePath, 'not-json{{{');

    // Should not throw, starts with empty store
    const store = new TokenStore(storePath);
    expect(store.size).toBe(0);
  });

  it('stores nsUserRole when provided', () => {
    const store = new TokenStore(storePath);
    const token = makeToken({ nsUserRole: 'domain_admin' });

    store.set(token);

    const retrieved = store.get(token.accessToken);
    expect(retrieved?.nsUserRole).toBe('domain_admin');
  });

  it('survives delete of nonexistent token', () => {
    const store = new TokenStore(storePath);
    // Should not throw
    store.delete('nonexistent');
    store.deleteByRefreshToken('nonexistent');
  });
});
