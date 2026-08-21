import {
  ForbiddenException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { RuntimeIdentityPort } from '../process-orchestration/application/runtime-identity.port.js';
import { ToolGatewayRepository } from './tool-gateway.repository.js';
import { stableToolDefinitionKey, ToolGatewayService } from './tool-gateway.service.js';

const PRINCIPAL = {
  tenantId: '00000000-0000-7000-8000-000000000301',
  userId: '00000000-0000-7000-8000-000000000302',
  tenantRole: 'OWNER' as const,
  authenticationSource: 'session' as const,
};

describe('ToolGatewayService', () => {
  it('derives a stable server key when the client omits one', async () => {
    const repository = repositoryMock();
    repository.createDefinition.mockResolvedValueOnce({
      kind: 'APPLIED',
      value: { id: 'tool-1', key: 'customer-profile' },
    });
    const service = new ToolGatewayService(
      repository as unknown as ToolGatewayRepository,
      { current: () => PRINCIPAL } as RuntimeIdentityPort,
      config(),
    );
    const request = {
      name: 'Customer Profile',
      description: 'Read customer profile.',
      permissionLabels: ['crm.read'],
      idempotencyKey: 'create-tool-1',
    };

    await expect(service.createDefinition(request)).resolves.toMatchObject({
      key: 'customer-profile',
    });
    expect(repository.createDefinition).toHaveBeenCalledWith({
      principal: PRINCIPAL,
      keyWasGenerated: true,
      request: { ...request, key: 'customer-profile' },
    });
    expect(stableToolDefinitionKey('客户资料')).toMatch(/^tool-[a-f0-9]{12}$/u);
  });

  it('preserves a legacy explicit Tool Definition key', async () => {
    const repository = repositoryMock();
    repository.createDefinition.mockResolvedValueOnce({
      kind: 'APPLIED',
      value: { id: 'tool-1', key: 'crm.customer.read' },
    });
    const service = new ToolGatewayService(
      repository as unknown as ToolGatewayRepository,
      { current: () => PRINCIPAL } as RuntimeIdentityPort,
      config(),
    );
    const request = {
      key: 'crm.customer.read',
      name: '客户资料',
      description: '读取客户资料。',
      permissionLabels: [],
      idempotencyKey: 'create-tool-explicit',
    };

    await service.createDefinition(request);

    expect(repository.createDefinition).toHaveBeenCalledWith({
      principal: PRINCIPAL,
      keyWasGenerated: false,
      request,
    });
  });

  it('discovers only tools authorized by the repository for the trusted task principal', async () => {
    const repository = repositoryMock();
    repository.listAvailableTools.mockResolvedValueOnce([
      { toolVersionId: '00000000-0000-7000-8000-000000000303' },
    ]);
    const service = new ToolGatewayService(
      repository as unknown as ToolGatewayRepository,
      { current: () => PRINCIPAL } as RuntimeIdentityPort,
      config(),
    );

    await expect(
      service.listAvailableTools('00000000-0000-7000-8000-000000000304'),
    ).resolves.toEqual({
      items: [{ toolVersionId: '00000000-0000-7000-8000-000000000303' }],
    });
    expect(repository.listAvailableTools).toHaveBeenCalledWith(
      PRINCIPAL,
      '00000000-0000-7000-8000-000000000304',
    );
  });

  it('returns only independently reviewable invocations resolved for the trusted principal', async () => {
    const repository = repositoryMock();
    repository.listReviewableInvocations.mockResolvedValueOnce([{ id: 'invocation-1' }]);
    const service = new ToolGatewayService(
      repository as unknown as ToolGatewayRepository,
      { current: () => PRINCIPAL } as RuntimeIdentityPort,
      config(),
    );

    await expect(
      service.listReviewableInvocations('00000000-0000-7000-8000-000000000304'),
    ).resolves.toEqual({
      items: [{ id: 'invocation-1' }],
      nextCursor: null,
    });
    expect(repository.listReviewableInvocations).toHaveBeenCalledWith(
      PRINCIPAL,
      '00000000-0000-7000-8000-000000000304',
    );
  });

  it('passes only the trusted request principal into an invocation mutation', async () => {
    const repository = repositoryMock();
    repository.createInvocation.mockResolvedValueOnce({
      kind: 'APPLIED',
      value: { id: 'invocation-1' },
    });
    const service = new ToolGatewayService(
      repository as unknown as ToolGatewayRepository,
      { current: () => PRINCIPAL } as RuntimeIdentityPort,
      config(),
    );
    const request = {
      toolVersionId: '00000000-0000-7000-8000-000000000303',
      taskId: '00000000-0000-7000-8000-000000000304',
      correlationId: '00000000-0000-7000-8000-000000000305',
      dryRun: true,
      input: { customerId: 'customer-1' },
      reason: 'Validate before dispatch.',
      idempotencyKey: 'invoke-1',
    };

    await expect(service.createInvocation(request)).resolves.toEqual({
      id: 'invocation-1',
    });
    expect(repository.createInvocation).toHaveBeenCalledWith({
      principal: PRINCIPAL,
      request,
    });
  });

  it('creates compensation through a server-derived repository command only', async () => {
    const repository = repositoryMock();
    repository.createCompensation.mockResolvedValueOnce({
      kind: 'APPLIED',
      value: {
        id: 'compensation-1',
        compensationForInvocationId: '00000000-0000-7000-8000-000000000306',
      },
    });
    const service = new ToolGatewayService(
      repository as unknown as ToolGatewayRepository,
      { current: () => PRINCIPAL } as RuntimeIdentityPort,
      config(),
    );
    const request = {
      expectedRevision: 4,
      reason: 'Reverse the exact completed provider write.',
      idempotencyKey: 'compensate-1',
    };
    await expect(
      service.createCompensation('00000000-0000-7000-8000-000000000306', request),
    ).resolves.toMatchObject({ id: 'compensation-1' });
    expect(repository.createCompensation).toHaveBeenCalledWith({
      principal: PRINCIPAL,
      originalInvocationId: '00000000-0000-7000-8000-000000000306',
      request,
    });
  });

  it('requires tenant administration for Tool Definition lifecycle operations', async () => {
    const repository = repositoryMock();
    const service = new ToolGatewayService(
      repository as unknown as ToolGatewayRepository,
      {
        current: () => ({ ...PRINCIPAL, tenantRole: 'MEMBER' as const }),
      } as RuntimeIdentityPort,
      config(),
    );
    await expect(service.listDefinitions()).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.listDefinitions).not.toHaveBeenCalled();
  });

  it('surfaces stale revision and policy rejection instead of hiding them', async () => {
    const repository = repositoryMock();
    const service = new ToolGatewayService(
      repository as unknown as ToolGatewayRepository,
      { current: () => PRINCIPAL } as RuntimeIdentityPort,
      config(),
    );
    repository.decideInvocation.mockResolvedValueOnce({
      kind: 'STALE_REVISION',
      currentRevision: 4,
    });
    await expect(
      service.decideInvocation('00000000-0000-7000-8000-000000000306', {
        expectedRevision: 3,
        action: 'CANCEL',
        reason: 'Cancel before dispatch.',
        idempotencyKey: 'cancel-1',
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('does not advertise or create invocations while the execution worker is disabled', async () => {
    const repository = repositoryMock();
    const service = new ToolGatewayService(
      repository as unknown as ToolGatewayRepository,
      { current: () => PRINCIPAL } as RuntimeIdentityPort,
      config({ workerEnabled: false }),
    );

    await expect(
      service.listAvailableTools('00000000-0000-7000-8000-000000000304'),
    ).resolves.toEqual({ items: [] });
    await expect(
      service.createInvocation({
        toolVersionId: '00000000-0000-7000-8000-000000000303',
        taskId: '00000000-0000-7000-8000-000000000304',
        correlationId: '00000000-0000-7000-8000-000000000305',
        dryRun: false,
        input: {},
        reason: 'Execute the configured tool.',
        idempotencyKey: 'disabled-runtime',
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(repository.listAvailableTools).not.toHaveBeenCalled();
    expect(repository.createInvocation).not.toHaveBeenCalled();
  });

  it('blocks publishing until an implemented adapter has a matching server-side endpoint', async () => {
    const repository = repositoryMock();
    repository.findDefinition.mockResolvedValue({
      definition: { id: '00000000-0000-7000-8000-000000000310' },
      versions: [
        {
          id: '00000000-0000-7000-8000-000000000311',
          adapter: 'HTTP',
          endpointRef: 'crm.read',
          allowedHttpMethods: ['GET'],
          riskClass: 'READ_ONLY',
          idempotencyMode: 'SYSTEM_LEDGER',
        },
      ],
    });
    const service = new ToolGatewayService(
      repository as unknown as ToolGatewayRepository,
      { current: () => PRINCIPAL } as RuntimeIdentityPort,
      config(),
    );

    await expect(
      service.transitionVersion(
        '00000000-0000-7000-8000-000000000310',
        '00000000-0000-7000-8000-000000000311',
        {
          action: 'PUBLISH',
          expectedDefinitionRevision: 1,
          reason: 'Publish after runtime verification.',
          idempotencyKey: 'publish-without-endpoint',
        },
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(repository.transitionVersion).not.toHaveBeenCalled();
  });

  it('allows publishing only when the immutable method matches the server-side binding', async () => {
    const repository = repositoryMock();
    repository.findDefinition.mockResolvedValue({
      definition: { id: '00000000-0000-7000-8000-000000000310' },
      versions: [
        {
          id: '00000000-0000-7000-8000-000000000311',
          adapter: 'HTTP',
          endpointRef: 'crm.read',
          allowedHttpMethods: ['GET'],
          riskClass: 'READ_ONLY',
          idempotencyMode: 'SYSTEM_LEDGER',
        },
      ],
    });
    repository.transitionVersion.mockResolvedValue({
      kind: 'APPLIED',
      value: { definition: { id: '00000000-0000-7000-8000-000000000310' } },
    });
    const service = new ToolGatewayService(
      repository as unknown as ToolGatewayRepository,
      { current: () => PRINCIPAL } as RuntimeIdentityPort,
      config({
        bindings: {
          'crm.read': {
            url: 'https://crm.example.test/customer',
            method: 'GET',
            headers: {},
            signingSecret: 'test-signing-secret',
          },
        },
      }),
    );

    await expect(
      service.transitionVersion(
        '00000000-0000-7000-8000-000000000310',
        '00000000-0000-7000-8000-000000000311',
        {
          action: 'PUBLISH',
          expectedDefinitionRevision: 1,
          reason: 'Publish after runtime verification.',
          idempotencyKey: 'publish-with-endpoint',
        },
      ),
    ).resolves.toMatchObject({
      definition: { id: '00000000-0000-7000-8000-000000000310' },
    });
    expect(repository.transitionVersion).toHaveBeenCalledOnce();
  });

  it('rejects side-effecting publication when only the local ledger claims idempotency', async () => {
    const repository = repositoryMock();
    repository.findDefinition.mockResolvedValue({
      definition: { id: '00000000-0000-7000-8000-000000000310' },
      versions: [
        {
          id: '00000000-0000-7000-8000-000000000311',
          adapter: 'HTTP',
          endpointRef: 'crm.write',
          allowedHttpMethods: ['POST'],
          riskClass: 'CONFIRM_REQUIRED',
          idempotencyMode: 'SYSTEM_LEDGER',
        },
      ],
    });
    const service = new ToolGatewayService(
      repository as unknown as ToolGatewayRepository,
      { current: () => PRINCIPAL } as RuntimeIdentityPort,
      config({
        bindings: {
          'crm.write': {
            url: 'https://crm.example.test/customer',
            method: 'POST',
            headers: {},
            signingSecret: 'test-signing-secret',
          },
        },
      }),
    );

    await expect(
      service.transitionVersion(
        '00000000-0000-7000-8000-000000000310',
        '00000000-0000-7000-8000-000000000311',
        {
          action: 'PUBLISH',
          expectedDefinitionRevision: 1,
          reason: 'Publish a side-effecting integration.',
          idempotencyKey: 'unsafe-ledger-only',
        },
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(repository.transitionVersion).not.toHaveBeenCalled();
  });
});

function repositoryMock() {
  return {
    listAvailableTools: vi.fn(),
    listReviewableInvocations: vi.fn(),
    listDefinitions: vi.fn(),
    findDefinition: vi.fn(),
    createDefinition: vi.fn(),
    createVersion: vi.fn(),
    transitionVersion: vi.fn(),
    listInvocations: vi.fn(),
    findInvocation: vi.fn(),
    createInvocation: vi.fn(),
    createCompensation: vi.fn(),
    decideInvocation: vi.fn(),
  };
}

function config(input?: { workerEnabled?: boolean; bindings?: Record<string, unknown> }) {
  const values = {
    TOOL_EXECUTION_WORKER_ENABLED: input?.workerEnabled ?? true,
    TOOL_ENDPOINT_BINDINGS: input?.bindings ?? {},
  };
  return {
    get: (key: keyof typeof values) => values[key],
  } as never;
}
