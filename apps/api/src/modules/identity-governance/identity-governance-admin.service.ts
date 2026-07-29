import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type {
  CreateScimServiceTokenRequest,
  IdentityPolicy,
  IdentityProvider,
  IdentityProviderCommandRequest,
  OidcProviderInput,
  RevokeScimServiceTokenRequest,
  RotateScimServiceTokenRequest,
  ScimConnector,
  ScimConnectorCommandRequest,
  ScimConnectorCreateRequest,
  ScimConnectorUpdateRequest,
  ScimServiceTokenCreated,
  ScimServiceTokenMetadata,
  UpsertIdentityPolicyRequest,
} from '@enterprise/contracts';

import type { EnvironmentVariables } from '../../config/environment.js';
import { AdminPrismaService } from '../../database/admin-prisma.service.js';
import type { AuthenticatedPrincipal } from '../auth/domain/authenticated-principal.js';
import { IdentitySecretVault } from './identity-secret-vault.js';
import { OidcDiscoveryClient } from './oidc-discovery.client.js';

@Injectable()
export class IdentityGovernanceAdminService {
  private readonly pepper: string;

  constructor(
    @Inject(AdminPrismaService) private readonly prisma: AdminPrismaService,
    @Inject(IdentitySecretVault) private readonly vault: IdentitySecretVault,
    @Inject(OidcDiscoveryClient) private readonly discovery: OidcDiscoveryClient,
    @Inject(ConfigService)
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.pepper = config.get('AUTH_TOKEN_PEPPER', { infer: true });
  }

  async listProviders(principal: AuthenticatedPrincipal): Promise<{ items: IdentityProvider[] }> {
    requireAdmin(principal);
    const rows = await this.prisma.withTenant(
      principal.tenantId,
      (transaction) =>
        transaction.$queryRaw<ProviderRow[]>`
        SELECT provider."id", provider."key", provider."display_name",
               provider."protocol", provider."verification_status",
               provider."publication_status", provider."verification_error_code",
               provider."verified_at", provider."jit_mode",
               provider."allow_verified_email_linking",
               provider."allowed_email_domains", provider."revision",
               provider."proposed_by_user_id", provider."approved_by_user_id",
               provider."approved_at",
               oidc."issuer", oidc."discovery_url", oidc."authorization_endpoint",
               oidc."token_endpoint", oidc."jwks_uri", oidc."client_id",
               oidc."scopes", oidc."discovered_at", oidc."clock_skew_seconds",
               (secret."id" IS NOT NULL) AS "secret_configured",
               COALESCE(saml."fail_closed", true) AS "saml_fail_closed"
        FROM public."enterprise_identity_providers" AS provider
        LEFT JOIN public."oidc_provider_configs" AS oidc
          ON oidc."tenant_id" = provider."tenant_id"
         AND oidc."provider_id" = provider."id"
        LEFT JOIN public."identity_provider_secret_metadata" AS secret
          ON secret."tenant_id" = provider."tenant_id"
         AND secret."provider_id" = provider."id"
         AND secret."kind" = 'OIDC_CLIENT_SECRET'
        LEFT JOIN public."saml_provider_configs" AS saml
          ON saml."tenant_id" = provider."tenant_id"
         AND saml."provider_id" = provider."id"
        WHERE provider."tenant_id" = ${principal.tenantId}::uuid
        ORDER BY provider."display_name", provider."id"
      `,
    );
    return { items: rows.map(mapProvider) };
  }

