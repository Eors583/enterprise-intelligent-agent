import { createHmac } from 'node:crypto';

import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PrismaClient } from '@prisma/client';

import type { EnvironmentVariables } from '../src/config/environment.js';
import type { AdminPrismaService } from '../src/database/admin-prisma.service.js';
import { ScimPrismaService } from '../src/database/scim-prisma.service.js';
import type { AuthenticatedPrincipal } from '../src/modules/auth/domain/authenticated-principal.js';
import { BreakGlassService } from '../src/modules/identity-governance/break-glass.service.js';
import { IdentityGovernanceAdminService } from '../src/modules/identity-governance/identity-governance-admin.service.js';
import type { IdentitySecretVault } from '../src/modules/identity-governance/identity-secret-vault.js';
import type { OidcDiscoveryClient } from '../src/modules/identity-governance/oidc-discovery.client.js';
import { cleanupDisposableTenants } from './database-test-harness.js';

const enabled = process.env.RUN_DATABASE_TESTS === 'true';

const tenantId = '00000000-0000-7000-8000-00000000e901';
const requesterId = '00000000-0000-7000-8000-00000000e911';
const approverId = '00000000-0000-7000-8000-00000000e912';
const reviewerId = '00000000-0000-7000-8000-00000000e913';
const requesterFactorId = '00000000-0000-7000-8000-00000000e921';
const approverFactorId = '00000000-0000-7000-8000-00000000e922';
const reviewerFactorId = '00000000-0000-7000-8000-00000000e923';
const requesterSessionId = '00000000-0000-7000-8000-00000000e931';
const approverSessionId = '00000000-0000-7000-8000-00000000e932';
const reviewerSessionId = '00000000-0000-7000-8000-00000000e933';
const scimConnectorId = '00000000-0000-7000-8000-00000000e941';
const scimUserId = '00000000-0000-7000-8000-00000000e942';
const requesterDeviceId = '00000000-0000-7000-8000-00000000e943';
const scimNoDeactivationConnectorId = '00000000-0000-7000-8000-00000000e944';
const scimNoDeactivationUserId = '00000000-0000-7000-8000-00000000e945';
const queuedAgentRunId = '00000000-0000-7000-8000-00000000e951';
const runningAgentRunId = '00000000-0000-7000-8000-00000000e952';
const runningExternalRunId = '00000000-0000-7000-8000-00000000e953';
const sharedAgentOtherUserRunId = '00000000-0000-7000-8000-00000000e954';
const sharedAgentOtherUserExternalRunId = '00000000-0000-7000-8000-00000000e955';
const scimTokenPepper = 'database-integration-scim-token-pepper';

