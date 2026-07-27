import type { Department, DirectoryMember } from './directory.models.js';

export abstract class DirectoryRepository {
  abstract listDepartments(tenantId: string): Promise<readonly Department[]>;
  abstract listMembers(tenantId: string): Promise<readonly DirectoryMember[]>;
}
