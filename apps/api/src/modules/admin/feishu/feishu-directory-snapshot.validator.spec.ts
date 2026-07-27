import { describe, expect, it } from 'vitest';

import {
  InvalidFeishuSnapshotError,
  validateFeishuDirectorySnapshot,
} from './feishu-directory-snapshot.validator.js';

describe('validateFeishuDirectorySnapshot', () => {
  it('orders parents before children without changing users', () => {
    const users = [
      {
        externalId: 'user-1',
        name: '成员一',
        active: true,
        departmentExternalIds: ['child'],
      },
    ];
    const result = validateFeishuDirectorySnapshot({
      departments: [
        { externalId: 'child', name: '子部门', parentExternalId: 'parent' },
        { externalId: 'parent', name: '父部门', parentExternalId: '0' },
      ],
      users,
    });
    expect(result.departments.map((item) => item.externalId)).toEqual(['parent', 'child']);
    expect(result.users).toBe(users);
  });

  it('rejects cycles with a stable error code', () => {
    expect(() =>
      validateFeishuDirectorySnapshot({
        departments: [
          { externalId: 'a', name: 'A', parentExternalId: 'b' },
          { externalId: 'b', name: 'B', parentExternalId: 'a' },
        ],
        users: [],
      }),
    ).toThrowError(new InvalidFeishuSnapshotError('DEPARTMENT_CYCLE'));
  });

  it('rejects users that reference a missing department', () => {
    expect(() =>
      validateFeishuDirectorySnapshot({
        departments: [],
        users: [
          {
            externalId: 'user-1',
            name: '成员一',
            active: true,
            departmentExternalIds: ['missing'],
          },
        ],
      }),
    ).toThrowError(new InvalidFeishuSnapshotError('USER_DEPARTMENT_MISSING'));
  });
});
