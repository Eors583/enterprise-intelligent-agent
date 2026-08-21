import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import {
  PrismaService,
  REQUIRED_AI_EVALUATION_COLUMNS,
  REQUIRED_AI_EVALUATION_RUNNER_POLICIES,
  REQUIRED_AI_EVALUATION_TABLES,
  REQUIRED_AI_EVALUATION_TRIGGERS,
  REQUIRED_APPLICATION_SCHEMA_COLUMNS,
  REQUIRED_BUSINESS_SEMANTIC_CONSTRAINTS,
  REQUIRED_BUSINESS_SEMANTIC_INDEXES,
  REQUIRED_BUSINESS_SEMANTIC_TABLES,
  REQUIRED_BUSINESS_SEMANTIC_TRIGGERS,
  REQUIRED_OUTBOX_DELIVERY_TABLES,
  REQUIRED_OUTBOX_DELIVERY_TRIGGERS,
  REQUIRED_PROCESS_RUNTIME_COLUMNS,
  REQUIRED_PROCESS_RUNTIME_TABLES,
  REQUIRED_PROCESS_RUNTIME_TRIGGERS,
  REQUIRED_TOOL_GATEWAY_COLUMNS,
  REQUIRED_TOOL_GATEWAY_TABLES,
} from './prisma.service.js';

interface ReadinessState {
  readonly role: string;
  readonly table_count: number;
  readonly forced_rls_count: number;
  readonly policy_count: number;
  readonly missing_schema_columns: string[];
  readonly semantic_table_count: number;
  readonly semantic_forced_rls_count: number;
  readonly semantic_policy_count: number;
  readonly semantic_acl_count: number;
  readonly missing_semantic_constraints: string[];
  readonly missing_semantic_triggers: string[];
  readonly missing_semantic_indexes: string[];
  readonly process_runtime_table_count: number;
  readonly process_runtime_forced_rls_count: number;
  readonly process_runtime_policy_count: number;
  readonly process_runtime_role_count: number;
  readonly process_runtime_acl_ready: boolean;
  readonly process_assignment_helper_ready: boolean;
  readonly missing_process_runtime_columns: string[];
  readonly missing_process_runtime_triggers: string[];
  readonly outbox_delivery_table_count: number;
  readonly outbox_delivery_forced_rls_count: number;
  readonly outbox_delivery_policy_count: number;
  readonly outbox_delivery_acl_ready: boolean;
  readonly outbox_event_immutable_acl_ready: boolean;
  readonly missing_outbox_delivery_triggers: string[];
  readonly tool_gateway_table_count: number;
  readonly tool_gateway_forced_rls_count: number;
  readonly tool_gateway_policy_count: number;
  readonly tool_gateway_role_count: number;
  readonly missing_tool_gateway_columns: string[];
  readonly ai_evaluation_table_count: number;
  readonly ai_evaluation_forced_rls_count: number;
  readonly ai_evaluation_base_policy_count: number;
  readonly ai_evaluation_runner_policy_count: number;
  readonly ai_evaluation_runner_boundary_count: number;
  readonly ai_evaluation_role_count: number;
  readonly ai_evaluation_acl_ready: boolean;
  readonly missing_ai_evaluation_columns: string[];
  readonly missing_ai_evaluation_triggers: string[];
}

function serviceWithState(state: ReadinessState): {
  readonly service: PrismaService;
  readonly executeRaw: ReturnType<typeof vi.fn>;
  readonly queryRaw: ReturnType<typeof vi.fn>;
  readonly countUsers: ReturnType<typeof vi.fn>;
} {
  const executeRaw = vi.fn().mockResolvedValue(0);
  const queryRaw = vi.fn().mockResolvedValue([state]);
  const countUsers = vi.fn().mockResolvedValue(0);
  const transaction = {
    $executeRawUnsafe: executeRaw,
    $queryRaw: queryRaw,
    user: { count: countUsers },
  };
  const service = Object.create(PrismaService.prototype) as PrismaService;
  Object.defineProperty(service, 'enabled', { value: true });
  Object.defineProperty(service, '$transaction', {
    value: vi.fn(async (operation: (client: typeof transaction) => Promise<unknown>) =>
      operation(transaction),
    ),
  });
  return { service, executeRaw, queryRaw, countUsers };
}

