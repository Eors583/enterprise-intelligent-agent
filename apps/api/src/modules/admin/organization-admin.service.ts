import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  type AdminMember,
  type AdminOrganizationResponse,
  type AdminOrgUnit,
  type CreateMemberRequest,
  type CreateOrgUnitRequest,
  type ResetMemberPasswordRequest,
  type ResetMemberPasswordResponse,
  type TenantRole,
  type UpdateMemberRequest,
  type UpdateOrganizationRequest,
  type UpdateOrgUnitRequest,
} from '@enterprise/contracts';
import { Prisma } from '@prisma/client';

import { AdminPrismaService } from '../../database/admin-prisma.service.js';
import { PasswordHasher } from '../auth/application/password-hasher.js';
import { AdminAccessService, type AdminPrincipal } from './admin-access.service.js';
import { recordAdminAudit } from './admin-audit.js';
import { assertOrgUnitParent } from './org-unit-tree.js';
import { lockOrganizationDirectory } from './organization-directory-lock.js';
import { KnowledgeGateway } from '../knowledge-gateway/knowledge-gateway.port.js';
import { createMemberDirectoryDetails } from './member-directory-details.js';

type MemberRecord = Prisma.UserGetPayload<{
  include: {
    directoryBindings: true;
    employments: {
      include: {
        position: true;
        managers: { include: { managerEmployment: { include: { user: true } } } };
      };
    };
  };
}>;

type OrgUnitRecord = Prisma.OrgUnitGetPayload<{
  include: {
    directoryBindings: true;
    _count: {
      select: { employments: { where: { status: { not: 'TERMINATED' } } } };
    };
  };
}>;

@Injectable()
export class OrganizationAdminService {
  constructor(
    @Inject(AdminPrismaService) private readonly prisma: AdminPrismaService,
    @Inject(AdminAccessService) private readonly access: AdminAccessService,
    @Inject(PasswordHasher) private readonly passwords: PasswordHasher,
    @Inject(KnowledgeGateway) private readonly knowledge: KnowledgeGateway,
  ) {}

