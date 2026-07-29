import { randomUUID } from 'node:crypto';

import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  CreateMarketingActionItemContributorRequest,
  CreateMarketingActionItemDependencyRequest,
  CreateMarketingActionItemRequest,
  CreateMarketingActionPlanRequest,
  CreateMarketingTargetRequest,
  MarketingActionItem,
  MarketingActionItemContributor,
  MarketingActionItemDependency,
  MarketingActionPlan,
  MarketingTarget,
  TransitionMarketingActionItemRequest,
  TransitionMarketingActionPlanRequest,
  TransitionMarketingTargetRequest,
} from '@enterprise/contracts';
import {
  Prisma,
  type MarketingActionItem as DbMarketingActionItem,
  type MarketingActionPlan as DbMarketingActionPlan,
  type MarketingTarget as DbMarketingTarget,
} from '@prisma/client';

import {
  InvalidMarketingTransitionError,
  transitionMarketingActionItem,
  transitionMarketingActionPlan,
  transitionMarketingTarget,
} from './domain/marketing-state-machine.js';
import {
  assertMarketingReplay,
  lockMarketingKey,
  lockMarketingRecord,
  marketingRequestIdentity,
  recordMarketingMutation,
} from './marketing-persistence.js';
import { AdminPrismaService } from '../../database/admin-prisma.service.js';
import { AdminAccessService } from '../admin/admin-access.service.js';

@Injectable()
export class MarketingPlanningService {
  constructor(
    @Inject(AdminPrismaService) private readonly prisma: AdminPrismaService,
    @Inject(AdminAccessService) private readonly access: AdminAccessService,
  ) {}

