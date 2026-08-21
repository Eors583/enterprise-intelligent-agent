import { describe, expect, it, vi } from 'vitest';

import type { ToolDnsResolverPort, ToolEndpointResolverPort } from './tool-execution.port.js';
import { preparePinnedHttpTarget } from './tool-execution-boundary.js';

describe('Tool HTTP execution boundary', () => {
  it('resolves and pins only public addresses after the lexical URL gate', async () => {
    const endpoint = {
      resolve: vi.fn().mockResolvedValue({
        url: 'https://crm.example.com/v1/customers',
        method: 'GET',
      }),
    } as ToolEndpointResolverPort;
    const dns = {
      resolve: vi.fn().mockResolvedValue({
        hostname: 'crm.example.com',
        addresses: ['8.8.8.8'],
        resolverName: 'enterprise-dns',
        ttlSeconds: 60,
        resolvedAt: new Date('2026-07-28T00:00:00.000Z'),
        expiresAt: new Date('2026-07-28T00:01:00.000Z'),
      }),
    } as ToolDnsResolverPort;
    await expect(
      preparePinnedHttpTarget(
        'secret://tenant/crm',
        ['crm.example.com'],
        endpoint,
        dns,
        new Date('2026-07-28T00:00:10.000Z'),
      ),
    ).resolves.toMatchObject({
      target: {
        hostname: 'crm.example.com',
        tlsServerName: 'crm.example.com',
        pinnedIpAddress: '8.8.8.8',
      },
    });
  });

  it('rejects a private DNS answer and never returns a dispatch target', async () => {
    const endpoint = {
      resolve: vi.fn().mockResolvedValue({
        url: 'https://crm.example.com/v1/customers',
        method: 'GET',
      }),
    } as ToolEndpointResolverPort;
    const dns = {
      resolve: vi.fn().mockResolvedValue({
        hostname: 'crm.example.com',
        addresses: ['127.0.0.1'],
        resolverName: 'enterprise-dns',
        ttlSeconds: 60,
        resolvedAt: new Date('2026-07-28T00:00:00.000Z'),
        expiresAt: new Date('2026-07-28T00:01:00.000Z'),
      }),
    } as ToolDnsResolverPort;
    await expect(
      preparePinnedHttpTarget(
        'secret://tenant/crm',
        ['crm.example.com'],
        endpoint,
        dns,
        new Date('2026-07-28T00:00:10.000Z'),
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ reasonCode: 'NON_PUBLIC_ADDRESS' }),
    });
  });
});
