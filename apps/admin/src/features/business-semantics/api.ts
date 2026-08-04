import {
  acceptanceSchema,
  createAcceptanceRequestSchema,
  createDeliverableRequestSchema,
  createEvidenceGuidedRequestSchema,
  createEvidenceLinkRequestSchema,
  createEvidenceRequestSchema,
  createMetricDefinitionRequestSchema,
  createObjectiveRelationRequestSchema,
  createObjectiveRequestSchema,
  createStrategyRequestSchema,
  createTaskDependencyRequestSchema,
  createTaskRequestSchema,
  createValueDefinitionRequestSchema,
  createValueVersionRequestSchema,
  deliverableSchema,
  evidenceLinkSchema,
  evidenceSchema,
  metricDefinitionSchema,
  objectiveRelationSchema,
  objectiveSchema,
  processDefinitionSchema,
  processVersionSchema,
  strategySchema,
  taskDependencySchema,
  taskSchema,
  transitionAcceptanceRequestSchema,
  transitionDeliverableRequestSchema,
  transitionEvidenceLinkRequestSchema,
  transitionEvidenceRequestSchema,
  transitionMetricDefinitionRequestSchema,
  transitionObjectiveRelationRequestSchema,
  transitionObjectiveRequestSchema,
  transitionProcessVersionRequestSchema,
  transitionStrategyRequestSchema,
  transitionTaskDependencyRequestSchema,
  transitionTaskRequestSchema,
  transitionValueVersionRequestSchema,
  updateAcceptanceRequestSchema,
  updateDeliverableRequestSchema,
  updateEvidenceLinkRequestSchema,
  updateEvidenceRequestSchema,
  updateMetricDefinitionRequestSchema,
  updateObjectiveRelationRequestSchema,
  updateObjectiveRequestSchema,
  updateProcessDefinitionRequestSchema,
  updateProcessVersionRequestSchema,
  updateStrategyRequestSchema,
  updateTaskDependencyRequestSchema,
  updateTaskRequestSchema,
  updateValueDefinitionRequestSchema,
  updateValueVersionRequestSchema,
  valueDefinitionSchema,
  valueVersionSchema,
  type Acceptance,
  type CreateAcceptanceRequest,
  type CreateDeliverableRequest,
  type CreateEvidenceGuidedRequest,
  type CreateEvidenceLinkRequest,
  type CreateEvidenceRequest,
  type CreateMetricDefinitionRequest,
  type CreateObjectiveRelationRequest,
  type CreateObjectiveRequest,
  type CreateProcessDefinitionRequest,
  type CreateProcessVersionRequest,
  type CreateStrategyRequest,
  type CreateTaskDependencyRequest,
  type CreateTaskRequest,
  type CreateValueDefinitionRequest,
  type CreateValueVersionRequest,
  type Deliverable,
  type Evidence,
  type EvidenceLink,
  type MetricDefinition,
  type Objective,
  type ObjectiveRelation,
  type ProcessDefinition,
  type ProcessVersion,
  type Strategy,
  type Task,
  type TaskDependency,
  type TransitionAcceptanceRequest,
  type TransitionDeliverableRequest,
  type TransitionEvidenceLinkRequest,
  type TransitionEvidenceRequest,
  type TransitionMetricDefinitionRequest,
  type TransitionObjectiveRelationRequest,
  type TransitionObjectiveRequest,
  type TransitionProcessVersionRequest,
  type TransitionStrategyRequest,
  type TransitionTaskDependencyRequest,
  type TransitionTaskRequest,
  type TransitionValueVersionRequest,
  type UpdateAcceptanceRequest,
  type UpdateDeliverableRequest,
  type UpdateEvidenceLinkRequest,
  type UpdateEvidenceRequest,
  type UpdateMetricDefinitionRequest,
  type UpdateObjectiveRelationRequest,
  type UpdateObjectiveRequest,
  type UpdateProcessDefinitionRequest,
  type UpdateProcessVersionRequest,
  type UpdateStrategyRequest,
  type UpdateTaskDependencyRequest,
  type UpdateTaskRequest,
  type UpdateValueDefinitionRequest,
  type UpdateValueVersionRequest,
  type ValueDefinition,
  type ValueVersion,
  createProcessDefinitionRequestSchema,
  createProcessVersionRequestSchema,
} from '@enterprise/contracts';
import { z, type ZodType } from 'zod';

