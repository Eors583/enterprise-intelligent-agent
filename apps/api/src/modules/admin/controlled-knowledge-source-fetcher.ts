import type { IncomingMessage } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { knowledgeSourceManifestSchema, type KnowledgeSourceManifest } from '@enterprise/contracts';

import type { EnvironmentVariables } from '../../config/environment.js';
import { isPublicAddress } from '../knowledge-ingestion/infrastructure/controlled-knowledge-web-fetcher.js';

const MAXIMUM_RESOLVED_ADDRESSES = 16;

export type KnowledgeSourceFetchErrorCode =
  | 'KNOWLEDGE_SOURCE_URL_INVALID'
  | 'KNOWLEDGE_SOURCE_HOST_NOT_ALLOWED'
  | 'KNOWLEDGE_SOURCE_DNS_UNAVAILABLE'
  | 'KNOWLEDGE_SOURCE_ADDRESS_FORBIDDEN'
  | 'KNOWLEDGE_SOURCE_REDIRECT_FORBIDDEN'
  | 'KNOWLEDGE_SOURCE_FETCH_FAILED'
  | 'KNOWLEDGE_SOURCE_FETCH_TIMEOUT'
  | 'KNOWLEDGE_SOURCE_RESPONSE_TOO_LARGE'
  | 'KNOWLEDGE_SOURCE_MANIFEST_INVALID'
  | 'KNOWLEDGE_SOURCE_CHECKSUM_MISMATCH';

export class KnowledgeSourceFetchError extends Error {
  constructor(readonly code: KnowledgeSourceFetchErrorCode) {
    super(code);
    this.name = 'KnowledgeSourceFetchError';
  }
}

interface SourceFetchPolicy {
  readonly allowedHosts: readonly string[];
  readonly timeoutMs: number;
  readonly allowLocalFixture: boolean;
}

interface ResolvedSourceUrl {
  readonly url: URL;
  readonly address: string;
  readonly family: 4 | 6;
  readonly localFixture: boolean;
}

@Injectable()
export class ControlledKnowledgeSourceFetcher {
  constructor(private readonly config: ConfigService<EnvironmentVariables, true>) {}

  assertAllowedUrl(value: string): void {
    validateSourceUrl(value, this.policy());
  }

  async fetchManifest(
    manifestUrl: string,
    cursor: string | null,
  ): Promise<KnowledgeSourceManifest> {
    const url = new URL(manifestUrl);
    if (cursor !== null) url.searchParams.set('cursor', cursor);
    const bytes = await fetchControlledBytes(
      url.toString(),
      this.policy(),
      this.config.get('KNOWLEDGE_SOURCE_SYNC_MANIFEST_MAX_BYTES', { infer: true }),
      'application/json',
    );
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new KnowledgeSourceFetchError('KNOWLEDGE_SOURCE_MANIFEST_INVALID');
    }
    const parsed = knowledgeSourceManifestSchema.safeParse(value);
    if (!parsed.success) {
      throw new KnowledgeSourceFetchError('KNOWLEDGE_SOURCE_MANIFEST_INVALID');
    }
    return parsed.data;
  }

  fetchFile(downloadUrl: string): Promise<Buffer> {
    return fetchControlledBytes(
      downloadUrl,
      this.policy(),
      this.config.get('KNOWLEDGE_OBJECT_STORE_MAX_BYTES', { infer: true }),
      null,
    );
  }

  get maximumPages(): number {
    return this.config.get('KNOWLEDGE_SOURCE_SYNC_MAX_PAGES', { infer: true });
  }

  private policy(): SourceFetchPolicy {
    return {
      allowedHosts: this.config.get('KNOWLEDGE_SOURCE_SYNC_ALLOWED_HOSTS', { infer: true }),
      timeoutMs: this.config.get('KNOWLEDGE_SOURCE_SYNC_TIMEOUT_MS', { infer: true }),
      allowLocalFixture: this.config.get('KNOWLEDGE_SOURCE_SYNC_ALLOW_LOCAL_FIXTURE', {
        infer: true,
      }),
    };
  }
}

export async function fetchControlledBytes(
  sourceUrl: string,
  policy: SourceFetchPolicy,
  maximumBytes: number,
  requiredMimeType: string | null,
): Promise<Buffer> {
  const resolved = await resolveSourceUrl(sourceUrl, policy);
  return new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    let request: ReturnType<typeof httpsRequest> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const fail = (code: KnowledgeSourceFetchErrorCode): void => {
      if (settled) return;
      settled = true;
      if (deadline !== undefined) clearTimeout(deadline);
      reject(new KnowledgeSourceFetchError(code));
    };
    const succeed = (bytes: Buffer): void => {
      if (settled) return;
      settled = true;
      if (deadline !== undefined) clearTimeout(deadline);
      resolve(bytes);
    };
    const options: RequestOptions = {
      protocol: 'https:',
      hostname: resolved.url.hostname,
      port: resolved.url.port === '' ? 443 : Number(resolved.url.port),
      family: resolved.family,
      path: `${resolved.url.pathname}${resolved.url.search}`,
      method: 'GET',
      agent: false,
      servername: resolved.url.hostname,
      rejectUnauthorized: !resolved.localFixture,
      headers: {
        accept: requiredMimeType ?? '*/*',
        'accept-encoding': 'identity',
        'user-agent': 'EnterpriseKnowledgeSourceSync/1.0',
      },
      lookup: (_hostname, _options, callback) => callback(null, resolved.address, resolved.family),
    };
    try {
      request = httpsRequest(options, (response) => {
        consumeResponse(response, maximumBytes, requiredMimeType, succeed, fail);
      });
    } catch {
      fail('KNOWLEDGE_SOURCE_FETCH_FAILED');
      return;
    }
    deadline = setTimeout(() => {
      request?.destroy();
      fail('KNOWLEDGE_SOURCE_FETCH_TIMEOUT');
    }, policy.timeoutMs);
    deadline.unref();
    request.setTimeout(policy.timeoutMs, () => {
      request?.destroy();
      fail('KNOWLEDGE_SOURCE_FETCH_TIMEOUT');
    });
    request.once('error', () => fail('KNOWLEDGE_SOURCE_FETCH_FAILED'));
    request.end();
  });
}

