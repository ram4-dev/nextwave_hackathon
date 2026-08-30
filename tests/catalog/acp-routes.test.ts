import { describe, expect, it } from 'vitest';
import {
  AcpIngestionService,
  MemoryAcpCatalogStore,
  acpIngestionOptionsFromConfig,
} from '../../src/catalog/ingestion.js';
import { ACP_API_VERSION, MerchantFeedAuthorizer } from '../../src/catalog/acp-contract.js';
import { loadConfig } from '../../src/config/env.js';
import { InMemoryRepository } from '../../src/persistence/repository.js';
import { createApp } from '../../src/server/app.js';

function testConfig() {
  return loadConfig({
    NODE_ENV: 'test',
    KYA_MODE: 'demo',
    PUBLIC_BASE_URL: 'http://localhost:8787',
    KYA_ISSUER: 'http://localhost:8787',
    KYA_AUDIENCE: 'kya-agent',
    CATALOG_ACP_ENABLED: 'true',
  });
}

function isoNow(): string {
  return new Date().toISOString();
}

function headers(apiKey: string, extras: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
    'api-version': ACP_API_VERSION,
    'idempotency-key': extras['idempotency-key'] ?? 'idem-1',
    'request-id': extras['request-id'] ?? 'req-1',
    timestamp: extras.timestamp ?? isoNow(),
    'accept-language': extras['accept-language'] ?? 'es-AR',
    'user-agent': extras['user-agent'] ?? 'juno-acp-test/1.0',
    ...extras,
  };
}

function snackProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prod_snack',
    title: 'Bastones crocantes',
    description: { plain: 'Snack de papa en bastones' },
    variants: [
      {
        id: 'var_default',
        title: 'Bolsa 200g',
        description: { plain: 'Porción familiar' },
        price: { amount: 2100, currency: 'ARS' },
        availability: { available: true, status: 'in_stock' },
        categories: [{ value: 'snacks', taxonomy: 'merchant' }],
        variant_options: [{ name: 'peso', value: '200g' }],
      },
    ],
    ...overrides,
  };
}

async function acpApp(opts?: { rateLimit?: number; storageDown?: boolean }) {
  const store = new MemoryAcpCatalogStore();
  const issued = store.provisionMerchant({
    merchant_id: 'merchant_centro',
    name: 'Mercado Centro',
    slug: 'mercado-centro',
    category: 'supermercado',
  });
  const other = store.provisionMerchant({
    merchant_id: 'merchant_palermo',
    name: 'Rotisería Palermo',
    slug: 'rotiseria-palermo',
    category: 'comida-rapida',
  });
  const ingestion = new AcpIngestionService(store, {
    maxRequestsPerWindow: opts?.rateLimit,
    storageUnavailable: opts?.storageDown,
  });
  const { app } = createApp(new InMemoryRepository(), testConfig(), {
    acpIngestion: ingestion,
    acpAuthorizer: new MerchantFeedAuthorizer(store),
  });
  return { app, store, issued, other };
}

async function createFeed(
  app: { request: (url: string, init?: RequestInit) => Response | Promise<Response> },
  apiKey: string,
  idem = 'create-feed',
) {
  const res = await app.request('/product_feeds', {
    method: 'POST',
    headers: headers(apiKey, { 'idempotency-key': idem, 'request-id': `req-${idem}` }),
    body: JSON.stringify({ target_country: 'AR' }),
  });
  return { res, body: (await res.json()) as { id: string; target_country: string; updated_at: string } };
}

