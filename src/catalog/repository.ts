import type {
  DerivedCatalogSnapshot,
  HydratedSearchResult,
  PublishResult,
  RepositorySearchInput,
} from './domain.js';

export interface CatalogRepository {
  searchActive(input: RepositorySearchInput): Promise<HydratedSearchResult>;
  publish(snapshot: DerivedCatalogSnapshot): Promise<PublishResult>;
  rollback(version: string): Promise<void>;
}
