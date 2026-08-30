import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CatalogError } from '../../src/catalog/domain.js';
import { DeterministicEmbeddingProvider } from '../../src/catalog/embedding.js';
import { deriveCatalogSnapshot, loadJunoCatalog } from '../../src/catalog/loader.js';
import { HARD_COMMERCE_FIELD_NAMES, projectionSearchablePayload } from '../../src/catalog/projection.js';
import { MemoryCatalogRepository } from './fakes.js';

function fixture(): unknown {
  return JSON.parse(readFileSync(new URL('../../fixtures/juno/catalog.json', import.meta.url), 'utf8'));
}

describe('catalog loader', () => {
  it('publishes exactly 10 projections without hard commerce fields', async () => {
    const repository = new MemoryCatalogRepository();
    const embedding = new DeterministicEmbeddingProvider();
    const result = await loadJunoCatalog({ fixture: fixture(), repository, embedding });
    expect(result.status).toBe('published');
    expect(result.idempotent).toBe(false);
    const snapshot = repository.snapshots.get(result.version)!;
    expect(snapshot.offers).toHaveLength(10);
    expect(snapshot.projections).toHaveLength(10);
    for (const projection of snapshot.projections) {
      const payload = projectionSearchablePayload(projection);
      for (const field of HARD_COMMERCE_FIELD_NAMES) {
        expect(field in payload).toBe(false);
      }
    }
  });

  it('is idempotent for the same source version and preserves a published snapshot on failure', async () => {
    const repository = new MemoryCatalogRepository();
    const embedding = new DeterministicEmbeddingProvider();
    const first = await loadJunoCatalog({ fixture: fixture(), repository, embedding });
    const second = await loadJunoCatalog({ fixture: fixture(), repository, embedding });
    expect(second.idempotent).toBe(true);
    expect(repository.publishCalls).toBe(2);
    expect(repository.snapshots.size).toBe(1);

    repository.failNextPublish = true;
    await expect(
      loadJunoCatalog({
        fixture: { ...(fixture() as object), version: 'juno-mock-fail' },
        repository,
        embedding,
      }),
    ).rejects.toBeInstanceOf(CatalogError);
    expect(repository.activeVersion).toBe(first.version);
  });

  it('rejects the complete candidate when embedding derivation fails', async () => {
    const repository = new MemoryCatalogRepository();
    const embedding = {
      model: 'test-deterministic-384',
      dimensions: 384,
      embed: async () => {
        throw new Error('model offline');
      },
    };
    await expect(loadJunoCatalog({ fixture: fixture(), repository, embedding })).rejects.toBeInstanceOf(
      CatalogError,
    );
    expect(repository.publishCalls).toBe(0);
  });

  it('rolls back to a retained prior version', async () => {
    const repository = new MemoryCatalogRepository();
    const embedding = new DeterministicEmbeddingProvider();
    const prior = await deriveCatalogSnapshot(fixture(), embedding);
    repository.snapshots.set(prior.version, prior);
    repository.snapshots.set('juno-mock-newer', { ...prior, version: 'juno-mock-newer' });
    repository.activeVersion = 'juno-mock-newer';
    await repository.rollback(prior.version);
    expect(repository.activeVersion).toBe(prior.version);
  });
});
