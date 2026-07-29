import { createHmac, randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
  SCIM_BULK_MAX_OPERATIONS,
  SCIM_BULK_MAX_PAYLOAD_BYTES,
  scimBulkRequestSchema,
  type ScimBulkOperation,
  type ScimBulkRequest,
  type ScimBulkResponse,
  type ScimBulkResponseOperation,
  type ScimGroup,
  type ScimUser,
} from '@enterprise/contracts';

import type { EnvironmentVariables } from '../../config/environment.js';
import {
  InvalidScimCapabilityError,
  ScimPrismaService,
  type ScimCapability,
} from '../../database/scim-prisma.service.js';
import { ScimHttpException, toScimError } from './scim.errors.js';

const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User' as const;
const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group' as const;
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse' as const;
const BULK_RESPONSE_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:BulkResponse' as const;

const USER_SORT_COLUMNS: Readonly<Record<string, Prisma.Sql>> = {
  id: Prisma.sql`"scim_id"`,
  username: Prisma.sql`"user_name_normalized"`,
  displayname: Prisma.sql`"display_name"`,
  externalid: Prisma.sql`"external_id"`,
  'meta.created': Prisma.sql`"created_at"`,
  'meta.lastmodified': Prisma.sql`"last_modified_at"`,
};
const GROUP_SORT_COLUMNS: Readonly<Record<string, Prisma.Sql>> = {
  id: Prisma.sql`"scim_id"`,
  displayname: Prisma.sql`"display_name"`,
  externalid: Prisma.sql`"external_id"`,
  'meta.created': Prisma.sql`"created_at"`,
  'meta.lastmodified': Prisma.sql`"last_modified_at"`,
};

export interface ScimRequestIdentity {
  readonly bearer: string;
  readonly requestId: string;
  readonly idempotencyKey?: string;
  readonly ifMatch?: string;
}

export interface ScimListQuery {
  readonly filter?: string;
  readonly startIndex?: string;
  readonly count?: string;
  readonly sortBy?: string;
  readonly sortOrder?: string;
}

@Injectable()
export class ScimService {
  private readonly pepper: string;

  constructor(
    @Inject(ScimPrismaService) private readonly prisma: ScimPrismaService,
    @Inject(ConfigService)
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.pepper = config.get('AUTH_TOKEN_PEPPER', { infer: true });
  }

  async bulk(
    connectorKey: string,
    identity: ScimRequestIdentity,
    body: unknown,
  ): Promise<ScimBulkResponse> {
    const request = parseBulkRequest(body);
    if (identity.idempotencyKey === undefined) {
      throw new ScimHttpException(
        400,
        'Idempotency-Key is required for SCIM Bulk mutations.',
        'invalidValue',
      );
    }
    const scopes = new Set(request.Operations.map(requiredBulkScope));
    await this.authorizeScopes(connectorKey, identity, scopes);

    const responses: ScimBulkResponseOperation[] = [];
    let errorCount = 0;
    for (const [index, operation] of request.Operations.entries()) {
      if (
        request.failOnErrors !== undefined &&
        request.failOnErrors > 0 &&
        errorCount >= request.failOnErrors
      ) {
        responses.push({
          method: operation.method,
          ...(operation.bulkId === undefined ? {} : { bulkId: operation.bulkId }),
          status: '424',
          response: {
            schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
            status: '424',
            detail: 'Bulk processing stopped after reaching failOnErrors.',
          },
        });
        continue;
      }
      try {
        responses.push(await this.executeBulkOperation(connectorKey, identity, operation, index));
      } catch (error) {
        const failure = toScimError(error);
        responses.push({
          method: operation.method,
          ...(operation.bulkId === undefined ? {} : { bulkId: operation.bulkId }),
          status: String(failure.status),
          response: failure.body,
        });
        errorCount += 1;
      }
    }
    return {
      schemas: [BULK_RESPONSE_SCHEMA],
      Operations: responses,
    };
  }

  listUsers(
    connectorKey: string,
    identity: ScimRequestIdentity,
    query: ScimListQuery,
  ): Promise<ScimListResponse<ScimUser>> {
    const page = parsePage(query);
    const filter = parseFilter(query.filter, new Set(['userName', 'externalId', 'id']));
    const sort = parseSort(query, USER_SORT_COLUMNS);
    return this.withCapability(connectorKey, identity, 'scim.users.read', async (tx, cap) => {
      const conditions: Prisma.Sql[] = [
        Prisma.sql`"tenant_id" = ${cap.tenantId}::uuid`,
        Prisma.sql`"connector_id" = ${cap.connectorId}::uuid`,
      ];
      if (filter?.attribute === 'userName') {
        conditions.push(Prisma.sql`"user_name_normalized" = ${filter.value.toLowerCase()}`);
      } else if (filter?.attribute === 'externalId') {
        conditions.push(Prisma.sql`"external_id" = ${filter.value}`);
      } else if (filter?.attribute === 'id') {
        conditions.push(Prisma.sql`"scim_id" = ${filter.value}`);
      }
      const where = Prisma.join(conditions, ' AND ');
      const [countRows, rows] = await Promise.all([
        tx.$queryRaw<Array<{ count: bigint }>>(
          Prisma.sql`SELECT count(*)::bigint AS "count" FROM public."scim_users"
                     WHERE ${where}`,
        ),
        tx.$queryRaw<ScimUserRow[]>(
          Prisma.sql`SELECT * FROM public."scim_users"
                     WHERE ${where}
                     ORDER BY ${sort.expression} ${sort.direction} NULLS LAST,
                              "scim_id" ASC
                     OFFSET ${page.startIndex - 1} LIMIT ${page.count}`,
        ),
      ]);
      return {
        schemas: [LIST_SCHEMA],
        totalResults: Number(countRows[0]?.count ?? 0),
        startIndex: page.startIndex,
        itemsPerPage: rows.length,
        Resources: rows.map((row) => mapUser(row, connectorKey)),
      };
    });
  }

  getUser(connectorKey: string, scimId: string, identity: ScimRequestIdentity): Promise<ScimUser> {
    return this.withCapability(connectorKey, identity, 'scim.users.read', async (tx, cap) => {
      const row = await requireUser(tx, cap, scimId);
      return mapUser(row, connectorKey);
    });
  }

