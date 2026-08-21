import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { TenantRole } from '@enterprise/contracts';

import { TenantContext, type TenantPrincipal } from '../../common/context/tenant-context.js';

export interface AdminPrincipal extends TenantPrincipal {
  readonly role: TenantRole;
}

const DIRECTORY_READ_ROLES = new Set<TenantRole>(['OWNER', 'ADMIN', 'KNOWLEDGE_ADMIN']);
const DIRECTORY_WRITE_ROLES = new Set<TenantRole>(['OWNER', 'ADMIN']);
const KNOWLEDGE_WRITE_ROLES = DIRECTORY_READ_ROLES;
const AUDIT_READ_ROLES = new Set<TenantRole>(['OWNER', 'ADMIN']);
const AUDIT_EXPORT_ROLES = new Set<TenantRole>(['OWNER']);

@Injectable()
export class AdminAccessService {
  constructor(@Inject(TenantContext) private readonly context: TenantContext) {}

  requireDirectoryRead(): AdminPrincipal {
    return this.requireRole(DIRECTORY_READ_ROLES);
  }

  requireDirectoryWrite(): AdminPrincipal {
    return this.requireRole(DIRECTORY_WRITE_ROLES);
  }

  requireKnowledgeWrite(): AdminPrincipal {
    return this.requireRole(KNOWLEDGE_WRITE_ROLES);
  }

  requireAuditRead(): AdminPrincipal {
    return this.requireRole(AUDIT_READ_ROLES);
  }

  requireAuditExport(): AdminPrincipal {
    return this.requireRole(AUDIT_EXPORT_ROLES);
  }

  assertCanAssignRole(actor: AdminPrincipal, targetRole: TenantRole): void {
    if (targetRole === 'OWNER' && actor.role !== 'OWNER') {
      throw new ForbiddenException('Only an owner can assign the owner role.');
    }
  }

  assertCanManageMember(actor: AdminPrincipal, currentRole: TenantRole): void {
    if (currentRole === 'OWNER' && actor.role !== 'OWNER') {
      throw new ForbiddenException('Only an owner can manage another owner.');
    }
  }

  private requireRole(allowed: ReadonlySet<TenantRole>): AdminPrincipal {
    const principal: AdminPrincipal = this.context.current;
    if (!allowed.has(principal.role)) {
      throw new ForbiddenException('The current account does not have admin access.');
    }
    return principal;
  }
}
