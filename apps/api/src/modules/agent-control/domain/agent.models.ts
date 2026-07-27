export interface MemberAgent {
  readonly id: string;
  readonly tenantId: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly status: 'online' | 'offline' | 'disabled';
  readonly versionStatus: 'draft' | 'published' | 'retired';
  readonly visibility: 'tenant' | 'owner';
  readonly summary?: string;
}
