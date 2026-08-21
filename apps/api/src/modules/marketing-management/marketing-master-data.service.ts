import { randomUUID } from 'node:crypto';

import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateMarketingMasterDataRequest,
  MarketingMasterData,
  UpdateMarketingMasterDataRequest,
} from '@enterprise/contracts';
import { Prisma } from '@prisma/client';

import {
  assertMarketingReplay,
  lockMarketingKey,
  marketingRequestIdentity,
  recordMarketingMutation,
} from './marketing-persistence.js';
import { AdminPrismaService } from '../../database/admin-prisma.service.js';
import { AdminAccessService } from '../admin/admin-access.service.js';

export type MarketingMasterDataKind = 'PRODUCT' | 'REGION' | 'CUSTOMER_SEGMENT';

interface MarketingMasterRecord {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly status: 'ACTIVE' | 'RETIRED';
  readonly revision: number;
  readonly requestHash: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

@Injectable()
export class MarketingMasterDataService {
  constructor(
    @Inject(AdminPrismaService) private readonly prisma: AdminPrismaService,
    @Inject(AdminAccessService) private readonly access: AdminAccessService,
  ) {}

  async list(kind: MarketingMasterDataKind): Promise<{ readonly items: MarketingMasterData[] }> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const records =
        kind === 'PRODUCT'
          ? await transaction.marketingProduct.findMany({
              where: { tenantId: principal.tenantId },
              orderBy: [{ status: 'asc' }, { code: 'asc' }],
              take: 500,
            })
          : kind === 'REGION'
            ? await transaction.marketingRegion.findMany({
                where: { tenantId: principal.tenantId },
                orderBy: [{ status: 'asc' }, { code: 'asc' }],
                take: 500,
              })
            : await transaction.marketingCustomerSegment.findMany({
                where: { tenantId: principal.tenantId },
                orderBy: [{ status: 'asc' }, { code: 'asc' }],
                take: 500,
              });
      return { items: records.map(mapMaster) };
    });
  }

  async create(
    kind: MarketingMasterDataKind,
    request: CreateMarketingMasterDataRequest,
  ): Promise<MarketingMasterData> {
    const principal = this.access.requireDirectoryWrite();
    const identity = marketingRequestIdentity(request);
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        await lockMarketingKey(transaction, principal.tenantId, `master:${kind}`, identity.key);
        const replay = await findByIdempotency(transaction, kind, principal.tenantId, identity.key);
        if (replay !== null) {
          assertMarketingReplay(replay, identity.requestHash);
          return mapMaster(replay);
        }
        const data = {
          id: randomUUID(),
          tenantId: principal.tenantId,
          code: request.code,
          name: request.name,
          description: request.description,
          idempotencyKey: identity.key,
          requestHash: identity.requestHash,
        };
        const created =
          kind === 'PRODUCT'
            ? await transaction.marketingProduct.create({ data })
            : kind === 'REGION'
              ? await transaction.marketingRegion.create({ data })
              : await transaction.marketingCustomerSegment.create({ data });
        await recordMarketingMutation(
          transaction,
          principal,
          `marketing.${kind.toLowerCase()}.created`,
          `marketing_${kind.toLowerCase()}`,
          created.id,
          { code: created.code },
        );
        return mapMaster(created);
      });
    } catch (error) {
      throw mapMasterError(error, kind);
    }
  }

  async update(
    kind: MarketingMasterDataKind,
    id: string,
    request: UpdateMarketingMasterDataRequest,
  ): Promise<MarketingMasterData> {
    const principal = this.access.requireDirectoryWrite();
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        const current = await findById(transaction, kind, principal.tenantId, id);
        if (current === null) throw new NotFoundException(`${kind} master data was not found.`);
        if (current.revision !== request.expectedRevision) {
          throw new ConflictException(`${kind} master data changed. Refresh and try again.`);
        }
        const data = {
          ...(request.name === undefined ? {} : { name: request.name }),
          ...(request.description === undefined ? {} : { description: request.description }),
          ...(request.status === undefined ? {} : { status: request.status }),
          revision: { increment: 1 as const },
        };
        const changed =
          kind === 'PRODUCT'
            ? await transaction.marketingProduct.updateMany({
                where: {
                  tenantId: principal.tenantId,
                  id,
                  revision: request.expectedRevision,
                },
                data,
              })
            : kind === 'REGION'
              ? await transaction.marketingRegion.updateMany({
                  where: {
                    tenantId: principal.tenantId,
                    id,
                    revision: request.expectedRevision,
                  },
                  data,
                })
              : await transaction.marketingCustomerSegment.updateMany({
                  where: {
                    tenantId: principal.tenantId,
                    id,
                    revision: request.expectedRevision,
                  },
                  data,
                });
        if (changed.count !== 1) {
          throw new ConflictException(`${kind} master data changed. Refresh and try again.`);
        }
        await recordMarketingMutation(
          transaction,
          principal,
          `marketing.${kind.toLowerCase()}.updated`,
          `marketing_${kind.toLowerCase()}`,
          id,
          {
            expectedRevision: request.expectedRevision,
            status: request.status ?? current.status,
          },
        );
        const updated = await findById(transaction, kind, principal.tenantId, id);
        if (updated === null) throw new NotFoundException(`${kind} master data was not found.`);
        return mapMaster(updated);
      });
    } catch (error) {
      throw mapMasterError(error, kind);
    }
  }
}

async function findByIdempotency(
  transaction: Prisma.TransactionClient,
  kind: MarketingMasterDataKind,
  tenantId: string,
  idempotencyKey: string,
): Promise<MarketingMasterRecord | null> {
  if (kind === 'PRODUCT') {
    return transaction.marketingProduct.findFirst({ where: { tenantId, idempotencyKey } });
  }
  if (kind === 'REGION') {
    return transaction.marketingRegion.findFirst({ where: { tenantId, idempotencyKey } });
  }
  return transaction.marketingCustomerSegment.findFirst({
    where: { tenantId, idempotencyKey },
  });
}

async function findById(
  transaction: Prisma.TransactionClient,
  kind: MarketingMasterDataKind,
  tenantId: string,
  id: string,
): Promise<MarketingMasterRecord | null> {
  if (kind === 'PRODUCT') {
    return transaction.marketingProduct.findFirst({ where: { tenantId, id } });
  }
  if (kind === 'REGION') {
    return transaction.marketingRegion.findFirst({ where: { tenantId, id } });
  }
  return transaction.marketingCustomerSegment.findFirst({ where: { tenantId, id } });
}

function mapMaster(record: MarketingMasterRecord): MarketingMasterData {
  return {
    id: record.id,
    code: record.code,
    name: record.name,
    description: record.description,
    status: record.status,
    revision: record.revision,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function mapMasterError(error: unknown, kind: MarketingMasterDataKind): unknown {
  if (error instanceof ConflictException || error instanceof NotFoundException) return error;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') {
      return new ConflictException(`${kind} code or idempotency key already exists.`);
    }
    if (error.code === 'P2003' || error.code === 'P2004') {
      return new ConflictException(`${kind} is still referenced by governed marketing data.`);
    }
  }
  return error;
}
