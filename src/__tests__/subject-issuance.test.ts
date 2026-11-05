import { describe, expect, it } from 'vitest';
import { NetSapiensAuthProvider } from '../auth/netsapiens-auth-provider.js';
import { deriveStoreKey } from '../store/codec.js';
import { createMemoryStore } from '../store/memory.js';
import type { McpStore } from '../store/types.js';

// Subject issuance wiring on the real provider. The provider accepts a subject
// resolver only with the atomic redeem path and subject-guard support, and refuses
// to start otherwise, so no issuance can silently lose its guard.

const key = deriveStoreKey('subject-issuance-test-secret-0123456789abcdef');
const base = {
  nsApiUrl: 'https://ns.example.test',
  platforms: [] as const,
  nsClientId: 'client-id',
  nsClientSecret: 'client-secret',
  serverBaseUrl: 'https://mcp.example.test',
};
const resolver = () => undefined;

describe('subject issuance wiring on the provider', () => {
  it('accepts a resolver on an atomic store that supports subject guards', () => {
    const store = createMemoryStore({ namespace: 'mcp', key });
    expect(() => new NetSapiensAuthProvider({ ...base, store, subjectForIssuance: resolver })).not.toThrow();
  });

  it('refuses a resolver on a store without atomic code redemption', () => {
    const store = createMemoryStore({ namespace: 'mcp', key });
    const nonAtomic = { ...store, authCodes: { ...store.authCodes, redeemAndIssue: undefined, getEntry: undefined } } as unknown as McpStore;
    expect(() => new NetSapiensAuthProvider({ ...base, store: nonAtomic, subjectForIssuance: resolver }))
      .toThrow('atomic code redemption');
  });

  it('refuses a resolver on a store without subject-guard support', () => {
    const store = createMemoryStore({ namespace: 'mcp', key });
    const noGuards = { ...store, capabilities: { ...store.capabilities, subjectGuards: false } } as unknown as McpStore;
    expect(() => new NetSapiensAuthProvider({ ...base, store: noGuards, subjectForIssuance: resolver }))
      .toThrow('subject guards');
  });
});
