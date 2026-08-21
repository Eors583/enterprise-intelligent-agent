import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ADMIN_PRIMARY_NAVIGATION, ADMIN_SECONDARY_NAVIGATION } from './admin-navigation';

const REMOVED_GOVERNANCE_PAGES = [
  'identity-governance',
  'tool-governance',
  'audit-governance',
  'runtime-governance',
  'finance-finops',
] as const;

const REMOVED_COMPONENTS = [
  'IdentityGovernancePage',
  'ToolGovernancePage',
  'AuditGovernancePage',
  'RuntimeGovernancePage',
  'FinanceFinopsPage',
] as const;

describe('business-only release scope', () => {
  it('keeps removed governance modules out of primary and secondary navigation', () => {
    expect(ADMIN_PRIMARY_NAVIGATION).toHaveLength(5);
    expect(ADMIN_PRIMARY_NAVIGATION.map((item) => item.id)).not.toContain('advanced-settings');
    const secondaryIds = Object.values(ADMIN_SECONDARY_NAVIGATION)
      .flatMap((items) => items ?? [])
      .map((item) => item.id);
    for (const page of REMOVED_GOVERNANCE_PAGES) expect(secondaryIds).not.toContain(page);
    expect(secondaryIds).toContain('ai-model-routing');
    expect(secondaryIds).toContain('knowledge');
    expect(secondaryIds).toContain('knowledge-integrations');
    expect(secondaryIds).toContain('agents');
  });

  it('does not bundle removed governance pages through the admin shell', () => {
    const shell = readFileSync(resolve(process.cwd(), 'src/app/AdminShell.tsx'), 'utf8');
    for (const page of REMOVED_GOVERNANCE_PAGES) {
      expect(shell).not.toContain(`page === '${page}'`);
    }
    for (const component of REMOVED_COMPONENTS) expect(shell).not.toContain(component);
    expect(shell).toContain('AiModelRoutingPage');
    expect(shell).toContain('KnowledgePage');
    expect(shell).toContain('KnowledgeIntegrationsPage');
    expect(shell).toContain('AgentsPage');
  });

  it('removes tenant cost and quota controls from the agent business page', () => {
    const agents = readFileSync(
      resolve(process.cwd(), 'src/features/agents/AgentsPage.tsx'),
      'utf8',
    );
    expect(agents).not.toContain('getAgentUsageSummary');
    expect(agents).not.toContain('updateAgentUsageLimits');
    expect(agents).not.toMatch(/Token|成本|配额|并发与速率/u);
  });
});
