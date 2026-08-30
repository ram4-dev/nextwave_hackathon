import { Hono } from 'hono';
import { AcpError, type MerchantFeedAuthorizer } from '../catalog/acp-contract.js';
import type { AcpIngestionService } from '../catalog/ingestion.js';
import type { PostgresAcpIngestionService } from '../catalog/postgres-acp-store.js';

type IngestionBoundary = AcpIngestionService | PostgresAcpIngestionService;

export function createAcpCatalogRoutes(deps: {
  enabled: boolean;
  authorizer?: MerchantFeedAuthorizer;
  ingestion?: IngestionBoundary;
}) {
  const routes = new Hono();
  if (!deps.enabled || !deps.authorizer || !deps.ingestion) {
    return routes;
  }
  const authorizer = deps.authorizer;
  const ingestion = deps.ingestion;

  const mutationHeaders = (c: { req: { header: (name: string) => string | undefined } }) => ({
    contentType: c.req.header('content-type'),
    apiVersion: c.req.header('api-version'),
    idempotencyKey: c.req.header('idempotency-key'),
    requestId: c.req.header('request-id'),
    timestamp: c.req.header('timestamp'),
    acceptLanguage: c.req.header('accept-language'),
    contentLength: Number(c.req.header('content-length') ?? Number.NaN),
  });

  const echo = (
    c: { header: (name: string, value: string) => void; req: { header: (name: string) => string | undefined } },
  ) => {
    const idem = c.req.header('idempotency-key');
    const requestId = c.req.header('request-id');
    if (idem) c.header('Idempotency-Key', idem);
    if (requestId) c.header('Request-Id', requestId);
  };

  routes.post('/product_feeds', async (c) => {
    const headers = mutationHeaders(c);
    if (Number.isFinite(headers.contentLength)) {
      ingestion.validateMutationHeaders(headers);
    } else {
      ingestion.validateMutationHeaders({ ...headers, contentLength: undefined });
    }
    const { merchant_id } = await authorizer.authenticate(c.req.header('authorization'));
    const rawBody = await c.req.text();
    if (Buffer.byteLength(rawBody, 'utf8') > 1_048_576) {
      throw new AcpError('El cuerpo supera 1 MiB', 'PAYLOAD_TOO_LARGE', 413);
    }
    echo(c);
    return c.json(
      await ingestion.createFeed({
        merchantId: merchant_id,
        rawBody,
        idempotencyKey: headers.idempotencyKey!,
        path: '/product_feeds',
      }),
    );
  });

  routes.get('/product_feeds/:feedId', async (c) => {
    const feedId = c.req.param('feedId');
    await authorizer.authorizeFeed(c.req.header('authorization'), feedId);
    return c.json(await ingestion.getFeed(feedId));
  });

  routes.get('/product_feeds/:feedId/products', async (c) => {
    const feedId = c.req.param('feedId');
    await authorizer.authorizeFeed(c.req.header('authorization'), feedId);
    return c.json(await ingestion.getProducts(feedId));
  });

  routes.patch('/product_feeds/:feedId/products', async (c) => {
    const feedId = c.req.param('feedId');
    const headers = mutationHeaders(c);
    if (Number.isFinite(headers.contentLength)) {
      ingestion.validateMutationHeaders(headers);
    } else {
      ingestion.validateMutationHeaders({ ...headers, contentLength: undefined });
    }
    const { merchant_id } = await authorizer.authorizeFeed(c.req.header('authorization'), feedId, undefined);
    const rawBody = await c.req.text();
    if (Buffer.byteLength(rawBody, 'utf8') > 1_048_576) {
      throw new AcpError('El cuerpo supera 1 MiB', 'PAYLOAD_TOO_LARGE', 413);
    }
    echo(c);
    return c.json(
      await ingestion.patchProducts({
        merchantId: merchant_id,
        feedId,
        rawBody,
        idempotencyKey: headers.idempotencyKey!,
        path: `/product_feeds/${feedId}/products`,
      }),
    );
  });

  return routes;
}
