import { describe, expect, it } from 'vitest';

import {
  adminSecurityHeaders,
  createAdminViteConfig,
  externalOrigin,
  parseAdminPort,
  parseApiProxyTarget,
} from '../vite.config';

describe('admin Vite security configuration', () => {
  it('adds a matching CSP nonce for the development React refresh preamble', () => {
    const config = createAdminViteConfig({
      apiBaseUrl: '/api/v1',
      development: true,
      nonce: 'development-test-nonce',
    });

    expect(config.html).toEqual({ cspNonce: 'development-test-nonce' });
    expect(config.server.headers['Content-Security-Policy']).toContain(
      "script-src 'self' 'nonce-development-test-nonce'",
    );
    expect(config.server.headers['Content-Security-Policy']).not.toContain(
      "script-src 'self' 'unsafe-inline'",
    );
  });

  it('keeps preview scripts strict and proxies same-origin API requests', () => {
    const config = createAdminViteConfig({
      apiBaseUrl: '/api/v1',
      development: false,
      port: 4273,
      proxyTarget: 'http://127.0.0.1:3300',
    });

    expect('html' in config).toBe(false);
    expect(config.preview.port).toBe(4273);
    expect(config.preview.headers['Content-Security-Policy']).toContain("script-src 'self'");
    expect(config.preview.headers['Content-Security-Policy']).not.toContain("'nonce-");
    expect(config.preview.proxy['/api']).toEqual({
      target: 'http://127.0.0.1:3300',
      changeOrigin: true,
    });
  });

  it('only adds websocket and external API origins where they are required', () => {
    const origin = externalOrigin('https://api.enterprise.example/api/v1');
    expect(origin).toBe('https://api.enterprise.example');
    expect(
      adminSecurityHeaders(origin, {
        development: true,
        nonce: 'nonce',
        port: 4274,
      })['Content-Security-Policy'],
    ).toContain('ws://127.0.0.1:4274');
    const previewCsp = adminSecurityHeaders(origin, {
      development: false,
      nonce: null,
    })['Content-Security-Policy'];
    expect(previewCsp).toContain('https://api.enterprise.example');
    expect(previewCsp).not.toContain('ws://');
  });

  it('validates isolated acceptance ports and proxy origins', () => {
    expect(parseAdminPort(undefined)).toBe(4173);
    expect(parseAdminPort('4274')).toBe(4274);
    expect(() => parseAdminPort('0')).toThrow('VITE_ADMIN_PORT');
    expect(() => parseAdminPort('not-a-port')).toThrow('VITE_ADMIN_PORT');
    expect(parseApiProxyTarget(undefined)).toBe('http://127.0.0.1:3000');
    expect(parseApiProxyTarget('http://127.0.0.1:3300')).toBe('http://127.0.0.1:3300');
    expect(() => parseApiProxyTarget('http://127.0.0.1:3300/api')).toThrow('VITE_API_PROXY_TARGET');
  });
});
