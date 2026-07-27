import type {
  FeishuDirectoryDepartment,
  FeishuDirectorySnapshot,
} from './feishu-directory.models.js';

export const FEISHU_ROOT_DEPARTMENT_ID = '0';

export class InvalidFeishuSnapshotError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'InvalidFeishuSnapshotError';
  }
}

/** Validates provider data and returns departments in parent-before-child order. */
export function validateFeishuDirectorySnapshot(
  snapshot: FeishuDirectorySnapshot,
): FeishuDirectorySnapshot {
  const departmentById = new Map<string, FeishuDirectoryDepartment>();
  for (const department of snapshot.departments) {
    assertBoundedText(department.externalId, 200, 'DEPARTMENT_ID_INVALID');
    assertBoundedText(department.name, 200, 'DEPARTMENT_NAME_INVALID');
    if (department.externalId === FEISHU_ROOT_DEPARTMENT_ID) continue;
    if (departmentById.has(department.externalId)) {
      throw new InvalidFeishuSnapshotError('DEPARTMENT_DUPLICATE');
    }
    if (
      department.sortOrder !== undefined &&
      (!Number.isSafeInteger(department.sortOrder) ||
        department.sortOrder < -2_147_483_648 ||
        department.sortOrder > 2_147_483_647)
    ) {
      throw new InvalidFeishuSnapshotError('DEPARTMENT_SORT_INVALID');
    }
    departmentById.set(department.externalId, department);
  }

  for (const department of departmentById.values()) {
    const parent = department.parentExternalId ?? FEISHU_ROOT_DEPARTMENT_ID;
    assertBoundedText(parent, 200, 'DEPARTMENT_PARENT_INVALID');
    if (parent !== FEISHU_ROOT_DEPARTMENT_ID && !departmentById.has(parent)) {
      throw new InvalidFeishuSnapshotError('DEPARTMENT_PARENT_MISSING');
    }
  }

  const orderedDepartments: FeishuDirectoryDepartment[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (department: FeishuDirectoryDepartment): void => {
    if (visited.has(department.externalId)) return;
    if (visiting.has(department.externalId)) {
      throw new InvalidFeishuSnapshotError('DEPARTMENT_CYCLE');
    }
    visiting.add(department.externalId);
    const parentId = department.parentExternalId ?? FEISHU_ROOT_DEPARTMENT_ID;
    const parent = departmentById.get(parentId);
    if (parent !== undefined) visit(parent);
    visiting.delete(department.externalId);
    visited.add(department.externalId);
    orderedDepartments.push(department);
  };
  for (const department of departmentById.values()) visit(department);

  const userIds = new Set<string>();
  for (const user of snapshot.users) {
    assertBoundedText(user.externalId, 200, 'USER_ID_INVALID');
    assertBoundedText(user.name, 120, 'USER_NAME_INVALID');
    if (userIds.has(user.externalId)) throw new InvalidFeishuSnapshotError('USER_DUPLICATE');
    userIds.add(user.externalId);
    if (user.employeeNumber !== undefined) {
      assertBoundedText(user.employeeNumber, 255, 'USER_EMPLOYEE_NUMBER_INVALID');
    }
    if (user.jobTitle !== undefined) {
      assertBoundedText(user.jobTitle, 200, 'USER_TITLE_INVALID');
    }
    for (const departmentId of user.departmentExternalIds) {
      assertBoundedText(departmentId, 200, 'USER_DEPARTMENT_INVALID');
      if (departmentId !== FEISHU_ROOT_DEPARTMENT_ID && !departmentById.has(departmentId)) {
        throw new InvalidFeishuSnapshotError('USER_DEPARTMENT_MISSING');
      }
    }
  }

  return { departments: orderedDepartments, users: snapshot.users };
}

function assertBoundedText(value: string, maximum: number, code: string): void {
  if (value.trim().length === 0 || value.length > maximum || value.includes('\u0000')) {
    throw new InvalidFeishuSnapshotError(code);
  }
}
