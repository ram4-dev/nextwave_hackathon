import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  HARD_COMMERCE_FIELD_NAMES,
  SEARCHABLE_PROJECTION_KEYS,
  buildItemInfo,
  buildSearchProjection,
  projectionSearchablePayload,
} from '../../src/catalog/projection.js';
import { DeterministicEmbeddingProvider } from '../../src/catalog/embedding.js';
import { validateCatalogFixture } from '../../src/catalog/schema.js';

const URL_RE = /https?:\/\/|www\.|[a-z0-9-]+\.(com|net|org|ar)\b/i;

function loadFixture(): unknown {
  return JSON.parse(readFileSync(new URL('../../fixtures/juno/catalog.json', import.meta.url), 'utf8'));
}

describe('Juno catalog projection', () => {
  it('accepts exactly 10 Argentine Spanish ARS offers across multiple merchants with no URLs', () => {
    const catalog = validateCatalogFixture(loadFixture());
    expect(catalog.offers).toHaveLength(10);
    expect(new Set(catalog.merchants.map((m) => m.merchant_id)).size).toBeGreaterThanOrEqual(2);
    expect(new Set(catalog.offers.map((o) => o.merchant_id)).size).toBeGreaterThanOrEqual(2);
    for (const merchant of catalog.merchants) {
      expect(merchant.country_code).toBe('AR');
      expect(merchant.accepts_juno).toBe(true);
      expect(URL_RE.test(JSON.stringify(merchant))).toBe(false);
    }
    for (const offer of catalog.offers) {
      expect(offer.currency).toBe('ARS');
      expect(Number.isInteger(offer.price_minor)).toBe(true);
      expect(offer.price_minor).toBeGreaterThanOrEqual(0);
      expect(offer.name).toMatch(/[áéíóúñüÁÉÍÓÚÑÜa-zA-Z]/);
      expect(URL_RE.test(JSON.stringify(offer))).toBe(false);
    }
  });

  it('builds a searchable payload with only item_id, name, description, item_info, and embedding', async () => {
    const catalog = validateCatalogFixture(loadFixture());
    const embedding = new DeterministicEmbeddingProvider();
    const projection = await buildSearchProjection(catalog.offers[1]!, embedding, 'ver-1');
    expect(Object.keys(projectionSearchablePayload(projection)).sort()).toEqual(
      [...SEARCHABLE_PROJECTION_KEYS].sort(),
    );
    expect(projection.embedding).toHaveLength(embedding.dimensions);
    expect(projection.embedding).toHaveLength(384);
    expect(SEARCHABLE_PROJECTION_KEYS).toEqual([
      'item_id',
      'name',
      'description',
      'item_info',
      'embedding',
    ]);
  });

  it('keeps hard merchant, price, currency, and availability fields out of the searchable payload', async () => {
    const catalog = validateCatalogFixture(loadFixture());
    const conflicting = {
      ...catalog.offers[0]!,
      name: 'Snack crocante',
      description: 'Corte fino con sal marina, sin tokens de papas fritas',
      price_minor: 999_999,
      currency: 'ARS' as const,
    };
    const embedding = new DeterministicEmbeddingProvider();
    const projection = await buildSearchProjection(conflicting, embedding, 'ver-1');
    const payload = projectionSearchablePayload(projection);
    const serialized = JSON.stringify(payload);
    for (const field of HARD_COMMERCE_FIELD_NAMES) {
      expect(field in payload).toBe(false);
    }
    expect(serialized).not.toMatch(/999999|999_999|price_minor|amount_minor/);
    expect(serialized).not.toContain(conflicting.merchant_id);
    expect(payload.item_info).not.toMatch(/ARS|in_stock|out_of_stock|unknown|\$/);
    expect(buildItemInfo(conflicting)).not.toMatch(/ARS|in_stock|out_of_stock|\$/);
    expect(conflicting.price_minor).toBe(999_999);
  });

  it('links projection to the same version and item_id without promoting linkage into the searchable payload', async () => {
    const catalog = validateCatalogFixture(loadFixture());
    const embedding = new DeterministicEmbeddingProvider();
    const projection = await buildSearchProjection(catalog.offers[0]!, embedding, 'ver-link');
    expect(projection.catalog_version_id).toBe('ver-link');
    expect(projection.item_id).toBe(catalog.offers[0]!.item_id);
    expect(projection.is_published).toBe(false);
    const payload = projectionSearchablePayload(projection);
    expect(payload).not.toHaveProperty('catalog_version_id');
    expect(payload).not.toHaveProperty('is_published');
  });
});
