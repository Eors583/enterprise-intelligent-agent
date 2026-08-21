import { describe, expect, it } from 'vitest';

import {
  buildFeishuApplyIdempotencyKey,
  feishuSyncStatusLabel,
  isFeishuRetryableTerminalRun,
  nextSiblingSortOrder,
  summarizeFeishuFieldChanges,
} from './OrganizationPage';

const PREVIEW_ID = '00000000-0000-7000-8000-000000000101';
const RUN_ID = '00000000-0000-7000-8000-000000000102';

describe('Feishu synchronization view policy', () => {
  it('keeps the initial request idempotent and derives a new deterministic key for DLQ retry', () => {
    expect(buildFeishuApplyIdempotencyKey(PREVIEW_ID, null)).toBe(`admin-${PREVIEW_ID}`);
    expect(
      buildFeishuApplyIdempotencyKey(PREVIEW_ID, {
        id: RUN_ID,
        previewId: PREVIEW_ID,
        status: 'DEAD_LETTER',
      }),
    ).toBe(`admin-${PREVIEW_ID}-retry-${RUN_ID}`);
    expect(
      isFeishuRetryableTerminalRun({ previewId: PREVIEW_ID, status: 'DEAD_LETTER' }, PREVIEW_ID),
    ).toBe(true);
  });

  it('does not create a retry identity for an active or unrelated run', () => {
    expect(
      buildFeishuApplyIdempotencyKey(PREVIEW_ID, {
        id: RUN_ID,
        previewId: PREVIEW_ID,
        status: 'RUNNING',
      }),
    ).toBe(`admin-${PREVIEW_ID}`);
    expect(
      isFeishuRetryableTerminalRun(
        {
          previewId: '00000000-0000-7000-8000-000000000999',
          status: 'FAILED',
        },
        PREVIEW_ID,
      ),
    ).toBe(false);
  });

  it('makes rename, transfer and employment mapping changes diagnosable', () => {
    expect(
      summarizeFeishuFieldChanges({
        name: { before: '旧名', after: '新名' },
        departments: { before: ['od-old'], after: ['od-new'] },
        primaryDepartment: { before: 'od-old', after: 'od-new' },
        jobTitle: { before: '旧岗位', after: '新岗位' },
      }),
    ).toContain('所属部门/调岗');
    expect(
      summarizeFeishuFieldChanges({
        name: { before: '旧名', after: '新名' },
        departments: { before: ['od-old'], after: ['od-new'] },
      }),
    ).toContain('名称');
  });

  it('distinguishes verified credentials from an actually completed synchronization', () => {
    expect(feishuSyncStatusLabel('NOT_CONFIGURED')).toBe('未配置');
    expect(feishuSyncStatusLabel('READY')).toBe('已配置（尚未同步）');
    expect(feishuSyncStatusLabel('SUCCEEDED')).toBe('最近一次同步成功');
  });

  it('places a new department at the end of the selected sibling group', () => {
    const units = [
      { id: 'one', parentId: null, sortOrder: 2 },
      { id: 'two', parentId: null, sortOrder: 8 },
      { id: 'child', parentId: 'one', sortOrder: 20 },
    ];
    expect(nextSiblingSortOrder(units, null)).toBe(9);
    expect(nextSiblingSortOrder(units, 'one')).toBe(21);
    expect(nextSiblingSortOrder(units, 'missing')).toBe(0);
  });
});
