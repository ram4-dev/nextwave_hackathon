/**
 * Operational background work processor for webhook retries + async actions.
 * Started by main() only — createApp unit tests do not auto-start it.
 * Scheduler/timer is injectable so tests never sleep.
 */
import type { MockConfig } from '../config.js';
import type { YunoMockRepository } from '../persistence/types.js';
import { redactSecrets } from '../redact.js';
import type { MockRuntime } from '../runtime.js';
import { processDueWork } from './webhook-delivery.js';

export type IntervalHandle = {
  clear(): void;
};

/** Pluggable timer surface — production uses setInterval; tests inject a manual driver. */
export type Scheduler = {
  every(intervalMs: number, tick: () => void | Promise<void>): IntervalHandle;
};

export function systemScheduler(): Scheduler {
  return {
    every(intervalMs, tick) {
      const id = setInterval(() => {
        void Promise.resolve()
          .then(() => tick())
          .catch(() => {
            // Errors must be handled inside the processor tick.
          });
      }, intervalMs);
      // Avoid keeping the event loop alive solely for the mock worker in some runtimes.
      if (typeof id === 'object' && id && 'unref' in id && typeof id.unref === 'function') {
        id.unref();
      }
      return {
        clear: () => clearInterval(id),
      };
    },
  };
}

/**
 * Manual scheduler for deterministic tests: records the tick callback and
 * exposes runTick() so callers advance work without sleeping.
 */
export function createManualScheduler(): Scheduler & {
  runTick(): Promise<void>;
  isArmed(): boolean;
} {
  let tick: (() => void | Promise<void>) | null = null;
  return {
    every(_intervalMs, fn) {
      tick = fn;
      return {
        clear: () => {
          tick = null;
        },
      };
    },
    async runTick() {
      if (!tick) return;
      await tick();
    },
    isArmed() {
      return tick !== null;
    },
  };
}

export type WorkProcessor = {
  /** Begin periodic ticks. Idempotent. */
  start(): void;
  /** Cancel scheduler and wait for any in-flight tick to finish. */
  stop(): Promise<void>;
  /** Run one processDueWork cycle (also used by the scheduler). */
  tick(): Promise<void>;
  readonly running: boolean;
};

export type CreateWorkProcessorOptions = {
  repo: YunoMockRepository;
  runtime: MockRuntime;
  secretsKey: Buffer;
  intervalMs: number;
  scheduler?: Scheduler;
  /** Extra secret strings to redact from error logs. */
  redactSecrets?: readonly string[];
  onError?: (message: string) => void;
};

export function createWorkProcessor(
  options: CreateWorkProcessorOptions,
): WorkProcessor {
  const scheduler = options.scheduler ?? systemScheduler();
  const logError =
    options.onError ??
    ((message: string) => {
      console.error(`[yuno-rest-mock] work-processor ${message}`);
    });

  let handle: IntervalHandle | null = null;
  let started = false;
  let stopped = false;
  let tickInFlight: Promise<void> | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (tickInFlight) {
      // Prevent overlapping ticks — skip while a previous cycle is running.
      return;
    }
    tickInFlight = (async () => {
      try {
        await processDueWork(options.repo, options.runtime, options.secretsKey);
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        const secrets = [
          ...(options.redactSecrets ?? []),
          options.secretsKey.toString('hex'),
        ];
        logError(redactSecrets(raw, secrets));
      } finally {
        tickInFlight = null;
      }
    })();
    await tickInFlight;
  };

  return {
    get running() {
      return started && !stopped;
    },
    start() {
      if (started || stopped) return;
      started = true;
      handle = scheduler.every(options.intervalMs, tick);
    },
    async stop() {
      stopped = true;
      handle?.clear();
      handle = null;
      if (tickInFlight) await tickInFlight;
    },
    tick,
  };
}

/** Convenience: build processor from loaded mock config + runtime. */
export function createWorkProcessorFromConfig(
  config: MockConfig,
  repo: YunoMockRepository,
  runtime: MockRuntime,
  overrides: Partial<CreateWorkProcessorOptions> = {},
): WorkProcessor {
  return createWorkProcessor({
    repo,
    runtime,
    secretsKey: config.secretsKey,
    intervalMs: config.YUNO_MOCK_WORK_POLL_MS,
    redactSecrets: [
      config.YUNO_PUBLIC_API_KEY,
      config.YUNO_PRIVATE_SECRET_KEY,
      config.YUNO_MOCK_FINGERPRINT_SECRET,
      config.YUNO_MOCK_SECRETS_KEY,
    ],
    ...overrides,
  });
}
