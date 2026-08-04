import { describe, expect, it } from 'vitest';

import { buildGuidedEvidenceRequest } from './evidence-admin.service.js';

const USER_ID = '00000000-0000-7000-8000-000000000001';

describe('guided Evidence registration', () => {
  it('derives technical identity, hash, ownership and validity from business fields', () => {
    const command = {
      sourceType: 'DOCUMENT' as const,
      sourceName: '2026 年客户服务复盘',
      sourceUri: 'https://knowledge.example.local/reviews/customer-service',
      observedAt: '2026-07-30T08:00:00.000Z',
      summary: '复盘确认客户响应时间缩短，并保留原始服务记录作为来源。',
      trustLevel: 'MEDIUM' as const,
      retentionDays: 365,
    };

    const first = buildGuidedEvidenceRequest(command, USER_ID);
    const replay = buildGuidedEvidenceRequest(command, USER_ID);

    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      sourceType: 'DOCUMENT',
      sourceSystem: 'SYSTEM.DOCUMENT',
      sourceRecordId: '2026 年客户服务复盘',
      sourceVersion: '1',
      contentHashAlgorithm: 'SHA256',
      trustLevel: 'MEDIUM',
      confidence: 0.65,
      owner: { type: 'USER', id: USER_ID },
      permissionLabels: [],
      effectiveFrom: command.observedAt,
      effectiveTo: '2027-07-30T08:00:00.000Z',
      verifiedBy: null,
      verifiedAt: null,
    });
    expect(first.code).toMatch(/^EVIDENCE\.[A-F0-9]{20}$/);
    expect(first.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('changes the generated identity when the business evidence changes', () => {
    const base = {
      sourceType: 'HUMAN_ATTESTATION' as const,
      sourceName: '客户成功负责人确认',
      sourceUri: null,
      observedAt: '2026-07-30T08:00:00.000Z',
      summary: '负责人确认本月回访已全部完成。',
      trustLevel: 'UNVERIFIED' as const,
      retentionDays: null,
    };

    const original = buildGuidedEvidenceRequest(base, USER_ID);
    const changed = buildGuidedEvidenceRequest(
      { ...base, summary: '负责人确认本月回访已完成，并附带回访清单。' },
      USER_ID,
    );

    expect(original.code).not.toBe(changed.code);
    expect(original.contentHash).not.toBe(changed.contentHash);
    expect(original.effectiveTo).toBeNull();
  });
});
