import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import {
  roleAssignmentCandidateListResponseSchema,
  roleAssignmentListResponseSchema,
  roleAssignmentSchema,
} from '@enterprise/contracts';
import request from 'supertest';

import { RoleAssignmentLifecycleService } from '../src/modules/admin/role-assignment-lifecycle.service.js';
import { createTestApp } from '../src/testing/create-test-app.js';
import { cleanupDisposableTenants } from './database-test-harness.js';

const enabled = process.env.RUN_DATABASE_TESTS === 'true';

const tenantAId = '00000000-0000-7000-8000-00000000f001';
const tenantBId = '00000000-0000-7000-8000-00000000f002';
const adminAId = '00000000-0000-7000-8000-00000000f101';
const assigneeAId = '00000000-0000-7000-8000-00000000f102';
const adminBId = '00000000-0000-7000-8000-00000000f103';
const assigneeBId = '00000000-0000-7000-8000-00000000f104';
const reviewerAId = '00000000-0000-7000-8000-00000000f105';
const delegateAId = '00000000-0000-7000-8000-00000000f106';
const organizationAId = '00000000-0000-7000-8000-00000000f201';
const organizationBId = '00000000-0000-7000-8000-00000000f202';
const orgUnitAId = '00000000-0000-7000-8000-00000000f211';
const orgUnitBId = '00000000-0000-7000-8000-00000000f212';
const employmentAId = '00000000-0000-7000-8000-00000000f221';
const employmentBId = '00000000-0000-7000-8000-00000000f222';
const delegateEmploymentAId = '00000000-0000-7000-8000-00000000f223';
const templateAId = '00000000-0000-7000-8000-00000000f301';
const templateBId = '00000000-0000-7000-8000-00000000f302';
const publishedVersionAId = '00000000-0000-7000-8000-00000000f311';
const draftVersionAId = '00000000-0000-7000-8000-00000000f312';
const testingVersionAId = '00000000-0000-7000-8000-00000000f313';
const retiredVersionAId = '00000000-0000-7000-8000-00000000f314';
const publishedVersionBId = '00000000-0000-7000-8000-00000000f315';
const assignmentKey = 'asg:role-integration:assignee-a';

