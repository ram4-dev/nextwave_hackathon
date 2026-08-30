import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ACP_ACCEPT_LANGUAGE,
  ACP_API_VERSION,
  ACP_CURRENCY,
  ACP_PRODUCTS_PER_PATCH,
  ACP_REQUEST_LIMIT_BYTES,
  ACP_TARGET_COUNTRY,
  ACP_TIMESTAMP_WINDOW_MS,
  ACP_VARIANTS_PER_PRODUCT,
  AcpError,
  MemoryMerchantKeyStore,
  provisionMerchantApiKey,
  type MerchantApiKeyRecord,
  type MerchantKeyStore,
  type ProductFeedRecord,
} from './acp-contract.js';

export type AcpAvailabilityStatus =
  | 'in_stock'
  | 'backorder'
  | 'preorder'
  | 'out_of_stock'
  | 'discontinued'
  | 'unknown';

export interface AcpPrice {
  amount: number;
  currency: typeof ACP_CURRENCY;
}

export interface AcpVariant {
  id: string;
  title?: string;
  description?: { plain?: string; html?: string; markdown?: string };
  url?: string;
  price?: AcpPrice;
  list_price?: AcpPrice;
  unit_price?: Record<string, unknown>;
  availability?: { available?: boolean; status?: AcpAvailabilityStatus };
  categories?: Array<{ value: string; taxonomy?: string }>;
  variant_options?: Array<{ name: string; value: string }>;
  media?: unknown[];
  barcodes?: unknown[];
  condition?: string[];
  seller?: unknown;
}

export interface AcpProduct {
  id: string;
  title?: string;
  description?: { plain?: string; html?: string; markdown?: string };
  url?: string;
  media?: unknown[];
  variants: AcpVariant[];
}

export interface VariantRevision {
  data_revision: number;
  search_revision: number;
  index_revision: number;
  tombstoned: boolean;
}

export interface OutboxJob {
  id: string;
  item_id: string;
  feed_id: string;
  external_product_id: string;
  external_variant_id: string;
  search_revision: number;
  operation: 'upsert' | 'delete';
  status: 'pending' | 'leased' | 'done' | 'dead_letter';
  attempts: number;
  lease_until?: string;
  last_error?: string;
}

const priceSchema = z
  .object({
    amount: z.number().int().min(0),
    currency: z.literal(ACP_CURRENCY),
  })
  .strict();

const variantSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1).optional(),
    description: z
      .object({
        plain: z.string().optional(),
        html: z.string().optional(),
        markdown: z.string().optional(),
      })
      .strict()
      .optional(),
    url: z.string().optional(),
    price: priceSchema.optional(),
    list_price: priceSchema.optional(),
    unit_price: z
      .object({
        amount: z.number().int(),
        currency: z.literal(ACP_CURRENCY),
        measure: z.unknown(),
        reference: z.unknown(),
      })
      .passthrough()
      .optional(),
    availability: z
      .object({
        available: z.boolean().optional(),
        status: z
          .enum(['in_stock', 'backorder', 'preorder', 'out_of_stock', 'discontinued', 'unknown'])
          .optional(),
      })
      .strict()
      .optional(),
    categories: z.array(z.object({ value: z.string(), taxonomy: z.string().optional() }).strict()).optional(),
    variant_options: z.array(z.object({ name: z.string(), value: z.string() }).strict()).optional(),
    media: z.array(z.record(z.unknown())).optional(),
    barcodes: z.array(z.unknown()).optional(),
    condition: z.array(z.string()).optional(),
    seller: z.unknown().optional(),
  })
  .strict();

const productSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().optional(),
    description: z
      .object({
        plain: z.string().optional(),
        html: z.string().optional(),
        markdown: z.string().optional(),
      })
      .strict()
      .optional(),
    url: z.string().optional(),
    media: z.array(z.record(z.unknown())).optional(),
    variants: z.array(variantSchema).max(ACP_VARIANTS_PER_PRODUCT).optional(),
  })
  .strict();

const patchSchema = z
  .object({
    target_country: z.literal(ACP_TARGET_COUNTRY).optional(),
    products: z.array(productSchema).max(ACP_PRODUCTS_PER_PATCH),
  })
  .strict();

export function catalogItemId(feedId: string, productId: string, variantId: string): string {
  return `${feedId}::${productId}::${variantId}`;
}

