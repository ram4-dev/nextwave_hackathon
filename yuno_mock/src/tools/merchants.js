// Tools for the `merchants` category (invented — see
// docs/scope-and-fidelity.md, "Merchants and catalog: a fully invented
// layer", and the "merchants + catalog" section of src/store.js). Unlike
// customers/checkout/payments, this category **does not exist in Yuno's
// real API** — confirmed by fetching docs.y.uno live: there's no
// "Merchants" or "Catalog" resource. Tool names follow the
// `entityAction`/`RetrieveAll` convention that the real inventory does use,
// but are marked as invented in their description.
//
// Agreed scope — only 2 read-only tools, no CRUD:
// - merchantRetrieveAll: list merchants, with an optional filter by category.
// - merchantCatalogRetrieveAll: list the catalog of a given merchant.

import { z } from 'zod';
import { ok, fail } from '../mcp-result.js';
import {
  getAllMerchants,
  getMerchantById,
  getCatalogByMerchantId,
  MERCHANT_CATEGORY_NAMES,
} from '../store.js';

export function registerMerchantTools(server) {
  server.registerTool(
    'merchantRetrieveAll',
    {
      description:
        'List merchants, optionally filtered by category. Invented tool for this mock — not part of Yuno\'s real API.',
      inputSchema: {
        category: z
          .enum(MERCHANT_CATEGORY_NAMES)
          .optional()
          .describe('Filters by one of the directory\'s fixed categories'),
      },
    },
    async ({ category }) => ok(getAllMerchants({ category })),
  );

  server.registerTool(
    'merchantCatalogRetrieveAll',
    {
      description:
        'List the product/service catalog of a merchant. Invented tool for this mock — not part of Yuno\'s real API.',
      inputSchema: {
        merchant_id: z.string(),
      },
    },
    async ({ merchant_id }) => {
      if (!getMerchantById(merchant_id)) {
        return fail(`No existe un merchant con id "${merchant_id}"`);
      }
      return ok(getCatalogByMerchantId(merchant_id));
    },
  );
}
