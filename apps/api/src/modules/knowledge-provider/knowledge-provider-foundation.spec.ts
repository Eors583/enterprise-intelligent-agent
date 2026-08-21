import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('Lexiang knowledge provider persistence boundary', () => {
  it('stores only encrypted tenant-scoped credentials behind admin-only RLS', () => {
    const migration = readFileSync(
      new URL(
        '../../../prisma/migrations/20260813000100_lexiang_knowledge_provider_connection/migration.sql',
        import.meta.url,
      ),
      'utf8',
    );

    expect(migration).toContain('"credential_ciphertext" text');
    expect(migration).not.toContain('"app_secret"');
    expect(migration).not.toContain('"access_token"');
    expect(migration).toContain(
      'ALTER TABLE public."knowledge_provider_connections" FORCE ROW LEVEL SECURITY',
    );
    expect(migration).toContain(
      'ON public."knowledge_provider_connections" TO enterprise_agent_admin',
    );
    expect(migration).not.toContain(
      'ON public."knowledge_provider_connections" TO enterprise_agent_app',
    );
  });

  it('stores managed Lexiang identities behind the knowledge boundary and admin-only RLS', () => {
    const migration = readFileSync(
      new URL(
        '../../../prisma/migrations/20260813000200_lexiang_managed_knowledge_spaces/migration.sql',
        import.meta.url,
      ),
      'utf8',
    );

    expect(migration).toContain('CREATE TABLE public."knowledge_external_space_bindings"');
    expect(migration).toContain('"external_space_id" varchar(200)');
    expect(migration).toContain('"external_root_entry_id" varchar(200)');
    expect(migration).toContain(
      'ALTER TABLE public."knowledge_external_space_bindings" FORCE ROW LEVEL SECURITY',
    );
    expect(migration).toContain(
      'ON public."knowledge_external_space_bindings" TO enterprise_agent_admin',
    );
    expect(migration).not.toContain(
      'ON public."knowledge_external_space_bindings" TO enterprise_agent_app',
    );
  });

  it('stores Lexiang entry identities without exposing provider metadata to the regular app role', () => {
    const migration = readFileSync(
      new URL(
        '../../../prisma/migrations/20260813000300_lexiang_document_catalog_sync/migration.sql',
        import.meta.url,
      ),
      'utf8',
    );

    expect(migration).toContain('CREATE TABLE public."knowledge_external_entry_bindings"');
    expect(migration).toContain('"external_entry_id" varchar(200)');
    expect(migration).toContain('"document_id" uuid');
    expect(migration).toContain('"folder_id" uuid');
    expect(migration).toContain(
      'ALTER TABLE public."knowledge_external_entry_bindings" FORCE ROW LEVEL SECURITY',
    );
    expect(migration).toContain(
      'ON public."knowledge_external_entry_bindings" TO enterprise_agent_admin',
    );
    expect(migration).not.toContain(
      'ON public."knowledge_external_entry_bindings" TO enterprise_agent_app',
    );
  });

  it('stores trusted user staff identities behind admin-only RLS', () => {
    const migration = readFileSync(
      new URL(
        '../../../prisma/migrations/20260813000500_lexiang_user_identity_binding/migration.sql',
        import.meta.url,
      ),
      'utf8',
    );

    expect(migration).toContain('CREATE TABLE public."knowledge_provider_user_bindings"');
    expect(migration).toContain('"external_staff_id" varchar(200)');
    expect(migration).toContain(
      'ALTER TABLE public."knowledge_provider_user_bindings" FORCE ROW LEVEL SECURITY',
    );
    expect(migration).toContain(
      'ON public."knowledge_provider_user_bindings" TO enterprise_agent_admin',
    );
    expect(migration).not.toContain(
      'ON public."knowledge_provider_user_bindings" TO enterprise_agent_app',
    );
  });
});
