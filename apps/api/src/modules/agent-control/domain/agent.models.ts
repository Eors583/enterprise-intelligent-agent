export interface MemberAgent {
  readonly id: string;
  readonly tenantId: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly status: 'online' | 'offline' | 'disabled';
  readonly versionStatus: 'draft' | 'testing' | 'published' | 'retired';
  readonly visibility: 'tenant' | 'owner';
  readonly assignedToPrincipal: boolean;
  readonly requiresActiveAssignment: boolean;
  readonly summary?: string;
}
