import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  AcpError,
  hashApiKey,
  provisionMerchantApiKey,
  type MerchantApiKeyRecord,
  type MerchantKeyLookup,
  type MerchantKeyStore,
  type ProductFeedRecord,
} from './acp-contract.js';
import {
  AcpIngestionService,
  AcpWriteGuard,
  MemoryAcpCatalogStore,
  catalogItemId,
  type AcpAvailabilityStatus,
  type AcpIngestionOptions,
  type AcpProduct,
  type OutboxJob,
  type VariantRevision,
} from './ingestion.js';

export class PostgresMerchantKeyStore implements MerchantKeyStore {
  lookups: MerchantKeyLookup[] = [];

  constructor(private readonly pool: Pool) {}

  async findActiveByHash(keyHash: string): Promise<MerchantApiKeyRecord | undefined> {
    this.lookups.push({ kind: 'hash', key_hash: keyHash });
    const result = await this.pool.query<MerchantApiKeyRecord>(
      `SELECT merchant_id, key_prefix, key_hash, status::text AS status, revoked_at::text
       FROM catalog_merchant_api_keys
       WHERE key_hash = $1`,
      [keyHash],
    );
    return result.rows[0];
  }

  async findFeed(feedId: string): Promise<ProductFeedRecord | undefined> {
    this.lookups.push({ kind: 'feed', feed_id: feedId });
    const result = await this.pool.query<ProductFeedRecord>(
      `SELECT feed_id, merchant_id, target_country
       FROM catalog_product_feeds
       WHERE feed_id = $1`,
      [feedId],
    );
    return result.rows[0];
  }
}

export class PostgresAcpIngestionService {
  private readonly writeGuard: AcpWriteGuard;

  constructor(
    private readonly pool: Pool,
    private readonly options: AcpIngestionOptions = {},
  ) {
    this.writeGuard = new AcpWriteGuard(options);
  }

  private service(store: MemoryAcpCatalogStore): AcpIngestionService {
    return new AcpIngestionService(store, this.options, this.writeGuard);
  }

  validateMutationHeaders(input: Parameters<AcpIngestionService['validateMutationHeaders']>[0]): void {
    this.service(new MemoryAcpCatalogStore()).validateMutationHeaders(input);
  }

  private async withFeedLock<T>(
    feedId: string,
    work: (client: PoolClient, memory: MemoryAcpCatalogStore) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (feedId) {
        await client.query('SELECT feed_id FROM catalog_product_feeds WHERE feed_id = $1 FOR UPDATE', [feedId]);
      }
      const memory = await loadMemory(client, feedId);
      const result = await work(client, memory);
      await persistMemory(client, memory, feedId);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async createFeed(input: {
    merchantId: string;
    rawBody: string;
    idempotencyKey: string;
    path: string;
  }): Promise<{ id: string; target_country: 'AR'; updated_at: string }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `${input.merchantId}|POST|${input.path}|${input.idempotencyKey}`,
      ]);
      const memory = await loadMemory(client, '');
      const created = this.service(memory).createFeed(input);
      await persistMemory(client, memory, created.id);
      await client.query('COMMIT');
      return created;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async getFeed(feedId: string): Promise<{ id: string; target_country: 'AR'; updated_at: string }> {
    const client = await this.pool.connect();
    try {
      return this.service(await loadMemory(client, feedId)).getFeed(feedId);
    } finally {
      client.release();
    }
  }

  async getProducts(feedId: string): Promise<{ target_country: 'AR'; products: AcpProduct[] }> {
    const client = await this.pool.connect();
    try {
      return this.service(await loadMemory(client, feedId)).getProducts(feedId);
    } finally {
      client.release();
    }
  }

  async patchProducts(input: {
    merchantId: string;
    feedId: string;
    rawBody: string;
    idempotencyKey: string;
    path: string;
  }): Promise<{ id: string; accepted: true }> {
    return this.withFeedLock(input.feedId, async (_client, memory) =>
      this.service(memory).patchProducts(input),
    );
  }
}