describe.runIf(enabled)('PostgreSQL enterprise identity governance integration', () => {
  const administrator = new PrismaClient();
  const scimPersistence = new ScimPrismaService(
    new ConfigService<EnvironmentVariables, true>({
      REPOSITORY_DRIVER: 'prisma',
      SCIM_DATABASE_URL: process.env.DATABASE_URL,
    } as EnvironmentVariables),
  );
  const service = new BreakGlassService({
    withTenant: <T>(
      scopedTenantId: string,
      operation: (transaction: Prisma.TransactionClient) => Promise<T>,
    ) =>
      administrator.$transaction(async (transaction) => {
        await transaction.$queryRaw`
          SELECT set_config('app.tenant_id', ${scopedTenantId}, true)
        `;
        return operation(transaction);
      }),
  } as unknown as AdminPrismaService);
  const scimAdmin = new IdentityGovernanceAdminService(
    {
      withTenant: <T>(
        scopedTenantId: string,
        operation: (transaction: Prisma.TransactionClient) => Promise<T>,
      ) =>
        administrator.$transaction(async (transaction) => {
          await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_admin');
          await transaction.$queryRaw`
            SELECT set_config('app.tenant_id', ${scopedTenantId}, true)
          `;
          return operation(transaction);
        }),
    } as unknown as AdminPrismaService,
    {} as IdentitySecretVault,
    {} as OidcDiscoveryClient,
    new ConfigService<EnvironmentVariables, true>({
      AUTH_TOKEN_PEPPER: scimTokenPepper,
    } as EnvironmentVariables),
  );

  beforeAll(async () => {
    await scimPersistence.onModuleInit();
    await cleanup();
    await seedFixtures();
  });

  afterAll(async () => {
    await cleanup();
    await scimPersistence.onModuleDestroy();
    await administrator.$disconnect();
  });

  it('completes the independently approved and reviewed lifecycle with immediate revocation', async () => {
    const pending = await service.request(
      {
        scopes: ['SESSION_REVOCATION'],
        reason: 'Production authentication is unavailable and requires bounded recovery access.',
        requestedDurationSeconds: 120,
        idempotencyKey: 'break-glass-request-lifecycle-0001',
      },
      requester,
    );
    expect(pending).toMatchObject({ status: 'PENDING_APPROVAL', revision: 1 });

    const replay = await service.request(
      {
        scopes: ['SESSION_REVOCATION'],
        reason: 'Production authentication is unavailable and requires bounded recovery access.',
        requestedDurationSeconds: 120,
        idempotencyKey: 'break-glass-request-lifecycle-0001',
      },
      requester,
    );
    expect(replay.id).toBe(pending.id);

    await expect(
      service.approve(
        pending.id,
        {
          expectedRevision: 1,
          comment: 'A requester must never approve their own emergency authority.',
          idempotencyKey: 'break-glass-self-approval-0001',
        },
        requester,
      ),
    ).rejects.toThrow(ForbiddenException);

    const approved = await service.approve(
      pending.id,
      {
        expectedRevision: 1,
        comment: 'Independent administrator approved the bounded recovery operation.',
        idempotencyKey: 'break-glass-approve-lifecycle-0001',
      },
      approver,
    );
    const active = await service.activate(
      pending.id,
      {
        expectedRevision: approved.revision,
        idempotencyKey: 'break-glass-activate-lifecycle-0001',
      },
      requester,
    );
    expect(active).toMatchObject({ status: 'ACTIVE', revision: 3, effective: true });
    await expect(service.hasActiveGrant('SESSION_REVOCATION', requester)).resolves.toBe(true);
    await expect(service.hasActiveGrant('SCIM_RECOVERY', requester)).resolves.toBe(false);

    const terminated = await service.revoke(
      pending.id,
      {
        expectedRevision: active.revision,
        reason: 'Recovery work completed; remove emergency authority immediately.',
        idempotencyKey: 'break-glass-revoke-lifecycle-0001',
      },
      requester,
    );
    expect(terminated).toMatchObject({
      status: 'REVIEW_PENDING',
      terminationKind: 'REVOKED',
      revision: 4,
      effective: false,
    });
    await expect(service.hasActiveGrant('SESSION_REVOCATION', requester)).resolves.toBe(false);

    const closed = await service.closeReview(
      pending.id,
      {
        expectedRevision: terminated.revision,
        outcome: 'NO_ISSUE',
        summary: 'Independent reviewer confirmed the grant was used only for session recovery.',
        idempotencyKey: 'break-glass-review-lifecycle-0001',
      },
      reviewer,
    );
    expect(closed).toMatchObject({
      status: 'CLOSED',
      reviewedByUserId: reviewerId,
      revision: 5,
    });

    const [counts] = await administrator.$queryRaw<
      Array<{ events: bigint; audits: bigint; outbox: bigint }>
    >`
      SELECT
        (
          SELECT count(*)
          FROM public."identity_break_glass_events"
          WHERE "tenant_id" = ${tenantId}::uuid
            AND "request_id" = ${pending.id}::uuid
        ) AS "events",
        (
          SELECT count(*)
          FROM public."audit_events"
          WHERE "tenant_id" = ${tenantId}::uuid
            AND "resource_type" = 'IdentityBreakGlassRequest'
            AND "resource_id" = ${pending.id}::uuid
        ) AS "audits",
        (
          SELECT count(*)
          FROM public."outbox_events"
          WHERE "tenant_id" = ${tenantId}::uuid
            AND "aggregate_type" = 'IdentityBreakGlassRequest'
            AND "aggregate_id" = ${pending.id}::uuid
        ) AS "outbox"
    `;
    expect(counts).toEqual({ events: 5n, audits: 5n, outbox: 5n });

    await expect(
      administrator.$executeRaw`
        DELETE FROM public."identity_break_glass_events"
        WHERE "tenant_id" = ${tenantId}::uuid
          AND "request_id" = ${pending.id}::uuid
      `,
    ).rejects.toThrow(/append-only/i);
  });

  it('rejects self-approval, missing transition evidence, and stale MFA in PostgreSQL', async () => {
    const selfApproval = await service.request(
      {
        scopes: ['IDENTITY_PROVIDER_RECOVERY'],
        reason: 'A deterministic fixture verifies database-enforced separation of duties.',
        requestedDurationSeconds: 60,
        idempotencyKey: 'break-glass-request-negative-0001',
      },
      requester,
    );
    await expect(
      administrator.$executeRaw`
        UPDATE public."identity_break_glass_requests"
        SET "status" = 'APPROVED',
            "approved_by_user_id" = ${requesterId}::uuid,
            "approval_comment" = 'The database must reject a self approval attempt.',
            "approved_at" = CURRENT_TIMESTAMP,
            "revision" = 2,
            "updated_at" = CURRENT_TIMESTAMP
        WHERE "tenant_id" = ${tenantId}::uuid
          AND "id" = ${selfApproval.id}::uuid
      `,
    ).rejects.toThrow();

    await expect(
      administrator.$transaction(async (transaction) => {
        await transaction.$executeRaw`
          UPDATE public."identity_break_glass_requests"
          SET "status" = 'APPROVED',
              "approved_by_user_id" = ${approverId}::uuid,
              "approval_comment" = 'This transition intentionally omits its immutable event.',
              "approved_at" = CURRENT_TIMESTAMP,
              "revision" = 2,
              "updated_at" = CURRENT_TIMESTAMP
          WHERE "tenant_id" = ${tenantId}::uuid
            AND "id" = ${selfApproval.id}::uuid
        `;
      }),
    ).rejects.toThrow(/requires an audit event/i);

    await administrator.authSession.update({
      where: { id: approverSessionId },
      data: { lastMfaAt: new Date(Date.now() - 10 * 60 * 1000) },
    });
    await expect(
      service.approve(
        selfApproval.id,
        {
          expectedRevision: 1,
          comment: 'A stale step-up must fail closed even for a valid administrator.',
          idempotencyKey: 'break-glass-stale-mfa-0001',
        },
        approver,
      ),
    ).rejects.toThrow(/recent MFA/i);
    await administrator.authSession.update({
      where: { id: approverSessionId },
      data: { lastMfaAt: new Date() },
    });
  });

  it('sweeps an elapsed grant and denies it at the authorization point', async () => {
    const pending = await service.request(
      {
        scopes: ['AUTHENTICATION_POLICY_RECOVERY'],
        reason: 'An elapsed emergency grant must terminate without a privileged user action.',
        requestedDurationSeconds: 60,
        idempotencyKey: 'break-glass-request-expiry-0001',
      },
      requester,
    );
    const approved = await service.approve(
      pending.id,
      {
        expectedRevision: 1,
        comment: 'Approve the deterministic elapsed-grant database fixture.',
        idempotencyKey: 'break-glass-approve-expiry-0001',
      },
      approver,
    );
    const activatedAt = new Date(Date.now() - 61_000);
    const activeUntil = new Date(activatedAt.getTime() + 60_000);
    await administrator.$transaction(async (transaction) => {
      await transaction.$executeRaw`
        UPDATE public."identity_break_glass_requests"
        SET "status" = 'ACTIVE',
            "activated_at" = ${activatedAt},
            "active_until" = ${activeUntil},
            "revision" = 3,
            "updated_at" = ${activatedAt}
        WHERE "tenant_id" = ${tenantId}::uuid
          AND "id" = ${pending.id}::uuid
          AND "revision" = ${approved.revision}
      `;
      await transaction.$executeRaw`
        INSERT INTO public."identity_break_glass_events" (
          "tenant_id", "request_id", "action", "from_status", "to_status",
          "actor_type", "actor_user_id", "actor_session_id",
          "expected_revision", "result_revision", "idempotency_key",
          "request_hash", "reason", "occurred_at"
        ) VALUES (
          ${tenantId}::uuid, ${pending.id}::uuid, 'ACTIVATE',
          'APPROVED', 'ACTIVE', 'USER', ${requesterId}::uuid,
          ${requesterSessionId}::uuid, 2, 3,
          'break-glass-activate-expiry-0001', ${'a'.repeat(64)},
          'Activate an already elapsed deterministic fixture.', CURRENT_TIMESTAMP
        )
      `;
    });

    await expect(service.hasActiveGrant('AUTHENTICATION_POLICY_RECOVERY', requester)).resolves.toBe(
      false,
    );
    const mine = await service.listMine(requester);
    expect(mine.items.find(({ id }) => id === pending.id)).toMatchObject({
      status: 'REVIEW_PENDING',
      terminationKind: 'EXPIRED',
      effective: false,
      revision: 4,
    });
    const events = await administrator.$queryRaw<Array<{ action: string; actor_type: string }>>`
      SELECT "action", "actor_type"
      FROM public."identity_break_glass_events"
      WHERE "tenant_id" = ${tenantId}::uuid
        AND "request_id" = ${pending.id}::uuid
      ORDER BY "result_revision"
    `;
    expect(events.at(-1)).toEqual({ action: 'EXPIRE', actor_type: 'SYSTEM' });
  });

  it('governs SCIM connectors and one-time service-token rotation through real PostgreSQL', async () => {
    const draft = await scimAdmin.createScimConnector(
      {
        key: 'governed-directory',
        displayName: 'Governed directory',
        allowUserCreate: true,
        allowGroupCreate: true,
        deactivateUserOnScimDisable: true,
        expectedRevision: 0,
        idempotencyKey: 'scim-governed-create-0001',
      },
      requester,
    );
    expect(draft).toMatchObject({ status: 'DRAFT', revision: 1 });

    const inReview = await scimAdmin.transitionScimConnector(
      draft.id,
      'SUBMIT',
      {
        expectedRevision: draft.revision,
        idempotencyKey: 'scim-governed-submit-0001',
      },
      requester,
    );
    await expect(
      scimAdmin.transitionScimConnector(
        draft.id,
        'ACTIVATE',
        {
          expectedRevision: inReview.revision,
          idempotencyKey: 'scim-governed-self-activate-0001',
        },
        requester,
      ),
    ).rejects.toThrow(ForbiddenException);

    const active = await scimAdmin.transitionScimConnector(
      draft.id,
      'ACTIVATE',
      {
        expectedRevision: inReview.revision,
        idempotencyKey: 'scim-governed-activate-0001',
      },
      approver,
    );
    expect(active).toMatchObject({
      status: 'ACTIVE',
      revision: 3,
      approvedByUserId: approverId,
    });

    const issued = await scimAdmin.createScimServiceToken(
      draft.id,
      {
        scopes: ['scim.users.read', 'scim.groups.read'],
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        idempotencyKey: 'scim-governed-token-0001',
      },
      approver,
    );
    const [persisted] = await administrator.$queryRaw<
      Array<{ token_hash: string; token_hint: string }>
    >`
      SELECT "token_hash", "token_hint"
      FROM public."scim_service_tokens"
      WHERE "tenant_id" = ${tenantId}::uuid
        AND "id" = ${issued.id}::uuid
    `;
    const expectedHash = createHmac('sha256', scimTokenPepper)
      .update('enterprise-agent:scim-service-token:v1\0')
      .update(issued.token)
      .digest('hex');
    expect(persisted).toEqual({ token_hash: expectedHash, token_hint: issued.tokenHint });
    await expect(
      scimPersistence.withToken(
        expectedHash,
        'governed-directory',
        async (_transaction, cap) => cap,
      ),
    ).resolves.toMatchObject({
      serviceTokenId: issued.id,
      tenantId,
      connectorId: draft.id,
      connectorKey: 'governed-directory',
      // Token scopes are canonicalized before persistence so the resolver
      // returns the same stable ordering exposed by the issuance response.
      scopes: issued.scopes,
      allowUserCreate: true,
      allowGroupCreate: true,
      deactivateUserOnDisable: true,
    });
    const [tokenTelemetry] = await administrator.$queryRaw<Array<{ last_used_at: Date | null }>>`
      SELECT "last_used_at"
      FROM public."scim_service_tokens"
      WHERE "tenant_id" = ${tenantId}::uuid
        AND "id" = ${issued.id}::uuid
    `;
    expect(tokenTelemetry?.last_used_at).toBeInstanceOf(Date);
    expect(JSON.stringify(await scimAdmin.listScimServiceTokens(draft.id, approver))).not.toContain(
      issued.token,
    );

    const rotatedExpiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    const rotated = await scimAdmin.rotateScimServiceToken(
      draft.id,
      issued.id,
      {
        scopes: issued.scopes,
        expiresAt: rotatedExpiresAt,
        expectedRevision: issued.revision,
        idempotencyKey: 'scim-governed-rotate-0001',
      },
      approver,
    );
    expect(rotated.token).not.toBe(issued.token);
    await expect(
      scimAdmin.rotateScimServiceToken(
        draft.id,
        issued.id,
        {
          scopes: issued.scopes,
          expiresAt: rotatedExpiresAt,
          expectedRevision: issued.revision,
          idempotencyKey: 'scim-governed-rotate-0001',
        },
        approver,
      ),
    ).rejects.toThrow(/plaintext cannot be shown again/i);
    const revoked = await scimAdmin.revokeScimServiceToken(
      draft.id,
      rotated.id,
      {
        expectedRevision: rotated.revision,
        idempotencyKey: 'scim-governed-revoke-0001',
      },
      approver,
    );
    expect(revoked).toMatchObject({ status: 'REVOKED', revision: 2 });

    const [evidence] = await administrator.$queryRaw<
      Array<{ commands: bigint; audits: bigint; outbox: bigint; active_tokens: bigint }>
    >`
      SELECT
        (
          SELECT count(*)
          FROM public."identity_governance_commands"
          WHERE "tenant_id" = ${tenantId}::uuid
            AND "resource_type" IN ('scim_connector', 'scim_service_token')
        ) AS "commands",
        (
          SELECT count(*)
          FROM public."audit_events"
          WHERE "tenant_id" = ${tenantId}::uuid
            AND "resource_type" IN ('scim_connector', 'scim_service_token')
        ) AS "audits",
        (
          SELECT count(*)
          FROM public."outbox_events"
          WHERE "tenant_id" = ${tenantId}::uuid
            AND "aggregate_type" IN ('scim_connector', 'scim_service_token')
        ) AS "outbox",
        (
          SELECT count(*)
          FROM public."scim_service_tokens"
          WHERE "tenant_id" = ${tenantId}::uuid
            AND "connector_id" = ${draft.id}::uuid
            AND "status" = 'ACTIVE'
        ) AS "active_tokens"
    `;
    expect(evidence).toEqual({
      commands: 6n,
      audits: 6n,
      outbox: 6n,
      active_tokens: 0n,
    });
  });

  it('preserves local identity access when connector deactivation is disabled', async () => {
    await administrator.$executeRaw`
      INSERT INTO public."scim_connectors" (
        "id", "tenant_id", "key", "display_name", "base_path",
        "deactivate_user_on_scim_disable",
        "idempotency_key", "request_hash", "proposed_by_user_id"
      ) VALUES (
        ${scimNoDeactivationConnectorId}::uuid, ${tenantId}::uuid,
        'database-fixture-no-deactivation', 'Database fixture without deactivation',
        '/api/v1/scim/v2/database-fixture-no-deactivation', false,
        'scim-connector-no-deactivation-0001', ${'a'.repeat(64)},
        ${requesterId}::uuid
      )
    `;
    await administrator.$executeRaw`
      INSERT INTO public."scim_users" (
        "id", "tenant_id", "connector_id", "scim_id", "external_id",
        "user_id", "user_name_normalized", "display_name", "active",
        "resource_version", "etag"
      ) VALUES (
        ${scimNoDeactivationUserId}::uuid, ${tenantId}::uuid,
        ${scimNoDeactivationConnectorId}::uuid, 'scim-no-deactivation-user',
        'employee-no-deactivation', ${reviewerId}::uuid,
        'reviewer@identity.integration', 'Independent reviewer', true, 1,
        ${'b'.repeat(64)}
      )
    `;

    await administrator.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_scim');
      await transaction.$queryRaw`
        SELECT set_config('app.tenant_id', ${tenantId}, true)
      `;
      await transaction.$executeRaw`
        UPDATE public."scim_users"
        SET "active" = false,
            "resource_version" = 2,
            "etag" = ${'c'.repeat(64)}
        WHERE "tenant_id" = ${tenantId}::uuid
          AND "connector_id" = ${scimNoDeactivationConnectorId}::uuid
          AND "id" = ${scimNoDeactivationUserId}::uuid
          AND "etag" = ${'b'.repeat(64)}
      `;
    });

    const [state] = await administrator.$queryRaw<
      Array<{
        scimActive: boolean;
        userStatus: string;
        sessionRevokedAt: Date | null;
        actions: bigint;
        audits: bigint;
        outbox: bigint;
      }>
    >`
      SELECT
        scim_user."active" AS "scimActive",
        user_row."status"::text AS "userStatus",
        session."revoked_at" AS "sessionRevokedAt",
        (
          SELECT count(*)
          FROM public."identity_deprovisioning_actions"
          WHERE "tenant_id" = ${tenantId}::uuid
            AND "scim_user_id" = ${scimNoDeactivationUserId}::uuid
        ) AS "actions",
        (
          SELECT count(*)
          FROM public."audit_events"
          WHERE "tenant_id" = ${tenantId}::uuid
            AND "action" = 'identity.scim.user.deprovisioned'
            AND "resource_id" = ${reviewerId}::uuid
        ) AS "audits",
        (
          SELECT count(*)
          FROM public."outbox_events"
          WHERE "tenant_id" = ${tenantId}::uuid
            AND "event_type" = 'IdentityPrincipalDeprovisioned.v1'
            AND "aggregate_id" = ${reviewerId}::uuid
        ) AS "outbox"
      FROM public."scim_users" AS scim_user
      JOIN public."users" AS user_row
        ON user_row."tenant_id" = scim_user."tenant_id"
       AND user_row."id" = scim_user."user_id"
      JOIN public."auth_sessions" AS session
        ON session."tenant_id" = user_row."tenant_id"
       AND session."id" = ${reviewerSessionId}::uuid
      WHERE scim_user."tenant_id" = ${tenantId}::uuid
        AND scim_user."id" = ${scimNoDeactivationUserId}::uuid
    `;
    expect(state).toEqual({
      scimActive: false,
      userStatus: 'ACTIVE',
      sessionRevokedAt: null,
      actions: 0n,
      audits: 0n,
      outbox: 0n,
    });
  });

  it('atomically deprovisions local identity access when SCIM becomes inactive', async () => {
    const template = await administrator.agentTemplate.create({
      data: {
        tenantId,
        key: 'scim-cancellation-fixture',
        name: 'SCIM cancellation fixture',
      },
    });
    const version = await administrator.agentVersion.create({
      data: {
        tenantId,
        templateId: template.id,
        version: 1,
        systemPrompt: 'Integration fixture.',
        modelPolicy: {},
        toolPolicy: {},
        knowledgeScope: {},
      },
    });
    const agent = await administrator.agentInstance.create({
      data: {
        tenantId,
        key: 'scim-cancellation-fixture',
        versionId: version.id,
        createdById: requesterId,
        name: 'SCIM cancellation fixture',
      },
    });
    const conversation = await administrator.conversation.create({
      data: {
        tenantId,
        directKey: 'scim-cancellation-fixture',
        createdById: requesterId,
      },
    });
    await administrator.conversationParticipant.create({
      data: {
        tenantId,
        conversationId: conversation.id,
        type: 'USER',
        participantKey: `user:${requesterId}`,
        userId: requesterId,
        displayName: 'Emergency requester',
      },
    });
    const input = await administrator.message.create({
      data: {
        tenantId,
        conversationId: conversation.id,
        senderType: 'USER',
        senderUserId: requesterId,
        senderKey: `user:${requesterId}`,
        senderName: 'Emergency requester',
        clientMessageId: 'scim-cancellation-fixture',
        content: { type: 'text', text: 'Fixture' },
      },
    });
    const runningConversation = await administrator.conversation.create({
      data: {
        tenantId,
        directKey: 'scim-cancellation-running-fixture',
        createdById: requesterId,
      },
    });
    await administrator.conversationParticipant.create({
      data: {
        tenantId,
        conversationId: runningConversation.id,
        type: 'USER',
        participantKey: `user:${requesterId}`,
        userId: requesterId,
        displayName: 'Emergency requester',
      },
    });
    const runningInput = await administrator.message.create({
      data: {
        tenantId,
        conversationId: runningConversation.id,
        senderType: 'USER',
        senderUserId: requesterId,
        senderKey: `user:${requesterId}`,
        senderName: 'Emergency requester',
        clientMessageId: 'scim-cancellation-running-fixture',
        content: { type: 'text', text: 'Running fixture' },
      },
    });
    const otherUserConversation = await administrator.conversation.create({
      data: {
        tenantId,
        directKey: 'scim-cancellation-other-user-fixture',
        createdById: approverId,
      },
    });
    await administrator.conversationParticipant.create({
      data: {
        tenantId,
        conversationId: otherUserConversation.id,
        type: 'USER',
        participantKey: `user:${approverId}`,
        userId: approverId,
        displayName: 'Independent approver',
      },
    });
    const otherUserInput = await administrator.message.create({
      data: {
        tenantId,
        conversationId: otherUserConversation.id,
        senderType: 'USER',
        senderUserId: approverId,
        senderKey: `user:${approverId}`,
        senderName: 'Independent approver',
        clientMessageId: 'scim-cancellation-other-user-fixture',
        content: { type: 'text', text: 'Other user fixture' },
      },
    });
    await administrator.agentRun.createMany({
      data: [
        {
          id: queuedAgentRunId,
          tenantId,
          conversationId: conversation.id,
          inputMessageId: input.id,
          requesterUserId: requesterId,
          agentId: agent.id,
          agentVersionId: version.id,
          idempotencyKey: 'scim-cancellation-queued',
          policySnapshot: {},
          status: 'QUEUED',
          reservedTokens: 20_000,
        },
        {
          id: runningAgentRunId,
          tenantId,
          conversationId: runningConversation.id,
          inputMessageId: runningInput.id,
          requesterUserId: requesterId,
          agentId: agent.id,
          agentVersionId: version.id,
          idempotencyKey: 'scim-cancellation-running',
          policySnapshot: {},
          status: 'RUNNING',
          externalRunId: runningExternalRunId,
          dispatchStartedAt: new Date(),
          startedAt: new Date(),
          reservedTokens: 20_000,
        },
        {
          id: sharedAgentOtherUserRunId,
          tenantId,
          conversationId: otherUserConversation.id,
          inputMessageId: otherUserInput.id,
          requesterUserId: approverId,
          agentId: agent.id,
          agentVersionId: version.id,
          idempotencyKey: 'scim-cancellation-shared-agent-other-user',
          policySnapshot: {},
          status: 'RUNNING',
          externalRunId: sharedAgentOtherUserExternalRunId,
          dispatchStartedAt: new Date(),
          startedAt: new Date(),
          reservedTokens: 20_000,
        },
      ],
    });

    await administrator.$executeRaw`
      INSERT INTO public."scim_connectors" (
        "id", "tenant_id", "key", "display_name", "base_path",
        "idempotency_key", "request_hash", "proposed_by_user_id"
      ) VALUES (
        ${scimConnectorId}::uuid, ${tenantId}::uuid, 'database-fixture',
        'Database fixture', '/api/v1/scim/v2/database-fixture',
        'scim-connector-database-fixture-0001', ${'c'.repeat(64)},
        ${requesterId}::uuid
      )
    `;
    await administrator.$executeRaw`
      INSERT INTO public."identity_devices" (
        "id", "tenant_id", "user_id", "fingerprint_hash", "label"
      ) VALUES (
        ${requesterDeviceId}::uuid, ${tenantId}::uuid, ${requesterId}::uuid,
        ${'d'.repeat(64)}, 'SCIM deprovision fixture'
      )
    `;
    await administrator.$executeRaw`
      INSERT INTO public."scim_users" (
        "id", "tenant_id", "connector_id", "scim_id", "external_id",
        "user_id", "user_name_normalized", "display_name", "active",
        "resource_version", "etag"
      ) VALUES (
        ${scimUserId}::uuid, ${tenantId}::uuid, ${scimConnectorId}::uuid,
        'scim-database-user', 'employee-database-fixture', ${requesterId}::uuid,
        'requester@identity.integration', 'Emergency requester', true, 1,
        ${'e'.repeat(64)}
      )
    `;

    await administrator.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_scim');
      await transaction.$queryRaw`
        SELECT set_config('app.tenant_id', ${tenantId}, true)
      `;
      await transaction.$executeRaw`
        UPDATE public."scim_users"
        SET "active" = false,
            "resource_version" = 2,
            "etag" = ${'f'.repeat(64)}
        WHERE "tenant_id" = ${tenantId}::uuid
          AND "connector_id" = ${scimConnectorId}::uuid
          AND "id" = ${scimUserId}::uuid
          AND "etag" = ${'e'.repeat(64)}
      `;
    });

    const [state] = await administrator.$queryRaw<
      Array<{
        userStatus: string;
        sessionRevokedAt: Date | null;
        sessionRevokedReason: string | null;
        deviceStatus: string;
        deviceReason: string | null;
        actions: bigint;
        audits: bigint;
        outbox: bigint;
        queuedStatus: string;
        queuedReservation: number;
        queuedCancellationRequested: Date | null;
        queuedCancellationConfirmed: Date | null;
        runningStatus: string;
        runningReservation: number;
        runningCancellationRequested: Date | null;
        runningCancellationConfirmed: Date | null;
        otherUserStatus: string;
        otherUserReservation: number;
        otherUserCancellationRequested: Date | null;
        cancellationOutbox: bigint;
      }>
    >`
      SELECT
        user_row."status"::text AS "userStatus",
        session."revoked_at" AS "sessionRevokedAt",
        session."revoked_reason" AS "sessionRevokedReason",
        device."status"::text AS "deviceStatus",
        device."revoke_reason" AS "deviceReason",
        (
          SELECT count(*)
          FROM public."identity_deprovisioning_actions"
          WHERE "tenant_id" = ${tenantId}::uuid
            AND "scim_user_id" = ${scimUserId}::uuid
            AND "sessions_revoked" >= 1
            AND "devices_revoked" = 1
            AND "agent_runs_cancelled" = 1
            AND "agent_runs_cancellation_requested" = 1
        ) AS "actions",
        (
          SELECT count(*)
          FROM public."audit_events"
          WHERE "tenant_id" = ${tenantId}::uuid
            AND "action" = 'identity.scim.user.deprovisioned'
            AND "resource_id" = ${requesterId}::uuid
        ) AS "audits",
        (
          SELECT count(*)
          FROM public."outbox_events"
          WHERE "tenant_id" = ${tenantId}::uuid
            AND "event_type" = 'IdentityPrincipalDeprovisioned.v1'
            AND "aggregate_id" = ${requesterId}::uuid
        ) AS "outbox",
        queued."status"::text AS "queuedStatus",
        queued."reserved_tokens" AS "queuedReservation",
        queued."cancellation_requested_at" AS "queuedCancellationRequested",
        queued."cancellation_confirmed_at" AS "queuedCancellationConfirmed",
        running."status"::text AS "runningStatus",
        running."reserved_tokens" AS "runningReservation",
        running."cancellation_requested_at" AS "runningCancellationRequested",
        running."cancellation_confirmed_at" AS "runningCancellationConfirmed",
        other_user_run."status"::text AS "otherUserStatus",
        other_user_run."reserved_tokens" AS "otherUserReservation",
        other_user_run."cancellation_requested_at" AS "otherUserCancellationRequested",
        (
          SELECT count(*)
          FROM public."outbox_events"
          WHERE "tenant_id" = ${tenantId}::uuid
            AND "event_type" = 'agent.run_cancel_requested.v1'
            AND "aggregate_id" = ${runningAgentRunId}::uuid
        ) AS "cancellationOutbox"
      FROM public."users" AS user_row
      JOIN public."auth_sessions" AS session
        ON session."tenant_id" = user_row."tenant_id"
       AND session."id" = ${requesterSessionId}::uuid
      JOIN public."identity_devices" AS device
        ON device."tenant_id" = user_row."tenant_id"
       AND device."id" = ${requesterDeviceId}::uuid
      JOIN public."agent_runs" AS queued
        ON queued."tenant_id" = user_row."tenant_id"
       AND queued."id" = ${queuedAgentRunId}::uuid
      JOIN public."agent_runs" AS running
        ON running."tenant_id" = user_row."tenant_id"
       AND running."id" = ${runningAgentRunId}::uuid
      JOIN public."agent_runs" AS other_user_run
        ON other_user_run."tenant_id" = user_row."tenant_id"
       AND other_user_run."id" = ${sharedAgentOtherUserRunId}::uuid
      WHERE user_row."tenant_id" = ${tenantId}::uuid
        AND user_row."id" = ${requesterId}::uuid
    `;
    expect(state).toEqual({
      userStatus: 'INACTIVE',
      sessionRevokedAt: expect.any(Date),
      sessionRevokedReason: 'SCIM_DEPROVISIONING',
      deviceStatus: 'REVOKED',
      deviceReason: 'SCIM_DEPROVISIONING',
      actions: 1n,
      audits: 1n,
      outbox: 1n,
      queuedStatus: 'CANCELLED',
      queuedReservation: 0,
      queuedCancellationRequested: null,
      queuedCancellationConfirmed: null,
      runningStatus: 'RUNNING',
      runningReservation: 20_000,
      runningCancellationRequested: expect.any(Date),
      runningCancellationConfirmed: null,
      otherUserStatus: 'RUNNING',
      otherUserReservation: 20_000,
      otherUserCancellationRequested: null,
      cancellationOutbox: 1n,
    });

    await expect(
      administrator.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_scim');
        await transaction.$queryRaw`
          SELECT set_config('app.tenant_id', ${tenantId}, true)
        `;
        await transaction.$executeRaw`
          UPDATE public."agent_runs"
          SET "status" = 'CANCELLED',
              "error_code" = 'IDENTITY_DEPROVISIONED',
              "error_message" = 'Forged cancellation must be rejected.',
              "finished_at" = CURRENT_TIMESTAMP,
              "reserved_tokens" = 0,
              "version" = "version" + 1,
              "updated_at" = CURRENT_TIMESTAMP
          WHERE "tenant_id" = ${tenantId}::uuid
            AND "id" = ${runningAgentRunId}::uuid
        `;
      }),
    ).rejects.toThrow(/permission denied for table agent_runs/i);

    await expect(
      administrator.$executeRaw`
        UPDATE public."scim_users"
        SET "active" = true,
            "deprovisioned_at" = NULL,
            "resource_version" = 3,
            "etag" = ${'0'.repeat(64)}
        WHERE "tenant_id" = ${tenantId}::uuid
          AND "id" = ${scimUserId}::uuid
      `,
    ).rejects.toThrow(/explicit admin reactivation/i);
  });

  async function seedFixtures(): Promise<void> {
    await administrator.tenant.create({
      data: {
        id: tenantId,
        slug: 'identity-governance-integration',
        name: 'Identity governance integration',
      },
    });
    await administrator.user.createMany({
      data: [
        {
          id: requesterId,
          tenantId,
          email: 'requester@identity.integration',
          emailNormalized: 'requester@identity.integration',
          displayName: 'Emergency requester',
          role: 'OWNER',
        },
        {
          id: approverId,
          tenantId,
          email: 'approver@identity.integration',
          emailNormalized: 'approver@identity.integration',
          displayName: 'Independent approver',
          role: 'ADMIN',
        },
        {
          id: reviewerId,
          tenantId,
          email: 'reviewer@identity.integration',
          emailNormalized: 'reviewer@identity.integration',
          displayName: 'Independent reviewer',
          role: 'ADMIN',
        },
      ],
    });
    const verifiedAt = new Date();
    await administrator.$executeRaw`
      INSERT INTO public."user_mfa_factors" (
        "id", "tenant_id", "user_id", "status", "secret_ref"
      ) VALUES
        (
          ${requesterFactorId}::uuid, ${tenantId}::uuid, ${requesterId}::uuid,
          'PENDING', 'test://requester-totp'
        ),
        (
          ${approverFactorId}::uuid, ${tenantId}::uuid, ${approverId}::uuid,
          'PENDING', 'test://approver-totp'
        ),
        (
          ${reviewerFactorId}::uuid, ${tenantId}::uuid, ${reviewerId}::uuid,
          'PENDING', 'test://reviewer-totp'
        )
    `;
    await administrator.$executeRaw`
      UPDATE public."user_mfa_factors"
      SET "status" = 'ACTIVE',
          "verified_at" = ${verifiedAt},
          "revision" = 2
      WHERE "tenant_id" = ${tenantId}::uuid
        AND "id" IN (
          ${requesterFactorId}::uuid,
          ${approverFactorId}::uuid,
          ${reviewerFactorId}::uuid
        )
    `;
    const accessExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const refreshExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await administrator.authSession.createMany({
      data: [
        sessionFixture(
          requesterSessionId,
          requesterId,
          requesterFactorId,
          '1',
          verifiedAt,
          accessExpiresAt,
          refreshExpiresAt,
        ),
        sessionFixture(
          approverSessionId,
          approverId,
          approverFactorId,
          '2',
          verifiedAt,
          accessExpiresAt,
          refreshExpiresAt,
        ),
        sessionFixture(
          reviewerSessionId,
          reviewerId,
          reviewerFactorId,
          '3',
          verifiedAt,
          accessExpiresAt,
          refreshExpiresAt,
        ),
      ],
    });
  }

  async function cleanup(): Promise<void> {
    await cleanupDisposableTenants(administrator, [tenantId]);
  }
});

