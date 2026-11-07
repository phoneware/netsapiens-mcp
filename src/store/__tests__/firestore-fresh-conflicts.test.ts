import { describe, expect, it, vi } from 'vitest';
import { assertNoFreshDatabaseConflicts, type FreshDatabaseInventory } from '../firestore-fresh-conflicts.js';

const root = 'projects/example-project/databases/test-database/documents';

describe('fresh database conflict scan', () => {
  it('reads every collection page with showMissing and follows empty document pages', async () => {
    const listCollectionIds = vi.fn(async (_parent: string, token?: string) => token
      ? { collectionIds: ['second'] } : { collectionIds: ['first'], nextPageToken: 'more-collections' });
    const listDocuments = vi.fn(async (_parent: string, collection: string, options: { showMissing: true; pageToken?: string }) =>
      collection === 'first' && !options.pageToken ? { nextPageToken: 'more-documents' } : {});
    await expect(assertNoFreshDatabaseConflicts({ listCollectionIds, listDocuments }, root)).resolves.toBeUndefined();
    expect(listCollectionIds).toHaveBeenCalledTimes(2);
    expect(listDocuments).toHaveBeenCalledTimes(3);
    expect(listDocuments.mock.calls.every(([, , options]) => options.showMissing === true)).toBe(true);
  });

  it.each([
    ['existing document', { name: `${root}/group/doc`, fields: {} }],
    ['missing parent with descendants', { name: `${root}/group/missing` }],
  ])('refuses an %s even without fields', async (_label, document) => {
    const inventory: FreshDatabaseInventory = {
      listCollectionIds: async () => ({ collectionIds: ['group'] }),
      listDocuments: async () => ({ documents: [document] }),
    };
    await expect(assertNoFreshDatabaseConflicts(inventory, root)).rejects.toThrow('not empty');
  });

  it('fails closed on malformed pages, invalid names, repeated pages and read failures', async () => {
    for (const response of [null, [], { collectionIds: 'group' }, { collectionIds: [''] }, { collectionIds: ['a/b'] }, { nextPageToken: '' }]) {
      const inventory: FreshDatabaseInventory = { listCollectionIds: async () => response, listDocuments: async () => ({}) };
      await expect(assertNoFreshDatabaseConflicts(inventory, root)).rejects.toThrow();
    }
    const repeated: FreshDatabaseInventory = {
      listCollectionIds: async () => ({ nextPageToken: 'again' }), listDocuments: async () => ({}),
    };
    await expect(assertNoFreshDatabaseConflicts(repeated, root)).rejects.toThrow('Repeated');
    const unreadable: FreshDatabaseInventory = {
      listCollectionIds: async () => ({ collectionIds: ['group'] }),
      listDocuments: async () => { throw new Error('permission denied'); },
    };
    await expect(assertNoFreshDatabaseConflicts(unreadable, root)).rejects.toThrow('permission denied');
    await expect(assertNoFreshDatabaseConflicts(repeated, 'not-a-database')).rejects.toThrow('Invalid');
  });
});