describe('ACP feed and product routes', () => {
  it('maps CATALOG_ACP_RATE_LIMIT onto the ingestion write window', () => {
    expect(acpIngestionOptionsFromConfig({ CATALOG_ACP_RATE_LIMIT: 12 })).toEqual({
      maxRequestsPerWindow: 12,
    });
    expect(acpIngestionOptionsFromConfig({})).toEqual({
      maxRequestsPerWindow: undefined,
    });
  });

  it('creates a feed with 200 metadata and returns the full products array', async () => {
    const { app, issued } = await acpApp();
    const created = await createFeed(app, issued.raw);
    expect(created.res.status).toBe(200);
    expect(created.body).toEqual({
      id: created.body.id,
      target_country: 'AR',
      updated_at: created.body.updated_at,
    });
    expect(created.body.id).toMatch(/\S/);

    const patch = await app.request(`/product_feeds/${created.body.id}/products`, {
      method: 'PATCH',
      headers: headers(issued.raw, { 'idempotency-key': 'patch-1', 'request-id': 'req-patch-1' }),
      body: JSON.stringify({ products: [snackProduct()] }),
    });
    expect(patch.status).toBe(200);
    expect(await patch.json()).toEqual({ id: created.body.id, accepted: true });

    const listed = await app.request(`/product_feeds/${created.body.id}/products`, {
      method: 'GET',
      headers: { authorization: `Bearer ${issued.raw}`, 'accept-language': 'es-AR' },
    });
    expect(listed.status).toBe(200);
    const body = await listed.json();
    expect(body.target_country).toBe('AR');
    expect(Array.isArray(body.products)).toBe(true);
    expect(body.products).toHaveLength(1);
    expect(body.next_page_token).toBeUndefined();
    expect(body.products[0].id).toBe('prod_snack');
    expect(body.products[0].variants[0].price).toEqual({ amount: 2100, currency: 'ARS' });
  });

  it('rejects expired timestamps without side effects and localizes the error as es-AR', async () => {
    const { app, issued, store } = await acpApp();
    const created = await createFeed(app, issued.raw);
    const expired = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const res = await app.request(`/product_feeds/${created.body.id}/products`, {
      method: 'PATCH',
      headers: headers(issued.raw, { timestamp: expired, 'idempotency-key': 'expired' }),
      body: JSON.stringify({ products: [snackProduct()] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_ACP_REQUEST');
    expect(String(body.error)).toMatch(/marca de tiempo|timestamp/i);
    expect(store.variantCount(created.body.id)).toBe(0);
  });

  it('rejects non-AR markets and non-ARS prices with 400 and no writes', async () => {
    const { app, issued, store } = await acpApp();
    const us = await app.request('/product_feeds', {
      method: 'POST',
      headers: headers(issued.raw, { 'idempotency-key': 'us-feed' }),
      body: JSON.stringify({ target_country: 'US' }),
    });
    expect(us.status).toBe(400);
    expect(store.feedCount()).toBe(0);

    const created = await createFeed(app, issued.raw, 'ar-feed');
    const usd = await app.request(`/product_feeds/${created.body.id}/products`, {
      method: 'PATCH',
      headers: headers(issued.raw, { 'idempotency-key': 'usd' }),
      body: JSON.stringify({
        products: [snackProduct({ variants: [{ id: 'var_default', title: 'Bolsa', price: { amount: 10, currency: 'USD' } }] })],
      }),
    });
    expect(usd.status).toBe(400);
    expect(store.variantCount(created.body.id)).toBe(0);
  });

  it('enforces payload, product, and variant limits plus storage and rate-limit errors', async () => {
    const limited = await acpApp({ rateLimit: 1 });
    const first = await createFeed(limited.app, limited.issued.raw, 'rate-1');
    expect(first.res.status).toBe(200);
    const second = await limited.app.request('/product_feeds', {
      method: 'POST',
      headers: headers(limited.issued.raw, { 'idempotency-key': 'rate-2', 'request-id': 'req-rate-2' }),
      body: JSON.stringify({ target_country: 'AR' }),
    });
    expect(second.status).toBe(429);

    const { app, issued } = await acpApp();
    const created = await createFeed(app, issued.raw, 'limits');
    const tooMany = await app.request(`/product_feeds/${created.body.id}/products`, {
      method: 'PATCH',
      headers: headers(issued.raw, { 'idempotency-key': 'too-many' }),
      body: JSON.stringify({
        products: Array.from({ length: 101 }, (_, i) => snackProduct({ id: `p_${i}` })),
      }),
    });
    expect(tooMany.status).toBe(400);

    const tooManyVariants = await app.request(`/product_feeds/${created.body.id}/products`, {
      method: 'PATCH',
      headers: headers(issued.raw, { 'idempotency-key': 'too-many-variants' }),
      body: JSON.stringify({
        products: [
          snackProduct({
            variants: Array.from({ length: 101 }, (_, i) => ({
              id: `var_${i}`,
              title: `Var ${i}`,
              price: { amount: 1000, currency: 'ARS' },
            })),
          }),
        ],
      }),
    });
    expect(tooManyVariants.status).toBe(400);

    const huge = await app.request(`/product_feeds/${created.body.id}/products`, {
      method: 'PATCH',
      headers: {
        ...headers(issued.raw, { 'idempotency-key': 'huge' }),
        'content-length': String(1_048_576 + 1),
      },
      body: JSON.stringify({ products: [snackProduct()] }),
    });
    expect(huge.status).toBe(413);

    const down = await acpApp({ storageDown: true });
    const unavailable = await down.app.request('/product_feeds', {
      method: 'POST',
      headers: headers(down.issued.raw, { 'idempotency-key': 'down' }),
      body: JSON.stringify({ target_country: 'AR' }),
    });
    expect(unavailable.status).toBe(503);

    const replayLimited = await acpApp({ rateLimit: 1 });
    const accepted = await createFeed(replayLimited.app, replayLimited.issued.raw, 'rate-replay');
    expect(accepted.res.status).toBe(200);
    const replay = await replayLimited.app.request('/product_feeds', {
      method: 'POST',
      headers: headers(replayLimited.issued.raw, {
        'idempotency-key': 'rate-replay',
        'request-id': 'req-rate-replay-2',
      }),
      body: JSON.stringify({ target_country: 'AR' }),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ id: accepted.body.id, target_country: 'AR' });
    expect(replayLimited.store.feedCount()).toBe(1);

    const rfc = await acpApp();
    const looseTs = await rfc.app.request('/product_feeds', {
      method: 'POST',
      headers: headers(rfc.issued.raw, {
        'idempotency-key': 'rfc',
        timestamp: 'August 30, 2026 01:00:00 GMT-0300',
      }),
      body: JSON.stringify({ target_country: 'AR' }),
    });
    expect(looseTs.status).toBe(400);
    expect(rfc.store.feedCount()).toBe(0);
  });

  it('merges a single variant price and preserves omitted products, variants, and fields', async () => {
    const { app, issued, store } = await acpApp();
    const created = await createFeed(app, issued.raw);
    const seed = await app.request(`/product_feeds/${created.body.id}/products`, {
      method: 'PATCH',
      headers: headers(issued.raw, { 'idempotency-key': 'seed' }),
      body: JSON.stringify({
        products: [
          snackProduct({
            variants: [
              {
                id: 'var_default',
                title: 'Bolsa 200g',
                description: { plain: 'Porción familiar' },
                price: { amount: 2100, currency: 'ARS' },
                availability: { available: true, status: 'in_stock' },
                categories: [{ value: 'snacks' }],
              },
              {
                id: 'var_big',
                title: 'Bolsa 500g',
                price: { amount: 4200, currency: 'ARS' },
                availability: { available: true, status: 'in_stock' },
              },
            ],
          }),
          {
            id: 'prod_leche',
            title: 'Leche entera',
            variants: [
              {
                id: 'var_leche',
                title: '1L',
                price: { amount: 1800, currency: 'ARS' },
                availability: { available: true, status: 'in_stock' },
              },
            ],
          },
        ],
      }),
    });
    expect(seed.status).toBe(200);
    store.markIndexed(created.body.id, 'prod_snack', 'var_default');

    const patch = await app.request(`/product_feeds/${created.body.id}/products`, {
      method: 'PATCH',
      headers: headers(issued.raw, { 'idempotency-key': 'price-only' }),
      body: JSON.stringify({
        products: [
          {
            id: 'prod_snack',
            variants: [{ id: 'var_default', price: { amount: 2500, currency: 'ARS' } }],
          },
        ],
      }),
    });
    expect(patch.status).toBe(200);
    const current = store.getProducts(created.body.id);
    expect(current).toHaveLength(2);
    const snack = current.find((product) => product.id === 'prod_snack')!;
    expect(snack.title).toBe('Bastones crocantes');
    expect(snack.variants).toHaveLength(2);
    expect(snack.variants.find((row) => row.id === 'var_default')?.price).toEqual({ amount: 2500, currency: 'ARS' });
    expect(snack.variants.find((row) => row.id === 'var_default')?.title).toBe('Bolsa 200g');
    expect(snack.variants.find((row) => row.id === 'var_big')?.price).toEqual({ amount: 4200, currency: 'ARS' });
    expect(current.find((product) => product.id === 'prod_leche')?.title).toBe('Leche entera');
    const revision = store.getVariantRevisions(created.body.id, 'prod_snack', 'var_default');
    expect(revision.data_revision).toBeGreaterThan(revision.search_revision);
    expect(revision.search_revision).toBe(revision.index_revision);

    const omitted = await app.request(`/product_feeds/${created.body.id}/products`, {
      method: 'PATCH',
      headers: headers(issued.raw, { 'idempotency-key': 'omit-variants' }),
      body: JSON.stringify({ products: [{ id: 'prod_snack', title: 'Bastones de maíz' }] }),
    });
    expect(omitted.status).toBe(200);
    const afterOmit = store.getProducts(created.body.id).find((product) => product.id === 'prod_snack')!;
    expect(afterOmit.title).toBe('Bastones de maíz');
    expect(afterOmit.variants.map((row) => row.id).sort()).toEqual(['var_big', 'var_default']);
    expect(store.getVariantRevisions(created.body.id, 'prod_snack', 'var_default').search_revision).toBeGreaterThan(
      revision.search_revision,
    );
    expect(store.outbox.some((job) => job.external_variant_id === 'var_default' && job.operation === 'upsert')).toBe(
      true,
    );

    const emptyVariants = await app.request(`/product_feeds/${created.body.id}/products`, {
      method: 'PATCH',
      headers: headers(issued.raw, { 'idempotency-key': 'empty-variants' }),
      body: JSON.stringify({
        products: [
          {
            id: 'prod_snack',
            description: { plain: 'Snack de maíz horneado' },
            media: [{ url: 'https://cdn.example/maiz.jpg' }],
            variants: [],
          },
        ],
      }),
    });
    expect(emptyVariants.status).toBe(200);
    const afterEmpty = store.getProducts(created.body.id).find((product) => product.id === 'prod_snack')!;
    expect(afterEmpty.description?.plain).toBe('Snack de maíz horneado');
    expect(afterEmpty.media).toEqual([{ url: 'https://cdn.example/maiz.jpg' }]);
    expect(afterEmpty.variants).toHaveLength(2);
    expect(store.getVariantRevisions(created.body.id, 'prod_snack', 'var_big').search_revision).toBeGreaterThan(1);
  });

  it('replays an identical idempotency key and rejects collisions with 409', async () => {
    const { app, issued, store } = await acpApp();
    const created = await createFeed(app, issued.raw);
    const body = JSON.stringify({ products: [snackProduct()] });
    const first = await app.request(`/product_feeds/${created.body.id}/products`, {
      method: 'PATCH',
      headers: headers(issued.raw, { 'idempotency-key': 'same', 'request-id': 'r1' }),
      body,
    });
    expect(first.status).toBe(200);
    const afterFirst = store.getVariantRevisions(created.body.id, 'prod_snack', 'var_default');
    const replay = await app.request(`/product_feeds/${created.body.id}/products`, {
      method: 'PATCH',
      headers: headers(issued.raw, { 'idempotency-key': 'same', 'request-id': 'r2' }),
      body,
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ id: created.body.id, accepted: true });
    expect(store.getVariantRevisions(created.body.id, 'prod_snack', 'var_default')).toEqual(afterFirst);

    const collision = await app.request(`/product_feeds/${created.body.id}/products`, {
      method: 'PATCH',
      headers: headers(issued.raw, { 'idempotency-key': 'same', 'request-id': 'r3' }),
      body: JSON.stringify({
        products: [snackProduct({ variants: [{ id: 'var_default', title: 'Otra', price: { amount: 3000, currency: 'ARS' } }] })],
      }),
    });
    expect(collision.status).toBe(409);
    expect(store.getVariantRevisions(created.body.id, 'prod_snack', 'var_default')).toEqual(afterFirst);
  });

  it('hides a foreign feed as 404 and ignores seller ownership claims', async () => {
    const { app, issued, other } = await acpApp();
    const created = await createFeed(app, issued.raw);
    const peek = await app.request(`/product_feeds/${created.body.id}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${other.raw}`, 'accept-language': 'es-AR' },
    });
    expect(peek.status).toBe(404);
    const patch = await app.request(`/product_feeds/${created.body.id}/products`, {
      method: 'PATCH',
      headers: headers(other.raw, { 'idempotency-key': 'steal' }),
      body: JSON.stringify({
        products: [snackProduct({ variants: [{ id: 'var_default', title: 'Hack', seller: { name: 'merchant_centro' } }] })],
      }),
    });
    expect(patch.status).toBe(404);
  });
});
