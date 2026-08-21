import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const apiRoot = process.cwd().endsWith(path.join('apps', 'api'))
  ? process.cwd()
  : path.resolve(process.cwd(), 'apps/api');
const migration = readFileSync(
  path.join(
    apiRoot,
    'prisma/migrations/20260728001600_people_organization_foundation/migration.sql',
  ),
  'utf8',
);

describe('People and Organization database foundation', () => {
  it('creates the competency, evidence, assessment, development and triangle relationship model', () => {
    for (const table of [
      'competency_definitions',
      'competency_versions',
      'competency_levels',
      'competency_behavior_anchors',
      'role_competency_requirements',
      'competency_evidence',
      'competency_assessments',
      'competency_assessment_attributions',
      'competency_assessment_confirmations',
      'competency_appeals',
      'competency_gaps',
      'development_plans',
      'development_actions',
      'triangle_teams',
      'triangle_team_members',
      'triangle_team_metrics',
      'triangle_health_policies',
      'triangle_health_snapshots',
      'organization_change_proposals',
      'organization_impact_reports',
      'organization_impact_items',
    ]) {
      expect(migration).toContain(`CREATE TABLE public.${table}`);
    }
  });

  it('requires traceable AI candidates and configured human confirmation before effectiveness', () => {
    expect(migration).toContain(
      'Competency Assessment requires a succeeded tenant-bound Agent Run',
    );
    expect(migration).toContain(
      'AI candidate cannot become effective without every required human confirmation',
    );
    expect(migration).toContain('Assessment maker cannot act as a human checker');
    expect(migration).toContain(
      'Assessment must separate capability attribution from contextual causes',
    );
    expect(migration).toContain('Reassessment must supersede the current eligible conclusion');
  });

  it('forbids message-count health and requires three effective distinct responsibilities', () => {
    expect(migration).toContain(
      'Active Triangle Team requires three distinct effective responsibility assignments',
    );
    expect(migration).toContain('Triangle Team arbiter must be an effective Role Assignment');
    expect(migration).toContain('Triangle Team requires shared business metrics');
    expect(migration).toContain('message count is forbidden');
    expect(migration).not.toContain(`'MESSAGE_COUNT' AS`);
  });

  it('requires full organization impact analysis and independent handling of critical changes', () => {
    for (const area of ['OBJECTIVE', 'PROCESS', 'PERMISSION', 'TASK', 'AGENT_ASSIGNMENT']) {
      expect(migration).toContain(`'${area}'`);
    }
    expect(migration).toContain('Organization Change requires a complete five-area impact report');
    expect(migration).toContain('Organization Change requires an independent human confirmation');
    expect(migration).toContain('Critical Organization Change requires an independent applier');
  });

  it('forces tenant RLS and grants employees only read plus self-service appeal insertion', () => {
    expect(migration).toContain('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('AS RESTRICTIVE FOR ALL TO PUBLIC');
    expect(migration).toContain('REVOKE ALL ON TABLE public.%I FROM PUBLIC');
    expect(migration).toContain('enterprise_agent_app_appeal_insert');
    expect(migration).toContain('GRANT SELECT ON TABLE public.%I TO enterprise_agent_app');
    expect(migration).not.toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE public.%I TO enterprise_agent_app',
    );
  });
});
