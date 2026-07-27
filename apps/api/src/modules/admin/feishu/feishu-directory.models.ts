export interface FeishuDirectoryDepartment {
  readonly externalId: string;
  readonly name: string;
  readonly parentExternalId: string | null;
  readonly sortOrder?: number;
}

export interface FeishuDirectoryUser {
  readonly externalId: string;
  readonly openId?: string;
  readonly unionId?: string;
  readonly name: string;
  readonly email?: string;
  readonly avatarUrl?: string;
  readonly active: boolean;
  readonly departmentExternalIds: readonly string[];
  readonly primaryDepartmentExternalId?: string;
  readonly employeeNumber?: string;
  readonly jobTitle?: string;
}

export interface FeishuDirectorySnapshot {
  readonly departments: readonly FeishuDirectoryDepartment[];
  readonly users: readonly FeishuDirectoryUser[];
}

export type FeishuDirectoryErrorCode =
  | 'FEISHU_NOT_CONFIGURED'
  | 'FEISHU_TIMEOUT'
  | 'FEISHU_NETWORK_ERROR'
  | 'FEISHU_INVALID_RESPONSE'
  | 'FEISHU_REQUIRED_FIELD_MISSING'
  | 'FEISHU_PAGINATION_INVALID'
  | `FEISHU_HTTP_${number}`
  | `FEISHU_API_${number}`;

/**
 * A deliberately redacted provider error. `code` and `providerCode` are safe
 * to expose to an administrator; provider response bodies and credentials are
 * never retained on the error.
 */
export class FeishuDirectoryError extends Error {
  override readonly name = 'FeishuDirectoryError';

  constructor(
    readonly code: FeishuDirectoryErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly providerCode?: number,
    readonly httpStatus?: number,
  ) {
    super(message);
  }
}
