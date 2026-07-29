import { describe, expect, it, vi } from 'vitest';

import { SECURITY_HEADERS, SecurityHeadersMiddleware } from './security-headers.middleware.js';

describe('SecurityHeadersMiddleware', () => {
  it('sets a no-store, non-executable, non-embeddable API boundary', () => {
    const setHeader = vi.fn();
    const removeHeader = vi.fn();
    const next = vi.fn();

    new SecurityHeadersMiddleware().use({} as never, { setHeader, removeHeader } as never, next);

    expect(setHeader.mock.calls).toEqual(Object.entries(SECURITY_HEADERS));
    expect(removeHeader).toHaveBeenCalledWith('X-Powered-By');
    expect(next).toHaveBeenCalledOnce();
    expect(SECURITY_HEADERS['Content-Security-Policy']).toContain("default-src 'none'");
    expect(SECURITY_HEADERS['Content-Security-Policy']).toContain("frame-ancestors 'none'");
  });
});
