import { randomUUID } from 'node:crypto';

import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';

const enabled = process.env.RUN_DATABASE_TESTS === 'true';
const administrator = new PrismaClient();

describe.runIf(enabled)('PostgreSQL audit governance integration', () => {
  afterAll(async () => {
    await administrator.$disconnect();
  });

  it('exposes the payload helper only to the audit administration role', async () => {
    const [privileges] = await administrator.$queryRaw<
      Array<{
        publicExecute: boolean;
        appExecute: boolean;
        authExecute: boolean;
        adminExecute: boolean;
        outboxExecute: boolean;
      }>
    >(Prisma.sql`
      SELECT
        has_function_privilege('public', procedure.oid, 'EXECUTE') AS "publicExecute",
        has_function_privilege(
          'enterprise_agent_app',
          procedure.oid,
          'EXECUTE'
        ) AS "appExecute",
        has_function_privilege(
          'enterprise_agent_auth',
          procedure.oid,
          'EXECUTE'
        ) AS "authExecute",
        has_function_privilege(
          'enterprise_agent_admin',
          procedure.oid,
          'EXECUTE'
        ) AS "adminExecute",
        has_function_privilege(
          'enterprise_agent_outbox',
          procedure.oid,
          'EXECUTE'
        ) AS "outboxExecute"
      FROM pg_catalog.pg_proc procedure
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'public'
        AND procedure.proname = 'audit_event_chain_payload'
    `);

    expect(privileges).toEqual({
      publicExecute: false,
      appExecute: false,
      authExecute: false,
      adminExecute: true,
      outboxExecute: false,
    });
  });

  it('lets enterprise_agent_admin invoke the tenant-bound verifier', async () => {
    const tenantId = randomUUID();
    const [result] = await administrator.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_admin');
      await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return transaction.$queryRaw<
        Array<{
          checkedRecords: bigint;
          firstInvalidEventId: string | null;
          headSequence: bigint;
          headHash: string | null;
        }>
      >(Prisma.sql`
        SELECT
          "checked_records" AS "checkedRecords",
          "first_invalid_event_id" AS "firstInvalidEventId",
          "head_sequence" AS "headSequence",
          "head_hash" AS "headHash"
        FROM public.verify_audit_event_chain(${tenantId}::uuid)
      `);
    });

    expect(result).toEqual({
      checkedRecords: 0n,
      firstInvalidEventId: null,
      headSequence: 0n,
      headHash: null,
    });
  });
});
