import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { KnowledgeCitationDetail } from '@enterprise/contracts';

import { PrismaService } from '../../database/prisma.service.js';
import { IdentityService } from '../identity/application/identity.service.js';
import { accessibleKnowledgeBaseIds } from './knowledge-access.policy.js';

@Injectable()
export class KnowledgeCitationService {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async getOriginal(documentVersionId: string, chunkId: string): Promise<KnowledgeCitationDetail> {
    const { user } = await this.identity.getCurrentIdentity();
    return this.prisma.withTenant(user.tenantId, async (transaction) => {
      const [storedUser, employments, orgUnits, chunk] = await Promise.all([
        transaction.user.findFirst({
          where: { tenantId: user.tenantId, id: user.id },
          select: { status: true },
        }),
        transaction.employment.findMany({
          where: { tenantId: user.tenantId, userId: user.id, status: 'ACTIVE' },
          select: { orgUnitId: true },
        }),
        transaction.orgUnit.findMany({
          where: { tenantId: user.tenantId, status: 'ACTIVE' },
          select: { id: true, parentId: true },
        }),
        transaction.knowledgeChunk.findFirst({
          where: {
            tenantId: user.tenantId,
            id: chunkId,
            documentVersionId,
          },
          select: {
            id: true,
            tenantId: true,
            knowledgeBaseId: true,
            documentId: true,
            documentVersionId: true,
            headingPath: true,
            content: true,
            knowledgeBase: {
              select: {
                id: true,
                tenantId: true,
                name: true,
                status: true,
                orgUnits: { select: { orgUnitId: true, includeChildren: true } },
              },
            },
            document: {
              select: {
                id: true,
                tenantId: true,
                knowledgeBaseId: true,
                title: true,
                status: true,
              },
            },
            documentVersion: {
              select: {
                id: true,
                tenantId: true,
                knowledgeBaseId: true,
                documentId: true,
                versionNumber: true,
                sourceType: true,
                status: true,
                createdAt: true,
                publishedAt: true,
              },
            },
          },
        }),
      ]);

      if (storedUser?.status !== 'ACTIVE' || chunk === null) throw this.notFound();

      const activeOrgUnitIds = new Set(orgUnits.map((orgUnit) => orgUnit.id));
      const memberOrgUnitIds = new Set(
        employments
          .map((employment) => employment.orgUnitId)
          .filter((orgUnitId) => activeOrgUnitIds.has(orgUnitId)),
      );
      // Enterprise knowledge access requires a currently active employment. This makes
      // departure and directory-sync deactivation effective immediately, including for
      // knowledge bases that are otherwise visible to the whole tenant.
      if (memberOrgUnitIds.size === 0) throw this.notFound();

      if (
        chunk.tenantId !== user.tenantId ||
        chunk.documentVersionId !== documentVersionId ||
        chunk.id !== chunkId ||
        chunk.knowledgeBase.tenantId !== user.tenantId ||
        chunk.document.tenantId !== user.tenantId ||
        chunk.documentVersion.tenantId !== user.tenantId ||
        chunk.knowledgeBaseId !== chunk.knowledgeBase.id ||
        chunk.documentId !== chunk.document.id ||
        chunk.documentVersionId !== chunk.documentVersion.id ||
        chunk.document.knowledgeBaseId !== chunk.knowledgeBaseId ||
        chunk.documentVersion.knowledgeBaseId !== chunk.knowledgeBaseId ||
        chunk.documentVersion.documentId !== chunk.documentId
      ) {
        throw this.notFound();
      }

      if (
        chunk.knowledgeBase.status === 'DRAFT' ||
        (chunk.documentVersion.status !== 'READY' && chunk.documentVersion.status !== 'ARCHIVED')
      ) {
        throw this.notFound();
      }

      const accessibleIds = accessibleKnowledgeBaseIds({
        userActive: true,
        memberOrgUnitIds,
        parentByOrgUnitId: new Map(orgUnits.map((orgUnit) => [orgUnit.id, orgUnit.parentId])),
        knowledgeBases: [chunk.knowledgeBase],
      });
      if (!accessibleIds.includes(chunk.knowledgeBaseId)) throw this.notFound();

      return {
        knowledgeBaseId: chunk.knowledgeBaseId,
        knowledgeBaseName: chunk.knowledgeBase.name,
        documentId: chunk.documentId,
        documentTitle: chunk.document.title,
        documentVersionId: chunk.documentVersionId,
        documentVersion: chunk.documentVersion.versionNumber,
        chunkId: chunk.id,
        headingPath: chunk.headingPath,
        sourceType: chunk.documentVersion.sourceType,
        content: chunk.content,
        updatedAt: (
          chunk.documentVersion.publishedAt ?? chunk.documentVersion.createdAt
        ).toISOString(),
      };
    });
  }

  private notFound(): NotFoundException {
    return new NotFoundException(
      'Knowledge citation source was not found or is no longer accessible.',
    );
  }
}