  createUser(
    connectorKey: string,
    identity: ScimRequestIdentity,
    body: unknown,
  ): Promise<ScimUser> {
    const input = parseUserInput(body);
    return this.withCapability(connectorKey, identity, 'scim.users.write', async (tx, cap) => {
      if (!cap.allowUserCreate) {
        throw new ScimHttpException(403, 'SCIM user creation is disabled.');
      }
      const replay = await beginMutation(tx, cap, identity, {
        method: 'POST',
        resourceType: 'User',
        requestHash: this.hash('scim-request', stableJson(input)),
      });
      if (replay !== null) {
        return mapUser(await requireUser(tx, cap, replay), connectorKey);
      }
      const scimId = randomUUID();
      const userId = randomUUID();
      const version = 1n;
      const modifiedAt = new Date();
      const etag = this.resourceEtag('User', {
        active: input.active,
        displayName: input.displayName,
        externalId: input.externalId,
        scimId,
        userName: input.userName,
        version: version.toString(),
      });
      try {
        await tx.$executeRaw`
          INSERT INTO public."users" (
            "id", "tenant_id", "email", "email_normalized", "display_name",
            "status", "role", "created_at", "updated_at"
          ) VALUES (
            ${userId}::uuid, ${cap.tenantId}::uuid, ${input.userName},
            ${input.userName.toLowerCase()}, ${input.displayName},
            ${input.active ? 'ACTIVE' : 'INACTIVE'}::public."UserStatus",
            'MEMBER', ${modifiedAt}, ${modifiedAt}
          )
        `;
        const rows = await tx.$queryRaw<ScimUserRow[]>`
          INSERT INTO public."scim_users" (
            "tenant_id", "connector_id", "scim_id", "external_id", "user_id",
            "user_name_normalized", "display_name", "active", "attributes",
            "resource_version", "etag", "last_modified_at", "deprovisioned_at",
            "created_at"
          ) VALUES (
            ${cap.tenantId}::uuid, ${cap.connectorId}::uuid, ${scimId},
            ${input.externalId ?? null}, ${userId}::uuid,
            ${input.userName.toLowerCase()}, ${input.displayName}, ${input.active},
            ${input.attributes}::jsonb, ${version}, ${etag}, ${modifiedAt},
            ${input.active ? null : modifiedAt}, ${modifiedAt}
          )
          RETURNING *
        `;
        await completeMutation(tx, cap, identity, scimId, etag, 201);
        return mapUser(rows[0]!, connectorKey);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ScimHttpException(409, 'SCIM user already exists.', 'uniqueness');
        }
        throw error;
      }
    });
  }

  replaceUser(
    connectorKey: string,
    scimId: string,
    identity: ScimRequestIdentity,
    body: unknown,
  ): Promise<ScimUser> {
    const input = parseUserInput(body);
    return this.mutateUser(connectorKey, scimId, identity, 'PUT', async (current) => ({
      ...input,
      attributes: input.attributes,
      current,
    }));
  }

  patchUser(
    connectorKey: string,
    scimId: string,
    identity: ScimRequestIdentity,
    body: unknown,
  ): Promise<ScimUser> {
    const operations = parsePatch(body);
    return this.mutateUser(connectorKey, scimId, identity, 'PATCH', async (current) => {
      const next: UserMutation = {
        active: current.active,
        displayName: current.display_name,
        ...(current.external_id === null ? {} : { externalId: current.external_id }),
        userName: current.user_name_normalized,
        attributes: asSafeAttributeObject(current.attributes),
        current,
      };
      for (const operation of operations) {
        if (operation.op !== 'replace') {
          throw new ScimHttpException(
            400,
            'Only replace is supported for User PATCH.',
            'invalidValue',
          );
        }
        applyUserPatch(next, operation.path, operation.value);
      }
      return next;
    });
  }

  deleteUser(connectorKey: string, scimId: string, identity: ScimRequestIdentity): Promise<void> {
    return this.withCapability(connectorKey, identity, 'scim.users.write', async (tx, cap) => {
      const current = await requireUser(tx, cap, scimId, true);
      requireIfMatch(identity.ifMatch, current.etag);
      if (!current.active) return;
      const now = new Date();
      const nextVersion = current.resource_version + 1n;
      const etag = this.resourceEtag('User', {
        active: false,
        displayName: current.display_name,
        externalId: current.external_id,
        scimId,
        userName: current.user_name_normalized,
        version: nextVersion.toString(),
      });
      await beginMutation(tx, cap, identity, {
        method: 'DELETE',
        resourceType: 'User',
        resourceId: scimId,
        requestHash: this.hash('scim-request', `DELETE:${scimId}:${current.etag}`),
        ifMatchEtag: current.etag,
      });
      await tx.$executeRaw`
        UPDATE public."scim_users"
        SET "active" = false, "resource_version" = ${nextVersion},
            "etag" = ${etag}, "last_modified_at" = ${now},
            "deprovisioned_at" = ${now}
        WHERE "tenant_id" = ${cap.tenantId}::uuid
          AND "connector_id" = ${cap.connectorId}::uuid
          AND "id" = ${current.id}::uuid
          AND "etag" = ${current.etag}
      `;
      await completeMutation(tx, cap, identity, scimId, etag, 204);
    });
  }

  listGroups(
    connectorKey: string,
    identity: ScimRequestIdentity,
    query: ScimListQuery,
  ): Promise<ScimListResponse<ScimGroup>> {
    const page = parsePage(query);
    const filter = parseFilter(query.filter, new Set(['displayName', 'externalId', 'id']));
    const sort = parseSort(query, GROUP_SORT_COLUMNS);
    return this.withCapability(connectorKey, identity, 'scim.groups.read', async (tx, cap) => {
      const conditions: Prisma.Sql[] = [
        Prisma.sql`"tenant_id" = ${cap.tenantId}::uuid`,
        Prisma.sql`"connector_id" = ${cap.connectorId}::uuid`,
      ];
      if (filter?.attribute === 'displayName') {
        conditions.push(Prisma.sql`"display_name" = ${filter.value}`);
      } else if (filter?.attribute === 'externalId') {
        conditions.push(Prisma.sql`"external_id" = ${filter.value}`);
      } else if (filter?.attribute === 'id') {
        conditions.push(Prisma.sql`"scim_id" = ${filter.value}`);
      }
      const where = Prisma.join(conditions, ' AND ');
      const [countRows, rows] = await Promise.all([
        tx.$queryRaw<Array<{ count: bigint }>>(
          Prisma.sql`SELECT count(*)::bigint AS "count" FROM public."scim_groups"
                     WHERE ${where}`,
        ),
        tx.$queryRaw<ScimGroupRow[]>(
          Prisma.sql`SELECT * FROM public."scim_groups"
                     WHERE ${where}
                     ORDER BY ${sort.expression} ${sort.direction} NULLS LAST,
                              "scim_id" ASC
                     OFFSET ${page.startIndex - 1} LIMIT ${page.count}`,
        ),
      ]);
      const resources = [];
      for (const row of rows) resources.push(await mapGroup(tx, cap, row, connectorKey));
      return {
        schemas: [LIST_SCHEMA],
        totalResults: Number(countRows[0]?.count ?? 0),
        startIndex: page.startIndex,
        itemsPerPage: resources.length,
        Resources: resources,
      };
    });
  }

  getGroup(
    connectorKey: string,
    scimId: string,
    identity: ScimRequestIdentity,
  ): Promise<ScimGroup> {
    return this.withCapability(connectorKey, identity, 'scim.groups.read', async (tx, cap) =>
      mapGroup(tx, cap, await requireGroup(tx, cap, scimId), connectorKey),
    );
  }

  createGroup(
    connectorKey: string,
    identity: ScimRequestIdentity,
    body: unknown,
  ): Promise<ScimGroup> {
    const input = parseGroupInput(body);
    return this.withCapability(connectorKey, identity, 'scim.groups.write', async (tx, cap) => {
      if (!cap.allowGroupCreate) {
        throw new ScimHttpException(403, 'SCIM group creation is disabled.');
      }
      const replay = await beginMutation(tx, cap, identity, {
        method: 'POST',
        resourceType: 'Group',
        requestHash: this.hash('scim-request', stableJson(input)),
      });
      if (replay !== null) {
        return mapGroup(tx, cap, await requireGroup(tx, cap, replay), connectorKey);
      }
      const scimId = randomUUID();
      const version = 1n;
      const now = new Date();
      const memberIds = await resolveMemberIds(tx, cap, input.members);
      const etag = this.resourceEtag('Group', {
        displayName: input.displayName,
        externalId: input.externalId,
        members: [...input.members].sort(),
        scimId,
        version: version.toString(),
      });
      try {
        const rows = await tx.$queryRaw<ScimGroupRow[]>`
          INSERT INTO public."scim_groups" (
            "tenant_id", "connector_id", "scim_id", "external_id",
            "display_name", "resource_version", "etag",
            "last_modified_at", "created_at"
          ) VALUES (
            ${cap.tenantId}::uuid, ${cap.connectorId}::uuid, ${scimId},
            ${input.externalId ?? null}, ${input.displayName}, ${version},
            ${etag}, ${now}, ${now}
          )
          RETURNING *
        `;
        for (const member of memberIds) {
          await insertMembership(tx, cap, rows[0]!.id, member, etag);
        }
        await completeMutation(tx, cap, identity, scimId, etag, 201);
        return mapGroup(tx, cap, rows[0]!, connectorKey);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ScimHttpException(409, 'SCIM group already exists.', 'uniqueness');
        }
        throw error;
      }
    });
  }

  replaceGroup(
    connectorKey: string,
    scimId: string,
    identity: ScimRequestIdentity,
    body: unknown,
  ): Promise<ScimGroup> {
    const input = parseGroupInput(body);
    return this.mutateGroup(connectorKey, scimId, identity, 'PUT', input);
  }

  patchGroup(
    connectorKey: string,
    scimId: string,
    identity: ScimRequestIdentity,
    body: unknown,
  ): Promise<ScimGroup> {
    const operations = parsePatch(body);
    return this.withCapability(connectorKey, identity, 'scim.groups.write', async (tx, cap) => {
      const current = await requireGroup(tx, cap, scimId, true);
      requireIfMatch(identity.ifMatch, current.etag);
      const existing = await memberScimIds(tx, cap, current.id);
      const next: GroupInput = {
        displayName: current.display_name,
        ...(current.external_id === null ? {} : { externalId: current.external_id }),
        members: existing,
      };
      for (const operation of operations) applyGroupPatch(next, operation);
      return this.performGroupMutation(tx, cap, connectorKey, identity, current, next, 'PATCH');
    });
  }

  deleteGroup(connectorKey: string, scimId: string, identity: ScimRequestIdentity): Promise<void> {
    return this.withCapability(connectorKey, identity, 'scim.groups.write', async (tx, cap) => {
      const current = await requireGroup(tx, cap, scimId, true);
      requireIfMatch(identity.ifMatch, current.etag);
      if (!current.active) return;
      const now = new Date();
      const nextVersion = current.resource_version + 1n;
      const etag = this.resourceEtag('Group', {
        deleted: true,
        scimId,
        version: nextVersion.toString(),
      });
      await beginMutation(tx, cap, identity, {
        method: 'DELETE',
        resourceType: 'Group',
        resourceId: scimId,
        requestHash: this.hash('scim-request', `DELETE:${scimId}:${current.etag}`),
        ifMatchEtag: current.etag,
      });
      await tx.$executeRaw`
        UPDATE public."scim_groups"
        SET "active" = false, "deleted_at" = ${now},
            "resource_version" = ${nextVersion}, "etag" = ${etag},
            "last_modified_at" = ${now}
        WHERE "id" = ${current.id}::uuid AND "etag" = ${current.etag}
      `;
      await completeMutation(tx, cap, identity, scimId, etag, 204);
    });
  }

  private mutateUser(
    connectorKey: string,
    scimId: string,
    identity: ScimRequestIdentity,
    method: 'PUT' | 'PATCH',
    transform: (current: ScimUserRow) => Promise<UserMutation>,
  ): Promise<ScimUser> {
    return this.withCapability(connectorKey, identity, 'scim.users.write', async (tx, cap) => {
      const current = await requireUser(tx, cap, scimId, true);
      requireIfMatch(identity.ifMatch, current.etag);
      const next = await transform(current);
      const nextVersion = current.resource_version + 1n;
      const now = new Date();
      const etag = this.resourceEtag('User', {
        active: next.active,
        displayName: next.displayName,
        externalId: next.externalId,
        scimId,
        userName: next.userName,
        version: nextVersion.toString(),
      });
      const requestHash = this.hash('scim-request', stableJson(next));
      const replay = await beginMutation(tx, cap, identity, {
        method,
        resourceType: 'User',
        resourceId: scimId,
        requestHash,
        ifMatchEtag: current.etag,
      });
      if (replay !== null) return mapUser(await requireUser(tx, cap, replay), connectorKey);
      await tx.$executeRaw`
        UPDATE public."users"
        SET "email" = ${next.userName},
            "email_normalized" = ${next.userName.toLowerCase()},
            "display_name" = ${next.displayName},
            "updated_at" = ${now}
        WHERE "tenant_id" = ${cap.tenantId}::uuid
          AND "id" = ${current.user_id}::uuid
      `;
      const rows = await tx.$queryRaw<ScimUserRow[]>`
        UPDATE public."scim_users"
        SET "external_id" = ${next.externalId ?? null},
            "user_name_normalized" = ${next.userName.toLowerCase()},
            "display_name" = ${next.displayName}, "active" = ${next.active},
            "attributes" = ${next.attributes}::jsonb,
            "resource_version" = ${nextVersion}, "etag" = ${etag},
            "last_modified_at" = ${now},
            "deprovisioned_at" = ${next.active ? null : now}
        WHERE "tenant_id" = ${cap.tenantId}::uuid
          AND "connector_id" = ${cap.connectorId}::uuid
          AND "id" = ${current.id}::uuid
          AND "etag" = ${current.etag}
        RETURNING *
      `;
      if (rows.length !== 1) throw preconditionFailed();
      await completeMutation(tx, cap, identity, scimId, etag, 200);
      return mapUser(rows[0]!, connectorKey);
    });
  }

  private mutateGroup(
    connectorKey: string,
    scimId: string,
    identity: ScimRequestIdentity,
    method: 'PUT',
    next: GroupInput,
  ): Promise<ScimGroup> {
    return this.withCapability(connectorKey, identity, 'scim.groups.write', async (tx, cap) => {
      const current = await requireGroup(tx, cap, scimId, true);
      requireIfMatch(identity.ifMatch, current.etag);
      return this.performGroupMutation(tx, cap, connectorKey, identity, current, next, method);
    });
  }

  private async performGroupMutation(
    tx: Prisma.TransactionClient,
    cap: ScimCapability,
    connectorKey: string,
    identity: ScimRequestIdentity,
    current: ScimGroupRow,
    next: GroupInput,
    method: 'PUT' | 'PATCH',
  ): Promise<ScimGroup> {
    const memberIds = await resolveMemberIds(tx, cap, next.members);
    const nextVersion = current.resource_version + 1n;
    const now = new Date();
    const etag = this.resourceEtag('Group', {
      displayName: next.displayName,
      externalId: next.externalId,
      members: [...next.members].sort(),
      scimId: current.scim_id,
      version: nextVersion.toString(),
    });
    const replay = await beginMutation(tx, cap, identity, {
      method,
      resourceType: 'Group',
      resourceId: current.scim_id,
      requestHash: this.hash('scim-request', stableJson(next)),
      ifMatchEtag: current.etag,
    });
    if (replay !== null) {
      return mapGroup(tx, cap, await requireGroup(tx, cap, replay), connectorKey);
    }
    const rows = await tx.$queryRaw<ScimGroupRow[]>`
      UPDATE public."scim_groups"
      SET "external_id" = ${next.externalId ?? null},
          "display_name" = ${next.displayName},
          "resource_version" = ${nextVersion}, "etag" = ${etag},
          "last_modified_at" = ${now}
      WHERE "id" = ${current.id}::uuid AND "etag" = ${current.etag}
      RETURNING *
    `;
    if (rows.length !== 1) throw preconditionFailed();
    await tx.$executeRaw`
      DELETE FROM public."scim_group_memberships"
      WHERE "tenant_id" = ${cap.tenantId}::uuid
        AND "connector_id" = ${cap.connectorId}::uuid
        AND "group_id" = ${current.id}::uuid
    `;
    for (const member of memberIds) await insertMembership(tx, cap, current.id, member, etag);
    await completeMutation(tx, cap, identity, current.scim_id, etag, 200);
    return mapGroup(tx, cap, rows[0]!, connectorKey);
  }

  private withCapability<T>(
    connectorKey: string,
    identity: ScimRequestIdentity,
    scope: string,
    operation: (tx: Prisma.TransactionClient, cap: ScimCapability) => Promise<T>,
  ): Promise<T> {
    const tokenHash = this.hash('scim-service-token', identity.bearer);
    return this.prisma
      .withToken(tokenHash, connectorKey, async (transaction, capability) => {
        if (!capability.scopes.includes(scope)) {
          throw new ScimHttpException(403, 'SCIM bearer lacks the required scope.');
        }
        return operation(transaction, capability);
      })
      .catch((error: unknown) => {
        if (error instanceof InvalidScimCapabilityError) {
          throw new ScimHttpException(401, 'SCIM bearer capability is invalid.');
        }
        throw error;
      });
  }

  private authorizeScopes(
    connectorKey: string,
    identity: ScimRequestIdentity,
    scopes: ReadonlySet<string>,
  ): Promise<void> {
    const tokenHash = this.hash('scim-service-token', identity.bearer);
    return this.prisma
      .withToken(tokenHash, connectorKey, async (_transaction, capability) => {
        for (const scope of scopes) {
          if (!capability.scopes.includes(scope)) {
            throw new ScimHttpException(403, 'SCIM bearer lacks the required scope.');
          }
        }
      })
      .catch((error: unknown) => {
        if (error instanceof InvalidScimCapabilityError) {
          throw new ScimHttpException(401, 'SCIM bearer capability is invalid.');
        }
        throw error;
      });
  }

  private async executeBulkOperation(
    connectorKey: string,
    identity: ScimRequestIdentity,
    operation: ScimBulkOperation,
    index: number,
  ): Promise<ScimBulkResponseOperation> {
    const target = parseBulkTarget(operation);
    const operationIdentity: ScimRequestIdentity = {
      bearer: identity.bearer,
      requestId: `${identity.requestId}:bulk:${String(index + 1)}`.slice(0, 200),
      idempotencyKey: `bulk:${this.hash(
        'scim-bulk-operation-key',
        `${identity.idempotencyKey!}:${String(index + 1)}:${operation.bulkId ?? ''}`,
      )}`,
      ...(operation.version === undefined ? {} : { ifMatch: operation.version }),
    };
    if (operation.method === 'POST') {
      const resource =
        target.resourceType === 'User'
          ? await this.createUser(connectorKey, operationIdentity, operation.data)
          : await this.createGroup(connectorKey, operationIdentity, operation.data);
      return {
        method: operation.method,
        bulkId: operation.bulkId!,
        location: resource.meta.location,
        version: resource.meta.version,
        status: '201',
        response: resource,
      };
    }
    if (operation.method === 'PUT') {
      const resource =
        target.resourceType === 'User'
          ? await this.replaceUser(connectorKey, target.scimId!, operationIdentity, operation.data)
          : await this.replaceGroup(
              connectorKey,
              target.scimId!,
              operationIdentity,
              operation.data,
            );
      return {
        method: operation.method,
        location: resource.meta.location,
        version: resource.meta.version,
        status: '200',
        response: resource,
      };
    }
    if (operation.method === 'PATCH') {
      const resource =
        target.resourceType === 'User'
          ? await this.patchUser(connectorKey, target.scimId!, operationIdentity, operation.data)
          : await this.patchGroup(connectorKey, target.scimId!, operationIdentity, operation.data);
      return {
        method: operation.method,
        location: resource.meta.location,
        version: resource.meta.version,
        status: '200',
        response: resource,
      };
    }
    if (target.resourceType === 'User') {
      await this.deleteUser(connectorKey, target.scimId!, operationIdentity);
    } else {
      await this.deleteGroup(connectorKey, target.scimId!, operationIdentity);
    }
    return { method: operation.method, status: '204' };
  }

  private resourceEtag(type: string, value: unknown): string {
    return this.hash(`scim-${type.toLowerCase()}-etag`, stableJson(value));
  }

  private hash(namespace: string, value: string): string {
    return createHmac('sha256', this.pepper)
      .update(`enterprise-agent:${namespace}:v1\0`)
      .update(value)
      .digest('hex');
  }
}

