import type {
  DerivedCatalogSnapshot,
  HydratedSearchItem,
  HydratedSearchResult,
  PublishResult,
  RepositorySearchInput,
  SearchMode,
} from '../../src/catalog/domain.js';
import { CatalogError } from '../../src/catalog/domain.js';
import { matchesAuthoritativeFilters } from '../../src/catalog/filters.js';
import type { CatalogRepository } from '../../src/catalog/repository.js';

export class MemoryCatalogRepository implements CatalogRepository {
  snapshots = new Map<string, DerivedCatalogSnapshot>();
  activeVersion?: string;
  publishCalls = 0;
  searchCalls = 0;
  hydrateCalls = 0;
  lastHydrateItemIds: string[] = [];
  failNextPublish = false;
  searchMode: SearchMode = 'hnsw';
  missingOnHydrate = false;
  throwOnSearch?: CatalogError;
  unexpectedOnSearch = false;
  revisions = new Map<string, { data_revision: number; search_revision: number; index_revision: number }>();

  setRevision(
    itemId: string,
    revision: { data_revision: number; search_revision: number; index_revision: number },
  ): void {
    this.revisions.set(itemId, revision);
  }

  setOfferPrice(itemId: string, priceMinor: number): void {
    if (!this.activeVersion) return;
    const snapshot = this.snapshots.get(this.activeVersion);
    if (!snapshot) return;
    const offer = snapshot.offers.find((row) => row.item_id === itemId);
    if (offer) offer.price_minor = priceMinor;
  }

  async publish(snapshot: DerivedCatalogSnapshot): Promise<PublishResult> {
    this.publishCalls += 1;
    if (this.failNextPublish) {
      this.failNextPublish = false;
      throw new CatalogError('candidate failed before commit', 'INVALID_CATALOG_FIXTURE');
    }
    const existing = this.snapshots.get(snapshot.version);
    if (existing && this.activeVersion) {
      return {
        catalog_version_id: snapshot.version,
        version: snapshot.version,
        status: 'published',
        idempotent: true,
      };
    }
    this.snapshots.set(snapshot.version, snapshot);
    this.activeVersion = snapshot.version;
    return {
      catalog_version_id: snapshot.version,
      version: snapshot.version,
      status: 'published',
      idempotent: false,
    };
  }

  async rollback(version: string): Promise<void> {
    if (!this.snapshots.has(version)) {
      throw new CatalogError('Retained version is missing', 'CATALOG_UNAVAILABLE');
    }
    this.activeVersion = version;
  }

  async searchActive(input: RepositorySearchInput): Promise<HydratedSearchResult> {
    this.searchCalls += 1;
    if (this.throwOnSearch) throw this.throwOnSearch;
    if (this.unexpectedOnSearch) throw new Error('ECONNREFUSED catalog-db');
    if (!this.activeVersion) {
      throw new CatalogError('No published catalog version', 'CATALOG_UNAVAILABLE');
    }
    const snapshot = this.snapshots.get(this.activeVersion);
    if (!snapshot) {
      throw new CatalogError('No published catalog version', 'CATALOG_UNAVAILABLE');
    }

    const ranked = snapshot.offers.map((offer) => offer.item_id).slice(0, input.candidate_k);
    this.hydrateCalls += 1;
    this.lastHydrateItemIds = [...ranked];
    if (this.missingOnHydrate) {
      throw new CatalogError('Candidate missing from active version', 'SEARCH_UNAVAILABLE');
    }

    const items = ranked
      .map((itemId) => this.hydrate(snapshot, itemId, 1 / (ranked.indexOf(itemId) + 1)))
      .filter((item) => matchesAuthoritativeFilters(item, input.filters))
      .slice(0, input.top_k);

    return {
      as_of: snapshot.source_updated_at,
      search_mode: this.searchMode,
      items,
    };
  }

  hydrate(snapshot: DerivedCatalogSnapshot, itemId: string, score: number): HydratedSearchItem {
    const offer = snapshot.offers.find((row) => row.item_id === itemId)!;
    const merchant = snapshot.merchants.find((row) => row.merchant_id === offer.merchant_id)!;
    return {
      item_id: offer.item_id,
      merchant: {
        merchant_id: merchant.merchant_id,
        name: merchant.name,
        category: merchant.category,
        accepts_juno: true,
      },
      product: {
        name: offer.name,
        description: offer.description,
        category: offer.category,
        tags: offer.tags,
      },
      price: {
        amount_minor: offer.price_minor,
        currency: offer.currency,
      },
      availability: offer.availability,
      score,
      updated_at: offer.source_updated_at,
      ...(this.revisions.get(itemId) ?? { data_revision: 1, search_revision: 1, index_revision: 1 }),
    };
  }
}
