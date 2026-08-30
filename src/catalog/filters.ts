import type { HydratedSearchItem, SearchFilters } from './domain.js';

export function matchesAuthoritativeFilters(
  item: HydratedSearchItem,
  filters: SearchFilters,
): boolean {
  if (filters.merchant_ids?.length && !filters.merchant_ids.includes(item.merchant.merchant_id)) {
    return false;
  }
  if (filters.categories?.length && !filters.categories.includes(item.product.category)) {
    return false;
  }
  if (filters.currency && item.price.currency !== filters.currency) {
    return false;
  }
  if (filters.min_price_minor !== undefined && item.price.amount_minor < filters.min_price_minor) {
    return false;
  }
  if (filters.max_price_minor !== undefined && item.price.amount_minor > filters.max_price_minor) {
    return false;
  }
  if (item.availability !== filters.availability) {
    return false;
  }
  return true;
}