interface ScimListResponse<T> {
  readonly schemas: readonly [typeof LIST_SCHEMA];
  readonly totalResults: number;
  readonly startIndex: number;
  readonly itemsPerPage: number;
  readonly Resources: readonly T[];
}

interface ScimUserRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly connector_id: string;
  readonly scim_id: string;
  readonly external_id: string | null;
  readonly user_id: string;
  readonly user_name_normalized: string;
  readonly display_name: string;
  readonly active: boolean;
  readonly attributes: Prisma.JsonValue;
  readonly resource_version: bigint;
  readonly etag: string;
  readonly last_modified_at: Date;
  readonly created_at: Date;
}

interface ScimGroupRow {
  readonly id: string;
  readonly scim_id: string;
  readonly external_id: string | null;
  readonly display_name: string;
  readonly active: boolean;
  readonly resource_version: bigint;
  readonly etag: string;
  readonly last_modified_at: Date;
  readonly created_at: Date;
}

interface UserInput {
  userName: string;
  displayName: string;
  externalId?: string;
  active: boolean;
  attributes: Prisma.InputJsonObject;
}

interface UserMutation extends UserInput {
  readonly current: ScimUserRow;
}

interface GroupInput {
  displayName: string;
  externalId?: string;
  members: string[];
}

interface PatchOperation {
  readonly op: string;
  readonly path?: string;
  readonly value: unknown;
}

