import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CatalogError } from '../../src/catalog/domain.js';
import { DeterministicEmbeddingProvider } from '../../src/catalog/embedding.js';
import { loadJunoCatalog } from '../../src/catalog/loader.js';
import { CatalogSearchService } from '../../src/catalog/search.js';
import { MemoryCatalogRepository } from './fakes.js';

function fixture(): unknown {
  return JSON.parse(readFileSync(new URL('../../fixtures/juno/catalog.json', import.meta.url), 'utf8'));
}

async function readyService(overrides?: { missing?: boolean; unexpected?: boolean }) {
  const repository = new MemoryCatalogRepository();
  const embedding = new DeterministicEmbeddingProvider();
  await loadJunoCatalog({ fixture: fixture(), repository, embedding });
  repository.missingOnHydrate = overrides?.missing ?? false;
  repository.unexpectedOnSearch = overrides?.unexpected ?? false;
  return { service: new CatalogSearchService(repository, embedding), repository };
}

describe('CatalogSearchService', () => {
  it('hydrates selected item_ids once, filters authoritatively, and preserves rank', async () => {
    const { service, repository } = await readyService();
    const response = await service.search({
      query: 'papas fritas',
      top_k: 3,
      filters: { merchant_ids: ['merchant_palermo', 'merchant_centro'] },
    });
    expect(repository.searchCalls).toBe(1);
    expect(repository.hydrateCalls).toBe(1);
    expect(repository.lastHydrateItemIds.length).toBeGreaterThan(0);
    expect(response.results.length).toBeGreaterThan(0);
    expect(response.results.length).toBeLessThanOrEqual(3);
    expect(response.search_mode).toBe('hnsw');
    expect(response.results.every((row) => ['merchant_palermo', 'merchant_centro'].includes(row.merchant.merchant_id))).toBe(
      true,
    );
    const scores = response.results.map((row) => row.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('uses authoritative hard fields even when projection text conflicts', async () => {
    const { service, repository } = await readyService();
    const snapshot = repository.snapshots.get(repository.activeVersion!)!;
    snapshot.projections[0] = {
      ...snapshot.projections[0]!,
      name: 'precio 1 ARS',
      description: 'merchant inventado out_of_stock',
    };
    const response = await service.search({ query: 'leche' });
    const leche = response.results.find((row) => row.item_id === 'item_leche_entera');
    expect(leche?.price.amount_minor).toBe(2100);
    expect(leche?.price.currency).toBe('ARS');
    expect(leche?.availability).toBe('in_stock');
    expect(leche?.merchant.merchant_id).toBe('merchant_centro');
  });

  it('returns SEARCH_UNAVAILABLE without partials when hydration is incomplete', async () => {
    const { service } = await readyService({ missing: true });
    await expect(service.search({ query: 'papas' })).rejects.toMatchObject({
      code: 'SEARCH_UNAVAILABLE',
    });
  });

  it('does not call the catalog repository when query embedding fails', async () => {
    const repository = new MemoryCatalogRepository();
    const embedding = {
      model: 'test-deterministic-384',
      dimensions: 384,
      embed: async () => {
        throw new Error('offline');
      },
    };
    const service = new CatalogSearchService(repository, embedding);
    await expect(service.search({ query: 'papas' })).rejects.toBeInstanceOf(CatalogError);
    expect(repository.searchCalls).toBe(0);
  });

  it('returns CATALOG_UNAVAILABLE when no version is published', async () => {
    const service = new CatalogSearchService(new MemoryCatalogRepository(), new DeterministicEmbeddingProvider());
    await expect(service.search({ query: 'papas' })).rejects.toMatchObject({
      code: 'CATALOG_UNAVAILABLE',
    });
  });

  it('maps unexpected repository failures to INTERNAL_ERROR', async () => {
    const { service } = await readyService({ unexpected: true });
    await expect(service.search({ query: 'papas' })).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });

  it('returns per-item revisions and never a global catalog_version', async () => {
    const { service } = await readyService();
    const response = await service.search({ query: 'papas fritas' });
    expect(response).not.toHaveProperty('catalog_version');
    expect(response.results.length).toBeGreaterThan(0);
    for (const row of response.results) {
      expect(row.data_revision).toEqual(expect.any(Number));
      expect(row.search_revision).toEqual(expect.any(Number));
      expect(row.index_revision).toEqual(expect.any(Number));
      expect(row.price.currency).toBe('ARS');
    }
  });

  it('keeps current hard fields when a searchable document lags behind', async () => {
    const { service, repository } = await readyService();
    repository.setRevision('item_bastones_crocantes', {
      data_revision: 4,
      search_revision: 4,
      index_revision: 3,
    });
    repository.setOfferPrice('item_bastones_crocantes', 3333);
    const response = await service.search({ query: 'papas fritas' });
    const row = response.results.find((item) => item.item_id === 'item_bastones_crocantes');
    expect(row?.price.amount_minor).toBe(3333);
    expect(row).toMatchObject({
      data_revision: 4,
      search_revision: 4,
      index_revision: 3,
    });
  });
});
