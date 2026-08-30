import { DomainError } from '../domain/state-machine.js';

export const CATALOG_SOURCE = 'juno_mock' as const;
export const CATALOG_MARKET = 'AR' as const;
export const CATALOG_CURRENCY = 'ARS' as const;
export const EMBEDDING_DIMENSIONS = 384;
export const DEFAULT_EMBEDDING_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';

export const SEARCH_503_CODES = [
  'CATALOG_UNAVAILABLE',
  'EMBEDDING_UNAVAILABLE',
  'SEARCH_UNAVAILABLE',
] as const;

export type Search503Code = (typeof SEARCH_503_CODES)[number];
export type CatalogErrorCode =
  | 'INVALID_SEARCH_REQUEST'
  | Search503Code
  | 'INTERNAL_ERROR'
  | 'INVALID_CATALOG_FIXTURE';

export class CatalogError extends DomainError {
  constructor(message: string, readonly catalogCode: CatalogErrorCode) {
    super(message, catalogCode);
    this.name = 'CatalogError';
  }
}

export type Availability = 'in_stock' | 'out_of_stock' | 'unknown';
export type SearchMode = 'hnsw' | 'exact_fallback';
export type CatalogVersionStatus = 'building' | 'published' | 'superseded' | 'failed';

export interface CatalogMerchant {
  merchant_id: string;
  name: string;
  slug: string;
  category: string;
  country_code: typeof CATALOG_MARKET;
  locality?: string;
  accepts_juno: true;
  source_updated_at: string;
}

export interface CatalogOffer {
  item_id: string;
  merchant_id: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  price_minor: number;
  currency: typeof CATALOG_CURRENCY;
  availability: Availability;
  source_updated_at: string;
}

export interface CatalogFixture {
  source: typeof CATALOG_SOURCE;
  version: string;
  source_updated_at: string;
  merchants: CatalogMerchant[];
  offers: CatalogOffer[];
}

export interface SearchProjection {
  catalog_version_id: string;
  item_id: string;
  name: string;
  description: string;
  item_info: string;
  embedding: readonly number[];
  is_published: boolean;
}

export interface SearchableProjectionPayload {
  item_id: string;
  name: string;
  description: string;
  item_info: string;
  embedding: readonly number[];
}

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<readonly number[][]>;
}

export interface SearchFilters {
  merchant_ids?: string[];
  categories?: string[];
  currency?: string;
  min_price_minor?: number;
  max_price_minor?: number;
  availability: Availability;
}

export interface ParsedSearchRequest {
  query: string;
  top_k: number;
  filters: SearchFilters;
}

export interface RankedCandidate {
  item_id: string;
  score: number;
}

export interface HydratedSearchItem {
  item_id: string;
  merchant: {
    merchant_id: string;
    name: string;
    category: string;
    accepts_juno: true;
  };
  product: {
    name: string;
    description: string;
    category: string;
    tags: string[];
  };
  price: {
    amount_minor: number;
    currency: string;
  };
  availability: Availability;
  score: number;
  updated_at: string;
  data_revision: number;
  search_revision: number;
  index_revision: number;
}

export interface SearchResponse {
  query: string;
  as_of: string;
  search_mode: SearchMode;
  results: HydratedSearchItem[];
}

export interface RepositorySearchInput {
  query: string;
  query_embedding: readonly number[];
  embedding_model: string;
  embedding_dimensions: number;
  filters: SearchFilters;
  candidate_k: number;
  top_k: number;
}

export interface HydratedSearchResult {
  as_of: string;
  search_mode: SearchMode;
  items: HydratedSearchItem[];
}

export interface DerivedCatalogSnapshot {
  source: typeof CATALOG_SOURCE;
  version: string;
  source_updated_at: string;
  embedding_model: string;
  embedding_dimensions: number;
  merchants: CatalogMerchant[];
  offers: CatalogOffer[];
  projections: SearchProjection[];
}

export interface PublishResult {
  catalog_version_id: string;
  version: string;
  status: CatalogVersionStatus;
  idempotent: boolean;
}

export function isCatalog503(code: string): code is Search503Code {
  return (SEARCH_503_CODES as readonly string[]).includes(code);
}
