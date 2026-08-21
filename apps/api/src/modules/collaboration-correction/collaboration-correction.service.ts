import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  CollaborationCandidateList,
  CollaborationCommandRequest,
  CollaborationDetailResponse,
  CollaborationListResponse,
  CorrectionCase,
  CorrectionCaseListResponse,
  CorrectionFeedbackRequest,
  CreateCollaborationRequest,
} from '@enterprise/contracts';

import {
  normalizeRuntimeCursor,
  unwrapRuntimeMutation,
} from '../process-orchestration/application/runtime-http-errors.js';
import { RuntimeIdentityPort } from '../process-orchestration/application/runtime-identity.port.js';
import {
  evaluateCorrectionFeedback,
  type CorrectionTransitionDecision,
} from '../process-orchestration/domain/correction-state-machine.js';
import { CollaborationCorrectionAuthorizationPort } from './collaboration-correction-authorization.port.js';
import {
  mapCollaborationDetail,
  mapCollaborationPage,
  mapCorrectionFeedbackResult,
  mapCorrectionPage,
  mapCorrectionRecord,
} from './collaboration-correction.mapper.js';
import { CollaborationCorrectionRepository } from './collaboration-correction.repository.js';

const PAGE_SIZE = 100;

@Injectable()
export class CollaborationCorrectionService {
  constructor(
    @Inject(CollaborationCorrectionRepository)
    private readonly repository: CollaborationCorrectionRepository,
    @Inject(CollaborationCorrectionAuthorizationPort)
    private readonly authorization: CollaborationCorrectionAuthorizationPort,
    @Inject(RuntimeIdentityPort)
    private readonly identity: RuntimeIdentityPort,
  ) {}

  async listCollaborationCandidates(taskId: string): Promise<CollaborationCandidateList> {
    const principal = this.identity.current();
    const scope = await this.authorization.requireTaskAccess({
      principal,
      taskId,
      action: 'collaboration.candidates',
    });
    requireCoherentScope(principal, taskId, scope);
    return { items: [...(await this.repository.listCollaborationCandidates(scope))] };
  }

  async createCollaboration(
    taskId: string,
    request: CreateCollaborationRequest,
  ): Promise<CollaborationDetailResponse> {
    const principal = this.identity.current();
    const scope = await this.authorization.requireTaskAccess({
      principal,
      taskId,
      action: 'collaboration.create',
    });
    requireCoherentScope(principal, taskId, scope);
    const dueAt = new Date(request.dueAt);
    if (!Number.isFinite(dueAt.getTime()) || dueAt.getTime() <= Date.now()) {
      throw new UnprocessableEntityException('Collaboration dueAt must be in the future.');
    }
    return unwrapRuntimeMutation(
      await this.repository.createCollaboration({ principal, scope, request }),
      'Collaboration',
    );
  }

  async submitCollaborationCommand(
    taskId: string,
    collaborationId: string,
    request: CollaborationCommandRequest,
  ): Promise<CollaborationDetailResponse> {
    const principal = this.identity.current();
    const scope = await this.authorization.requireTaskAccess({
      principal,
      taskId,
      action: 'collaboration.command',
    });
    requireCoherentScope(principal, taskId, scope);
    return unwrapRuntimeMutation(
      await this.repository.applyCollaborationCommand({
        principal,
        scope,
        collaborationId,
        request,
      }),
      'Collaboration',
    );
  }

  async listCollaborations(taskId: string, cursor?: string): Promise<CollaborationListResponse> {
    const principal = this.identity.current();
    const scope = await this.authorization.requireTaskAccess({
      principal,
      taskId,
      action: 'collaboration.list',
    });
    requireCoherentScope(principal, taskId, scope);
    const page = await this.repository.listCollaborations(scope, {
      cursor: normalizeRuntimeCursor(cursor),
      limit: PAGE_SIZE,
    });
    return mapCollaborationPage(
      scope.tenantId,
      taskId,
      scope.managementBypass,
      scope.permissionLabelScopes,
      page,
    );
  }

