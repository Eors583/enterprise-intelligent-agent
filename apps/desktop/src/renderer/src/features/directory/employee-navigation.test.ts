import { describe, expect, it } from 'vitest';

import {
  buildEmployeeNavigation,
  employeeSectionForLegacyId,
  initialEmployeeSection,
} from './employee-navigation';

describe('employee information architecture', () => {
  const serverNavigation = [
    { id: 'growth', label: '我的成长' },
    { id: 'home', label: '首页' },
    { id: 'messages', label: '消息' },
    { id: 'contacts', label: '通讯录' },
    { id: 'agents', label: '智能体' },
    { id: 'roles', label: '我的角色' },
    { id: 'workbench', label: '目标与任务' },
    { id: 'memories', label: '我的记忆' },
    { id: 'experience-usage', label: '经验与用量' },
  ];

  it('collapses legacy entries into four stable employee tasks', () => {
    expect(buildEmployeeNavigation(serverNavigation)).toEqual([
      { id: 'workbench', label: '工作台' },
      { id: 'messages', label: '消息' },
      { id: 'directory', label: '通讯录' },
      { id: 'my', label: '我的' },
    ]);
  });

  it('keeps old deep links compatible without restoring hidden primary entries', () => {
    expect(employeeSectionForLegacyId('#agents')).toBe('messages');
    expect(employeeSectionForLegacyId('#memories')).toBe('my');
    expect(employeeSectionForLegacyId('#growth')).toBe('my');
    expect(employeeSectionForLegacyId('#objective-tasks')).toBe('workbench');
  });

  it('falls back to an authorized section and always retains account self-service', () => {
    const navigation = buildEmployeeNavigation([{ id: 'contacts', label: '通讯录' }]);
    expect(navigation).toEqual([
      { id: 'directory', label: '通讯录' },
      { id: 'my', label: '我的' },
    ]);
    expect(initialEmployeeSection('#agents', navigation)).toBe('directory');
  });
});
