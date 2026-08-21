import { createHash } from 'node:crypto';

import { BadGatewayException, BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { KnowledgeBaseExternalSpace } from '@enterprise/contracts';
import type { KnowledgeExternalSpaceBinding, KnowledgeProviderConnection } from '@prisma/client';

import { AdminPrismaService } from '../../../database/admin-prisma.service.js';
import type { AdminPrincipal } from '../../admin/admin-access.service.js';
import { recordAdminAudit } from '../../admin/admin-audit.js';
import { LexiangCredentialVault } from '../infrastructure/lexiang/lexiang-credential-vault.js';
import type {
  LexiangEntry,
  LexiangSpace,
} from '../infrastructure/lexiang/lexiang-response.schemas.js';
import { LexiangSpaceClient } from '../infrastructure/lexiang/lexiang-space.client.js';
import {
  LexiangProviderError,
  type LexiangCredential,
} from '../infrastructure/lexiang/lexiang-token.provider.js';

type ConnectionRecord = Pick<
  KnowledgeProviderConnection,
  'id' | 'status' | 'appKey' | 'teamId' | 'operatorStaffId' | 'credentialCiphertext'
>;

export interface LexiangEntrySyncSummary {
  readonly entriesDiscovered: number;
  readonly foldersSynchronized: number;
  readonly documentsDiscovered: number;
  readonly documentsImported: number;
  readonly documentsUpdated: number;
  readonly documentsArchived: number;
}

const LEXIANG_FILE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'bmp',
  'webp',
  'tiff',
  'gif',
  'doc',
  'dot',
  'wps',
  'wpt',
  'docx',
  'dotx',
  'docm',
  'dotm',
  'xls',
  'xlt',
  'et',
  'ett',
  'xlsx',
  'xltx',
  'csv',
  'xlsb',
  'xlsm',
  'xltm',
  'ets',
  'pptx',
  'ppt',
  'pot',
  'potx',
  'pps',
  'ppsx',
  'dps',
  'dpt',
  'pptm',
  'potm',
  'ppsm',
  'pdf',
  'txt',
]);

@Injectable()
export class KnowledgeProviderSpaceService {
  constructor(
    @Inject(AdminPrismaService) private readonly prisma: AdminPrismaService,
    @Inject(LexiangCredentialVault) private readonly vault: LexiangCredentialVault,
    @Inject(LexiangSpaceClient) private readonly spaces: LexiangSpaceClient,
  ) {}

  async assertLexiangReady(tenantId: string): Promise<void> {
    await this.loadConnection(tenantId);
  }

  async list(
    tenantId: string,
    knowledgeBaseIds: readonly string[],
  ): Promise<ReadonlyMap<string, KnowledgeBaseExternalSpace>> {
    if (knowledgeBaseIds.length === 0) return new Map();
    const bindings = await this.prisma.withTenant(tenantId, (transaction) =>
      transaction.knowledgeExternalSpaceBinding.findMany({
        where: { tenantId, knowledgeBaseId: { in: [...knowledgeBaseIds] } },
      }),
    );
    return new Map(bindings.map((binding) => [binding.knowledgeBaseId, mapBinding(binding)]));
  }

  async isManaged(tenantId: string, knowledgeBaseId: string): Promise<boolean> {
    const binding = await this.prisma.withTenant(tenantId, (transaction) =>
      transaction.knowledgeExternalSpaceBinding.findUnique({
        where: { tenantId_knowledgeBaseId: { tenantId, knowledgeBaseId } },
        select: { id: true },
      }),
    );
    return binding !== null;
  }

  async listRemote(principal: AdminPrincipal): Promise<readonly LexiangSpace[]> {
    const connection = await this.loadConnection(principal.tenantId);
    const context = {
      connectionId: connection.id,
      credential: this.credential(principal.tenantId, connection),
      teamId: connection.teamId!,
    };
    const listed = await this.spaces.listSpaces(context);
    const remote: LexiangSpace[] = [];
    for (let index = 0; index < listed.length; index += 20) {
      remote.push(
        ...(await Promise.all(
          listed
            .slice(index, index + 20)
            .map((item) => this.spaces.getSpace({ ...context, spaceId: item.id })),
        )),
      );
    }
    if (remote.some((space) => space.teamId !== connection.teamId)) {
      throw new BadGatewayException('乐享返回了绑定团队之外的知识库，已停止同步。');
    }
    return remote;
  }