async function loadMemory(client: PoolClient, feedId: string): Promise<MemoryAcpCatalogStore> {
  const memory = new MemoryAcpCatalogStore();
  const receipts = await client.query<{
    merchant_id: string;
    idempotency_key: string;
    method: string;
    path: string;
    body_hash: string;
    response_status: number;
    response_body: unknown;
  }>(`SELECT merchant_id, idempotency_key, method, path, body_hash, response_status, response_body FROM catalog_ingest_receipts`);
  for (const row of receipts.rows) {
    memory.receipts.set(memory.receiptKey(row.merchant_id, row.method, row.path, row.idempotency_key), {
      body_hash: row.body_hash,
      status: row.response_status,
      body: row.response_body,
    });
  }
  if (!feedId) return memory;
  const feed = await client.query<{ feed_id: string; merchant_id: string; target_country: 'AR'; updated_at: Date }>(
    `SELECT feed_id, merchant_id, target_country, updated_at FROM catalog_product_feeds WHERE feed_id = $1`,
    [feedId],
  );
  const current = feed.rows[0];
  if (!current) return memory;
  memory.putFeed(current);
  memory.feedState.set(current.feed_id, { ...current, updated_at: current.updated_at.toISOString() });
  const products = await client.query<{
    external_product_id: string;
    title: string | null;
    description_plain: string | null;
    url: string | null;
    media: unknown;
  }>(
    `SELECT external_product_id, title, description_plain, url, media FROM catalog_products_current WHERE feed_id = $1`,
    [feedId],
  );
  const variants = await client.query<{
    external_product_id: string;
    external_variant_id: string;
    item_id: string;
    title: string;
    description_plain: string | null;
    url: string | null;
    media: unknown;
    categories: unknown;
    variant_options: unknown;
    price_minor: string | null;
    list_price_minor: string | null;
    unit_price: unknown;
    currency: string | null;
    available: boolean | null;
    availability_status: string | null;
    data_revision: string;
    search_revision: string;
    index_revision: string;
    tombstoned: boolean;
  }>(
    `SELECT * FROM catalog_variants_current WHERE feed_id = $1`,
    [feedId],
  );
  const byProduct = new Map<string, AcpProduct>();
  for (const product of products.rows) {
    byProduct.set(product.external_product_id, {
      id: product.external_product_id,
      title: product.title ?? undefined,
      description: product.description_plain ? { plain: product.description_plain } : undefined,
      url: product.url ?? undefined,
      media: (product.media as AcpProduct['media']) ?? [],
      variants: [],
    });
  }
  for (const variant of variants.rows) {
    const product = byProduct.get(variant.external_product_id) ?? {
      id: variant.external_product_id,
      variants: [],
    };
    product.variants.push({
      id: variant.external_variant_id,
      title: variant.title,
      description: variant.description_plain ? { plain: variant.description_plain } : undefined,
      url: variant.url ?? undefined,
      media: (variant.media as AcpProduct['variants'][number]['media']) ?? [],
      categories: (variant.categories as AcpProduct['variants'][number]['categories']) ?? [],
      variant_options: (variant.variant_options as AcpProduct['variants'][number]['variant_options']) ?? [],
      price:
        variant.price_minor && variant.currency === 'ARS'
          ? { amount: Number(variant.price_minor), currency: 'ARS' }
          : undefined,
      list_price:
        variant.list_price_minor != null
          ? { amount: Number(variant.list_price_minor), currency: 'ARS' }
          : undefined,
      unit_price: (variant.unit_price as AcpProduct['variants'][number]['unit_price']) ?? undefined,
      availability: {
        available: variant.available ?? undefined,
        status: (variant.availability_status as AcpAvailabilityStatus | null) ?? undefined,
      },
    });
    memory.revisions.set(variant.item_id, {
      data_revision: Number(variant.data_revision),
      search_revision: Number(variant.search_revision),
      index_revision: Number(variant.index_revision),
      tombstoned: variant.tombstoned,
    });
    byProduct.set(variant.external_product_id, product);
  }
  memory.products.set(feedId, byProduct);
  return memory;
}

