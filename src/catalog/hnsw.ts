export type HnswReadiness = 'ready' | 'unavailable';

export interface HnswIndexProbe {
  amname?: string | null;
  indisvalid?: boolean | null;
}

export function classifyHnswReadiness(probe: HnswIndexProbe | undefined): HnswReadiness {
  if (!probe || probe.amname !== 'hnsw' || probe.indisvalid !== true) {
    return 'unavailable';
  }
  return 'ready';
}

export function isGeneralDatabaseFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /ECONNREFUSED|ECONNRESET|connection terminated|timeout expired|too many clients|serialization failure|deadlock detected/i.test(
    message,
  );
}

export function shouldUseExactFallback(input: {
  readiness: HnswReadiness;
}): boolean {
  return input.readiness === 'unavailable';
}