function mapUser(row: ScimUserRow, connectorKey: string): ScimUser {
  const attributes = asSafeAttributeObject(row.attributes);
  return {
    ...attributes,
    schemas: [USER_SCHEMA],
    id: row.scim_id,
    ...(row.external_id === null ? {} : { externalId: row.external_id }),
    userName: row.user_name_normalized,
    displayName: row.display_name,
    active: row.active,
    meta: {
      resourceType: 'User',
      created: row.created_at.toISOString(),
      lastModified: row.last_modified_at.toISOString(),
      version: weakEtag(row.etag),
      location: `/api/v1/scim/v2/${encodeURIComponent(connectorKey)}/Users/${encodeURIComponent(row.scim_id)}`,
    },
  };
}

async function mapGroup(
  tx: Prisma.TransactionClient,
  cap: ScimCapability,
  row: ScimGroupRow,
  connectorKey: string,
): Promise<ScimGroup> {
  const members = await tx.$queryRaw<Array<{ scim_id: string; display_name: string }>>`
    SELECT user_resource."scim_id", user_resource."display_name"
    FROM public."scim_group_memberships" AS membership
    JOIN public."scim_users" AS user_resource
      ON user_resource."tenant_id" = membership."tenant_id"
     AND user_resource."connector_id" = membership."connector_id"
     AND user_resource."id" = membership."scim_user_id"
    WHERE membership."tenant_id" = ${cap.tenantId}::uuid
      AND membership."connector_id" = ${cap.connectorId}::uuid
      AND membership."group_id" = ${row.id}::uuid
    ORDER BY user_resource."scim_id"
  `;
  return {
    schemas: [GROUP_SCHEMA],
    id: row.scim_id,
    ...(row.external_id === null ? {} : { externalId: row.external_id }),
    displayName: row.display_name,
    members: members.map((member) => ({
      value: member.scim_id,
      display: member.display_name,
    })),
    meta: {
      resourceType: 'Group',
      created: row.created_at.toISOString(),
      lastModified: row.last_modified_at.toISOString(),
      version: weakEtag(row.etag),
      location: `/api/v1/scim/v2/${encodeURIComponent(connectorKey)}/Groups/${encodeURIComponent(row.scim_id)}`,
    },
  };
}