  async upsertOidc(
    request: OidcProviderInput,
    principal: AuthenticatedPrincipal,
  ): Promise<IdentityProvider> {
    requireAdmin(principal);
    const discovered = await this.discovery.discover(request.discoveryUrl, request.issuer);
    const providerId = randomUUID();
    const safeRequest = { ...request, clientSecret: request.clientSecret !== undefined };
    const requestHash = hashJson(safeRequest);
    const secretDigest =
      request.clientSecret === undefined
        ? undefined
        : createHmac('sha256', this.pepper)
            .update('enterprise-agent:oidc-client-secret:v1\0')
            .update(request.clientSecret)
            .digest('hex');

    await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const existing = await transaction.$queryRaw<
        Array<{
          id: string;
          revision: number;
          idempotency_key: string;
          request_hash: string;
        }>
      >`
        SELECT "id", "revision", "idempotency_key", "request_hash"
        FROM public."enterprise_identity_providers"
        WHERE "tenant_id" = ${principal.tenantId}::uuid
          AND "key" = ${request.key}
        FOR UPDATE
      `;
      const current = existing[0];
      if (current !== undefined && current.idempotency_key === request.idempotencyKey) {
        if (current.request_hash !== requestHash) {
          throw new ConflictException('Idempotency key was reused with a different request.');
        }
        return;
      }
      if (current === undefined && request.expectedRevision !== 0) {
        throw new ConflictException('The identity provider does not exist.');
      }
      if (current !== undefined && current.revision !== request.expectedRevision) {
        throw new ConflictException('The identity provider changed; refresh and retry.');
      }
      if (current === undefined && request.clientSecret === undefined) {
        throw new BadRequestException('OIDC clientSecret is required when creating a provider.');
      }
      const id = current?.id ?? providerId;
      let secretMarker = secretDigest;
      if (request.clientSecret === undefined) {
        const metadata = await transaction.$queryRaw<Array<{ revision: number }>>`
          SELECT "revision"
          FROM public."identity_provider_secret_metadata"
          WHERE "tenant_id" = ${principal.tenantId}::uuid
            AND "provider_id" = ${id}::uuid
            AND "kind" = 'OIDC_CLIENT_SECRET'
        `;
        if (metadata[0] === undefined) {
          throw new BadRequestException('OIDC clientSecret is not configured.');
        }
        secretMarker = `retained-revision:${metadata[0].revision}`;
      }
      const configurationHash = hashJson({
        allowedEmailDomains: request.allowedEmailDomains,
        allowVerifiedEmailLinking: request.allowVerifiedEmailLinking,
        clientId: request.clientId,
        discoveryDocumentHash: discovered.documentHash,
        issuer: discovered.document.issuer,
        jitMode: request.jitMode,
        scopes: [...request.scopes].sort(),
        secretMarker,
      });
      if (current === undefined) {
        await transaction.$executeRaw`
          INSERT INTO public."enterprise_identity_providers" (
            "id", "tenant_id", "key", "display_name", "protocol",
            "configuration_hash", "jit_mode", "allow_verified_email_linking",
            "allowed_email_domains", "idempotency_key", "request_hash",
            "proposed_by_user_id"
          ) VALUES (
            ${id}::uuid, ${principal.tenantId}::uuid, ${request.key},
            ${request.displayName}, 'OIDC', ${configurationHash},
            ${request.jitMode}::public."IdentityProviderJitMode",
            ${request.allowVerifiedEmailLinking}, ${request.allowedEmailDomains},
            ${request.idempotencyKey}, ${requestHash}, ${principal.userId}::uuid
          )
        `;
      } else {
        await transaction.$executeRaw`
          UPDATE public."enterprise_identity_providers"
          SET "display_name" = ${request.displayName},
              "configuration_hash" = ${configurationHash},
              "verification_status" = 'NOT_VERIFIED',
              "verified_configuration_hash" = NULL,
              "verification_evidence_hash" = NULL,
              "verification_error_code" = NULL,
              "verified_at" = NULL,
              "publication_status" = 'DRAFT',
              "jit_mode" = ${request.jitMode}::public."IdentityProviderJitMode",
              "allow_verified_email_linking" = ${request.allowVerifiedEmailLinking},
              "allowed_email_domains" = ${request.allowedEmailDomains},
              "revision" = "revision" + 1,
              "approved_revision" = NULL,
              "approved_by_user_id" = NULL,
              "approved_at" = NULL,
              "idempotency_key" = ${request.idempotencyKey},
              "request_hash" = ${requestHash},
              "proposed_by_user_id" = ${principal.userId}::uuid,
              "updated_at" = CURRENT_TIMESTAMP
          WHERE "tenant_id" = ${principal.tenantId}::uuid
            AND "id" = ${id}::uuid
            AND "revision" = ${request.expectedRevision}
        `;
      }
      await transaction.$executeRaw`
        INSERT INTO public."oidc_provider_configs" (
          "provider_id", "tenant_id", "issuer", "discovery_url",
          "authorization_endpoint", "token_endpoint", "jwks_uri", "client_id",
          "scopes", "discovery_document_hash", "discovered_at",
          "clock_skew_seconds"
        ) VALUES (
          ${id}::uuid, ${principal.tenantId}::uuid, ${discovered.document.issuer},
          ${request.discoveryUrl}, ${discovered.document.authorization_endpoint},
          ${discovered.document.token_endpoint}, ${discovered.document.jwks_uri},
          ${request.clientId}, ${request.scopes}, ${discovered.documentHash},
          CURRENT_TIMESTAMP, ${request.clockSkewSeconds}
        )
        ON CONFLICT ("provider_id") DO UPDATE SET
          "issuer" = EXCLUDED."issuer",
          "discovery_url" = EXCLUDED."discovery_url",
          "authorization_endpoint" = EXCLUDED."authorization_endpoint",
          "token_endpoint" = EXCLUDED."token_endpoint",
          "jwks_uri" = EXCLUDED."jwks_uri",
          "client_id" = EXCLUDED."client_id",
          "scopes" = EXCLUDED."scopes",
          "discovery_document_hash" = EXCLUDED."discovery_document_hash",
          "discovered_at" = EXCLUDED."discovered_at",
          "clock_skew_seconds" = EXCLUDED."clock_skew_seconds",
          "updated_at" = CURRENT_TIMESTAMP
      `;
      if (request.clientSecret !== undefined) {
        const encrypted = this.vault.encrypt(request.clientSecret, {
          tenantId: principal.tenantId,
          resourceId: id,
          purpose: 'OIDC_CLIENT_SECRET',
        });
        await transaction.$executeRaw`
          INSERT INTO public."identity_provider_secrets" (
            "tenant_id", "provider_id", "kind", "secret_ciphertext",
            "secret_key_id", "secret_format_version"
          ) VALUES (
            ${principal.tenantId}::uuid, ${id}::uuid, 'OIDC_CLIENT_SECRET',
            ${encrypted.ciphertext}, ${encrypted.keyId}, ${encrypted.formatVersion}
          )
          ON CONFLICT ("tenant_id", "provider_id", "kind") DO UPDATE SET
            "secret_ciphertext" = EXCLUDED."secret_ciphertext",
            "secret_ref" = NULL,
            "secret_key_id" = EXCLUDED."secret_key_id",
            "secret_format_version" = EXCLUDED."secret_format_version",
            "revision" = public."identity_provider_secrets"."revision" + 1,
            "updated_at" = CURRENT_TIMESTAMP
        `;
      }
    });
    return this.requireProviderByKey(request.key, principal);
  }

  async verifyOidc(
    providerId: string,
    principal: AuthenticatedPrincipal,
  ): Promise<IdentityProvider> {
    requireAdmin(principal);
    const configuration = await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const rows = await transaction.$queryRaw<
        Array<{
          issuer: string;
          discovery_url: string;
          jwks_uri: string;
          configuration_hash: string;
        }>
      >`
        SELECT oidc."issuer", oidc."discovery_url", oidc."jwks_uri",
               provider."configuration_hash"
        FROM public."enterprise_identity_providers" AS provider
        JOIN public."oidc_provider_configs" AS oidc
          ON oidc."tenant_id" = provider."tenant_id"
         AND oidc."provider_id" = provider."id"
        WHERE provider."tenant_id" = ${principal.tenantId}::uuid
          AND provider."id" = ${providerId}::uuid
          AND provider."protocol" = 'OIDC'
      `;
      if (rows[0] === undefined) throw new NotFoundException('OIDC provider was not found.');
      return rows[0];
    });
    try {
      const [discovered, jwks] = await Promise.all([
        this.discovery.discover(configuration.discovery_url, configuration.issuer),
        this.discovery.jwks(configuration.jwks_uri),
      ]);
      const evidenceHash = hashJson({
        configurationHash: configuration.configuration_hash,
        discoveryDocumentHash: discovered.documentHash,
        jwksDocumentHash: jwks.documentHash,
      });
      await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        const updated = await transaction.$executeRaw`
          UPDATE public."enterprise_identity_providers"
          SET "verification_status" = 'VERIFIED',
              "verified_configuration_hash" = "configuration_hash",
              "verification_evidence_hash" = ${evidenceHash},
              "verification_error_code" = NULL,
              "verified_at" = CURRENT_TIMESTAMP,
              "updated_at" = CURRENT_TIMESTAMP
          WHERE "tenant_id" = ${principal.tenantId}::uuid
            AND "id" = ${providerId}::uuid
            AND "configuration_hash" = ${configuration.configuration_hash}
        `;
        if (updated !== 1) {
          throw new ConflictException('Provider configuration changed during verification.');
        }
      });
    } catch (error) {
      await this.prisma.withTenant(
        principal.tenantId,
        (transaction) =>
          transaction.$executeRaw`
          UPDATE public."enterprise_identity_providers"
          SET "verification_status" = 'FAILED',
              "verified_configuration_hash" = NULL,
              "verification_evidence_hash" = NULL,
              "verification_error_code" = 'OIDC_DISCOVERY_OR_JWKS_INVALID',
              "verified_at" = NULL,
              "updated_at" = CURRENT_TIMESTAMP
          WHERE "tenant_id" = ${principal.tenantId}::uuid
            AND "id" = ${providerId}::uuid
        `,
      );
      throw error;
    }
    return this.requireProvider(providerId, principal);
  }

  transitionProvider(
    providerId: string,
    action: 'SUBMIT' | 'PUBLISH' | 'RETIRE',
    request: IdentityProviderCommandRequest,
    principal: AuthenticatedPrincipal,
  ): Promise<IdentityProvider> {
    requireAdmin(principal);
    return this.prisma
      .withTenant(principal.tenantId, async (transaction) => {
        const rows = await transaction.$queryRaw<
          Array<{
            revision: number;
            publication_status: string;
            verification_status: string;
            configuration_hash: string;
            verified_configuration_hash: string | null;
            proposed_by_user_id: string;
          }>
        >`
          SELECT "revision", "publication_status", "verification_status",
                 "configuration_hash", "verified_configuration_hash",
                 "proposed_by_user_id"
          FROM public."enterprise_identity_providers"
          WHERE "tenant_id" = ${principal.tenantId}::uuid
            AND "id" = ${providerId}::uuid
          FOR UPDATE
        `;
        const provider = rows[0];
        if (provider === undefined) throw new NotFoundException('Identity provider was not found.');
        if (provider.revision !== request.expectedRevision) {
          throw new ConflictException('The identity provider changed; refresh and retry.');
        }
        if (action === 'SUBMIT' && provider.publication_status !== 'DRAFT') {
          throw new ConflictException('Only a draft provider can be submitted.');
        }
        if (
          action === 'PUBLISH' &&
          (provider.publication_status !== 'IN_REVIEW' ||
            provider.verification_status !== 'VERIFIED' ||
            provider.verified_configuration_hash !== provider.configuration_hash)
        ) {
          throw new ConflictException('Provider must be reviewed and verified before publishing.');
        }
        if (action === 'PUBLISH' && provider.proposed_by_user_id === principal.userId) {
          throw new ForbiddenException('Provider maker and publication checker must be different.');
        }
        if (action === 'RETIRE' && provider.publication_status === 'RETIRED') {
          throw new ConflictException('Provider is already retired.');
        }
        const nextStatus = {
          SUBMIT: 'IN_REVIEW',
          PUBLISH: 'PUBLISHED',
          RETIRE: 'RETIRED',
        }[action]!;
        const nextRevision = provider.revision + 1;
        const updated = await transaction.$executeRaw`
          UPDATE public."enterprise_identity_providers"
          SET "publication_status" = ${nextStatus}::public."IdentityPublicationStatus",
              "revision" = ${nextRevision},
              "approved_revision" = ${action === 'PUBLISH' ? nextRevision : null},
              "approved_by_user_id" = ${action === 'PUBLISH' ? principal.userId : null}::uuid,
              "approved_at" = ${action === 'PUBLISH' ? new Date() : null},
              "updated_at" = CURRENT_TIMESTAMP
          WHERE "tenant_id" = ${principal.tenantId}::uuid
            AND "id" = ${providerId}::uuid
            AND "revision" = ${request.expectedRevision}
        `;
        if (updated !== 1) {
          throw new ConflictException('The identity provider changed; refresh and retry.');
        }
        await insertGovernanceCommand(transaction, {
          tenantId: principal.tenantId,
          resourceType: 'identity_provider',
          resourceId: providerId,
          action,
          expectedRevision: provider.revision,
          resultRevision: nextRevision,
          idempotencyKey: request.idempotencyKey,
          requestHash: hashJson({ action, providerId, ...request }),
          makerUserId: principal.userId,
          checkerUserId: action === 'PUBLISH' ? provider.proposed_by_user_id : null,
          independentApproval: action === 'PUBLISH',
          sessionId: principal.sessionId,
        });
      })
      .then(() => this.requireProvider(providerId, principal));
  }

  async listScimConnectors(principal: AuthenticatedPrincipal): Promise<{ items: ScimConnector[] }> {
    requireAdmin(principal);
    const rows = await this.prisma.withTenant(
      principal.tenantId,
      (transaction) =>
        transaction.$queryRaw<ScimConnectorRow[]>`
        SELECT "id", "key", "display_name", "status", "base_path",
               "allow_user_create", "allow_group_create",
               "deactivate_user_on_scim_disable", "revision",
               "proposed_by_user_id", "approved_by_user_id", "approved_at",
               "created_at", "updated_at"
        FROM public."scim_connectors"
        WHERE "tenant_id" = ${principal.tenantId}::uuid
        ORDER BY "display_name", "id"
      `,
    );
    return { items: rows.map(mapScimConnector) };
  }

  async createScimConnector(
    request: ScimConnectorCreateRequest,
    principal: AuthenticatedPrincipal,
  ): Promise<ScimConnector> {
    requireAdmin(principal);
    const connectorId = randomUUID();
    const requestHash = hashJson({ action: 'CREATE', ...request });
    const resourceId = await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await takeIdempotencyLock(transaction, principal.tenantId, request.idempotencyKey);
      const replay = await transaction.$queryRaw<Array<{ id: string; request_hash: string }>>`
          SELECT "id", "request_hash"
          FROM public."scim_connectors"
          WHERE "tenant_id" = ${principal.tenantId}::uuid
            AND "idempotency_key" = ${request.idempotencyKey}
        `;
      if (replay[0] !== undefined) {
        if (replay[0].request_hash !== requestHash) {
          throw new ConflictException(
            'Idempotency key was reused with a different SCIM connector request.',
          );
        }
        return replay[0].id;
      }
      const duplicate = await transaction.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM public."scim_connectors"
          WHERE "tenant_id" = ${principal.tenantId}::uuid
            AND "key" = ${request.key}
        `;
      if (duplicate[0] !== undefined) {
        throw new ConflictException('A SCIM connector with this key already exists.');
      }
      await transaction.$executeRaw`
          INSERT INTO public."scim_connectors" (
            "id", "tenant_id", "key", "display_name", "base_path",
            "allow_user_create", "allow_group_create",
            "deactivate_user_on_scim_disable", "idempotency_key",
            "request_hash", "proposed_by_user_id"
          ) VALUES (
            ${connectorId}::uuid, ${principal.tenantId}::uuid, ${request.key},
            ${request.displayName}, ${`/api/v1/scim/v2/${request.key}`},
            ${request.allowUserCreate}, ${request.allowGroupCreate},
            ${request.deactivateUserOnScimDisable}, ${request.idempotencyKey},
            ${requestHash}, ${principal.userId}::uuid
          )
        `;
      await insertGovernanceCommand(transaction, {
        tenantId: principal.tenantId,
        resourceType: 'scim_connector',
        resourceId: connectorId,
        action: 'CREATE',
        expectedRevision: 0,
        resultRevision: 1,
        idempotencyKey: request.idempotencyKey,
        requestHash,
        makerUserId: principal.userId,
        checkerUserId: null,
        independentApproval: false,
        sessionId: principal.sessionId,
      });
      return connectorId;
    });
    return this.requireScimConnector(resourceId, principal);
  }

  async updateScimConnector(
    connectorId: string,
    request: ScimConnectorUpdateRequest,
    principal: AuthenticatedPrincipal,
  ): Promise<ScimConnector> {
    requireAdmin(principal);
    const requestHash = hashJson({ action: 'UPDATE', connectorId, ...request });
    await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const current = await lockScimConnector(transaction, principal.tenantId, connectorId);
      if (
        await governanceCommandWasApplied(transaction, {
          tenantId: principal.tenantId,
          resourceType: 'scim_connector',
          resourceId: connectorId,
          action: 'UPDATE',
          idempotencyKey: request.idempotencyKey,
          requestHash,
        })
      ) {
        return;
      }
      if (current.status === 'RETIRED') {
        throw new ConflictException('A retired SCIM connector cannot be edited.');
      }
      if (current.revision !== request.expectedRevision) {
        throw new ConflictException('The SCIM connector changed; refresh and retry.');
      }
      const nextRevision = current.revision + 1;
      const updated = await transaction.$executeRaw`
        UPDATE public."scim_connectors"
        SET "display_name" = ${request.displayName},
            "allow_user_create" = ${request.allowUserCreate},
            "allow_group_create" = ${request.allowGroupCreate},
            "deactivate_user_on_scim_disable" = ${request.deactivateUserOnScimDisable},
            "status" = 'DRAFT',
            "revision" = ${nextRevision},
            "approved_revision" = NULL,
            "approved_by_user_id" = NULL,
            "approved_at" = NULL,
            "idempotency_key" = ${request.idempotencyKey},
            "request_hash" = ${requestHash},
            "proposed_by_user_id" = ${principal.userId}::uuid
        WHERE "tenant_id" = ${principal.tenantId}::uuid
          AND "id" = ${connectorId}::uuid
          AND "revision" = ${request.expectedRevision}
      `;
      if (updated !== 1) {
        throw new ConflictException('The SCIM connector changed; refresh and retry.');
      }
      await insertGovernanceCommand(transaction, {
        tenantId: principal.tenantId,
        resourceType: 'scim_connector',
        resourceId: connectorId,
        action: 'UPDATE',
        expectedRevision: current.revision,
        resultRevision: nextRevision,
        idempotencyKey: request.idempotencyKey,
        requestHash,
        makerUserId: principal.userId,
        checkerUserId: null,
        independentApproval: false,
        sessionId: principal.sessionId,
      });
    });
    return this.requireScimConnector(connectorId, principal);
  }

  async transitionScimConnector(
    connectorId: string,
    action: 'SUBMIT' | 'ACTIVATE' | 'SUSPEND' | 'RETIRE',
    request: ScimConnectorCommandRequest,
    principal: AuthenticatedPrincipal,
  ): Promise<ScimConnector> {
    requireAdmin(principal);
    const requestHash = hashJson({ action, connectorId, ...request });
    await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const current = await lockScimConnector(transaction, principal.tenantId, connectorId);
      if (
        await governanceCommandWasApplied(transaction, {
          tenantId: principal.tenantId,
          resourceType: 'scim_connector',
          resourceId: connectorId,
          action,
          idempotencyKey: request.idempotencyKey,
          requestHash,
        })
      ) {
        return;
      }
      if (current.revision !== request.expectedRevision) {
        throw new ConflictException('The SCIM connector changed; refresh and retry.');
      }
      const allowed =
        (action === 'SUBMIT' && current.status === 'DRAFT') ||
        (action === 'ACTIVATE' &&
          (current.status === 'IN_REVIEW' || current.status === 'SUSPENDED')) ||
        (action === 'SUSPEND' && current.status === 'ACTIVE') ||
        (action === 'RETIRE' && (current.status === 'ACTIVE' || current.status === 'SUSPENDED'));
      if (!allowed) {
        throw new ConflictException(`SCIM connector cannot ${action.toLowerCase()} from here.`);
      }
      if (action === 'ACTIVATE' && current.proposed_by_user_id === principal.userId) {
        throw new ForbiddenException(
          'The SCIM connector proposer and activation checker must be different.',
        );
      }
      const nextStatus = {
        SUBMIT: 'IN_REVIEW',
        ACTIVATE: 'ACTIVE',
        SUSPEND: 'SUSPENDED',
        RETIRE: 'RETIRED',
      }[action]!;
      const nextRevision = current.revision + 1;
      const updated = await transaction.$executeRaw`
        UPDATE public."scim_connectors"
        SET "status" = ${nextStatus}::public."ScimConnectorStatus",
            "revision" = ${nextRevision},
            "approved_revision" = ${action === 'ACTIVATE' ? nextRevision : null},
            "approved_by_user_id" = ${action === 'ACTIVATE' ? principal.userId : null}::uuid,
            "approved_at" = ${action === 'ACTIVATE' ? new Date() : null}
        WHERE "tenant_id" = ${principal.tenantId}::uuid
          AND "id" = ${connectorId}::uuid
          AND "revision" = ${request.expectedRevision}
      `;
      if (updated !== 1) {
        throw new ConflictException('The SCIM connector changed; refresh and retry.');
      }
      await insertGovernanceCommand(transaction, {
        tenantId: principal.tenantId,
        resourceType: 'scim_connector',
        resourceId: connectorId,
        action,
        expectedRevision: current.revision,
        resultRevision: nextRevision,
        idempotencyKey: request.idempotencyKey,
        requestHash,
        makerUserId: principal.userId,
        checkerUserId: action === 'ACTIVATE' ? current.proposed_by_user_id : null,
        independentApproval: action === 'ACTIVATE',
        sessionId: principal.sessionId,
      });
    });
    return this.requireScimConnector(connectorId, principal);
  }

  async listScimServiceTokens(
    connectorId: string,
    principal: AuthenticatedPrincipal,
  ): Promise<{ items: ScimServiceTokenMetadata[] }> {
    requireAdmin(principal);
    await this.requireScimConnector(connectorId, principal);
    const rows = await this.prisma.withTenant(
      principal.tenantId,
      (transaction) =>
        transaction.$queryRaw<ScimServiceTokenRow[]>`
        SELECT "id", "connector_id", "token_hint",
               CASE
                 WHEN "status" = 'ACTIVE'
                  AND "expires_at" IS NOT NULL
                  AND "expires_at" <= CURRENT_TIMESTAMP
                 THEN 'EXPIRED'
                 ELSE "status"::text
               END AS "status",
               "scopes", "created_by_user_id", "expires_at", "last_used_at",
               "revoked_at", "revision", "created_at"
        FROM public."scim_service_token_metadata"
        WHERE "tenant_id" = ${principal.tenantId}::uuid
          AND "connector_id" = ${connectorId}::uuid
        ORDER BY "created_at" DESC, "id"
      `,
    );
    return { items: rows.map(mapScimServiceToken) };
  }

  async createScimServiceToken(
    connectorId: string,
    request: CreateScimServiceTokenRequest,
    principal: AuthenticatedPrincipal,
  ): Promise<ScimServiceTokenCreated> {
    requireAdmin(principal);
    const now = new Date();
    validateScimTokenExpiration(request.expiresAt, now);
    const token = `ea_scim_${randomBytes(32).toString('base64url')}`;
    const tokenHash = this.hashSecret('scim-service-token', token);
    const tokenHint = token.slice(-8);
    const tokenId = randomUUID();
    const scopes = [...request.scopes].sort();
    const requestHash = hashJson({
      action: 'CREATE_TOKEN',
      connectorId,
      expiresAt: request.expiresAt,
      scopes,
    });
    const row = await this.prisma.withTenant(
      principal.tenantId,
      async (transaction): Promise<ScimServiceTokenRow> => {
        const connector = await lockScimConnector(transaction, principal.tenantId, connectorId);
        if (connector.status !== 'ACTIVE') {
          throw new ConflictException('Only an active SCIM connector can issue service tokens.');
        }
        if (
          await governanceCommandWasApplied(transaction, {
            tenantId: principal.tenantId,
            resourceType: 'scim_service_token',
            resourceId: null,
            action: 'CREATE_TOKEN',
            idempotencyKey: request.idempotencyKey,
            requestHash,
          })
        ) {
          throw new ConflictException(
            'This service token was already created. Its plaintext cannot be shown again.',
          );
        }
        const rows = await transaction.$queryRaw<ScimServiceTokenRow[]>`
          INSERT INTO public."scim_service_tokens" (
            "id", "tenant_id", "connector_id", "token_hash", "token_hint",
            "scopes", "created_by_user_id", "expires_at"
          ) VALUES (
            ${tokenId}::uuid, ${principal.tenantId}::uuid, ${connectorId}::uuid,
            ${tokenHash}, ${tokenHint}, ${scopes}, ${principal.userId}::uuid,
            ${request.expiresAt === null ? null : new Date(request.expiresAt)}
          )
          RETURNING "id", "connector_id", "token_hint", "status"::text AS "status",
                    "scopes", "created_by_user_id", "expires_at", "last_used_at",
                    "revoked_at", "revision", "created_at"
        `;
        await insertGovernanceCommand(transaction, {
          tenantId: principal.tenantId,
          resourceType: 'scim_service_token',
          resourceId: tokenId,
          action: 'CREATE_TOKEN',
          expectedRevision: 0,
          resultRevision: 1,
          idempotencyKey: request.idempotencyKey,
          requestHash,
          makerUserId: principal.userId,
          checkerUserId: null,
          independentApproval: false,
          sessionId: principal.sessionId,
        });
        return rows[0]!;
      },
    );
    return mapCreatedScimServiceToken(row, token);
  }

  async rotateScimServiceToken(
    connectorId: string,
    tokenId: string,
    request: RotateScimServiceTokenRequest,
    principal: AuthenticatedPrincipal,
  ): Promise<ScimServiceTokenCreated> {
    requireAdmin(principal);
    const now = new Date();
    validateScimTokenExpiration(request.expiresAt, now);
    const token = `ea_scim_${randomBytes(32).toString('base64url')}`;
    const tokenHash = this.hashSecret('scim-service-token', token);
    const tokenHint = token.slice(-8);
    const nextTokenId = randomUUID();
    const scopes = [...request.scopes].sort();
    const requestHash = hashJson({
      action: 'ROTATE_TOKEN',
      connectorId,
      tokenId,
      expiresAt: request.expiresAt,
      scopes,
    });
    const row = await this.prisma.withTenant(
      principal.tenantId,
      async (transaction): Promise<ScimServiceTokenRow> => {
        const connector = await lockScimConnector(transaction, principal.tenantId, connectorId);
        if (connector.status !== 'ACTIVE') {
          throw new ConflictException('Only an active SCIM connector can rotate service tokens.');
        }
        const current = await lockScimServiceToken(
          transaction,
          principal.tenantId,
          connectorId,
          tokenId,
        );
        if (
          await governanceCommandWasApplied(transaction, {
            tenantId: principal.tenantId,
            resourceType: 'scim_service_token',
            resourceId: tokenId,
            action: 'ROTATE_TOKEN',
            idempotencyKey: request.idempotencyKey,
            requestHash,
          })
        ) {
          throw new ConflictException(
            'This service token was already rotated. New plaintext cannot be shown again.',
          );
        }
        if (current.status !== 'ACTIVE') {
          throw new ConflictException('Only an active SCIM service token can be rotated.');
        }
        if (current.revision !== request.expectedRevision) {
          throw new ConflictException('The SCIM service token changed; refresh and retry.');
        }
        const revoked = await transaction.$executeRaw`
          UPDATE public."scim_service_tokens"
          SET "status" = 'REVOKED',
              "revoked_at" = CURRENT_TIMESTAMP,
              "revision" = "revision" + 1
          WHERE "tenant_id" = ${principal.tenantId}::uuid
            AND "connector_id" = ${connectorId}::uuid
            AND "id" = ${tokenId}::uuid
            AND "status" = 'ACTIVE'
            AND "revision" = ${request.expectedRevision}
        `;
        if (revoked !== 1) {
          throw new ConflictException('The SCIM service token changed; refresh and retry.');
        }
        const rows = await transaction.$queryRaw<ScimServiceTokenRow[]>`
          INSERT INTO public."scim_service_tokens" (
            "id", "tenant_id", "connector_id", "token_hash", "token_hint",
            "scopes", "created_by_user_id", "expires_at"
          ) VALUES (
            ${nextTokenId}::uuid, ${principal.tenantId}::uuid, ${connectorId}::uuid,
            ${tokenHash}, ${tokenHint}, ${scopes}, ${principal.userId}::uuid,
            ${request.expiresAt === null ? null : new Date(request.expiresAt)}
          )
          RETURNING "id", "connector_id", "token_hint", "status"::text AS "status",
                    "scopes", "created_by_user_id", "expires_at", "last_used_at",
                    "revoked_at", "revision", "created_at"
        `;
        await insertGovernanceCommand(transaction, {
          tenantId: principal.tenantId,
          resourceType: 'scim_service_token',
          resourceId: tokenId,
          action: 'ROTATE_TOKEN',
          expectedRevision: current.revision,
          resultRevision: current.revision + 1,
          idempotencyKey: request.idempotencyKey,
          requestHash,
          makerUserId: principal.userId,
          checkerUserId: null,
          independentApproval: false,
          sessionId: principal.sessionId,
        });
        return rows[0]!;
      },
    );
    return mapCreatedScimServiceToken(row, token);
  }

  async revokeScimServiceToken(
    connectorId: string,
    tokenId: string,
    request: RevokeScimServiceTokenRequest,
    principal: AuthenticatedPrincipal,
  ): Promise<ScimServiceTokenMetadata> {
    requireAdmin(principal);
    const requestHash = hashJson({
      action: 'REVOKE_TOKEN',
      connectorId,
      tokenId,
      ...request,
    });
    const row = await this.prisma.withTenant(
      principal.tenantId,
      async (transaction): Promise<ScimServiceTokenRow> => {
        const current = await lockScimServiceToken(
          transaction,
          principal.tenantId,
          connectorId,
          tokenId,
        );
        if (
          await governanceCommandWasApplied(transaction, {
            tenantId: principal.tenantId,
            resourceType: 'scim_service_token',
            resourceId: tokenId,
            action: 'REVOKE_TOKEN',
            idempotencyKey: request.idempotencyKey,
            requestHash,
          })
        ) {
          return current;
        }
        if (current.status !== 'ACTIVE') {
          throw new ConflictException('The SCIM service token is already terminal.');
        }
        if (current.revision !== request.expectedRevision) {
          throw new ConflictException('The SCIM service token changed; refresh and retry.');
        }
        const rows = await transaction.$queryRaw<ScimServiceTokenRow[]>`
          UPDATE public."scim_service_tokens"
          SET "status" = 'REVOKED',
              "revoked_at" = CURRENT_TIMESTAMP,
              "revision" = "revision" + 1
          WHERE "tenant_id" = ${principal.tenantId}::uuid
            AND "connector_id" = ${connectorId}::uuid
            AND "id" = ${tokenId}::uuid
            AND "status" = 'ACTIVE'
            AND "revision" = ${request.expectedRevision}
          RETURNING "id", "connector_id", "token_hint", "status"::text AS "status",
                    "scopes", "created_by_user_id", "expires_at", "last_used_at",
                    "revoked_at", "revision", "created_at"
        `;
        if (rows[0] === undefined) {
          throw new ConflictException('The SCIM service token changed; refresh and retry.');
        }
        await insertGovernanceCommand(transaction, {
          tenantId: principal.tenantId,
          resourceType: 'scim_service_token',
          resourceId: tokenId,
          action: 'REVOKE_TOKEN',
          expectedRevision: current.revision,
          resultRevision: current.revision + 1,
          idempotencyKey: request.idempotencyKey,
          requestHash,
          makerUserId: principal.userId,
          checkerUserId: null,
          independentApproval: false,
          sessionId: principal.sessionId,
        });
        return rows[0];
      },
    );
    return mapScimServiceToken(row);
  }

  async getPolicy(principal: AuthenticatedPrincipal): Promise<IdentityPolicy | null> {
    requireAdmin(principal);
    const rows = await this.prisma.withTenant(
      principal.tenantId,
      (transaction) =>
        transaction.$queryRaw<PolicyMetadataRow[]>`
        SELECT *
        FROM public."enterprise_identity_policies"
        WHERE "tenant_id" = ${principal.tenantId}::uuid
      `,
    );
    return rows[0] === undefined ? null : mapPolicy(rows[0]);
  }

  async upsertPolicy(
    request: UpsertIdentityPolicyRequest,
    principal: AuthenticatedPrincipal,
  ): Promise<IdentityPolicy> {
    requireAdmin(principal);
    const requestHash = hashJson(request);
    await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const rows = await transaction.$queryRaw<PolicyMetadataRow[]>`
        SELECT *
        FROM public."enterprise_identity_policies"
        WHERE "tenant_id" = ${principal.tenantId}::uuid
        FOR UPDATE
      `;
      const current = rows[0];
      if (current === undefined && request.expectedRevision !== 0) {
        throw new ConflictException('Identity policy does not exist.');
      }
      if (current !== undefined && current.revision !== request.expectedRevision) {
        throw new ConflictException('Identity policy changed; refresh and retry.');
      }
      if (current === undefined) {
        await transaction.$executeRaw`
          INSERT INTO public."enterprise_identity_policies" (
            "tenant_id", "mfa_requirement", "require_recent_mfa_for_admin",
            "recent_mfa_max_age_seconds", "totp_allowed_drift_steps",
            "totp_max_attempts", "totp_attempt_window_seconds",
            "allow_local_password_fallback", "idempotency_key", "request_hash",
            "proposed_by_user_id"
          ) VALUES (
            ${principal.tenantId}::uuid,
            ${request.mfaRequirement}::public."MfaPolicyRequirement",
            ${request.requireRecentMfaForAdmin}, ${request.recentMfaMaxAgeSeconds},
            ${request.totpAllowedDriftSteps}, ${request.totpMaxAttempts},
            ${request.totpAttemptWindowSeconds}, ${request.allowLocalPasswordFallback},
            ${request.idempotencyKey}, ${requestHash}, ${principal.userId}::uuid
          )
        `;
      } else {
        await transaction.$executeRaw`
          UPDATE public."enterprise_identity_policies"
          SET "publication_status" = 'DRAFT',
              "mfa_requirement" = ${request.mfaRequirement}::public."MfaPolicyRequirement",
              "require_recent_mfa_for_admin" = ${request.requireRecentMfaForAdmin},
              "recent_mfa_max_age_seconds" = ${request.recentMfaMaxAgeSeconds},
              "totp_allowed_drift_steps" = ${request.totpAllowedDriftSteps},
              "totp_max_attempts" = ${request.totpMaxAttempts},
              "totp_attempt_window_seconds" = ${request.totpAttemptWindowSeconds},
              "allow_local_password_fallback" = ${request.allowLocalPasswordFallback},
              "revision" = "revision" + 1,
              "approved_revision" = NULL,
              "approved_by_user_id" = NULL,
              "approved_at" = NULL,
              "idempotency_key" = ${request.idempotencyKey},
              "request_hash" = ${requestHash},
              "proposed_by_user_id" = ${principal.userId}::uuid,
              "updated_at" = CURRENT_TIMESTAMP
          WHERE "tenant_id" = ${principal.tenantId}::uuid
            AND "revision" = ${request.expectedRevision}
        `;
      }
    });
    const policy = await this.getPolicy(principal);
    if (policy === null) throw new Error('Identity policy write did not persist.');
    return policy;
  }

  private async requireProvider(
    providerId: string,
    principal: AuthenticatedPrincipal,
  ): Promise<IdentityProvider> {
    const providers = await this.listProviders(principal);
    const provider = providers.items.find((item) => item.id === providerId);
    if (provider === undefined) throw new NotFoundException('Identity provider was not found.');
    return provider;
  }

  private async requireProviderByKey(
    key: string,
    principal: AuthenticatedPrincipal,
  ): Promise<IdentityProvider> {
    const providers = await this.listProviders(principal);
    const provider = providers.items.find((item) => item.key === key);
    if (provider === undefined) throw new NotFoundException('Identity provider was not found.');
    return provider;
  }

  private async requireScimConnector(
    connectorId: string,
    principal: AuthenticatedPrincipal,
  ): Promise<ScimConnector> {
    const connectors = await this.listScimConnectors(principal);
    const connector = connectors.items.find((item) => item.id === connectorId);
    if (connector === undefined) throw new NotFoundException('SCIM connector was not found.');
    return connector;
  }

  private hashSecret(namespace: string, value: string): string {
    return createHmac('sha256', this.pepper)
      .update(`enterprise-agent:${namespace}:v1\0`)
      .update(value)
      .digest('hex');
  }
}

interface ProviderRow {
  readonly id: string;
  readonly key: string;
  readonly display_name: string;
  readonly protocol: 'OIDC' | 'SAML';
  readonly verification_status: 'NOT_VERIFIED' | 'VERIFIED' | 'FAILED';
  readonly publication_status: 'DRAFT' | 'IN_REVIEW' | 'PUBLISHED' | 'RETIRED';
  readonly verification_error_code: string | null;
  readonly verified_at: Date | null;
  readonly jit_mode: 'DISABLED' | 'EXISTING_USERS_ONLY' | 'CREATE_USERS';
  readonly allow_verified_email_linking: boolean;
  readonly allowed_email_domains: string[];
  readonly revision: number;
  readonly proposed_by_user_id: string;
  readonly approved_by_user_id: string | null;
  readonly approved_at: Date | null;
  readonly issuer: string | null;
  readonly discovery_url: string | null;
  readonly authorization_endpoint: string | null;
  readonly token_endpoint: string | null;
  readonly jwks_uri: string | null;
  readonly client_id: string | null;
  readonly scopes: string[] | null;
  readonly discovered_at: Date | null;
  readonly clock_skew_seconds: number | null;
  readonly secret_configured: boolean;
  readonly saml_fail_closed: boolean;
}

interface PolicyMetadataRow {
  readonly id: string;
  readonly publication_status: 'DRAFT' | 'IN_REVIEW' | 'PUBLISHED' | 'RETIRED';
  readonly mfa_requirement: 'OPTIONAL' | 'ADMINS' | 'ALL_USERS';
  readonly require_recent_mfa_for_admin: boolean;
  readonly recent_mfa_max_age_seconds: number;
  readonly totp_allowed_drift_steps: number;
  readonly totp_max_attempts: number;
  readonly totp_attempt_window_seconds: number;
  readonly allow_local_password_fallback: boolean;
  readonly revision: number;
  readonly proposed_by_user_id: string;
  readonly approved_by_user_id: string | null;
  readonly approved_at: Date | null;
  readonly updated_at: Date;
}

interface ScimConnectorRow {
  readonly id: string;
  readonly key: string;
  readonly display_name: string;
  readonly status: 'DRAFT' | 'IN_REVIEW' | 'ACTIVE' | 'SUSPENDED' | 'RETIRED';
  readonly base_path: string;
  readonly allow_user_create: boolean;
  readonly allow_group_create: boolean;
  readonly deactivate_user_on_scim_disable: boolean;
  readonly revision: number;
  readonly proposed_by_user_id: string;
  readonly approved_by_user_id: string | null;
  readonly approved_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface ScimConnectorLockRow {
  readonly revision: number;
  readonly status: 'DRAFT' | 'IN_REVIEW' | 'ACTIVE' | 'SUSPENDED' | 'RETIRED';
  readonly proposed_by_user_id: string;
}

interface ScimServiceTokenRow {
  readonly id: string;
  readonly connector_id: string;
  readonly token_hint: string;
  readonly status: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
  readonly scopes: Array<
    'scim.users.read' | 'scim.users.write' | 'scim.groups.read' | 'scim.groups.write'
  >;
  readonly created_by_user_id: string;
  readonly expires_at: Date | null;
  readonly last_used_at: Date | null;
  readonly revoked_at: Date | null;
  readonly revision: number;
  readonly created_at: Date;
}

function mapProvider(row: ProviderRow): IdentityProvider {
  const oidc =
    row.protocol === 'OIDC' &&
    row.issuer !== null &&
    row.discovery_url !== null &&
    row.authorization_endpoint !== null &&
    row.token_endpoint !== null &&
    row.jwks_uri !== null &&
    row.client_id !== null &&
    row.scopes !== null &&
    row.discovered_at !== null &&
    row.clock_skew_seconds !== null
      ? {
          issuer: row.issuer,
          discoveryUrl: row.discovery_url,
          authorizationEndpoint: row.authorization_endpoint,
          tokenEndpoint: row.token_endpoint,
          jwksUri: row.jwks_uri,
          clientId: row.client_id,
          scopes: row.scopes,
          discoveredAt: row.discovered_at.toISOString(),
          clockSkewSeconds: row.clock_skew_seconds,
        }
      : null;
  return {
    id: row.id,
    key: row.key,
    displayName: row.display_name,
    protocol: row.protocol,
    verificationStatus: row.verification_status,
    publicationStatus: row.publication_status,
    verificationErrorCode: row.verification_error_code,
    verifiedAt: row.verified_at?.toISOString() ?? null,
    jitMode: row.jit_mode,
    allowVerifiedEmailLinking: row.allow_verified_email_linking,
    allowedEmailDomains: row.allowed_email_domains,
    revision: row.revision,
    proposedByUserId: row.proposed_by_user_id,
    approvedByUserId: row.approved_by_user_id,
    approvedAt: row.approved_at?.toISOString() ?? null,
    secretConfigured: row.secret_configured,
    oidc,
    samlFailClosed: row.saml_fail_closed,
  };
}

function mapPolicy(row: PolicyMetadataRow): IdentityPolicy {
  return {
    id: row.id,
    publicationStatus: row.publication_status,
    mfaRequirement: row.mfa_requirement,
    requireRecentMfaForAdmin: row.require_recent_mfa_for_admin,
    recentMfaMaxAgeSeconds: row.recent_mfa_max_age_seconds,
    totpAllowedDriftSteps: row.totp_allowed_drift_steps,
    totpMaxAttempts: row.totp_max_attempts,
    totpAttemptWindowSeconds: row.totp_attempt_window_seconds,
    allowLocalPasswordFallback: row.allow_local_password_fallback,
    revision: row.revision,
    proposedByUserId: row.proposed_by_user_id,
    approvedByUserId: row.approved_by_user_id,
    approvedAt: row.approved_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapScimConnector(row: ScimConnectorRow): ScimConnector {
  return {
    id: row.id,
    key: row.key,
    displayName: row.display_name,
    status: row.status,
    basePath: row.base_path,
    allowUserCreate: row.allow_user_create,
    allowGroupCreate: row.allow_group_create,
    deactivateUserOnScimDisable: row.deactivate_user_on_scim_disable,
    revision: row.revision,
    proposedByUserId: row.proposed_by_user_id,
    approvedByUserId: row.approved_by_user_id,
    approvedAt: row.approved_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapScimServiceToken(row: ScimServiceTokenRow): ScimServiceTokenMetadata {
  return {
    id: row.id,
    connectorId: row.connector_id,
    tokenHint: row.token_hint,
    status: row.status,
    scopes: row.scopes,
    createdByUserId: row.created_by_user_id,
    expiresAt: row.expires_at?.toISOString() ?? null,
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
  };
}

function mapCreatedScimServiceToken(
  row: ScimServiceTokenRow,
  token: string,
): ScimServiceTokenCreated {
  if (
    row.status !== 'ACTIVE' ||
    row.revision !== 1 ||
    row.last_used_at !== null ||
    row.revoked_at !== null
  ) {
    throw new Error('A newly issued SCIM service token has an invalid persisted state.');
  }
  return {
    id: row.id,
    connectorId: row.connector_id,
    token,
    tokenHint: row.token_hint,
    status: 'ACTIVE',
    scopes: row.scopes,
    createdByUserId: row.created_by_user_id,
    expiresAt: row.expires_at?.toISOString() ?? null,
    lastUsedAt: null,
    revokedAt: null,
    revision: 1,
    createdAt: row.created_at.toISOString(),
  };
}

function requireAdmin(principal: AuthenticatedPrincipal): void {
  if (principal.role !== 'OWNER' && principal.role !== 'ADMIN') {
    throw new ForbiddenException('Identity governance requires an owner or administrator.');
  }
}

interface GovernanceCommandInput {
  readonly tenantId: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly action: string;
  readonly expectedRevision: number;
  readonly resultRevision: number;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly makerUserId: string;
  readonly checkerUserId: string | null;
  readonly independentApproval: boolean;
  readonly sessionId: string;
}

async function insertGovernanceCommand(
  transaction: Prisma.TransactionClient,
  input: GovernanceCommandInput,
): Promise<void> {
  await transaction.$executeRaw`
    INSERT INTO public."identity_governance_commands" (
      "tenant_id", "resource_type", "resource_id", "action",
      "expected_revision", "result_revision", "idempotency_key", "request_hash",
      "maker_user_id", "checker_user_id", "requires_independent_approval",
      "recent_mfa_session_id", "status"
    ) VALUES (
      ${input.tenantId}::uuid, ${input.resourceType}, ${input.resourceId}::uuid,
      ${input.action}, ${input.expectedRevision}, ${input.resultRevision},
      ${input.idempotencyKey}, ${input.requestHash}, ${input.makerUserId}::uuid,
      ${input.checkerUserId}::uuid, ${input.independentApproval},
      ${input.sessionId}::uuid, 'APPLIED'
    )
  `;
}

interface GovernanceCommandReplayInput {
  readonly tenantId: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly action: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

async function governanceCommandWasApplied(
  transaction: Prisma.TransactionClient,
  input: GovernanceCommandReplayInput,
): Promise<boolean> {
  const rows = await transaction.$queryRaw<
    Array<{
      resource_type: string;
      resource_id: string;
      action: string;
      request_hash: string;
      status: 'APPLIED' | 'REJECTED';
    }>
  >`
    SELECT "resource_type", "resource_id", "action", "request_hash", "status"
    FROM public."identity_governance_commands"
    WHERE "tenant_id" = ${input.tenantId}::uuid
      AND "idempotency_key" = ${input.idempotencyKey}
  `;
  const command = rows[0];
  if (command === undefined) return false;
  if (
    command.resource_type !== input.resourceType ||
    (input.resourceId !== null && command.resource_id !== input.resourceId) ||
    command.action !== input.action ||
    command.request_hash !== input.requestHash
  ) {
    throw new ConflictException(
      'Idempotency key was reused with a different identity-governance request.',
    );
  }
  if (command.status !== 'APPLIED') {
    throw new ConflictException('The previous identity-governance request was rejected.');
  }
  return true;
}

async function takeIdempotencyLock(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  idempotencyKey: string,
): Promise<void> {
  await transaction.$queryRaw`
    SELECT true AS "locked"
    FROM (
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`${tenantId}:${idempotencyKey}`}, 0)
      )
    ) AS advisory_lock
  `;
}

async function lockScimConnector(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  connectorId: string,
): Promise<ScimConnectorLockRow> {
  const rows = await transaction.$queryRaw<ScimConnectorLockRow[]>`
    SELECT "revision", "status", "proposed_by_user_id"
    FROM public."scim_connectors"
    WHERE "tenant_id" = ${tenantId}::uuid
      AND "id" = ${connectorId}::uuid
    FOR UPDATE
  `;
  if (rows[0] === undefined) throw new NotFoundException('SCIM connector was not found.');
  return rows[0];
}

async function lockScimServiceToken(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  connectorId: string,
  tokenId: string,
): Promise<ScimServiceTokenRow> {
  const rows = await transaction.$queryRaw<ScimServiceTokenRow[]>`
    SELECT "id", "connector_id", "token_hint", "status"::text AS "status",
           "scopes", "created_by_user_id", "expires_at", "last_used_at",
           "revoked_at", "revision", "created_at"
    FROM public."scim_service_tokens"
    WHERE "tenant_id" = ${tenantId}::uuid
      AND "connector_id" = ${connectorId}::uuid
      AND "id" = ${tokenId}::uuid
    FOR UPDATE
  `;
  if (rows[0] === undefined) throw new NotFoundException('SCIM service token was not found.');
  return rows[0];
}

function validateScimTokenExpiration(expiresAt: string | null, now: Date): void {
  if (expiresAt === null) return;
  const expiresAtMs = new Date(expiresAt).getTime();
  const nowMs = now.getTime();
  if (expiresAtMs < nowMs + 10 * 60 * 1000) {
    throw new BadRequestException('SCIM service-token expiry must be at least 10 minutes away.');
  }
  if (expiresAtMs > nowMs + 365 * 24 * 60 * 60 * 1000) {
    throw new BadRequestException('SCIM service-token expiry cannot exceed 365 days.');
  }
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`;
}
