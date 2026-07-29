import type { AdminAgent } from '@enterprise/contracts';

export function agentConfigurationStatusLabel(status: AdminAgent['status']): string {
  return {
    ONLINE: '配置已启用',
    OFFLINE: '配置已离线',
    DISABLED: '配置已停用',
  }[status];
}
