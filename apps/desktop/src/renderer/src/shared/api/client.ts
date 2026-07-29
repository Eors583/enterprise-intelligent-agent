import type { ZodType } from 'zod';

export type ApiClientErrorKind =
  'configuration' | 'network' | 'http' | 'contract' | 'stale-account';

export class ApiClientError extends Error {
  readonly kind: ApiClientErrorKind;
  readonly requestId?: string;
  readonly status?: number;

  constructor(
    kind: ApiClientErrorKind,
    message: string,
    options: {
      requestId?: string | undefined;
      status?: number | undefined;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'ApiClientError';
    this.kind = kind;
    if (options.requestId !== undefined) this.requestId = options.requestId;
    if (options.status !== undefined) this.status = options.status;
  }
}

let expectedDesktopSessionId: string | null = null;

export function setExpectedDesktopSessionId(sessionId: string | null): void {
  expectedDesktopSessionId = sessionId;
}

export function getExpectedDesktopSessionId(): string | null {
  return expectedDesktopSessionId;
}

interface ApiRequestOptions<T> {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  headers?: Readonly<Record<string, string>>;
  schema: ZodType<T>;
  signal?: AbortSignal;
  apiBaseUrl?: string;
}

function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function apiEndpoint(path: string, apiBaseUrl = import.meta.env.VITE_API_BASE_URL): string {
  const configuredBaseUrl = apiBaseUrl?.trim();
  if (!configuredBaseUrl) {
    throw new ApiClientError(
      'configuration',
      '未配置桌面端 API 地址。请设置 VITE_API_BASE_URL 后重新启动应用。',
    );
  }

  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(configuredBaseUrl);
  } catch (cause) {
    throw new ApiClientError('configuration', 'VITE_API_BASE_URL 不是有效 URL。', { cause });
  }

  if (parsedBaseUrl.protocol !== 'http:' && parsedBaseUrl.protocol !== 'https:') {
    throw new ApiClientError('configuration', 'API 地址只允许使用 HTTP 或 HTTPS 协议。');
  }

  if (parsedBaseUrl.protocol === 'http:' && !isLocalHostname(parsedBaseUrl.hostname)) {
    throw new ApiClientError('configuration', '非本机 API 地址必须使用 HTTPS。');
  }

  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${configuredBaseUrl.replace(/\/+$/, '')}${normalizedPath}`;
}

async function responseErrorMessage(response: Response): Promise<string | undefined> {
  try {
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object') return undefined;
    const message = Reflect.get(value, 'message');
    return typeof message === 'string' && message.trim() ? message.trim().slice(0, 500) : undefined;
  } catch {
    return undefined;
  }
}

function responseBodyErrorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const message = Reflect.get(value, 'message');
  return typeof message === 'string' && message.trim() ? message.trim().slice(0, 500) : undefined;
}

export async function apiRequest<T>(path: string, options: ApiRequestOptions<T>): Promise<T> {
  const canUseDesktopProxy =
    options.apiBaseUrl === undefined && typeof window.enterpriseDesktop?.apiRequest === 'function';
  if (canUseDesktopProxy) {
    if (options.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    let response;
    if (expectedDesktopSessionId === null) {
      throw new ApiClientError('configuration', 'The desktop account context is not ready.');
    }
    try {
      response = await window.enterpriseDesktop.apiRequest({
        path,
        method: options.method ?? 'GET',
        expectedSessionId: expectedDesktopSessionId,
        ...(options.body === undefined ? {} : { body: options.body }),
      });
    } catch (cause) {
      if (cause instanceof Error && cause.message.includes('STALE_ACCOUNT:')) {
        throw new ApiClientError('stale-account', 'The active desktop account changed.', {
          cause,
        });
      }
      if (
        cause instanceof Error &&
        cause.message.includes('The requested desktop API operation is not allowed.')
      ) {
        throw new ApiClientError(
          'configuration',
          '桌面客户端尚未启用该操作，请重启或更新客户端。',
          { cause },
        );
      }
      throw new ApiClientError('network', '无法连接企业服务，请检查网络或稍后重试。', {
        cause,
      });
    }
    if (options.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    if (response.status < 200 || response.status >= 300) {
      throw new ApiClientError(
        'http',
        responseBodyErrorMessage(response.body) ??
          `企业服务返回 HTTP ${response.status}，请稍后重试。`,
        {
          ...(response.requestId === undefined ? {} : { requestId: response.requestId }),
          status: response.status,
        },
      );
    }
    const parsed = options.schema.safeParse(response.body);
    if (!parsed.success) {
      throw new ApiClientError('contract', '企业服务响应不符合客户端契约。', {
        ...(response.requestId === undefined ? {} : { requestId: response.requestId }),
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  const endpoint = apiEndpoint(path, options.apiBaseUrl);
  const request: RequestInit = {
    method: options.method ?? 'GET',
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...options.headers,
    },
  };
  if (options.signal) request.signal = options.signal;
  if (options.body !== undefined) request.body = JSON.stringify(options.body);

  let response: Response;
  try {
    response = await fetch(endpoint, request);
  } catch (cause) {
    if (cause instanceof ApiClientError) throw cause;
    throw new ApiClientError('network', '无法连接企业服务，请检查网络或稍后重试。', { cause });
  }

  const requestId = response.headers.get('x-request-id') ?? undefined;
  if (!response.ok) {
    const serverMessage = await responseErrorMessage(response);
    throw new ApiClientError(
      'http',
      serverMessage ?? `企业服务返回 HTTP ${response.status}，请稍后重试。`,
      { requestId, status: response.status },
    );
  }

  let value: unknown;
  try {
    value = await response.json();
  } catch (cause) {
    throw new ApiClientError('contract', '企业服务返回的不是有效 JSON。', {
      requestId,
      cause,
    });
  }

  const parsed = options.schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiClientError('contract', '企业服务响应不符合客户端契约。', {
      requestId,
      cause: parsed.error,
    });
  }

  return parsed.data;
}