  async syncEntries(
    principal: AdminPrincipal,
    knowledgeBaseId: string,
  ): Promise<LexiangEntrySyncSummary> {
    const loaded = await this.loadBindingWithConnection(principal.tenantId, knowledgeBaseId);
    if (
      loaded === null ||
      loaded.binding.externalSpaceId === null ||
      loaded.binding.status === 'DELETED'
    ) {
      throw new BadRequestException('该知识库没有可同步的腾讯乐享文档目录。');
    }
    const externalSpaceId = loaded.binding.externalSpaceId;
    const entries = await this.spaces.listEntries({
      connectionId: loaded.connection.id,
      credential: this.credential(principal.tenantId, loaded.connection),
      spaceId: externalSpaceId,
    });
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
      throw new BadGatewayException('乐享返回了重复的知识节点，已停止文档目录同步。');
    }
    return this.prisma.withTenant(
      principal.tenantId,
      async (transaction) => {
        const existing = await transaction.knowledgeExternalEntryBinding.findMany({
          where: { tenantId: principal.tenantId, knowledgeBaseId },
          include: {
            folder: { select: { id: true, path: true } },
            document: { select: { id: true } },
          },
        });
        const existingByExternalId = new Map(
          existing.map((binding) => [binding.externalEntryId, binding]),
        );
        const synchronizedAt = new Date();
        const remoteIds = new Set(entries.map((entry) => entry.id));
        const folderState = new Map<string, { readonly id: string; readonly path: string }>();
        let foldersSynchronized = 0;
        let documentsImported = 0;
        let documentsUpdated = 0;
        let documentsArchived = 0;

        for (const entry of entries.filter((candidate) => candidate.entryType === 'folder')) {
          const previous = existingByExternalId.get(entry.id);
          if (previous !== undefined && previous.folderId === null) {
            throw new BadGatewayException('乐享知识节点类型发生变化，已停止同步以保护本地记录。');
          }
          const parent =
            entry.parentEntryId === null ? undefined : folderState.get(entry.parentEntryId);
          const path = externalFolderPath(parent?.path ?? null, entry);
          const remoteCreatedAt = parseLexiangDate(entry.createdAt);
          const remoteUpdatedAt = parseLexiangDate(entry.updatedAt);
          let folderId = previous?.folderId ?? null;
          if (folderId === null) {
            const folder = await transaction.knowledgeFolder.create({
              data: {
                tenantId: principal.tenantId,
                knowledgeBaseId,
                parentId: parent?.id ?? null,
                name: boundedName(entry.name, 200),
                path,
                createdById: principal.userId,
                ...(remoteCreatedAt === null ? {} : { createdAt: remoteCreatedAt }),
                ...(remoteUpdatedAt === null ? {} : { updatedAt: remoteUpdatedAt }),
              },
            });
            folderId = folder.id;
            await transaction.knowledgeExternalEntryBinding.create({
              data: {
                tenantId: principal.tenantId,
                knowledgeBaseId,
                provider: 'LEXIANG',
                externalSpaceId,
                externalEntryId: entry.id,
                externalParentEntryId: entry.parentEntryId,
                entryType: entry.entryType,
                folderId,
                remoteName: entry.name,
                remoteCreatedAt,
                remoteUpdatedAt,
                lastSyncedAt: synchronizedAt,
              },
            });
          } else {
            await transaction.knowledgeFolder.update({
              where: { id: folderId },
              data: {
                parentId: parent?.id ?? null,
                name: boundedName(entry.name, 200),
                path,
                ...(remoteUpdatedAt === null ? {} : { updatedAt: remoteUpdatedAt }),
              },
            });
            await transaction.knowledgeExternalEntryBinding.update({
              where: { id: previous!.id },
              data: {
                externalParentEntryId: entry.parentEntryId,
                remoteName: entry.name,
                remoteCreatedAt,
                remoteUpdatedAt,
                lastSyncedAt: synchronizedAt,
              },
            });
          }
          folderState.set(entry.id, { id: folderId, path });
          foldersSynchronized += 1;
        }

        for (const entry of entries.filter((candidate) => candidate.entryType !== 'folder')) {
          const previous = existingByExternalId.get(entry.id);
          if (previous !== undefined && previous.documentId === null) {
            throw new BadGatewayException('乐享知识节点类型发生变化，已停止同步以保护本地记录。');
          }
          const folder =
            entry.parentEntryId === null ? undefined : folderState.get(entry.parentEntryId);
          const remoteCreatedAt = parseLexiangDate(entry.createdAt);
          const remoteUpdatedAt = parseLexiangDate(entry.updatedAt);
          let documentId = previous?.documentId ?? null;
          if (documentId === null) {
            const document = await transaction.knowledgeDocument.create({
              data: {
                tenantId: principal.tenantId,
                knowledgeBaseId,
                folderId: folder?.id ?? null,
                title: entry.name,
                sourceType: 'FILE',
                mimeType: lexiangEntryMimeType(entry.entryType),
                fileName: entry.name,
                status: 'DRAFT',
                createdById: principal.userId,
                ...(remoteCreatedAt === null ? {} : { createdAt: remoteCreatedAt }),
                ...(remoteUpdatedAt === null ? {} : { updatedAt: remoteUpdatedAt }),
              },
            });
            documentId = document.id;
            await transaction.knowledgeExternalEntryBinding.create({
              data: {
                tenantId: principal.tenantId,
                knowledgeBaseId,
                provider: 'LEXIANG',
                externalSpaceId,
                externalEntryId: entry.id,
                externalParentEntryId: entry.parentEntryId,
                entryType: entry.entryType,
                documentId,
                remoteName: entry.name,
                remoteCreatedAt,
                remoteUpdatedAt,
                lastSyncedAt: synchronizedAt,
              },
            });
            documentsImported += 1;
          } else {
            await transaction.knowledgeDocument.update({
              where: { id: documentId },
              data: {
                folderId: folder?.id ?? null,
                title: entry.name,
                mimeType: lexiangEntryMimeType(entry.entryType),
                fileName: entry.name,
                status: 'DRAFT',
                ...(remoteUpdatedAt === null ? {} : { updatedAt: remoteUpdatedAt }),
              },
            });
            await transaction.knowledgeExternalEntryBinding.update({
              where: { id: previous!.id },
              data: {
                externalParentEntryId: entry.parentEntryId,
                entryType: entry.entryType,
                remoteName: entry.name,
                remoteCreatedAt,
                remoteUpdatedAt,
                lastSyncedAt: synchronizedAt,
              },
            });
            documentsUpdated += 1;
          }
        }

        const removedDocuments = existing.filter(
          (binding) => binding.documentId !== null && !remoteIds.has(binding.externalEntryId),
        );
        for (const binding of removedDocuments) {
          await transaction.knowledgeDocument.update({
            where: { id: binding.documentId! },
            data: { status: 'ARCHIVED', folderId: null },
          });
          await transaction.knowledgeExternalEntryBinding.delete({ where: { id: binding.id } });
          documentsArchived += 1;
        }

        const removedFolders = existing
          .filter((binding) => binding.folderId !== null && !remoteIds.has(binding.externalEntryId))
          .sort(
            (left, right) => (right.folder?.path.length ?? 0) - (left.folder?.path.length ?? 0),
          );
        for (const binding of removedFolders) {
          await transaction.knowledgeExternalEntryBinding.delete({ where: { id: binding.id } });
          await transaction.knowledgeFolder.deleteMany({
            where: {
              tenantId: principal.tenantId,
              knowledgeBaseId,
              id: binding.folderId!,
              documents: { none: {} },
              children: { none: {} },
            },
          });
        }

        await recordAdminAudit(
          transaction,
          principal,
          'admin.knowledge-provider.lexiang.entries-synchronized',
          'knowledge_external_space_binding',
          loaded.binding.id,
          {
            knowledgeBaseId,
            externalSpaceId,
            entriesDiscovered: entries.length,
            foldersSynchronized,
            documentsDiscovered: entries.length - foldersSynchronized,
            documentsImported,
            documentsUpdated,
            documentsArchived,
          },
        );
        return {
          entriesDiscovered: entries.length,
          foldersSynchronized,
          documentsDiscovered: entries.length - foldersSynchronized,
          documentsImported,
          documentsUpdated,
          documentsArchived,
        };
      },
      { timeout: 120_000 },
    );
  }

  async ensureFolders(
    principal: AdminPrincipal,
    knowledgeBaseId: string,
    paths: readonly string[],
  ): Promise<void> {
    const loaded = await this.loadWritableBinding(principal.tenantId, knowledgeBaseId);
    const context = {
      connectionId: loaded.connection.id,
      credential: this.credential(principal.tenantId, loaded.connection),
      operatorStaffId: loaded.connection.operatorStaffId!,
      spaceId: loaded.binding.externalSpaceId!,
    };
    try {
      const entries = await this.spaces.listEntries(context);
      const folderIds = remoteFolderIdsByPath(entries);
      for (const requestedPath of paths) {
        const segments = requestedPath.split('/');
        for (let index = 0; index < segments.length; index += 1) {
          if (Array.from(segments[index]!).length > 150) {
            throw new BadRequestException('腾讯乐享文件夹名称不能超过 150 个字符。');
          }
          const path = segments.slice(0, index + 1).join('/');
          if (folderIds.has(path)) continue;
          const parentPath = segments.slice(0, index).join('/');
          const parentEntryId = parentPath === '' ? null : folderIds.get(parentPath);
          if (parentPath !== '' && parentEntryId === undefined) {
            throw new BadGatewayException('乐享文件夹层级不完整，无法安全创建目录。');
          }
          const created = await this.spaces.createFolder({
            ...context,
            parentEntryId: parentEntryId ?? null,
            name: segments[index]!,
          });
          folderIds.set(path, created.id);
        }
      }
      await this.syncEntries(principal, knowledgeBaseId);
    } catch (error) {
      if (error instanceof BadGatewayException || error instanceof BadRequestException) throw error;
      throw new BadGatewayException('腾讯乐享文件夹创建失败，请检查连接与操作账号权限后重试。');
    }
  }

  async uploadFile(
    principal: AdminPrincipal,
    knowledgeBaseId: string,
    input: {
      readonly title: string;
      readonly bytes: Buffer;
      readonly mimeType: string;
      readonly fileName: string;
      readonly folderId?: string | null;
    },
  ): Promise<string> {
    const extension = input.fileName.split('.').pop()?.toLowerCase() ?? '';
    if (!LEXIANG_FILE_EXTENSIONS.has(extension)) {
      throw new BadRequestException(`腾讯乐享不支持上传 .${extension || '未知'} 格式文件。`);
    }
    const loaded = await this.loadWritableBinding(principal.tenantId, knowledgeBaseId);
    const externalParentEntryId = await this.prisma.withTenant(
      principal.tenantId,
      async (transaction) => {
        if (input.folderId === undefined || input.folderId === null) return null;
        const folderBinding = await transaction.knowledgeExternalEntryBinding.findFirst({
          where: {
            tenantId: principal.tenantId,
            knowledgeBaseId,
            provider: 'LEXIANG',
            folderId: input.folderId,
          },
          select: { externalEntryId: true },
        });
        if (folderBinding === null) {
          throw new BadRequestException('所选文件夹尚未同步到腾讯乐享，请刷新后重试。');
        }
        return folderBinding.externalEntryId;
      },
    );
    const matches = await this.prisma.withTenant(principal.tenantId, (transaction) =>
      transaction.knowledgeDocument.findMany({
        where: {
          tenantId: principal.tenantId,
          knowledgeBaseId,
          folderId: input.folderId ?? null,
          sourceType: 'FILE',
          status: { not: 'ARCHIVED' },
          fileName: { equals: input.fileName, mode: 'insensitive' },
          externalEntryBinding: { is: { provider: 'LEXIANG' } },
        },
        include: { externalEntryBinding: true },
        take: 2,
      }),
    );
    if (matches.length > 1) {
      throw new BadRequestException('乐享中存在多个同名文件，请先在乐享中整理后重新同步。');
    }
    const existing = matches[0] ?? null;
    const context = {
      connectionId: loaded.connection.id,
      credential: this.credential(principal.tenantId, loaded.connection),
      operatorStaffId: loaded.connection.operatorStaffId!,
    };
    let remote: LexiangEntry;
    try {
      const existingBinding = existing?.externalEntryBinding ?? null;
      if (existing !== null && existingBinding === null) {
        throw new BadGatewayException('乐享文件映射不完整，请重新同步后再上传。');
      }
      remote =
        existing === null
          ? await this.spaces.uploadFile({
              ...context,
              spaceId: loaded.binding.externalSpaceId!,
              parentEntryId: externalParentEntryId,
              name: input.fileName,
              bytes: input.bytes,
            })
          : await this.spaces.reuploadFile({
              ...context,
              entryId: existingBinding!.externalEntryId,
              name: input.fileName,
              bytes: input.bytes,
            });
    } catch {
      throw new BadGatewayException('腾讯乐享文件上传失败，请检查文件格式、连接和操作账号权限。');
    }
    const remoteCreatedAt = parseLexiangDate(remote.createdAt);
    const remoteUpdatedAt = parseLexiangDate(remote.updatedAt);
    const synchronizedAt = new Date();
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        if (existing !== null && existing.externalEntryBinding !== null) {
          await transaction.knowledgeDocument.update({
            where: { id: existing.id },
            data: {
              folderId: input.folderId ?? null,
              title: boundedName(remote.name, 300),
              mimeType: lexiangEntryMimeType('file'),
              fileName: input.fileName,
              status: 'DRAFT',
              ...(remoteUpdatedAt === null ? {} : { updatedAt: remoteUpdatedAt }),
            },
          });
          await transaction.knowledgeExternalEntryBinding.update({
            where: { id: existing.externalEntryBinding.id },
            data: {
              externalParentEntryId,
              remoteName: remote.name,
              remoteCreatedAt,
              remoteUpdatedAt,
              lastSyncedAt: synchronizedAt,
            },
          });
          await recordAdminAudit(
            transaction,
            principal,
            'admin.knowledge-provider.lexiang.file-reuploaded',
            'knowledge_document',
            existing.id,
            { knowledgeBaseId, externalEntryId: remote.id },
          );
          return existing.id;
        }
        const document = await transaction.knowledgeDocument.create({
          data: {
            tenantId: principal.tenantId,
            knowledgeBaseId,
            folderId: input.folderId ?? null,
            title: boundedName(remote.name, 300),
            sourceType: 'FILE',
            mimeType: lexiangEntryMimeType('file'),
            fileName: input.fileName,
            status: 'DRAFT',
            createdById: principal.userId,
            ...(remoteCreatedAt === null ? {} : { createdAt: remoteCreatedAt }),
            ...(remoteUpdatedAt === null ? {} : { updatedAt: remoteUpdatedAt }),
          },
        });
        await transaction.knowledgeExternalEntryBinding.create({
          data: {
            tenantId: principal.tenantId,
            knowledgeBaseId,
            provider: 'LEXIANG',
            externalSpaceId: loaded.binding.externalSpaceId!,
            externalEntryId: remote.id,
            externalParentEntryId,
            entryType: 'file',
            documentId: document.id,
            remoteName: remote.name,
            remoteCreatedAt,
            remoteUpdatedAt,
            lastSyncedAt: synchronizedAt,
          },
        });
        await recordAdminAudit(
          transaction,
          principal,
          'admin.knowledge-provider.lexiang.file-uploaded',
          'knowledge_document',
          document.id,
          { knowledgeBaseId, externalEntryId: remote.id },
        );
        return document.id;
      });
    } catch (error) {
      if (existing === null) {
        await this.spaces.deleteEntry({ ...context, entryId: remote.id }).catch(() => undefined);
      }
      throw error;
    }
  }

  async linkedKnowledgeBaseIds(
    tenantId: string,
    externalSpaceIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    if (externalSpaceIds.length === 0) return new Map();
    const bindings = await this.prisma.withTenant(tenantId, (transaction) =>
      transaction.knowledgeExternalSpaceBinding.findMany({
        where: {
          tenantId,
          provider: 'LEXIANG',
          externalSpaceId: { in: [...externalSpaceIds] },
        },
        select: { externalSpaceId: true, knowledgeBaseId: true },
      }),
    );
    return new Map(
      bindings.flatMap((binding) =>
        binding.externalSpaceId === null
          ? []
          : [[binding.externalSpaceId, binding.knowledgeBaseId] as const],
      ),
    );
  }

  async bindExisting(
    principal: AdminPrincipal,
    knowledgeBaseId: string,
    remote: LexiangSpace,
  ): Promise<KnowledgeBaseExternalSpace> {
    const connection = await this.loadConnection(principal.tenantId);
    if (remote.teamId !== connection.teamId) {
      throw new BadRequestException('只能绑定当前乐享团队中的知识库。');
    }
    let binding = await this.prisma.withTenant(principal.tenantId, (transaction) =>
      transaction.knowledgeExternalSpaceBinding.findUnique({
        where: {
          tenantId_provider_externalSpaceId: {
            tenantId: principal.tenantId,
            provider: 'LEXIANG',
            externalSpaceId: remote.id,
          },
        },
      }),
    );
    if (binding === null) {
      binding = await this.prisma.withTenant(principal.tenantId, (transaction) =>
        transaction.knowledgeExternalSpaceBinding.create({
          data: {
            tenantId: principal.tenantId,
            knowledgeBaseId,
            connectionId: connection.id,
            provider: 'LEXIANG',
            status: 'PROVISIONING',
            externalTeamId: remote.teamId,
            externalSpaceId: remote.id,
            externalRootEntryId: remote.rootEntryId,
          },
        }),
      );
    }
    if (binding.knowledgeBaseId !== knowledgeBaseId) {
      throw new BadRequestException('该乐享知识库已绑定到其他本地知识库。');
    }
    binding = await this.saveRemoteIdentity(principal, binding, remote);
    try {
      return await this.completeSync(principal, binding, remote);
    } catch (error) {
      return this.failSync(principal, binding.id, safeProviderCode(error));
    }
  }

  async provision(
    principal: AdminPrincipal,
    knowledgeBaseId: string,
    name: string,
  ): Promise<KnowledgeBaseExternalSpace> {
    const connection = await this.loadConnection(principal.tenantId);
    const previousBinding = await this.prisma.withTenant(principal.tenantId, (transaction) =>
      transaction.knowledgeExternalSpaceBinding.findUnique({
        where: {
          tenantId_knowledgeBaseId: {
            tenantId: principal.tenantId,
            knowledgeBaseId,
          },
        },
      }),
    );
    let binding = await this.prisma.withTenant(principal.tenantId, (transaction) =>
      transaction.knowledgeExternalSpaceBinding.upsert({
        where: {
          tenantId_knowledgeBaseId: {
            tenantId: principal.tenantId,
            knowledgeBaseId,
          },
        },
        create: {
          tenantId: principal.tenantId,
          knowledgeBaseId,
          connectionId: connection.id,
          provider: 'LEXIANG',
          status: 'PROVISIONING',
          externalTeamId: connection.teamId!,
        },
        update: {
          status: 'PROVISIONING',
          lastErrorCode: null,
          version: { increment: 1 },
        },
      }),
    );
    const credential = this.credential(principal.tenantId, connection);
    try {
      if (binding.externalSpaceId === null && previousBinding !== null) {
        const recovered = await this.spaces.findSpaceByManagedMarker({
          connectionId: connection.id,
          credential,
          teamId: connection.teamId!,
          marker: managedSpaceMarker(knowledgeBaseId),
        });
        if (recovered !== null)
          binding = await this.saveRemoteIdentity(principal, binding, recovered);
      }
      if (binding.externalSpaceId === null) {
        const created = await this.spaces.createSpace({
          connectionId: connection.id,
          credential,
          teamId: connection.teamId!,
          operatorStaffId: connection.operatorStaffId!,
          name: managedSpaceName(name, knowledgeBaseId),
        });
        binding = await this.saveRemoteIdentity(principal, binding, created);
      }
      const remote = await this.spaces.getSpace({
        connectionId: connection.id,
        credential,
        spaceId: binding.externalSpaceId!,
      });
      if (remote.teamId !== binding.externalTeamId) {
        throw new LexiangProviderError('LEXIANG_SPACE_SCOPE_MISMATCH');
      }
      return await this.completeSync(principal, binding, remote);
    } catch (error) {
      return this.failSync(principal, binding.id, safeProviderCode(error));
    }
  }

  async rename(
    principal: AdminPrincipal,
    knowledgeBaseId: string,
    name: string,
  ): Promise<KnowledgeBaseExternalSpace | null> {
    const loaded = await this.loadBindingWithConnection(principal.tenantId, knowledgeBaseId);
    if (loaded === null || loaded.binding.externalSpaceId === null) return null;
    const { binding, connection } = loaded;
    const externalSpaceId = binding.externalSpaceId!;
    try {
      const remote = await this.spaces.updateSpace({
        connectionId: connection.id,
        credential: this.credential(principal.tenantId, connection),
        spaceId: externalSpaceId,
        operatorStaffId: connection.operatorStaffId!,
        name: managedSpaceName(name, knowledgeBaseId),
      });
      return await this.completeSync(principal, binding, remote);
    } catch (error) {
      return this.failSync(principal, binding.id, safeProviderCode(error));
    }
  }

  async delete(principal: AdminPrincipal, knowledgeBaseId: string): Promise<void> {
    const loaded = await this.loadBindingWithConnection(principal.tenantId, knowledgeBaseId);
    if (loaded === null || loaded.binding.status === 'DELETED') return;
    const { connection } = loaded;
    let binding: KnowledgeExternalSpaceBinding = loaded.binding;
    try {
      if (binding.externalSpaceId === null) {
        const recovered = await this.spaces.findSpaceByManagedMarker({
          connectionId: connection.id,
          credential: this.credential(principal.tenantId, connection),
          teamId: connection.teamId!,
          marker: managedSpaceMarker(knowledgeBaseId),
        });
        if (recovered !== null)
          binding = await this.saveRemoteIdentity(principal, binding, recovered);
      }
      binding = await this.prisma.withTenant(principal.tenantId, (transaction) =>
        transaction.knowledgeExternalSpaceBinding.update({
          where: { id: binding.id },
          data: { status: 'DELETING', lastErrorCode: null, version: { increment: 1 } },
        }),
      );
      if (binding.externalSpaceId !== null) {
        await this.spaces.deleteSpace({
          connectionId: connection.id,
          credential: this.credential(principal.tenantId, connection),
          spaceId: binding.externalSpaceId,
          operatorStaffId: connection.operatorStaffId!,
        });
      }
      await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        await transaction.knowledgeExternalSpaceBinding.update({
          where: { id: binding.id },
          data: {
            status: 'DELETED',
            lastSyncedAt: new Date(),
            lastErrorCode: null,
            version: { increment: 1 },
          },
        });
        await recordAdminAudit(
          transaction,
          principal,
          'admin.knowledge-provider.lexiang.space-deleted',
          'knowledge_external_space_binding',
          binding.id,
          { knowledgeBaseId, externalSpaceId: binding.externalSpaceId },
        );
      });
    } catch (error) {
      if (error instanceof LexiangProviderError && error.status === 404) {
        await this.markDeleted(principal, binding);
        return;
      }
      await this.failDelete(principal, binding.id, safeProviderCode(error));
      throw new BadGatewayException('乐享知识库删除失败，本系统知识库仍然保留，请检查连接后重试。');
    }
  }

  private async loadConnection(tenantId: string): Promise<ConnectionRecord> {
    const connection = await this.prisma.withTenant(tenantId, (transaction) =>
      transaction.knowledgeProviderConnection.findUnique({
        where: { tenantId_provider: { tenantId, provider: 'LEXIANG' } },
        select: {
          id: true,
          status: true,
          appKey: true,
          teamId: true,
          operatorStaffId: true,
          credentialCiphertext: true,
        },
      }),
    );
    if (
      connection === null ||
      connection.status !== 'ACTIVE' ||
      connection.credentialCiphertext === null ||
      connection.teamId === null ||
      connection.operatorStaffId === null
    ) {
      throw new BadRequestException('请先在“知识来源”中完成腾讯乐享团队连接配置。');
    }
    return connection;
  }

  private async loadBindingWithConnection(tenantId: string, knowledgeBaseId: string) {
    const binding = await this.prisma.withTenant(tenantId, (transaction) =>
      transaction.knowledgeExternalSpaceBinding.findUnique({
        where: { tenantId_knowledgeBaseId: { tenantId, knowledgeBaseId } },
        include: { connection: true },
      }),
    );
    if (binding === null) return null;
    const connection = binding.connection;
    if (
      connection.status !== 'ACTIVE' ||
      connection.credentialCiphertext === null ||
      connection.teamId === null ||
      connection.operatorStaffId === null
    ) {
      throw new BadRequestException('腾讯乐享连接不可用，无法安全操作远端知识库。');
    }
    return { binding, connection };
  }

  private async loadWritableBinding(tenantId: string, knowledgeBaseId: string) {
    const loaded = await this.loadBindingWithConnection(tenantId, knowledgeBaseId);
    if (
      loaded === null ||
      loaded.binding.status !== 'ACTIVE' ||
      loaded.binding.externalSpaceId === null ||
      loaded.binding.externalRootEntryId === null
    ) {
      throw new BadRequestException('该腾讯乐享知识库尚未通过隐私范围校验，不能从本系统上传资料。');
    }
    return loaded;
  }

  private credential(tenantId: string, connection: ConnectionRecord): LexiangCredential {
    return {
      appKey: connection.appKey,
      appSecret: this.vault.decrypt(connection.credentialCiphertext!, {
        tenantId,
        appKey: connection.appKey,
      }),
    };
  }

  private async saveRemoteIdentity(
    principal: AdminPrincipal,
    binding: KnowledgeExternalSpaceBinding,
    remote: Awaited<ReturnType<LexiangSpaceClient['createSpace']>>,
  ): Promise<KnowledgeExternalSpaceBinding> {
    if (remote.teamId !== binding.externalTeamId) {
      throw new LexiangProviderError('LEXIANG_SPACE_SCOPE_MISMATCH');
    }
    return this.prisma.withTenant(principal.tenantId, (transaction) =>
      transaction.knowledgeExternalSpaceBinding.update({
        where: { id: binding.id },
        data: {
          externalSpaceId: remote.id,
          externalRootEntryId: remote.rootEntryId,
          remoteName: remote.name,
          remoteDescription: remote.description,
          remoteLogo: remote.logo,
          ...(remote.visibleType === null ? {} : { visibleType: remote.visibleType }),
          ...(remote.managerInheritType === null
            ? {}
            : { managerInheritType: remote.managerInheritType }),
          ...(remote.memberInheritType === null
            ? {}
            : { memberInheritType: remote.memberInheritType }),
          version: { increment: 1 },
        },
      }),
    );
  }

  private async completeSync(
    principal: AdminPrincipal,
    binding: KnowledgeExternalSpaceBinding,
    remote: Awaited<ReturnType<LexiangSpaceClient['getSpace']>>,
  ): Promise<KnowledgeBaseExternalSpace> {
    const visibleType = remote.visibleType ?? binding.visibleType;
    const managerInheritType = remote.managerInheritType ?? binding.managerInheritType;
    const memberInheritType = remote.memberInheritType ?? binding.memberInheritType;
    if (visibleType !== 0 || managerInheritType !== 'none' || memberInheritType !== 'none') {
      throw new LexiangProviderError('LEXIANG_SPACE_PRIVACY_MISMATCH');
    }
    const updatedBinding = await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const updated = await transaction.knowledgeExternalSpaceBinding.update({
        where: { id: binding.id },
        data: {
          status: 'ACTIVE',
          externalSpaceId: remote.id,
          externalRootEntryId: remote.rootEntryId,
          remoteName: remote.name,
          remoteDescription: remote.description,
          remoteLogo: remote.logo,
          visibleType,
          managerInheritType,
          memberInheritType,
          lastSyncedAt: new Date(),
          lastErrorCode: null,
          version: { increment: 1 },
        },
      });
      await recordAdminAudit(
        transaction,
        principal,
        'admin.knowledge-provider.lexiang.space-synchronized',
        'knowledge_external_space_binding',
        binding.id,
        {
          externalSpaceId: remote.id,
          externalRootEntryId: remote.rootEntryId,
          externalTeamId: remote.teamId,
        },
      );
      return updated;
    });
    return mapBinding(updatedBinding);
  }

  private async failSync(
    principal: AdminPrincipal,
    bindingId: string,
    code: string,
  ): Promise<KnowledgeBaseExternalSpace> {
    const binding = await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const updated = await transaction.knowledgeExternalSpaceBinding.update({
        where: { id: bindingId },
        data: { status: 'SYNC_FAILED', lastErrorCode: code, version: { increment: 1 } },
      });
      await recordAdminAudit(
        transaction,
        principal,
        'admin.knowledge-provider.lexiang.space-sync-failed',
        'knowledge_external_space_binding',
        bindingId,
        { code },
      );
      return updated;
    });
    return mapBinding(binding);
  }

  private async failDelete(principal: AdminPrincipal, bindingId: string, code: string) {
    await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await transaction.knowledgeExternalSpaceBinding.update({
        where: { id: bindingId },
        data: { status: 'DELETE_FAILED', lastErrorCode: code, version: { increment: 1 } },
      });
      await recordAdminAudit(
        transaction,
        principal,
        'admin.knowledge-provider.lexiang.space-delete-failed',
        'knowledge_external_space_binding',
        bindingId,
        { code },
      );
    });
  }

  private async markDeleted(principal: AdminPrincipal, binding: KnowledgeExternalSpaceBinding) {
    await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await transaction.knowledgeExternalSpaceBinding.update({
        where: { id: binding.id },
        data: {
          status: 'DELETED',
          lastSyncedAt: new Date(),
          lastErrorCode: null,
          version: { increment: 1 },
        },
      });
      await recordAdminAudit(
        transaction,
        principal,
        'admin.knowledge-provider.lexiang.space-already-deleted',
        'knowledge_external_space_binding',
        binding.id,
        { externalSpaceId: binding.externalSpaceId },
      );
    });
  }
}