export function validateSourceUrl(sourceUrl: string, policy: SourceFetchPolicy): URL {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw new KnowledgeSourceFetchError('KNOWLEDGE_SOURCE_URL_INVALID');
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, '');
  const localFixture = isLoopbackHostname(hostname) && policy.allowLocalFixture;
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    hostname.length === 0 ||
    (!localFixture && url.port !== '' && url.port !== '443')
  ) {
    throw new KnowledgeSourceFetchError('KNOWLEDGE_SOURCE_URL_INVALID');
  }
  if (!policy.allowedHosts.includes(hostname)) {
    throw new KnowledgeSourceFetchError('KNOWLEDGE_SOURCE_HOST_NOT_ALLOWED');
  }
  url.hostname = hostname;
  return url;
}

async function resolveSourceUrl(
  sourceUrl: string,
  policy: SourceFetchPolicy,
): Promise<ResolvedSourceUrl> {
  const url = validateSourceUrl(sourceUrl, policy);
  let candidates: Array<{ readonly address: string; readonly family: number }>;
  try {
    candidates = await dnsLookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new KnowledgeSourceFetchError('KNOWLEDGE_SOURCE_DNS_UNAVAILABLE');
  }
  if (candidates.length === 0 || candidates.length > MAXIMUM_RESOLVED_ADDRESSES) {
    throw new KnowledgeSourceFetchError('KNOWLEDGE_SOURCE_DNS_UNAVAILABLE');
  }
  const localFixture = isLoopbackHostname(url.hostname) && policy.allowLocalFixture;
  for (const candidate of candidates) {
    const valid = localFixture
      ? isLoopbackAddress(candidate.address)
      : isPublicAddress(candidate.address, candidate.family);
    if (!valid) throw new KnowledgeSourceFetchError('KNOWLEDGE_SOURCE_ADDRESS_FORBIDDEN');
  }
  // Most local HTTPS fixtures bind IPv4 only while Windows resolves localhost
  // to ::1 first. Prefer a verified IPv4 loopback in this explicitly gated
  // development mode; production/public hosts keep the resolver order.
  const selected = localFixture
    ? (candidates.find((candidate) => candidate.family === 4) ?? candidates[0])
    : candidates[0];
  if (selected === undefined || (selected.family !== 4 && selected.family !== 6)) {
    throw new KnowledgeSourceFetchError('KNOWLEDGE_SOURCE_DNS_UNAVAILABLE');
  }
  return { url, address: selected.address, family: selected.family, localFixture };
}

function consumeResponse(
  response: IncomingMessage,
  maximumBytes: number,
  requiredMimeType: string | null,
  resolve: (bytes: Buffer) => void,
  fail: (code: KnowledgeSourceFetchErrorCode) => void,
): void {
  const statusCode = response.statusCode ?? 0;
  if (statusCode >= 300 && statusCode < 400) {
    response.destroy();
    fail('KNOWLEDGE_SOURCE_REDIRECT_FORBIDDEN');
    return;
  }
  if (statusCode !== 200) {
    response.destroy();
    fail('KNOWLEDGE_SOURCE_FETCH_FAILED');
    return;
  }
  const contentEncoding = String(response.headers['content-encoding'] ?? 'identity')
    .trim()
    .toLowerCase();
  const contentType = String(response.headers['content-type'] ?? '')
    .split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  if (
    (contentEncoding !== '' && contentEncoding !== 'identity') ||
    (requiredMimeType !== null && contentType !== requiredMimeType)
  ) {
    response.destroy();
    fail('KNOWLEDGE_SOURCE_FETCH_FAILED');
    return;
  }
  const declaredHeader = response.headers['content-length'];
  const declared = Number(declaredHeader);
  if (
    declaredHeader !== undefined &&
    (!/^(?:0|[1-9]\d*)$/u.test(String(declaredHeader)) ||
      !Number.isSafeInteger(declared) ||
      declared < 0 ||
      declared > maximumBytes)
  ) {
    response.destroy();
    fail('KNOWLEDGE_SOURCE_RESPONSE_TOO_LARGE');
    return;
  }
  const chunks: Buffer[] = [];
  let received = 0;
  response.on('data', (chunk: unknown) => {
    if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
      response.destroy();
      fail('KNOWLEDGE_SOURCE_FETCH_FAILED');
      return;
    }
    const bytes = Buffer.from(chunk);
    received += bytes.byteLength;
    if (received > maximumBytes) {
      response.destroy();
      fail('KNOWLEDGE_SOURCE_RESPONSE_TOO_LARGE');
      return;
    }
    chunks.push(bytes);
  });
  response.once('end', () => {
    if (received === 0) {
      fail('KNOWLEDGE_SOURCE_FETCH_FAILED');
      return;
    }
    resolve(Buffer.concat(chunks, received));
  });
  response.once('error', () => fail('KNOWLEDGE_SOURCE_FETCH_FAILED'));
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function isLoopbackAddress(address: string): boolean {
  return address === '::1' || /^127\./u.test(address);
}
