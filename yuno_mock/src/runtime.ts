/**
 * Injected clock + HTTP transport so webhook retries and async work are
 * deterministic in tests (no real sleeps).
 */

export type Clock = {
  now(): number;
};

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export const systemClock: Clock = {
  now: () => Date.now(),
};

export function createManualClock(startMs = 0): Clock & { advance(ms: number): void; set(ms: number): void } {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
    set: (ms: number) => {
      current = ms;
    },
  };
}

export type MockRuntime = {
  clock: Clock;
  fetch: FetchLike;
};

export function createRuntime(overrides: Partial<MockRuntime> = {}): MockRuntime {
  return {
    clock: overrides.clock ?? systemClock,
    fetch: overrides.fetch ?? globalThis.fetch.bind(globalThis),
  };
}
