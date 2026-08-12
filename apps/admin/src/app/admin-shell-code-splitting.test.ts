import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROUTE_MODULES = [
  'admin-overview/AdminOverviewPage',
  'organization/OrganizationPage',
  'members/MembersPage',
  'agents/AgentsPage',
  'role-blueprints/RoleBlueprintsPage',
  'role-assignments/RoleAssignmentsPage',
  'business-semantics/BusinessSemanticsPage',
  'marketing-management/MarketingManagementPage',
  'people-organization/PeopleOrganizationPage',
  'experience-governance/ExperienceGovernancePage',
  'identity-governance/IdentitySecurityPage',
  'ai-model-routing/AiModelRoutingPage',
  'ai-evaluation/AiEvaluationPage',
  'knowledge/KnowledgePage',
] as const;

describe('admin shell route code splitting', () => {
  it('loads every business page through a route-level dynamic import', () => {
    const shell = readFileSync(resolve(process.cwd(), 'src/app/AdminShell.tsx'), 'utf8');

    expect(shell).toContain('lazy(() =>');
    expect(shell).toContain('<Suspense');
    for (const routeModule of ROUTE_MODULES) {
      expect(shell).toContain(`import('@/features/${routeModule}')`);
      expect(shell).not.toMatch(
        new RegExp(`^import \\{[^\\n]+\\} from ['\"]@/features/${routeModule}['\"];`, 'mu'),
      );
    }
  });

  it('keeps authenticated boot from eagerly loading login and recovery forms', () => {
    const app = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');

    expect(app).toContain("import('@/features/auth/AuthScreen')");
    expect(app).toContain("import('@/features/auth/RecoveryScreen')");
    expect(app).toContain("from '@/features/auth/recovery-route'");
    expect(app).toContain("from '@/api/session-api'");
    expect(app).not.toContain("from '@/api/auth-api'");
  });

  it('uses the narrow session contract in the always-loaded shell', () => {
    const shell = readFileSync(resolve(process.cwd(), 'src/app/AdminShell.tsx'), 'utf8');
    const client = readFileSync(resolve(process.cwd(), 'src/api/client.ts'), 'utf8');

    expect(shell).toContain("from '@enterprise/contracts/auth-session'");
    expect(client).toContain("from '@enterprise/contracts/auth-session'");
  });
});
