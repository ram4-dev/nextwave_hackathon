import { describe, expect, it } from 'vitest';
import { DeterministicEmbeddingProvider } from '../../src/catalog/embedding.js';
import { catalogItemId, MemoryAcpCatalogStore } from '../../src/catalog/ingestion.js';
import { ReindexWorker } from '../../src/catalog/reindex-worker.js';

function pendingJob(store: MemoryAcpCatalogStore, overrides: Partial<MemoryAcpCatalogStore['outbox'][number]> = {}) {
  const job = {
    id: overrides.id ?? `job_${store.outbox.length + 1}`,
    item_id: overrides.item_id ?? 'feed::prod::var',
    feed_id: overrides.feed_id ?? 'feed',
    external_product_id: overrides.external_product_id ?? 'prod',
    external_variant_id: overrides.external_variant_id ?? 'var',
    search_revision: overrides.search_revision ?? 1,
    operation: overrides.operation ?? 'upsert',
    status: overrides.status ?? 'pending',
    attempts: overrides.attempts ?? 0,
    lease_until: overrides.lease_until,
    last_error: overrides.last_error,
  } as MemoryAcpCatalogStore['outbox'][number];
  store.outbox.push(job);
  return job;
}

describe('catalog reindex worker', () => {
  it('claims one pending job with a lease and publishes the searchable document', async () => {
    const store = new MemoryAcpCatalogStore();
    store.products.set('feed', new Map([
      [
        'prod',
        {
          id: 'prod',
          title: 'Bastones crocantes',
          description: { plain: 'Snack de papa' },
          variants: [
            {
              id: 'var',
              title: '200g',
              description: { plain: 'Porción familiar' },
              categories: [{ value: 'snacks' }],
              price: { amount: 2100, currency: 'ARS' },
            },
          ],
        },
      ],
    ]));
    store.revisions.set(catalogItemId('feed', 'prod', 'var'), {
      data_revision: 1,
      search_revision: 1,
      index_revision: 0,
      tombstoned: false,
    });
    pendingJob(store, { item_id: catalogItemId('feed', 'prod', 'var'), search_revision: 1 });
    const worker = new ReindexWorker(store, new DeterministicEmbeddingProvider(), { leaseMs: 5_000, maxAttempts: 3 });

    const processed = await worker.processNext();
    expect(processed).toBe(true);
    expect(store.outbox[0]?.status).toBe('done');
    expect(store.documents.get(catalogItemId('feed', 'prod', 'var'))?.index_revision).toBe(1);
    expect(store.getVariantRevisions('feed', 'prod', 'var').index_revision).toBe(1);
    const document = store.documents.get(catalogItemId('feed', 'prod', 'var'))!;
    expect(JSON.stringify({ ...document, embedding: undefined })).not.toMatch(/2100|ARS|merchant/);
  });

  it('does not let two workers claim the same leased job', async () => {
    const store = new MemoryAcpCatalogStore();
    pendingJob(store, { id: 'shared' });
    const first = new ReindexWorker(store, new DeterministicEmbeddingProvider(), { leaseMs: 30_000 });
    const second = new ReindexWorker(store, new DeterministicEmbeddingProvider(), { leaseMs: 30_000 });
    const claimed = first.claimNext();
    expect(claimed?.id).toBe('shared');
    expect(second.claimNext()).toBeUndefined();
    expect(store.outbox[0]?.status).toBe('leased');
  });

  it('retries failed embeddings and dead-letters without reverting hard data', async () => {
    const store = new MemoryAcpCatalogStore();
    store.products.set('feed', new Map([
      ['prod', { id: 'prod', title: 'Leche', variants: [{ id: 'var', title: '1L', price: { amount: 1800, currency: 'ARS' } }] }],
    ]));
    store.revisions.set(catalogItemId('feed', 'prod', 'var'), {
      data_revision: 4,
      search_revision: 3,
      index_revision: 2,
      tombstoned: false,
    });
    pendingJob(store, {
      item_id: catalogItemId('feed', 'prod', 'var'),
      search_revision: 3,
    });
    let calls = 0;
    let now = 1_700_000_000_000;
    const worker = new ReindexWorker(
      store,
      {
        model: 'test-deterministic-384',
        dimensions: 384,
        embed: async () => {
          calls += 1;
          throw new Error('embed down');
        },
      },
      { maxAttempts: 2, leaseMs: 1_000, now: () => now },
    );

    await expect(worker.processNext()).resolves.toBe(true);
    expect(store.outbox[0]?.status).toBe('pending');
    expect(store.outbox[0]?.attempts).toBe(1);
    expect(store.outbox[0]?.lease_until).toEqual(expect.any(String));
    expect(new ReindexWorker(store, new DeterministicEmbeddingProvider(), { now: () => now }).claimNext()).toBeUndefined();
    now += 60_000;
    await expect(worker.processNext()).resolves.toBe(true);
    expect(store.outbox[0]?.status).toBe('dead_letter');
    expect(calls).toBe(2);
    expect(store.getVariantRevisions('feed', 'prod', 'var')).toMatchObject({
      data_revision: 4,
      search_revision: 3,
      index_revision: 2,
    });
    expect(store.products.get('feed')?.get('prod')?.variants[0]?.price?.amount).toBe(1800);
  });

  it('releases an interrupted lease so a later worker can recover the same item once', async () => {
    const store = new MemoryAcpCatalogStore();
    store.products.set('feed', new Map([
      ['prod', { id: 'prod', title: 'Yerba', variants: [{ id: 'var', title: '1kg' }] }],
    ]));
    store.revisions.set(catalogItemId('feed', 'prod', 'var'), {
      data_revision: 1,
      search_revision: 1,
      index_revision: 0,
      tombstoned: false,
    });
    pendingJob(store, { id: 'recover', item_id: catalogItemId('feed', 'prod', 'var') });
    const interrupted = new ReindexWorker(store, new DeterministicEmbeddingProvider(), { leaseMs: 30_000 });
    expect(interrupted.claimNext()?.id).toBe('recover');
    interrupted.requestStop();
    interrupted.releaseClaimed();
    expect(store.outbox[0]?.status).toBe('pending');
    expect(store.outbox[0]?.lease_until).toBeUndefined();

    const recovered = new ReindexWorker(store, new DeterministicEmbeddingProvider(), { leaseMs: 30_000 });
    expect(await recovered.processNext()).toBe(true);
    expect(store.outbox.filter((job) => job.item_id === catalogItemId('feed', 'prod', 'var') && job.status === 'done')).toHaveLength(1);
    expect(store.documents.get(catalogItemId('feed', 'prod', 'var'))?.index_revision).toBe(1);
  });

  it('ignores a stale search_revision so a newer document is not overwritten', async () => {
    const store = new MemoryAcpCatalogStore();
    const itemId = catalogItemId('feed', 'prod', 'var');
    store.products.set('feed', new Map([
      ['prod', { id: 'prod', title: 'Café nuevo', variants: [{ id: 'var', title: '250g' }] }],
    ]));
    store.revisions.set(itemId, {
      data_revision: 5,
      search_revision: 5,
      index_revision: 5,
      tombstoned: false,
    });
    store.documents.set(itemId, {
      item_id: itemId,
      name: 'Café nuevo',
      description: '',
      item_info: '',
      search_text: 'Café nuevo',
      embedding: new Array(384).fill(0),
      index_revision: 5,
    });
    pendingJob(store, { id: 'stale', item_id: itemId, search_revision: 4 });
    const worker = new ReindexWorker(store, new DeterministicEmbeddingProvider());
    await worker.processNext();
    expect(store.documents.get(itemId)?.name).toBe('Café nuevo');
    expect(store.documents.get(itemId)?.index_revision).toBe(5);
    expect(store.outbox[0]?.status).toBe('done');
  });

  it('applies a tombstone by hiding the current document immediately after commit', async () => {
    const store = new MemoryAcpCatalogStore();
    const itemId = catalogItemId('feed', 'prod', 'var');
    store.documents.set(itemId, {
      item_id: itemId,
      name: 'Alfajor',
      description: '',
      item_info: '',
      search_text: 'Alfajor',
      embedding: new Array(384).fill(0),
      index_revision: 1,
    });
    store.revisions.set(itemId, {
      data_revision: 2,
      search_revision: 1,
      index_revision: 1,
      tombstoned: true,
    });
    pendingJob(store, { item_id: itemId, operation: 'delete', search_revision: 1 });
    const worker = new ReindexWorker(store, new DeterministicEmbeddingProvider());
    await worker.processNext();
    expect(store.documents.has(itemId)).toBe(false);
    expect(store.getVariantRevisions('feed', 'prod', 'var').tombstoned).toBe(true);
  });
});
