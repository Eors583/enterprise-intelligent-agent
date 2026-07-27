import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { loadEnv } from 'vite';

function apiOrigin(value: string | undefined): string {
  if (!value) return '';

  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : '';
  } catch {
    return '';
  }
}

export default defineConfig(({ mode }) => {
  const workspaceRoot = resolve(process.cwd(), '../..');
  const env = loadEnv(mode, workspaceRoot, '');
  const authPublicAppUrl =
    env.AUTH_PUBLIC_APP_URL ?? (mode === 'development' ? 'http://127.0.0.1:4173' : '');

  return {
    main: {
      define: {
        __AUTH_PUBLIC_APP_URL__: JSON.stringify(authPublicAppUrl),
        __RENDERER_API_ORIGIN__: JSON.stringify(apiOrigin(env.VITE_API_BASE_URL)),
        __RENDERER_API_BASE_URL__: JSON.stringify(env.VITE_API_BASE_URL ?? ''),
      },
      // The workspace contracts package is ESM-only. Bundle it into Electron's
      // main output so the generated CJS entry never tries to require() it.
      plugins: [externalizeDepsPlugin({ exclude: ['@enterprise/contracts'] })],
    },
    preload: {
      plugins: [externalizeDepsPlugin()],
    },
    renderer: {
      envDir: workspaceRoot,
      resolve: {
        alias: {
          '@renderer': resolve('src/renderer/src'),
          '@shared': resolve('src/shared'),
        },
      },
      plugins: [react()],
    },
  };
});
