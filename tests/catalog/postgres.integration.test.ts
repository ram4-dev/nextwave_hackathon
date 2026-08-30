import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyHnswReadiness, shouldUseExactFallback } from '../../src/catalog/hnsw.js';
import { DeterministicEmbeddingProvider } from '../../src/catalog/embedding.js';
import { deriveCatalogSnapshot, loadJunoCatalog } from '../../src/catalog/loader.js';
import { applyCatalogMigrations } from '../../src/catalog/migrate.js';
import {
  HNSW_CANDIDATES_QUERY,
  PostgresCatalogRepository,
} from '../../src/catalog/postgres-repository.js';
import { CatalogSearchService } from '../../src/catalog/search.js';
import { ACP_API_VERSION, MerchantFeedAuthorizer } from '../../src/catalog/acp-contract.js';
import { CatalogError } from '../../src/catalog/domain.js';
import {
  PostgresAcpIngestionService,
  PostgresMerchantKeyStore,
  provisionMerchantInPostgres,
  revokeMerchantApiKeyInPostgres,
  rotateMerchantApiKeyInPostgres,
} from '../../src/catalog/postgres-acp-store.js';
import { PostgresReindexWorker } from '../../src/catalog/postgres-reindex-worker.js';
import { loadConfig } from '../../src/config/env.js';
import { InMemoryRepository } from '../../src/persistence/repository.js';
import { createApp } from '../../src/server/app.js';

const execFileAsync = promisify(execFile);
const DEFAULT_URL = 'postgres://catalog:catalog@127.0.0.1:55432/juno_catalog';

function fixture(): unknown {
  return JSON.parse(readFileSync(new URL('../../fixtures/juno/catalog.json', import.meta.url), 'utf8'));
}

