import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac } from 'node:crypto';
import { request as httpsRequest, type RequestOptions } from 'node:https';

import type { EnvironmentVariables } from '../../../../config/environment.js';
import {
  ToolProviderDispatcherPort,
  type ToolProviderRequest,
  type ToolProviderResult,
} from '../../tool-execution.port.js';

@Injectable()
export class PinnedHttpToolProviderDispatcher extends ToolProviderDispatcherPort {
  private readonly maxResponseBytes: number;

  constructor(@Inject(ConfigService) config: ConfigService<EnvironmentVariables, true>) {
    super();
    this.maxResponseBytes = config.get('TOOL_PROVIDER_MAX_RESPONSE_BYTES', {
      infer: true,
    });
  }

  dispatch(request: ToolProviderRequest): Promise<ToolProviderResult> {
    const startedAt = new Date();
    if (request.target === null) {
      return Promise.resolve(
        failure(
          request.providerRequestId,
          startedAt,
          'FAILED',
          'TOOL_HTTP_TARGET_MISSING',
          'HTTP provider dispatch requires a validated pinned target.',
        ),
      );
    }

    let requestBody: Buffer;
    let normalizedUrl: URL;
    try {
      normalizedUrl = new URL(request.target.normalizedUrl);
      requestBody =
        request.endpoint.method === 'GET'
          ? Buffer.alloc(0)
          : Buffer.from(JSON.stringify(request.input), 'utf8');
      if (request.endpoint.method === 'GET') {
        appendQueryInput(normalizedUrl, request.input);
      }
    } catch {
      return Promise.resolve(
        failure(
          request.providerRequestId,
          startedAt,
          'FAILED',
          'TOOL_PROVIDER_REQUEST_INVALID',
          'The provider request could not be serialized safely.',
        ),
      );
    }

    const timestamp = startedAt.toISOString();
    const path = `${normalizedUrl.pathname}${normalizedUrl.search}`;
    const headers = buildToolProviderHeaders(request, requestBody, timestamp, path);
    const options = buildPinnedHttpRequestOptions(request, path, headers);

    return new Promise((resolve) => {
      let settled = false;
      let requestFinished = false;
      let responseStarted = false;
      const finish = (result: ToolProviderResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const outbound = httpsRequest(options, (response) => {
        responseStarted = true;
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        response.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buffer.length;
          if (totalBytes > this.maxResponseBytes) {
            response.destroy(new Error('TOOL_PROVIDER_RESPONSE_TOO_LARGE'));
            return;
          }
          chunks.push(buffer);
        });
        response.on('end', () => {
          const completedAt = new Date();
          const statusCode = response.statusCode ?? 0;
          const cost = parseProviderCost(response.headers['x-enterprise-cost-micros']);
          if (cost === null) {
            finish(
              failure(
                request.providerRequestId,
                startedAt,
                'UNKNOWN',
                'TOOL_PROVIDER_RECEIPT_INVALID',
                'Provider returned a malformed or ambiguous cost attestation.',
                completedAt,
              ),
            );
            return;
          }
          if (statusCode >= 300 && statusCode < 400) {
            finish(
              failure(
                request.providerRequestId,
                startedAt,
                'UNKNOWN',
                'TOOL_PROVIDER_REDIRECT_REJECTED',
                'Provider redirects are not followed; reconcile the external outcome.',
                completedAt,
                cost,
              ),
            );
            return;
          }
          if (statusCode < 200 || statusCode >= 300) {
            finish(
              failure(
                request.providerRequestId,
                startedAt,
                'FAILED',
                httpErrorCode(statusCode),
                `Provider returned HTTP ${statusCode || 'unknown'}.`,
                completedAt,
                cost,
              ),
            );
            return;
          }
          let output: unknown;
          try {
            output = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            finish(
              failure(
                request.providerRequestId,
                startedAt,
                'UNKNOWN',
                'TOOL_PROVIDER_RESPONSE_INVALID',
                'Provider returned an invalid JSON response; reconcile before retry.',
                completedAt,
                cost,
              ),
            );
            return;
          }
          if (!isRecord(output)) {
            finish(
              failure(
                request.providerRequestId,
                startedAt,
                'UNKNOWN',
                'TOOL_PROVIDER_RESPONSE_INVALID',
                'Provider response must be a JSON object; reconcile before retry.',
                completedAt,
                cost,
              ),
            );
            return;
          }
          finish({
            providerRequestId: request.providerRequestId,
            outcome: 'SUCCEEDED',
            output,
            errorCode: null,
            errorDetail: null,
            startedAt,
            completedAt,
            cost,
          });
        });
        response.on('error', (error) => {
          finish(
            transportFailure(
              request.providerRequestId,
              startedAt,
              error,
              requestFinished || responseStarted,
            ),
          );
        });
      });
      outbound.setTimeout(request.timeoutMs, () => {
        outbound.destroy(new Error('TOOL_PROVIDER_TIMEOUT'));
      });
      outbound.on('finish', () => {
        requestFinished = true;
      });
      outbound.on('error', (error) => {
        finish(
          transportFailure(
            request.providerRequestId,
            startedAt,
            error,
            requestFinished || responseStarted,
          ),
        );
      });
      if (requestBody.length > 0) outbound.write(requestBody);
      outbound.end();
    });
  }
}