async function requireUser(
  tx: Prisma.TransactionClient,
  cap: ScimCapability,
  scimId: string,
  lock = false,
): Promise<ScimUserRow> {
  const rows = await tx.$queryRaw<ScimUserRow[]>(
    Prisma.sql`SELECT * FROM public."scim_users"
               WHERE "tenant_id" = ${cap.tenantId}::uuid
                 AND "connector_id" = ${cap.connectorId}::uuid
                 AND "scim_id" = ${scimId}
               ${lock ? Prisma.sql`FOR UPDATE` : Prisma.empty}`,
  );
  if (rows[0] === undefined) throw new ScimHttpException(404, 'SCIM User was not found.');
  return rows[0];
}

async function requireGroup(
  tx: Prisma.TransactionClient,
  cap: ScimCapability,
  scimId: string,
  lock = false,
): Promise<ScimGroupRow> {
  const rows = await tx.$queryRaw<ScimGroupRow[]>(
    Prisma.sql`SELECT * FROM public."scim_groups"
               WHERE "tenant_id" = ${cap.tenantId}::uuid
                 AND "connector_id" = ${cap.connectorId}::uuid
                 AND "scim_id" = ${scimId}
               ${lock ? Prisma.sql`FOR UPDATE` : Prisma.empty}`,
  );
  if (rows[0] === undefined) throw new ScimHttpException(404, 'SCIM Group was not found.');
  return rows[0];
}

