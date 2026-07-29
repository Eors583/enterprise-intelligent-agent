import type { ValueDefinition, ValueVersion } from '@enterprise/contracts';

const id = (number: number): string =>
  `00000000-0000-7000-8000-${String(number).padStart(12, '0')}`;
const tenantId = '10000000-0000-7000-8000-000000000001';
const owner = { type: 'USER' as const, id: id(1) };
const effectiveFrom = '2026-01-01T00:00:00.000Z';
const effectiveTo = null;
const createdAt = '2026-01-01T00:00:00.000Z';
const updatedAt = '2026-07-28T00:00:00.000Z';

export function valueDefinitionFixture(): ValueDefinition {
  return {
    id: id(10),
    tenantId,
    code: 'VALUE.CUSTOMER.SUCCESS',
    owner,
    version: 2,
    revision: 4,
    permissionLabels: ['business.read', 'customer.success'],
    createdAt,
    updatedAt,
    effectiveFrom,
    effectiveTo,
    type: 'CUSTOMER',
    name: '客户成功价值',
    description: '以持续、可验证的客户成果作为价值判断。',
    currentVersionId: id(11),
  };
}

export function valueVersionFixture(): ValueVersion {
  return {
    id: id(11),
    tenantId,
    valueDefinitionId: id(10),
    version: 2,
    revision: 3,
    status: 'PUBLISHED',
    statement: '通过主动识别风险和持续交付成果创造客户价值。',
    effectiveFrom,
    effectiveTo,
    owner,
    permissionLabels: ['business.read'],
    positiveBehaviors: ['主动识别客户风险'],
    negativeBehaviors: ['忽略客户反馈'],
    metrics: [
      {
        id: id(12),
        tenantId,
        code: 'VALUE.METRIC.RETENTION',
        owner,
        version: 1,
        revision: 1,
        permissionLabels: ['business.read'],
        createdAt,
        updatedAt,
        valueVersionId: id(11),
        metricDefinitionId: id(20),
        name: '客户留存率',
        weight: 1,
        target: { kind: 'AT_LEAST', value: 90 },
      },
    ],
    constraints: [],
    changeSummary: '发布客户成功价值标准',
    createdAt,
    updatedAt,
  };
}
