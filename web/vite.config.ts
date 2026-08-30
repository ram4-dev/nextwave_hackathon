import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/** Vite's root is `web`, but public deployment variables live in repo `.env`. */
export const VITE_ENV_DIR = path.resolve(__dirname, '..');

function allowedPublicHost(publicBaseUrl: string | undefined): string[] | undefined {
  if (!publicBaseUrl) return undefined;
  try {
    return [new URL(publicBaseUrl).hostname];
  } catch {
    return undefined;
  }
}

function apiProxyTarget(value: string | undefined): string {
  if (!value) return 'http://localhost:8787';
  const target = new URL(value);
  if (!['http:', 'https:'].includes(target.protocol)) {
    throw new Error('KYA_API_PROXY_TARGET must use http or https');
  }
  return target.origin;
}

export function createViteConfig(
  mode: string,
  runtimeEnv: Record<string, string | undefined> = loadEnv(mode, VITE_ENV_DIR, ''),
) {
  const proxyTarget = apiProxyTarget(runtimeEnv.KYA_API_PROXY_TARGET);
  return {
    envDir: VITE_ENV_DIR,
    base: '/app/',
    plugins: [react()],
    root: path.resolve(__dirname),
    build: {
      outDir: path.resolve(__dirname, 'dist'),
      emptyOutDir: true,
    },
    server: {
      port: 5173,
      // This is server-only Vite configuration. Only VITE_* keys are exposed to
      // browser modules; PUBLIC_BASE_URL and KYA_API_PROXY_TARGET stay server-only.
      allowedHosts: allowedPublicHost(runtimeEnv.PUBLIC_BASE_URL),
      proxy: {
        '/v1': proxyTarget,
        '/.well-known': proxyTarget,
        '/health': proxyTarget,
        '/ready': proxyTarget,
      },
    },
  };
}

export default defineConfig(({ mode }) => createViteConfig(mode));
