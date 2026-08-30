import { serve } from '@hono/node-server';
import { loadMockConfig } from './config.js';
import { createApp } from './app.js';
import { createRepository } from './persistence/index.js';
import { createRuntime } from './runtime.js';
import { createWorkProcessorFromConfig } from './services/work-processor.js';

export type MainHandle = {
  /** Stop the background work processor (and wait for in-flight tick). */
  stop(): Promise<void>;
};

/**
 * Start the independent Yuno REST mock process.
 * Owns HTTP listen + operational background work processor lifecycle.
 * createApp does not start the worker — main does.
 */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<MainHandle> {
  const config = loadMockConfig(env);
  const repo = createRepository(config);
  const runtime = createRuntime();
  const app = createApp({ config, repo, runtime });
  const worker = createWorkProcessorFromConfig(config, repo, runtime);

  console.log(
    `[yuno-rest-mock] listening on http://${config.HOST}:${config.PORT} (store=${config.YUNO_STORE_BACKEND}, workPollMs=${config.YUNO_MOCK_WORK_POLL_MS})`,
  );
  serve({
    fetch: app.fetch,
    hostname: config.HOST,
    port: config.PORT,
  });

  worker.start();

  const stop = async () => {
    await worker.stop();
  };

  const onSignal = () => {
    void stop().finally(() => {
      process.exit(0);
    });
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  return { stop };
}
