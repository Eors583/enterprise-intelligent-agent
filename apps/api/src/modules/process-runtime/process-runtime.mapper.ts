import { ConflictException } from '@nestjs/common';
import {
  processInstanceDetailResponseSchema,
  processInstanceListResponseSchema,
  processInstanceSchema,
  processStepInstanceSchema,
  type ProcessInstance,
  type ProcessInstanceDetailResponse,
  type ProcessInstanceListResponse,
  type ProcessStepInstance,
} from '@enterprise/contracts';

import type { RuntimeCursorPage } from '../process-orchestration/application/runtime-mutation-result.js';

export function mapProcessInstancePage(
  tenantId: string,
  page: RuntimeCursorPage<ProcessInstance>,
): ProcessInstanceListResponse {
  return parseRuntimeContract(
    processInstanceListResponseSchema,
    {
      items: page.items,
      pageInfo: {
        nextCursor: page.nextCursor,
        hasMore: page.nextCursor !== null,
      },
    },
    'Process Instance list',
    (response) => response.items.every((item) => item.tenantId === tenantId),
  );
}

export function mapProcessInstanceDetail(
  tenantId: string,
  processInstanceId: string,
  value: ProcessInstanceDetailResponse,
): ProcessInstanceDetailResponse {
  return parseRuntimeContract(
    processInstanceDetailResponseSchema,
    value,
    'Process Instance detail',
    (response) =>
      response.instance.tenantId === tenantId &&
      response.instance.id === processInstanceId &&
      response.steps.every((step) => step.tenantId === tenantId),
  );
}

export function mapProcessInstanceMutation(
  tenantId: string,
  processInstanceId: string,
  expectedRevision: number,
  value: ProcessInstance,
): ProcessInstance {
  return parseRuntimeContract(
    processInstanceSchema,
    value,
    'Process Instance command result',
    (response) =>
      response.tenantId === tenantId &&
      response.id === processInstanceId &&
      response.revision > expectedRevision,
  );
}

export function mapProcessStepMutation(
  tenantId: string,
  processInstanceId: string,
  stepInstanceId: string,
  expectedRevision: number,
  value: ProcessStepInstance,
): ProcessStepInstance {
  return parseRuntimeContract(
    processStepInstanceSchema,
    value,
    'Process Step command result',
    (response) =>
      response.tenantId === tenantId &&
      response.processInstanceId === processInstanceId &&
      response.id === stepInstanceId &&
      response.revision > expectedRevision,
  );
}

interface ContractSchema<T> {
  safeParse(
    value: unknown,
  ): { readonly success: true; readonly data: T } | { readonly success: false };
}

function parseRuntimeContract<T>(
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
