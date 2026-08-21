import {
  type AuditEventListQuery,
  type AuditEventListResponse,
  type AuditExportResponse,
  type AuditIntegrityResponse,
  type CreateAuditExportRequest,
  auditEventListResponseSchema,
  auditExportResponseSchema,
  auditIntegrityResponseSchema,
} from '@enterprise/contracts';

import { request } from '@/api/client';

export function listAuditEvents(
  query: AuditEventListQuery,
  signal?: AbortSignal,
): Promise<AuditEventListResponse> {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) parameters.set(key, String(value));
  }
  const suffix = parameters.size === 0 ? '' : `?${parameters.toString()}`;
  return request(`/admin/audit/events${suffix}`, {
    schema: auditEventListResponseSchema,
    ...(signal === undefined ? {} : { signal }),
  });
}

export function verifyAuditIntegrity(signal?: AbortSignal): Promise<AuditIntegrityResponse> {
  return request('/admin/audit/integrity', {
    schema: auditIntegrityResponseSchema,
    ...(signal === undefined ? {} : { signal }),
  });
}

export function createAuditExport(input: CreateAuditExportRequest): Promise<AuditExportResponse> {
  return request('/admin/audit/exports', {
    method: 'POST',
    body: input,
    schema: auditExportResponseSchema,
  });
}
