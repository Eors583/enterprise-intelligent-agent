import {
  businessEventDetailResponseSchema,
  businessEventDeliverySchema,
  businessEventListResponseSchema,
  processCommandSchema,
  processInstanceDetailResponseSchema,
  processInstanceListResponseSchema,
  processInstanceSchema,
  processStepCommandSchema,
  processStepInstanceSchema,
  replayBusinessEventDeliveryRequestSchema,
  type BusinessEventDelivery,
  type BusinessEventDetailResponse,
  type BusinessEventListResponse,
  type ProcessCommand,
  type ProcessInstance,
  type ProcessInstanceDetailResponse,
  type ProcessInstanceListResponse,
  type ProcessStepCommand,
  type ProcessStepInstance,
} from '@enterprise/contracts';
import { z } from 'zod';

import { ApiError, request } from '@/api/client';

const PROCESS_ROOT = '/admin/process-runtime';
const EVENT_ROOT = '/admin/business-events';

export const runtimeGovernanceApiPaths = {
  processInstances: (cursor?: string) => withCursor(`${PROCESS_ROOT}/instances`, cursor),
  processInstance: (instanceId: string) =>
    `${PROCESS_ROOT}/instances/${encodeURIComponent(instanceId)}`,
  processCommands: (instanceId: string) =>
    `${PROCESS_ROOT}/instances/${encodeURIComponent(instanceId)}/commands`,
  processStepCommands: (instanceId: string, stepId: string) =>
    `${PROCESS_ROOT}/instances/${encodeURIComponent(instanceId)}/steps/${encodeURIComponent(stepId)}/commands`,
  businessEvents: (cursor?: string) => withCursor(`${EVENT_ROOT}/events`, cursor),
  businessEvent: (eventId: string) => `${EVENT_ROOT}/events/${encodeURIComponent(eventId)}`,
  replayDelivery: (deliveryId: string) =>
    `${EVENT_ROOT}/deliveries/${encodeURIComponent(deliveryId)}/replay`,
} as const;

function withCursor(path: string, cursor?: string): string {
  return cursor ? `${path}?cursor=${encodeURIComponent(cursor)}` : path;
}

export function listProcessInstances(
  signal?: AbortSignal,
  cursor?: string,
): Promise<ProcessInstanceListResponse> {
  return request(runtimeGovernanceApiPaths.processInstances(cursor), {
    schema: processInstanceListResponseSchema,
    ...(signal ? { signal } : {}),
  });
}

export async function getProcessInstanceDetail(
  instanceId: string,
  signal?: AbortSignal,
): Promise<ProcessInstanceDetailResponse> {
  const response = await request(runtimeGovernanceApiPaths.processInstance(instanceId), {
    schema: processInstanceDetailResponseSchema,
    ...(signal ? { signal } : {}),
  });
  if (response.instance.id !== instanceId) {
    throw new ApiError('流程实例详情与请求身份不一致，已拒绝展示。');
  }
  return response;
}

export async function sendProcessCommand(
  instanceId: string,
  input: ProcessCommand,
): Promise<ProcessInstance> {
  const response = await request(runtimeGovernanceApiPaths.processCommands(instanceId), {
    method: 'POST',
    body: processCommandSchema.parse(input),
    schema: processInstanceSchema,
  });
  if (response.id !== instanceId || response.revision <= input.expectedRevision) {
    throw new ApiError('流程命令响应未确认请求实例的新 revision，已拒绝显示成功。');
  }
  return response;
}

export async function sendProcessStepCommand(
  instanceId: string,
  stepId: string,
  input: ProcessStepCommand,
): Promise<ProcessStepInstance> {
  const response = await request(
    runtimeGovernanceApiPaths.processStepCommands(instanceId, stepId),
    {
      method: 'POST',
      body: processStepCommandSchema.parse(input),
      schema: processStepInstanceSchema,
    },
  );
  if (
    response.id !== stepId ||
    response.processInstanceId !== instanceId ||
    response.revision <= input.expectedRevision
  ) {
    throw new ApiError('步骤命令响应未确认请求步骤的新 revision，已拒绝显示成功。');
  }
  return response;
}

export function listBusinessEvents(
  signal?: AbortSignal,
  cursor?: string,
): Promise<BusinessEventListResponse> {
  return request(runtimeGovernanceApiPaths.businessEvents(cursor), {
    schema: businessEventListResponseSchema,
    ...(signal ? { signal } : {}),
  });
}

export async function getBusinessEventDetail(
  eventId: string,
  signal?: AbortSignal,
): Promise<BusinessEventDetailResponse> {
  const response = await request(runtimeGovernanceApiPaths.businessEvent(eventId), {
    schema: businessEventDetailResponseSchema,
    ...(signal ? { signal } : {}),
  });
  if (response.event.eventId !== eventId) {
    throw new ApiError('业务事件详情与请求身份不一致，已拒绝展示。');
  }
  return response;
}

export async function replayEventDelivery(
  deliveryId: string,
  input: z.input<typeof replayBusinessEventDeliveryRequestSchema>,
): Promise<BusinessEventDelivery> {
  const response = await request(runtimeGovernanceApiPaths.replayDelivery(deliveryId), {
    method: 'POST',
    body: replayBusinessEventDeliveryRequestSchema.parse(input),
    schema: businessEventDeliverySchema,
  });
  if (response.id !== deliveryId) {
    throw new ApiError('投递重放响应与请求身份不一致，已拒绝显示成功。');
  }
  return response;
}
