import {
  businessSemanticTraceResponseSchema,
  collaborationCandidateListSchema,
  collaborationCommandRequestSchema,
  collaborationDetailResponseSchema,
  collaborationListResponseSchema,
  correctionCaseListResponseSchema,
  correctionCaseSchema,
  correctionFeedbackRequestSchema,
  createCollaborationRequestSchema,
  deliverableSchema,
  employeeAcceptanceRequestInputSchema,
  employeeAcceptanceRequestSchema,
  employeeDeliverableSubmissionRequestSchema,
  employeeEvidenceContributionRequestSchema,
  employeeTaskExecutionSnapshotSchema,
  employeeTaskTransitionRequestSchema,
  evidenceSchema,
  taskSchema,
  workbenchObjectiveListResponseSchema,
  workbenchTaskListResponseSchema,
  type BusinessSemanticTraceResponse,
  type CollaborationCandidateList,
  type CollaborationCommandRequest,
  type CollaborationDetailResponse,
  type CollaborationListResponse,
  type CorrectionCase,
  type CorrectionCaseListResponse,
  type CorrectionFeedbackRequest,
  type CreateCollaborationRequest,
  type Deliverable,
  type EmployeeAcceptanceRequest,
  type EmployeeAcceptanceRequestInput,
  type EmployeeDeliverableSubmissionRequest,
  type EmployeeEvidenceContributionRequest,
  type EmployeeTaskExecutionSnapshot,
  type EmployeeTaskTransitionRequest,
  type Evidence,
  type Objective,
  type Task,
} from '@enterprise/contracts';
import { ApiClientError, apiRequest } from '../../shared/api/client';

export const workbenchApiPaths = {
  objectives: '/api/v1/workbench/objectives',
  tasks: '/api/v1/workbench/tasks',
  trace: (taskId: string) => `/api/v1/workbench/tasks/${encodeURIComponent(taskId)}/trace`,
  collaborations: (taskId: string, cursor?: string) =>
    withCursor(`/api/v1/workbench/tasks/${encodeURIComponent(taskId)}/collaborations`, cursor),
  collaborationCandidates: (taskId: string) =>
    `/api/v1/workbench/tasks/${encodeURIComponent(taskId)}/collaboration-candidates`,
  collaboration: (taskId: string, collaborationId: string) =>
    `/api/v1/workbench/tasks/${encodeURIComponent(taskId)}/collaborations/${encodeURIComponent(collaborationId)}`,
  collaborationCommands: (taskId: string, collaborationId: string) =>
    `/api/v1/workbench/tasks/${encodeURIComponent(taskId)}/collaborations/${encodeURIComponent(collaborationId)}/commands`,
  corrections: (taskId: string, cursor?: string) =>
    withCursor(`/api/v1/workbench/tasks/${encodeURIComponent(taskId)}/corrections`, cursor),
  correctionFeedback: (taskId: string, correctionId: string) =>
    `/api/v1/workbench/tasks/${encodeURIComponent(taskId)}/corrections/${encodeURIComponent(correctionId)}/feedback`,
  execution: (taskId: string) => `/api/v1/workbench/tasks/${encodeURIComponent(taskId)}/execution`,
  taskTransition: (taskId: string) =>
    `/api/v1/workbench/tasks/${encodeURIComponent(taskId)}/execution/task-transitions`,
  deliverableSubmission: (taskId: string, deliverableId: string) =>
    `/api/v1/workbench/tasks/${encodeURIComponent(taskId)}/execution/deliverables/${encodeURIComponent(deliverableId)}/submit`,
  evidenceContribution: (taskId: string) =>
    `/api/v1/workbench/tasks/${encodeURIComponent(taskId)}/execution/evidence`,
  acceptanceRequest: (taskId: string, deliverableId: string) =>
    `/api/v1/workbench/tasks/${encodeURIComponent(taskId)}/execution/deliverables/${encodeURIComponent(deliverableId)}/acceptance-requests`,
} as const;

function withCursor(path: string, cursor?: string): string {
  return cursor ? `${path}?cursor=${encodeURIComponent(cursor)}` : path;
}

export async function listWorkbenchObjectives(
  signal?: AbortSignal,
  apiBaseUrl?: string,
): Promise<Objective[]> {
  const response = await apiRequest(workbenchApiPaths.objectives, {
    schema: workbenchObjectiveListResponseSchema,
    ...(signal ? { signal } : {}),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });
  return response.items;
}

export async function listWorkbenchTasks(
  signal?: AbortSignal,
  apiBaseUrl?: string,
): Promise<Task[]> {
  const response = await apiRequest(workbenchApiPaths.tasks, {
    schema: workbenchTaskListResponseSchema,
    ...(signal ? { signal } : {}),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });
  return response.items;
}

export function getWorkbenchTaskTrace(
  taskId: string,
  signal?: AbortSignal,
  apiBaseUrl?: string,
): Promise<BusinessSemanticTraceResponse> {
  return apiRequest(workbenchApiPaths.trace(taskId), {
    schema: businessSemanticTraceResponseSchema,
    ...(signal ? { signal } : {}),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });
}