export function hashRequestBody(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

function searchableFingerprint(product: AcpProduct, variant: AcpVariant): string {
  return JSON.stringify({
    product_title: product.title ?? '',
    product_description: product.description?.plain ?? '',
    product_media: product.media ?? [],
    title: variant.title ?? '',
    description: variant.description?.plain ?? '',
    categories: variant.categories ?? [],
    variant_options: variant.variant_options ?? [],
  });
}

export function isTombstone(variant: AcpVariant): boolean {
  return variant.availability?.status === 'discontinued' || variant.availability?.available === false;
}

function mergeDefined<T>(current: T, patch: object): T {
  const next: Record<string, unknown> = { ...(current as object) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || key === 'variants') continue;
    next[key] = value;
  }
  return next as T;
}

export class MemoryAcpCatalogStore extends MemoryMerchantKeyStore {
  merchants = new Map<string, { merchant_id: string; name: string; slug: string; category: string }>();
  feedState = new Map<string, ProductFeedRecord & { updated_at: string }>();
  products = new Map<string, Map<string, AcpProduct>>();
  revisions = new Map<string, VariantRevision>();
  receipts = new Map<string, { body_hash: string; status: number; body: unknown }>();
  outbox: OutboxJob[] = [];
  documents = new Map<
    string,
    {
      item_id: string;
      name: string;
      description: string;
      item_info: string;
      search_text: string;
      embedding: readonly number[];
      index_revision: number;
    }
  >();

  provisionMerchant(input: {
    merchant_id: string;
    name: string;
    slug: string;
    category: string;
  }): { raw: string; record: MerchantApiKeyRecord } {
    this.merchants.set(input.merchant_id, input);
    const issued = provisionMerchantApiKey({ merchantId: input.merchant_id });
    this.putKey(issued.record);
    return issued;
  }

  feedCount(): number {
    return this.feedState.size;
  }

  variantCount(feedId: string): number {
    const products = this.products.get(feedId);
    if (!products) return 0;
    return [...products.values()].reduce((sum, product) => sum + product.variants.length, 0);
  }

  getProducts(feedId: string): AcpProduct[] {
    return [...(this.products.get(feedId)?.values() ?? [])].map((product) => ({
      ...product,
      variants: product.variants.map((variant) => ({ ...variant })),
    }));
  }

  getVariantRevisions(feedId: string, productId: string, variantId: string): VariantRevision {
    return { ...this.revisions.get(catalogItemId(feedId, productId, variantId))! };
  }

  markIndexed(feedId: string, productId: string, variantId: string): void {
    const itemId = catalogItemId(feedId, productId, variantId);
    const current = this.revisions.get(itemId);
    if (!current) return;
    this.revisions.set(itemId, { ...current, index_revision: current.search_revision });
  }

  receiptKey(merchantId: string, method: string, path: string, idempotencyKey: string): string {
    return `${merchantId}|${method}|${path}|${idempotencyKey}`;
  }
}

export interface AcpIngestionOptions {
  now?: () => Date;
  maxRequestsPerWindow?: number;
  storageUnavailable?: boolean;
}

export function acpIngestionOptionsFromConfig(config: {
  CATALOG_ACP_RATE_LIMIT?: number;
}): AcpIngestionOptions {
  return { maxRequestsPerWindow: config.CATALOG_ACP_RATE_LIMIT };
}

export class AcpWriteGuard {
  private readonly hits = new Map<string, number>();

  constructor(private readonly options: AcpIngestionOptions = {}) {}

  assertWritable(merchantId: string): void {
    if (this.options.storageUnavailable) {
      throw new AcpError('Almacenamiento no disponible', 'STORAGE_UNAVAILABLE', 503);
    }
    if (this.options.maxRequestsPerWindow !== undefined) {
      const used = this.hits.get(merchantId) ?? 0;
      if (used >= this.options.maxRequestsPerWindow) {
        throw new AcpError('Límite de solicitudes excedido', 'RATE_LIMITED', 429);
      }
      this.hits.set(merchantId, used + 1);
    }
  }
}

export class AcpIngestionService {
  private readonly writeGuard: AcpWriteGuard;

  constructor(
    private readonly store: MemoryAcpCatalogStore,
    private readonly options: AcpIngestionOptions = {},
    writeGuard?: AcpWriteGuard,
  ) {
    this.writeGuard = writeGuard ?? new AcpWriteGuard(options);
  }

