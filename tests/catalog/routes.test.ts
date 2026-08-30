import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';
import { InMemoryRepository } from '../../src/persistence/repository.js';
import { createApp } from '../../src/server/app.js';
import { DeterministicEmbeddingProvider } from '../../src/catalog/embedding.js';
import { loadJunoCatalog } from '../../src/catalog/loader.js';
import { CatalogSearchService } from '../../src/catalog/search.js';
import { MemoryCatalogRepository } from './fakes.js';
import { readFileSync } from 'node:fs';

function testConfig() {
  return loadConfig({
    NODE_ENV: 'test',
    KYA_MODE: 'demo',
    PUBLIC_BASE_URL: 'http://localhost:8787',
    KYA_ISSUER: 'http://localhost:8787',
    KYA_AUDIENCE: 'kya-agent',
  });
}

function fixture(): unknown {
  return JSON.parse(readFileSync(new URL('../../fixtures/juno/catalog.json', import.meta.url), 'utf8'));
}

async function catalogApp(repo = new MemoryCatalogRepository()) {
  const embedding = new DeterministicEmbeddingProvider();
  await loadJunoCatalog({ fixture: fixture(), repository: repo, embedding });
  const { app } = createApp(new InMemoryRepository(), testConfig(), {
    catalogSearch: new CatalogSearchService(repo, embedding),
  });
  return { app, repo };
}

describe('POST /v1/catalog/search', () => {
  it('is public and returns ranked ARS results without embeddings or URLs', async () => {
    const { app } = await catalogApp();
    const res = await app.request('/v1/catalog/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'papas fritas' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.search_mode).toBe('hnsw');
    expect(body).not.toHaveProperty('catalog_version');
    expect(body.results[0]).toMatchObject({
      data_revision: expect.any(Number),
      search_revision: expect.any(Number),
      index_revision: expect.any(Number),
    });
    expect(JSON.stringify(body)).not.toMatch(/https?:\/\/|embedding/);
    expect(body.results[0].price.currency).toBe('ARS');
  });

  it('returns 200 with an empty list when filters exclude every candidate', async () => {
    const { app } = await catalogApp();
    const res = await app.request('/v1/catalog/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'papas', filters: { currency: 'USD' } }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ results: [] });
  });

  it('rejects invalid requests with 400 INVALID_SEARCH_REQUEST', async () => {
    const { app } = await catalogApp();
    const res = await app.request('/v1/catalog/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'x', extra: true }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'INVALID_SEARCH_REQUEST' });
  });

  it('maps catalog and unexpected failures without touching KyaStore', async () => {
    const kya = new InMemoryRepository();
    const before = await kya.getStore();
    const missing = new MemoryCatalogRepository();
    const embedding = new DeterministicEmbeddingProvider();
    await loadJunoCatalog({ fixture: fixture(), repository: missing, embedding });
    missing.missingOnHydrate = true;
    const { app } = createApp(kya, testConfig(), {
      catalogSearch: new CatalogSearchService(missing, embedding),
    });
    const unavailable = await app.request('/v1/catalog/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'papas' }),
    });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: 'Search unavailable', code: 'SEARCH_UNAVAILABLE' });
    expect(await kya.getStore()).toEqual(before);

    const unexpectedRepo = new MemoryCatalogRepository();
    unexpectedRepo.unexpectedOnSearch = true;
    unexpectedRepo.snapshots.set('x', {
      source: 'juno_mock',
      version: 'x',
      source_updated_at: '2026-08-29T21:00:00.000Z',
      embedding_model: embedding.model,
      embedding_dimensions: 384,
      merchants: [],
      offers: [],
      projections: [],
    });
    unexpectedRepo.activeVersion = 'x';
    const { app: unexpectedApp } = createApp(kya, testConfig(), {
      catalogSearch: new CatalogSearchService(unexpectedRepo, embedding),
    });
    const internal = await unexpectedApp.request('/v1/catalog/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'papas' }),
    });
    expect(internal.status).toBe(500);
    expect(await internal.json()).toEqual({ error: 'Internal error', code: 'INTERNAL_ERROR' });
    expect(await kya.getStore()).toEqual(before);

    const { app: emptyApp } = createApp(kya, testConfig());
    const noCatalog = await emptyApp.request('/v1/catalog/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'papas' }),
    });
    expect(noCatalog.status).toBe(503);
    expect(await noCatalog.json()).toMatchObject({ code: 'CATALOG_UNAVAILABLE' });
  });
});