export async function listTaskCollaborations(
  taskId: string,
  signal?: AbortSignal,
  apiBaseUrl?: string,
  cursor?: string,
): Promise<CollaborationListResponse> {
  const response = await apiRequest(workbenchApiPaths.collaborations(taskId, cursor), {
    schema: collaborationListResponseSchema,
    ...(signal ? { signal } : {}),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });
  if (response.items.some((item) => item.taskId !== taskId)) {
    throw new ApiClientError('contract', '协同列表包含不属于当前任务的记录，已拒绝展示。');
  }
  return response;
}

export function listTaskCollaborationCandidates(
  taskId: string,
  signal?: AbortSignal,
  apiBaseUrl?: string,
): Promise<CollaborationCandidateList> {
  return apiRequest(workbenchApiPaths.collaborationCandidates(taskId), {
    schema: collaborationCandidateListSchema,
    ...(signal ? { signal } : {}),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });
}

export async function createTaskCollaboration(
  taskId: string,
  input: CreateCollaborationRequest,
  apiBaseUrl?: string,
): Promise<CollaborationDetailResponse> {
  const parsed = createCollaborationRequestSchema.parse(input);
  const response = await apiRequest(workbenchApiPaths.collaborations(taskId), {
    method: 'POST',
    body: parsed,
    schema: collaborationDetailResponseSchema,
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });
  if (
    response.collaboration.taskId !== taskId ||
    response.collaboration.status !== 'REQUESTED' ||
    response.messages.at(-1)?.type !== 'REQUEST'
  ) {
    throw new ApiClientError('contract', '协同创建响应未确认 REQUEST 状态，已拒绝显示成功。');
  }
  return response;
}

export async function getTaskCollaborationDetail(
  taskId: string,
  collaborationId: string,
  signal?: AbortSignal,
  apiBaseUrl?: string,
): Promise<CollaborationDetailResponse> {
  const response = await apiRequest(workbenchApiPaths.collaboration(taskId, collaborationId), {
    schema: collaborationDetailResponseSchema,
    ...(signal ? { signal } : {}),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });
  if (response.collaboration.id !== collaborationId || response.collaboration.taskId !== taskId) {
    throw new ApiClientError('contract', '协同详情与请求的任务或协同身份不一致，已拒绝展示。');
  }
  return response;
}

export async function submitTaskCollaborationCommand(
  taskId: string,
  collaborationId: string,
  input: CollaborationCommandRequest,
  apiBaseUrl?: string,
): Promise<CollaborationDetailResponse> {
  const parsed = collaborationCommandRequestSchema.parse(input);
  const response = await apiRequest(
    workbenchApiPaths.collaborationCommands(taskId, collaborationId),
    {
      method: 'POST',
      body: parsed,
      schema: collaborationDetailResponseSchema,
      ...(apiBaseUrl ? { apiBaseUrl } : {}),
    },
  );
  const expectedStatus: Record<
    CollaborationCommandRequest['type'],
    CollaborationDetailResponse['collaboration']['status']
  > = {
    COMMIT: 'COMMITTED',
    DELIVER: 'DELIVERED',
    ACCEPT: 'ACCEPTED',
    REJECT: 'REJECTED',
    ESCALATE: 'ESCALATED',
    CANCEL: 'CANCELLED',
  };
  if (
    response.collaboration.id !== collaborationId ||
    response.collaboration.taskId !== taskId ||
    response.collaboration.revision <= parsed.expectedRevision ||
    response.collaboration.status !== expectedStatus[parsed.type] ||
    response.messages.at(-1)?.type !== parsed.type
  ) {
    throw new ApiClientError(
      'contract',
      '协同命令响应未确认预期状态、新 revision 或消息类型，已拒绝显示成功。',
    );
  }
  return response;
}

export async function listTaskCorrections(
  taskId: string,
  signal?: AbortSignal,
  apiBaseUrl?: string,
  cursor?: string,
): Promise<CorrectionCaseListResponse> {
  const response = await apiRequest(workbenchApiPaths.corrections(taskId, cursor), {
    schema: correctionCaseListResponseSchema,
    ...(signal ? { signal } : {}),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });
  if (response.items.some((item) => item.taskId !== taskId)) {
    throw new ApiClientError('contract', '纠偏列表包含不属于当前任务的记录，已拒绝展示。');
  }
  return response;
}

