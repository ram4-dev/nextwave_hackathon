import { CatalogError, type EmbeddingProvider, type SearchResponse } from './domain.js';
import { assertCompatibleEmbedding } from './embedding.js';
import { candidateK } from './ranking.js';
import type { CatalogRepository } from './repository.js';
import { parseSearchRequest } from './schema.js';

export class CatalogSearchService {
  constructor(
    private readonly repository: CatalogRepository,
    private readonly embedding: EmbeddingProvider,
  ) {}

  async search(input: unknown): Promise<SearchResponse> {
    const request = parseSearchRequest(input);
    let queryEmbedding: readonly number[];
    try {
      const vectors = await this.embedding.embed([request.query]);
      const vector = vectors[0];
      if (!vector || vector.length !== this.embedding.dimensions) {
        throw new CatalogError('Query embedding is unavailable', 'EMBEDDING_UNAVAILABLE');
      }
      queryEmbedding = vector;
    } catch (err) {
      if (err instanceof CatalogError) throw err;
      throw new CatalogError('Query embedding is unavailable', 'EMBEDDING_UNAVAILABLE');
    }

    try {
      const result = await this.repository.searchActive({
        query: request.query,
        query_embedding: queryEmbedding,
        embedding_model: this.embedding.model,
        embedding_dimensions: this.embedding.dimensions,
        filters: request.filters,
        candidate_k: candidateK(request.top_k),
        top_k: request.top_k,
      });
      return {
        query: request.query,
        as_of: result.as_of,
        search_mode: result.search_mode,
        results: result.items,
      };
    } catch (err) {
      if (err instanceof CatalogError) throw err;
      throw new CatalogError('Internal error', 'INTERNAL_ERROR');
    }
  }
}

export function requireMatchingEmbeddingProvider(
  provider: EmbeddingProvider,
  model: string,
  dimensions: number,
): void {
  assertCompatibleEmbedding(provider, model, dimensions);
}
