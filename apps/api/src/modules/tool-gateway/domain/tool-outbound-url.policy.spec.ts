import { describe, expect, it } from 'vitest';

import {
  decideResolvedToolOutboundTarget,
  decideToolOutboundUrl,
} from './tool-outbound-url.policy.js';

describe('Tool outbound URL policy', () => {
  it('allows only an explicitly allowlisted HTTPS host', () => {
    expect(
      decideToolOutboundUrl('https://crm.example.com/api/customers/1#ignored', ['crm.example.com']),
    ).toEqual({
      allowed: true,
      normalizedUrl: 'https://crm.example.com/api/customers/1',
      hostname: 'crm.example.com',
      obligation: 'RESOLVE_AND_PIN_PUBLIC_IP',
    });
  });

  it.each([
    ['http://crm.example.com/customers', 'TLS_REQUIRED'],
    ['https://user:secret@crm.example.com/customers', 'USERINFO_FORBIDDEN'],
    ['https://127.0.0.1/customers', 'IP_LITERAL_FORBIDDEN'],
    ['https://localhost/customers', 'PRIVATE_HOST_FORBIDDEN'],
    ['https://crm.example.com:8443/customers', 'UNSAFE_PORT'],
    ['https://evil.example.net/customers', 'HOST_NOT_ALLOWED'],
  ])('denies unsafe target %s', (url, reasonCode) => {
    expect(decideToolOutboundUrl(url, ['crm.example.com'])).toEqual({
      allowed: false,
      reasonCode,
    });
  });

  it('supports an explicit subdomain wildcard without allowing the apex', () => {
    expect(
      decideToolOutboundUrl('https://eu.crm.example.com/v1', ['*.crm.example.com']),
    ).toMatchObject({ allowed: true });
    expect(decideToolOutboundUrl('https://crm.example.com/v1', ['*.crm.example.com'])).toEqual({
      allowed: false,
      reasonCode: 'HOST_NOT_ALLOWED',
    });
  });

  it('pins only fresh, globally routable DNS answers', () => {
    const urlDecision = decideToolOutboundUrl('https://crm.example.com/v1', ['crm.example.com']);
    const now = new Date('2026-07-28T00:05:00.000Z');
    expect(
      decideResolvedToolOutboundTarget(
        urlDecision,
        {
          hostname: 'crm.example.com',
          addresses: ['93.184.216.34', '2606:4700:4700::1111'],
          resolvedAt: '2026-07-28T00:04:00.000Z',
          expiresAt: '2026-07-28T00:06:00.000Z',
        },
        now,
      ),
    ).toMatchObject({
      allowed: true,
      pinnedAddresses: ['2606:4700:4700::1111', '93.184.216.34'],
    });
  });

  it.each([
    [['127.0.0.1'], 'NON_PUBLIC_ADDRESS'],
    [['10.0.0.1'], 'NON_PUBLIC_ADDRESS'],
    [['169.254.169.254'], 'NON_PUBLIC_ADDRESS'],
    [['93.184.216.34', '192.168.1.10'], 'NON_PUBLIC_ADDRESS'],
    [['fc00::1'], 'NON_PUBLIC_ADDRESS'],
    [['2001:db8::1'], 'NON_PUBLIC_ADDRESS'],
    [['3fff::1'], 'NON_PUBLIC_ADDRESS'],
  ])('denies private, mixed, or special DNS answers %#', (addresses, reasonCode) => {
    const urlDecision = decideToolOutboundUrl('https://crm.example.com/v1', ['crm.example.com']);
    expect(
      decideResolvedToolOutboundTarget(
        urlDecision,
        {
          hostname: 'crm.example.com',
          addresses,
          resolvedAt: '2026-07-28T00:04:00.000Z',
          expiresAt: '2026-07-28T00:06:00.000Z',
        },
        new Date('2026-07-28T00:05:00.000Z'),
      ),
    ).toEqual({ allowed: false, reasonCode });
  });

  it('denies stale DNS proofs and requires every redirect to repeat both gates', () => {
    const urlDecision = decideToolOutboundUrl('https://crm.example.com/v1', ['crm.example.com']);
    expect(
      decideResolvedToolOutboundTarget(
        urlDecision,
        {
          hostname: 'crm.example.com',
          addresses: ['93.184.216.34'],
          resolvedAt: '2026-07-28T00:01:00.000Z',
          expiresAt: '2026-07-28T00:02:00.000Z',
        },
        new Date('2026-07-28T00:05:00.000Z'),
      ),
    ).toEqual({ allowed: false, reasonCode: 'DNS_PROOF_INVALID' });
  });
});
