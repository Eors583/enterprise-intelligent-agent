export interface Tenant {
  readonly id: string;
  readonly name: string;
  readonly status: 'active' | 'suspended' | 'archived';
}

export interface User {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly title?: string;
  readonly avatarUrl?: string;
  readonly status: 'active' | 'inactive';
}