function mapBinding(binding: KnowledgeExternalSpaceBinding): KnowledgeBaseExternalSpace {
  return {
    provider: 'LEXIANG',
    status: binding.status,
    externalTeamId: binding.externalTeamId,
    externalSpaceId: binding.externalSpaceId,
    externalRootEntryId: binding.externalRootEntryId,
    name: binding.remoteName,
    description: binding.remoteDescription,
    logo: binding.remoteLogo,
    visibleType: binding.visibleType,
    managerInheritType: binding.managerInheritType,
    memberInheritType: binding.memberInheritType,
    lastSyncedAt: binding.lastSyncedAt?.toISOString() ?? null,
    lastErrorCode: binding.lastErrorCode,
  };
}

function safeProviderCode(error: unknown): string {
  return error instanceof LexiangProviderError
    ? `${error.code}${error.status === undefined ? '' : `_${error.status}`}`
    : 'LEXIANG_SPACE_OPERATION_FAILED';
}

function managedSpaceMarker(knowledgeBaseId: string): string {
  return ` · BMS:${knowledgeBaseId}`;
}

function managedSpaceName(name: string, knowledgeBaseId: string): string {
  const marker = managedSpaceMarker(knowledgeBaseId);
  return `${Array.from(name)
    .slice(0, 100 - marker.length)
    .join('')}${marker}`;
}