  async listTargets(): Promise<{ readonly items: MarketingTarget[] }> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => ({
      items: (
        await transaction.marketingTarget.findMany({
          where: { tenantId: principal.tenantId },
          orderBy: [{ status: 'asc' }, { code: 'asc' }],
          take: 500,
        })
      ).map(mapTarget),
    }));
  }

  async createTarget(request: CreateMarketingTargetRequest): Promise<MarketingTarget> {
    const principal = this.access.requireDirectoryWrite();
    const identity = marketingRequestIdentity(request);
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        await lockMarketingKey(transaction, principal.tenantId, 'target', identity.key);
        const replay = await transaction.marketingTarget.findFirst({
          where: { tenantId: principal.tenantId, idempotencyKey: identity.key },
        });
        if (replay !== null) {
          assertMarketingReplay(replay, identity.requestHash);
          return mapTarget(replay);
        }
        const created = await transaction.marketingTarget.create({
          data: {
            id: randomUUID(),
            tenantId: principal.tenantId,
            code: request.code,
            productId: request.productId,
            axis: request.axis,
            regionId: request.regionId,
            customerSegmentId: request.customerSegmentId,
            strategyId: request.strategyId,
            strategyVersion: request.strategyVersion,
            objectiveId: request.objectiveId,
            objectiveVersion: request.objectiveVersion,
            valueDefinitionId: request.valueDefinitionId,
            valueVersionId: request.valueVersionId,
            valueVersionNumber: request.valueVersionNumber,
            responsibleRoleAssignmentId: request.responsibleRoleAssignmentId,
            metricDefinitionId: request.metricDefinitionId,
            metricDefinitionVersion: request.metricDefinitionVersion,
            baselineValue: request.baselineValue,
            targetValue: request.targetValue,
            unit: request.unit,
            periodStart: new Date(request.periodStart),
            periodEnd: new Date(request.periodEnd),
            budgetAmount: request.budgetAmount,
            budgetCurrency: request.budgetCurrency,
            idempotencyKey: identity.key,
            requestHash: identity.requestHash,
            createdByUserId: principal.userId,
          },
        });
        await recordMarketingMutation(
          transaction,
          principal,
          'marketing.target.created',
          'marketing_target',
          created.id,
          {
            code: created.code,
            productId: created.productId,
            axis: created.axis,
            objectiveId: created.objectiveId,
            objectiveVersion: created.objectiveVersion,
          },
        );
        return mapTarget(created);
      });
    } catch (error) {
      throw mapPlanningError(error, 'Marketing target');
    }
  }

  async transitionTarget(
    id: string,
    request: TransitionMarketingTargetRequest,
  ): Promise<MarketingTarget> {
    const principal = this.access.requireDirectoryWrite();
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        await lockMarketingRecord(transaction, 'marketing_targets', principal.tenantId, id);
        const current = await transaction.marketingTarget.findFirst({
          where: { tenantId: principal.tenantId, id },
        });
        if (current === null) throw new NotFoundException('Marketing target was not found.');
        const patch = transitionMarketingTarget(current, request);
        const changed = await transaction.marketingTarget.updateMany({
          where: {
            tenantId: principal.tenantId,
            id,
            revision: request.expectedRevision,
            status: current.status,
          },
          data: { ...patch, revision: { increment: 1 } },
        });
        if (changed.count !== 1) {
          throw new ConflictException('Marketing target changed. Refresh and try again.');
        }
        await recordMarketingMutation(
          transaction,
          principal,
          `marketing.target.${request.action.toLowerCase()}`,
          'marketing_target',
          id,
          {
            previousStatus: current.status,
            nextStatus: patch.status,
            expectedRevision: request.expectedRevision,
            comment: request.comment,
          },
        );
        return mapTarget(
          await transaction.marketingTarget.findFirstOrThrow({
            where: { tenantId: principal.tenantId, id },
          }),
        );
      });
    } catch (error) {
      throw mapPlanningTransitionError(error, 'Marketing target');
    }
  }

  async listPlans(): Promise<{ readonly items: MarketingActionPlan[] }> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const plans = await transaction.marketingActionPlan.findMany({
        where: { tenantId: principal.tenantId },
        orderBy: [{ status: 'asc' }, { code: 'asc' }, { version: 'desc' }],
        take: 500,
      });
      const items = await transaction.marketingActionItem.findMany({
        where: { tenantId: principal.tenantId, planId: { in: plans.map((plan) => plan.id) } },
        orderBy: [{ ordinal: 'asc' }, { id: 'asc' }],
      });
      return {
        items: plans.map((plan) =>
          mapPlan(plan, items.filter((item) => item.planId === plan.id).map(mapItem)),
        ),
      };
    });
  }

  async createPlan(request: CreateMarketingActionPlanRequest): Promise<MarketingActionPlan> {
    const principal = this.access.requireDirectoryWrite();
    const identity = marketingRequestIdentity(request);
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        await lockMarketingKey(transaction, principal.tenantId, 'action-plan', identity.key);
        const replay = await transaction.marketingActionPlan.findFirst({
          where: { tenantId: principal.tenantId, idempotencyKey: identity.key },
        });
        if (replay !== null) {
          assertMarketingReplay(replay, identity.requestHash);
          return hydratePlan(transaction, principal.tenantId, replay.id);
        }
        const created = await transaction.marketingActionPlan.create({
          data: {
            id: randomUUID(),
            tenantId: principal.tenantId,
            code: request.code,
            targetId: request.targetId,
            title: request.title,
            description: request.description,
            responsibleRoleAssignmentId: request.responsibleRoleAssignmentId,
            periodStart: new Date(request.periodStart),
            periodEnd: new Date(request.periodEnd),
            plannedBudgetAmount: request.plannedBudgetAmount,
            plannedBudgetCurrency: request.plannedBudgetCurrency,
            idempotencyKey: identity.key,
            requestHash: identity.requestHash,
            createdByUserId: principal.userId,
          },
        });
        await recordMarketingMutation(
          transaction,
          principal,
          'marketing.action_plan.created',
          'marketing_action_plan',
          created.id,
          { code: created.code, targetId: created.targetId },
        );
        return mapPlan(created, []);
      });
    } catch (error) {
      throw mapPlanningError(error, 'Marketing action plan');
    }
  }

  async transitionPlan(
    id: string,
    request: TransitionMarketingActionPlanRequest,
  ): Promise<MarketingActionPlan> {
    const principal = this.access.requireDirectoryWrite();
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        await lockMarketingKey(transaction, principal.tenantId, 'action-plan-mutation', id);
        const current = await transaction.marketingActionPlan.findFirst({
          where: { tenantId: principal.tenantId, id },
        });
        if (current === null) {
          throw new NotFoundException('Marketing action plan was not found.');
        }
        const nextStatus = transitionMarketingActionPlan(current, request);
        if (nextStatus === 'ACTIVE') {
          const target = await transaction.marketingTarget.findFirst({
            where: { tenantId: principal.tenantId, id: current.targetId },
            select: { status: true },
          });
          if (target?.status !== 'ACTIVE') {
            throw new ConflictException(
              'Marketing action plan cannot activate until its Target is active.',
            );
          }
        }
        if (nextStatus === 'COMPLETED') {
          const items = await transaction.marketingActionItem.findMany({
            where: { tenantId: principal.tenantId, planId: id },
            select: { status: true },
          });
          if (
            items.length === 0 ||
            !items.some((item) => item.status === 'COMPLETED') ||
            items.some((item) => item.status !== 'COMPLETED' && item.status !== 'CANCELLED')
          ) {
            throw new ConflictException(
              'Marketing action plan requires at least one accepted item and no unfinished items.',
            );
          }
        }
        const changed = await transaction.marketingActionPlan.updateMany({
          where: {
            tenantId: principal.tenantId,
            id,
            revision: request.expectedRevision,
            status: current.status,
          },
          data: { status: nextStatus, revision: { increment: 1 } },
        });
        if (changed.count !== 1) {
          throw new ConflictException('Marketing action plan changed. Refresh and try again.');
        }
        await recordMarketingMutation(
          transaction,
          principal,
          `marketing.action_plan.${request.action.toLowerCase()}`,
          'marketing_action_plan',
          id,
          {
            previousStatus: current.status,
            nextStatus,
            expectedRevision: request.expectedRevision,
            comment: request.comment,
          },
        );
        return hydratePlan(transaction, principal.tenantId, id);
      });
    } catch (error) {
      throw mapPlanningTransitionError(error, 'Marketing action plan');
    }
  }

  async createItem(
    planId: string,
    request: CreateMarketingActionItemRequest,
  ): Promise<MarketingActionItem> {
    const principal = this.access.requireDirectoryWrite();
    const identity = marketingRequestIdentity(request);
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        await lockMarketingKey(transaction, principal.tenantId, 'action-item', identity.key);
        await lockMarketingKey(transaction, principal.tenantId, 'action-plan-mutation', planId);
        const replay = await transaction.marketingActionItem.findFirst({
          where: { tenantId: principal.tenantId, idempotencyKey: identity.key },
        });
        if (replay !== null) {
          assertMarketingReplay(replay, identity.requestHash);
          return mapItem(replay);
        }
        const plan = await transaction.marketingActionPlan.findFirst({
          where: { tenantId: principal.tenantId, id: planId },
        });
        if (plan === null) throw new NotFoundException('Marketing action plan was not found.');
        if (plan.status !== 'DRAFT' && plan.status !== 'ACTIVE') {
          throw new ConflictException('Closed Marketing action plans cannot receive new items.');
        }
        const created = await transaction.marketingActionItem.create({
          data: {
            id: randomUUID(),
            tenantId: principal.tenantId,
            planId,
            planVersion: plan.version,
            code: request.code,
            ordinal: request.ordinal,
            title: request.title,
            description: request.description,
            responsibleRoleAssignmentId: request.responsibleRoleAssignmentId,
            linkedTaskId: request.linkedTaskId,
            linkedTaskVersion: request.linkedTaskVersion,
            contributionType: request.contributionType,
            acceptanceCriteria: request.acceptanceCriteria,
            dueAt: new Date(request.dueAt),
            idempotencyKey: identity.key,
            requestHash: identity.requestHash,
            createdByUserId: principal.userId,
          },
        });
        await recordMarketingMutation(
          transaction,
          principal,
          'marketing.action_item.created',
          'marketing_action_item',
          created.id,
          {
            planId,
            code: created.code,
            linkedTaskId: created.linkedTaskId,
            contributionType: created.contributionType,
          },
        );
        return mapItem(created);
      });
    } catch (error) {
      throw mapPlanningError(error, 'Marketing action item');
    }
  }

  async transitionItem(
    itemId: string,
    request: TransitionMarketingActionItemRequest,
  ): Promise<MarketingActionItem> {
    const principal = this.access.requireDirectoryWrite();
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        const current = await transaction.marketingActionItem.findFirst({
          where: { tenantId: principal.tenantId, id: itemId },
        });
        if (current === null) throw new NotFoundException('Marketing action item was not found.');
        const nextStatus = transitionMarketingActionItem(current, request);
        if (nextStatus === 'COMPLETED') {
          if (request.acceptanceEvidenceId === null || request.acceptanceEvidenceVersion === null) {
            throw new ConflictException(
              'Marketing action item completion requires acceptance Evidence.',
            );
          }
          const evidence = await transaction.evidence.findFirst({
            where: {
              tenantId: principal.tenantId,
              id: request.acceptanceEvidenceId,
              version: request.acceptanceEvidenceVersion,
              status: 'ACTIVE',
            },
          });
          if (evidence === null) {
            throw new ConflictException(
              'Marketing action item acceptance Evidence is missing or inactive.',
            );
          }
        }
        const changed = await transaction.marketingActionItem.updateMany({
          where: {
            tenantId: principal.tenantId,
            id: itemId,
            revision: request.expectedRevision,
            status: current.status,
          },
          data: {
            status: nextStatus,
            revision: { increment: 1 },
            ...(nextStatus === 'COMPLETED'
              ? {
                  acceptanceEvidenceId: request.acceptanceEvidenceId,
                  acceptanceEvidenceVersion: request.acceptanceEvidenceVersion,
                }
              : {}),
          },
        });
        if (changed.count !== 1) {
          throw new ConflictException('Marketing action item changed. Refresh and try again.');
        }
        await recordMarketingMutation(
          transaction,
          principal,
          `marketing.action_item.${request.action.toLowerCase()}`,
          'marketing_action_item',
          itemId,
          {
            previousStatus: current.status,
            nextStatus,
            expectedRevision: request.expectedRevision,
            comment: request.comment,
            acceptanceEvidenceId: request.acceptanceEvidenceId,
          },
        );
        return mapItem(
          await transaction.marketingActionItem.findFirstOrThrow({
            where: { tenantId: principal.tenantId, id: itemId },
          }),
        );
      });
    } catch (error) {
      throw mapPlanningTransitionError(error, 'Marketing action item');
    }
  }

  async addContributor(
    itemId: string,
    request: CreateMarketingActionItemContributorRequest,
  ): Promise<MarketingActionItemContributor> {
    const principal = this.access.requireDirectoryWrite();
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        const created = await transaction.marketingActionItemContributor.create({
          data: {
            tenantId: principal.tenantId,
            actionItemId: itemId,
            roleAssignmentId: request.roleAssignmentId,
            contributionType: request.contributionType,
          },
        });
        await recordMarketingMutation(
          transaction,
          principal,
          'marketing.action_item.contributor_added',
          'marketing_action_item',
          itemId,
          {
            roleAssignmentId: created.roleAssignmentId,
            contributionType: created.contributionType,
          },
        );
        return {
          actionItemId: created.actionItemId,
          roleAssignmentId: created.roleAssignmentId,
          contributionType: created.contributionType,
          createdAt: created.createdAt.toISOString(),
        };
      });
    } catch (error) {
      throw mapPlanningError(error, 'Marketing action item contributor');
    }
  }

  async createDependency(
    planId: string,
    request: CreateMarketingActionItemDependencyRequest,
  ): Promise<MarketingActionItemDependency> {
    const principal = this.access.requireDirectoryWrite();
    const identity = marketingRequestIdentity(request);
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        await lockMarketingKey(transaction, principal.tenantId, 'action-dependency', identity.key);
        await lockMarketingKey(transaction, principal.tenantId, 'action-dependency-graph', planId);
        const replay = await transaction.marketingActionItemDependency.findFirst({
          where: { tenantId: principal.tenantId, idempotencyKey: identity.key },
        });
        if (replay !== null) {
          assertMarketingReplay(replay, identity.requestHash);
          return mapDependency(replay);
        }
        const created = await transaction.marketingActionItemDependency.create({
          data: {
            id: randomUUID(),
            tenantId: principal.tenantId,
            planId,
            predecessorItemId: request.predecessorItemId,
            successorItemId: request.successorItemId,
            idempotencyKey: identity.key,
            requestHash: identity.requestHash,
          },
        });
        await recordMarketingMutation(
          transaction,
          principal,
          'marketing.action_item.dependency_created',
          'marketing_action_item_dependency',
          created.id,
          {
            planId,
            predecessorItemId: created.predecessorItemId,
            successorItemId: created.successorItemId,
          },
        );
        return mapDependency(created);
      });
    } catch (error) {
      throw mapPlanningError(error, 'Marketing action item dependency');
    }
  }
}

