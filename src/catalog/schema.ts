import { z } from 'zod';
import {
  CATALOG_CURRENCY,
  CATALOG_MARKET,
  CATALOG_SOURCE,
  CatalogError,
  type CatalogFixture,
  type ParsedSearchRequest,
} from './domain.js';

const URL_RE = /https?:\/\/|www\.|[a-z0-9-]+\.(com|net|org|ar)\b/i;

const availabilitySchema = z.enum(['in_stock', 'out_of_stock', 'unknown']);

const searchFiltersSchema = z
  .object({
    merchant_ids: z.array(z.string().min(1).max(128)).max(50).optional(),
    categories: z.array(z.string().min(1).max(64)).max(20).optional(),
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
    min_price_minor: z.number().int().min(0).optional(),
    max_price_minor: z.number().int().min(0).optional(),
    availability: availabilitySchema.optional(),
  })
  .strict();

const searchRequestSchema = z
  .object({
    query: z.string().transform((v) => v.trim()).pipe(z.string().min(2).max(200)),
    top_k: z.number().int().min(1).max(50).optional(),
    filters: searchFiltersSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const min = value.filters?.min_price_minor;
    const max = value.filters?.max_price_minor;
    if (min !== undefined && max !== undefined && min > max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['filters', 'min_price_minor'],
        message: 'min_price_minor must be <= max_price_minor',
      });
    }
  });

const merchantSchema = z
  .object({
    merchant_id: z.string().min(1),
    name: z.string().min(1),
    slug: z.string().min(1),
    category: z.string().min(1),
    country_code: z.literal(CATALOG_MARKET),
    locality: z.string().min(1).optional(),
    accepts_juno: z.literal(true),
    source_updated_at: z.string().datetime(),
  })
  .strict();

const offerSchema = z
  .object({
    item_id: z.string().min(1),
    merchant_id: z.string().min(1),
    name: z.string().min(1),
    description: z.string(),
    category: z.string().min(1),
    tags: z.array(z.string().min(1)).default([]),
    price_minor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    currency: z.literal(CATALOG_CURRENCY),
    availability: availabilitySchema,
    source_updated_at: z.string().datetime(),
  })
  .strict();

const fixtureSchema = z
  .object({
    source: z.literal(CATALOG_SOURCE),
    version: z.string().min(1),
    source_updated_at: z.string().datetime(),
    merchants: z.array(merchantSchema).min(2),
    offers: z.array(offerSchema).length(10),
  })
  .strict();

function assertNoUrls(value: unknown, path: string): void {
  if (URL_RE.test(JSON.stringify(value))) {
    throw new CatalogError(`Continuation or web URL is forbidden in ${path}`, 'INVALID_CATALOG_FIXTURE');
  }
}

export function parseSearchRequest(input: unknown): ParsedSearchRequest {
  const parsed = searchRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new CatalogError('Invalid search request', 'INVALID_SEARCH_REQUEST');
  }
  return {
    query: parsed.data.query,
    top_k: parsed.data.top_k ?? 10,
    filters: {
      ...parsed.data.filters,
      availability: parsed.data.filters?.availability ?? 'in_stock',
    },
  };
}

export function validateCatalogFixture(input: unknown): CatalogFixture {
  const parsed = fixtureSchema.safeParse(input);
  if (!parsed.success) {
    throw new CatalogError('Invalid catalog fixture', 'INVALID_CATALOG_FIXTURE');
  }
  assertNoUrls(parsed.data, 'fixture');
  const merchantIds = new Set(parsed.data.merchants.map((m) => m.merchant_id));
  if (merchantIds.size !== parsed.data.merchants.length) {
    throw new CatalogError('Duplicate merchant_id', 'INVALID_CATALOG_FIXTURE');
  }
  const itemIds = new Set<string>();
  for (const offer of parsed.data.offers) {
    if (itemIds.has(offer.item_id)) {
      throw new CatalogError(`Duplicate item_id ${offer.item_id}`, 'INVALID_CATALOG_FIXTURE');
    }
    itemIds.add(offer.item_id);
    if (!merchantIds.has(offer.merchant_id)) {
      throw new CatalogError(`Orphaned offer ${offer.item_id}`, 'INVALID_CATALOG_FIXTURE');
    }
  }
  return parsed.data;
}
