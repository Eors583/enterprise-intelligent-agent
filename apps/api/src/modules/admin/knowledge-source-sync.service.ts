import { createHash } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  defineKnowledgePublicEvent,
  knowledgeSourceSyncFailureSchema,
  type CreateKnowledgeSourceConnectorRequest,
  type KnowledgeSourceConnector,
  type KnowledgeSourceConnectorListResponse,
  type KnowledgeSourceManifestItem,
  type KnowledgeSourceSyncFailure,
  type KnowledgeSourceSyncRun,
  type UpdateKnowledgeSourceConnectorRequest,
} from '@enterprise/contracts';
import { Prisma } from '@prisma/client';

import { AdminPrismaService } from '../../database/admin-prisma.service.js';
import { KnowledgeGateway } from '../knowledge-gateway/knowledge-gateway.port.js';
import { AdminAccessService } from './admin-access.service.js';
import { recordAdminAudit } from './admin-audit.js';
import {
  ControlledKnowledgeSourceFetcher,
  KnowledgeSourceFetchError,
} from './controlled-knowledge-source-fetcher.js';

const MAXIMUM_ITEMS_PER_SYNC = 1_000;

type ConnectorRecord = Prisma.KnowledgeSourceConnectorGetPayload<Record<string, never>>;
type RunRecord = Prisma.KnowledgeSourceSyncRunGetPayload<Record<string, never>>;

interface MutableSyncCounts {
  discoveredCount: number;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  deletedCount: number;
  failedCount: number;
}

@Injectable()
export class KnowledgeSourceSyncService {
  constructor(
    @Inject(AdminPrismaService) private readonly prisma: AdminPrismaService,
    @Inject(AdminAccessService) private readonly access: AdminAccessService,
    @Inject(KnowledgeGateway)
    private readonly ingestion: Pick<
      KnowledgeGateway,
      'upload' | 'uploadFileVersion' | 'archiveSearchDocument'
    >,
    @Inject(ControlledKnowledgeSourceFetcher)
    private readonly sourceFetcher: ControlledKnowledgeSourceFetcher,
  ) {}

