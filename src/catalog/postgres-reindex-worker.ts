import type { Pool, PoolClient } from 'pg';
import type { EmbeddingProvider } from './domain.js';
import { buildAcpSearchableFields, buildSearchText } from './projection.js';

export interface PostgresWorkerOptions {
  leaseMs?: number;
  maxAttempts?: number;
}

export class PostgresReindexWorker {
  private stopping = false;
  private claimedId: string | undefined;

  constructor(
    private readonly pool: Pool,
    private readonly embedding: EmbeddingProvider,
    private readonly options: PostgresWorkerOptions = {},
  ) {}

  requestStop(): void {
    this.stopping = true;
  }

  async drain(): Promise<void> {
    if (!this.claimedId) return;
    await this.pool.query(
      `UPDATE catalog_reindex_outbox
       SET status = 'pending', lease_until = NULL, updated_at = now()
       WHERE id = $1 AND status = 'leased'`,
      [this.claimedId],
    );
    this.claimedId = undefined;
  }

  async runLoop(): Promise<void> {
    while (!this.stopping) {
      const worked = await this.processNext();
      if (!worked) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }

  async processNext(): Promise<boolean> {
    if (this.stopping) return false;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const leaseMs = this.options.leaseMs ?? 30_000;
      const claimed = await client.query<{
        id: string;
        item_id: string;
        feed_id: string;
        external_product_id: string;
        external_variant_id: string;
        search_revision: string;
        operation: 'upsert' | 'delete';
        attempts: number;
      }>(
        `SELECT id, item_id, feed_id, external_product_id, external_variant_id, search_revision::text, operation, attempts
         FROM catalog_reindex_outbox
         WHERE (status = 'pending' AND (lease_until IS NULL OR lease_until <= now()))
            OR (status = 'leased' AND lease_until IS NOT NULL AND lease_until <= now())
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
      );
      const job = claimed.rows[0];
      if (!job) {
        await client.query('COMMIT');
        return false;
      }
      this.claimedId = job.id;
      await client.query(
        `UPDATE catalog_reindex_outbox
         SET status = 'leased', lease_until = now() + ($2 * interval '1 millisecond'), updated_at = now()
         WHERE id = $1`,
        [job.id, leaseMs],
      );
      try {
        await this.execute(client, job);
        await client.query(
          `UPDATE catalog_reindex_outbox
           SET status = 'done', lease_until = NULL, updated_at = now()
           WHERE id = $1`,
          [job.id],
        );
        await client.query('COMMIT');
        this.claimedId = undefined;
        return true;
      } catch (err) {
        const attempts = job.attempts + 1;
        const maxAttempts = this.options.maxAttempts ?? 5;
        await client.query('ROLLBACK');
        await this.pool.query(
          `UPDATE catalog_reindex_outbox
           SET status = $2, attempts = $3, last_error = $4,
               lease_until = CASE WHEN $2 = 'pending' THEN now() + ($5 * interval '1 millisecond') ELSE NULL END,
               updated_at = now()
           WHERE id = $1`,
          [
            job.id,
            attempts >= maxAttempts ? 'dead_letter' : 'pending',
            attempts,
            err instanceof Error ? err.message : String(err),
            Math.min(30_000, 1000 * 2 ** (attempts - 1)),
          ],
        );
        this.claimedId = undefined;
        return true;
      }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      this.claimedId = undefined;
      throw err;
    } finally {
      client.release();
    }
  }

  private async execute(
    client: PoolClient,
    job: {
      item_id: string;
      feed_id: string;
      external_product_id: string;
      external_variant_id: string;
      search_revision: string;
      operation: 'upsert' | 'delete';
    },
  ): Promise<void> {
    const revision = Number(job.search_revision);
    if (job.operation === 'delete') {
      await client.query('DELETE FROM catalog_search_documents_current WHERE item_id = $1', [job.item_id]);
      return;
    }
    const current = await client.query<{ search_revision: string; index_revision: string }>(
      `SELECT search_revision::text, index_revision::text FROM catalog_variants_current WHERE item_id = $1`,
      [job.item_id],
    );
    const row = current.rows[0];
    if (!row || revision < Number(row.search_revision) || Number(row.index_revision) >= revision) {
      return;
    }
    const loaded = await client.query<{
      product_title: string | null;
      product_description: string | null;
      variant_title: string;
      variant_description: string | null;
      categories: unknown;
      variant_options: unknown;
    }>(
      `SELECT
         p.title AS product_title,
         p.description_plain AS product_description,
         v.title AS variant_title,
         v.description_plain AS variant_description,
         v.categories,
         v.variant_options
       FROM catalog_variants_current v
       JOIN catalog_products_current p
         ON p.feed_id = v.feed_id AND p.external_product_id = v.external_product_id
       WHERE v.item_id = $1`,
      [job.item_id],
    );
    const product = loaded.rows[0];
    if (!product) throw new Error('variant missing for outbox job');
    const fields = buildAcpSearchableFields(
      { title: product.product_title ?? undefined, description: { plain: product.product_description ?? undefined } },
      {
        title: product.variant_title,
        description: { plain: product.variant_description ?? undefined },
        categories: product.categories as Array<{ value: string }>,
        variant_options: product.variant_options as Array<{ name: string; value: string }>,
      },
    );
    const searchText = buildSearchText(fields);
    const vectors = await this.embedding.embed([searchText]);
    const embedding = vectors[0];
    if (!embedding || embedding.length !== this.embedding.dimensions) {
      throw new Error('incompatible embedding');
    }
    const latest = await client.query<{ search_revision: string }>(
      `SELECT search_revision::text FROM catalog_variants_current WHERE item_id = $1`,
      [job.item_id],
    );
    if (latest.rows[0] && revision < Number(latest.rows[0].search_revision)) {
      return;
    }
    await client.query(
      `INSERT INTO catalog_search_documents_current (
         item_id, name, description, item_info, search_text, embedding, index_revision,
         embedding_model, embedding_dimensions
       ) VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8, $9)
       ON CONFLICT (item_id) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         item_info = EXCLUDED.item_info,
         search_text = EXCLUDED.search_text,
         embedding = EXCLUDED.embedding,
         index_revision = EXCLUDED.index_revision,
         embedding_model = EXCLUDED.embedding_model,
         updated_at = now()`,
      [
        job.item_id,
        fields.name,
        fields.description,
        fields.item_info,
        searchText,
        `[${embedding.join(',')}]`,
        revision,
        this.embedding.model,
        this.embedding.dimensions,
      ],
    );
    await client.query(
      `UPDATE catalog_variants_current SET index_revision = $2, updated_at = now() WHERE item_id = $1 AND search_revision = $2`,
      [job.item_id, revision],
    );
  }
}