async function persistMemory(client: PoolClient, memory: MemoryAcpCatalogStore, feedId: string): Promise<void> {
  for (const [key, receipt] of memory.receipts) {
    const [merchantId, method, path, idempotencyKey] = key.split('|');
    await client.query(
      `INSERT INTO catalog_ingest_receipts (
         merchant_id, idempotency_key, method, path, body_hash, response_status, response_body
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (merchant_id, idempotency_key, method, path) DO NOTHING`,
      [merchantId, idempotencyKey, method, path, receipt.body_hash, receipt.status, JSON.stringify(receipt.body)],
    );
  }
  for (const feed of memory.feedState.values()) {
    await client.query(
      `INSERT INTO catalog_product_feeds (feed_id, merchant_id, target_country, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (feed_id) DO UPDATE SET updated_at = EXCLUDED.updated_at`,
      [feed.feed_id, feed.merchant_id, feed.target_country, feed.updated_at],
    );
  }
  if (!feedId) return;
  const products = memory.products.get(feedId) ?? new Map();
  for (const product of products.values()) {
    await client.query(
      `INSERT INTO catalog_products_current (
         feed_id, external_product_id, title, description_plain, url, media, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, now())
       ON CONFLICT (feed_id, external_product_id) DO UPDATE SET
         title = EXCLUDED.title,
         description_plain = EXCLUDED.description_plain,
         url = EXCLUDED.url,
         media = EXCLUDED.media,
         updated_at = now()`,
      [
        feedId,
        product.id,
        product.title ?? null,
        product.description?.plain ?? null,
        product.url ?? null,
        JSON.stringify(product.media ?? []),
      ],
    );
    for (const variant of product.variants) {
      const itemId = catalogItemId(feedId, product.id, variant.id);
      const revision: VariantRevision = memory.revisions.get(itemId) ?? {
        data_revision: 1,
        search_revision: 1,
        index_revision: 0,
        tombstoned: false,
      };
      await client.query(
        `INSERT INTO catalog_variants_current (
           feed_id, external_product_id, external_variant_id, item_id, title, description_plain, url, media,
           categories, variant_options, price_minor, list_price_minor, unit_price, currency, available, availability_status, tombstoned,
           data_revision, search_revision, index_revision, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13::jsonb, $14, $15, $16, $17, $18, $19, $20, now()
         )
         ON CONFLICT (feed_id, external_product_id, external_variant_id) DO UPDATE SET
           title = EXCLUDED.title,
           description_plain = EXCLUDED.description_plain,
           url = EXCLUDED.url,
           media = EXCLUDED.media,
           categories = EXCLUDED.categories,
           variant_options = EXCLUDED.variant_options,
           price_minor = EXCLUDED.price_minor,
           list_price_minor = EXCLUDED.list_price_minor,
           unit_price = EXCLUDED.unit_price,
           currency = EXCLUDED.currency,
           available = EXCLUDED.available,
           availability_status = EXCLUDED.availability_status,
           tombstoned = EXCLUDED.tombstoned,
           data_revision = EXCLUDED.data_revision,
           search_revision = EXCLUDED.search_revision,
           updated_at = now()`,
        [
          feedId,
          product.id,
          variant.id,
          itemId,
          variant.title ?? product.title ?? '',
          variant.description?.plain ?? null,
          variant.url ?? null,
          JSON.stringify(variant.media ?? []),
          JSON.stringify(variant.categories ?? []),
          JSON.stringify(variant.variant_options ?? []),
          variant.price?.amount ?? null,
          variant.list_price?.amount ?? null,
          variant.unit_price ? JSON.stringify(variant.unit_price) : null,
          variant.price?.currency ?? null,
          variant.availability?.available ?? null,
          variant.availability?.status ?? null,
          revision.tombstoned,
          revision.data_revision,
          revision.search_revision,
          revision.index_revision,
        ],
      );
    }
  }
  for (const job of memory.outbox) {
    await insertOutbox(client, job);
  }
}