import { request } from '@/api/client';

const ROOT = '/admin/business-semantics';

function listItems<T>(path: string, itemSchema: ZodType<T>, signal?: AbortSignal): Promise<T[]> {
  return request(path, {
    schema: z.object({ items: z.array(itemSchema) }).strict(),
    ...(signal ? { signal } : {}),
  }).then((response) => response.items);
}

function itemPath(resource: string, id: string): string {
  return `${ROOT}/${resource}/${encodeURIComponent(id)}`;
}

export function listValueDefinitions(signal?: AbortSignal): Promise<ValueDefinition[]> {
  return listItems(`${ROOT}/values`, valueDefinitionSchema, signal);
}

export function createValueDefinition(
  input: CreateValueDefinitionRequest,
): Promise<ValueDefinition> {
  return request(`${ROOT}/values`, {
    method: 'POST',
    body: createValueDefinitionRequestSchema.parse(input),
    schema: valueDefinitionSchema,
  });
}

export function updateValueDefinition(
  id: string,
  input: UpdateValueDefinitionRequest,
): Promise<ValueDefinition> {
  return request(itemPath('values', id), {
    method: 'PATCH',
    body: updateValueDefinitionRequestSchema.parse(input),
    schema: valueDefinitionSchema,
  });
}

export function listValueVersions(
  valueDefinitionId: string,
  signal?: AbortSignal,
): Promise<ValueVersion[]> {
  return listItems(`${itemPath('values', valueDefinitionId)}/versions`, valueVersionSchema, signal);
}

export function createValueVersion(
  valueDefinitionId: string,
  input: CreateValueVersionRequest,
): Promise<ValueVersion> {
  return request(`${itemPath('values', valueDefinitionId)}/versions`, {
    method: 'POST',
    body: createValueVersionRequestSchema.parse(input),
    schema: valueVersionSchema,
  });
}

export function updateValueVersion(
  valueDefinitionId: string,
  versionId: string,
  input: UpdateValueVersionRequest,
): Promise<ValueVersion> {
  return request(
    `${itemPath('values', valueDefinitionId)}/versions/${encodeURIComponent(versionId)}`,
    {
      method: 'PATCH',
      body: updateValueVersionRequestSchema.parse(input),
      schema: valueVersionSchema,
    },
  );
}

export function transitionValueVersion(
  valueDefinitionId: string,
  versionId: string,
  input: TransitionValueVersionRequest,
): Promise<ValueVersion> {
  return request(
    `${itemPath('values', valueDefinitionId)}/versions/${encodeURIComponent(versionId)}/transition`,
    {
      method: 'POST',
      body: transitionValueVersionRequestSchema.parse(input),
      schema: valueVersionSchema,
    },
  );
}

export function listStrategies(signal?: AbortSignal): Promise<Strategy[]> {
  return listItems(`${ROOT}/strategies`, strategySchema, signal);
}

export function createStrategy(input: CreateStrategyRequest): Promise<Strategy> {
  return request(`${ROOT}/strategies`, {
    method: 'POST',
    body: createStrategyRequestSchema.parse(input),
    schema: strategySchema,
  });
}

export function updateStrategy(id: string, input: UpdateStrategyRequest): Promise<Strategy> {
  return request(itemPath('strategies', id), {
    method: 'PATCH',
    body: updateStrategyRequestSchema.parse(input),
    schema: strategySchema,
  });
}

export function transitionStrategy(
  id: string,
  input: TransitionStrategyRequest,
): Promise<Strategy> {
  return request(`${itemPath('strategies', id)}/transition`, {
    method: 'POST',
    body: transitionStrategyRequestSchema.parse(input),
    schema: strategySchema,
  });
}

export function listObjectives(signal?: AbortSignal): Promise<Objective[]> {
  return listItems(`${ROOT}/objectives`, objectiveSchema, signal);
}

export function createObjective(input: CreateObjectiveRequest): Promise<Objective> {
  return request(`${ROOT}/objectives`, {
    method: 'POST',
    body: createObjectiveRequestSchema.parse(input),
    schema: objectiveSchema,
  });
}

export function updateObjective(id: string, input: UpdateObjectiveRequest): Promise<Objective> {
  return request(itemPath('objectives', id), {
    method: 'PATCH',
    body: updateObjectiveRequestSchema.parse(input),
    schema: objectiveSchema,
  });
}

