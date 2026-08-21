import { randomUUID } from 'node:crypto';

import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  CreateMarketingInsightRequest,
  CreateMarketingObservationRequest,
  MarketingInsight,
  MarketingObservation,
  TransitionMarketingInsightRequest,
} from '@enterprise/contracts';
import { Prisma, type Evidence, type MarketingInsight as DbMarketingInsight } from '@prisma/client';

import {
  InvalidMarketingTransitionError,
  transitionMarketingInsight,
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
export class MarketingEvidenceService {
  constructor(
    @Inject(AdminPrismaService) private readonly prisma: AdminPrismaService,
    @Inject(AdminAccessService) private readonly access: AdminAccessService,
  ) {}

  async listObservations(): Promise<{ readonly items: MarketingObservation[] }> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const observations = await transaction.marketingObservation.findMany({
        where: { tenantId: principal.tenantId },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: 500,
      });
      const links = await transaction.marketingObservationEvidence.findMany({
        where: { tenantId: principal.tenantId },
      });
      const evidence = await transaction.evidence.findMany({
        where: {
          tenantId: principal.tenantId,
          id: { in: [...new Set(links.map((link) => link.evidenceId))] },
        },
      });
      const evidenceByIdentity = new Map(
        evidence.map((item) => [`${item.id}:${item.version}`, item] as const),
      );
      return {
        items: observations.map((observation) =>
          mapObservation(
            observation,
            links
              .filter((link) => link.observationId === observation.id)
              .map((link) => ({
                link,
                evidence: requiredEvidence(
                  evidenceByIdentity,
                  link.evidenceId,
                  link.evidenceVersion,
                ),
              })),
          ),
        ),
      };
    });
  }

  async createObservation(
    request: CreateMarketingObservationRequest,
  ): Promise<MarketingObservation> {
    const principal = this.access.requireDirectoryWrite();
    const identity = marketingRequestIdentity(request);
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        await lockMarketingKey(transaction, principal.tenantId, 'observation', identity.key);
        await lockMarketingKey(transaction, principal.tenantId, 'observation-code', request.code);
        const replay = await transaction.marketingObservation.findFirst({
          where: { tenantId: principal.tenantId, idempotencyKey: identity.key },
        });
        if (replay !== null) {
          assertMarketingReplay(replay, identity.requestHash);
          return hydrateObservation(transaction, principal.tenantId, replay.id);
        }
        await assertAgentRun(transaction, principal.tenantId, request.origin, request.agentRunId);
        const evidence = await loadTrustedEvidence(
          transaction,
          principal.tenantId,
          request.evidence,
        );
        const latest = await transaction.marketingObservation.findFirst({
          where: { tenantId: principal.tenantId, code: request.code },
          orderBy: { version: 'desc' },
          select: { version: true },
        });
        const created = await transaction.marketingObservation.create({
          data: {
            id: randomUUID(),
            tenantId: principal.tenantId,
            code: request.code,
            version: (latest?.version ?? 0) + 1,
            dimension: request.dimension,
            assertionType: request.assertionType,
            statement: request.statement,
            confidence: request.confidence,
            origin: request.origin,
            agentRunId: request.agentRunId,
            createdByUserId: principal.userId,
            idempotencyKey: identity.key,
            requestHash: identity.requestHash,
          },
        });
        await transaction.marketingObservationEvidence.createMany({
          data: request.evidence.map((requested) => {
            const source = requiredEvidence(
              evidence,
              requested.evidenceId,
              requested.evidenceVersion,
            );
            return {
              tenantId: principal.tenantId,
              observationId: created.id,
              observationVersion: created.version,
              evidenceId: source.id,
              evidenceVersion: source.version,
              linkType: requested.linkType,
              sourceVersion: source.sourceVersion,
              contentHash: source.contentHash,
            };
          }),
        });
        await recordMarketingMutation(
          transaction,
          principal,
          'marketing.observation.created',
          'marketing_observation',
          created.id,
          {
            code: created.code,
            dimension: created.dimension,
            assertionType: created.assertionType,
            origin: created.origin,
            evidenceCount: request.evidence.length,
          },
        );
        return hydrateObservation(transaction, principal.tenantId, created.id);
      });
    } catch (error) {
      throw mapMarketingWriteError(error, 'Marketing observation');
    }
  }

  async listInsights(): Promise<{ readonly items: MarketingInsight[] }> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const insights = await transaction.marketingInsight.findMany({
        where: { tenantId: principal.tenantId },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        take: 500,
      });
      const links = await transaction.marketingInsightObservation.findMany({
        where: { tenantId: principal.tenantId },
      });
      return {
        items: insights.map((insight) =>
          mapInsight(
            insight,
            links.filter((link) => link.insightId === insight.id).map((link) => link.observationId),
          ),
        ),
      };
    });
  }

  async createInsight(request: CreateMarketingInsightRequest): Promise<MarketingInsight> {
    const principal = this.access.requireDirectoryWrite();
    const identity = marketingRequestIdentity(request);
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        await lockMarketingKey(transaction, principal.tenantId, 'insight', identity.key);
        await lockMarketingKey(transaction, principal.tenantId, 'insight-code', request.code);
        const replay = await transaction.marketingInsight.findFirst({
          where: { tenantId: principal.tenantId, idempotencyKey: identity.key },
        });
        if (replay !== null) {
          assertMarketingReplay(replay, identity.requestHash);
          return hydrateInsight(transaction, principal.tenantId, replay.id);
        }
        await assertAgentRun(transaction, principal.tenantId, request.origin, request.agentRunId);
        const distinctObservationIds = [...new Set(request.observationIds)];
        if (distinctObservationIds.length !== request.observationIds.length) {
          throw new ConflictException('Marketing Insight observations must be unique.');
        }
        const observations = await transaction.marketingObservation.findMany({
          where: {
            tenantId: principal.tenantId,
            id: { in: distinctObservationIds },
          },
        });
        if (observations.length !== distinctObservationIds.length) {
          throw new NotFoundException('One or more Marketing observations were not found.');
        }
        const latest = await transaction.marketingInsight.findFirst({
          where: { tenantId: principal.tenantId, code: request.code },
          orderBy: { version: 'desc' },
        });
        const created = await transaction.marketingInsight.create({
          data: {
            id: randomUUID(),
            tenantId: principal.tenantId,
            code: request.code,
            version: (latest?.version ?? 0) + 1,
            previousVersionId: latest?.id ?? null,
            previousVersionNumber: latest?.version ?? null,
            title: request.title,
            statement: request.statement,
            origin: request.origin,
            agentRunId: request.agentRunId,
            status: 'CANDIDATE',
            createdByUserId: principal.userId,
            idempotencyKey: identity.key,
            requestHash: identity.requestHash,
          },
        });
        await transaction.marketingInsightObservation.createMany({
          data: observations.map((observation) => ({
            tenantId: principal.tenantId,
            insightId: created.id,
            insightVersion: created.version,
            observationId: observation.id,
            observationVersion: observation.version,
          })),
        });
        await recordMarketingMutation(
          transaction,
          principal,
          'marketing.insight.candidate_created',
          'marketing_insight',
          created.id,
          {
            code: created.code,
            version: created.version,
            origin: created.origin,
            observationCount: observations.length,
          },
        );
        return hydrateInsight(transaction, principal.tenantId, created.id);
      });
    } catch (error) {
      throw mapMarketingWriteError(error, 'Marketing insight');
    }
  }

  async transitionInsight(
    insightId: string,
    request: TransitionMarketingInsightRequest,
  ): Promise<MarketingInsight> {
    const principal = this.access.requireDirectoryWrite();
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        await lockMarketingRecord(transaction, 'marketing_insights', principal.tenantId, insightId);
        const current = await transaction.marketingInsight.findFirst({
          where: { tenantId: principal.tenantId, id: insightId },
        });
        if (current === null) throw new NotFoundException('Marketing insight was not found.');
        const patch = transitionMarketingInsight(
          mapInsight(current, []),
          request,
          { userId: principal.userId },
          new Date(),
        );
        const changed = await transaction.marketingInsight.updateMany({
          where: {
            tenantId: principal.tenantId,
            id: insightId,
            revision: request.expectedRevision,
            status: current.status,
          },
          data: {
            ...patch,
            revision: { increment: 1 },
          },
        });
        if (changed.count !== 1) {
          throw new ConflictException('Marketing insight changed. Refresh and try again.');
        }
        await recordMarketingMutation(
          transaction,
          principal,
          `marketing.insight.${request.action.toLowerCase()}`,
          'marketing_insight',
          insightId,
          {
            previousStatus: current.status,
            nextStatus: patch.status,
            expectedRevision: request.expectedRevision,
            comment: request.comment,
          },
        );
        return hydrateInsight(transaction, principal.tenantId, insightId);
      });
    } catch (error) {
      if (error instanceof InvalidMarketingTransitionError) {
        throw new UnprocessableEntityException(error.message);
      }
      throw mapMarketingWriteError(error, 'Marketing insight');
    }
  }
}