  validateMutationHeaders(input: {
    contentType?: string;
    apiVersion?: string;
    idempotencyKey?: string;
    requestId?: string;
    timestamp?: string;
    acceptLanguage?: string;
    contentLength?: number;
  }): void {
    if (input.contentLength !== undefined && input.contentLength > ACP_REQUEST_LIMIT_BYTES) {
      throw new AcpError('El cuerpo supera 1 MiB', 'PAYLOAD_TOO_LARGE', 413);
    }
    if (!input.contentType?.includes('application/json')) {
      throw new AcpError('Content-Type debe ser application/json', 'INVALID_ACP_REQUEST', 400);
    }
    if (input.apiVersion !== ACP_API_VERSION) {
      throw new AcpError('API-Version inválida', 'INVALID_ACP_REQUEST', 400);
    }
    if (!input.idempotencyKey) {
      throw new AcpError('Falta Idempotency-Key', 'INVALID_ACP_REQUEST', 400);
    }
    if (!input.requestId) {
      throw new AcpError('Falta Request-Id', 'INVALID_ACP_REQUEST', 400);
    }
    if (input.acceptLanguage !== ACP_ACCEPT_LANGUAGE) {
      throw new AcpError('Accept-Language debe ser es-AR', 'INVALID_ACP_REQUEST', 400);
    }
    if (!input.timestamp || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(input.timestamp)) {
      throw new AcpError('La marca de tiempo expiró o es inválida', 'INVALID_ACP_REQUEST', 400);
    }
    const ts = Date.parse(input.timestamp);
    const now = (this.options.now ?? (() => new Date()))().getTime();
    if (!Number.isFinite(ts) || Math.abs(now - ts) > ACP_TIMESTAMP_WINDOW_MS) {
      throw new AcpError('La marca de tiempo expiró o es inválida', 'INVALID_ACP_REQUEST', 400);
    }
  }

  private assertWritable(merchantId: string): void {
    this.writeGuard.assertWritable(merchantId);
  }

  private replayOrLock(
    merchantId: string,
    method: string,
    path: string,
    idempotencyKey: string,
    body: string,
  ): { status: number; body: unknown } | undefined {
    const key = this.store.receiptKey(merchantId, method, path, idempotencyKey);
    const existing = this.store.receipts.get(key);
    const digest = hashRequestBody(body);
    if (!existing) return undefined;
    if (existing.body_hash !== digest) {
      throw new AcpError('Conflicto de idempotencia', 'IDEMPOTENCY_CONFLICT', 409);
    }
    return { status: existing.status, body: existing.body };
  }

  private saveReceipt(
    merchantId: string,
    method: string,
    path: string,
    idempotencyKey: string,
    body: string,
    status: number,
    response: unknown,
  ): void {
    this.store.receipts.set(this.store.receiptKey(merchantId, method, path, idempotencyKey), {
      body_hash: hashRequestBody(body),
      status,
      body: response,
    });
  }

  createFeed(input: {
    merchantId: string;
    rawBody: string;
    idempotencyKey: string;
    path: string;
  }): { id: string; target_country: 'AR'; updated_at: string } {
    const replay = this.replayOrLock(input.merchantId, 'POST', input.path, input.idempotencyKey, input.rawBody);
    if (replay) return replay.body as { id: string; target_country: 'AR'; updated_at: string };
    this.assertWritable(input.merchantId);
    let parsed: { target_country?: string };
    try {
      parsed = JSON.parse(input.rawBody) as { target_country?: string };
    } catch {
      throw new AcpError('JSON inválido', 'INVALID_ACP_REQUEST', 400);
    }
    if (parsed.target_country !== ACP_TARGET_COUNTRY) {
      throw new AcpError('El mercado debe ser AR', 'INVALID_ACP_REQUEST', 400);
    }
    const feed = {
      feed_id: randomUUID(),
      merchant_id: input.merchantId,
      target_country: ACP_TARGET_COUNTRY,
      updated_at: new Date().toISOString(),
    };
    this.store.putFeed(feed);
    this.store.feedState.set(feed.feed_id, feed);
    this.store.products.set(feed.feed_id, new Map());
    const response = { id: feed.feed_id, target_country: feed.target_country, updated_at: feed.updated_at };
    this.saveReceipt(input.merchantId, 'POST', input.path, input.idempotencyKey, input.rawBody, 200, response);
    return response;
  }

  getFeed(feedId: string): { id: string; target_country: 'AR'; updated_at: string } {
    const feed = this.store.feedState.get(feedId);
    if (!feed) throw new AcpError('Feed no encontrado', 'NOT_FOUND', 404);
    return { id: feed.feed_id, target_country: feed.target_country, updated_at: feed.updated_at };
  }

  getProducts(feedId: string): { target_country: 'AR'; products: AcpProduct[] } {
    const feed = this.store.feedState.get(feedId);
    if (!feed) throw new AcpError('Feed no encontrado', 'NOT_FOUND', 404);
    return { target_country: feed.target_country, products: this.store.getProducts(feedId) };
  }

