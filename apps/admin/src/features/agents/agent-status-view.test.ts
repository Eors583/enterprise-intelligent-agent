import { describe, expect, it } from 'vitest';

import { agentConfigurationStatusLabel } from './agent-status-view';

describe('agent configuration status labels', () => {
  it('never presents configuration lifecycle as provider availability', () => {
    expect(agentConfigurationStatusLabel('ONLINE')).toBe('配置已启用');
    expect(agentConfigurationStatusLabel('OFFLINE')).toBe('配置已离线');
    expect(agentConfigurationStatusLabel('DISABLED')).toBe('配置已停用');
    expect(agentConfigurationStatusLabel('ONLINE')).not.toContain('在线');
  });
});
