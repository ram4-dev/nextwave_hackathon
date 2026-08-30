import { describe, expect, it } from 'vitest';
import {
  catalogMcpToolDefinitions,
  createCatalogMcpToolHandlers,
} from '../src/mcp/catalog.js';

describe('catalog MCP contract', () => {
  it('declares read-only vector-search and exact-item tools', () => {
    expect(catalogMcpToolDefinitions.map((tool) => tool.name)).toEqual(['catalog_semantic_search', 'catalog_get_product']);
    expect(catalogMcpToolDefinitions.every((tool) => tool.annotations.readOnlyHint)).toBe(true);
  });

  it('validates both boundaries around the future catalog read model', async () => {
    const tools = createCatalogMcpToolHandlers({
      semanticSearch: async () => ({ results: [{ itemId: 'item_1', merchantId: 'merchant_1', score: 0.95, matchedFields: ['name'] }], indexVersion: 'catalog-v1', searchedAt: '2030-01-01T00:00:00.000Z' }),
      getProduct: async () => ({ item: { itemId: 'item_1', merchantId: 'merchant_1', name: 'Coffee maker', description: 'Compact coffee maker', categoryIds: ['kitchen'], attributes: { color: 'black' }, images: ['https://cdn.example/products/item_1.jpg'], price: { amountMinor: 12500, currency: 'USD' }, availability: { status: 'in_stock', updatedAt: '2030-01-01T00:00:00.000Z' }, catalogVersion: 'catalog-v1', updatedAt: '2030-01-01T00:00:00.000Z' } }),
    });
    await expect(tools.catalog_semantic_search({ query: 'coffee machine', limit: 1 })).resolves.toMatchObject({ results: [{ itemId: 'item_1' }] });
    await expect(tools.catalog_get_product({ itemId: 'item_1' })).resolves.toMatchObject({ item: { price: { currency: 'USD' } } });
    await expect(tools.catalog_get_product({ itemId: 'invalid id with spaces' })).rejects.toThrow();
  });
});