  patchProducts(input: {
    merchantId: string;
    feedId: string;
    rawBody: string;
    idempotencyKey: string;
    path: string;
  }): { id: string; accepted: true } {
    const replay = this.replayOrLock(input.merchantId, 'PATCH', input.path, input.idempotencyKey, input.rawBody);
    if (replay) return replay.body as { id: string; accepted: true };
    this.assertWritable(input.merchantId);
    const feed = this.store.feedState.get(input.feedId);
    if (!feed || feed.merchant_id !== input.merchantId) {
      throw new AcpError('Feed no encontrado', 'NOT_FOUND', 404);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.rawBody);
    } catch {
      throw new AcpError('JSON inválido', 'INVALID_ACP_REQUEST', 400);
    }
    const body = patchSchema.safeParse(parsed);
    if (!body.success) {
      const currencyIssue = body.error.issues.some((issue) => String(issue.path).includes('currency'));
      throw new AcpError(
        currencyIssue ? 'Los precios deben usar ARS' : 'El payload de productos es inválido',
        'INVALID_ACP_REQUEST',
        400,
      );
    }
    if (body.data.products.length > ACP_PRODUCTS_PER_PATCH) {
      throw new AcpError('El PATCH admite como máximo 100 productos', 'INVALID_ACP_REQUEST', 400);
    }
    const current = this.store.products.get(input.feedId) ?? new Map<string, AcpProduct>();
    for (const patchProduct of body.data.products) {
      const patchVariants = patchProduct.variants ?? [];
      if (patchVariants.length > ACP_VARIANTS_PER_PRODUCT) {
        throw new AcpError('El PATCH admite como máximo 100 variants por producto', 'INVALID_ACP_REQUEST', 400);
      }
      const existing = current.get(patchProduct.id);
      const mergedProduct = existing
        ? mergeDefined(existing, patchProduct)
        : { ...patchProduct, variants: [] };
      const variants = new Map((existing?.variants ?? []).map((variant) => [variant.id, variant]));
      const enqueue = (variant: AcpVariant, searchableChanged: boolean) => {
        const itemId = catalogItemId(input.feedId, patchProduct.id, variant.id);
        const prevRevision = this.store.revisions.get(itemId) ?? {
          data_revision: 0,
          search_revision: 0,
          index_revision: 0,
          tombstoned: false,
        };
        const next: VariantRevision = {
          data_revision: prevRevision.data_revision + 1,
          search_revision: searchableChanged ? prevRevision.data_revision + 1 : prevRevision.search_revision,
          index_revision: prevRevision.index_revision,
          tombstoned: isTombstone(variant),
        };
        this.store.revisions.set(itemId, next);
        if (searchableChanged || next.tombstoned) {
          this.store.outbox.push({
            id: randomUUID(),
            item_id: itemId,
            feed_id: input.feedId,
            external_product_id: patchProduct.id,
            external_variant_id: variant.id,
            search_revision: next.search_revision,
            operation: next.tombstoned ? 'delete' : 'upsert',
            status: 'pending',
            attempts: 0,
          });
        }
      };
      for (const patchVariant of patchVariants) {
        const previous = variants.get(patchVariant.id);
        if (!previous && !patchVariant.title) {
          throw new AcpError('La variant nueva requiere title', 'INVALID_ACP_REQUEST', 400);
        }
        const mergedVariant = previous ? mergeDefined(previous, patchVariant) : { ...patchVariant };
        variants.set(patchVariant.id, mergedVariant);
        enqueue(
          mergedVariant,
          !previous ||
            searchableFingerprint(existing ?? mergedProduct, previous) !==
              searchableFingerprint(mergedProduct, mergedVariant),
        );
      }
      if (
        patchVariants.length === 0 &&
        existing &&
        searchableFingerprint(existing, existing.variants[0] ?? { id: '_' }) !==
          searchableFingerprint(mergedProduct, existing.variants[0] ?? { id: '_' })
      ) {
        for (const variant of variants.values()) {
          enqueue(variant, true);
        }
      }
      current.set(patchProduct.id, { ...mergedProduct, variants: [...variants.values()] });
    }
    this.store.products.set(input.feedId, current);
    feed.updated_at = new Date().toISOString();
    const response = { id: input.feedId, accepted: true as const };
    this.saveReceipt(input.merchantId, 'PATCH', input.path, input.idempotencyKey, input.rawBody, 200, response);
    return response;
  }
}

export type { MerchantKeyStore };