describe.runIf(enabled)('PostgreSQL role assignment integration', () => {
  const administrator = new PrismaClient();
  let app: INestApplication;
  let assignmentId: string;
  let agentInstanceId: string;
  let assignmentUpdatedAt: string;
  let assignmentCreateBody: Record<string, unknown>;

  beforeAll(async () => {
    await cleanup();
    await seedFixtures();
    app = await createTestApp();
  });

  afterAll(async () => {
    if (app !== undefined) await app.close();
    await cleanup();
    await administrator.$disconnect();
  });

  it('allows direct publication while preserving optional review-data consistency', async () => {
    const unreviewedPublishedId = '00000000-0000-7000-8000-00000000f316';
    const selfApprovedId = '00000000-0000-7000-8000-00000000f317';
    const selfReviewedId = '00000000-0000-7000-8000-00000000f318';
    const now = new Date();

    await expect(
      administrator.agentVersion.create({
        data: {
          ...agentVersionFixture(unreviewedPublishedId, tenantAId, templateAId, 90, 'DRAFT'),
          status: 'PUBLISHED',
          publishedAt: now,
        },
      }),
    ).resolves.toMatchObject({
      id: unreviewedPublishedId,
      status: 'PUBLISHED',
      reviewStatus: 'NOT_SUBMITTED',
    });

    await expect(
      administrator.agentVersion.create({
        data: {
          ...agentVersionFixture(selfApprovedId, tenantAId, templateAId, 91, 'DRAFT'),
          status: 'TESTING',
          reviewStatus: 'APPROVED',
          reviewRequestedAt: now,
          reviewRequestedById: adminAId,
          reviewedAt: now,
          reviewedById: reviewerAId,
          reviewComment: 'Database negative maker-checker test.',
          approvedAt: now,
          approvedById: adminAId,
        },
      }),
    ).rejects.toThrow();

    await expect(
      administrator.agentVersion.create({
        data: {
          ...agentVersionFixture(selfReviewedId, tenantAId, templateAId, 92, 'DRAFT'),
          status: 'TESTING',
          reviewStatus: 'APPROVED',
          reviewRequestedAt: now,
          reviewRequestedById: reviewerAId,
          reviewedAt: now,
          reviewedById: reviewerAId,
          reviewComment: 'Database negative requester-reviewer test.',
          approvedAt: now,
          approvedById: reviewerAId,
        },
      }),
    ).rejects.toThrow();

    await expect(
      administrator.agentVersion.count({
        where: { id: { in: [unreviewedPublishedId, selfApprovedId, selfReviewedId] } },
      }),
    ).resolves.toBe(1);
  });

  it('lists published structured versions as assignment candidates', async () => {
    const candidates = roleAssignmentCandidateListResponseSchema.parse(
      (
        await request(app.getHttpServer())
          .get('/api/v1/admin/role-blueprints/assignment-candidates')
          .set(identityHeaders(tenantAId, adminAId))
          .expect(200)
      ).body,
    );

    expect(candidates.items).toContainEqual({
      id: publishedVersionAId,
      version: 1,
      blueprintRevision: 1,
      roleDefinitionSnapshot: governedRoleDefinition(),
      blueprint: {
        id: templateAId,
        key: 'role-integration-a',
        name: 'Role Integration A',
      },
    });
    expect(candidates.items.map(({ id }) => id)).not.toEqual(
      expect.arrayContaining([draftVersionAId, testingVersionAId, retiredVersionAId]),
    );
  });

  it('atomically creates a linked RoleAssignment and AgentInstance for a valid admin request', async () => {
    const before = await persistenceCounts(tenantAId);
    expect(before).toEqual({ assignments: 0, instances: 0, audits: 0 });

    assignmentCreateBody = {
      key: assignmentKey,
      idempotencyKey: 'role-assignment-integration-create-0001',
      userId: assigneeAId,
      employmentId: employmentAId,
      agentVersionId: publishedVersionAId,
      agentName: 'Assignee A Role Agent',
      effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
      effectiveTo: null,
      source: 'LOCAL',
      organizationScope: { organizationIds: [organizationAId], includeChildren: true },
      permissionScope: {},
      memoryPolicy: { roleOnly: true },
    };
    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/role-assignments')
      .set(identityHeaders(tenantAId, adminAId))
      .send(assignmentCreateBody)
      .expect(201);
    const created = roleAssignmentSchema.parse(response.body);
    assignmentId = created.id;
    agentInstanceId = created.agent.id;
    assignmentUpdatedAt = created.updatedAt;

    expect(created).toMatchObject({
      key: assignmentKey,
      status: 'ACTIVE',
      source: 'LOCAL',
      assignee: { id: assigneeAId, status: 'ACTIVE' },
      employment: { id: employmentAId, status: 'ACTIVE' },
      agent: {
        id: agentInstanceId,
        name: 'Assignee A Role Agent',
        status: 'ONLINE',
        versionId: publishedVersionAId,
        version: 1,
        versionStatus: 'PUBLISHED',
        template: { id: templateAId },
      },
      createdBy: { id: adminAId },
      roleDefinitionSnapshot: governedRoleDefinition(),
      blueprintRevision: 1,
    });

    const [storedAssignment, storedInstance, audit, after] = await Promise.all([
      administrator.roleAssignment.findUniqueOrThrow({
        where: { id: assignmentId },
        select: {
          tenantId: true,
          userId: true,
          employmentId: true,
          agentInstanceId: true,
          createdById: true,
          idempotencyKey: true,
          roleTemplateId: true,
          roleVersionId: true,
          version: true,
          status: true,
        },
      }),
      administrator.agentInstance.findUniqueOrThrow({
        where: { id: agentInstanceId },
        select: {
          tenantId: true,
          versionId: true,
          ownerUserId: true,
          createdById: true,
          status: true,
          settings: true,
        },
      }),
      administrator.auditEvent.findFirstOrThrow({
        where: {
          tenantId: tenantAId,
          action: 'admin.role_assignment.created',
          resourceId: assignmentId,
        },
      }),
      persistenceCounts(tenantAId),
    ]);
    expect(after).toEqual({ assignments: 1, instances: 1, audits: 1 });
    expect(storedAssignment).toEqual({
      tenantId: tenantAId,
      userId: assigneeAId,
      employmentId: employmentAId,
      agentInstanceId,
      createdById: adminAId,
      idempotencyKey: 'role-assignment-integration-create-0001',
      roleTemplateId: templateAId,
      roleVersionId: publishedVersionAId,
      version: 1,
      status: 'ACTIVE',
    });
    expect(storedInstance).toMatchObject({
      tenantId: tenantAId,
      versionId: publishedVersionAId,
      ownerUserId: assigneeAId,
      createdById: adminAId,
      status: 'ONLINE',
      settings: {
        visibility: 'owner',
        roleAssignmentId: assignmentId,
        roleTemplateId: templateAId,
      },
    });
    expect(audit.metadata).toMatchObject({
      assignmentKey,
      userId: assigneeAId,
      employmentId: employmentAId,
      agentInstanceId,
      agentVersionId: publishedVersionAId,
    });
  });

  it('replays the same idempotency key without duplicating the instance, assignment, or audit', async () => {
    const before = await persistenceCounts(tenantAId);
    const replay = roleAssignmentSchema.parse(
      (
        await request(app.getHttpServer())
          .post('/api/v1/admin/role-assignments')
          .set(identityHeaders(tenantAId, adminAId))
          .send(assignmentCreateBody)
          .expect(201)
      ).body,
    );
    expect(replay.id).toBe(assignmentId);
    await expect(persistenceCounts(tenantAId)).resolves.toEqual(before);
  });

  it('rejects an overlapping assignment for the same member and Role Blueprint', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/role-assignments')
      .set(identityHeaders(tenantAId, adminAId))
      .send({
        ...assignmentCreateBody,
        key: 'asg:role-integration:overlap',
        idempotencyKey: 'role-assignment-integration-overlap-0001',
      })
      .expect(409);
    await expect(
      administrator.roleAssignment.count({ where: { tenantId: tenantAId } }),
    ).resolves.toBe(1);
  });

  it('accepts only PUBLISHED Agent versions without leaving partial instances', async () => {
    const before = await persistenceCounts(tenantAId);
    const unpublishedVersions = [
      ['draft', draftVersionAId],
      ['testing', testingVersionAId],
      ['retired', retiredVersionAId],
    ] as const;

    for (const [status, versionId] of unpublishedVersions) {
      const response = await request(app.getHttpServer())
        .post('/api/v1/admin/role-assignments')
        .set(identityHeaders(tenantAId, adminAId))
        .send({
          key: `asg:role-integration:${status}`,
          userId: assigneeAId,
          employmentId: employmentAId,
          agentVersionId: versionId,
          effectiveFrom: new Date(Date.now() + 60_000).toISOString(),
          source: 'LOCAL',
          organizationScope: {},
          permissionScope: {},
          memoryPolicy: {},
        })
        .expect(409);
      expect(response.body).toMatchObject({
        message: 'Only a published structured Role Blueprint version can be assigned.',
      });
    }

    await expect(persistenceCounts(tenantAId)).resolves.toEqual(before);
  });

  it('keeps assignment writes admin-only while allowing the application role to verify access', async () => {
    const [boundary] = await administrator.$queryRaw<
      Array<{
        appCanRead: boolean;
        appCanInsert: boolean;
        appCanUpdate: boolean;
        appCanDelete: boolean;
        adminCanWrite: boolean;
        processCanRead: boolean;
        processReadPolicyValid: boolean;
        policyNames: string[];
      }>
    >`
      SELECT
        has_table_privilege(
          'enterprise_agent_app',
          'public.role_assignments',
          'SELECT'
        ) AS "appCanRead",
        has_table_privilege(
          'enterprise_agent_app',
          'public.role_assignments',
          'INSERT'
        ) AS "appCanInsert",
        has_table_privilege(
          'enterprise_agent_app',
          'public.role_assignments',
          'UPDATE'
        ) AS "appCanUpdate",
        has_table_privilege(
          'enterprise_agent_app',
          'public.role_assignments',
          'DELETE'
        ) AS "appCanDelete",
        (
          has_table_privilege(
            'enterprise_agent_admin',
            'public.role_assignments',
            'INSERT'
          )
          AND has_table_privilege(
            'enterprise_agent_admin',
            'public.role_assignments',
            'UPDATE'
          )
          AND has_table_privilege(
            'enterprise_agent_admin',
            'public.role_assignments',
            'DELETE'
          )
        ) AS "adminCanWrite",
        has_table_privilege(
          'enterprise_agent_process',
          'public.role_assignments',
          'SELECT'
        ) AS "processCanRead",
        EXISTS (
          SELECT 1
          FROM pg_policies
          WHERE schemaname = 'public'
            AND tablename = 'role_assignments'
            AND policyname = 'enterprise_agent_process_read'
            AND permissive = 'PERMISSIVE'
            AND cmd = 'SELECT'
            AND roles = ARRAY['enterprise_agent_process']::name[]
            AND qual = 'true'
            AND with_check IS NULL
        ) AS "processReadPolicyValid",
        ARRAY(
          SELECT policyname
          FROM pg_policies
          WHERE schemaname = 'public'
            AND tablename = 'role_assignments'
          ORDER BY policyname
        )::text[] AS "policyNames"
    `;
    expect(boundary).toEqual({
      appCanRead: true,
      appCanInsert: false,
      appCanUpdate: false,
      appCanDelete: false,
      adminCanWrite: true,
      processCanRead: true,
      processReadPolicyValid: true,
      // SCIM deprovisioning is trigger-owned. Reintroducing a SCIM assignment
      // policy would restore unnecessary direct visibility to this table.
      policyNames: [
        'employee_insights_assignment_select',
        'enterprise_agent_access',
        'enterprise_agent_admin_access',
        'enterprise_agent_lifecycle_access',
        'enterprise_agent_process_read',
        'tenant_isolation',
        'tool_gateway_parent_read',
        'tool_gateway_parent_tenant',
      ],
    });
    const [overlapConstraint] = await administrator.$queryRaw<
      Array<{ constraintType: string; definition: string }>
    >`
      SELECT
        constraint_type."contype"::text AS "constraintType",
        pg_get_constraintdef(constraint_type.oid) AS "definition"
      FROM pg_constraint AS constraint_type
      JOIN pg_class AS target_table
        ON target_table.oid = constraint_type.conrelid
      JOIN pg_namespace AS target_schema
        ON target_schema.oid = target_table.relnamespace
      WHERE target_schema.nspname = 'public'
        AND target_table.relname = 'role_assignments'
        AND constraint_type.conname = 'role_assignments_no_overlapping_effective_period'
    `;
    expect(overlapConstraint?.constraintType).toBe('x');
    expect(overlapConstraint?.definition).toContain('tstzrange');
  });

  it('hides assignments and rejects foreign users, employments, versions, and revocation', async () => {
    const foreignList = roleAssignmentListResponseSchema.parse(
      (
        await request(app.getHttpServer())
          .get('/api/v1/admin/role-assignments')
          .set(identityHeaders(tenantBId, adminBId))
          .expect(200)
      ).body,
    );
    expect(foreignList.items).toEqual([]);

    await request(app.getHttpServer())
      .post(`/api/v1/admin/role-assignments/${assignmentId}/revoke`)
      .set(identityHeaders(tenantBId, adminBId))
      .send({ reason: 'Foreign tenant request', expectedUpdatedAt: assignmentUpdatedAt })
      .expect(404);

    await request(app.getHttpServer())
      .post('/api/v1/admin/role-assignments')
      .set(identityHeaders(tenantBId, adminBId))
      .send(
        assignmentRequest({
          key: 'asg:role-integration:foreign-user',
          userId: assigneeAId,
          employmentId: employmentBId,
          agentVersionId: publishedVersionBId,
        }),
      )
      .expect(404);

    await request(app.getHttpServer())
      .post('/api/v1/admin/role-assignments')
      .set(identityHeaders(tenantBId, adminBId))
      .send(
        assignmentRequest({
          key: 'asg:role-integration:foreign-employment',
          userId: assigneeBId,
          employmentId: employmentAId,
          agentVersionId: publishedVersionBId,
        }),
      )
      .expect(409);

    await request(app.getHttpServer())
      .post('/api/v1/admin/role-assignments')
      .set(identityHeaders(tenantBId, adminBId))
      .send(
        assignmentRequest({
          key: 'asg:role-integration:foreign-version',
          userId: assigneeBId,
          employmentId: employmentBId,
          agentVersionId: publishedVersionAId,
        }),
      )
      .expect(409);

    await expect(persistenceCounts(tenantBId)).resolves.toEqual({
      assignments: 0,
      instances: 0,
      audits: 0,
    });
    await expect(
      administrator.roleAssignment.findUniqueOrThrow({ where: { id: assignmentId } }),
    ).resolves.toMatchObject({ tenantId: tenantAId, status: 'ACTIVE' });
  });

  it('revokes the assignment and disables its now-unassigned AgentInstance', async () => {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/admin/role-assignments/${assignmentId}/revoke`)
      .set(identityHeaders(tenantAId, adminAId))
      .send({
        reason: 'Role changed',
        expectedUpdatedAt: assignmentUpdatedAt,
      })
      .expect(201);
    const revoked = roleAssignmentSchema.parse(response.body);

    expect(revoked).toMatchObject({
      id: assignmentId,
      status: 'REVOKED',
      revokedBy: { id: adminAId },
      revokeReason: 'Role changed',
      agent: { id: agentInstanceId, status: 'DISABLED' },
    });
    expect(revoked.revokedAt).not.toBeNull();

    const [storedAssignment, storedInstance, audit] = await Promise.all([
      administrator.roleAssignment.findUniqueOrThrow({ where: { id: assignmentId } }),
      administrator.agentInstance.findUniqueOrThrow({ where: { id: agentInstanceId } }),
      administrator.auditEvent.findFirstOrThrow({
        where: {
          tenantId: tenantAId,
          action: 'admin.role_assignment.revoked',
          resourceId: assignmentId,
        },
      }),
    ]);
    expect(storedAssignment).toMatchObject({
      status: 'REVOKED',
      revokedById: adminAId,
      revokeReason: 'Role changed',
      revokedAt: expect.any(Date),
    });
    expect(storedInstance.status).toBe('DISABLED');
    expect(audit.metadata).toEqual({
      userId: assigneeAId,
      agentInstanceId,
      reason: 'Role changed',
      cancelledAgentRunIds: [],
      externalCancellationRunIds: [],
      cascadedAssignmentIds: [],
    });
  });

  it('rejects delegation expansion and cascades a source revocation to descendants', async () => {
    const source = roleAssignmentSchema.parse(
      (
        await request(app.getHttpServer())
          .post('/api/v1/admin/role-assignments')
          .set(identityHeaders(tenantAId, adminAId))
          .send({
            key: 'asg:role-integration:delegation-source',
            idempotencyKey: 'role-assignment-integration-delegation-source-0001',
            userId: assigneeAId,
            employmentId: employmentAId,
            agentVersionId: publishedVersionAId,
            effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
            effectiveTo: new Date(Date.now() + 86_400_000).toISOString(),
            source: 'LOCAL',
            organizationScope: {
              organizationIds: [organizationAId],
              includeChildren: true,
            },
            permissionScope: {},
            memoryPolicy: { roleOnly: false, retentionDays: 90 },
          })
          .expect(201)
      ).body,
    );

    const expanded = await request(app.getHttpServer())
      .post('/api/v1/admin/role-assignments')
      .set(identityHeaders(tenantAId, adminAId))
      .send({
        key: 'asg:role-integration:delegation-expanded',
        idempotencyKey: 'role-assignment-integration-delegation-expanded-0001',
        userId: delegateAId,
        employmentId: delegateEmploymentAId,
        agentVersionId: publishedVersionAId,
        effectiveFrom: new Date(Date.now() - 30_000).toISOString(),
        effectiveTo: new Date(Date.now() + 43_200_000).toISOString(),
        source: 'DELEGATION',
        delegatedFromAssignmentId: source.id,
        organizationScope: {
          organizationIds: [organizationAId, organizationBId],
          includeChildren: true,
        },
        permissionScope: {},
        memoryPolicy: { roleOnly: false, retentionDays: 90 },
      })
      .expect(409);
    expect(expanded.body).toMatchObject({
      message:
        'The delegated organization scope must be equal to or narrower than its source assignment.',
    });

    const delegated = roleAssignmentSchema.parse(
      (
        await request(app.getHttpServer())
          .post('/api/v1/admin/role-assignments')
          .set(identityHeaders(tenantAId, adminAId))
          .send({
            key: 'asg:role-integration:delegation-child',
            idempotencyKey: 'role-assignment-integration-delegation-child-0001',
            userId: delegateAId,
            employmentId: delegateEmploymentAId,
            agentVersionId: publishedVersionAId,
            effectiveFrom: new Date(Date.now() - 30_000).toISOString(),
            effectiveTo: new Date(Date.now() + 43_200_000).toISOString(),
            source: 'DELEGATION',
            delegatedFromAssignmentId: source.id,
            organizationScope: {
              organizationIds: [organizationAId],
              includeChildren: false,
            },
            permissionScope: {},
            memoryPolicy: { roleOnly: true, retentionDays: 30 },
          })
          .expect(201)
      ).body,
    );
    expect(delegated).toMatchObject({
      status: 'ACTIVE',
      source: 'DELEGATION',
      delegatedFromAssignmentId: source.id,
    });

    await request(app.getHttpServer())
      .post(`/api/v1/admin/role-assignments/${source.id}/revoke`)
      .set(identityHeaders(tenantAId, adminAId))
      .send({
        reason: 'Source role ended',
        expectedUpdatedAt: source.updatedAt,
      })
      .expect(201);

    const [storedSource, storedChild, cascadeAudit] = await Promise.all([
      administrator.roleAssignment.findUniqueOrThrow({ where: { id: source.id } }),
      administrator.roleAssignment.findUniqueOrThrow({ where: { id: delegated.id } }),
      administrator.auditEvent.findFirstOrThrow({
        where: {
          tenantId: tenantAId,
          resourceId: delegated.id,
          action: 'admin.role_assignment.cascade_revoked',
        },
      }),
    ]);
    expect(storedSource.status).toBe('REVOKED');
    expect(storedChild).toMatchObject({
      status: 'REVOKED',
      revokedById: adminAId,
      delegatedFromAssignmentId: source.id,
    });
    expect(cascadeAudit.metadata).toMatchObject({
      sourceAssignmentId: source.id,
      parentAssignmentId: source.id,
      previousStatus: 'ACTIVE',
    });
    await expect(
      administrator.agentInstance.findUniqueOrThrow({
        where: { id: delegated.agent.id },
      }),
    ).resolves.toMatchObject({ status: 'DISABLED' });
  });

  it('atomically activates an immediate handover and revokes its source', async () => {
    const source = roleAssignmentSchema.parse(
      (
        await request(app.getHttpServer())
          .post('/api/v1/admin/role-assignments')
          .set(identityHeaders(tenantAId, adminAId))
          .send({
            key: 'asg:role-integration:handover-source',
            idempotencyKey: 'role-assignment-integration-handover-source-0001',
            userId: assigneeAId,
            employmentId: employmentAId,
            agentVersionId: publishedVersionAId,
            effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
            effectiveTo: null,
            source: 'LOCAL',
            organizationScope: {
              organizationIds: [organizationAId],
              includeChildren: true,
            },
            permissionScope: {},
            memoryPolicy: { roleOnly: false, retentionDays: 90 },
          })
          .expect(201)
      ).body,
    );

    const handover = roleAssignmentSchema.parse(
      (
        await request(app.getHttpServer())
          .post('/api/v1/admin/role-assignments')
          .set(identityHeaders(tenantAId, adminAId))
          .send({
            key: 'asg:role-integration:handover-successor',
            idempotencyKey: 'role-assignment-integration-handover-successor-0001',
            userId: delegateAId,
            employmentId: delegateEmploymentAId,
            agentVersionId: publishedVersionAId,
            effectiveFrom: new Date(Date.now() - 30_000).toISOString(),
            effectiveTo: null,
            source: 'HANDOVER',
            delegatedFromAssignmentId: source.id,
            organizationScope: {
              organizationIds: [organizationAId],
              includeChildren: false,
            },
            permissionScope: {},
            memoryPolicy: { roleOnly: true, retentionDays: 30 },
          })
          .expect(201)
      ).body,
    );

    expect(handover).toMatchObject({
      status: 'ACTIVE',
      source: 'HANDOVER',
      delegatedFromAssignmentId: source.id,
    });
    await expect(
      administrator.roleAssignment.findUniqueOrThrow({ where: { id: source.id } }),
    ).resolves.toMatchObject({
      status: 'REVOKED',
      revokedById: adminAId,
      revokeReason: `Handed over to assignment ${handover.id}.`,
    });
    await expect(
      administrator.auditEvent.findFirstOrThrow({
        where: {
          tenantId: tenantAId,
          resourceId: source.id,
          action: 'admin.role_assignment.handed_over',
        },
      }),
    ).resolves.toMatchObject({
      metadata: expect.objectContaining({ successorAssignmentId: handover.id }),
    });
  });

  it('reconciles scheduled activation and expiry with instance and audit transitions', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/role-assignments')
      .set(identityHeaders(tenantAId, adminAId))
      .send({
        key: 'asg:role-integration:lifecycle',
        idempotencyKey: 'role-assignment-integration-lifecycle-0001',
        userId: assigneeAId,
        employmentId: employmentAId,
        agentVersionId: publishedVersionAId,
        effectiveFrom: new Date(Date.now() + 3_600_000).toISOString(),
        effectiveTo: null,
        source: 'TEMPORARY',
        organizationScope: {},
        permissionScope: {},
        memoryPolicy: {},
      })
      .expect(201);
    const scheduled = roleAssignmentSchema.parse(response.body);
    expect(scheduled.status).toBe('PENDING');
    expect(scheduled.agent.status).toBe('OFFLINE');

    const activationTime = new Date();
    await administrator.roleAssignment.update({
      where: { id: scheduled.id },
      data: { effectiveFrom: new Date(activationTime.getTime() - 60_000) },
    });
    await expect(
      app.get(RoleAssignmentLifecycleService).runOnce(activationTime),
    ).resolves.toMatchObject({ activated: 1 });
    await expect(
      administrator.roleAssignment.findUniqueOrThrow({ where: { id: scheduled.id } }),
    ).resolves.toMatchObject({ status: 'ACTIVE', version: 2 });
    await expect(
      administrator.agentInstance.findUniqueOrThrow({ where: { id: scheduled.agent.id } }),
    ).resolves.toMatchObject({ status: 'ONLINE' });

    const expiryTime = new Date();
    await administrator.roleAssignment.update({
      where: { id: scheduled.id },
      data: { effectiveTo: new Date(expiryTime.getTime() - 1) },
    });
    await request(app.getHttpServer())
      .post('/api/v1/admin/role-assignments/reconcile')
      .set(identityHeaders(tenantAId, adminAId))
      .expect(201);
    await expect(
      administrator.roleAssignment.findUniqueOrThrow({ where: { id: scheduled.id } }),
    ).resolves.toMatchObject({ status: 'EXPIRED', version: 3 });
    await expect(
      administrator.agentInstance.findUniqueOrThrow({ where: { id: scheduled.agent.id } }),
    ).resolves.toMatchObject({ status: 'DISABLED' });
    await expect(
      administrator.auditEvent.count({
        where: {
          tenantId: tenantAId,
          resourceId: scheduled.id,
          action: {
            in: ['admin.role_assignment.activated', 'admin.role_assignment.expired'],
          },
        },
      }),
    ).resolves.toBe(2);
  });

  it('governs Role Version review, publication, replacement, and immutable rollback lineage', async () => {
    const initialMission =
      'Create measurable customer value through governed partner collaboration.';
    const revisedMission =
      'Create measurable customer value through governed and measurable partner delivery.';
    const blueprint = (
      await request(app.getHttpServer())
        .post('/api/v1/admin/role-blueprints')
        .set(identityHeaders(tenantAId, adminAId))
        .send({
          key: 'integration.partner-sales',
          name: 'Integration Partner Sales',
          description: 'Governed integration Role Blueprint.',
          mission: initialMission,
          responsibilities: [
            {
              key: 'pipeline',
              name: 'Pipeline',
              description: 'Maintain a verifiable opportunity pipeline.',
              outcomes: ['Every opportunity has an owner and next action.'],
            },
          ],
          valueDefinition: {
            statement: 'Increase partner success with reliable collaboration.',
            stakeholderOutcomes: ['Partners receive predictable support.'],
            measures: ['Partner win rate'],
          },
          capabilities: [],
          processes: [],
          tools: [],
          knowledgeDomains: [],
        })
        .expect(201)
    ).body as { id: string; revision: number };

    const firstDraft = await createVersionDraft(blueprint.id, 'First governed configuration.');
    expect(firstDraft).toMatchObject({
      blueprintRevision: 1,
      roleDefinitionSnapshot: expect.objectContaining({ mission: initialMission }),
    });
    const firstSubmitted = await transitionVersion(
      blueprint.id,
      String(firstDraft.id),
      'submit',
      adminAId,
      Number(firstDraft.revision),
    );
    const firstApproved = await request(app.getHttpServer())
      .post(`/api/v1/admin/role-blueprints/${blueprint.id}/versions/${firstDraft.id}/review`)
      .set(identityHeaders(tenantAId, reviewerAId))
      .send({
        expectedRevision: firstSubmitted.revision,
        decision: 'APPROVE',
        comment: 'The structured role and execution policy are acceptable.',
      })
      .expect(201);
    const firstPublished = await transitionVersion(
      blueprint.id,
      String(firstDraft.id),
      'publish',
      reviewerAId,
      Number(firstApproved.body.revision),
    );

    const revisedBlueprint = await request(app.getHttpServer())
      .patch(`/api/v1/admin/role-blueprints/${blueprint.id}`)
      .set(identityHeaders(tenantAId, adminAId))
      .send({ expectedRevision: 1, mission: revisedMission })
      .expect(200);
    expect(revisedBlueprint.body).toMatchObject({ revision: 2, mission: revisedMission });
    await expect(
      administrator.agentVersion.findUniqueOrThrow({
        where: { id: firstPublished.id },
        select: { roleDefinitionSnapshot: true, blueprintRevision: true },
      }),
    ).resolves.toEqual({
      roleDefinitionSnapshot: expect.objectContaining({ mission: initialMission }),
      blueprintRevision: 1,
    });

    const secondDraft = await createVersionDraft(blueprint.id, 'Second governed configuration.');
    expect(secondDraft).toMatchObject({
      blueprintRevision: 2,
      roleDefinitionSnapshot: expect.objectContaining({ mission: revisedMission }),
    });
    const secondSubmitted = await transitionVersion(
      blueprint.id,
      String(secondDraft.id),
      'submit',
      adminAId,
      Number(secondDraft.revision),
    );
    const secondApproved = await request(app.getHttpServer())
      .post(`/api/v1/admin/role-blueprints/${blueprint.id}/versions/${secondDraft.id}/review`)
      .set(identityHeaders(tenantAId, reviewerAId))
      .send({
        expectedRevision: secondSubmitted.revision,
        decision: 'APPROVE',
        comment: 'The replacement configuration is approved.',
      })
      .expect(201);
    const secondPublished = await transitionVersion(
      blueprint.id,
      String(secondDraft.id),
      'publish',
      reviewerAId,
      Number(secondApproved.body.revision),
    );
    await expect(
      administrator.agentVersion.findUniqueOrThrow({ where: { id: firstPublished.id } }),
    ).resolves.toMatchObject({ status: 'RETIRED', retiredById: reviewerAId });

    const rollback = await request(app.getHttpServer())
      .post(`/api/v1/admin/role-blueprints/${blueprint.id}/versions/${firstPublished.id}/rollback`)
      .set(identityHeaders(tenantAId, reviewerAId))
      .send({
        expectedPublishedVersionId: secondPublished.id,
        changeSummary: 'Rollback the replacement after a verified regression.',
      })
      .expect(201);
    expect(rollback.body).toMatchObject({
      status: 'DRAFT',
      reviewStatus: 'NOT_SUBMITTED',
      rollbackOfVersionId: firstPublished.id,
      version: 3,
      blueprintRevision: 1,
      roleDefinitionSnapshot: expect.objectContaining({ mission: initialMission }),
    });
    await expect(
      administrator.agentVersion.findUniqueOrThrow({ where: { id: secondPublished.id } }),
    ).resolves.toMatchObject({ status: 'PUBLISHED', retiredAt: null });
    await expect(
      administrator.agentVersion.count({
        where: { tenantId: tenantAId, templateId: blueprint.id, status: 'PUBLISHED' },
      }),
    ).resolves.toBe(1);

    const rollbackSubmitted = await transitionVersion(
      blueprint.id,
      String(rollback.body.id),
      'submit',
      reviewerAId,
      Number(rollback.body.revision),
    );
    const rollbackApproved = await request(app.getHttpServer())
      .post(`/api/v1/admin/role-blueprints/${blueprint.id}/versions/${rollback.body.id}/review`)
      .set(identityHeaders(tenantAId, adminAId))
      .send({
        expectedRevision: rollbackSubmitted.revision,
        decision: 'APPROVE',
        comment: 'Independent approval confirms the rollback configuration.',
      })
      .expect(201);
    const rollbackPublished = await transitionVersion(
      blueprint.id,
      String(rollback.body.id),
      'publish',
      adminAId,
      Number(rollbackApproved.body.revision),
    );
    expect(rollbackPublished).toMatchObject({
      status: 'PUBLISHED',
      reviewStatus: 'APPROVED',
      rollbackOfVersionId: firstPublished.id,
    });
    await expect(
      administrator.agentVersion.findUniqueOrThrow({ where: { id: secondPublished.id } }),
    ).resolves.toMatchObject({ status: 'RETIRED', retiredById: adminAId });
  });

  async function createVersionDraft(blueprintId: string, changeSummary: string) {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/admin/role-blueprints/${blueprintId}/versions`)
      .set(identityHeaders(tenantAId, adminAId))
      .send({
        systemPrompt: `Execute the governed role safely. ${changeSummary}`,
        modelPolicy: { route: 'default' },
        toolPolicy: { allow: [] },
        knowledgeScope: { mode: 'selected', knowledgeBaseIds: [] },
        changeSummary,
      })
      .expect(201);
    return response.body as {
      id: string;
      revision: number;
      blueprintRevision: number;
      roleDefinitionSnapshot: ReturnType<typeof governedRoleDefinition>;
    };
  }

  async function transitionVersion(
    blueprintId: string,
    versionId: string,
    action: 'submit' | 'publish',
    actorId: string,
    expectedRevision: number,
  ) {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/admin/role-blueprints/${blueprintId}/versions/${versionId}/${action}`)
      .set(identityHeaders(tenantAId, actorId))
      .send({ expectedRevision })
      .expect(201);
    return response.body as { id: string; revision: number };
  }

  function identityHeaders(tenantId: string, userId: string): Record<string, string> {
    return { 'x-tenant-id': tenantId, 'x-user-id': userId };
  }

  function assignmentRequest(values: {
    key: string;
    userId: string;
    employmentId: string;
    agentVersionId: string;
  }): Record<string, unknown> {
    return {
      ...values,
      effectiveFrom: new Date(Date.now() + 60_000).toISOString(),
      effectiveTo: null,
      source: 'LOCAL',
      organizationScope: {},
      permissionScope: {},
      memoryPolicy: {},
    };
  }

  async function persistenceCounts(tenantId: string): Promise<{
    assignments: number;
    instances: number;
    audits: number;
  }> {
    const [assignments, instances, audits] = await Promise.all([
      administrator.roleAssignment.count({ where: { tenantId } }),
      administrator.agentInstance.count({ where: { tenantId } }),
      administrator.auditEvent.count({
        where: {
          tenantId,
          action: { in: ['admin.role_assignment.created', 'admin.role_assignment.revoked'] },
        },
      }),
    ]);
    return { assignments, instances, audits };
  }

  async function seedFixtures(): Promise<void> {
    await administrator.tenant.createMany({
      data: [
        { id: tenantAId, slug: 'role-assignment-integration-a', name: 'Role assignment tenant A' },
        { id: tenantBId, slug: 'role-assignment-integration-b', name: 'Role assignment tenant B' },
      ],
    });
    await administrator.user.createMany({
      data: [
        {
          id: adminAId,
          tenantId: tenantAId,
          email: 'admin-a@role-assignment.integration',
          emailNormalized: 'admin-a@role-assignment.integration',
          displayName: 'Admin A',
          role: 'OWNER',
        },
        {
          id: assigneeAId,
          tenantId: tenantAId,
          email: 'assignee-a@role-assignment.integration',
          emailNormalized: 'assignee-a@role-assignment.integration',
          displayName: 'Assignee A',
        },
        {
          id: reviewerAId,
          tenantId: tenantAId,
          email: 'reviewer-a@role-assignment.integration',
          emailNormalized: 'reviewer-a@role-assignment.integration',
          displayName: 'Reviewer A',
          role: 'ADMIN',
        },
        {
          id: delegateAId,
          tenantId: tenantAId,
          email: 'delegate-a@role-assignment.integration',
          emailNormalized: 'delegate-a@role-assignment.integration',
          displayName: 'Delegate A',
        },
        {
          id: adminBId,
          tenantId: tenantBId,
          email: 'admin-b@role-assignment.integration',
          emailNormalized: 'admin-b@role-assignment.integration',
          displayName: 'Admin B',
          role: 'OWNER',
        },
        {
          id: assigneeBId,
          tenantId: tenantBId,
          email: 'assignee-b@role-assignment.integration',
          emailNormalized: 'assignee-b@role-assignment.integration',
          displayName: 'Assignee B',
        },
      ],
    });
    await administrator.organization.createMany({
      data: [
        { id: organizationAId, tenantId: tenantAId, name: 'Organization A' },
        { id: organizationBId, tenantId: tenantBId, name: 'Organization B' },
      ],
    });
    await administrator.orgUnit.createMany({
      data: [
        {
          id: orgUnitAId,
          tenantId: tenantAId,
          organizationId: organizationAId,
          name: 'Unit A',
        },
        {
          id: orgUnitBId,
          tenantId: tenantBId,
          organizationId: organizationBId,
          name: 'Unit B',
        },
      ],
    });
    await administrator.employment.createMany({
      data: [
        {
          id: employmentAId,
          tenantId: tenantAId,
          userId: assigneeAId,
          organizationId: organizationAId,
          orgUnitId: orgUnitAId,
          status: 'ACTIVE',
          isPrimary: true,
        },
        {
          id: employmentBId,
          tenantId: tenantBId,
          userId: assigneeBId,
          organizationId: organizationBId,
          orgUnitId: orgUnitBId,
          status: 'ACTIVE',
          isPrimary: true,
        },
        {
          id: delegateEmploymentAId,
          tenantId: tenantAId,
          userId: delegateAId,
          organizationId: organizationAId,
          orgUnitId: orgUnitAId,
          status: 'ACTIVE',
          isPrimary: true,
        },
      ],
    });
    await administrator.agentTemplate.createMany({
      data: [
        {
          id: templateAId,
          tenantId: tenantAId,
          key: 'role-integration-a',
          name: 'Role Integration A',
          ...governedRoleDefinition(),
        },
        {
          id: templateBId,
          tenantId: tenantBId,
          key: 'role-integration-b',
          name: 'Role Integration B',
          ...governedRoleDefinition(),
        },
      ],
    });
    await administrator.agentVersion.createMany({
      data: [
        agentVersionFixture(publishedVersionAId, tenantAId, templateAId, 1, 'PUBLISHED'),
        agentVersionFixture(draftVersionAId, tenantAId, templateAId, 2, 'DRAFT'),
        agentVersionFixture(testingVersionAId, tenantAId, templateAId, 3, 'TESTING'),
        agentVersionFixture(retiredVersionAId, tenantAId, templateAId, 4, 'RETIRED'),
        agentVersionFixture(publishedVersionBId, tenantBId, templateBId, 1, 'PUBLISHED'),
      ],
    });
  }

  async function cleanup(): Promise<void> {
    const tenantIds = [tenantAId, tenantBId];
    await cleanupDisposableTenants(administrator, tenantIds);
  }
});

function agentVersionFixture(
  id: string,
  tenantId: string,
  templateId: string,
  version: number,
  status: 'DRAFT' | 'TESTING' | 'PUBLISHED' | 'RETIRED',
) {
  const governed = status === 'PUBLISHED' || status === 'RETIRED';
  const authorId = tenantId === tenantAId ? adminAId : adminBId;
  const reviewerId = tenantId === tenantAId ? reviewerAId : assigneeBId;
  const reviewedAt = governed ? new Date() : null;
  return {
    id,
    tenantId,
    templateId,
    version,
    status,
    reviewStatus: governed ? ('APPROVED' as const) : ('NOT_SUBMITTED' as const),
    systemPrompt: `Role integration version ${version}`,
    modelPolicy: { provider: 'integration', model: 'integration' },
    toolPolicy: { allow: [] },
    knowledgeScope: { ids: [] },
    roleDefinitionSnapshot: governedRoleDefinition(),
    blueprintRevision: 1,
    createdById: authorId,
    reviewRequestedAt: reviewedAt,
    reviewRequestedById: governed ? authorId : null,
    reviewedAt,
    reviewedById: governed ? reviewerId : null,
    reviewComment: governed ? 'Approved integration fixture.' : null,
    approvedAt: reviewedAt,
    approvedById: governed ? reviewerId : null,
    publishedAt: status === 'PUBLISHED' || status === 'RETIRED' ? new Date() : null,
    publishedById: governed ? reviewerId : null,
    retiredAt: status === 'RETIRED' ? new Date() : null,
    retiredById: status === 'RETIRED' ? reviewerId : null,
  };
}

function governedRoleDefinition() {
  return {
    mission: 'Deliver governed and verifiable enterprise outcomes.',
    responsibilities: [
      {
        key: 'delivery',
        name: 'Delivery',
        description: 'Deliver a verified enterprise result.',
        outcomes: ['A verified result exists.'],
      },
    ],
    valueDefinition: {
      statement: 'Produce verifiable enterprise value.',
      stakeholderOutcomes: ['Stakeholders receive a reliable result.'],
      measures: ['Verified outcomes'],
    },
    capabilities: [],
    processes: [],
    tools: [],
    knowledgeDomains: [],
  };
}
