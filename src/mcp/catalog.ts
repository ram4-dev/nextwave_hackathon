import { z } from 'zod';

/**
 * Contract-only MCP surface for the agent's read-only product discovery flow.
 * Implementations are intentionally injected: this module makes no database,
 * merchant, vector-index, Yuno, checkout, or payment calls.
 */

const opaqueId = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/, 'Opaque identifier required');
const currency = z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 currency required');
const url = z.string().url().refine((value) => /^https?:\/\//.test(value), 'HTTP(S) URL required');

export const catalogSemanticSearchInputSchema = z.object({
  query: z.string().trim().min(2).max(500).describe('Natural-language product need, name, or description.'),
  merchantId: opaqueId.optional().describe('Optional merchant scope. Omit to search all eligible catalog merchants.'),
  limit: z.number().int().min(1).max(20).default(10),
  locale: z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/).optional(),
  filters: z.object({
    categoryIds: z.array(opaqueId).max(20).optional(),
    minPriceMinor: z.number().int().nonnegative().safe().optional(),
    maxPriceMinor: z.number().int().nonnegative().safe().optional(),
    currency: currency.optional(),
    inStockOnly: z.boolean().default(false),
  }).strict().optional(),
}).strict();

export const catalogSemanticSearchOutputSchema = z.object({
  results: z.array(z.object({
    itemId: opaqueId.describe('Internal catalog item ID. Use this value with catalog_get_product.'),
    merchantId: opaqueId,
    score: z.number().min(0).max(1),
    matchedFields: z.array(z.enum(['name', 'description', 'category', 'attributes'])).min(1),
  }).strict()).max(20),
  indexVersion: z.string().min(1).max(200),
  searchedAt: z.string().datetime({ offset: true }),
}).strict();

export const catalogGetProductInputSchema = z.object({
  itemId: opaqueId.describe('Item ID returned by catalog_semantic_search.'),
  locale: z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/).optional(),
}).strict();

export const catalogGetProductOutputSchema = z.object({
  item: z.object({
    itemId: opaqueId,
    merchantId: opaqueId,
    name: z.string().min(1).max(500),
    description: z.string().min(1).max(10000),
    brand: z.string().min(1).max(300).optional(),
    categoryIds: z.array(opaqueId).max(50),
    attributes: z.record(z.string().min(1).max(100), z.union([z.string().max(500), z.number().finite(), z.boolean(), z.array(z.string().max(200)).max(30)])).default({}),
    images: z.array(url).max(20).default([]),
    price: z.object({ amountMinor: z.number().int().nonnegative().safe(), currency }).strict(),
    availability: z.object({ status: z.enum(['in_stock', 'low_stock', 'out_of_stock', 'preorder', 'unknown']), availableQuantity: z.number().int().nonnegative().safe().optional(), updatedAt: z.string().datetime({ offset: true }) }).strict(),
    variantSummary: z.string().min(1).max(1000).optional(),
    returnPolicySummary: z.string().min(1).max(2000).optional(),
    merchantProductReference: opaqueId.optional().describe('Opaque merchant reference; never a payment or checkout credential.'),
    catalogVersion: z.string().min(1).max(200),
    updatedAt: z.string().datetime({ offset: true }),
  }).strict(),
}).strict();

export type CatalogSemanticSearchInput = z.input<typeof catalogSemanticSearchInputSchema>;
export type CatalogSemanticSearchOutput = z.output<typeof catalogSemanticSearchOutputSchema>;
export type CatalogGetProductInput = z.input<typeof catalogGetProductInputSchema>;
export type CatalogGetProductOutput = z.output<typeof catalogGetProductOutputSchema>;

/** Future local read model: vector lookup first, then exact item_id lookup. */
export interface CatalogReadModel {
  semanticSearch(input: CatalogSemanticSearchInput): Promise<CatalogSemanticSearchOutput>;
  getProduct(input: CatalogGetProductInput): Promise<CatalogGetProductOutput>;
}

export type McpToolDefinition = {
  name: 'catalog_semantic_search' | 'catalog_get_product';
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: true; destructiveHint: false; openWorldHint: false };
};

/**
 * Tool declarations for an MCP host. The host is responsible for transport,
 * agent authentication, tenant scoping, and invoking the injected read model.
 */
export const catalogMcpToolDefinitions: readonly McpToolDefinition[] = [
  {
    name: 'catalog_semantic_search',
    description: 'Search the partner catalog semantically. Returns only ranked item_id values and minimal matching metadata; call catalog_get_product for presentation data.',
    inputSchema: {
      type: 'object', required: ['query'], additionalProperties: false,
      properties: { query: { type: 'string', minLength: 2, maxLength: 500 }, merchantId: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 }, locale: { type: 'string' }, filters: { type: 'object' } },
    },
    outputSchema: { type: 'object', required: ['results', 'indexVersion', 'searchedAt'] },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'catalog_get_product',
    description: 'Fetch complete human-presentable product information by an item_id returned from catalog_semantic_search.',
    inputSchema: { type: 'object', required: ['itemId'], additionalProperties: false, properties: { itemId: { type: 'string' }, locale: { type: 'string' } } },
    outputSchema: { type: 'object', required: ['item'] },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
];

/** Binds the schema-validated handlers when the local catalog read model exists. */
export function createCatalogMcpToolHandlers(readModel: CatalogReadModel) {
  return {
    async catalog_semantic_search(input: unknown): Promise<CatalogSemanticSearchOutput> {
      const parsed = catalogSemanticSearchInputSchema.parse(input);
      return catalogSemanticSearchOutputSchema.parse(await readModel.semanticSearch(parsed));
    },
    async catalog_get_product(input: unknown): Promise<CatalogGetProductOutput> {
      const parsed = catalogGetProductInputSchema.parse(input);
      return catalogGetProductOutputSchema.parse(await readModel.getProduct(parsed));
    },
  };
}