  async list(knowledgeBaseId: string): Promise<KnowledgeSourceConnectorListResponse> {
    const principal = this.access.requireKnowledgeWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await requireKnowledgeBase(transaction, principal.tenantId, knowledgeBaseId);
      const connectors = await transaction.knowledgeSourceConnector.findMany({
        where: { tenantId: principal.tenantId, knowledgeBaseId },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      });
      return {
        items: await Promise.all(
          connectors.map(async (connector) => {
            const [itemCount, lastRun] = await Promise.all([
              transaction.knowledgeSourceItem.count({
                where: {
                  tenantId: principal.tenantId,
                  connectorId: connector.id,
                  status: 'ACTIVE',
                },
              }),
              transaction.knowledgeSourceSyncRun.findFirst({
                where: { tenantId: principal.tenantId, connectorId: connector.id },
                orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
              }),
            ]);
            return mapConnector(connector, itemCount, lastRun);
          }),
        ),
      };
    });
  }

  async create(
    knowledgeBaseId: string,
    request: CreateKnowledgeSourceConnectorRequest,
  ): Promise<KnowledgeSourceConnector> {
    const principal = this.access.requireKnowledgeWrite();
    this.assertAllowedManifestUrl(request.manifestUrl);
    const connector = await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await requireKnowledgeBase(transaction, principal.tenantId, knowledgeBaseId, true);
      const created = await transaction.knowledgeSourceConnector.create({
        data: {
          tenantId: principal.tenantId,
          knowledgeBaseId,
          name: request.name,
          manifestUrl: request.manifestUrl,
          createdById: principal.userId,
        },
      });
      await recordAdminAudit(
        transaction,
        principal,
        'admin.knowledge-source-connector.created',
        'knowledge_source_connector',
        created.id,
        { knowledgeBaseId, providerType: created.providerType },
      );
      return created;
    });
    return mapConnector(connector, 0, null);
  }

  async update(
    knowledgeBaseId: string,
    connectorId: string,
    request: UpdateKnowledgeSourceConnectorRequest,
  ): Promise<KnowledgeSourceConnector> {
    const principal = this.access.requireKnowledgeWrite();
    await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await requireConnector(transaction, principal.tenantId, knowledgeBaseId, connectorId);
      await transaction.knowledgeSourceConnector.updateMany({
        where: { tenantId: principal.tenantId, knowledgeBaseId, id: connectorId },
        data: { status: request.status },
      });
      await recordAdminAudit(
        transaction,
        principal,
        'admin.knowledge-source-connector.status-updated',
        'knowledge_source_connector',
        connectorId,
        { knowledgeBaseId, status: request.status },
      );
    });
    return this.get(knowledgeBaseId, connectorId);
  }

  async sync(knowledgeBaseId: string, connectorId: string): Promise<KnowledgeSourceSyncRun> {
    const principal = this.access.requireKnowledgeWrite();
    const { connector, run } = await this.prisma.withTenant(
      principal.tenantId,
      async (transaction) => {
        await requireKnowledgeBase(transaction, principal.tenantId, knowledgeBaseId, true);
        const connector = await requireConnector(
          transaction,
          principal.tenantId,
          knowledgeBaseId,
          connectorId,
        );
        if (connector.status !== 'ACTIVE') {
          throw new ConflictException('Paused document sources cannot be synchronized.');
        }
        this.assertAllowedManifestUrl(connector.manifestUrl);
        try {
          const run = await transaction.knowledgeSourceSyncRun.create({
            data: {
              tenantId: principal.tenantId,
              connectorId,
              cursorBefore: connector.cursor,
              requestedById: principal.userId,
            },
          });
          return { connector, run };
        } catch (error) {
          if (isUniqueConstraintError(error)) {
            throw new ConflictException('This document source is already synchronizing.');
          }
          throw error;
        }
      },
    );

    const counts: MutableSyncCounts = {
      discoveredCount: 0,
      createdCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      deletedCount: 0,
      failedCount: 0,
    };
    const failures: KnowledgeSourceSyncFailure[] = [];
    const seenExternalIds = new Set<string>();
    let cursor = connector.cursor;
    let pageCount = 0;

    try {
      while (true) {
        pageCount += 1;
        if (pageCount > this.sourceFetcher.maximumPages) {
          throw new KnowledgeSourceFetchError('KNOWLEDGE_SOURCE_MANIFEST_INVALID');
        }
        const manifest = await this.sourceFetcher.fetchManifest(connector.manifestUrl, cursor);
        if (counts.discoveredCount + manifest.items.length > MAXIMUM_ITEMS_PER_SYNC) {
          throw new BadRequestException(
            `A single synchronization can process at most ${MAXIMUM_ITEMS_PER_SYNC} items.`,
          );
        }
        for (const item of manifest.items) {
          counts.discoveredCount += 1;
          if (seenExternalIds.has(item.externalId)) {
            failures.push(
              knowledgeSourceSyncFailureSchema.parse({
                externalId: item.externalId,
                code: 'KNOWLEDGE_SOURCE_DUPLICATE_EXTERNAL_ID',
                message: 'The external ID appeared more than once in this synchronization.',
              }),
            );
            counts.failedCount += 1;
            continue;
          }
          seenExternalIds.add(item.externalId);
          try {
            const action = await this.applyItem({
              tenantId: principal.tenantId,
              knowledgeBaseId,
              connector,
              runId: run.id,
              item,
            });
            counts[`${action}Count`] += 1;
          } catch (error) {
            failures.push(describeItemFailure(item.externalId, error));
            counts.failedCount += 1;
          }
        }
        cursor = manifest.nextCursor;
        if (!manifest.hasMore) break;
      }
    } catch (error) {
      failures.push(describeItemFailure(null, error));
      counts.failedCount += 1;
    }

    const succeeded = failures.length === 0;
    const completed = await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const finishedAt = new Date();
      const updated = await transaction.knowledgeSourceSyncRun.update({
        where: { id: run.id },
        data: {
          status: succeeded ? 'SUCCEEDED' : 'FAILED',
          cursorAfter: succeeded ? cursor : connector.cursor,
          ...counts,
          failures: failures as unknown as Prisma.InputJsonValue,
          finishedAt,
        },
      });
      if (succeeded) {
        await transaction.knowledgeSourceConnector.updateMany({
          where: { tenantId: principal.tenantId, id: connectorId },
          data: { cursor, lastSyncedAt: finishedAt },
        });
      }
      await recordAdminAudit(
        transaction,
        principal,
        succeeded ? 'admin.knowledge-source-sync.succeeded' : 'admin.knowledge-source-sync.failed',
        'knowledge_source_sync_run',
        run.id,
        { knowledgeBaseId, connectorId, ...counts },
      );
      const publicEvent = succeeded
        ? defineKnowledgePublicEvent({
            eventType: 'knowledge.source-sync.succeeded.v1',
            payload: {
              knowledgeBaseId,
              connectorId,
              runId: run.id,
              ...counts,
              failedCount: 0,
            },
          })
        : defineKnowledgePublicEvent({
            eventType: 'knowledge.source-sync.failed.v1',
            payload: { knowledgeBaseId, connectorId, runId: run.id, ...counts },
          });
      await transaction.outboxEvent.create({
        data: {
          tenantId: principal.tenantId,
          aggregateType: 'knowledge_source_sync_run',
          aggregateId: run.id,
          eventType: publicEvent.eventType,
          payload: publicEvent.payload,
        },
      });
      return updated;
    });
    return mapRun(completed);
  }

  private async get(
    knowledgeBaseId: string,
    connectorId: string,
  ): Promise<KnowledgeSourceConnector> {
    const principal = this.access.requireKnowledgeWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const connector = await requireConnector(
        transaction,
        principal.tenantId,
        knowledgeBaseId,
        connectorId,
      );
      const [itemCount, lastRun] = await Promise.all([
        transaction.knowledgeSourceItem.count({
          where: { tenantId: principal.tenantId, connectorId, status: 'ACTIVE' },
        }),
        transaction.knowledgeSourceSyncRun.findFirst({
          where: { tenantId: principal.tenantId, connectorId },
          orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        }),
      ]);
      return mapConnector(connector, itemCount, lastRun);
    });
  }

  private assertAllowedManifestUrl(manifestUrl: string): void {
    try {
      this.sourceFetcher.assertAllowedUrl(manifestUrl);
    } catch (error) {
      if (error instanceof KnowledgeSourceFetchError) {
        throw new BadRequestException(error.code);
      }
      throw error;
    }
  }

  private async applyItem(input: {
    readonly tenantId: string;
    readonly knowledgeBaseId: string;
    readonly connector: ConnectorRecord;
    readonly runId: string;
    readonly item: KnowledgeSourceManifestItem;
  }): Promise<'created' | 'updated' | 'skipped' | 'deleted'> {
    const existing = await this.prisma.withTenant(input.tenantId, (transaction) =>
      transaction.knowledgeSourceItem.findUnique({
        where: {
          tenantId_connectorId_externalId: {
            tenantId: input.tenantId,
            connectorId: input.connector.id,
            externalId: input.item.externalId,
          },
        },
      }),
    );

    if (input.item.deleted) {
      if (existing === null || existing.status === 'DELETED') {
        await this.persistSkippedTombstone(input, existing?.id ?? null);
        return 'skipped';
      }
      if (existing.documentId !== null) {
        const documentId = existing.documentId;
        await this.prisma.withTenant(input.tenantId, async (transaction) => {
          await transaction.knowledgeDocument.updateMany({
            where: {
              tenantId: input.tenantId,
              knowledgeBaseId: input.knowledgeBaseId,
              id: documentId,
              status: { not: 'ARCHIVED' },
            },
            data: { status: 'ARCHIVED' },
          });
        });
        await this.ingestion.archiveSearchDocument({ documentId });
      }
      await this.prisma.withTenant(input.tenantId, (transaction) =>
        transaction.knowledgeSourceItem.update({
          where: { id: existing.id },
          data: {
            status: 'DELETED',
            sourceRevision: input.item.sourceRevision,
            lastSeenRunId: input.runId,
          },
        }),
      );
      return 'deleted';
    }

    if (
      existing?.status === 'ACTIVE' &&
      existing.sourceRevision === input.item.sourceRevision &&
      existing.documentId !== null
    ) {
      await this.touchSourceItem(existing.id, input.runId, input.item);
      return 'skipped';
    }

    const downloadUrl = input.item.downloadUrl;
    if (downloadUrl === null) {
      throw new KnowledgeSourceFetchError('KNOWLEDGE_SOURCE_MANIFEST_INVALID');
    }
    const bytes = await this.sourceFetcher.fetchFile(downloadUrl);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (input.item.sha256 !== null && input.item.sha256 !== sha256) {
      throw new KnowledgeSourceFetchError('KNOWLEDGE_SOURCE_CHECKSUM_MISMATCH');
    }
    if (existing?.status === 'ACTIVE' && existing.sha256 === sha256) {
      await this.touchSourceItem(existing.id, input.runId, input.item, sha256);
      return 'skipped';
    }

    const linkedDocument =
      existing?.documentId === null || existing?.documentId === undefined
        ? null
        : await this.prisma.withTenant(input.tenantId, (transaction) =>
            transaction.knowledgeDocument.findFirst({
              where: {
                tenantId: input.tenantId,
                knowledgeBaseId: input.knowledgeBaseId,
                id: existing.documentId!,
              },
              select: { id: true, status: true },
            }),
          );
    const sourceUri = input.item.sourceUri ?? input.connector.manifestUrl;
    const common = {
      knowledgeBaseId: input.knowledgeBaseId,
      title: input.item.title,
      bytes,
      mimeType: input.item.mimeType,
      fileName: input.item.fileName,
      sourceUri,
      changeSummary: `文档源同步：${input.item.sourceRevision}`,
    };
    const createNew = linkedDocument === null || linkedDocument.status === 'ARCHIVED';
    const documentId = createNew
      ? await this.ingestion.upload(common)
      : await this.ingestion.uploadFileVersion({ ...common, documentId: linkedDocument.id });

    await this.prisma.withTenant(input.tenantId, async (transaction) => {
      await transaction.knowledgeDocument.updateMany({
        where: { tenantId: input.tenantId, id: documentId },
        data: { title: input.item.title },
      });
      await transaction.knowledgeSourceItem.upsert({
        where: {
          tenantId_connectorId_externalId: {
            tenantId: input.tenantId,
            connectorId: input.connector.id,
            externalId: input.item.externalId,
          },
        },
        create: {
          tenantId: input.tenantId,
          connectorId: input.connector.id,
          externalId: input.item.externalId,
          sourceRevision: input.item.sourceRevision,
          sha256,
          sourceUri: input.item.sourceUri,
          fileName: input.item.fileName,
          mimeType: input.item.mimeType,
          sourceModifiedAt: input.item.modifiedAt === null ? null : new Date(input.item.modifiedAt),
          documentId,
          status: 'ACTIVE',
          lastSeenRunId: input.runId,
        },
        update: {
          sourceRevision: input.item.sourceRevision,
          sha256,
          sourceUri: input.item.sourceUri,
          fileName: input.item.fileName,
          mimeType: input.item.mimeType,
          sourceModifiedAt: input.item.modifiedAt === null ? null : new Date(input.item.modifiedAt),
          documentId,
          status: 'ACTIVE',
          lastSeenRunId: input.runId,
        },
      });
    });
    return createNew ? 'created' : 'updated';
  }

  private touchSourceItem(
    sourceItemId: string,
    runId: string,
    item: KnowledgeSourceManifestItem,
    sha256?: string,
  ): Promise<unknown> {
    const principal = this.access.requireKnowledgeWrite();
    return this.prisma.withTenant(principal.tenantId, (transaction) =>
      transaction.knowledgeSourceItem.update({
        where: { id: sourceItemId },
        data: {
          sourceRevision: item.sourceRevision,
          ...(sha256 === undefined ? {} : { sha256 }),
          sourceUri: item.sourceUri,
          fileName: item.fileName,
          mimeType: item.mimeType,
          sourceModifiedAt: item.modifiedAt === null ? null : new Date(item.modifiedAt),
          status: 'ACTIVE',
          lastSeenRunId: runId,
        },
      }),
    );
  }

  private persistSkippedTombstone(
    input: {
      readonly tenantId: string;
      readonly connector: ConnectorRecord;
      readonly runId: string;
      readonly item: KnowledgeSourceManifestItem;
    },
    existingId: string | null,
  ): Promise<unknown> {
    return this.prisma.withTenant(input.tenantId, (transaction) =>
      existingId === null
        ? transaction.knowledgeSourceItem.create({
            data: {
              tenantId: input.tenantId,
              connectorId: input.connector.id,
              externalId: input.item.externalId,
              sourceRevision: input.item.sourceRevision,
              sha256: input.item.sha256,
              sourceUri: input.item.sourceUri,
              fileName: input.item.fileName,
              mimeType: input.item.mimeType,
              sourceModifiedAt:
                input.item.modifiedAt === null ? null : new Date(input.item.modifiedAt),
              status: 'DELETED',
              lastSeenRunId: input.runId,
            },
          })
        : transaction.knowledgeSourceItem.update({
            where: { id: existingId },
            data: {
              sourceRevision: input.item.sourceRevision,
              status: 'DELETED',
              lastSeenRunId: input.runId,
            },
          }),
    );
  }
}

