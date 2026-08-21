import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('legacy shared member conversation migration', () => {
  it('preserves Run lineage while merging safe legacy human history', () => {
    const migration = readFileSync(
      new URL(
        '../../../prisma/migrations/20260819000100_merge_legacy_member_agent_conversations/migration.sql',
        import.meta.url,
      ),
      'utf8',
    );

    expect(migration).toContain("agent_conversation.direct_key LIKE 'agent:%'");
    expect(migration).toContain("human_conversation.direct_key LIKE 'human:%'");
    expect(migration).toContain('NOT EXISTS (\n    SELECT 1\n    FROM public.agent_runs');
    expect(migration).toContain("'member-assistant:' || requester.user_id::text");
    expect(migration).toContain("'merged-history:' || source.id::text");
    expect(migration).toContain('UPDATE public.messages');
    expect(migration).not.toContain('DELETE FROM public.messages');
    expect(migration).not.toContain('DELETE FROM public.conversations');
  });

  it('adds the represented member to remaining legacy Agent conversations', () => {
    const migration = readFileSync(
      new URL(
        '../../../prisma/migrations/20260819000200_upgrade_legacy_agent_conversations_to_shared/migration.sql',
        import.meta.url,
      ),
      'utf8',
    );

    expect(migration).toContain("conversation.direct_key LIKE 'agent:%'");
    expect(migration).toContain("'user:' || upgrade.owner_user_id::text");
    expect(migration).toContain("'member-assistant:' || upgrade.requester_user_id::text");
    expect(migration).not.toContain('DELETE FROM public.messages');
    expect(migration).not.toContain('DELETE FROM public.conversations');
  });
});
