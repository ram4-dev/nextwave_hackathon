import { createHash } from 'node:crypto';
import {
  CatalogError,
  DEFAULT_EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  type EmbeddingProvider,
} from './domain.js';

export { DEFAULT_EMBEDDING_MODEL, EMBEDDING_DIMENSIONS };

const CONCEPT_CLUSTERS: readonly (readonly string[])[] = [
  ['papa', 'papas', 'frita', 'fritas', 'baston', 'bastones', 'crocante', 'crocantes', 'snack'],
  ['hamburguesa', 'hamburguesas', 'carne'],
  ['empanada', 'empanadas'],
  ['cafe', 'café', 'grano'],
  ['yerba', 'mate'],
  ['agua', 'mineral'],
  ['alfajor', 'alfajores', 'chocolate'],
  ['leche', 'entera'],
  ['pan', 'lactal'],
];

function tokenize(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9áéíóúñü]+/i)
    .filter(Boolean);
}

function l2Normalize(values: number[]): number[] {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1;
  return values.map((value) => value / norm);
}

/**
 * Deterministic 384-d provider for tests. Concept clusters keep Spanish
 * near-synonyms close without downloading a model or sending query text.
 */
export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly model = 'test-deterministic-384';
  readonly dimensions = EMBEDDING_DIMENSIONS;

  async embed(texts: readonly string[]): Promise<readonly number[][]> {
    return texts.map((text) => {
      const tokens = new Set(tokenize(text));
      const vector = new Array<number>(this.dimensions).fill(0);
      CONCEPT_CLUSTERS.forEach((cluster, clusterIndex) => {
        if (cluster.some((token) => tokens.has(token))) {
          vector[clusterIndex] = 1;
        }
      });
      const digest = createHash('sha256').update(text).digest();
      for (let i = 0; i < this.dimensions; i++) {
        vector[i] = (vector[i] ?? 0) + ((digest[i % digest.length] ?? 0) / 255 - 0.5) * 0.01;
      }
      return l2Normalize(vector);
    });
  }
}

type FeatureExtractor = (
  texts: string | string[],
  options: { pooling: 'mean'; normalize: true },
) => Promise<{ tolist: () => number[][] }>;

/**
 * Local multilingual embeddings via `@huggingface/transformers`.
 * Preferred model: Xenova/paraphrase-multilingual-MiniLM-L12-v2 (384-d).
 * Query text never leaves the process; only a one-time model download occurs.
 */
export class TransformersEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions = EMBEDDING_DIMENSIONS;
  private extractor?: FeatureExtractor;
  private loading?: Promise<FeatureExtractor>;

  constructor(model = DEFAULT_EMBEDDING_MODEL) {
    this.model = model;
  }

  async embed(texts: readonly string[]): Promise<readonly number[][]> {
    try {
      const extractor = await this.load();
      const output = await extractor([...texts], { pooling: 'mean', normalize: true });
      const vectors = output.tolist();
      for (const vector of vectors) {
        if (vector.length !== this.dimensions) {
          throw new Error(`expected ${this.dimensions} dimensions, got ${vector.length}`);
        }
      }
      return vectors;
    } catch {
      throw new CatalogError('Embedding unavailable', 'EMBEDDING_UNAVAILABLE');
    }
  }

  private async load(): Promise<FeatureExtractor> {
    if (this.extractor) return this.extractor;
    this.loading ??= (async () => {
      const transformers = (await import('@huggingface/transformers')) as {
        pipeline: (task: string, model: string) => Promise<FeatureExtractor>;
      };
      const extractor = await transformers.pipeline('feature-extraction', this.model);
      this.extractor = extractor;
      return extractor;
    })();
    return this.loading;
  }
}

export function assertCompatibleEmbedding(
  provider: EmbeddingProvider,
  model: string,
  dimensions: number,
): void {
  if (provider.model !== model || provider.dimensions !== dimensions) {
    throw new CatalogError('Embedding provider does not match the active catalog version', 'EMBEDDING_UNAVAILABLE');
  }
}
