import { Hono } from 'hono';
import { CatalogError } from '../catalog/domain.js';
import type { CatalogSearchService } from '../catalog/search.js';

export function createCatalogRoutes(search?: CatalogSearchService) {
  const routes = new Hono();

  routes.post('/v1/catalog/search', async (c) => {
    if (!search) {
      throw new CatalogError('Catalog unavailable', 'CATALOG_UNAVAILABLE');
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new CatalogError('Invalid search request', 'INVALID_SEARCH_REQUEST');
    }
    return c.json(await search.search(body));
  });

  return routes;
}