async function requireKnowledgeBase(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  knowledgeBaseId: string,
  requireActive = false,
): Promise<void> {
  const knowledgeBase = await transaction.knowledgeBase.findFirst({
    where: { tenantId, id: knowledgeBaseId },
    select: { status: true },
  });
  if (knowledgeBase === null || (requireActive && knowledgeBase.status === 'ARCHIVED')) {
    throw new NotFoundException('The active knowledge base was not found.');
  }
}

async function requireConnector(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  knowledgeBaseId: string,
  connectorId: string,
): Promise<ConnectorRecord> {
  const connector = await transaction.knowledgeSourceConnector.findFirst({
    where: { tenantId, knowledgeBaseId, id: connectorId },
  });
  if (connector === null) throw new NotFoundException('The document source was not found.');
  return connector;
}

function mapConnector(
  connector: ConnectorRecord,
  itemCount: number,
  lastRun: RunRecord | null,
): KnowledgeSourceConnector {
  return {
    id: connector.id,
    knowledgeBaseId: connector.knowledgeBaseId,
    name: connector.name,
    providerType: 'HTTPS_MANIFEST',
    manifestUrl: connector.manifestUrl,
    status: connector.status,
    cursor: connector.cursor,
    itemCount,
    lastSyncedAt: connector.lastSyncedAt?.toISOString() ?? null,
    lastRun: lastRun === null ? null : mapRun(lastRun),
    createdAt: connector.createdAt.toISOString(),
    updatedAt: connector.updatedAt.toISOString(),
  };
}

