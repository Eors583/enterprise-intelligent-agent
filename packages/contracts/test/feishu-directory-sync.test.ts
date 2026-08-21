import { describe, expect, it } from 'vitest';

import {
  applyFeishuDirectoryPreviewRequestSchema,
  feishuDirectoryPreviewSchema,
  feishuDirectorySyncRunDetailSchema,
} from '../src/admin.js';

describe('Feishu directory synchronization contracts', () => {
  it('requires an explicit preview and caller idempotency key before apply', () => {
    expect(
      applyFeishuDirectoryPreviewRequestSchema.parse({
        previewId: '00000000-0000-7000-8000-000000000101',
        idempotencyKey: 'feishu-preview-101',
      }),
    ).toEqual({
      previewId: '00000000-0000-7000-8000-000000000101',
      idempotencyKey: 'feishu-preview-101',
    });
    expect(
      applyFeishuDirectoryPreviewRequestSchema.safeParse({
        previewId: '00000000-0000-7000-8000-000000000101',
        idempotencyKey: 'short',
      }).success,
    ).toBe(false);
  });

  it('retains record-level diagnostics and durable run lifecycle state', () => {
    const preview = feishuDirectoryPreviewSchema.parse({
      id: '00000000-0000-7000-8000-000000000101',
      status: 'READY',
      snapshotCursor: 'a'.repeat(64),
      summary: {
        created: 1,
        updated: 0,
        archived: 0,
        deactivated: 0,
        conflicts: 0,
        unchanged: 2,
      },
      expiresAt: '2026-07-28T08:30:00.000Z',
      appliedAt: null,
      createdAt: '2026-07-28T08:15:00.000Z',
      items: [
        {
          id: '00000000-0000-7000-8000-000000000102',
          sequence: 0,
          entityType: 'MEMBER',
          action: 'CREATE',
          externalId: 'ou_101',
          displayName: '测试成员',
          localResourceType: null,
          localResourceId: null,
          fieldChanges: { displayName: { before: null, after: '测试成员' } },
          diagnosticCode: null,
          applyStatus: 'PENDING',
        },
      ],
    });
    expect(preview.items[0]?.externalId).toBe('ou_101');
    expect(
      feishuDirectorySyncRunDetailSchema.parse({
        id: '00000000-0000-7000-8000-000000000103',
        previewId: preview.id,
        status: 'DEAD_LETTER',
        attempts: 4,
        maxAttempts: 4,
        expectedSnapshotCursor: preview.snapshotCursor,
        lastErrorCode: 'FEISHU_TIMEOUT',
        summary: null,
        startedAt: '2026-07-28T08:16:00.000Z',
        finishedAt: '2026-07-28T08:20:00.000Z',
        createdAt: '2026-07-28T08:15:30.000Z',
      }).status,
    ).toBe('DEAD_LETTER');
  });
});