export function transitionObjective(
  id: string,
  input: TransitionObjectiveRequest,
): Promise<Objective> {
  return request(`${itemPath('objectives', id)}/transition`, {
    method: 'POST',
    body: transitionObjectiveRequestSchema.parse(input),
    schema: objectiveSchema,
  });
}

export function listObjectiveRelations(signal?: AbortSignal): Promise<ObjectiveRelation[]> {
  return listItems(`${ROOT}/objectives/relations`, objectiveRelationSchema, signal);
}

export function createObjectiveRelation(
  input: CreateObjectiveRelationRequest,
): Promise<ObjectiveRelation> {
  return request(`${ROOT}/objectives/relations`, {
    method: 'POST',
    body: createObjectiveRelationRequestSchema.parse(input),
    schema: objectiveRelationSchema,
  });
}

export function updateObjectiveRelation(
  id: string,
  input: UpdateObjectiveRelationRequest,
): Promise<ObjectiveRelation> {
  return request(`${ROOT}/objectives/relations/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: updateObjectiveRelationRequestSchema.parse(input),
    schema: objectiveRelationSchema,
  });
}

export function transitionObjectiveRelation(
  id: string,
  input: TransitionObjectiveRelationRequest,
): Promise<ObjectiveRelation> {
  return request(`${ROOT}/objectives/relations/${encodeURIComponent(id)}/transition`, {
    method: 'POST',
    body: transitionObjectiveRelationRequestSchema.parse(input),
    schema: objectiveRelationSchema,
  });
}

export function listMetricDefinitions(signal?: AbortSignal): Promise<MetricDefinition[]> {
  return listItems(`${ROOT}/metrics`, metricDefinitionSchema, signal);
}

export function createMetricDefinition(
  input: CreateMetricDefinitionRequest,
): Promise<MetricDefinition> {
  return request(`${ROOT}/metrics`, {
    method: 'POST',
    body: createMetricDefinitionRequestSchema.parse(input),
    schema: metricDefinitionSchema,
  });
}

export function updateMetricDefinition(
  id: string,
  input: UpdateMetricDefinitionRequest,
): Promise<MetricDefinition> {
  return request(itemPath('metrics', id), {
    method: 'PATCH',
    body: updateMetricDefinitionRequestSchema.parse(input),
    schema: metricDefinitionSchema,
  });
}

export function transitionMetricDefinition(
  id: string,
  input: TransitionMetricDefinitionRequest,
): Promise<MetricDefinition> {
  return request(`${itemPath('metrics', id)}/transition`, {
    method: 'POST',
    body: transitionMetricDefinitionRequestSchema.parse(input),
    schema: metricDefinitionSchema,
  });
}

export function listProcessDefinitions(signal?: AbortSignal): Promise<ProcessDefinition[]> {
  return listItems(`${ROOT}/processes`, processDefinitionSchema, signal);
}

export function createProcessDefinition(
  input: CreateProcessDefinitionRequest,
): Promise<ProcessDefinition> {
  return request(`${ROOT}/processes`, {
    method: 'POST',
    body: createProcessDefinitionRequestSchema.parse(input),
    schema: processDefinitionSchema,
  });
}

export function updateProcessDefinition(
  id: string,
  input: UpdateProcessDefinitionRequest,
): Promise<ProcessDefinition> {
  return request(itemPath('processes', id), {
    method: 'PATCH',
    body: updateProcessDefinitionRequestSchema.parse(input),
    schema: processDefinitionSchema,
  });
}

export function listProcessVersions(
  processDefinitionId: string,
  signal?: AbortSignal,
): Promise<ProcessVersion[]> {
  return listItems(
    `${itemPath('processes', processDefinitionId)}/versions`,
    processVersionSchema,
    signal,
  );
}

export function createProcessVersion(
  processDefinitionId: string,
  input: CreateProcessVersionRequest,
): Promise<ProcessVersion> {
  return request(`${itemPath('processes', processDefinitionId)}/versions`, {
    method: 'POST',
    body: createProcessVersionRequestSchema.parse(input),
    schema: processVersionSchema,
  });
}

export function updateProcessVersion(
  processDefinitionId: string,
  versionId: string,
  input: UpdateProcessVersionRequest,
): Promise<ProcessVersion> {
  return request(
    `${itemPath('processes', processDefinitionId)}/versions/${encodeURIComponent(versionId)}`,
    {
      method: 'PATCH',
      body: updateProcessVersionRequestSchema.parse(input),
      schema: processVersionSchema,
    },
  );
}

export function transitionProcessVersion(
  processDefinitionId: string,
  versionId: string,
  input: TransitionProcessVersionRequest,
): Promise<ProcessVersion> {
  return request(
    `${itemPath('processes', processDefinitionId)}/versions/${encodeURIComponent(versionId)}/transition`,
    {
      method: 'POST',
      body: transitionProcessVersionRequestSchema.parse(input),
      schema: processVersionSchema,
    },
  );
}

export function listTasks(signal?: AbortSignal): Promise<Task[]> {
  return listItems(`${ROOT}/tasks`, taskSchema, signal);
}

export function createTask(input: CreateTaskRequest): Promise<Task> {
  return request(`${ROOT}/tasks`, {
    method: 'POST',
    body: createTaskRequestSchema.parse(input),
    schema: taskSchema,
  });
}

export function updateTask(id: string, input: UpdateTaskRequest): Promise<Task> {
  return request(itemPath('tasks', id), {
    method: 'PATCH',
    body: updateTaskRequestSchema.parse(input),
    schema: taskSchema,
  });
}

export function transitionTask(id: string, input: TransitionTaskRequest): Promise<Task> {
  return request(`${itemPath('tasks', id)}/transition`, {
    method: 'POST',
    body: transitionTaskRequestSchema.parse(input),
    schema: taskSchema,
  });
}

export function listTaskDependencies(signal?: AbortSignal): Promise<TaskDependency[]> {
  return listItems(`${ROOT}/tasks/dependencies`, taskDependencySchema, signal);
}

export function createTaskDependency(input: CreateTaskDependencyRequest): Promise<TaskDependency> {
  return request(`${ROOT}/tasks/dependencies`, {
    method: 'POST',
    body: createTaskDependencyRequestSchema.parse(input),
    schema: taskDependencySchema,
  });
}

export function updateTaskDependency(
  id: string,
  input: UpdateTaskDependencyRequest,
): Promise<TaskDependency> {
  return request(`${ROOT}/tasks/dependencies/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: updateTaskDependencyRequestSchema.parse(input),
    schema: taskDependencySchema,
  });
}