  async getCollaboration(
    taskId: string,
    collaborationId: string,
  ): Promise<CollaborationDetailResponse> {
    const principal = this.identity.current();
    const scope = await this.authorization.requireTaskAccess({
      principal,
      taskId,
      action: 'collaboration.read',
    });
    requireCoherentScope(principal, taskId, scope);
    const detail = await this.repository.findCollaboration(scope, collaborationId);
    if (detail === null) {
      throw new NotFoundException('Collaboration was not found.');
    }
    return mapCollaborationDetail(
      scope.tenantId,
      taskId,
      collaborationId,
      scope.managementBypass,
      scope.permissionLabelScopes,
      detail,
    );
  }

  async listCorrections(taskId: string, cursor?: string): Promise<CorrectionCaseListResponse> {
    const principal = this.identity.current();
    const scope = await this.authorization.requireTaskAccess({
      principal,
      taskId,
      action: 'correction.list',
    });
    requireCoherentScope(principal, taskId, scope);
    const page = await this.repository.listCorrections(scope, {
      cursor: normalizeRuntimeCursor(cursor),
      limit: PAGE_SIZE,
    });
    return mapCorrectionPage(
      scope.tenantId,
      taskId,
      scope.managementBypass,
      scope.permissionLabelScopes,
      page,
    );
  }

  async submitCorrectionFeedback(
    taskId: string,
    correctionId: string,
    feedback: CorrectionFeedbackRequest,
  ): Promise<CorrectionCase> {
    const principal = this.identity.current();
    const scope = await this.authorization.requireTaskAccess({
      principal,
      taskId,
      action: 'correction.feedback',
    });
    requireCoherentScope(principal, taskId, scope);
    const stored = await this.repository.findCorrectionForFeedback(scope, correctionId);
    if (stored === null) {
      throw new NotFoundException('Correction Case was not found.');
    }
    const correction = mapCorrectionRecord(
      scope.tenantId,
      taskId,
      correctionId,
      scope.managementBypass,
      scope.permissionLabelScopes,
      stored,
    );
    const context = await this.authorization.buildCorrectionFeedbackContext({
      principal,
      scope,
      correction,
      feedback,
    });
    const decision = evaluateCorrectionFeedback(correction, feedback, context);
    if (!decision.allowed || decision.nextStatus === null) {
      throwCorrectionDenied(decision, scope.decisionId);
    }
    const roleAssignmentId = context.actor.roleAssignment?.id;
    if (roleAssignmentId === undefined) {
      throw new ConflictException(
        'Trusted correction authorization returned no actor Role Assignment.',
      );
    }

    const value = unwrapRuntimeMutation(
      await this.repository.applyCorrectionFeedback({
        principal,
        scope,
        correctionId,
        trustedActorRoleAssignmentId: roleAssignmentId,
        nextStatus: decision.nextStatus,
        feedback,
      }),
      'Correction Case',
    );
    return mapCorrectionFeedbackResult(
      scope.tenantId,
      taskId,
      correctionId,
      scope.managementBypass,
      scope.permissionLabelScopes,
      feedback.expectedRevision,
      decision.nextStatus,
      value,
    );
  }
}

function requireCoherentScope(
  principal: ReturnType<RuntimeIdentityPort['current']>,
  taskId: string,
  scope: Awaited<ReturnType<CollaborationCorrectionAuthorizationPort['requireTaskAccess']>>,
): void {
  if (
    scope.tenantId !== principal.tenantId ||
    scope.userId !== principal.userId ||
    scope.taskId !== taskId
  ) {
    throw new ConflictException('Trusted task authorization returned an inconsistent scope.');
  }
}

function throwCorrectionDenied(decision: CorrectionTransitionDecision, decisionId: string): never {
  if (decision.reason === 'STALE_REVISION') {
    throw new ConflictException('Correction Case revision is stale.');
  }
  if (
    decision.reason === 'ILLEGAL_TRANSITION' ||
    decision.reason === 'INVALID_EFFECTIVE_TIME' ||
    decision.reason === 'EVIDENCE_REQUIRED' ||
    decision.reason === 'EVIDENCE_INVALID'
  ) {
    throw new UnprocessableEntityException({
      statusCode: 422,
      error: 'Unprocessable Entity',
      message: 'Correction feedback violates the correction policy.',
      reasonCode: decision.reason,
    });
  }
  throw new ForbiddenException({
    statusCode: 403,
    error: 'Forbidden',
    message: 'The current trusted identity cannot perform this correction action.',
    reasonCode: decision.reason,
    decisionId,
  });
}