async function canConnect(url: string): Promise<boolean> {
  try {
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['info'], { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

async function startCompose(): Promise<void> {
  await execFileAsync('docker', [
    'compose',
    '-f',
    path.resolve(process.cwd(), 'docker-compose.catalog.yml'),
    'up',
    '-d',
    '--wait',
  ]);
}

async function resolveUrl(): Promise<string> {
  const configured = process.env.CATALOG_DATABASE_URL ?? DEFAULT_URL;
  if (await canConnect(configured)) return configured;
  if (await dockerAvailable()) {
    await startCompose();
    for (let i = 0; i < 30; i++) {
      if (await canConnect(configured)) return configured;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error('PostgreSQL catalog integration requires Docker/pgvector or CATALOG_DATABASE_URL');
}

function containsHnswIndex(plan: unknown): boolean {
  if (Array.isArray(plan)) return plan.some(containsHnswIndex);
  if (!plan || typeof plan !== 'object') return false;
  const node = plan as Record<string, unknown>;
  return (
    node['Index Name'] === 'catalog_search_current_embedding_hnsw' ||
    node['Index Name'] === 'catalog_search_embedding_hnsw' ||
    Object.values(node).some(containsHnswIndex)
  );
}

async function catalogState(pool: import('pg').Pool) {
  const result = await pool.query<{
    versions: number;
    published_versions: number;
    products: number;
    documents: number;
    versions_state: string;
    products_state: string;
    documents_state: string;
  }>(
    `SELECT
       (SELECT count(*)::int FROM catalog_versions) AS versions,
       (SELECT count(*)::int FROM catalog_versions WHERE status = 'published') AS published_versions,
       (SELECT count(*)::int FROM catalog_products) AS products,
       (SELECT count(*)::int FROM catalog_search_documents) AS documents,
       COALESCE((SELECT string_agg(version || ':' || status::text, '|' ORDER BY version) FROM catalog_versions), '') AS versions_state,
       COALESCE((SELECT md5(string_agg(concat_ws(':', catalog_version_id::text, item_id, merchant_id, name, description, category, price_minor::text, currency, availability::text), '|' ORDER BY catalog_version_id, item_id)) FROM catalog_products), '') AS products_state,
       COALESCE((SELECT md5(string_agg(concat_ws(':', catalog_version_id::text, item_id, name, description, item_info, embedding::text, is_published::text), '|' ORDER BY catalog_version_id, item_id)) FROM catalog_search_documents), '') AS documents_state`,
  );
  return result.rows[0]!;
}

describe('HNSW fallback classification', () => {
  it('uses exact fallback only for explicit HNSW unreadiness', () => {
    expect(classifyHnswReadiness(undefined)).toBe('unavailable');
    expect(classifyHnswReadiness({ amname: 'hnsw', indisvalid: true })).toBe('ready');
    expect(shouldUseExactFallback({ readiness: 'unavailable' })).toBe(true);
    expect(shouldUseExactFallback({ readiness: 'ready' })).toBe(false);
  });

  it('maps an exact-vector failure after explicit unreadiness to SEARCH_UNAVAILABLE', async () => {
    const client = {
      query: async (query: string) => {
        if (query.includes('FROM catalog_search_documents_current') && query.includes('embedding_model')) {
          return {
            rows: [
              {
                embedding_model: 'test-deterministic-384',
                embedding_dimensions: 384,
                as_of: new Date(),
              },
            ],
          };
        }
        if (query.includes('FROM pg_index')) return { rows: [] };
        if (query.includes('catalog_search_documents_current') && query.includes('embedding <=>')) {
          throw new Error('exact vector query failed');
        }
        return { rows: [] };
      },
      release: () => undefined,
    };
    const repository = new PostgresCatalogRepository({
      connect: async () => client,
    } as unknown as import('pg').Pool);

    await expect(
      repository.searchActive({
        query: 'papas fritas',
        query_embedding: new Array(384).fill(0),
        embedding_model: 'test-deterministic-384',
        embedding_dimensions: 384,
        filters: { availability: 'in_stock' },
        candidate_k: 10,
        top_k: 5,
      }),
    ).rejects.toMatchObject({ catalogCode: 'SEARCH_UNAVAILABLE' });
  });

  it('does not fall back when a ready HNSW query fails unexpectedly', async () => {
    const client = {
      query: async (query: string) => {
        if (query.includes('FROM catalog_search_documents_current') && query.includes('embedding_model')) {
          return {
            rows: [
              {
                embedding_model: 'test-deterministic-384',
                embedding_dimensions: 384,
                as_of: new Date(),
              },
            ],
          };
        }
        if (query.includes('FROM pg_index')) return { rows: [{ amname: 'hnsw', indisvalid: true }] };
        if (query.includes('catalog_search_documents_current') && query.includes('hnsw_candidates')) {
          throw new Error('unexpected HNSW executor failure');
        }
        return { rows: [] };
      },
      release: () => undefined,
    };
    const repository = new PostgresCatalogRepository({
      connect: async () => client,
    } as unknown as import('pg').Pool);
    const service = new CatalogSearchService(repository, new DeterministicEmbeddingProvider());

    await expect(service.search({ query: 'papas fritas' })).rejects.toMatchObject({
      catalogCode: 'INTERNAL_ERROR',
    });
  });

  it('maps a general database connection failure to SEARCH_UNAVAILABLE', async () => {
    const repository = new PostgresCatalogRepository({
      connect: async () => {
        throw new Error('ECONNREFUSED catalog database');
      },
    } as unknown as import('pg').Pool);

    await expect(
      repository.searchActive({
        query: 'papas fritas',
        query_embedding: new Array(384).fill(0),
        embedding_model: 'test-deterministic-384',
        embedding_dimensions: 384,
        filters: { availability: 'in_stock' },
        candidate_k: 10,
        top_k: 5,
      }),
    ).rejects.toMatchObject({ catalogCode: 'SEARCH_UNAVAILABLE' });
  });
});

describe('PostgreSQL catalog integration', () => {
  let pool: import('pg').Pool;
  let repository: PostgresCatalogRepository;
  const embedding = new DeterministicEmbeddingProvider();

  beforeAll(async () => {
    const databaseUrl = await resolveUrl();
    const { default: pg } = await import('pg');
    pool = new pg.Pool({ connectionString: databaseUrl });
    await applyCatalogMigrations(pool);
    repository = new PostgresCatalogRepository(pool);
    await loadJunoCatalog({ fixture: fixture(), repository, embedding });
  }, 90_000);

  afterAll(async () => {
    await pool?.end();
  });

  it('migrates, publishes atomically, and searches through HNSW then exact fallback', async () => {
    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE indexname IN (
         'catalog_search_embedding_hnsw',
         'catalog_search_current_embedding_hnsw',
         'catalog_search_lexical_gin',
         'catalog_items_price_availability',
         'catalog_one_published_version'
       )`,
    );
    expect(indexes.rows.map((row) => row.indexname).sort()).toEqual([
      'catalog_items_price_availability',
      'catalog_one_published_version',
      'catalog_search_current_embedding_hnsw',
      'catalog_search_embedding_hnsw',
      'catalog_search_lexical_gin',
    ]);

    const first = await loadJunoCatalog({ fixture: fixture(), repository, embedding });
    expect(first.idempotent).toBe(true);
    const published = await pool.query('SELECT count(*)::int AS n FROM catalog_versions WHERE status = $1', [
      'published',
    ]);
    expect(published.rows[0]?.n).toBe(1);

    const service = new CatalogSearchService(repository, embedding);
    const beforeSearch = await catalogState(pool);
    const hnsw = await service.search({ query: 'papas fritas', top_k: 5 });
    expect(hnsw.search_mode).toBe('hnsw');
    expect(hnsw.results.length).toBeGreaterThan(0);
    expect(hnsw.results.some((row) => row.item_id === 'item_bastones_crocantes')).toBe(true);
    expect(repository.lastSearch?.hydrationQueries).toBe(1);
    expect(repository.lastSearch?.snapshotIsolation).toBe('repeatable read');
    expect(hnsw.results.every((row) => row.price.currency === 'ARS')).toBe(true);
    expect(hnsw).not.toHaveProperty('catalog_version');
    expect(hnsw.results[0]).toMatchObject({
      data_revision: expect.any(Number),
      search_revision: expect.any(Number),
      index_revision: expect.any(Number),
    });
    expect(await catalogState(pool)).toEqual(beforeSearch);

    const vector = await embedding.embed(['papas fritas']);
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query('SET LOCAL enable_seqscan = off');
      await client.query('SET LOCAL enable_bitmapscan = off');
      await client.query("SET LOCAL hnsw.iterative_scan = 'strict_order'");
      const explainedHnsw = await client.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${HNSW_CANDIDATES_QUERY}`,
        [`[${vector[0]!.join(',')}]`, 10],
      );
      expect(containsHnswIndex(explainedHnsw.rows[0])).toBe(true);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    try {
      await pool.query('DROP INDEX catalog_search_current_embedding_hnsw');
      const fallback = await service.search({ query: 'papas fritas', top_k: 5 });
      expect(fallback.search_mode).toBe('exact_fallback');
      expect(fallback.results.map((row) => row.item_id)).toEqual(hnsw.results.map((row) => row.item_id));
    } finally {
      await pool.query(`
        CREATE INDEX IF NOT EXISTS catalog_search_current_embedding_hnsw
        ON catalog_search_documents_current
        USING hnsw (embedding vector_cosine_ops)
      `);
    }
  }, 90_000);

  it('records a migration only when all SQL in that file commits', async () => {
    const migrationDir = await mkdtemp(path.join(tmpdir(), 'juno-catalog-migration-'));
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
    const migrationId = `999_broken_${suffix}.sql`;
    const probeTable = `catalog_migration_probe_${suffix}`;
    try {
      await writeFile(
        path.join(migrationDir, migrationId),
        `CREATE TABLE ${probeTable} (id integer);\nSELECT malformed_sql_${suffix};\n`,
      );

      await expect(applyCatalogMigrations(pool, migrationDir)).rejects.toThrow();

      const recorded = await pool.query('SELECT 1 FROM catalog_schema_migrations WHERE id = $1', [migrationId]);
      expect(recorded.rowCount).toBe(0);
      const table = await pool.query<{ relation: string | null }>('SELECT to_regclass($1) AS relation', [probeTable]);
      expect(table.rows[0]?.relation ?? null).toBeNull();
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${probeTable}`);
      await rm(migrationDir, { recursive: true, force: true });
    }
  });

  it('keeps the active snapshot intact when a projection violates the same-version item FK', async () => {
    const baseline = await pool.query<{ version: string }>(
      `SELECT version FROM catalog_versions WHERE status = 'published'`,
    );
    const failedVersion = `juno-mock-projection-failure-${Date.now()}`;
    const snapshot = await deriveCatalogSnapshot(
      { ...(fixture() as object), version: failedVersion },
      embedding,
    );
    snapshot.projections[0] = {
      ...snapshot.projections[0]!,
      item_id: `item-missing-${Date.now()}`,
    };

    await expect(repository.publish(snapshot)).rejects.toMatchObject({
      catalogCode: 'INVALID_CATALOG_FIXTURE',
    } satisfies Partial<CatalogError>);

    const active = await pool.query<{ version: string }>(
      `SELECT version FROM catalog_versions WHERE status = 'published'`,
    );
    const failed = await pool.query('SELECT 1 FROM catalog_versions WHERE version = $1', [failedVersion]);
    expect(active.rows).toEqual(baseline.rows);
    expect(failed.rowCount).toBe(0);
  });

  it('reports a retained superseded version honestly and rolls back only complete snapshots', async () => {
    const base = fixture() as { version: string };
    const newerVersion = `juno-mock-newer-${Date.now()}`;
    const invalidVersion = `juno-mock-building-${Date.now()}`;
    try {
      await loadJunoCatalog({
        fixture: { ...base, version: newerVersion },
        repository,
        embedding,
      });

      const activeRows = await pool.query<{ products: number; documents: number }>(
        `SELECT
           (SELECT count(*)::int FROM catalog_products p WHERE p.catalog_version_id = v.id) AS products,
           (SELECT count(*)::int FROM catalog_search_documents d WHERE d.catalog_version_id = v.id AND d.is_published) AS documents
         FROM catalog_versions v
         WHERE v.version = $1`,
        [newerVersion],
      );
      expect(activeRows.rows[0]).toEqual({ products: 10, documents: 10 });
      const indexReadiness = await pool.query<{ indexname: string; amname: string; indisvalid: boolean }>(
        `SELECT i.relname AS indexname, am.amname, ix.indisvalid
         FROM pg_index ix
         JOIN pg_class i ON i.oid = ix.indexrelid
         JOIN pg_am am ON am.oid = i.relam
         WHERE i.relname IN ('catalog_search_embedding_hnsw', 'catalog_search_lexical_gin', 'catalog_items_price_availability')
         ORDER BY i.relname`,
      );
      expect(indexReadiness.rows).toEqual([
        { indexname: 'catalog_items_price_availability', amname: 'btree', indisvalid: true },
        { indexname: 'catalog_search_embedding_hnsw', amname: 'hnsw', indisvalid: true },
        { indexname: 'catalog_search_lexical_gin', amname: 'gin', indisvalid: true },
      ]);

      const repeat = await loadJunoCatalog({ fixture: base, repository, embedding });
      expect(repeat.idempotent).toBe(true);
      expect(repeat.status).toBe('superseded');

      await pool.query(
        `INSERT INTO catalog_versions (
           source, version, status, embedding_model, embedding_dimensions, source_updated_at
         ) VALUES ('juno_mock', $1, 'building', $2, 384, now())`,
        [invalidVersion, embedding.model],
      );
      await expect(repository.rollback(invalidVersion)).rejects.toMatchObject({
        catalogCode: 'CATALOG_UNAVAILABLE',
      } satisfies Partial<CatalogError>);

      const versions = await pool.query<{ version: string; status: string }>(
        `SELECT version, status FROM catalog_versions WHERE version = ANY($1::text[]) ORDER BY version`,
        [[base.version, newerVersion, invalidVersion]],
      );
      expect(versions.rows).toContainEqual({ version: base.version, status: 'superseded' });
      expect(versions.rows).toContainEqual({ version: newerVersion, status: 'published' });
      expect(versions.rows).toContainEqual({ version: invalidVersion, status: 'building' });

      await repository.rollback(base.version);
      const restored = await pool.query<{ version: string; status: string; published_documents: number }>(
        `SELECT v.version, v.status,
           (SELECT count(*)::int FROM catalog_search_documents d WHERE d.catalog_version_id = v.id AND d.is_published) AS published_documents
         FROM catalog_versions v
         WHERE v.version = ANY($1::text[])
         ORDER BY v.version`,
        [[base.version, newerVersion]],
      );
      expect(restored.rows).toContainEqual({ version: base.version, status: 'published', published_documents: 10 });
      expect(restored.rows).toContainEqual({ version: newerVersion, status: 'superseded', published_documents: 0 });
      expect(
        (await pool.query(`SELECT count(*)::int AS n FROM catalog_versions WHERE status = 'published'`)).rows[0]?.n,
      ).toBe(1);
      const restoredSearch = await new CatalogSearchService(repository, embedding).search({ query: 'papas fritas' });
      expect(restoredSearch).not.toHaveProperty('catalog_version');
      expect(restoredSearch.results[0]).toMatchObject({
        data_revision: expect.any(Number),
        search_revision: expect.any(Number),
        index_revision: expect.any(Number),
      });
    } finally {
      await pool.query(
        `UPDATE catalog_search_documents SET is_published = false
         WHERE catalog_version_id IN (SELECT id FROM catalog_versions WHERE version = $1)`,
        [newerVersion],
      );
      await pool.query(
        `UPDATE catalog_versions SET status = 'superseded', published_at = NULL WHERE version = $1`,
        [newerVersion],
      );
      await pool.query(
        `UPDATE catalog_search_documents SET is_published = true
         WHERE catalog_version_id IN (SELECT id FROM catalog_versions WHERE version = $1)`,
        [base.version],
      );
      await pool.query(
        `UPDATE catalog_versions SET status = 'published', published_at = now() WHERE version = $1`,
        [base.version],
      );
      await pool.query(
        `DELETE FROM catalog_search_documents
         WHERE catalog_version_id IN (SELECT id FROM catalog_versions WHERE version = $1)`,
        [newerVersion],
      );
      await pool.query(
        `DELETE FROM catalog_products
         WHERE catalog_version_id IN (SELECT id FROM catalog_versions WHERE version = $1)`,
        [newerVersion],
      );
      await pool.query(
        `DELETE FROM catalog_merchants
         WHERE catalog_version_id IN (SELECT id FROM catalog_versions WHERE version = $1)`,
        [newerVersion],
      );
      await pool.query('DELETE FROM catalog_versions WHERE version = $1', [newerVersion]);
      await pool.query('DELETE FROM catalog_versions WHERE version = $1', [invalidVersion]);
    }
  });

  it('accepts an ACP PATCH, indexes through the worker, and searches current SQL revisions', async () => {
    await pool.query(`DELETE FROM catalog_reindex_outbox WHERE status IN ('pending', 'leased')`);
    const issued = await provisionMerchantInPostgres(pool, {
      merchant_id: `merchant_acp_${Date.now()}`,
      name: 'Almacén ACP',
      slug: 'almacen-acp',
      category: 'almacen',
    });
    const { app } = createApp(new InMemoryRepository(), loadConfig({
      NODE_ENV: 'test',
      KYA_MODE: 'demo',
      PUBLIC_BASE_URL: 'http://localhost:8787',
      KYA_ISSUER: 'http://localhost:8787',
      KYA_AUDIENCE: 'kya-agent',
      CATALOG_ACP_ENABLED: 'true',
    }), {
      catalogSearch: new CatalogSearchService(repository, embedding),
      acpAuthorizer: new MerchantFeedAuthorizer(new PostgresMerchantKeyStore(pool)),
      acpIngestion: new PostgresAcpIngestionService(pool),
    });
    const hdr = (idem: string) => ({
      authorization: `Bearer ${issued.raw}`,
      'content-type': 'application/json',
      'api-version': ACP_API_VERSION,
      'idempotency-key': idem,
      'request-id': `int-${idem}`,
      timestamp: new Date().toISOString(),
      'accept-language': 'es-AR',
    });
    const created = await app.request('/product_feeds', {
      method: 'POST',
      headers: hdr('int-feed'),
      body: JSON.stringify({ target_country: 'AR' }),
    });
    expect(created.status).toBe(200);
    const feed = (await created.json()) as { id: string };
    const patch = await app.request(`/product_feeds/${feed.id}/products`, {
      method: 'PATCH',
      headers: hdr('int-patch'),
      body: JSON.stringify({
        products: [
          {
            id: 'prod_cafe',
            title: 'Café molido',
            description: { plain: 'Café en grano tostado para filtrar' },
            variants: [
              {
                id: 'var_250',
                title: 'Paquete 250g',
                price: { amount: 3900, currency: 'ARS' },
                availability: { available: true, status: 'in_stock' },
                categories: [{ value: 'almacen' }],
              },
            ],
          },
        ],
      }),
    });
    expect(patch.status).toBe(200);
    expect(await patch.json()).toEqual({ id: feed.id, accepted: true });
    const worker = new PostgresReindexWorker(pool, embedding, { leaseMs: 5_000, maxAttempts: 3 });
    const pending = await new CatalogSearchService(repository, embedding).search({
      query: 'café molido',
      filters: { merchant_ids: [issued.merchant_id] },
    });
    expect(pending.results).toEqual([]);
    expect(await worker.processNext()).toBe(true);
    const found = await new CatalogSearchService(repository, embedding).search({
      query: 'café molido',
      filters: { merchant_ids: [issued.merchant_id] },
    });
    expect(found).not.toHaveProperty('catalog_version');
    expect(found.results[0]).toMatchObject({
      price: { amount_minor: 3900, currency: 'ARS' },
      data_revision: 1,
      search_revision: 1,
      index_revision: 1,
    });
  }, 90_000);

  it('serializes concurrent POST feeds and persists list_price and unit_price', async () => {
    const issued = await provisionMerchantInPostgres(pool, {
      merchant_id: `merchant_idemp_${Date.now()}`,
      name: 'Almacén Idem',
      slug: 'almacen-idemp',
      category: 'almacen',
    });
    const { app } = createApp(new InMemoryRepository(), loadConfig({
      NODE_ENV: 'test',
      KYA_MODE: 'demo',
      PUBLIC_BASE_URL: 'http://localhost:8787',
      KYA_ISSUER: 'http://localhost:8787',
      KYA_AUDIENCE: 'kya-agent',
      CATALOG_ACP_ENABLED: 'true',
    }), {
      acpAuthorizer: new MerchantFeedAuthorizer(new PostgresMerchantKeyStore(pool)),
      acpIngestion: new PostgresAcpIngestionService(pool),
    });
    const hdr = (idem: string, req: string) => ({
      authorization: `Bearer ${issued.raw}`,
      'content-type': 'application/json',
      'api-version': ACP_API_VERSION,
      'idempotency-key': idem,
      'request-id': req,
      timestamp: new Date().toISOString(),
      'accept-language': 'es-AR',
    });
    const posts = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        app.request('/product_feeds', {
          method: 'POST',
          headers: hdr('same-feed', `conc-${i}`),
          body: JSON.stringify({ target_country: 'AR' }),
        }),
      ),
    );
    expect(posts.every((row) => row.status === 200)).toBe(true);
    const ids = await Promise.all(posts.map(async (row) => ((await row.json()) as { id: string }).id));
    expect(new Set(ids).size).toBe(1);
    const stored = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM catalog_product_feeds WHERE merchant_id = $1',
      [issued.merchant_id],
    );
    expect(stored.rows[0]?.count).toBe('1');

    const feedId = ids[0]!;
    const patch = await app.request(`/product_feeds/${feedId}/products`, {
      method: 'PATCH',
      headers: hdr('prices', 'prices-1'),
      body: JSON.stringify({
        products: [
          {
            id: 'prod_precio',
            title: 'Aceite',
            variants: [
              {
                id: 'var_1l',
                title: '1L',
                price: { amount: 4200, currency: 'ARS' },
                list_price: { amount: 5100, currency: 'ARS' },
                unit_price: { amount: 420, currency: 'ARS', measure: { value: 100, unit: 'ml' }, reference: '100ml' },
                availability: { available: true, status: 'in_stock' },
              },
            ],
          },
        ],
      }),
    });
    expect(patch.status).toBe(200);
    const listed = await app.request(`/product_feeds/${feedId}/products`, {
      method: 'GET',
      headers: { authorization: `Bearer ${issued.raw}`, 'accept-language': 'es-AR' },
    });
    const body = (await listed.json()) as {
      products: Array<{ variants: Array<{ list_price?: unknown; unit_price?: unknown }> }>;
    };
    expect(body.products[0]?.variants[0]?.list_price).toEqual({ amount: 5100, currency: 'ARS' });
    expect(body.products[0]?.variants[0]?.unit_price).toEqual({
      amount: 420,
      currency: 'ARS',
      measure: { value: 100, unit: 'ml' },
      reference: '100ml',
    });
  }, 90_000);

  it('rolls back an atomic PATCH failure and isolates two merchants through search filters', async () => {
    const first = await provisionMerchantInPostgres(pool, {
      merchant_id: `merchant_iso_a_${Date.now()}`,
      name: 'Iso A',
      slug: 'iso-a',
      category: 'almacen',
    });
    const second = await provisionMerchantInPostgres(pool, {
      merchant_id: `merchant_iso_b_${Date.now()}`,
      name: 'Iso B',
      slug: 'iso-b',
      category: 'almacen',
    });
    const { app } = createApp(new InMemoryRepository(), loadConfig({
      NODE_ENV: 'test',
      KYA_MODE: 'demo',
      PUBLIC_BASE_URL: 'http://localhost:8787',
      KYA_ISSUER: 'http://localhost:8787',
      KYA_AUDIENCE: 'kya-agent',
      CATALOG_ACP_ENABLED: 'true',
    }), {
      catalogSearch: new CatalogSearchService(repository, embedding),
      acpAuthorizer: new MerchantFeedAuthorizer(new PostgresMerchantKeyStore(pool)),
      acpIngestion: new PostgresAcpIngestionService(pool),
    });
    const hdr = (raw: string, idem: string) => ({
      authorization: `Bearer ${raw}`,
      'content-type': 'application/json',
      'api-version': ACP_API_VERSION,
      'idempotency-key': idem,
      'request-id': `iso-${idem}`,
      timestamp: new Date().toISOString(),
      'accept-language': 'es-AR',
    });
    const product = (
      id: string,
      title: string,
      amount: number,
      status: 'in_stock' | 'unknown' | 'discontinued',
    ) => ({
      id,
      title,
      description: { plain: `${title} listo para filtrar` },
      variants: [
        {
          id: 'var_1',
          title: 'Paquete',
          price: { amount, currency: 'ARS' },
          availability: { available: status !== 'discontinued', status },
        },
      ],
    });
    const feedA = ((await (await app.request('/product_feeds', {
      method: 'POST',
      headers: hdr(first.raw, 'feed-a'),
      body: JSON.stringify({ target_country: 'AR' }),
    })).json()) as { id: string }).id;
    const feedB = ((await (await app.request('/product_feeds', {
      method: 'POST',
      headers: hdr(second.raw, 'feed-b'),
      body: JSON.stringify({ target_country: 'AR' }),
    })).json()) as { id: string }).id;
    expect((await app.request(`/product_feeds/${feedA}/products`, {
      method: 'PATCH',
      headers: hdr(first.raw, 'seed-a'),
      body: JSON.stringify({ products: [product('prod_cafe', 'Café de filtro', 3900, 'in_stock')] }),
    })).status).toBe(200);
    expect((await app.request(`/product_feeds/${feedB}/products`, {
      method: 'PATCH',
      headers: hdr(second.raw, 'seed-b'),
      body: JSON.stringify({ products: [product('prod_te', 'Té en hebras', 2100, 'in_stock')] }),
    })).status).toBe(200);

    await pool.query(`
      CREATE OR REPLACE FUNCTION catalog_fail_atomic_patch() RETURNS trigger AS $$
      BEGIN
        IF NEW.external_product_id = 'prod_fail' THEN
          RAISE EXCEPTION 'injected patch failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS catalog_fail_atomic_patch_trg ON catalog_variants_current;
      CREATE TRIGGER catalog_fail_atomic_patch_trg
        BEFORE INSERT OR UPDATE ON catalog_variants_current
        FOR EACH ROW EXECUTE FUNCTION catalog_fail_atomic_patch();
    `);
    const failed = await app.request(`/product_feeds/${feedA}/products`, {
      method: 'PATCH',
      headers: hdr(first.raw, 'atomic-fail'),
      body: JSON.stringify({
        products: [
          product('prod_cafe', 'Café de filtro', 9900, 'in_stock'),
          product('prod_fail', 'No debe persistir', 1, 'in_stock'),
        ],
      }),
    });
    expect(failed.status).toBeGreaterThanOrEqual(500);
    await pool.query('DROP TRIGGER IF EXISTS catalog_fail_atomic_patch_trg ON catalog_variants_current');
    const afterFail = await pool.query<{ price_minor: string }>(
      `SELECT price_minor::text FROM catalog_variants_current WHERE feed_id = $1 AND external_product_id = 'prod_cafe'`,
      [feedA],
    );
    expect(afterFail.rows[0]?.price_minor).toBe('3900');
    expect(
      (await pool.query('SELECT count(*)::int AS n FROM catalog_variants_current WHERE external_product_id = $1', [
        'prod_fail',
      ])).rows[0]?.n,
    ).toBe(0);

    const worker = new PostgresReindexWorker(pool, embedding, { leaseMs: 5_000, maxAttempts: 3 });
    while (await worker.processNext()) {
      /* drain */
    }
    const isolated = await new CatalogSearchService(repository, embedding).search({
      query: 'té hebras',
      filters: { merchant_ids: [second.merchant_id], currency: 'ARS', min_price_minor: 2000, max_price_minor: 2500, availability: 'in_stock' },
    });
    expect(isolated.results).toHaveLength(1);
    expect(isolated.results[0]?.merchant.merchant_id).toBe(second.merchant_id);
    expect(isolated.results.some((row) => row.merchant.merchant_id === first.merchant_id)).toBe(false);

    const textPrice = await app.request(`/product_feeds/${feedA}/products`, {
      method: 'PATCH',
      headers: hdr(first.raw, 'text-price'),
      body: JSON.stringify({
        products: [{ id: 'prod_cafe', title: 'Café especial de altura', variants: [{ id: 'var_1', price: { amount: 4500, currency: 'ARS' } }] }],
      }),
    });
    expect(textPrice.status).toBe(200);
    const pending = await new CatalogSearchService(repository, embedding).search({
      query: 'café de filtro',
      filters: { merchant_ids: [first.merchant_id] },
    });
    expect(pending.results[0]).toMatchObject({
      price: { amount_minor: 4500, currency: 'ARS' },
      data_revision: 2,
      search_revision: 2,
      index_revision: 1,
    });
    expect(await worker.processNext()).toBe(true);
    const indexed = await new CatalogSearchService(repository, embedding).search({
      query: 'café especial de altura',
      filters: { merchant_ids: [first.merchant_id] },
    });
    expect(indexed.results[0]?.price.amount_minor).toBe(4500);
    expect(indexed.results[0]?.index_revision).toBe(2);

    const tombstone = await app.request(`/product_feeds/${feedA}/products`, {
      method: 'PATCH',
      headers: hdr(first.raw, 'tombstone'),
      body: JSON.stringify({
        products: [{ id: 'prod_cafe', variants: [{ id: 'var_1', availability: { available: false, status: 'discontinued' } }] }],
      }),
    });
    expect(tombstone.status).toBe(200);
    const hidden = await new CatalogSearchService(repository, embedding).search({
      query: 'café especial de altura',
      filters: { merchant_ids: [first.merchant_id] },
    });
    expect(hidden.results).toEqual([]);

    expect((await app.request(`/product_feeds/${feedB}/products`, {
      method: 'PATCH',
      headers: hdr(second.raw, 'unknown-stock'),
      body: JSON.stringify({
        products: [{ id: 'prod_te', variants: [{ id: 'var_1', availability: { status: 'unknown' } }] }],
      }),
    })).status).toBe(200);
    const unknown = await new CatalogSearchService(repository, embedding).search({
      query: 'té hebras',
      filters: { merchant_ids: [second.merchant_id], availability: 'in_stock' },
    });
    expect(unknown.results).toEqual([]);
  }, 90_000);

  it('enforces CATALOG_ACP_RATE_LIMIT across sequential Postgres mutations', async () => {
    const issued = await provisionMerchantInPostgres(pool, {
      merchant_id: `merchant_rate_${Date.now()}`,
      name: 'Almacén Rate',
      slug: 'almacen-rate',
      category: 'almacen',
    });
    const { app } = createApp(new InMemoryRepository(), loadConfig({
      NODE_ENV: 'test',
      KYA_MODE: 'demo',
      PUBLIC_BASE_URL: 'http://localhost:8787',
      KYA_ISSUER: 'http://localhost:8787',
      KYA_AUDIENCE: 'kya-agent',
      CATALOG_ACP_ENABLED: 'true',
      CATALOG_ACP_RATE_LIMIT: '1',
    }), {
      acpAuthorizer: new MerchantFeedAuthorizer(new PostgresMerchantKeyStore(pool)),
      acpIngestion: new PostgresAcpIngestionService(pool, { maxRequestsPerWindow: 1 }),
    });
    const hdr = (idem: string) => ({
      authorization: `Bearer ${issued.raw}`,
      'content-type': 'application/json',
      'api-version': ACP_API_VERSION,
      'idempotency-key': idem,
      'request-id': `rate-${idem}`,
      timestamp: new Date().toISOString(),
      'accept-language': 'es-AR',
    });
    const first = await app.request('/product_feeds', {
      method: 'POST',
      headers: hdr('rate-1'),
      body: JSON.stringify({ target_country: 'AR' }),
    });
    expect(first.status).toBe(200);
    const second = await app.request('/product_feeds', {
      method: 'POST',
      headers: hdr('rate-2'),
      body: JSON.stringify({ target_country: 'AR' }),
    });
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('rotates a Postgres API key and fail-closes the previous raw secret', async () => {
    const issued = await provisionMerchantInPostgres(pool, {
      merchant_id: `merchant_rotate_${Date.now()}`,
      name: 'Almacén Rotate',
      slug: 'almacen-rotate',
      category: 'almacen',
    });
    const rotated = await rotateMerchantApiKeyInPostgres(pool, issued.raw);
    expect(rotated.raw).not.toBe(issued.raw);
    expect(JSON.stringify(rotated)).not.toContain(issued.raw);
    const authorizer = new MerchantFeedAuthorizer(new PostgresMerchantKeyStore(pool));
    await expect(authorizer.authenticate(`Bearer ${issued.raw}`)).rejects.toMatchObject({
      httpStatus: 401,
    });
    await expect(authorizer.authenticate(`Bearer ${rotated.raw}`)).resolves.toEqual({
      merchant_id: issued.merchant_id,
    });
    await revokeMerchantApiKeyInPostgres(pool, rotated.raw);
    await expect(authorizer.authenticate(`Bearer ${rotated.raw}`)).rejects.toMatchObject({
      httpStatus: 401,
    });
  });
});