function externalFolderPath(parentPath: string | null, entry: LexiangEntry): string {
  const displaySegment = boundedName(entry.name, 120).replaceAll('/', '／').replaceAll('\\', '＼');
  const identity = createHash('sha256').update(entry.id).digest('hex').slice(0, 12);
  const path = `${parentPath === null ? '' : `${parentPath}/`}${displaySegment}~${identity}`;
  if (path.length > 2_000) {
    throw new BadGatewayException('乐享文件夹层级过深，无法安全同步到本系统。');
  }
  return path;
}

function boundedName(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join('');
}

function lexiangEntryMimeType(entryType: string): string {
  return `application/vnd.tencent.lexiang.${entryType.toLowerCase()}`;
}

function parseLexiangDate(value: string | null): Date | null {
  if (value === null) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(value)
    ? `${value.replace(' ', 'T')}+08:00`
    : value;
  const parsed = new Date(normalized);
  if (!Number.isFinite(parsed.getTime())) {
    throw new BadGatewayException('乐享返回了无效的知识节点时间，已停止同步。');
  }
  return parsed;
}

function remoteFolderIdsByPath(entries: readonly LexiangEntry[]): Map<string, string> {
  const foldersById = new Map(
    entries
      .filter((entry) => entry.entryType === 'folder')
      .map((entry) => [entry.id, entry] as const),
  );
  const pathsById = new Map<string, string>();
  const resolving = new Set<string>();
  const resolvePath = (entry: LexiangEntry): string => {
    const previous = pathsById.get(entry.id);
    if (previous !== undefined) return previous;
    if (resolving.has(entry.id)) {
      throw new BadGatewayException('乐享返回了循环文件夹层级，已停止上传。');
    }
    resolving.add(entry.id);
    const segment = entry.name.replaceAll('/', '／').replaceAll('\\', '＼');
    const parent = entry.parentEntryId === null ? null : foldersById.get(entry.parentEntryId);
    if (entry.parentEntryId !== null && parent === undefined) {
      throw new BadGatewayException('乐享返回了缺少父节点的文件夹，已停止上传。');
    }
    const path =
      parent === null || parent === undefined ? segment : `${resolvePath(parent)}/${segment}`;
    resolving.delete(entry.id);
    pathsById.set(entry.id, path);
    return path;
  };
  const result = new Map<string, string>();
  for (const entry of foldersById.values()) {
    const path = resolvePath(entry);
    if (result.has(path)) {
      throw new BadGatewayException('乐享中存在同路径文件夹，无法确定上传目标。');
    }
    result.set(path, entry.id);
  }
  return result;
}
