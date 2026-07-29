export function roleAssignmentFixture() {
  return {
    id: '10000000-0000-7000-8000-000000000001',
    key: 'assignment-sales-lead',
    status: 'ACTIVE' as const,
    source: 'PROJECT' as const,
    effectiveFrom: '2026-07-01T00:00:00.000Z',
    effectiveTo: null,
    organizationScope: { orgUnitIds: ['40000000-0000-7000-8000-000000000001'] },
    permissionScope: { bundles: ['crm.read', 'crm.write'] },
    memoryPolicy: {},
    delegatedFromAssignmentId: null,
    blueprintRevision: 6,
    roleDefinitionSnapshot: {
      mission: '建立可预测、可持续的企业销售增长体系。',
      responsibilities: [
        {
          key: 'pipeline',
          name: '销售管道管理',
          description: '维护销售机会质量并推动关键阶段进展。',
          outcomes: ['预测准确率达到目标', '关键商机按计划推进'],
        },
      ],
      valueDefinition: {
        statement: '以可持续收入增长为客户与企业创造长期价值。',
        stakeholderOutcomes: ['客户获得匹配业务目标的解决方案'],
        measures: ['季度收入达成率', '客户续约率'],
      },
      capabilities: [
        {
          key: 'forecasting',
          name: '商业预测',
          description: '综合管道信号形成可信的收入预测。',
          level: 'ADVANCED' as const,
        },
      ],
      processes: [
        {
          key: 'quarterly-forecast',
          name: '季度预测复盘',
          description: '复盘预测偏差并调整销售计划。',
          responsibility: 'OWNER' as const,
        },
      ],
      tools: [
        {
          key: 'crm',
          name: '客户关系管理系统',
          description: '维护客户、商机与活动记录。',
          access: 'EXECUTE' as const,
        },
      ],
      knowledgeDomains: [
        {
          key: 'enterprise-pricing',
          name: '企业定价',
          description: '企业产品定价和折扣治理规则。',
          sensitivity: 'CONFIDENTIAL' as const,
        },
      ],
    },
    assignee: {
      id: '20000000-0000-7000-8000-000000000001',
      displayName: 'Lin Xia',
      status: 'ACTIVE' as const,
    },
    employment: {
      id: '30000000-0000-7000-8000-000000000001',
      organizationId: '40000000-0000-7000-8000-000000000001',
      orgUnitId: '50000000-0000-7000-8000-000000000001',
      positionId: null,
      status: 'ACTIVE' as const,
    },
    agent: {
      id: '60000000-0000-7000-8000-000000000001',
      name: 'Sales Lead Agent',
      status: 'ONLINE' as const,
      versionId: '70000000-0000-7000-8000-000000000001',
      version: 3,
      versionStatus: 'PUBLISHED' as const,
      template: {
        id: '80000000-0000-7000-8000-000000000001',
        key: 'sales-lead',
        name: '销售负责人',
      },
    },
    createdBy: {
      id: '90000000-0000-7000-8000-000000000001',
      displayName: 'Administrator',
    },
    revokedAt: null,
    revokedBy: null,
    revokeReason: null,
    createdAt: '2026-06-30T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
}
