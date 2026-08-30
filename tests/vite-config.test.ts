import { describe, expect, it } from 'vitest';
import { loadEnv } from 'vite';
import { createViteConfig, VITE_ENV_DIR } from '../web/vite.config.js';

describe('Vite public CDP environment', () => {
  it('loads the repository-root public project configuration without exposing its value', () => {
    const config = createViteConfig('development');
    const env = loadEnv('development', VITE_ENV_DIR, 'VITE_');
    expect(config.envDir).toBe(VITE_ENV_DIR);
    const projectId = env.VITE_CDP_PROJECT_ID;
    if (typeof projectId === 'string' && projectId.length > 0) {
      expect(projectId.trim().length).toBeGreaterThan(0);
    }
    expect(JSON.stringify(config)).not.toMatch(/cdp[_-]?api[_-]?key|secret/i);
  });

  it('derives the allowed development host from the configured public base URL', () => {
    const config = createViteConfig('development', {
      PUBLIC_BASE_URL: 'https://public-tunnel.example/path',
    });
    expect(config.server.allowedHosts).toEqual(['public-tunnel.example']);
  });

  it('can isolate a worktree against an explicit server-only API proxy target', () => {
    const config = createViteConfig('development', {
      KYA_API_PROXY_TARGET: 'http://127.0.0.1:8788',
    });
    expect(config.server.proxy).toEqual({
      '/v1': 'http://127.0.0.1:8788',
      '/.well-known': 'http://127.0.0.1:8788',
      '/health': 'http://127.0.0.1:8788',
      '/ready': 'http://127.0.0.1:8788',
    });
    expect(JSON.stringify(config)).not.toContain('VITE_KYA_API_PROXY_TARGET');
  });
});