export function buildToolProviderHeaders(
  request: ToolProviderRequest,
  requestBody: Buffer,
  timestamp: string,
  path: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    ...request.endpoint.headers,
    host: request.target?.hostname ?? '',
    accept: 'application/json',
    'user-agent': 'enterprise-agent-tool-gateway/1',
    'idempotency-key': request.idempotencyKey,
    'x-enterprise-invocation-id': request.invocationId,
    'x-enterprise-provider-request-id': request.providerRequestId,
    'x-enterprise-tenant-id': request.tenantId,
    'x-enterprise-user-id': request.requesterUserId,
    'x-enterprise-role-assignment-id': request.roleAssignmentId,
    'x-enterprise-task-id': request.taskId,
    'x-enterprise-correlation-id': request.correlationId,
    'x-enterprise-dry-run': String(request.providerDryRun),
    'x-enterprise-timestamp': timestamp,
  };
  if (requestBody.length > 0) {
    headers['content-type'] = 'application/json; charset=utf-8';
    headers['content-length'] = String(requestBody.length);
  }
  if (request.endpoint.signingSecret !== null) {
    const bodyHash = createHash('sha256').update(requestBody).digest('hex');
    const canonical = [
      'v1',
      timestamp,
      request.endpoint.method,
      path,
      request.invocationId,
      request.providerRequestId,
      request.tenantId,
      request.requesterUserId,
      request.roleAssignmentId,
      request.taskId,
      bodyHash,
    ].join('\n');
    headers['x-enterprise-signature-version'] = 'v1';
    headers['x-enterprise-signature'] = createHmac('sha256', request.endpoint.signingSecret)
      .update(canonical)
      .digest('hex');
  }
  return headers;
}

export function buildPinnedHttpRequestOptions(
  request: ToolProviderRequest,
  path: string,
  headers: Readonly<Record<string, string>>,
): RequestOptions {
  if (request.target === null) throw new Error('Pinned target is required.');
  return {
    protocol: 'https:',
    hostname: request.target.pinnedIpAddress,
    port: 443,
    path,
    method: request.endpoint.method,
    servername: request.target.tlsServerName,
    rejectUnauthorized: true,
    headers,
    agent: false,
  };
}

function appendQueryInput(url: URL, input: Readonly<Record<string, unknown>>): void {
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      url.searchParams.append(key, String(value));
      continue;
    }
    if (
      Array.isArray(value) &&
      value.every(
        (item) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean',
      )
    ) {
      for (const item of value) url.searchParams.append(key, String(item));
      continue;
    }
    throw new Error('GET tool input must contain only scalar values or scalar arrays.');
  }
}

function transportFailure(
  providerRequestId: string,
  startedAt: Date,
  error: Error,
  deliveryMayHaveOccurred: boolean,
): ToolProviderResult {
  const timeout = error.message === 'TOOL_PROVIDER_TIMEOUT';
  const tooLarge = error.message === 'TOOL_PROVIDER_RESPONSE_TOO_LARGE';
  const outcome = deliveryMayHaveOccurred || tooLarge ? 'UNKNOWN' : 'FAILED';
  const code = tooLarge
    ? 'TOOL_PROVIDER_RESPONSE_TOO_LARGE'
    : timeout
      ? 'TOOL_PROVIDER_TIMEOUT'
      : outcome === 'UNKNOWN'
        ? 'TOOL_PROVIDER_DELIVERY_UNKNOWN'
        : 'TOOL_PROVIDER_CONNECT_FAILED';
  return failure(
    providerRequestId,
    startedAt,
    outcome,
    code,
    outcome === 'UNKNOWN'
      ? 'Provider delivery could not be proven; reconcile before retry.'
      : 'Provider connection failed before delivery.',
  );
}

function failure(
  providerRequestId: string,
  startedAt: Date,
  outcome: 'FAILED' | 'UNKNOWN',
  errorCode: string,
  errorDetail: string,
  completedAt = new Date(),
  cost: ToolProviderResult['cost'] = { kind: 'UNATTESTED' },
): ToolProviderResult {
  return {
    providerRequestId,
    outcome,
    output: null,
    errorCode,
    errorDetail,
    startedAt,
    completedAt,
    cost,
  };
}

/**
 * Cost is accepted only from one canonical response header on the already
 * pinned TLS channel. No header means explicitly unattested, never zero.
 */
export function parseProviderCost(
  value: string | readonly string[] | undefined,
): ToolProviderResult['cost'] | null {
  if (value === undefined) return { kind: 'UNATTESTED' };
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,18})$/u.test(value)) return null;
  const costMicros = BigInt(value);
  return costMicros <= 9_223_372_036_854_775_807n
    ? { kind: 'PROVIDER_ATTESTED', costMicros }
    : null;
}

function httpErrorCode(statusCode: number): string {
  return Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599
    ? `TOOL_PROVIDER_HTTP_${statusCode}`
    : 'TOOL_PROVIDER_HTTP_ERROR';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
