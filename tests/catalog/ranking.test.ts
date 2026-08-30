import { describe, expect, it } from 'vitest';
import { candidateK, compareRanked, reciprocalRankFusion } from '../../src/catalog/ranking.js';

describe('hybrid ranking', () => {
  it('computes weighted RRF and breaks ties by item_id ASC', () => {
    const fused = reciprocalRankFusion({
      semantic: ['b', 'a'],
      lexical: ['a', 'c'],
    });
    const score = (semanticRank: number | undefined, lexicalRank: number | undefined) =>
      61 *
      ((semanticRank === undefined ? 0 : 0.8 / (60 + semanticRank)) +
        (lexicalRank === undefined ? 0 : 0.2 / (60 + lexicalRank)));

    expect(fused.find((row) => row.item_id === 'a')?.score).toBeCloseTo(score(2, 1));
    expect(fused.find((row) => row.item_id === 'b')?.score).toBeCloseTo(score(1, undefined));
    expect(fused.find((row) => row.item_id === 'c')?.score).toBeCloseTo(score(undefined, 2));

    expect(
      [
        { item_id: 'z', score: 0.5 },
        { item_id: 'm', score: 0.5 },
      ].sort(compareRanked).map((row) => row.item_id),
    ).toEqual(['m', 'z']);
  });

  it('sizes candidate_k from top_k with the approved bounds', () => {
    expect(candidateK(1)).toBe(50);
    expect(candidateK(10)).toBe(100);
    expect(candidateK(50)).toBe(200);
  });
});
