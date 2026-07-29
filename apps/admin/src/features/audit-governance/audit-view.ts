import type { AuditEventRecord } from '@enterprise/contracts';

export function shortAuditHash(value: string | null): string {
  return value === null ? '创世记录' : `${value.slice(0, 10)}…${value.slice(-8)}`;
}

export function formatAuditDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(value));
}

export function eventSummary(event: AuditEventRecord): string {
  return `${event.action} · ${event.resourceType}`;
}

export function downloadAuditCsv(value: {
  readonly csv: string;
  readonly fileName: string;
  readonly type: string;
}): void {
  const blob = new Blob([value.csv], { type: value.type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = value.fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