function parseUserInput(value: unknown): UserInput {
  assertNoPasswordAttribute(value);
  const record = requireRecord(value);
  const schemas = record.schemas;
  if (!Array.isArray(schemas) || !schemas.includes(USER_SCHEMA)) {
    throw new ScimHttpException(400, 'SCIM User schema is required.', 'invalidSyntax');
  }
  const userName = requiredText(record.userName, 'userName', 320).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userName)) {
    throw new ScimHttpException(400, 'userName must be a work email.', 'invalidValue');
  }
  const displayName = requiredText(record.displayName, 'displayName', 200);
  const externalId = optionalText(record.externalId, 'externalId', 500);
  const active = record.active === undefined ? true : requireBoolean(record.active, 'active');
  const {
    schemas: _schemas,
    id: _id,
    meta: _meta,
    userName: _userName,
    displayName: _displayName,
    externalId: _externalId,
    active: _active,
    ...attributes
  } = record;
  return {
    userName,
    displayName,
    ...(externalId === undefined ? {} : { externalId }),
    active,
    attributes: sanitizeJsonObject(attributes),
  };
}

function parseGroupInput(value: unknown): GroupInput {
  const record = requireRecord(value);
  const schemas = record.schemas;
  if (!Array.isArray(schemas) || !schemas.includes(GROUP_SCHEMA)) {
    throw new ScimHttpException(400, 'SCIM Group schema is required.', 'invalidSyntax');
  }
  const members = Array.isArray(record.members)
    ? record.members.map((item) => requiredText(requireRecord(item).value, 'members.value', 200))
    : [];
  const externalId = optionalText(record.externalId, 'externalId', 500);
  return {
    displayName: requiredText(record.displayName, 'displayName', 200),
    ...(externalId === undefined ? {} : { externalId }),
    members: [...new Set(members)],
  };
}

function parsePatch(value: unknown): PatchOperation[] {
  assertNoPasswordAttribute(value);
  const record = requireRecord(value);
  if (
    !Array.isArray(record.schemas) ||
    !record.schemas.includes('urn:ietf:params:scim:api:messages:2.0:PatchOp') ||
    !Array.isArray(record.Operations) ||
    record.Operations.length === 0 ||
    record.Operations.length > 100
  ) {
    throw new ScimHttpException(400, 'SCIM PatchOp document is invalid.', 'invalidSyntax');
  }
  return record.Operations.map((item) => {
    const operation = requireRecord(item);
    const op = requiredText(operation.op, 'op', 20).toLowerCase();
    const path = optionalText(operation.path, 'path', 200);
    if (path !== undefined && isPasswordPath(path)) {
      throw passwordProvisioningError();
    }
    return { op, ...(path === undefined ? {} : { path }), value: operation.value };
  });
}

function applyUserPatch(next: UserMutation, path: string | undefined, value: unknown): void {
  if (path !== undefined && isPasswordPath(path)) {
    throw passwordProvisioningError();
  }
  if (path === undefined && isRecord(value)) {
    for (const [key, item] of Object.entries(value)) applyUserPatch(next, key, item);
    return;
  }
  if (path === 'active') next.active = requireBoolean(value, 'active');
  else if (path === 'displayName') next.displayName = requiredText(value, 'displayName', 200);
  else if (path === 'userName') next.userName = requiredText(value, 'userName', 320).toLowerCase();
  else if (path === 'externalId') {
    const parsed = optionalText(value, 'externalId', 500);
    if (parsed === undefined) delete next.externalId;
    else next.externalId = parsed;
  } else {
    throw new ScimHttpException(400, `Unsupported User PATCH path: ${path ?? ''}.`, 'invalidPath');
  }
}

function applyGroupPatch(next: GroupInput, operation: PatchOperation): void {
  if (operation.op === 'replace' && operation.path === 'displayName') {
    next.displayName = requiredText(operation.value, 'displayName', 200);
    return;
  }
  if (operation.op === 'replace' && operation.path === 'externalId') {
    const parsed = optionalText(operation.value, 'externalId', 500);
    if (parsed === undefined) delete next.externalId;
    else next.externalId = parsed;
    return;
  }
  if (
    (operation.op === 'replace' || operation.op === 'add') &&
    (operation.path === 'members' || operation.path === undefined)
  ) {
    const values = extractMemberValues(operation.value);
    next.members =
      operation.op === 'replace'
        ? [...new Set(values)]
        : [...new Set([...next.members, ...values])];
    return;
  }
  if (operation.op === 'remove' && operation.path?.startsWith('members[value eq "')) {
    const match = /^members\[value eq "([^"]+)"\]$/.exec(operation.path);
    if (match === null) throw new ScimHttpException(400, 'Invalid member filter.', 'invalidPath');
    next.members = next.members.filter((value) => value !== match[1]);
    return;
  }
  throw new ScimHttpException(400, 'Unsupported Group PATCH operation.', 'invalidPath');
}

function extractMemberValues(value: unknown): string[] {
  if (!Array.isArray(value)) {
    const record = requireRecord(value);
    if (Array.isArray(record.members)) return extractMemberValues(record.members);
    return [requiredText(record.value, 'members.value', 200)];
  }
  return value.map((item) => requiredText(requireRecord(item).value, 'members.value', 200));
}

async function resolveMemberIds(
  tx: Prisma.TransactionClient,
  cap: ScimCapability,
  scimIds: readonly string[],
): Promise<string[]> {
  if (scimIds.length === 0) return [];
  const rows = await tx.$queryRaw<Array<{ id: string; scim_id: string }>>`
    SELECT "id", "scim_id"
    FROM public."scim_users"
    WHERE "tenant_id" = ${cap.tenantId}::uuid
      AND "connector_id" = ${cap.connectorId}::uuid
      AND "scim_id" IN (${Prisma.join(scimIds)})
      AND "active"
  `;
  if (rows.length !== new Set(scimIds).size) {
    throw new ScimHttpException(400, 'Group contains an unknown or inactive User.', 'invalidValue');
  }
  return rows.map((row) => row.id);
}

