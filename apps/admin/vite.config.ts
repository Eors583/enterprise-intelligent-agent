import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ command, isPreview, mode }) => {
  const environment = loadEnv(mode, process.cwd(), '');
  return createAdminViteConfig({
    apiBaseUrl: environment.VITE_API_BASE_URL?.trim() || '/api/v1',
    development: command === 'serve' && isPreview !== true,
    port: parseAdminPort(environment.VITE_ADMIN_PORT),
    proxyTarget: parseApiProxyTarget(environment.VITE_API_PROXY_TARGET),
  });
});

interface AdminViteConfigInput {
  readonly apiBaseUrl: string;
  readonly development: boolean;
  readonly nonce?: string;
  readonly port?: number;
  readonly proxyTarget?: string;
}

export function createAdminViteConfig(input: AdminViteConfigInput) {
  const connectSource = externalOrigin(input.apiBaseUrl);
  const nonce = input.development ? (input.nonce ?? createCspNonce()) : null;
  const port = input.port ?? 4173;
  const proxyTarget = input.proxyTarget ?? 'http://127.0.0.1:3000';
  const proxy = {
    '/api': {
      target: proxyTarget,
      changeOrigin: true,
    },
  };

  return {
    plugins: [react()],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    ...(nonce === null ? {} : { html: { cspNonce: nonce } }),
    server: {
      port,
      strictPort: true,
      headers: adminSecurityHeaders(connectSource, { development: true, nonce, port }),
      proxy,
    },
    preview: {
      port,
      strictPort: true,
      headers: adminSecurityHeaders(connectSource, {
        development: false,
        nonce: null,
        port,
      }),
      proxy,
    },
  };
}

export function parseAdminPort(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 4173;
  if (!/^[0-9]+$/.test(value.trim())) {
    throw new Error('VITE_ADMIN_PORT must be an integer between 1 and 65535.');
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('VITE_ADMIN_PORT must be an integer between 1 and 65535.');
  }
  return port;
}

export function parseApiProxyTarget(value: string | undefined): string {
  const target = value?.trim() || 'http://127.0.0.1:3000';
  const parsed = new URL(target);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== target) {
    throw new Error('VITE_API_PROXY_TARGET must be an HTTP(S) origin without a path.');
  }
  return parsed.origin;
}

export function externalOrigin(apiBaseUrl: string): string | null {
  if (apiBaseUrl.startsWith('/')) return null;
  const parsed = new URL(apiBaseUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('VITE_API_BASE_URL must use HTTP(S) or a same-origin absolute path.');
  }
  return parsed.origin;
}

export function adminSecurityHeaders(
  connectSource: string | null,
  input: {
    readonly development: boolean;
    readonly nonce: string | null;
    readonly port?: number;
  },
): Record<string, string> {
  const scriptSource =
    input.nonce === null ? "script-src 'self'" : `script-src 'self' 'nonce-${input.nonce}'`;
  const port = input.port ?? 4173;
  const websocketSources = input.development
    ? ` ws://127.0.0.1:${port} ws://localhost:${port}`
    : '';
  return {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': [
      "default-src 'self'",
      "base-uri 'self'",
      `connect-src 'self'${websocketSources}${connectSource ? ` ${connectSource}` : ''}`,
      "font-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "img-src 'self' data: https:",
      "object-src 'none'",
      scriptSource,
      "style-src 'self' 'unsafe-inline'",
    ].join('; '),
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}

function createCspNonce(): string {
  return randomBytes(18).toString('base64');
}