  async getOrganization(): Promise<AdminOrganizationResponse> {
    const principal = this.access.requireDirectoryRead();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const organization = await this.findOrganization(transaction, principal.tenantId);
      const [orgUnits, members] = await Promise.all([
        transaction.orgUnit.findMany({
          where: { tenantId: principal.tenantId, organizationId: organization.id },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          include: {
            directoryBindings: { take: 1 },
            _count: {
              select: { employments: { where: { status: { not: 'TERMINATED' } } } },
            },
          },
        }),
        transaction.user.findMany({
          where: { tenantId: principal.tenantId },
          orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
          include: {
            directoryBindings: { take: 1 },
            employments: {
              where: { organizationId: organization.id },
              orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
              take: 1,
              include: {
                position: true,
                managers: { include: { managerEmployment: { include: { user: true } } } },
              },
            },
          },
        }),
      ]);

      return {
        organization: {
          id: organization.id,
          name: organization.name,
          legalName: organization.legalName,
          timezone: organization.timezone,
          version: organization.version,
        },
        orgUnits: orgUnits.map(mapOrgUnit),
        members: members.map(mapMember),
      };
    });
  }

  async updateOrganization(
    request: UpdateOrganizationRequest,
  ): Promise<AdminOrganizationResponse['organization']> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const organization = await this.findOrganization(transaction, principal.tenantId);
      await lockOrganizationDirectory(transaction, principal.tenantId, organization.id);
      const data: Prisma.OrganizationUpdateManyMutationInput = {
        version: { increment: 1 },
        ...(request.name === undefined ? {} : { name: request.name }),
        ...(request.legalName === undefined ? {} : { legalName: request.legalName }),
        ...(request.timezone === undefined ? {} : { timezone: request.timezone }),
      };
      const result = await transaction.organization.updateMany({
        where: {
          id: organization.id,
          tenantId: principal.tenantId,
          version: request.expectedVersion,
        },
        data,
      });
      if (result.count !== 1) throw optimisticConflict('organization');

      const updated = await transaction.organization.findFirstOrThrow({
        where: { id: organization.id, tenantId: principal.tenantId },
      });
      await recordAdminAudit(
        transaction,
        principal,
        'admin.organization.updated',
        'organization',
        updated.id,
        { previousVersion: organization.version, version: updated.version },
      );
      return {
        id: updated.id,
        name: updated.name,
        legalName: updated.legalName,
        timezone: updated.timezone,
        version: updated.version,
      };
    });
  }

  async createOrgUnit(request: CreateOrgUnitRequest): Promise<AdminOrgUnit> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const organization = await this.findOrganization(transaction, principal.tenantId);
      await lockOrganizationDirectory(transaction, principal.tenantId, organization.id);
      const nodes = await transaction.orgUnit.findMany({
        where: { tenantId: principal.tenantId, organizationId: organization.id },
        select: { id: true, parentId: true, status: true },
      });
      const parentId = request.parentId ?? null;
      assertOrgUnitParent(nodes, undefined, parentId);

      const unit = await transaction.orgUnit.create({
        data: {
          tenantId: principal.tenantId,
          organizationId: organization.id,
          parentId,
          name: request.name,
          sortOrder: request.sortOrder,
          status: 'ACTIVE',
        },
        include: {
          directoryBindings: { take: 1 },
          _count: {
            select: { employments: { where: { status: { not: 'TERMINATED' } } } },
          },
        },
      });
      await recordAdminAudit(
        transaction,
        principal,
        'admin.org-unit.created',
        'org_unit',
        unit.id,
        { parentId, name: unit.name },
      );
      return mapOrgUnit(unit);
    });
  }

  async updateOrgUnit(id: string, request: UpdateOrgUnitRequest): Promise<AdminOrgUnit> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const target = await transaction.orgUnit.findFirst({
        where: { id, tenantId: principal.tenantId },
        select: { organizationId: true },
      });
      if (target === null) throw orgUnitNotFound();
      await lockOrganizationDirectory(transaction, principal.tenantId, target.organizationId);
      const current = await transaction.orgUnit.findFirst({
        where: { id, tenantId: principal.tenantId },
        include: { directoryBindings: { take: 1 } },
      });
      if (current === null) throw orgUnitNotFound();
      if (current.directoryBindings.length > 0) {
        throw new ConflictException('该部门由飞书通讯录管理，请在飞书中修改后重新同步。');
      }
      if (current.status !== 'ACTIVE') {
        throw new ConflictException('An archived organization unit cannot be edited.');
      }

      if (request.parentId !== undefined) {
        const nodes = await transaction.orgUnit.findMany({
          where: {
            tenantId: principal.tenantId,
            organizationId: current.organizationId,
          },
          select: { id: true, parentId: true, status: true },
        });
        assertOrgUnitParent(nodes, current.id, request.parentId);
      }

      const data: Prisma.OrgUnitUpdateManyMutationInput = {
        version: { increment: 1 },
        ...(request.name === undefined ? {} : { name: request.name }),
        ...(request.parentId === undefined ? {} : { parentId: request.parentId }),
        ...(request.sortOrder === undefined ? {} : { sortOrder: request.sortOrder }),
      };
      const result = await transaction.orgUnit.updateMany({
        where: {
          id,
          tenantId: principal.tenantId,
          status: 'ACTIVE',
          version: request.expectedVersion,
        },
        data,
      });
      if (result.count !== 1) throw optimisticConflict('organization unit');

      const updated = await transaction.orgUnit.findFirstOrThrow({
        where: { id, tenantId: principal.tenantId },
        include: {
          directoryBindings: { take: 1 },
          _count: {
            select: { employments: { where: { status: { not: 'TERMINATED' } } } },
          },
        },
      });
      await recordAdminAudit(transaction, principal, 'admin.org-unit.updated', 'org_unit', id, {
        previousVersion: current.version,
        version: updated.version,
        previousParentId: current.parentId,
        parentId: updated.parentId,
      });
      return mapOrgUnit(updated);
    });
  }

  async archiveOrgUnit(id: string, expectedVersion: number): Promise<AdminOrgUnit> {
    const principal = this.access.requireDirectoryWrite();
    assertPositiveVersion(expectedVersion);
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const target = await transaction.orgUnit.findFirst({
        where: { id, tenantId: principal.tenantId },
        select: { organizationId: true },
      });
      if (target === null) throw orgUnitNotFound();
      await lockOrganizationDirectory(transaction, principal.tenantId, target.organizationId);
      const current = await transaction.orgUnit.findFirst({
        where: { id, tenantId: principal.tenantId },
        include: { directoryBindings: { take: 1 } },
      });
      if (current === null) throw orgUnitNotFound();
      if (current.directoryBindings.length > 0) {
        throw new ConflictException('该部门由飞书通讯录管理，不能在本地归档。');
      }
      if (current.status === 'ARCHIVED') {
        throw new ConflictException('The organization unit is already archived.');
      }

      const [children, employments, positions, knowledgeScopes] = await Promise.all([
        transaction.orgUnit.count({
          where: { tenantId: principal.tenantId, parentId: id, status: 'ACTIVE' },
        }),
        transaction.employment.count({
          where: {
            tenantId: principal.tenantId,
            orgUnitId: id,
            status: { not: 'TERMINATED' },
          },
        }),
        transaction.position.count({
          where: { tenantId: principal.tenantId, orgUnitId: id },
        }),
        this.knowledge.countOrgUnitBindings({
          tenantId: principal.tenantId,
          userId: principal.userId,
          orgUnitId: id,
        }),
      ]);
      if (children + employments + positions + knowledgeScopes > 0) {
        throw new ConflictException(
          `The organization unit still has blockers (children=${children}, members=${employments}, positions=${positions}, knowledgeScopes=${knowledgeScopes}).`,
        );
      }

      const result = await transaction.orgUnit.updateMany({
        where: {
          id,
          tenantId: principal.tenantId,
          status: 'ACTIVE',
          version: expectedVersion,
        },
        data: { status: 'ARCHIVED', version: { increment: 1 } },
      });
      if (result.count !== 1) throw optimisticConflict('organization unit');

      const archived = await transaction.orgUnit.findFirstOrThrow({
        where: { id, tenantId: principal.tenantId },
        include: {
          directoryBindings: { take: 1 },
          _count: {
            select: { employments: { where: { status: { not: 'TERMINATED' } } } },
          },
        },
      });
      await recordAdminAudit(transaction, principal, 'admin.org-unit.archived', 'org_unit', id, {
        previousVersion: current.version,
        version: archived.version,
      });
      return mapOrgUnit(archived);
    });
  }

  async createMember(request: CreateMemberRequest): Promise<AdminMember> {
    const principal = this.access.requireDirectoryWrite();
    this.access.assertCanAssignRole(principal, request.role);
    const passwordHash = await this.passwords.hash(request.password);

    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        const organization = await this.findOrganization(transaction, principal.tenantId);
        await lockOrganizationDirectory(transaction, principal.tenantId, organization.id);
        await this.requireActiveOrgUnit(
          transaction,
          principal.tenantId,
          organization.id,
          request.orgUnitId,
        );

        const user = await transaction.user.create({
          data: {
            tenantId: principal.tenantId,
            email: request.email,
            emailNormalized: request.email,
            displayName: request.displayName,
            ...(request.phone === undefined ? {} : { phone: request.phone }),
            ...(request.avatarUrl === undefined ? {} : { avatarUrl: request.avatarUrl }),
            status: 'ACTIVE',
            role: request.role,
          },
        });
        await transaction.passwordCredential.create({
          data: {
            tenantId: principal.tenantId,
            userId: user.id,
            passwordHash,
            mustChangePassword: true,
          },
        });

        const positionId =
          request.title === undefined
            ? null
            : await this.upsertMemberPosition(
                transaction,
                principal.tenantId,
                organization.id,
                user.id,
                request.orgUnitId,
                request.title,
              );
        const employment = await transaction.employment.create({
          data: {
            tenantId: principal.tenantId,
            userId: user.id,
            organizationId: organization.id,
            orgUnitId: request.orgUnitId,
            positionId,
            workEmail: request.email,
            status: 'ACTIVE',
            isPrimary: true,
            employmentType: request.employmentType,
            ...(request.hireDate === undefined ? {} : { hireDate: new Date(request.hireDate) }),
            ...(request.countryOrRegion === undefined
              ? {}
              : { countryOrRegion: request.countryOrRegion }),
            ...(request.city === undefined ? {} : { city: request.city }),
            ...(request.employeeNumber === undefined
              ? {}
              : { employeeNumber: request.employeeNumber }),
          },
          select: { id: true },
        });
        await createMemberDirectoryDetails(transaction, {
          tenantId: principal.tenantId,
          organizationId: organization.id,
          employmentId: employment.id,
          ...(request.directManagerUserId === undefined
            ? {}
            : { directManagerUserId: request.directManagerUserId }),
          ...(request.dottedLineManagerUserId === undefined
            ? {}
            : { dottedLineManagerUserId: request.dottedLineManagerUserId }),
        });
        await recordAdminAudit(transaction, principal, 'admin.member.created', 'user', user.id, {
          role: user.role,
          orgUnitId: request.orgUnitId,
          passwordChangeRequired: true,
        });
        return this.findMember(transaction, principal.tenantId, organization.id, user.id);
      });
    } catch (error) {
      if (isUniqueConflict(error)) {
        throw new ConflictException('A member with this email or employee number already exists.');
      }
      throw error;
    }
  }

  async updateMember(id: string, request: UpdateMemberRequest): Promise<AdminMember> {
    const principal = this.access.requireDirectoryWrite();
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        const organization = await this.findOrganization(transaction, principal.tenantId);
        await lockOrganizationDirectory(transaction, principal.tenantId, organization.id);
        const current = await transaction.user.findFirst({
          where: { id, tenantId: principal.tenantId },
          include: {
            directoryBindings: { take: 1 },
            employments: {
              where: { organizationId: organization.id },
              orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
              take: 1,
              include: { position: true },
            },
          },
        });
        if (current === null) throw memberNotFound();
        const directoryManaged = current.directoryBindings.length > 0;
        const requestedEmail =
          request.email === undefined ? undefined : normalizeLoginEmail(request.email);
        if (directoryManaged && current.role !== 'OWNER' && request.role === 'OWNER') {
          throw new ConflictException('飞书导入成员尚未绑定本地登录身份，不能被设为企业所有者。');
        }
        if (
          directoryManaged &&
          (request.displayName !== undefined ||
            request.orgUnitId !== undefined ||
            request.title !== undefined ||
            request.status !== undefined)
        ) {
          throw new ConflictException('该成员的姓名、部门、职位和在职状态由飞书通讯录管理。');
        }

        this.access.assertCanManageMember(principal, current.role);
        if (request.role !== undefined) this.access.assertCanAssignRole(principal, request.role);
        await this.assertOwnerContinuity(transaction, principal, current.role, request);
        const accountDisabled = request.status !== undefined && request.status !== 'ACTIVE';
        if (requestedEmail !== undefined || accountDisabled) {
          await lockMemberPasswordFlow(transaction, principal.tenantId, current.id);
        }
        if (requestedEmail !== undefined) {
          assertRealLoginEmail(requestedEmail);
          await this.assertMemberEmailAvailable(
            transaction,
            principal.tenantId,
            current.id,
            requestedEmail,
          );
        }

        const currentEmployments =
          requestedEmail === undefined
            ? []
            : await transaction.employment.findMany({
                where: {
                  tenantId: principal.tenantId,
                  userId: current.id,
                  status: { not: 'TERMINATED' },
                },
                select: { workEmail: true },
              });
        const previousEmail = current.employments[0]?.workEmail ?? current.email;
        const emailChanged =
          requestedEmail !== undefined &&
          (normalizeLoginEmail(current.email) !== requestedEmail ||
            normalizeLoginEmail(previousEmail) !== requestedEmail ||
            currentEmployments.some(
              ({ workEmail }) =>
                workEmail === null || normalizeLoginEmail(workEmail) !== requestedEmail,
            ));

        await transaction.user.update({
          where: { id: current.id },
          data: {
            ...(requestedEmail === undefined
              ? {}
              : { email: requestedEmail, emailNormalized: requestedEmail }),
            ...(request.displayName === undefined ? {} : { displayName: request.displayName }),
            ...(request.role === undefined ? {} : { role: request.role }),
            ...(request.status === undefined ? {} : { status: request.status }),
          },
        });

        if (requestedEmail !== undefined) {
          const updatedEmployments = await transaction.employment.updateMany({
            where: {
              tenantId: principal.tenantId,
              userId: current.id,
              status: { not: 'TERMINATED' },
            },
            data: {
              workEmail: requestedEmail,
              ...(directoryManaged ? { workEmailOverridden: true } : {}),
            },
          });
          if (directoryManaged && updatedEmployments.count === 0) {
            throw new ConflictException(
              'The Feishu directory member has no active employment for a login email.',
            );
          }
        }

        if (accountDisabled || emailChanged) {
          const revokedAt = new Date();
          await transaction.authSession.updateMany({
            where: {
              tenantId: principal.tenantId,
              userId: current.id,
              revokedAt: null,
            },
            data: { revokedAt },
          });
          await transaction.authActionToken.updateMany({
            where: {
              tenantId: principal.tenantId,
              userId: current.id,
              consumedAt: null,
              revokedAt: null,
            },
            data: { revokedAt },
          });
        }

        const employment = current.employments[0];
        if (
          (request.orgUnitId !== undefined || request.title !== undefined) &&
          employment === undefined
        ) {
          throw new ConflictException('The member has no employment to update.');
        }
        if (
          employment !== undefined &&
          (request.orgUnitId !== undefined ||
            request.title !== undefined ||
            request.status !== undefined)
        ) {
          const targetOrgUnitId = request.orgUnitId ?? employment.orgUnitId;
          if (request.orgUnitId !== undefined) {
            await this.requireActiveOrgUnit(
              transaction,
              principal.tenantId,
              organization.id,
              request.orgUnitId,
            );
          }
          const resultingTitle = request.title ?? employment.position?.name;
          const positionId =
            resultingTitle === undefined
              ? employment.positionId
              : await this.upsertMemberPosition(
                  transaction,
                  principal.tenantId,
                  organization.id,
                  current.id,
                  targetOrgUnitId,
                  resultingTitle,
                );
          await transaction.employment.update({
            where: { id: employment.id },
            data: {
              ...(request.orgUnitId === undefined ? {} : { orgUnitId: request.orgUnitId }),
              ...(positionId === employment.positionId ? {} : { positionId }),
              ...(request.status === undefined
                ? {}
                : { status: request.status === 'ACTIVE' ? 'ACTIVE' : 'SUSPENDED' }),
            },
          });
        }

        await recordAdminAudit(transaction, principal, 'admin.member.updated', 'user', current.id, {
          previousRole: current.role,
          role: request.role ?? current.role,
          previousStatus: current.status,
          status: request.status ?? current.status,
          ...(requestedEmail === undefined
            ? {}
            : {
                previousEmail,
                email: requestedEmail,
                emailSource: directoryManaged ? 'LOCAL_OVERRIDE' : 'LOCAL',
              }),
        });
        return this.findMember(transaction, principal.tenantId, organization.id, current.id);
      });
    } catch (error) {
      if (isUniqueConflict(error)) {
        throw memberEmailConflict();
      }
      throw error;
    }
  }

  async resetMemberPassword(
    id: string,
    request: ResetMemberPasswordRequest,
  ): Promise<ResetMemberPasswordResponse> {
    const principal = this.access.requireDirectoryWrite();
    if (id === principal.userId) {
      throw new BadRequestException(
        'Use the authenticated password-change flow to change your own password.',
      );
    }

    const passwordHash = await this.passwords.hash(request.temporaryPassword);
    const changedAt = new Date();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const organization = await this.findOrganization(transaction, principal.tenantId);
      await lockOrganizationDirectory(transaction, principal.tenantId, organization.id);
      const member = await transaction.user.findFirst({
        where: { id, tenantId: principal.tenantId },
        select: { id: true, role: true },
      });
      if (member === null) throw memberNotFound();
      this.access.assertCanManageMember(principal, member.role);

      await lockMemberPasswordFlow(transaction, principal.tenantId, member.id);
      const credential = await transaction.passwordCredential.updateMany({
        where: { tenantId: principal.tenantId, userId: member.id },
        data: {
          passwordHash,
          mustChangePassword: true,
          passwordChangedAt: changedAt,
        },
      });
      if (credential.count !== 1) {
        throw new ConflictException('The member does not have a local password credential.');
      }

      const revoked = await transaction.authSession.updateMany({
        where: {
          tenantId: principal.tenantId,
          userId: member.id,
          revokedAt: null,
        },
        data: { revokedAt: changedAt },
      });
      await transaction.authActionToken.updateMany({
        where: {
          tenantId: principal.tenantId,
          userId: member.id,
          consumedAt: null,
          revokedAt: null,
        },
        data: { revokedAt: changedAt },
      });
      await recordAdminAudit(
        transaction,
        principal,
        'admin.member.password_reset',
        'user',
        member.id,
        {
          passwordChangeRequired: true,
          revokedSessionCount: revoked.count,
        },
      );
      return {
        memberId: member.id,
        passwordChangeRequired: true,
        revokedSessionCount: revoked.count,
      };
    });
  }

  private async findOrganization(
    transaction: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<Prisma.OrganizationGetPayload<Record<string, never>>> {
    const organization = await transaction.organization.findFirst({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
    });
    if (organization === null) throw new NotFoundException('The organization was not found.');
    return organization;
  }

  private async requireActiveOrgUnit(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    organizationId: string,
    orgUnitId: string,
  ): Promise<void> {
    const unit = await transaction.orgUnit.findFirst({
      where: { id: orgUnitId, tenantId, organizationId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (unit === null) throw orgUnitNotFound();
  }

  private async findMember(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    organizationId: string,
    userId: string,
  ): Promise<AdminMember> {
    const member = await transaction.user.findFirst({
      where: { id: userId, tenantId },
      include: {
        directoryBindings: { take: 1 },
        employments: {
          where: { organizationId },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          take: 1,
          include: {
            position: true,
            managers: { include: { managerEmployment: { include: { user: true } } } },
          },
        },
      },
    });
    if (member === null) throw memberNotFound();
    return mapMember(member);
  }

  private async upsertMemberPosition(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    organizationId: string,
    userId: string,
    orgUnitId: string,
    title: string,
  ): Promise<string> {
    const code = `ADMIN_MEMBER_${userId.replaceAll('-', '')}`;
    const position = await transaction.position.upsert({
      where: { tenantId_code: { tenantId, code } },
      create: { tenantId, organizationId, orgUnitId, code, name: title },
      update: { orgUnitId, name: title },
      select: { id: true },
    });
    return position.id;
  }

  private async assertMemberEmailAvailable(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    memberId: string,
    email: string,
  ): Promise<void> {
    const [userConflictCount, employmentConflictCount] = await Promise.all([
      transaction.user.count({
        where: {
          tenantId,
          id: { not: memberId },
          emailNormalized: email,
        },
      }),
      transaction.employment.count({
        where: {
          tenantId,
          userId: { not: memberId },
          status: { not: 'TERMINATED' },
          workEmail: { equals: email, mode: 'insensitive' },
        },
      }),
    ]);
    if (userConflictCount > 0 || employmentConflictCount > 0) {
      throw memberEmailConflict();
    }
  }

  private async assertOwnerContinuity(
    transaction: Prisma.TransactionClient,
    principal: AdminPrincipal,
    currentRole: TenantRole,
    request: UpdateMemberRequest,
  ): Promise<void> {
    const removesActiveOwner =
      currentRole === 'OWNER' &&
      ((request.role !== undefined && request.role !== 'OWNER') ||
        (request.status !== undefined && request.status !== 'ACTIVE'));
    if (!removesActiveOwner) return;

    const activeOwners = await transaction.user.count({
      where: {
        tenantId: principal.tenantId,
        role: 'OWNER',
        status: 'ACTIVE',
        passwordCredential: { isNot: null },
      },
    });
    if (activeOwners <= 1) {
      throw new ConflictException('A tenant must keep at least one active owner.');
    }
  }
}

function mapOrgUnit(unit: OrgUnitRecord): AdminOrgUnit {
  return {
    id: unit.id,
    organizationId: unit.organizationId,
    parentId: unit.parentId,
    name: unit.name,
    sortOrder: unit.sortOrder,
    status: unit.status,
    version: unit.version,
    memberCount: unit._count.employments,
    source: unit.directoryBindings.length > 0 ? 'FEISHU' : 'LOCAL',
  };
}

function mapMember(member: MemberRecord): AdminMember {
  const employment = member.employments[0];
  const directManager = employment?.managers?.find((manager) => manager.relationType === 'DIRECT');
  const dottedLineManager = employment?.managers?.find(
    (manager) => manager.relationType === 'DOTTED_LINE',
  );
  return {
    id: member.id,
    email: employment?.workEmail ?? member.email,
    displayName: member.displayName,
    phone: member.phone,
    avatarUrl: member.avatarUrl,
    status: member.status,
    role: member.role,
    source: member.directoryBindings.length > 0 ? 'FEISHU' : 'LOCAL',
    employment:
      employment === undefined
        ? null
        : {
            id: employment.id,
            organizationId: employment.organizationId,
            orgUnitId: employment.orgUnitId,
            title: employment.position?.name ?? null,
            employeeNumber: employment.employeeNumber,
            employmentType: readEmploymentType(employment.employmentType),
            hireDate: employment.hireDate?.toISOString().slice(0, 10) ?? null,
            countryOrRegion: employment.countryOrRegion,
            city: employment.city,
            directManager:
              directManager === undefined
                ? null
                : {
                    userId: directManager.managerEmployment.userId,
                    displayName: directManager.managerEmployment.user.displayName,
                  },
            dottedLineManager:
              dottedLineManager === undefined
                ? null
                : {
                    userId: dottedLineManager.managerEmployment.userId,
                    displayName: dottedLineManager.managerEmployment.user.displayName,
                  },
            status: employment.status,
          },
  };
}

function readEmploymentType(
  value: string | null | undefined,
): NonNullable<AdminMember['employment']>['employmentType'] {
  return ['REGULAR', 'INTERN', 'OUTSOURCED', 'LABOR', 'CONSULTANT'].includes(value ?? '')
    ? (value as NonNullable<AdminMember['employment']>['employmentType'])
    : null;
}

function optimisticConflict(resource: string): ConflictException {
  return new ConflictException(
    `The ${resource} changed after it was loaded. Refresh and try again.`,
  );
}

function orgUnitNotFound(): NotFoundException {
  return new NotFoundException('The organization unit was not found.');
}

function memberNotFound(): NotFoundException {
  return new NotFoundException('The member was not found.');
}

function memberEmailConflict(): ConflictException {
  return new ConflictException('That login email is already used by another member.');
}

function normalizeLoginEmail(email: string): string {
  return email.trim().toLowerCase();
}

function assertRealLoginEmail(email: string): void {
  if (email.endsWith('@external.invalid')) {
    throw new BadRequestException('A real login email is required.');
  }
}

async function lockMemberPasswordFlow(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  userId: string,
): Promise<void> {
  await transaction.$queryRaw`
    WITH password_flow_lock AS (
      SELECT pg_advisory_xact_lock(hashtextextended(${passwordFlowLockKey(tenantId, userId)}, 0))
    )
    SELECT 1::integer AS locked FROM password_flow_lock
  `;
}

function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function assertPositiveVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new BadRequestException('expectedVersion must be a positive integer.');
  }
}

function passwordFlowLockKey(tenantId: string, userId: string): string {
  return `password-flow:${tenantId}:${userId}`;
}