async function memberScimIds(
  tx: Prisma.TransactionClient,
  cap: ScimCapability,
  groupId: string,
): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ scim_id: string }>>`
    SELECT user_resource."scim_id"
    FROM public."scim_group_memberships" AS membership
    JOIN public."scim_users" AS user_resource
      ON user_resource."tenant_id" = membership."tenant_id"
     AND user_resource."connector_id" = membership."connector_id"
     AND user_resource."id" = membership."scim_user_id"
    WHERE membership."tenant_id" = ${cap.tenantId}::uuid
      AND membership."connector_id" = ${cap.connectorId}::uuid
      AND membership."group_id" = ${groupId}::uuid
  `;
  return rows.map((row) => row.scim_id);
}

function insertMembership(
  tx: Prisma.TransactionClient,
  cap: ScimCapability,
  groupId: string,
  scimUserId: string,
  etag: string,
): Promise<number> {
  return tx.$executeRaw`
    INSERT INTO public."scim_group_memberships" (
      "tenant_id", "connector_id", "group_id", "scim_user_id", "etag"
    ) VALUES (
      ${cap.tenantId}::uuid, ${cap.connectorId}::uuid, ${groupId}::uuid,
      ${scimUserId}::uuid, ${etag}
    )
  `;
}

interface MutationStart {
  readonly method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly resourceType: 'User' | 'Group';
  readonly resourceId?: string;
  readonly requestHash: string;
  readonly ifMatchEtag?: string;
}

async function beginMutation(
  tx: Prisma.TransactionClient,
  cap: ScimCapability,
  identity: ScimRequestIdentity,
  input: MutationStart,
): Promise<string | null> {
  const idempotencyKey = (identity.idempotencyKey ?? identity.requestId).slice(0, 200);
  const existing = await tx.$queryRaw<
    Array<{ request_hash: string; resource_id: string | null; status: string }>
  >`
    SELECT "request_hash", "resource_id", "status"
    FROM public."scim_provisioning_requests"
    WHERE "tenant_id" = ${cap.tenantId}::uuid
      AND "connector_id" = ${cap.connectorId}::uuid
      AND "idempotency_key" = ${idempotencyKey}
    FOR UPDATE
  `;
  if (existing[0] !== undefined) {
    if (existing[0].request_hash !== input.requestHash) {
      throw new ScimHttpException(
        409,
        'Idempotency key was reused with different input.',
        'uniqueness',
      );
    }
    if (existing[0].status === 'SUCCEEDED' && existing[0].resource_id !== null) {
      return existing[0].resource_id;
    }
    throw new ScimHttpException(409, 'A request with this idempotency key is in progress.');
  }
  await tx.$executeRaw`
    INSERT INTO public."scim_provisioning_requests" (
      "tenant_id", "connector_id", "service_token_id", "request_id",
      "idempotency_key", "request_hash", "http_method", "resource_type",
      "resource_id", "if_match_etag"
    ) VALUES (
      ${cap.tenantId}::uuid, ${cap.connectorId}::uuid, ${cap.serviceTokenId}::uuid,
      ${identity.requestId.slice(0, 200)}, ${idempotencyKey}, ${input.requestHash},
      ${input.method}, ${input.resourceType}, ${input.resourceId ?? null},
      ${input.ifMatchEtag ?? null}
    )
  `;
  return null;
}

function completeMutation(
  tx: Prisma.TransactionClient,
  cap: ScimCapability,
  identity: ScimRequestIdentity,
  resourceId: string,
  etag: string,
  status: number,
): Promise<number> {
  const idempotencyKey = (identity.idempotencyKey ?? identity.requestId).slice(0, 200);
  return tx.$executeRaw`
    UPDATE public."scim_provisioning_requests"
    SET "resource_id" = ${resourceId}, "result_etag" = ${etag},
        "status" = 'SUCCEEDED', "http_status" = ${status},
        "completed_at" = CURRENT_TIMESTAMP
    WHERE "tenant_id" = ${cap.tenantId}::uuid
      AND "connector_id" = ${cap.connectorId}::uuid
      AND "idempotency_key" = ${idempotencyKey}
      AND "status" = 'IN_PROGRESS'
  `;
}

interface BulkTarget {
  readonly resourceType: 'User' | 'Group';
  readonly scimId?: string;
}

function parseBulkRequest(value: unknown): ScimBulkRequest {
  assertNoPasswordAttribute(value);
  if (containsPasswordPatchPath(value)) throw passwordProvisioningError();
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new ScimHttpException(400, 'SCIM Bulk document is not valid JSON.', 'invalidSyntax');
  }
  if (serialized === undefined) {
    throw new ScimHttpException(400, 'SCIM Bulk document must be an object.', 'invalidSyntax');
  }
  if (Buffer.byteLength(serialized, 'utf8') > SCIM_BULK_MAX_PAYLOAD_BYTES) {
    throw new ScimHttpException(413, 'SCIM Bulk payload exceeds maxPayloadSize.', 'tooMany');
  }
  const record = requireRecord(value);
  if (Array.isArray(record.Operations) && record.Operations.length > SCIM_BULK_MAX_OPERATIONS) {
    throw new ScimHttpException(413, 'SCIM Bulk operation count exceeds maxOperations.', 'tooMany');
  }
  const parsed = scimBulkRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new ScimHttpException(400, 'SCIM Bulk document is invalid.', 'invalidSyntax');
  }
  const bulkIds = new Set<string>();
  for (const operation of parsed.data.Operations) {
    parseBulkTarget(operation);
    if (containsBulkIdReference(operation.path) || containsBulkIdReference(operation.data)) {
      throw new ScimHttpException(
        400,
        'bulkId references are not supported by this provider; use returned resource ids in a subsequent idempotent request.',
        'invalidValue',
      );
    }
    if (operation.bulkId !== undefined) {
      if (bulkIds.has(operation.bulkId)) {
        throw new ScimHttpException(400, 'SCIM Bulk bulkId values must be unique.', 'uniqueness');
      }
      bulkIds.add(operation.bulkId);
    }
  }
  return parsed.data;
}

