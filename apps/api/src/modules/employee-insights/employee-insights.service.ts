import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  employeeAiUsageSummarySchema,
  employeeExperienceCandidateSchema,
  employeeExperienceListResponseSchema,
  employeeExperienceSourceSchema,
  type CreateExperienceCandidateRequest,
  type EmployeeAiUsageQuery,
  type EmployeeAiUsageSummary,
  type EmployeeCreateExperienceRequest,
  type EmployeeExperienceCandidate,
  type EmployeeExperienceListQuery,
  type EmployeeExperienceListResponse,
  type EmployeeExperienceSource,
  type ExperienceCandidate,
  type ExperienceListQuery,
} from '@enterprise/contracts';
import { createHash } from 'node:crypto';

import { EmployeeInsightsRepository } from './employee-insights.repository.js';
import { MemoryExperienceAuthorizationPort } from '../memory-experience/memory-experience-authorization.port.js';
import { MemoryExperienceRepository } from '../memory-experience/memory-experience.repository.js';
import { unwrapRuntimeMutation } from '../process-orchestration/application/runtime-http-errors.js';
import { RuntimeIdentityPort } from '../process-orchestration/application/runtime-identity.port.js';

@Injectable()
export class EmployeeInsightsService {
  constructor(
    @Inject(EmployeeInsightsRepository)
    private readonly insights: EmployeeInsightsRepository,
    @Inject(MemoryExperienceRepository)
    private readonly experiences: MemoryExperienceRepository,
    @Inject(MemoryExperienceAuthorizationPort)
    private readonly authorization: MemoryExperienceAuthorizationPort,
    @Inject(RuntimeIdentityPort)
    private readonly identity: RuntimeIdentityPort,
  ) {}

  async listExperiences(
    query: EmployeeExperienceListQuery,
  ): Promise<EmployeeExperienceListResponse> {
    const principal = this.identity.current();
    const page = await this.experiences.listExperiencesByContributor(
      principal,
      query as ExperienceListQuery,
    );
    return employeeExperienceListResponseSchema.parse({
      items: page.items.map(toEmployeeExperience),
      nextCursor: page.nextCursor,
    });
  }

  async experienceSources(taskId: string): Promise<EmployeeExperienceSource> {
    const principal = this.identity.current();
    const now = new Date();
    await this.requireTaskGrant(taskId, now);
    const sources = await this.insights.experienceSources(principal, taskId, now);
    if (sources === null) throw new NotFoundException('The authorized Task was not found.');
    return employeeExperienceSourceSchema.parse(sources);
  }

  async createExperience(
    request: EmployeeCreateExperienceRequest,
  ): Promise<EmployeeExperienceCandidate> {
    const principal = this.identity.current();
    const now = new Date();
    await this.requireTaskGrant(request.sourceTaskId, now);
    const actor = await this.authorization.resolveExperienceActor({
      principal,
      taskId: request.sourceTaskId,
      action: 'CONTRIBUTE',
      now,
    });
    const governedRequest: CreateExperienceCandidateRequest = {
      ...request,
      rawInputHash: sha256(request.candidateSummary),
    };
    const candidate = unwrapRuntimeMutation(
      await this.experiences.createExperience({
        principal,
        actor,
        request: governedRequest,
        enforceContributorTaskScope: true,
        now,
      }),
      'Experience Candidate',
    );
    return employeeExperienceCandidateSchema.parse(toEmployeeExperience(candidate));
  }

  async aiUsage(query: EmployeeAiUsageQuery): Promise<EmployeeAiUsageSummary> {
    const principal = this.identity.current();
    const generatedAt = new Date();
    const defaultedToCurrentMonth = query.from === undefined;
    const from =
      query.from === undefined
        ? new Date(Date.UTC(generatedAt.getUTCFullYear(), generatedAt.getUTCMonth(), 1))
        : new Date(query.from);
    const to = query.to === undefined ? generatedAt : new Date(query.to);
    const usage = await this.insights.aiUsage(principal, {
      from,
      to,
      groupLimit: query.groupLimit,
    });
    return employeeAiUsageSummarySchema.parse({
      period: {
        from: from.toISOString(),
        to: to.toISOString(),
        defaultedToCurrentMonth,
      },
      generatedAt: generatedAt.toISOString(),
      ...usage,
    });
  }

  private async requireTaskGrant(taskId: string, now: Date): Promise<void> {
    const principal = this.identity.current();
    const access = await this.authorization.resolveMemoryAccess({
      principal,
      operation: 'READ',
      purpose: null,
      now,
    });
    const allowed = access.grants.some(
      (grant) =>
        grant.scope === 'TASK' &&
        grant.taskId === taskId &&
        grant.userId === principal.userId &&
        grant.tenantId === principal.tenantId,
    );
    if (!allowed) {
      throw new ForbiddenException(
        'Experience contribution requires a current exact Task authorization.',
      );
    }
  }
}

function toEmployeeExperience(candidate: ExperienceCandidate): EmployeeExperienceCandidate {
  return employeeExperienceCandidateSchema.parse({
    id: candidate.id,
    status: candidate.status,
    revision: candidate.revision,
    title: candidate.title,
    source: {
      taskId: candidate.sourceTaskId,
      deliverableIds: candidate.sourceDeliverableIds,
      evidenceIds: candidate.sourceEvidenceIds,
    },
    sanitized:
      candidate.sanitization === null
        ? null
        : {
            safeContent: candidate.sanitization.sanitizedContent,
            contentHash: candidate.sanitization.sanitizedHash,
            sanitizedAt: candidate.sanitization.sanitizedAt,
          },
    review:
      candidate.review === null
        ? null
        : {
            decision: candidate.review.decision,
            decidedAt: candidate.review.decidedAt,
          },
    validation:
      candidate.validation === null
        ? null
        : {
            passed: candidate.validation.passed,
            score: candidate.validation.score,
            threshold: candidate.validation.threshold,
            validatedAt: candidate.validation.validatedAt,
          },
    publication:
      candidate.publication === null
        ? null
        : {
            targetRoleTemplateIds: candidate.publication.targetRoleTemplateIds,
            targetOrgUnitIds: candidate.publication.targetOrgUnitIds,
            publishedAt: candidate.publication.publishedAt,
          },
    permissionLabels: candidate.permissionLabels,
    sensitivity: candidate.sensitivity,
    metrics: {
      useCount: candidate.monitoredUseCount,
      adoptionCount: candidate.monitoredAdoptionCount,
      complaintCount: candidate.monitoredComplaintCount,
    },
    retiredAt: candidate.retiredAt,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
