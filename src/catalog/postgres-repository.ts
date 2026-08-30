import type { Pool, PoolClient } from 'pg';
import {
  CatalogError,
  type CatalogVersionStatus,
  type DerivedCatalogSnapshot,
  type HydratedSearchItem,
  type HydratedSearchResult,
  type PublishResult,
  type RepositorySearchInput,
  type SearchMode,
} from './domain.js';
import { matchesAuthoritativeFilters } from './filters.js';
import {
  classifyHnswReadiness,
  isGeneralDatabaseFailure,
  shouldUseExactFallback,
  type HnswReadiness,
} from './hnsw.js';
import { buildSearchText } from './projection.js';
import { reciprocalRankFusion } from './ranking.js';
import type { CatalogRepository } from './repository.js';

export interface SearchDiagnostics {
  hydrationQueries: number;
  searchMode: SearchMode;
  fallbackReason?: string;
  snapshotIsolation?: string;
}

/**
 * The production HNSW shape deliberately orders in an inner subquery so
 * pgvector can satisfy the nearest-neighbor order. The outer query applies
 * the active-version predicate and deterministic item-id tie-break only after
 * the index has selected candidates.
 */
export const HNSW_CANDIDATES_QUERY = `SELECT item_id
  FROM (
    SELECT item_id, embedding <=> $1::vector AS distance
    FROM catalog_search_documents_current
    ORDER BY embedding <=> $1::vector
    LIMIT $2
  ) AS hnsw_candidates
  ORDER BY distance ASC, item_id ASC`;

const EXACT_CANDIDATES_QUERY = `SELECT item_id
  FROM catalog_search_documents_current
  ORDER BY embedding <=> $1::vector, item_id ASC
  LIMIT $2`;

function asVector(values: readonly number[]): string {
  return `[${values.join(',')}]`;
}

function minIso(values: string[]): string {
  return values.reduce((min, value) => (value < min ? value : min));
}

export class PostgresCatalogRepository implements CatalogRepository {
  lastSearch: SearchDiagnostics | undefined;

  constructor(private readonly pool: Pool) {}