async function hydrateObservation(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  id: string,
): Promise<MarketingObservation> {
  const observation = await transaction.marketingObservation.findFirstOrThrow({
    where: { tenantId, id },
  });
  const links = await transaction.marketingObservationEvidence.findMany({
    where: { tenantId, observationId: id },
  });
  const evidence = await transaction.evidence.findMany({
    where: { tenantId, id: { in: links.map((link) => link.evidenceId) } },
  });
  const evidenceByIdentity = new Map(
    evidence.map((item) => [`${item.id}:${item.version}`, item] as const),
  );
  return mapObservation(
    observation,
    links.map((link) => ({
      link,
      evidence: requiredEvidence(evidenceByIdentity, link.evidenceId, link.evidenceVersion),
    })),
  );
}

async function hydrateInsight(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  id: string,
): Promise<MarketingInsight> {
  const insight = await transaction.marketingInsight.findFirstOrThrow({
    where: { tenantId, id },
  });
  const links = await transaction.marketingInsightObservation.findMany({
    where: { tenantId, insightId: id },
  });
  return mapInsight(
    insight,
    links.map((link) => link.observationId),
  );
}

async function loadTrustedEvidence(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  requested: CreateMarketingObservationRequest['evidence'],
): Promise<Map<string, Evidence>> {
  const identities = new Set(requested.map((item) => `${item.evidenceId}:${item.evidenceVersion}`));
  if (identities.size !== requested.length) {
    throw new ConflictException('Marketing observation evidence must be unique.');
  }
  const evidence = await transaction.evidence.findMany({
    where: {
      tenantId,
      id: { in: requested.map((item) => item.evidenceId) },
      status: 'ACTIVE',
    },
  });
  const byIdentity = new Map(evidence.map((item) => [`${item.id}:${item.version}`, item] as const));
  for (const item of requested) {
    const trusted = byIdentity.get(`${item.evidenceId}:${item.evidenceVersion}`);
    if (trusted === undefined || trusted.contentHash !== item.expectedContentHash) {
      throw new ConflictException(
        'Marketing evidence is missing, inactive, or no longer matches its expected hash.',
      );
    }
  }
  return byIdentity;
}

