import { describe, expect, it } from 'vitest';

import {
  KnowledgeSourceFetchError,
  validateSourceUrl,
} from './controlled-knowledge-source-fetcher.js';

describe('controlled knowledge source URL policy', () => {
  it('accepts an exact allowlisted HTTPS host', () => {
    expect(
      validateSourceUrl('https://drive.example.com/manifest?scope=policies', {
        allowedHosts: ['drive.example.com'],
        timeoutMs: 10_000,
        allowLocalFixture: false,
      }).hostname,
    ).toBe('drive.example.com');
  });

  it('rejects credentials, redirects to arbitrary hosts, and private fixtures by default', () => {
    const policy = {
      allowedHosts: ['drive.example.com', 'localhost'],
      timeoutMs: 10_000,
      allowLocalFixture: false,
    };
    expect(() => validateSourceUrl('https://user:secret@drive.example.com/a', policy)).toThrow(
      KnowledgeSourceFetchError,
    );
    expect(() => validateSourceUrl('https://other.example.com/a', policy)).toThrow(
      'KNOWLEDGE_SOURCE_HOST_NOT_ALLOWED',
    );
    expect(() => validateSourceUrl('https://localhost:9443/a', policy)).toThrow(
      'KNOWLEDGE_SOURCE_URL_INVALID',
    );
  });

  it('allows an explicit development-only HTTPS loopback fixture port', () => {
    expect(
      validateSourceUrl('https://localhost:9443/manifest', {
        allowedHosts: ['localhost'],
        timeoutMs: 10_000,
        allowLocalFixture: true,
      }).port,
    ).toBe('9443');
  });
});