function mapRun(run: RunRecord): KnowledgeSourceSyncRun {
  return {
    id: run.id,
    connectorId: run.connectorId,
    status: run.status,
    cursorBefore: run.cursorBefore,
    cursorAfter: run.cursorAfter,
    discoveredCount: run.discoveredCount,
    createdCount: run.createdCount,
    updatedCount: run.updatedCount,
    skippedCount: run.skippedCount,
    deletedCount: run.deletedCount,
    failedCount: run.failedCount,
    failures: Array.isArray(run.failures)
      ? run.failures.map((failure) => knowledgeSourceSyncFailureSchema.parse(failure))
      : [],
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

function describeItemFailure(
  externalId: string | null,
  error: unknown,
): KnowledgeSourceSyncFailure {
  if (error instanceof KnowledgeSourceFetchError) {
    return { externalId, code: error.code, message: error.code };
  }
  if (error instanceof BadRequestException || error instanceof ConflictException) {
    const response = error.getResponse();
    const message = typeof response === 'string' ? response : error.message;
    return { externalId, code: 'KNOWLEDGE_SOURCE_ITEM_REJECTED', message };
  }
  return {
    externalId,
    code: 'KNOWLEDGE_SOURCE_INGESTION_FAILED',
    message:
      error instanceof Error
        ? 'The source file could not be queued for knowledge ingestion.'
        : 'Unknown synchronization error.',
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