export function transitionTaskDependency(
  id: string,
  input: TransitionTaskDependencyRequest,
): Promise<TaskDependency> {
  return request(`${ROOT}/tasks/dependencies/${encodeURIComponent(id)}/transition`, {
    method: 'POST',
    body: transitionTaskDependencyRequestSchema.parse(input),
    schema: taskDependencySchema,
  });
}

export function listTaskDeliverables(taskId: string, signal?: AbortSignal): Promise<Deliverable[]> {
  return listItems(`${itemPath('tasks', taskId)}/deliverables`, deliverableSchema, signal);
}

export function createTaskDeliverable(
  taskId: string,
  input: CreateDeliverableRequest,
): Promise<Deliverable> {
  return request(`${itemPath('tasks', taskId)}/deliverables`, {
    method: 'POST',
    body: createDeliverableRequestSchema.parse(input),
    schema: deliverableSchema,
  });
}

export function updateTaskDeliverable(
  taskId: string,
  deliverableId: string,
  input: UpdateDeliverableRequest,
): Promise<Deliverable> {
  return request(`${itemPath('tasks', taskId)}/deliverables/${encodeURIComponent(deliverableId)}`, {
    method: 'PATCH',
    body: updateDeliverableRequestSchema.parse(input),
    schema: deliverableSchema,
  });
}

export function transitionTaskDeliverable(
  taskId: string,
  deliverableId: string,
  input: TransitionDeliverableRequest,
): Promise<Deliverable> {
  return request(
    `${itemPath('tasks', taskId)}/deliverables/${encodeURIComponent(deliverableId)}/transition`,
    {
      method: 'POST',
      body: transitionDeliverableRequestSchema.parse(input),
      schema: deliverableSchema,
    },
  );
}

function acceptanceRoot(taskId: string, deliverableId: string): string {
  return `${itemPath('tasks', taskId)}/deliverables/${encodeURIComponent(deliverableId)}/acceptances`;
}

