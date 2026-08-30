import type { RankedCandidate } from './domain.js';

const RRF_K = 60;
const SEMANTIC_WEIGHT = 0.8;
const LEXICAL_WEIGHT = 0.2;

export function candidateK(topK: number): number {
  return Math.min(Math.max(topK * 10, 50), 200);
}

export function reciprocalRankFusion(input: {
  semantic: readonly string[];
  lexical: readonly string[];
}): RankedCandidate[] {
  const scores = new Map<string, number>();
  const add = (ids: readonly string[], weight: number) => {
    ids.forEach((itemId, index) => {
      const rank = index + 1;
      scores.set(itemId, (scores.get(itemId) ?? 0) + weight / (RRF_K + rank));
    });
  };
  add(input.semantic, SEMANTIC_WEIGHT);
  add(input.lexical, LEXICAL_WEIGHT);
  return [...scores.entries()]
    .map(([item_id, raw]) => ({ item_id, score: (RRF_K + 1) * raw }))
    .sort(compareRanked);
}

export function compareRanked(a: RankedCandidate, b: RankedCandidate): number {
  return b.score - a.score || a.item_id.localeCompare(b.item_id);
}
