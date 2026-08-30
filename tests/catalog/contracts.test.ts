import { describe, expect, it } from 'vitest';
import { parseSearchRequest, validateCatalogFixture } from '../../src/catalog/schema.js';
import { CatalogError } from '../../src/catalog/domain.js';

function validFixture() {
  return {
    source: 'juno_mock',
    version: 'juno-mock-test-001',
    source_updated_at: '2026-08-29T21:00:00.000Z',
    merchants: [
      {
        merchant_id: 'merchant_centro',
        name: 'Mercado Centro',
        slug: 'mercado-centro',
        category: 'supermercado',
        country_code: 'AR',
        locality: 'Buenos Aires',
        accepts_juno: true,
        source_updated_at: '2026-08-29T20:00:00.000Z',
      },
      {
        merchant_id: 'merchant_palermo',
        name: 'Rotisería Palermo',
        slug: 'rotiseria-palermo',
        category: 'comida-rapida',
        country_code: 'AR',
        locality: 'Buenos Aires',
        accepts_juno: true,
        source_updated_at: '2026-08-29T20:00:00.000Z',
      },
    ],
    offers: Array.from({ length: 10 }, (_, i) => ({
      item_id: `item_${String(i + 1).padStart(3, '0')}`,
      merchant_id: i < 5 ? 'merchant_centro' : 'merchant_palermo',
      name: `Oferta ${i + 1}`,
      description: 'Producto sintético en español',
      category: 'almacen',
      tags: ['sintetico'],
      price_minor: 1000 + i * 100,
      currency: 'ARS',
      availability: i === 9 ? 'out_of_stock' : 'in_stock',
      source_updated_at: '2026-08-29T20:45:00.000Z',
    })),
  };
}

describe('search request contract', () => {
  it('accepts a trimmed Spanish query with defaults', () => {
    const parsed = parseSearchRequest({ query: '  papas fritas  ' });
    expect(parsed.query).toBe('papas fritas');
    expect(parsed.top_k).toBe(10);
    expect(parsed.filters.availability).toBe('in_stock');
  });

  it('rejects unknown fields, short queries, and inverted price bounds', () => {
    expect(() => parseSearchRequest({ query: 'ok', extra: true })).toThrow(CatalogError);
    expect(() => parseSearchRequest({ query: 'x' })).toThrow(CatalogError);
    expect(() =>
      parseSearchRequest({
        query: 'papas',
        filters: { min_price_minor: 5000, max_price_minor: 1000 },
      }),
    ).toThrow(CatalogError);
    try {
      parseSearchRequest({ query: '' });
    } catch (err) {
      expect(err).toBeInstanceOf(CatalogError);
      expect((err as CatalogError).code).toBe('INVALID_SEARCH_REQUEST');
    }
  });
});

describe('catalog fixture contract', () => {
  it('accepts a fixture that satisfies every catalog invariant', () => {
    const catalog = validateCatalogFixture(validFixture());
    expect(catalog.offers).toHaveLength(10);
  });

  it('rejects the whole candidate for count, market, currency, URL, or non-Juno violations', () => {
    const cases: Array<{ mutate: (f: ReturnType<typeof validFixture>) => void; label: string }> = [
      { label: 'wrong count', mutate: (f) => f.offers.pop() },
      {
        label: 'unsupported market',
        mutate: (f) => {
          f.merchants[0]!.country_code = 'US';
        },
      },
      {
        label: 'unsupported currency',
        mutate: (f) => {
          f.offers[0]!.currency = 'USD';
        },
      },
      {
        label: 'continuation URL',
        mutate: (f) => {
          (f.offers[0] as { checkout_url?: string }).checkout_url = 'https://merchant.example/buy';
        },
      },
      {
        label: 'non-Juno merchant',
        mutate: (f) => {
          f.merchants[0]!.accepts_juno = false;
        },
      },
      {
        label: 'duplicate item_id',
        mutate: (f) => {
          f.offers[1]!.item_id = f.offers[0]!.item_id;
        },
      },
      {
        label: 'orphaned offer',
        mutate: (f) => {
          f.offers[0]!.merchant_id = 'missing';
        },
      },
    ];

    for (const { mutate } of cases) {
      const fixture = validFixture();
      mutate(fixture);
      expect(() => validateCatalogFixture(fixture)).toThrow(CatalogError);
    }
  });
});