const readyState: ReadinessState = {
  role: 'enterprise_agent_app',
  table_count: 3,
  forced_rls_count: 3,
  policy_count: 3,
  missing_schema_columns: [],
  semantic_table_count: REQUIRED_BUSINESS_SEMANTIC_TABLES.length,
  semantic_forced_rls_count: REQUIRED_BUSINESS_SEMANTIC_TABLES.length,
  semantic_policy_count: REQUIRED_BUSINESS_SEMANTIC_TABLES.length * 3,
  semantic_acl_count: REQUIRED_BUSINESS_SEMANTIC_TABLES.length,
  missing_semantic_constraints: [],
  missing_semantic_triggers: [],
  missing_semantic_indexes: [],
  process_runtime_table_count: REQUIRED_PROCESS_RUNTIME_TABLES.length,
  process_runtime_forced_rls_count: REQUIRED_PROCESS_RUNTIME_TABLES.length,
  process_runtime_policy_count: REQUIRED_PROCESS_RUNTIME_TABLES.length * 4,
  process_runtime_role_count: 1,
  process_runtime_acl_ready: true,
  process_assignment_helper_ready: true,
  missing_process_runtime_columns: [],
  missing_process_runtime_triggers: [],
  outbox_delivery_table_count: REQUIRED_OUTBOX_DELIVERY_TABLES.length,
  outbox_delivery_forced_rls_count: 1,
  outbox_delivery_policy_count: 4,
  outbox_delivery_acl_ready: true,
  outbox_event_immutable_acl_ready: true,
  missing_outbox_delivery_triggers: [],
  tool_gateway_table_count: REQUIRED_TOOL_GATEWAY_TABLES.length,
  tool_gateway_forced_rls_count: REQUIRED_TOOL_GATEWAY_TABLES.length,
  tool_gateway_policy_count: REQUIRED_TOOL_GATEWAY_TABLES.length * 3,
  tool_gateway_role_count: 1,
  missing_tool_gateway_columns: [],
  ai_evaluation_table_count: REQUIRED_AI_EVALUATION_TABLES.length,
  ai_evaluation_forced_rls_count: REQUIRED_AI_EVALUATION_TABLES.length,
  ai_evaluation_base_policy_count: REQUIRED_AI_EVALUATION_TABLES.length * 2,
  ai_evaluation_runner_policy_count: REQUIRED_AI_EVALUATION_RUNNER_POLICIES.length,
  ai_evaluation_runner_boundary_count: 5,
  ai_evaluation_role_count: 1,
  ai_evaluation_acl_ready: true,
  missing_ai_evaluation_columns: [],
  missing_ai_evaluation_triggers: [],
};

