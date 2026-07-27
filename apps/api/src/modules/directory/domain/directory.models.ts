export interface Department {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly memberCount: number;
}

export interface DirectoryMember {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly title: string;
  readonly departmentIds: readonly string[];
  readonly avatarUrl?: string;
  readonly status: 'active' | 'inactive';
}
