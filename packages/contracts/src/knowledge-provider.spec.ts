import { describe, expect, it } from 'vitest';

import {
  bindLexiangUserRequestSchema,
  createLexiangConnectionRequestSchema,
  discoverLexiangConnectionRequestSchema,
  lexiangConnectionDiscoveryResponseSchema,
  lexiangSpaceSyncResponseSchema,
  knowledgeProviderConnectionSchema,
  knowledgeProviderHealthCheckResponseSchema,
  knowledgeProviderUserBindingsResponseSchema,
} from './knowledge-provider.js';

describe('knowledge provider contracts', () => {
  it('accepts write-only credentials but never exposes a secret in connection responses', () => {
    expect(
      createLexiangConnectionRequestSchema.parse({
        appKey: 'app-key',
        appSecret: 'secret-value',
        teamId: 'team-1',
        operatorStaffId: 'staff-1',
      }),
    ).toEqual({
      appKey: 'app-key',
      appSecret: 'secret-value',
      teamId: 'team-1',
      operatorStaffId: 'staff-1',
    });
    expect(
      knowledgeProviderConnectionSchema.safeParse({
        id: '00000000-0000-7000-8000-000000000001',
        provider: 'LEXIANG',
        status: 'ACTIVE',
        appKeyHint: 'app…key',
        teamId: 'team-1',
        operatorStaffId: 'staff-1',
        credentialsConfigured: true,
        lastHealthAt: null,
        lastHealthCode: null,
        appSecret: 'must-not-leak',
      }).success,
    ).toBe(false);
  });

  it('describes a sanitized, user-facing health check result', () => {
    expect(
      knowledgeProviderHealthCheckResponseSchema.parse({
        connection: {
          id: '00000000-0000-7000-8000-000000000001',
          provider: 'LEXIANG',
          status: 'ACTIVE',
          appKeyHint: 'lexi…-app',
          teamId: 'team-1',
          operatorStaffId: 'staff-1',
          credentialsConfigured: true,
          lastHealthAt: '2026-08-13T03:00:00.000Z',
          lastHealthCode: 'LEXIANG_TOKEN_OK',
        },
        reachable: true,
        checkedAt: '2026-08-13T03:00:00.000Z',
        message: '凭据有效，已成功连接腾讯乐享。',
      }).reachable,
    ).toBe(true);
  });

  it('discovers selectable teams and operators without exposing the secret', () => {
    expect(
      discoverLexiangConnectionRequestSchema.parse({
        appKey: 'app-key',
        appSecret: 'secret-value',
      }),
    ).toEqual({ appKey: 'app-key', appSecret: 'secret-value' });
    const result = lexiangConnectionDiscoveryResponseSchema.parse({
      teamStatus: 'AVAILABLE',
      operatorStatus: 'AVAILABLE',
      teams: [{ id: 'team-1', code: 'k10001', name: '产品团队' }],
      operators: [{ staffId: 'staff-1', name: '张三' }],
    });
    expect(result.teams[0]?.id).toBe('team-1');
    expect(JSON.stringify(result)).not.toContain('secret-value');
  });

  it('returns bounded counts for an existing-space synchronization', () => {
    expect(
      lexiangSpaceSyncResponseSchema.parse({
        discovered: 4,
        imported: 3,
        updated: 1,
        requiresPrivacyReview: 2,
        entriesDiscovered: 629,
        foldersSynchronized: 65,
        documentsDiscovered: 564,
        documentsImported: 564,
        documentsUpdated: 0,
        documentsArchived: 0,
      }),
    ).toEqual({
      discovered: 4,
      imported: 3,
      updated: 1,
      requiresPrivacyReview: 2,
      entriesDiscovered: 629,
      foldersSynchronized: 65,
      documentsDiscovered: 564,
      documentsImported: 564,
      documentsUpdated: 0,
      documentsArchived: 0,
    });
  });

  it('validates trusted user-to-staff bindings without accepting provider secrets', () => {
    const request = bindLexiangUserRequestSchema.parse({
      userId: '00000000-0000-7000-8000-000000000101',
      externalStaffId: 'staff-101',
    });
    expect(request.externalStaffId).toBe('staff-101');
    const response = knowledgeProviderUserBindingsResponseSchema.parse({
      bindings: [
        {
          userId: request.userId,
          displayName: '测试成员',
          externalStaffId: request.externalStaffId,
          status: 'ACTIVE',
          updatedAt: '2026-08-13T10:00:00.000Z',
        },
      ],
    });
    expect(response.bindings).toHaveLength(1);
    expect(JSON.stringify(response)).not.toContain('appSecret');
  });
});