describe('PrismaService readiness', () => {
  it('only checks physical table columns present in the generated Prisma schema', () => {
    const physicalColumns = new Set(
      Prisma.dmmf.datamodel.models.flatMap((model) =>
        model.fields
          .filter((field) => field.kind !== 'object')
          .map((field) => `${model.dbName ?? model.name}.${field.dbName ?? field.name}`),
      ),
    );

    expect(
      REQUIRED_APPLICATION_SCHEMA_COLUMNS.filter(
        ({ tableName, columnName }) => !physicalColumns.has(`${tableName}.${columnName}`),
      ),
    ).toEqual([]);
    expect(REQUIRED_APPLICATION_SCHEMA_COLUMNS).toContainEqual({
      tableName: 'org_units',
      columnName: 'status',
    });
    expect(REQUIRED_APPLICATION_SCHEMA_COLUMNS).toContainEqual({
      tableName: 'agent_runs',
      columnName: 'task_id',
    });
    expect(REQUIRED_APPLICATION_SCHEMA_COLUMNS).toContainEqual({
      tableName: 'auth_recovery_deliveries',
      columnName: 'payload_ciphertext',
    });
    expect(REQUIRED_BUSINESS_SEMANTIC_TABLES).toHaveLength(37);
    expect(REQUIRED_BUSINESS_SEMANTIC_CONSTRAINTS).toContain('tasks_process_node_fkey');
    expect(REQUIRED_BUSINESS_SEMANTIC_TRIGGERS).toContain('tasks_completion_integrity_trigger');
    expect(REQUIRED_BUSINESS_SEMANTIC_INDEXES).toContain('agent_runs_tenant_task_id_idx');
    expect(REQUIRED_PROCESS_RUNTIME_TABLES).toHaveLength(5);
    expect(REQUIRED_PROCESS_RUNTIME_COLUMNS).toContainEqual({
      tableName: 'process_step_instances',
      columnName: 'assignment_snapshot',
    });
    expect(REQUIRED_PROCESS_RUNTIME_COLUMNS).toContainEqual({
      tableName: 'process_commands',
      columnName: 'actor_role_assignment_id',
    });
    expect(REQUIRED_PROCESS_RUNTIME_TRIGGERS).toContain(
      'process_step_task_lifecycle_transition_trigger',
    );
    expect(REQUIRED_OUTBOX_DELIVERY_TABLES).toEqual([
      'outbox_event_routes',
      'outbox_event_route_prefixes',
      'outbox_event_deliveries',
    ]);
    expect(REQUIRED_OUTBOX_DELIVERY_TRIGGERS).toEqual(['outbox_events_delivery_routing_trigger']);
    expect(REQUIRED_TOOL_GATEWAY_TABLES).toHaveLength(6);
    expect(REQUIRED_TOOL_GATEWAY_COLUMNS).toContainEqual({
      tableName: 'tool_invocations',
      columnName: 'provider_dispatch_allowed',
    });
    expect(REQUIRED_AI_EVALUATION_TABLES).toHaveLength(19);
    expect(REQUIRED_AI_EVALUATION_COLUMNS).toContainEqual({
      tableName: 'ai_evaluation_runs',
      columnName: 'result_submitted_by_runner_id',
    });
    expect(REQUIRED_AI_EVALUATION_TRIGGERS).toContain('ai_evaluation_runs_results_trigger');
    expect(REQUIRED_AI_EVALUATION_RUNNER_POLICIES).toHaveLength(9);
  });

  it('accepts a database with the security and application schema baselines', async () => {
    const { service, executeRaw, queryRaw, countUsers } = serviceWithState(readyState);

    await expect(service.ping()).resolves.toBeUndefined();

    expect(executeRaw).toHaveBeenCalledWith('SET LOCAL ROLE enterprise_agent_app');
    expect(queryRaw).toHaveBeenCalledOnce();
    expect(countUsers).toHaveBeenCalledOnce();
  });

  it('keeps the feedback source ledger read-only for administrators in the readiness ACL', async () => {
    const { service, queryRaw } = serviceWithState(readyState);

    await service.ping();

    const readinessQuerySegments = queryRaw.mock.calls[0]?.[0] as readonly string[] | undefined;
    const readinessQueryText = readinessQuerySegments?.join('');
    expect(readinessQueryText).toContain(
      "required.table_name = 'ai_evaluation_answer_feedback_sources'",
    );
    expect(readinessQueryText).toContain(
      "required.table_name <> 'ai_evaluation_answer_feedback_sources'",
    );
  });

  it('rejects a database that is reachable but is missing a required business column', async () => {
    const { service, countUsers } = serviceWithState({
      ...readyState,
      missing_schema_columns: ['knowledge_chunk_embeddings.embedding_model'],
    });

    await expect(service.ping()).rejects.toThrow(
      'Database security or application schema baseline is incomplete.',
    );
    expect(countUsers).not.toHaveBeenCalled();
  });

  it.each([
    {
      field: 'missing_semantic_constraints',
      missing: ['tasks_process_node_fkey'],
    },
    {
      field: 'missing_semantic_triggers',
      missing: ['tasks_completion_integrity_trigger'],
    },
    {
      field: 'missing_semantic_indexes',
      missing: ['agent_runs_tenant_task_id_idx'],
    },
  ] as const)(
    'rejects a partially applied business semantics migration with $field',
    async ({ field, missing }) => {
      const { service, countUsers } = serviceWithState({
        ...readyState,
        [field]: [...missing],
      });

      await expect(service.ping()).rejects.toThrow(
        'Database security or application schema baseline is incomplete.',
      );
      expect(countUsers).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['outbox_delivery_table_count', REQUIRED_OUTBOX_DELIVERY_TABLES.length - 1],
    ['outbox_delivery_forced_rls_count', 0],
    ['outbox_delivery_policy_count', 3],
    ['outbox_delivery_acl_ready', false],
    ['outbox_event_immutable_acl_ready', false],
  ] as const)('rejects an incomplete Outbox delivery baseline in %s', async (field, value) => {
    const { service, countUsers } = serviceWithState({
      ...readyState,
      [field]: value,
    });
    await expect(service.ping()).rejects.toThrow(
      'Database security or application schema baseline is incomplete.',
    );
    expect(countUsers).not.toHaveBeenCalled();
  });

  it('rejects a missing Outbox routing trigger', async () => {
    const { service, countUsers } = serviceWithState({
      ...readyState,
      missing_outbox_delivery_triggers: ['outbox_events_delivery_routing_trigger'],
    });
    await expect(service.ping()).rejects.toThrow(
      'Database security or application schema baseline is incomplete.',
    );
    expect(countUsers).not.toHaveBeenCalled();
  });

  it.each([
    ['process_runtime_table_count', REQUIRED_PROCESS_RUNTIME_TABLES.length - 1],
    ['process_runtime_forced_rls_count', REQUIRED_PROCESS_RUNTIME_TABLES.length - 1],
    ['process_runtime_policy_count', REQUIRED_PROCESS_RUNTIME_TABLES.length * 4 - 1],
    ['process_runtime_role_count', 0],
    ['process_runtime_acl_ready', false],
    ['process_assignment_helper_ready', false],
  ] as const)(
    'rejects a partially applied Process Runtime migration in %s',
    async (field, value) => {
      const { service, countUsers } = serviceWithState({
        ...readyState,
        [field]: value,
      });
      await expect(service.ping()).rejects.toThrow(
        'Database security or application schema baseline is incomplete.',
      );
      expect(countUsers).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      field: 'missing_process_runtime_columns',
      missing: ['process_step_instances.assignment_snapshot'],
    },
    {
      field: 'missing_process_runtime_triggers',
      missing: ['process_step_task_lifecycle_transition_trigger'],
    },
  ] as const)(
    'rejects a partially applied Process Runtime signature with $field',
    async ({ field, missing }) => {
      const { service, countUsers } = serviceWithState({
        ...readyState,
        [field]: [...missing],
      });
      await expect(service.ping()).rejects.toThrow(
        'Database security or application schema baseline is incomplete.',
      );
      expect(countUsers).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['tool_gateway_table_count', REQUIRED_TOOL_GATEWAY_TABLES.length - 1],
    ['tool_gateway_forced_rls_count', REQUIRED_TOOL_GATEWAY_TABLES.length - 1],
    ['tool_gateway_policy_count', REQUIRED_TOOL_GATEWAY_TABLES.length * 3 - 1],
    ['tool_gateway_role_count', 0],
  ] as const)(
    'rejects an incomplete Tool Gateway readiness baseline in %s',
    async (field, value) => {
      const { service, countUsers } = serviceWithState({
        ...readyState,
        [field]: value,
      });
      await expect(service.ping()).rejects.toThrow(
        'Database security or application schema baseline is incomplete.',
      );
      expect(countUsers).not.toHaveBeenCalled();
    },
  );

  it('rejects a Tool Gateway table missing a critical immutable-ledger column', async () => {
    const { service, countUsers } = serviceWithState({
      ...readyState,
      missing_tool_gateway_columns: ['tool_execution_receipts.receipt_hash'],
    });
    await expect(service.ping()).rejects.toThrow(
      'Database security or application schema baseline is incomplete.',
    );
    expect(countUsers).not.toHaveBeenCalled();
  });

  it.each([
    ['ai_evaluation_table_count', REQUIRED_AI_EVALUATION_TABLES.length - 1],
    ['ai_evaluation_forced_rls_count', REQUIRED_AI_EVALUATION_TABLES.length - 1],
    ['ai_evaluation_base_policy_count', REQUIRED_AI_EVALUATION_TABLES.length * 2 - 1],
    ['ai_evaluation_runner_policy_count', REQUIRED_AI_EVALUATION_RUNNER_POLICIES.length - 1],
    ['ai_evaluation_runner_boundary_count', 4],
    ['ai_evaluation_role_count', 0],
    ['ai_evaluation_acl_ready', false],
  ] as const)(
    'rejects an incomplete AI evaluation governance baseline in %s',
    async (field, value) => {
      const { service, countUsers } = serviceWithState({
        ...readyState,
        [field]: value,
      });
      await expect(service.ping()).rejects.toThrow(
        'Database security or application schema baseline is incomplete.',
      );
      expect(countUsers).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      field: 'missing_ai_evaluation_columns',
      missing: ['ai_evaluation_runs.result_submitted_by_runner_id'],
    },
    {
      field: 'missing_ai_evaluation_triggers',
      missing: ['ai_evaluation_runs_results_trigger'],
    },
  ] as const)(
    'rejects partially applied AI evaluation governance with $field',
    async ({ field, missing }) => {
      const { service, countUsers } = serviceWithState({
        ...readyState,
        [field]: [...missing],
      });
      await expect(service.ping()).rejects.toThrow(
        'Database security or application schema baseline is incomplete.',
      );
      expect(countUsers).not.toHaveBeenCalled();
    },
  );
});