export function listDeliverableAcceptances(
  taskId: string,
  deliverableId: string,
  signal?: AbortSignal,
): Promise<Acceptance[]> {
  return listItems(acceptanceRoot(taskId, deliverableId), acceptanceSchema, signal);
}

export function createDeliverableAcceptance(
  taskId: string,
  deliverableId: string,
  input: CreateAcceptanceRequest,
): Promise<Acceptance> {
  return request(acceptanceRoot(taskId, deliverableId), {
    method: 'POST',
    body: createAcceptanceRequestSchema.parse(input),
    schema: acceptanceSchema,
  });
}

export function updateDeliverableAcceptance(
  taskId: string,
  deliverableId: string,
  acceptanceId: string,
  input: UpdateAcceptanceRequest,
): Promise<Acceptance> {
  return request(`${acceptanceRoot(taskId, deliverableId)}/${encodeURIComponent(acceptanceId)}`, {
    method: 'PATCH',
    body: updateAcceptanceRequestSchema.parse(input),
    schema: acceptanceSchema,
  });
}

export function transitionDeliverableAcceptance(
  taskId: string,
  deliverableId: string,
  acceptanceId: string,
  input: TransitionAcceptanceRequest,
): Promise<Acceptance> {
  return request(
    `${acceptanceRoot(taskId, deliverableId)}/${encodeURIComponent(acceptanceId)}/transition`,
    {
      method: 'POST',
      body: transitionAcceptanceRequestSchema.parse(input),
      schema: acceptanceSchema,
    },
  );
}

export function listEvidence(signal?: AbortSignal): Promise<Evidence[]> {
  return listItems(`${ROOT}/evidence`, evidenceSchema, signal);
}

export function createEvidence(input: CreateEvidenceRequest): Promise<Evidence> {
  return request(`${ROOT}/evidence`, {
    method: 'POST',
    body: createEvidenceRequestSchema.parse(input),
    schema: evidenceSchema,
  });
}

export function createGuidedEvidence(input: CreateEvidenceGuidedRequest): Promise<Evidence> {
  return request(`${ROOT}/evidence/guided`, {
    method: 'POST',
    body: createEvidenceGuidedRequestSchema.parse(input),
    schema: evidenceSchema,
  });
}

export function updateEvidence(id: string, input: UpdateEvidenceRequest): Promise<Evidence> {
  return request(itemPath('evidence', id), {
    method: 'PATCH',
    body: updateEvidenceRequestSchema.parse(input),
    schema: evidenceSchema,
  });
}

export function transitionEvidence(
  id: string,
  input: TransitionEvidenceRequest,
): Promise<Evidence> {
  return request(`${itemPath('evidence', id)}/transition`, {
    method: 'POST',
    body: transitionEvidenceRequestSchema.parse(input),
    schema: evidenceSchema,
  });
}

export function listEvidenceLinks(
  evidenceId: string,
  signal?: AbortSignal,
): Promise<EvidenceLink[]> {
  return listItems(`${itemPath('evidence', evidenceId)}/links`, evidenceLinkSchema, signal);
}

export function createEvidenceLink(
  evidenceId: string,
  input: CreateEvidenceLinkRequest,
): Promise<EvidenceLink> {
  return request(`${itemPath('evidence', evidenceId)}/links`, {
    method: 'POST',
    body: createEvidenceLinkRequestSchema.parse(input),
    schema: evidenceLinkSchema,
  });
}

export function updateEvidenceLink(
  evidenceId: string,
  linkId: string,
  input: UpdateEvidenceLinkRequest,
): Promise<EvidenceLink> {
  return request(`${itemPath('evidence', evidenceId)}/links/${encodeURIComponent(linkId)}`, {
    method: 'PATCH',
    body: updateEvidenceLinkRequestSchema.parse(input),
    schema: evidenceLinkSchema,
  });
}

export function transitionEvidenceLink(
  evidenceId: string,
  linkId: string,
  input: TransitionEvidenceLinkRequest,
): Promise<EvidenceLink> {
  return request(
    `${itemPath('evidence', evidenceId)}/links/${encodeURIComponent(linkId)}/transition`,
    {
      method: 'POST',
      body: transitionEvidenceLinkRequestSchema.parse(input),
      schema: evidenceLinkSchema,
    },
  );
}
