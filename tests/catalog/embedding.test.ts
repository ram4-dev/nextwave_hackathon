import { describe, expect, it } from 'vitest';
import { TransformersEmbeddingProvider } from '../../src/catalog/embedding.js';

describe('TransformersEmbeddingProvider', () => {
  it('sanitizes a runtime or model failure at the embedding boundary', async () => {
    const provider = new TransformersEmbeddingProvider();
    (provider as unknown as { load: () => Promise<never> }).load = async () => {
      throw new Error('internal ONNX model path and runtime detail');
    };

    await expect(provider.embed(['papas fritas'])).rejects.toMatchObject({
      message: 'Embedding unavailable',
      code: 'EMBEDDING_UNAVAILABLE',
    });
  });
});