export async function submitTaskCorrectionFeedback(
  taskId: string,
  correctionId: string,
  input: CorrectionFeedbackRequest,
  apiBaseUrl?: string,
): Promise<CorrectionCase> {
  const response = await apiRequest(workbenchApiPaths.correctionFeedback(taskId, correctionId), {
    method: 'POST',
    body: correctionFeedbackRequestSchema.parse(input),
    schema: correctionCaseSchema,
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });
  if (response.id !== correctionId || response.taskId !== taskId) {
    throw new ApiClientError('contract', '纠偏反馈响应与请求身份不一致，已拒绝更新本地状态。');
  }
  const expectedStatus: Record<CorrectionFeedbackRequest['action'], CorrectionCase['status']> = {
    ACKNOWLEDGE: 'ACKNOWLEDGED',
    ACCEPT: 'ACCEPTED',
    REJECT: 'REJECTED',
    EXPLAIN: 'EXPLAINED',
    ESCALATE: 'ESCALATED',
    RESOLVE: 'RESOLVED',
    CANCEL: 'CANCELLED',
  };
  if (
    response.revision <= input.expectedRevision ||
    response.status !== expectedStatus[input.action]
  ) {
    throw new ApiClientError(
      'contract',
      '纠偏反馈响应未确认预期状态或新 revision，已拒绝显示成功。',
    );
  }
  return response;
}

export async function getEmployeeTaskExecution(
  taskId: string,
  signal?: AbortSignal,
  apiBaseUrl?: string,
): Promise<EmployeeTaskExecutionSnapshot> {
  const response = await apiRequest(workbenchApiPaths.execution(taskId), {
    schema: employeeTaskExecutionSnapshotSchema,
    ...(signal ? { signal } : {}),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });
  if (response.task.id !== taskId) {
    throw new ApiClientError('contract', '任务执行快照与请求的任务身份不一致，已拒绝展示。');
  }
  return response;
}

export async function transitionEmployeeTask(
  taskId: string,
  input: EmployeeTaskTransitionRequest,
  apiBaseUrl?: string,
): Promise<Task> {
  const parsed = employeeTaskTransitionRequestSchema.parse(input);
  const response = await apiRequest(workbenchApiPaths.taskTransition(taskId), {
    method: 'POST',
    body: parsed,
    schema: taskSchema,
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });
  const expectedStatus: Record<EmployeeTaskTransitionRequest['action'], Task['status']> = {
    START: 'IN_PROGRESS',
    BLOCK: 'BLOCKED',
    UNBLOCK: 'IN_PROGRESS',
    DELIVER: 'DELIVERED',
  };
  if (
    response.id !== taskId ||
    response.revision <= parsed.expectedRevision ||
    response.status !== expectedStatus[parsed.action]
  ) {
    throw new ApiClientError(
      'contract',
      '任务状态响应未确认预期状态或新 revision，已拒绝显示成功。',
    );
  }
  return response;
}

export async function submitEmployeeDeliverable(
  taskId: string,
  deliverableId: string,
  input: EmployeeDeliverableSubmissionRequest,
  apiBaseUrl?: string,
): Promise<Deliverable> {
  const parsed = employeeDeliverableSubmissionRequestSchema.parse(input);
  const response = await apiRequest(
    workbenchApiPaths.deliverableSubmission(taskId, deliverableId),
    {
      method: 'POST',
      body: parsed,
      schema: deliverableSchema,
      ...(apiBaseUrl ? { apiBaseUrl } : {}),
    },
  );
  if (
    response.id !== deliverableId ||
    response.taskId !== taskId ||
    response.revision <= parsed.expectedRevision ||
    response.status !== 'SUBMITTED'
  ) {
    throw new ApiClientError('contract', '交付物响应未确认提交状态或新 revision，已拒绝显示成功。');
  }
  return response;
}

export async function contributeEmployeeEvidence(
  taskId: string,
  input: EmployeeEvidenceContributionRequest,
  apiBaseUrl?: string,
): Promise<Evidence> {
  const parsed = employeeEvidenceContributionRequestSchema.parse(input);
  const response = await apiRequest(workbenchApiPaths.evidenceContribution(taskId), {
    method: 'POST',
    body: parsed,
    schema: evidenceSchema,
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });
  if (
    response.code !== parsed.code ||
    response.sourceSystem !== parsed.sourceSystem ||
    response.sourceRecordId !== parsed.sourceRecordId ||
    response.status !== 'DRAFT' ||
    response.trustLevel !== 'UNVERIFIED'
  ) {
    throw new ApiClientError('contract', '证据响应未确认草稿和待核验状态，已拒绝显示成功。');
  }
  return response;
}

export async function requestEmployeeAcceptance(
  taskId: string,
  deliverableId: string,
  input: EmployeeAcceptanceRequestInput,
  apiBaseUrl?: string,
): Promise<EmployeeAcceptanceRequest> {
  const parsed = employeeAcceptanceRequestInputSchema.parse(input);
  const response = await apiRequest(workbenchApiPaths.acceptanceRequest(taskId, deliverableId), {
    method: 'POST',
    body: parsed,
    schema: employeeAcceptanceRequestSchema,
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });
  if (
    response.taskId !== taskId ||
    response.deliverableId !== deliverableId ||
    response.status !== 'REQUESTED'
  ) {
    throw new ApiClientError('contract', '验收申请响应与当前交付物不一致，已拒绝显示成功。');
  }
  return response;
}
