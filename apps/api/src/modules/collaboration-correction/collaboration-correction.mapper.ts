import { ConflictException } from '@nestjs/common';
import {
  collaborationDetailResponseSchema,
  collaborationListResponseSchema,
  correctionCaseListResponseSchema,
  correctionCaseSchema,
  type Collaboration,
  type CollaborationDetailResponse,
  type CollaborationListResponse,
  type CorrectionCase,
  type CorrectionCaseListResponse,
} from '@enterprise/contracts';

import type { RuntimeCursorPage } from '../process-orchestration/application/runtime-mutation-result.js';

export function mapCollaborationPage(
  tenantId: string,
  taskId: string,
  managementBypass: boolean,
  allowedPermissionLabelScopes: readonly (readonly string[])[],
  page: RuntimeCursorPage<Collaboration>,
): CollaborationListResponse {
  return parseCollaborationContract(
    collaborationListResponseSchema,
    {
      items: page.items,
      pageInfo: {
        nextCursor: page.nextCursor,
        hasMore: page.nextCursor !== null,
      },
    },
    'Collaboration list',
    (response) =>
      response.items.every(
        (item) =>
          item.tenantId === tenantId &&
          item.taskId === taskId &&
          (managementBypass || labelsAllowed(item.permissionLabels, allowedPermissionLabelScopes)),
      ),
  );
}

export function mapCollaborationDetail(
  tenantId: string,
  taskId: string,
  collaborationId: string,
  managementBypass: boolean,
  allowedPermissionLabelScopes: readonly (readonly string[])[],
  value: CollaborationDetailResponse,
): CollaborationDetailResponse {
  return parseCollaborationContract(
    collaborationDetailResponseSchema,
    value,
    'Collaboration detail',
    (response) =>
      response.collaboration.tenantId === tenantId &&
      response.collaboration.taskId === taskId &&
      response.collaboration.id === collaborationId &&
      (managementBypass ||
        labelsAllowed(response.collaboration.permissionLabels, allowedPermissionLabelScopes)) &&
      response.messages.every(
        (message) =>
          message.tenantId === tenantId &&
          message.taskId === taskId &&
          (managementBypass ||
            labelsAllowed(message.permissionLabels, allowedPermissionLabelScopes)),
      ),
  );
}

export function mapCorrectionPage(
  tenantId: string,
  taskId: string,
  managementBypass: boolean,
  allowedPermissionLabelScopes: readonly (readonly string[])[],
  page: RuntimeCursorPage<CorrectionCase>,
): CorrectionCaseListResponse {
  return parseCollaborationContract(
    correctionCaseListResponseSchema,
    {
      items: page.items,
      pageInfo: {
        nextCursor: page.nextCursor,
        hasMore: page.nextCursor !== null,
      },
    },
    'Correction Case list',
    (response) =>
      response.items.every(
        (item) =>
          item.tenantId === tenantId &&
          item.taskId === taskId &&
          (managementBypass || labelsAllowed(item.permissionLabels, allowedPermissionLabelScopes)),
      ),
  );
}

export function mapCorrectionRecord(
  tenantId: string,
  taskId: string,
  correctionId: string,
  managementBypass: boolean,
  allowedPermissionLabelScopes: readonly (readonly string[])[],
  value: CorrectionCase,
): CorrectionCase {
  return parseCollaborationContract(
    correctionCaseSchema,
    value,
    'Correction Case',
    (response) =>
      response.tenantId === tenantId &&
      response.taskId === taskId &&
      response.id === correctionId &&
      (managementBypass || labelsAllowed(response.permissionLabels, allowedPermissionLabelScopes)),
  );
}

export function mapCorrectionFeedbackResult(
  tenantId: string,
  taskId: string,
  correctionId: string,
  managementBypass: boolean,
  allowedPermissionLabelScopes: readonly (readonly string[])[],
  expectedRevision: number,
  expectedStatus: CorrectionCase['status'],
  value: CorrectionCase,
): CorrectionCase {
  return parseCollaborationContract(
    correctionCaseSchema,
    value,
    'Correction feedback result',
    (response) =>
      response.tenantId === tenantId &&
      response.taskId === taskId &&
      response.id === correctionId &&
      (managementBypass ||
        labelsAllowed(response.permissionLabels, allowedPermissionLabelScopes)) &&
      response.revision > expectedRevision &&
      response.status === expectedStatus,
  );
}

function labelsAllowed(
  resourceLabels: readonly string[],
  allowedLabelScopes: readonly (readonly string[])[],
): boolean {
  return allowedLabelScopes.some((scope) => {
    const allowed = new Set(scope);
    return resourceLabels.every((label) => allowed.has(label));
  });
}

interface ContractSchema<T> {
  safeParse(
    value: unknown,
  ): { readonly success: true; readonly data: T } | { readonly success: false };
}

function parseCollaborationContract<T>(
  schema: ContractSchema<T>,
  value: unknown,
  resource: string,
  additionalInvariant: (parsed: T) => boolean,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success || !additionalInvariant(parsed.data)) {
    throw new ConflictException(
      `${resource} returned by the persistence adapter is structurally inconsistent.`,
    );
  }
  return parsed.data;
}
