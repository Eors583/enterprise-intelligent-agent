import type { ToolProviderRequest } from '../../tool-execution.port.js';
import {
  buildPinnedHttpRequestOptions,
  buildToolProviderHeaders,
  parseProviderCost,
} from './pinned-http-tool-provider.dispatcher.js';

describe('Pinned HTTP Tool provider boundary', () => {
  it('connects only to the validated IP while retaining the original hostname for TLS SNI', () => {
    const request = providerRequest();
    const headers = buildToolProviderHeaders(
      request,
      Buffer.from('{"customerId":"C-001"}'),
      '2026-07-28T00:00:00.000Z',
      '/v1/customer',
    );
    expect(buildPinnedHttpRequestOptions(request, '/v1/customer', headers)).toMatchObject({
      protocol: 'https:',
      hostname: '93.184.216.34',
      port: 443,
      servername: 'crm.example.com',
      rejectUnauthorized: true,
      agent: false,
      headers: {
        host: 'crm.example.com',
      },
    });
  });

  it('signs the immutable employee, Role Assignment, task, and request identity', () => {
    const request = providerRequest();
    const first = buildToolProviderHeaders(
      request,
      Buffer.from('{"customerId":"C-001"}'),
      '2026-07-28T00:00:00.000Z',
      '/v1/customer',
    );
    const changed = buildToolProviderHeaders(
      { ...request, roleAssignmentId: '00000000-0000-7000-8000-000000000999' },
      Buffer.from('{"customerId":"C-001"}'),
      '2026-07-28T00:00:00.000Z',
      '/v1/customer',
    );
    expect(first).toMatchObject({
      'x-enterprise-tenant-id': '00000000-0000-7000-8000-000000000001',
      'x-enterprise-user-id': '00000000-0000-7000-8000-000000000101',
      'x-enterprise-role-assignment-id': '00000000-0000-7000-8000-000000000301',
      'x-enterprise-task-id': '00000000-0000-7000-8000-000000000401',
      'x-enterprise-signature-version': 'v1',
    });
    expect(first['x-enterprise-signature']).toMatch(/^[0-9a-f]{64}$/u);
    expect(changed['x-enterprise-signature']).not.toBe(first['x-enterprise-signature']);
    expect(JSON.stringify(first)).not.toContain('12345678901234567890123456789012');
  });

  it('keeps missing, known zero, and non-zero provider costs distinct', () => {
    expect(parseProviderCost(undefined)).toEqual({ kind: 'UNATTESTED' });
    expect(parseProviderCost('0')).toEqual({
      kind: 'PROVIDER_ATTESTED',
      costMicros: 0n,
    });
    expect(parseProviderCost('1250')).toEqual({
      kind: 'PROVIDER_ATTESTED',
      costMicros: 1250n,
    });
  });

  it('rejects duplicate, negative, non-canonical, and overflowing cost attestations', () => {
    expect(parseProviderCost(['1', '2'])).toBeNull();
    expect(parseProviderCost('-1')).toBeNull();
    expect(parseProviderCost('01')).toBeNull();
    expect(parseProviderCost('9223372036854775808')).toBeNull();
  });
});

function providerRequest(): ToolProviderRequest {
  const resolvedAt = new Date('2026-07-28T00:00:00.000Z');
  return {
    invocationId: '00000000-0000-7000-8000-000000000201',
    tenantId: '00000000-0000-7000-8000-000000000001',
    requesterUserId: '00000000-0000-7000-8000-000000000101',
    roleAssignmentId: '00000000-0000-7000-8000-000000000301',
    taskId: '00000000-0000-7000-8000-000000000401',
    correlationId: '00000000-0000-7000-8000-000000000501',
    providerRequestId: 'tool-provider:00000000-0000-7000-8000-000000000201',
    endpoint: {
      url: 'https://crm.example.com/v1/customer',
      method: 'POST',
      headers: { authorization: 'Bearer server-only' },
      signingSecret: '12345678901234567890123456789012',
    },
    target: {
      normalizedUrl: 'https://crm.example.com/v1/customer',
      hostname: 'crm.example.com',
      tlsServerName: 'crm.example.com',
      pinnedIpAddress: '93.184.216.34',
      resolution: {
        hostname: 'crm.example.com',
        addresses: ['93.184.216.34'],
        resolverName: 'test',
        ttlSeconds: 300,
        resolvedAt,
        expiresAt: new Date(resolvedAt.getTime() + 300_000),
      },
    },
    input: { customerId: 'C-001' },
    idempotencyKey: 'tool-provider:00000000-0000-7000-8000-000000000201',
    timeoutMs: 10_000,
    providerDryRun: false,
  };
}