async function insertOutbox(client: PoolClient, job: OutboxJob): Promise<void> {
  await client.query(
    `INSERT INTO catalog_reindex_outbox (
       id, item_id, feed_id, external_product_id, external_variant_id, search_revision, operation, status, attempts
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)`,
    [
      job.id || randomUUID(),
      job.item_id,
      job.feed_id,
      job.external_product_id,
      job.external_variant_id,
      job.search_revision,
      job.operation,
      job.attempts,
    ],
  );
}

export async function revokeMerchantApiKeyInPostgres(pool: Pool, rawKey: string): Promise<void> {
  const digest = hashApiKey(rawKey);
  const updated = await pool.query(
    `UPDATE catalog_merchant_api_keys
     SET status = 'revoked', revoked_at = now()
     WHERE key_hash = $1 AND status = 'active'`,
    [digest],
  );
  if ((updated.rowCount ?? 0) === 0) {
    throw new AcpError('No autorizado', 'UNAUTHORIZED', 401);
  }
}

export async function rotateMerchantApiKeyInPostgres(
  pool: Pool,
  previousRawKey: string,
): Promise<{ merchant_id: string; raw: string }> {
  const digest = hashApiKey(previousRawKey);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query<{ merchant_id: string }>(
      `SELECT merchant_id FROM catalog_merchant_api_keys
       WHERE key_hash = $1 AND status = 'active'
       FOR UPDATE`,
      [digest],
    );
    const merchantId = found.rows[0]?.merchant_id;
    if (!merchantId) {
      throw new AcpError('No autorizado', 'UNAUTHORIZED', 401);
    }
    const revoked = await client.query(
      `UPDATE catalog_merchant_api_keys
       SET status = 'revoked', revoked_at = now()
       WHERE key_hash = $1 AND status = 'active'`,
      [digest],
    );
    if ((revoked.rowCount ?? 0) === 0) {
      throw new AcpError('No autorizado', 'UNAUTHORIZED', 401);
    }
    const issued = provisionMerchantApiKey({ merchantId });
    await client.query(
      `INSERT INTO catalog_merchant_api_keys (merchant_id, key_prefix, key_hash, status)
       VALUES ($1, $2, $3, 'active')`,
      [issued.record.merchant_id, issued.record.key_prefix, issued.record.key_hash],
    );
    await client.query('COMMIT');
    return { merchant_id: merchantId, raw: issued.raw };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function provisionMerchantInPostgres(
  pool: Pool,
  input: { merchant_id: string; name: string; slug: string; category: string; rawKey?: string },
): Promise<{ raw: string; merchant_id: string }> {
  const raw = input.rawKey ?? `juno_${randomUUID().replaceAll('-', '')}`;
  const hash = hashApiKey(raw);
  await pool.query(
    `INSERT INTO catalog_merchants_current (
       merchant_id, name, slug, category, country_code, accepts_juno
     ) VALUES ($1, $2, $3, $4, 'AR', true)
     ON CONFLICT (merchant_id) DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug`,
    [input.merchant_id, input.name, input.slug, input.category],
  );
  await pool.query(
    `INSERT INTO catalog_merchant_api_keys (merchant_id, key_prefix, key_hash, status)
     VALUES ($1, $2, $3, 'active')
     ON CONFLICT (key_hash) DO NOTHING`,
    [input.merchant_id, raw.slice(0, 8), hash],
  );
  return { raw, merchant_id: input.merchant_id };
}
