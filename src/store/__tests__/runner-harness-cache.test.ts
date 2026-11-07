import { describe, expect, it } from 'vitest';
import { fixtureFor } from './support/runner-harness.mjs';

describe('signed runner fixture cache', () => {
  it('does not reuse a signature across different collection-group sets', () => {
    const input = { bundleBytes: Buffer.from('synthetic bundle'), namespace: 'mcp', epoch: 2, nonce: 'cache-test' };
    const first = fixtureFor({ ...input, collectionGroups: ['mcp_one'] });
    const second = fixtureFor({ ...input, collectionGroups: ['mcp_two'] });
    expect(first.index.binding.collectionGroups).toEqual(['mcp_one']);
    expect(second.index.binding.collectionGroups).toEqual(['mcp_two']);
    expect(first.request.approvalPayloadSha256).not.toBe(second.request.approvalPayloadSha256);
    expect(fixtureFor({ ...input, collectionGroups: ['mcp_one'] })).toBe(first);
  });
});
