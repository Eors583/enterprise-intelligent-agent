import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { RuntimeIdentityPort } from '../process-orchestration/application/runtime-identity.port.js';
import {
  ADMIN_PRINCIPAL,
  CLAIM_STEP_COMMAND,
  INSTANCE_ID,
  MEMBER_PRINCIPAL,
  ROLE_ASSIGNMENT_ID,
  START_PROCESS_COMMAND,
  STEP_ID,
  processDetail,
  processInstance,
  processStep,
} from '../process-orchestration/testing/runtime-test-fixtures.js';
import type { ProcessRuntimeAuthorizationPort } from './process-runtime-authorization.port.js';
import type { ProcessRuntimeRepository } from './process-runtime.repository.js';
import { ProcessRuntimeService } from './process-runtime.service.js';

describe('ProcessRuntimeService', () => {
  it('lists only contract-valid instances through a bounded tenant query', async () => {
    const listInstances = vi.fn().mockResolvedValue({
      items: [processInstance()],
      nextCursor: 'next',
    });
    const { service } = createService({ repository: { listInstances } });

    const response = await service.listInstances(' cursor ');

    expect(response.pageInfo).toEqual({ nextCursor: 'next', hasMore: true });
    expect(listInstances).toHaveBeenCalledWith(ADMIN_PRINCIPAL, {
      cursor: 'cursor',
      limit: 100,
    });
  });

  it('fails closed before persistence for a non-admin runtime caller', async () => {
    const listInstances = vi.fn();
    const { service } = createService({
      repository: { listInstances },
      principal: MEMBER_PRINCIPAL,
    });

    await expect(service.listInstances()).rejects.toBeInstanceOf(ForbiddenException);
    expect(listInstances).not.toHaveBeenCalled();
  });

  it('maps an absent instance to HTTP 404 semantics', async () => {
    const { service } = createService({
      repository: { findInstance: vi.fn().mockResolvedValue(null) },
    });

    await expect(service.getInstance(INSTANCE_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns a complete contract-valid Process Instance detail', async () => {
    const findInstance = vi.fn().mockResolvedValue(processDetail());
    const { service } = createService({ repository: { findInstance } });

    const response = await service.getInstance(INSTANCE_ID);

    expect(response.instance.id).toBe(INSTANCE_ID);
    expect(response.steps).toHaveLength(1);
    expect(findInstance).toHaveBeenCalledWith(ADMIN_PRINCIPAL, INSTANCE_ID);
  });

  it('rejects a path/body aggregate mismatch before command execution', async () => {
    const executeProcessCommand = vi.fn();
    const { service } = createService({
      repository: { executeProcessCommand },
    });

    await expect(
      service.executeProcessCommand('00000000-0000-7000-8000-000000000999', START_PROCESS_COMMAND),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(executeProcessCommand).not.toHaveBeenCalled();
  });

  it('maps CAS and transition rejections to 409 and 422', async () => {
    const executeProcessCommand = vi
      .fn()
      .mockResolvedValueOnce({
        kind: 'STALE_REVISION',
        currentRevision: 3,
      })
      .mockResolvedValueOnce({
        kind: 'REJECTED',
        reason: 'INVALID_TRANSITION',
        detail: 'Cannot start a completed process.',
      });
    const { service } = createService({
      repository: { executeProcessCommand },
    });

    await expect(
      service.executeProcessCommand(INSTANCE_ID, START_PROCESS_COMMAND),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.executeProcessCommand(INSTANCE_ID, START_PROCESS_COMMAND),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('returns a contract-valid idempotent Process Instance command result', async () => {
    const executeProcessCommand = vi.fn().mockResolvedValue({
      kind: 'IDEMPOTENT_REPLAY',
      value: processInstance({
        status: 'RUNNING',
        revision: 2,
        startedAt: '2026-07-28T01:05:00.000Z',
        updatedAt: '2026-07-28T01:05:00.000Z',
      }),
    });
    const { service } = createService({
      repository: { executeProcessCommand },
    });

    const response = await service.executeProcessCommand(INSTANCE_ID, START_PROCESS_COMMAND);

    expect(response.status).toBe('RUNNING');
    expect(executeProcessCommand).toHaveBeenCalledWith({
      principal: ADMIN_PRINCIPAL,
      command: START_PROCESS_COMMAND,
    });
  });

  it('does not trust a claimed step actor identity', async () => {
    const executeStepCommand = vi.fn();
    const resolveStepActor = vi.fn().mockResolvedValue({
      actorRoleAssignmentId: '00000000-0000-7000-8000-000000000777',
      decisionId: 'decision-1',
    });
    const { service } = createService({
      repository: { executeStepCommand },
      authorization: { resolveStepActor },
    });

    await expect(
      service.executeStepCommand(INSTANCE_ID, STEP_ID, CLAIM_STEP_COMMAND),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(executeStepCommand).not.toHaveBeenCalled();
  });

  it('executes a step command only with the server-resolved actor', async () => {
    const executeStepCommand = vi.fn().mockResolvedValue({
      kind: 'APPLIED',
      value: processStep({
        status: 'RUNNING',
        revision: 2,
        claimedAt: '2026-07-28T01:05:00.000Z',
        startedAt: '2026-07-28T01:05:00.000Z',
        updatedAt: '2026-07-28T01:05:00.000Z',
      }),
    });
    const resolveStepActor = vi.fn().mockResolvedValue({
      actorRoleAssignmentId: ROLE_ASSIGNMENT_ID,
      decisionId: 'decision-2',
    });
    const { service } = createService({
      repository: { executeStepCommand },
      authorization: { resolveStepActor },
    });

    const response = await service.executeStepCommand(INSTANCE_ID, STEP_ID, CLAIM_STEP_COMMAND);

    expect(response.revision).toBe(2);
    expect(resolveStepActor).toHaveBeenCalledWith(
      expect.objectContaining({
        principal: ADMIN_PRINCIPAL,
        processInstanceId: INSTANCE_ID,
        stepInstanceId: STEP_ID,
      }),
    );
    expect(executeStepCommand).toHaveBeenCalledWith({
      principal: ADMIN_PRINCIPAL,
      processInstanceId: INSTANCE_ID,
      command: {
        ...CLAIM_STEP_COMMAND,
        actorRoleAssignmentId: ROLE_ASSIGNMENT_ID,
      },
    });
  });

  it('rejects structurally inconsistent adapter data instead of leaking it', async () => {
    const { service } = createService({
      repository: {
        findInstance: vi.fn().mockResolvedValue({
          ...processDetail(),
          instance: processInstance({
            tenantId: '00000000-0000-7000-8000-000000000888',
          }),
        }),
      },
    });

    await expect(service.getInstance(INSTANCE_ID)).rejects.toBeInstanceOf(ConflictException);
  });
});

function createService(input: {
  readonly repository?: Partial<ProcessRuntimeRepository>;
  readonly authorization?: Partial<ProcessRuntimeAuthorizationPort>;
  readonly principal?: typeof ADMIN_PRINCIPAL;
}) {
  const repository = {
    listInstances: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    findInstance: vi.fn().mockResolvedValue(processDetail()),
    executeProcessCommand: vi.fn().mockResolvedValue({
      kind: 'APPLIED',
      value: processInstance({
        status: 'RUNNING',
        revision: 2,
        startedAt: '2026-07-28T01:05:00.000Z',
        updatedAt: '2026-07-28T01:05:00.000Z',
      }),
    }),
    executeStepCommand: vi.fn(),
    ...input.repository,
  } as unknown as ProcessRuntimeRepository;
  const authorization = {
    resolveStepActor: vi.fn().mockResolvedValue({
      actorRoleAssignmentId: ROLE_ASSIGNMENT_ID,
      decisionId: 'decision-default',
    }),
    ...input.authorization,
  } as unknown as ProcessRuntimeAuthorizationPort;
  const identity = {
    current: () => input.principal ?? ADMIN_PRINCIPAL,
  } as RuntimeIdentityPort;
  return {
    service: new ProcessRuntimeService(repository, authorization, identity),
    repository,
    authorization,
  };
}
