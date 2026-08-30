import type {
  CatalogOffer,
  EmbeddingProvider,
  SearchableProjectionPayload,
  SearchProjection,
} from './domain.js';
import { CatalogError } from './domain.js';

export const SEARCHABLE_PROJECTION_KEYS = [
  'item_id',
  'name',
  'description',
  'item_info',
  'embedding',
] as const;

export const HARD_COMMERCE_FIELD_NAMES = [
  'price',
  'price_minor',
  'amount_minor',
  'currency',
  'availability',
  'merchant_id',
  'merchant',
  'accepts_juno',
  'country_code',
  'locality',
] as const;

export function buildItemInfo(offer: Pick<CatalogOffer, 'category' | 'tags'>): string {
  const category = offer.category.replace(/-/g, ' ').trim();
  const tags = offer.tags.map((tag) => tag.trim()).filter(Boolean);
  return [category, ...tags].filter(Boolean).join(', ');
}

export function buildSearchText(input: {
  name: string;
  description: string;
  item_info: string;
}): string {
  return [input.name, input.description, input.item_info]
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n');
}

export function projectionSearchablePayload(
  projection: SearchProjection,
): SearchableProjectionPayload {
  return {
    item_id: projection.item_id,
    name: projection.name,
    description: projection.description,
    item_info: projection.item_info,
    embedding: projection.embedding,
  };
}

export function buildAcpItemInfo(input: {
  categories?: Array<{ value: string }>;
  variant_options?: Array<{ name: string; value: string }>;
}): string {
  const categories = (input.categories ?? []).map((row) => row.value.replace(/-/g, ' ').trim()).filter(Boolean);
  const options = (input.variant_options ?? [])
    .map((row) => `${row.name} ${row.value}`.trim())
    .filter(Boolean);
  return [...categories, ...options].join(', ');
}

export function buildAcpSearchableFields(product: {
  title?: string;
  description?: { plain?: string };
}, variant: {
  title?: string;
  description?: { plain?: string };
  categories?: Array<{ value: string }>;
  variant_options?: Array<{ name: string; value: string }>;
}): { name: string; description: string; item_info: string; search_text: string } {
  const name = (variant.title ?? product.title ?? '').trim();
  const description = (variant.description?.plain ?? product.description?.plain ?? '').trim();
  const item_info = buildAcpItemInfo(variant);
  return {
    name,
    description,
    item_info,
    search_text: buildSearchText({
      name: [product.title, variant.title].filter(Boolean).join(' ').trim() || name,
      description,
      item_info,
    }),
  };
}

export async function buildSearchProjection(
  offer: CatalogOffer,
  embedding: EmbeddingProvider,
  catalogVersionId: string,
): Promise<SearchProjection> {
  const item_info = buildItemInfo(offer);
  const searchText = buildSearchText({
    name: offer.name,
    description: offer.description,
    item_info,
  });
  let vectors: readonly number[][];
  try {
    vectors = await embedding.embed([searchText]);
  } catch {
    throw new CatalogError('Could not embed catalog projection', 'INVALID_CATALOG_FIXTURE');
  }
  const vector = vectors[0];
  if (!vector || vector.length !== embedding.dimensions) {
    throw new CatalogError('Incompatible embedding dimensions', 'INVALID_CATALOG_FIXTURE');
  }
  return {
    catalog_version_id: catalogVersionId,
    item_id: offer.item_id,
    name: offer.name,
    description: offer.description,
    item_info,
    embedding: vector,
    is_published: false,
  };
}