async function assertAgentRun(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  origin: 'HUMAN' | 'AI',
  agentRunId: string | null,
): Promise<void> {
  if (origin === 'HUMAN') return;
  if (agentRunId === null) {
    throw new ConflictException('AI marketing candidates require a traceable Agent Run.');
  }
  const run = await transaction.agentRun.findFirst({
    where: { tenantId, id: agentRunId },
    select: { status: true },
  });
  if (run?.status !== 'SUCCEEDED') {
    throw new ConflictException(
      'AI marketing candidates require a completed, tenant-bound Agent Run.',
    );
  }
}

function mapObservation(
  record: {
    readonly id: string;
    readonly code: string;
    readonly version: number;
    readonly dimension: MarketingObservation['dimension'];
    readonly assertionType: MarketingObservation['assertionType'];
    readonly statement: string;
    readonly confidence: Prisma.Decimal;
    readonly origin: MarketingObservation['origin'];
    readonly agentRunId: string | null;
    readonly createdByUserId: string;
    readonly createdAt: Date;
  },
  evidence: ReadonlyArray<{
    readonly link: {
      readonly evidenceId: string;
      readonly evidenceVersion: number;
      readonly linkType: MarketingObservation['evidence'][number]['linkType'];
      readonly contentHash: string;
    };
    readonly evidence: Evidence;
  }>,
): MarketingObservation {
  return {
    id: record.id,
    code: record.code,
    version: record.version,
    dimension: record.dimension,
    assertionType: record.assertionType,
    statement: record.statement,
    confidence: record.confidence.toNumber(),
    origin: record.origin,
    agentRunId: record.agentRunId,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    evidence: evidence.map(({ link, evidence: source }) => ({
      evidenceId: link.evidenceId,
      evidenceVersion: link.evidenceVersion,
      linkType: link.linkType,
      sourceSystem: source.sourceSystem,
      sourceRecordId: source.sourceRecordId,
      sourceVersion: source.sourceVersion,
      contentHash: link.contentHash,
    })),
  };
}

function mapInsight(
  record: DbMarketingInsight,
  observationIds: readonly string[],
): MarketingInsight {
  return {
    id: record.id,
    code: record.code,
    version: record.version,
    revision: record.revision,
    title: record.title,
    statement: record.statement,
    origin: record.origin,
    agentRunId: record.agentRunId,
    status: record.status,
    createdByUserId: record.createdByUserId,
    reviewRequestedByUserId: record.reviewRequestedByUserId,
    reviewedByUserId: record.reviewedByUserId,
    publishedByUserId: record.publishedByUserId,
    reviewComment: record.reviewComment,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    observationIds: [...observationIds],
  };
}

function requiredEvidence(
  evidenceByIdentity: ReadonlyMap<string, Evidence>,
  id: string,
  version: number,
): Evidence {
  const evidence = evidenceByIdentity.get(`${id}:${version}`);
  if (evidence === undefined) {
    throw new ConflictException('Marketing evidence source identity is incomplete.');
  }
  return evidence;
}

function mapMarketingWriteError(error: unknown, resource: string): unknown {
  if (
    error instanceof ConflictException ||
    error instanceof NotFoundException ||
    error instanceof UnprocessableEntityException
  ) {
    return error;
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') {
      return new ConflictException(`${resource} code or idempotency key already exists.`);
    }
    if (error.code === 'P2003' || error.code === 'P2004') {
      return new ConflictException(`${resource} references invalid governed data.`);
    }
  }
  return error;
}
