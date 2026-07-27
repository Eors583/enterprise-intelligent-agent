import {
  apiErrorResponseSchema,
  authSessionResponseSchema,
  refreshSessionRequestSchema,
} from '@enterprise/contracts';
import type { ZodType } from 'zod';

import { readSession, writeSession } from '@/auth/session';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export class ApiError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly requestId?: string;

  constructor(
    message: string,
    options: { status?: number; code?: string; requestId?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'ApiError';
    if (options.status !== undefined) this.status = options.status;
    if (options.code !== undefined) this.code = options.code;
    if (options.requestId !== undefined) this.requestId = options.requestId;
  }
}

export function apiUrl(
  path: string,
  base = import.meta.env.VITE_API_BASE_URL ?? '/api/v1',
): string {
  const normalizedBase = base.trim().replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

async function parseError(response: Response): Promise<ApiError> {
  const fallback = `服务请求失败（HTTP ${response.status}）`;
  try {
    const body: unknown = await response.json();
    const parsed = apiErrorResponseSchema.safeParse(body);
    if (parsed.success) {
      return new ApiError(parsed.data.message, {
        status: response.status,
        code: parsed.data.code,
        requestId: parsed.data.request_id,
      });
    }
    if (body && typeof body === 'object') {
      const message = Reflect.get(body, 'message');
      if (typeof message === 'string') return new ApiError(message, { status: response.status });
      if (Array.isArray(message)) {
        return new ApiError(
          message.filter((item): item is string => typeof item === 'string').join('；'),
          {
            status: response.status,
          },
        );
      }
    }
  } catch {
    // Use a stable fallback for non-JSON proxy/server errors.
  }
  const requestId = response.headers.get('x-request-id');
  return new ApiError(fallback, {
    status: response.status,
    ...(requestId ? { requestId } : {}),
  });
}

let refreshInFlight: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  const current = readSession();
  if (!current) return false;

  const payload = refreshSessionRequestSchema.parse({ refreshToken: current.refreshToken });
  let response: Response;
  try {
    response = await fetch(apiUrl('/auth/refresh'), {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    return false;
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) writeSession(null);
    return false;
  }

  try {
    const parsed = authSessionResponseSchema.safeParse(await response.json());
    if (!parsed.success) return false;
    writeSession(parsed.data);
    return true;
  } catch {
    return false;
  }
}

async function refreshOnce(): Promise<boolean> {
  refreshInFlight ??= refreshAccessToken().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

interface RequestOptions<T> {
  method?: Method;
  body?: unknown;
  schema: ZodType<T>;
  signal?: AbortSignal;
  authenticated?: boolean;
}

function isFormDataBody(body: unknown): body is FormData {
  return typeof FormData !== 'undefined' && body instanceof FormData;
}

export async function request<T>(path: string, options: RequestOptions<T>): Promise<T> {
  const authenticated = options.authenticated !== false;

  const execute = async (): Promise<Response> => {
    const session = authenticated ? readSession() : null;
    const body = options.body;
    const multipart = isFormDataBody(body);
    const init: RequestInit = {
      method: options.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        ...(body === undefined || multipart ? {} : { 'Content-Type': 'application/json' }),
        ...(session ? { Authorization: `Bearer ${session.accessToken}` } : {}),
      },
    };
    if (body !== undefined) {
      // The browser must generate the multipart boundary. Setting Content-Type here
      // would produce an invalid upload request.
      init.body = multipart ? body : JSON.stringify(body);
    }
    if (options.signal) init.signal = options.signal;

    try {
      return await fetch(apiUrl(path), init);
    } catch (cause) {
      throw new ApiError('无法连接管理服务，请检查网络或服务是否已启动。', { cause });
    }
  };

  let response = await execute();
  if (authenticated && response.status === 401 && (await refreshOnce())) response = await execute();
  if (!response.ok) {
    const error = await parseError(response);
    if (authenticated && error.status === 401) writeSession(null);
    throw error;
  }

  let value: unknown;
  if (response.status === 204) value = undefined;
  else {
    try {
      value = await response.json();
    } catch (cause) {
      throw new ApiError('服务响应不是有效的 JSON。', { cause });
    }
  }
  const parsed = options.schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError('服务响应与客户端契约不一致，请联系管理员升级服务。', {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

export function messageFromError(error: unknown): string {
  if (error instanceof ApiError && error.requestId) {
    return `${error.message}（请求 ID：${error.requestId}）`;
  }
  return error instanceof Error ? error.message : '操作失败，请稍后重试。';
}