async function hydratePlan(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  id: string,
): Promise<MarketingActionPlan> {
  const plan = await transaction.marketingActionPlan.findFirstOrThrow({
    where: { tenantId, id },
  });
  const items = await transaction.marketingActionItem.findMany({
    where: { tenantId, planId: id },
    orderBy: [{ ordinal: 'asc' }, { id: 'asc' }],
  });
  return mapPlan(plan, items.map(mapItem));
}

function mapTarget(record: DbMarketingTarget): MarketingTarget {
  return {
    id: record.id,
    code: record.code,
    revision: record.revision,
    status: record.status,
    productId: record.productId,
    axis: record.axis,
    regionId: record.regionId,
    customerSegmentId: record.customerSegmentId,
    strategyId: record.strategyId,
    strategyVersion: record.strategyVersion,
    objectiveId: record.objectiveId,
    objectiveVersion: record.objectiveVersion,
    valueDefinitionId: record.valueDefinitionId,
    valueVersionId: record.valueVersionId,
    valueVersionNumber: record.valueVersionNumber,
    responsibleRoleAssignmentId: record.responsibleRoleAssignmentId,
    metricDefinitionId: record.metricDefinitionId,
    metricDefinitionVersion: record.metricDefinitionVersion,
    baselineValue: record.baselineValue?.toNumber() ?? null,
    targetValue: record.targetValue.toNumber(),
    unit: record.unit,
    periodStart: record.periodStart.toISOString(),
    periodEnd: record.periodEnd.toISOString(),
    budgetAmount: record.budgetAmount?.toNumber() ?? null,
    budgetCurrency: record.budgetCurrency,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function mapPlan(
  record: DbMarketingActionPlan,
  items: readonly MarketingActionItem[],
): MarketingActionPlan {
  return {
    id: record.id,
    code: record.code,
    version: record.version,
    revision: record.revision,
    targetId: record.targetId,
    title: record.title,
    description: record.description,
    status: record.status,
    responsibleRoleAssignmentId: record.responsibleRoleAssignmentId,
    periodStart: record.periodStart.toISOString(),
    periodEnd: record.periodEnd.toISOString(),
    plannedBudgetAmount: record.plannedBudgetAmount?.toNumber() ?? null,
    plannedBudgetCurrency: record.plannedBudgetCurrency,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    items: [...items],
  };
}

function mapItem(record: DbMarketingActionItem): MarketingActionItem {
  return {
    id: record.id,
    code: record.code,
    revision: record.revision,
    ordinal: record.ordinal,
    title: record.title,
    description: record.description,
    status: record.status,
    responsibleRoleAssignmentId: record.responsibleRoleAssignmentId,
    linkedTaskId: record.linkedTaskId,
    linkedTaskVersion: record.linkedTaskVersion,
    contributionType: record.contributionType,
    acceptanceCriteria: record.acceptanceCriteria,
    acceptanceEvidenceId: record.acceptanceEvidenceId,
    acceptanceEvidenceVersion: record.acceptanceEvidenceVersion,
    dueAt: record.dueAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function mapDependency(record: {
  readonly id: string;
  readonly planId: string;
  readonly predecessorItemId: string;
  readonly successorItemId: string;
  readonly createdAt: Date;
}): MarketingActionItemDependency {
  return {
    id: record.id,
    planId: record.planId,
    predecessorItemId: record.predecessorItemId,
    successorItemId: record.successorItemId,
    createdAt: record.createdAt.toISOString(),
  };
}

function mapPlanningTransitionError(error: unknown, resource: string): unknown {
  if (error instanceof InvalidMarketingTransitionError) {
    return new UnprocessableEntityException(error.message);
  }
  return mapPlanningError(error, resource);
}

function mapPlanningError(error: unknown, resource: string): unknown {
  if (
    error instanceof ConflictException ||
    error instanceof NotFoundException ||
    error instanceof UnprocessableEntityException
  ) {
    return error;
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') {
      return new ConflictException(`${resource} code, link, or idempotency key already exists.`);
    }
    if (error.code === 'P2003' || error.code === 'P2004') {
      return new ConflictException(
        `${resource} violates a governed Strategy, Objective, Value, Role, Evidence, or Task boundary.`,
      );
    }
  }
  return error;
}