  async publish(snapshot: DerivedCatalogSnapshot): Promise<PublishResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query<{ id: string; status: CatalogVersionStatus }>(
        'SELECT id, status FROM catalog_versions WHERE source = $1 AND version = $2',
        [snapshot.source, snapshot.version],
      );
      const current = existing.rows[0];
      if (current && (current.status === 'published' || current.status === 'superseded')) {
        await this.seedCurrentFromSnapshot(client, snapshot);
        await client.query('COMMIT');
        return {
          catalog_version_id: current.id,
          version: snapshot.version,
          status: current.status,
          idempotent: true,
        };
      }
      if (current) {
        await client.query('DELETE FROM catalog_search_documents WHERE catalog_version_id = $1', [current.id]);
        await client.query('DELETE FROM catalog_products WHERE catalog_version_id = $1', [current.id]);
        await client.query('DELETE FROM catalog_merchants WHERE catalog_version_id = $1', [current.id]);
        await client.query('DELETE FROM catalog_versions WHERE id = $1', [current.id]);
      }

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO catalog_versions (
           source, version, status, embedding_model, embedding_dimensions, source_updated_at
         ) VALUES ($1, $2, 'building', $3, $4, $5)
         RETURNING id`,
        [
          snapshot.source,
          snapshot.version,
          snapshot.embedding_model,
          snapshot.embedding_dimensions,
          snapshot.source_updated_at,
        ],
      );
      const catalogVersionId = inserted.rows[0]!.id;

      for (const merchant of snapshot.merchants) {
        await client.query(
          `INSERT INTO catalog_merchants (
             catalog_version_id, merchant_id, name, slug, category, country_code, locality,
             accepts_juno, source_updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8)`,
          [
            catalogVersionId,
            merchant.merchant_id,
            merchant.name,
            merchant.slug,
            merchant.category,
            merchant.country_code,
            merchant.locality ?? null,
            merchant.source_updated_at,
          ],
        );
      }

      for (const offer of snapshot.offers) {
        await client.query(
          `INSERT INTO catalog_products (
             catalog_version_id, item_id, merchant_id, name, description, category, tags,
             price_minor, currency, availability, source_updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            catalogVersionId,
            offer.item_id,
            offer.merchant_id,
            offer.name,
            offer.description,
            offer.category,
            offer.tags,
            offer.price_minor,
            offer.currency,
            offer.availability,
            offer.source_updated_at,
          ],
        );
      }

      for (const projection of snapshot.projections) {
        const searchText = buildSearchText(projection);
        await client.query(
          `INSERT INTO catalog_search_documents (
             catalog_version_id, item_id, name, description, item_info, search_text, embedding, is_published
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::vector, false)`,
          [
            catalogVersionId,
            projection.item_id,
            projection.name,
            projection.description,
            projection.item_info,
            searchText,
            asVector(projection.embedding),
          ],
        );
      }

      const published = await client.query<{ id: string }>(
        `SELECT id FROM catalog_versions WHERE status = 'published' FOR UPDATE`,
      );
      const previousId = published.rows[0]?.id;
      if (previousId) {
        await client.query(
          `UPDATE catalog_search_documents SET is_published = false WHERE catalog_version_id = $1`,
          [previousId],
        );
        await client.query(
          `UPDATE catalog_versions SET status = 'superseded', published_at = NULL WHERE id = $1`,
          [previousId],
        );
      }
      await client.query(
        `UPDATE catalog_search_documents SET is_published = true WHERE catalog_version_id = $1`,
        [catalogVersionId],
      );
      await client.query(
        `UPDATE catalog_versions
         SET status = 'published', published_at = now()
         WHERE id = $1`,
        [catalogVersionId],
      );
      await this.seedCurrentFromSnapshot(client, snapshot);
      await client.query('COMMIT');
      return {
        catalog_version_id: catalogVersionId,
        version: snapshot.version,
        status: 'published',
        idempotent: false,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (err instanceof CatalogError) throw err;
      throw new CatalogError('Catalog publication failed', 'INVALID_CATALOG_FIXTURE');
    } finally {
      client.release();
    }
  }

  async rollback(version: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const target = await client.query<{ id: string }>(
        `SELECT id
         FROM catalog_versions
         WHERE version = $1
           AND status IN ('published', 'superseded')
         FOR UPDATE`,
        [version],
      );
      const targetId = target.rows[0]?.id;
      if (!targetId) {
        throw new CatalogError('Retained version is missing', 'CATALOG_UNAVAILABLE');
      }
      const current = await client.query<{ id: string }>(
        `SELECT id FROM catalog_versions WHERE status = 'published' FOR UPDATE`,
      );
      const currentId = current.rows[0]?.id;
      if (currentId && currentId !== targetId) {
        await client.query(
          `UPDATE catalog_search_documents SET is_published = false WHERE catalog_version_id = $1`,
          [currentId],
        );
        await client.query(
          `UPDATE catalog_versions SET status = 'superseded', published_at = NULL WHERE id = $1`,
          [currentId],
        );
      }
      await client.query(
        `UPDATE catalog_search_documents SET is_published = true WHERE catalog_version_id = $1`,
        [targetId],
      );
      await client.query(
        `UPDATE catalog_versions SET status = 'published', published_at = now() WHERE id = $1`,
        [targetId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (err instanceof CatalogError) throw err;
      throw new CatalogError('Catalog rollback failed', 'CATALOG_UNAVAILABLE');
    } finally {
      client.release();
    }
  }

  async searchActive(input: RepositorySearchInput): Promise<HydratedSearchResult> {
    const started = Date.now();
    let client: PoolClient | undefined;
    let hydrationQueries = 0;
    let searchMode: SearchMode = 'hnsw';
    let fallbackReason: string | undefined;
    let snapshotIsolation: string | undefined;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const isolation = await client.query<{ transaction_isolation: string }>('SHOW transaction_isolation');
      snapshotIsolation = isolation.rows[0]?.transaction_isolation;
      const meta = await client.query<{
        embedding_model: string;
        embedding_dimensions: number;
        as_of: Date;
      }>(
        `SELECT embedding_model, embedding_dimensions, updated_at AS as_of
         FROM catalog_search_documents_current
         ORDER BY updated_at DESC
         LIMIT 1`,
      );
      const active = meta.rows[0];
      if (!active) {
        throw new CatalogError('No current catalog is available', 'CATALOG_UNAVAILABLE');
      }
      if (
        active.embedding_model !== input.embedding_model ||
        active.embedding_dimensions !== input.embedding_dimensions
      ) {
        throw new CatalogError('Query embedding does not match the active catalog', 'EMBEDDING_UNAVAILABLE');
      }

      const readiness = await this.probeHnsw(client);
      const semantic = await this.discoverSemantic(client, {
        embedding: input.query_embedding,
        candidateK: input.candidate_k,
        readiness,
      });
      searchMode = semantic.mode;
      fallbackReason = semantic.fallbackReason;

      const lexical = await client.query<{ item_id: string }>(
        `SELECT item_id
         FROM catalog_search_documents_current
         WHERE search_tsv @@ plainto_tsquery('simple', $1)
         ORDER BY ts_rank_cd(search_tsv, plainto_tsquery('simple', $1)) DESC, item_id ASC
         LIMIT $2`,
        [input.query, input.candidate_k],
      );

      const ranked = reciprocalRankFusion({
        semantic: semantic.itemIds,
        lexical: lexical.rows.map((row) => row.item_id),
      });
      const candidateIds = ranked.map((row) => row.item_id);
      if (candidateIds.length === 0) {
        await client.query('COMMIT');
        this.lastSearch = { hydrationQueries: 0, searchMode, fallbackReason, snapshotIsolation };
        return {
          as_of: active.as_of.toISOString(),
          search_mode: searchMode,
          items: [],
        };
      }

      const hydrated = await client.query<{
        item_id: string;
        product_name: string;
        description: string;
        product_category: string;
        tags: string[];
        price_minor: string | null;
        currency: string | null;
        availability_status: string | null;
        available: boolean | null;
        tombstoned: boolean;
        data_revision: string;
        search_revision: string;
        index_revision: string;
        product_updated_at: Date;
        merchant_id: string;
        merchant_name: string;
        merchant_category: string;
        merchant_updated_at: Date;
        country_code: string;
      }>(
        `SELECT
           v.item_id,
           COALESCE(v.title, p.title, '') AS product_name,
           COALESCE(v.description_plain, p.description_plain, '') AS description,
           COALESCE(m.category, 'comercio') AS product_category,
           COALESCE(
             ARRAY(
               SELECT COALESCE(elem ->> 'value', elem #>> '{}')
               FROM jsonb_array_elements(COALESCE(v.categories, '[]'::jsonb)) AS elem
             ),
             '{}'
           ) AS tags,
           v.price_minor::text,
           v.currency,
           v.availability_status::text,
           v.available,
           v.tombstoned,
           v.data_revision::text,
           v.search_revision::text,
           v.index_revision::text,
           v.updated_at AS product_updated_at,
           m.merchant_id,
           m.name AS merchant_name,
           m.category AS merchant_category,
           m.updated_at AS merchant_updated_at,
           m.country_code
         FROM catalog_variants_current v
         JOIN catalog_products_current p
           ON p.feed_id = v.feed_id
          AND p.external_product_id = v.external_product_id
         JOIN catalog_product_feeds f ON f.feed_id = v.feed_id
         JOIN catalog_merchants_current m ON m.merchant_id = f.merchant_id
         WHERE v.item_id = ANY($1::text[])`,
        [candidateIds],
      );
      hydrationQueries = 1;
      if (hydrated.rows.length !== candidateIds.length) {
        throw new CatalogError('Candidate missing or version-mismatched', 'SEARCH_UNAVAILABLE');
      }

      const byId = new Map(hydrated.rows.map((row) => [row.item_id, row]));
      const items: HydratedSearchItem[] = [];
      for (const candidate of ranked) {
        const row = byId.get(candidate.item_id);
        if (!row) {
          throw new CatalogError('Candidate missing or version-mismatched', 'SEARCH_UNAVAILABLE');
        }
        if (
          row.tombstoned ||
          row.available === false ||
          row.availability_status === 'discontinued' ||
          row.country_code !== 'AR' ||
          row.currency !== 'ARS'
        ) {
          continue;
        }
        const availability =
          row.availability_status === 'in_stock'
            ? 'in_stock'
            : row.availability_status === 'out_of_stock'
              ? 'out_of_stock'
              : 'unknown';
        const item: HydratedSearchItem = {
          item_id: row.item_id,
          merchant: {
            merchant_id: row.merchant_id,
            name: row.merchant_name,
            category: row.merchant_category,
            accepts_juno: true,
          },
          product: {
            name: row.product_name,
            description: row.description,
            category: row.product_category,
            tags: row.tags ?? [],
          },
          price: {
            amount_minor: Number(row.price_minor ?? 0),
            currency: row.currency ?? 'ARS',
          },
          availability,
          score: candidate.score,
          updated_at: minIso([row.product_updated_at.toISOString(), row.merchant_updated_at.toISOString()]),
          data_revision: Number(row.data_revision),
          search_revision: Number(row.search_revision),
          index_revision: Number(row.index_revision),
        };
        if (matchesAuthoritativeFilters(item, input.filters)) {
          items.push(item);
        }
        if (items.length === input.top_k) break;
      }

      await client.query('COMMIT');
      this.lastSearch = { hydrationQueries, searchMode, fallbackReason, snapshotIsolation };
      console.log(
        JSON.stringify({
          event: 'catalog_search',
          latency_ms: Date.now() - started,
          candidate_count: candidateIds.length,
          result_count: items.length,
          search_mode: searchMode,
          fallback_reason: fallbackReason,
        }),
      );
      return {
        as_of: active.as_of.toISOString(),
        search_mode: searchMode,
        items,
      };
    } catch (err) {
      await client?.query('ROLLBACK').catch(() => undefined);
      this.lastSearch = { hydrationQueries, searchMode, fallbackReason, snapshotIsolation };
      if (err instanceof CatalogError) throw err;
      if (isGeneralDatabaseFailure(err)) {
        throw new CatalogError('Search unavailable', 'SEARCH_UNAVAILABLE');
      }
      throw err;
    } finally {
      client?.release();
    }
  }

  private async seedCurrentFromSnapshot(client: PoolClient, snapshot: DerivedCatalogSnapshot): Promise<void> {
    for (const merchant of snapshot.merchants) {
      await client.query(
        `INSERT INTO catalog_merchants_current (
           merchant_id, name, slug, category, country_code, locality, accepts_juno, updated_at
         ) VALUES ($1, $2, $3, $4, 'AR', $5, true, $6)
         ON CONFLICT (merchant_id) DO UPDATE SET
           name = EXCLUDED.name,
           slug = EXCLUDED.slug,
           category = EXCLUDED.category,
           locality = EXCLUDED.locality,
           updated_at = EXCLUDED.updated_at`,
        [
          merchant.merchant_id,
          merchant.name,
          merchant.slug,
          merchant.category,
          merchant.locality ?? null,
          merchant.source_updated_at,
        ],
      );
      await client.query(
        `INSERT INTO catalog_product_feeds (feed_id, merchant_id, target_country, updated_at)
         VALUES ($1, $2, 'AR', $3)
         ON CONFLICT (feed_id) DO UPDATE SET updated_at = EXCLUDED.updated_at`,
        [`juno-seed-${merchant.merchant_id}`, merchant.merchant_id, merchant.source_updated_at],
      );
    }

    for (const offer of snapshot.offers) {
      const feedId = `juno-seed-${offer.merchant_id}`;
      await client.query(
        `INSERT INTO catalog_products_current (
           feed_id, external_product_id, title, description_plain, updated_at
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (feed_id, external_product_id) DO UPDATE SET
           title = EXCLUDED.title,
           description_plain = EXCLUDED.description_plain,
           updated_at = EXCLUDED.updated_at`,
        [feedId, offer.item_id, offer.name, offer.description, offer.source_updated_at],
      );
      const availability =
        offer.availability === 'in_stock' || offer.availability === 'out_of_stock' ? offer.availability : 'unknown';
      await client.query(
        `INSERT INTO catalog_variants_current (
           feed_id, external_product_id, external_variant_id, item_id, title, description_plain,
           categories, price_minor, currency, available, availability_status, tombstoned,
           data_revision, search_revision, index_revision, updated_at
         ) VALUES (
           $1, $2, 'default', $3, $4, $5, $6::jsonb, $7, 'ARS', $8, $9, false, 1, 1, 1, $10
         )
         ON CONFLICT (feed_id, external_product_id, external_variant_id) DO UPDATE SET
           title = EXCLUDED.title,
           description_plain = EXCLUDED.description_plain,
           categories = EXCLUDED.categories,
           price_minor = EXCLUDED.price_minor,
           available = EXCLUDED.available,
           availability_status = EXCLUDED.availability_status,
           updated_at = EXCLUDED.updated_at`,
        [
          feedId,
          offer.item_id,
          offer.item_id,
          offer.name,
          offer.description,
          JSON.stringify(offer.tags.map((tag) => ({ value: tag }))),
          offer.price_minor,
          offer.availability === 'in_stock',
          availability,
          offer.source_updated_at,
        ],
      );
    }

    for (const projection of snapshot.projections) {
      const searchText = buildSearchText(projection);
      await client.query(
        `INSERT INTO catalog_search_documents_current (
           item_id, name, description, item_info, search_text, embedding, index_revision,
           embedding_model, embedding_dimensions
         ) VALUES ($1, $2, $3, $4, $5, $6::vector, 1, $7, $8)
         ON CONFLICT (item_id) DO UPDATE SET
           name = EXCLUDED.name,
           description = EXCLUDED.description,
           item_info = EXCLUDED.item_info,
           search_text = EXCLUDED.search_text,
           embedding = EXCLUDED.embedding,
           embedding_model = EXCLUDED.embedding_model`,
        [
          projection.item_id,
          projection.name,
          projection.description,
          projection.item_info,
          searchText,
          asVector(projection.embedding),
          snapshot.embedding_model,
          snapshot.embedding_dimensions,
        ],
      );
    }
  }

  private async probeHnsw(client: PoolClient): Promise<HnswReadiness> {
    const probe = await client.query<{ amname: string; indisvalid: boolean }>(
      `SELECT am.amname, ix.indisvalid
       FROM pg_index ix
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_am am ON am.oid = i.relam
       WHERE i.relname = 'catalog_search_current_embedding_hnsw'`,
    );
    return classifyHnswReadiness(probe.rows[0]);
  }

  private async discoverSemantic(
    client: PoolClient,
    input: {
      embedding: readonly number[];
      candidateK: number;
      readiness: HnswReadiness;
    },
  ): Promise<{ itemIds: string[]; mode: SearchMode; fallbackReason?: string }> {
    const runExact = async (reason: string) => {
      try {
        await client.query('SET LOCAL enable_indexscan = off');
        await client.query('SET LOCAL enable_bitmapscan = off');
        const rows = await this.exactCandidates(client, input);
        return { itemIds: rows, mode: 'exact_fallback' as const, fallbackReason: reason };
      } catch (err) {
        if (err instanceof CatalogError) throw err;
        throw new CatalogError('Search unavailable', 'SEARCH_UNAVAILABLE');
      }
    };

    if (shouldUseExactFallback({ readiness: input.readiness })) {
      return runExact('hnsw_index_not_ready');
    }

    await client.query('SET LOCAL enable_seqscan = off');
    await client.query('SET LOCAL enable_bitmapscan = off');
    await client.query("SET LOCAL hnsw.iterative_scan = 'strict_order'").catch(() => undefined);
    const itemIds = await this.hnswCandidates(client, input);
    return { itemIds, mode: 'hnsw' };
  }

  private async hnswCandidates(
    client: PoolClient,
    input: { embedding: readonly number[]; candidateK: number },
  ): Promise<string[]> {
    const rows = await client.query<{ item_id: string }>(HNSW_CANDIDATES_QUERY, [
      asVector(input.embedding),
      input.candidateK,
    ]);
    return rows.rows.map((row) => row.item_id);
  }

  private async exactCandidates(
    client: PoolClient,
    input: { embedding: readonly number[]; candidateK: number },
  ): Promise<string[]> {
    const rows = await client.query<{ item_id: string }>(EXACT_CANDIDATES_QUERY, [
      asVector(input.embedding),
      input.candidateK,
    ]);
    return rows.rows.map((row) => row.item_id);
  }
}
