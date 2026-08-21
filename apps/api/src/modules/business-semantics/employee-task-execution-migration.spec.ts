import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL(
    '../../../prisma/migrations/20260728002400_employee_task_execution/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const service = readFileSync(
  new URL('./employee-task-execution.service.ts', import.meta.url),
  'utf8',
);

describe('employee task execution database boundary', () => {
  it('uses a non-login, non-bypass executor without inheriting an application or admin role', () => {
    expect(migration).toContain(
      'CREATE ROLE enterprise_agent_task_executor\n      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',
    );
    expect(migration).not.toMatch(
      /GRANT\s+(?:enterprise_agent_admin|enterprise_agent_app)\s+TO\s+enterprise_agent_task_executor/iu,
    );
    expect(migration).not.toMatch(
      /GRANT\s+(?:UPDATE|DELETE|TRUNCATE)(?:\s*\([^;]*\))?\s+ON TABLE\s+public\."acceptances"\s+TO\s+enterprise_agent_task_executor/iu,
    );
    expect(migration).not.toMatch(
      /GRANT\s+INSERT\s+ON TABLE\s+public\."evidence"\s+TO\s+enterprise_agent_task_executor/iu,
    );
  });

  it('forces tenant RLS and keeps commands and Acceptance Requests append-only', () => {
    expect(migration).toContain(`'employee_task_commands'`);
    expect(migration).toContain(`'employee_task_acceptance_requests'`);
    expect(migration).toContain(
      `EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name)`,
    );
    expect(migration).toContain(`BEFORE UPDATE OR DELETE ON public."employee_task_commands"`);
    expect(migration).toContain(`BEFORE TRUNCATE ON public."employee_task_commands"`);
    expect(migration).toContain(
      `BEFORE UPDATE OR DELETE ON public."employee_task_acceptance_requests"`,
    );
    expect(migration).toContain(`BEFORE TRUNCATE ON public."employee_task_acceptance_requests"`);
    expect(migration).toContain(
      `REVOKE ALL ON FUNCTION public.reject_employee_task_ledger_mutation() FROM PUBLIC`,
    );
    expect(migration).not.toMatch(
      /GRANT\s+SELECT,\s*INSERT,\s*UPDATE\s+ON TABLE\s+public\."employee_task_commands"/iu,
    );
  });

  it('binds every executor decision to server session identity, exact action and Task scope', () => {
    expect(migration).toContain(
      `required_action =\n      NULLIF(current_setting('app.action', true), '')`,
    );
    expect(migration).toContain(`current_setting('app.role_assignment_id', true)`);
    expect(migration).toContain(`current_setting('app.user_id', true)`);
    expect(migration).toContain(`assignment."permission_scope" -> 'taskIds' ? task."id"::text`);
    expect(migration).toContain(`assignment."permission_scope" -> 'dataLabels' ? label.value`);
    expect(migration).toContain(`public.memory_assignment_active(`);
    expect(migration).toContain(`objective_assignment."role_assignment_id" = assignment."id"`);
    expect(migration).toContain(`REVOKE ALL ON FUNCTION public.employee_task_action_authorized(`);
    expect(migration).toContain(`REVOKE ALL ON FUNCTION public.employee_submit_task_evidence(`);
  });

  it('keeps employee evidence unverified and delegates formal transitions to existing domain logic', () => {
    expect(migration).toMatch(/evidence_id,\s*input_tenant_id,\s*input_code,\s*1,\s*1,\s*'DRAFT'/u);
    expect(migration).toContain(`'SHA256', input_content_hash, 'UNVERIFIED', 0.5`);
    expect(service).toContain('await assertTaskTransitionEvidence(');
    expect(service).toContain('taskTransitionData(current, request.action');
    expect(service).toContain('await submitDeliverableWithinTransaction(');
    expect(service).toContain('if (task.processInstanceId !== null)');
    expect(service).toContain('await lockEmployeeCommand(');
    expect(service.indexOf('await lockEmployeeCommand(')).toBeLessThan(
      service.indexOf('const replay = await readCommandReplay('),
    );
  });
});
