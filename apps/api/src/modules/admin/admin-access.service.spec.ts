import { ForbiddenException } from '@nestjs/common';
import type { TenantRole } from '@enterprise/contracts';
import { describe, expect, it } from 'vitest';

import { TenantContext } from '../../common/context/tenant-context.js';
import { AdminAccessService } from './admin-access.service.js';

describe('AdminAccessService', () => {
  it.each<TenantRole>(['OWNER', 'ADMIN', 'KNOWLEDGE_ADMIN'])(
    'allows %s to manage knowledge',
    (role) => {
      expect(createService(role).requireKnowledgeWrite().role).toBe(role);
    },
  );

  it('allows a knowledge admin to read the directory but not mutate it', () => {
    const service = createService('KNOWLEDGE_ADMIN');

    expect(service.requireDirectoryRead().role).toBe('KNOWLEDGE_ADMIN');
    expect(() => service.requireDirectoryWrite()).toThrow(ForbiddenException);
  });

  it('rejects a regular member from every admin surface', () => {
    const service = createService('MEMBER');

    expect(() => service.requireDirectoryRead()).toThrow(ForbiddenException);
    expect(() => service.requireDirectoryWrite()).toThrow(ForbiddenException);
    expect(() => service.requireKnowledgeWrite()).toThrow(ForbiddenException);
  });

  it('only permits an owner to grant the owner role', () => {
    const admin = createService('ADMIN');
    const owner = createService('OWNER');

    expect(() => admin.assertCanAssignRole(admin.requireDirectoryWrite(), 'OWNER')).toThrow(
      ForbiddenException,
    );
    expect(() => owner.assertCanAssignRole(owner.requireDirectoryWrite(), 'OWNER')).not.toThrow();
  });

  it('prevents an administrator from managing an owner account', () => {
    const admin = createService('ADMIN');
    const owner = createService('OWNER');

    expect(() => admin.assertCanManageMember(admin.requireDirectoryWrite(), 'OWNER')).toThrow(
      ForbiddenException,
    );
    expect(() => admin.assertCanManageMember(admin.requireDirectoryWrite(), 'ADMIN')).not.toThrow();
    expect(() => owner.assertCanManageMember(owner.requireDirectoryWrite(), 'OWNER')).not.toThrow();
  });
});

function createService(role: TenantRole): AdminAccessService {
  const context = {
    current: {
      tenantId: '00000000-0000-7000-8000-000000000001',
      userId: '00000000-0000-7000-8000-000000000101',
      role,
      authenticationSource: 'session' as const,
    },
  } as TenantContext;
  return new AdminAccessService(context);
}