function parseBulkTarget(operation: ScimBulkOperation): BulkTarget {
  const match = /^\/(Users|Groups)(?:\/([A-Za-z0-9._~-]{1,500}))?$/.exec(operation.path);
  if (match === null) {
    throw new ScimHttpException(
      400,
      'Bulk path must target /Users, /Groups, or one concrete resource.',
      'invalidPath',
    );
  }
  const resourceType = match[1] === 'Users' ? 'User' : 'Group';
  const scimId = match[2];
  if (operation.method === 'POST') {
    if (scimId !== undefined || operation.version !== undefined) {
      throw new ScimHttpException(
        400,
        'POST Bulk operations must target a collection and cannot include version.',
        'invalidPath',
      );
    }
    return { resourceType };
  }
  if (scimId === undefined) {
    throw new ScimHttpException(
      400,
      `${operation.method} Bulk operations must target one concrete resource.`,
      'invalidPath',
    );
  }
  return { resourceType, scimId };
}

function requiredBulkScope(operation: ScimBulkOperation): string {
  return parseBulkTarget(operation).resourceType === 'User'
    ? 'scim.users.write'
    : 'scim.groups.write';
}

function containsBulkIdReference(value: unknown): boolean {
  if (typeof value === 'string') return value.startsWith('bulkId:');
  if (Array.isArray(value)) return value.some(containsBulkIdReference);
  if (!isRecord(value)) return false;
  return Object.values(value).some(containsBulkIdReference);
}

function containsPasswordPatchPath(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsPasswordPatchPath);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, item]) =>
      (key.toLowerCase() === 'path' && typeof item === 'string' && isPasswordPath(item)) ||
      containsPasswordPatchPath(item),
  );
}

function parseFilter(
  value: string | undefined,
  allowed: ReadonlySet<string>,
): { attribute: string; value: string } | null {
  if (value === undefined || value.trim() === '') return null;
  const match = /^\s*([A-Za-z][A-Za-z0-9]*)\s+eq\s+"([^"\\]{1,500})"\s*$/.exec(value);
  if (match === null || !allowed.has(match[1]!)) {
    throw new ScimHttpException(
      400,
      'Only supported exact-match SCIM filters are allowed.',
      'invalidFilter',
    );
  }
  return { attribute: match[1]!, value: match[2]! };
}

function parseSort(
  query: ScimListQuery,
  columns: Readonly<Record<string, Prisma.Sql>>,
): { readonly expression: Prisma.Sql; readonly direction: Prisma.Sql } {
  if (query.sortBy === undefined || query.sortBy.trim() === '') {
    if (query.sortOrder !== undefined && query.sortOrder.trim() !== '') {
      throw new ScimHttpException(
        400,
        'sortOrder requires an allowlisted sortBy attribute.',
        'invalidValue',
      );
    }
    return { expression: Prisma.sql`"scim_id"`, direction: Prisma.sql`ASC` };
  }
  const expression = columns[query.sortBy.trim().toLowerCase()];
  if (expression === undefined) {
    throw new ScimHttpException(400, 'sortBy is not supported for this resource.', 'invalidValue');
  }
  const order = (query.sortOrder ?? 'ascending').trim().toLowerCase();
  if (order !== 'ascending' && order !== 'descending') {
    throw new ScimHttpException(400, 'sortOrder must be ascending or descending.', 'invalidValue');
  }
  return {
    expression,
    direction: order === 'descending' ? Prisma.sql`DESC` : Prisma.sql`ASC`,
  };
}

function parsePage(query: ScimListQuery): { startIndex: number; count: number } {
  const startIndex = parseBoundedInt(query.startIndex, 1, 1, 1_000_000, 'startIndex');
  const count = parseBoundedInt(query.count, 100, 0, 200, 'count');
  return { startIndex, count };
}

function parseBoundedInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ScimHttpException(400, `${name} is outside the supported range.`, 'invalidValue');
  }
  return parsed;
}

function requireIfMatch(value: string | undefined, current: string): void {
  if (value === undefined) {
    throw new ScimHttpException(428, 'If-Match is required for SCIM mutation.');
  }
  const match = /^W\/"([0-9a-f]{64})"$/.exec(value.trim());
  if (match === null || match[1] !== current) throw preconditionFailed();
}

function preconditionFailed(): ScimHttpException {
  return new ScimHttpException(412, 'SCIM resource ETag does not match.', 'mutability');
}

function weakEtag(value: string): `W/"${string}"` {
  return `W/"${value}"`;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ScimHttpException(400, 'SCIM request body must be an object.', 'invalidSyntax');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > max) {
    throw new ScimHttpException(400, `${name} is required.`, 'invalidValue');
  }
  return value.trim();
}

function optionalText(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requiredText(value, name, max);
}

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ScimHttpException(400, `${name} must be boolean.`, 'invalidValue');
  }
  return value;
}

function sanitizeJsonObject(value: Record<string, unknown>): Prisma.InputJsonObject {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > 65_536) {
    throw new ScimHttpException(413, 'SCIM custom attributes exceed the size limit.');
  }
  return JSON.parse(serialized) as Prisma.InputJsonObject;
}

function asSafeAttributeObject(value: Prisma.JsonValue): Prisma.InputJsonObject {
  const sanitized = stripPasswordAttributes(value);
  return isRecord(sanitized) ? (sanitized as Prisma.InputJsonObject) : {};
}

function assertNoPasswordAttribute(value: unknown): void {
  const visited = new Set<object>();
  const inspect = (candidate: unknown): boolean => {
    if (candidate === null || typeof candidate !== 'object') return false;
    if (visited.has(candidate)) return false;
    visited.add(candidate);
    if (Array.isArray(candidate)) return candidate.some(inspect);
    return Object.entries(candidate as Record<string, unknown>).some(
      ([key, item]) => key.toLowerCase() === 'password' || inspect(item),
    );
  };
  if (inspect(value)) throw passwordProvisioningError();
}

function passwordProvisioningError(): ScimHttpException {
  return new ScimHttpException(
    400,
    'SCIM password provisioning is disabled; use a one-time invitation or enterprise SSO activation.',
    'mutability',
  );
}

function isPasswordPath(path: string): boolean {
  return /(^|[.:])password(?:$|\[)/i.test(path.trim());
}

function stripPasswordAttributes(value: Prisma.JsonValue): Prisma.JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => stripPasswordAttributes(item)) as Prisma.JsonArray;
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key.toLowerCase() !== 'password')
      .map(([key, item]) => [key, stripPasswordAttributes(item as Prisma.JsonValue)]),
  ) as Prisma.JsonObject;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'bigint') return JSON.stringify(value.toString());
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== 'current')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2002' || error.code === 'P2010')
  );
}
