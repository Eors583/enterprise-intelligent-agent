import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import {
  ModelRouteUnavailableError,
  resolveTrustedModelRouteSnapshot,
} from './model-route-execution.js';

const runRequest = {
  taskClass: 'GENERAL_QA',
  dataClassification: 'INTERNAL',
  requiredCapabilities: ['chat'],
} satisfies Prisma.InputJsonObject;

describe('trusted model route resolution', () => {
  it('fails closed when no published route policy exists', async () => {
    const transaction = {
      aiModelRoutePolicyVersion: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    } as unknown as Prisma.TransactionClient;

    await expect(
      resolveTrustedModelRouteSnapshot(transaction, {
        tenantId: '00000000-0000-7000-8000-000000000001',
        existingSnapshot: null,
        modelPolicy: runRequest,
        effectiveClassification: 'INTERNAL',
      }),
    ).rejects.toEqual(new ModelRouteUnavailableError('MODEL_ROUTE_UNAVAILABLE'));
  });

  it('accepts an immutable trusted snapshot without querying mutable policy state', async () => {
    const snapshot = {
      schemaVersion: 1,
      policyVersionId: '00000000-0000-7000-8000-000000000002',
      policyVersion: 3,
      policyHash: 'a'.repeat(64),
      taskClass: 'GENERAL_QA',
      maximumClassification: 'INTERNAL',
      requiredCapabilities: ['chat'],
      maximumAttempts: 1,
      circuitFailureThreshold: 3,
      circuitOpenSeconds: 60,
      candidates: [
        {
          ordinal: 1,
          catalogVersionId: '00000000-0000-7000-8000-000000000003',
          routeKey: 'PRIMARY',
          provider: 'OPENAI_COMPATIBLE',
          model: 'enterprise-chat',
          credentialReference: 'vault://ai/primary',
        },
      ],
    } satisfies Prisma.InputJsonObject;
    const findFirst = vi.fn();
    const findMany = vi.fn().mockResolvedValue([
      {
        id: '00000000-0000-7000-8000-000000000003',
        routeKey: 'PRIMARY',
        provider: 'OPENAI_COMPATIBLE',
        modelName: 'enterprise-chat',
        credentialReference: 'vault://ai/primary',
        maximumClassification: 'INTERNAL',
      },
    ]);
    const transaction = {
      aiModelRoutePolicyVersion: { findFirst },
      aiModelCatalogVersion: { findMany },
    } as unknown as Prisma.TransactionClient;

    await expect(
      resolveTrustedModelRouteSnapshot(transaction, {
        tenantId: '00000000-0000-7000-8000-000000000001',
        existingSnapshot: snapshot,
        modelPolicy: runRequest,
        effectiveClassification: 'INTERNAL',
      }),
    ).resolves.toEqual({ ...snapshot, effectiveClassification: 'INTERNAL' });
    expect(findFirst).not.toHaveBeenCalled();
    expect(findMany).toHaveBeenCalledOnce();
  });

  it('rejects malformed stored snapshots instead of repairing them from current policy', async () => {
    const transaction = {
      aiModelRoutePolicyVersion: { findFirst: vi.fn() },
    } as unknown as Prisma.TransactionClient;

    await expect(
      resolveTrustedModelRouteSnapshot(transaction, {
        tenantId: '00000000-0000-7000-8000-000000000001',
        existingSnapshot: { schemaVersion: 1 },
        modelPolicy: runRequest,
        effectiveClassification: 'INTERNAL',
      }),
    ).rejects.toEqual(new ModelRouteUnavailableError('MODEL_ROUTE_SNAPSHOT_INVALID'));
  });

  it('rejects a stored route when any catalog candidate is below the effective classification', async () => {
    const snapshot = {
      schemaVersion: 1,
      policyVersionId: '00000000-0000-7000-8000-000000000002',
      policyVersion: 3,
      policyHash: 'a'.repeat(64),
      taskClass: 'GENERAL_QA',
      maximumClassification: 'CONFIDENTIAL',
      requiredCapabilities: ['chat'],
      maximumAttempts: 1,
      circuitFailureThreshold: 3,
      circuitOpenSeconds: 60,
      candidates: [
        {
          ordinal: 1,
          catalogVersionId: '00000000-0000-7000-8000-000000000003',
          routeKey: 'PRIMARY',
          provider: 'OPENAI_COMPATIBLE',
          model: 'enterprise-chat',
          credentialReference: 'vault://ai/primary',
        },
      ],
    } satisfies Prisma.InputJsonObject;
    const transaction = {
      aiModelCatalogVersion: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: '00000000-0000-7000-8000-000000000003',
            routeKey: 'PRIMARY',
            provider: 'OPENAI_COMPATIBLE',
            modelName: 'enterprise-chat',
            credentialReference: 'vault://ai/primary',
            maximumClassification: 'INTERNAL',
          },
        ]),
      },
    } as unknown as Prisma.TransactionClient;

    await expect(
      resolveTrustedModelRouteSnapshot(transaction, {
        tenantId: '00000000-0000-7000-8000-000000000001',
        existingSnapshot: snapshot,
        modelPolicy: runRequest,
        effectiveClassification: 'CONFIDENTIAL',
      }),
    ).rejects.toEqual(new ModelRouteUnavailableError('MODEL_ROUTE_SNAPSHOT_INVALID'));
  });
});