function sessionFixture(
  id: string,
  userId: string,
  factorId: string,
  hashSeed: string,
  lastMfaAt: Date,
  accessExpiresAt: Date,
  refreshExpiresAt: Date,
) {
  return {
    id,
    tenantId,
    userId,
    accessTokenHash: hashSeed.repeat(64),
    refreshTokenHash: (Number(hashSeed) + 3).toString().repeat(64),
    accessExpiresAt,
    refreshExpiresAt,
    lastMfaAt,
    lastMfaMethod: 'TOTP' as const,
    lastMfaFactorId: factorId,
  };
}

const principalBase = {
  tenantId,
  tenantSlug: 'identity-governance-integration',
  tenantName: 'Identity governance integration',
  passwordChangeRequired: false,
  accessExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  refreshExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  authenticationSource: 'session' as const,
};

const requester: AuthenticatedPrincipal = {
  ...principalBase,
  sessionId: requesterSessionId,
  userId: requesterId,
  email: 'requester@identity.integration',
  displayName: 'Emergency requester',
  role: 'OWNER',
};

const approver: AuthenticatedPrincipal = {
  ...principalBase,
  sessionId: approverSessionId,
  userId: approverId,
  email: 'approver@identity.integration',
  displayName: 'Independent approver',
  role: 'ADMIN',
};

const reviewer: AuthenticatedPrincipal = {
  ...principalBase,
  sessionId: reviewerSessionId,
  userId: reviewerId,
  email: 'reviewer@identity.integration',
  displayName: 'Independent reviewer',
  role: 'ADMIN',
};
