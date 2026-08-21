import { Inject, Injectable } from '@nestjs/common';

import { AdminPrismaService } from '../../../database/admin-prisma.service.js';
import { LexiangClient } from '../infrastructure/lexiang/lexiang.client.js';
import { LexiangCredentialVault } from '../infrastructure/lexiang/lexiang-credential-vault.js';
import { LexiangProviderError } from '../infrastructure/lexiang/lexiang-token.provider.js';

export interface ExternalKnowledgeEvidence {
  readonly evidenceId: string;
  readonly knowledgeBaseId: string;
  readonly knowledgeBaseName: string;
  readonly title: string;
  readonly content: string;
  readonly sourceUri: string;
  readonly score: number | null;
  readonly updatedAt: Date;
}

export interface ExternalKnowledgeSearchResponse {
  readonly searchedKnowledgeBaseIds: readonly string[];
  readonly items: readonly ExternalKnowledgeEvidence[];
}

export class KnowledgeProviderRetrievalError extends Error {
  constructor(
    readonly code: string,
    readonly knowledgeBaseIds: readonly string[],
  ) {
    super(code);
    this.name = 'KnowledgeProviderRetrievalError';
  }
}

@Injectable()
export class KnowledgeProviderRetrievalService {
  constructor(
    @Inject(AdminPrismaService) private readonly prisma: AdminPrismaService,
    @Inject(LexiangCredentialVault) private readonly vault: LexiangCredentialVault,
    @Inject(LexiangClient) private readonly lexiang: LexiangClient,
  ) {}

  async search(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly knowledgeBaseIds: readonly string[];
    readonly query: string;
    readonly limit: number;
  }): Promise<ExternalKnowledgeSearchResponse> {
    const targets = await this.loadTargets(input.tenantId, input.userId, input.knowledgeBaseIds);
    if (targets.length === 0) return { searchedKnowledgeBaseIds: [], items: [] };

    try {
      const searched = await Promise.all(
        targets.map(async (target) => {
          const evidence = await this.lexiang.search({
            connectionId: target.connection.id,
            credential: {
              appKey: target.connection.appKey,
              appSecret: this.vault.decrypt(target.connection.credentialCiphertext, {
                tenantId: input.tenantId,
                appKey: target.connection.appKey,
              }),
            },
            staffId: target.connection.operatorStaffId,
            query: input.query,
            targets: [{ type: 'space', id: target.externalSpaceId }],
            topN: input.limit,
          });
          return evidence.map((item) => ({
            evidenceId: item.evidenceId,
            knowledgeBaseId: target.knowledgeBaseId,
            knowledgeBaseName: target.knowledgeBase.name,
            title: item.title,
            content: item.content,
            sourceUri: item.url,
            score: item.score,
            updatedAt: target.lastSyncedAt ?? target.updatedAt,
          }));
        }),
      );
      return {
        searchedKnowledgeBaseIds: targets.map((target) => target.knowledgeBaseId),
        items: searched.flat(),
      };
    } catch (error) {
      throw new KnowledgeProviderRetrievalError(
        error instanceof LexiangProviderError ? error.code : 'LEXIANG_SEARCH_UNAVAILABLE',
        targets.map((target) => target.knowledgeBaseId),
      );
    }
  }

  async areKnowledgeBasesRetrievable(
    tenantId: string,
    userId: string,
    knowledgeBaseIds: readonly string[],
  ): Promise<boolean> {
    const requested = [...new Set(knowledgeBaseIds)].slice(0, 50);
    if (requested.length === 0) return true;
    const targets = await this.loadTargets(tenantId, userId, requested);
    return targets.length === requested.length;
  }

  private async loadTargets(tenantId: string, userId: string, knowledgeBaseIds: readonly string[]) {
    // The requester remains part of the public retrieval context because BMS
    // ACLs are evaluated before and after provider retrieval. Lexiang uses the
    // connection operator only as the external API access identity.
    void userId;
    const requested = [...new Set(knowledgeBaseIds)].slice(0, 50);
    if (requested.length === 0) return [];
    return this.prisma.withTenant(tenantId, async (transaction) => {
      const targets = await transaction.knowledgeExternalSpaceBinding.findMany({
        where: {
          tenantId,
          knowledgeBaseId: { in: requested },
          provider: 'LEXIANG',
          status: 'ACTIVE',
          externalSpaceId: { not: null },
          connection: {
            is: {
              status: 'ACTIVE',
              credentialCiphertext: { not: null },
              operatorStaffId: { not: null },
            },
          },
        },
        select: {
          knowledgeBaseId: true,
          externalSpaceId: true,
          lastSyncedAt: true,
          updatedAt: true,
          knowledgeBase: { select: { name: true } },
          connection: {
            select: {
              id: true,
              appKey: true,
              credentialCiphertext: true,
              operatorStaffId: true,
            },
          },
        },
        orderBy: { knowledgeBaseId: 'asc' },
      });
      return targets.flatMap((target) =>
        target.externalSpaceId === null ||
        target.connection.credentialCiphertext === null ||
        target.connection.operatorStaffId === null ||
        target.connection.operatorStaffId.trim() === ''
          ? []
          : [
              {
                ...target,
                externalSpaceId: target.externalSpaceId,
                connection: {
                  ...target.connection,
                  credentialCiphertext: target.connection.credentialCiphertext,
                  operatorStaffId: target.connection.operatorStaffId!,
                },
              },
            ],
      );
    });
  }
}
