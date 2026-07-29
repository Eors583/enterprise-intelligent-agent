import { adminOverviewResponseSchema, type AdminOverviewResponse } from '@enterprise/contracts';

import { request } from '@/api/client';

export function loadAdminOverview(signal?: AbortSignal): Promise<AdminOverviewResponse> {
  return request('/admin/overview', {
    schema: adminOverviewResponseSchema,
    ...(signal === undefined ? {} : { signal }),
  });
}
