import { readFile } from 'node:fs/promises';
import { CatalogError, type DerivedCatalogSnapshot, type EmbeddingProvider, type PublishResult } from './domain.js';
import { buildSearchProjection } from './projection.js';
import type { CatalogRepository } from './repository.js';
import { validateCatalogFixture } from './schema.js';

export async function deriveCatalogSnapshot(
  input: unknown,
  embedding: EmbeddingProvider,
  catalogVersionId = 'pending',
): Promise<DerivedCatalogSnapshot> {
  const fixture = validateCatalogFixture(input);
  const projections = [];
  for (const offer of fixture.offers) {
    projections.push(await buildSearchProjection(offer, embedding, catalogVersionId));
  }
  if (projections.length !== fixture.offers.length) {
    throw new CatalogError('Projection count mismatch', 'INVALID_CATALOG_FIXTURE');
  }
  const offerIds = new Set(fixture.offers.map((offer) => offer.item_id));
  for (const projection of projections) {
    if (!offerIds.has(projection.item_id)) {
      throw new CatalogError('Projection item_id is not in the catalog version', 'INVALID_CATALOG_FIXTURE');
    }
  }
  return {
    source: fixture.source,
    version: fixture.version,
    source_updated_at: fixture.source_updated_at,
    embedding_model: embedding.model,
    embedding_dimensions: embedding.dimensions,
    merchants: fixture.merchants,
    offers: fixture.offers,
    projections,
  };
}

export async function loadJunoCatalog(opts: {
  fixture: unknown;
  repository: CatalogRepository;
  embedding: EmbeddingProvider;
}): Promise<PublishResult> {
  const snapshot = await deriveCatalogSnapshot(opts.fixture, opts.embedding);
  return opts.repository.publish(snapshot);
}

export async function loadJunoCatalogFromFile(opts: {
  fixturePath: string;
  repository: CatalogRepository;
  embedding: EmbeddingProvider;
}): Promise<PublishResult> {
  const raw = await readFile(opts.fixturePath, 'utf8');
  return loadJunoCatalog({
    fixture: JSON.parse(raw) as unknown,
    repository: opts.repository,
    embedding: opts.embedding,
  });
}
