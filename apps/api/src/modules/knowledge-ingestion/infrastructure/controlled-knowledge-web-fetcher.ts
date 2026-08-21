import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

import type { EnvironmentVariables } from '../../../config/environment.js';

const ALLOWED_CONTENT_TYPES = new Set(['text/html', 'application/xhtml+xml']);
const MAXIMUM_RESOLVED_ADDRESSES = 16;
const PRIVATE_ADDRESSES = createPrivateAddressBlockList();

export type KnowledgeWebFetchErrorCode =
  | 'KNOWLEDGE_WEB_URL_INVALID'
  | 'KNOWLEDGE_WEB_HOST_NOT_ALLOWED'
  | 'KNOWLEDGE_WEB_DNS_UNAVAILABLE'
  | 'KNOWLEDGE_WEB_ADDRESS_FORBIDDEN'
  | 'KNOWLEDGE_WEB_REDIRECT_FORBIDDEN'
  | 'KNOWLEDGE_WEB_FETCH_FAILED'
  | 'KNOWLEDGE_WEB_FETCH_TIMEOUT'
  | 'KNOWLEDGE_WEB_RESPONSE_TOO_LARGE'
  | 'KNOWLEDGE_WEB_CONTENT_TYPE_FORBIDDEN';

export class KnowledgeWebFetchError extends Error {
  constructor(readonly code: KnowledgeWebFetchErrorCode) {
    super(code);
    this.name = 'KnowledgeWebFetchError';
  }
}

export interface ControlledKnowledgeWebPage {
  readonly sourceUri: string;
  readonly bytes: Buffer;
  readonly mimeType: 'text/html' | 'application/xhtml+xml';
}

interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

interface KnowledgeWebFetchDependencies {
  readonly resolve: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  readonly request: (
    options: RequestOptions,
    onResponse: (response: IncomingMessage) => void,
  ) => ReturnType<typeof httpsRequest>;
}

export interface KnowledgeWebFetchPolicy {
  readonly allowedHosts: readonly string[];
  readonly timeoutMs: number;
  readonly maximumBytes: number;
}

const DEFAULT_DEPENDENCIES: KnowledgeWebFetchDependencies = {
  resolve: (hostname) => dnsLookup(hostname, { all: true, verbatim: true }),
  request: httpsRequest,
};

@Injectable()
export class ControlledKnowledgeWebFetcher {
  constructor(private readonly config: ConfigService<EnvironmentVariables, true>) {}

  fetch(sourceUri: string): Promise<ControlledKnowledgeWebPage> {
    return fetchControlledKnowledgeWebPage(
      sourceUri,
      {
        allowedHosts: this.config.get('KNOWLEDGE_WEB_IMPORT_ALLOWED_HOSTS', { infer: true }),
        timeoutMs: this.config.get('KNOWLEDGE_WEB_IMPORT_TIMEOUT_MS', { infer: true }),
        maximumBytes: this.config.get('KNOWLEDGE_WEB_IMPORT_MAX_BYTES', { infer: true }),
      },
      DEFAULT_DEPENDENCIES,
    );
  }
}

export async function fetchControlledKnowledgeWebPage(
  sourceUri: string,
  policy: KnowledgeWebFetchPolicy,
  dependencies: KnowledgeWebFetchDependencies = DEFAULT_DEPENDENCIES,
): Promise<ControlledKnowledgeWebPage> {
  const url = validateKnowledgeWebUrl(sourceUri, policy.allowedHosts);
  let resolved: readonly ResolvedAddress[];
  try {
    resolved = await dependencies.resolve(url.hostname);
  } catch {
    throw new KnowledgeWebFetchError('KNOWLEDGE_WEB_DNS_UNAVAILABLE');
  }
  if (resolved.length === 0 || resolved.length > MAXIMUM_RESOLVED_ADDRESSES) {
    throw new KnowledgeWebFetchError('KNOWLEDGE_WEB_DNS_UNAVAILABLE');
  }
  for (const candidate of resolved) {
    if (!isPublicAddress(candidate.address, candidate.family)) {
      throw new KnowledgeWebFetchError('KNOWLEDGE_WEB_ADDRESS_FORBIDDEN');
    }
  }

  // Pin the socket lookup to an address that was just policy-checked. The TLS
  // SNI and certificate hostname remain the original URL hostname, closing the
  // DNS-rebinding window without weakening certificate verification.
  const selected = resolved[0];
  if (selected === undefined) throw new KnowledgeWebFetchError('KNOWLEDGE_WEB_DNS_UNAVAILABLE');
  return new Promise<ControlledKnowledgeWebPage>((resolve, reject) => {
    let settled = false;
    let request: ReturnType<typeof httpsRequest> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const fail = (error: KnowledgeWebFetchError): void => {
      if (settled) return;
      settled = true;
      if (deadline !== undefined) clearTimeout(deadline);
      reject(error);
    };
    const options: RequestOptions = {
      protocol: 'https:',
      hostname: url.hostname,
      port: 443,
      family: selected.family,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      agent: false,
      servername: url.hostname,
      headers: {
        accept: 'text/html, application/xhtml+xml;q=0.9',
        'accept-encoding': 'identity',
        'user-agent': 'EnterpriseKnowledgeImporter/1.0',
      },
      lookup: (_hostname, _options, callback) => {
        callback(null, selected.address, selected.family);
      },
    };

    try {
      request = dependencies.request(options, (response) => {
        const statusCode = response.statusCode ?? 0;
        if (statusCode >= 300 && statusCode < 400) {
          response.destroy();
          fail(new KnowledgeWebFetchError('KNOWLEDGE_WEB_REDIRECT_FORBIDDEN'));
          return;
        }
        if (statusCode !== 200) {
          response.destroy();
          fail(new KnowledgeWebFetchError('KNOWLEDGE_WEB_FETCH_FAILED'));
          return;
        }
        const contentEncoding = String(response.headers['content-encoding'] ?? 'identity')
          .trim()
          .toLowerCase();
        if (contentEncoding !== '' && contentEncoding !== 'identity') {
          response.destroy();
          fail(new KnowledgeWebFetchError('KNOWLEDGE_WEB_CONTENT_TYPE_FORBIDDEN'));
          return;
        }
        const mimeType = normalizeContentType(response.headers['content-type']);
        if (mimeType === null) {
          response.destroy();
          fail(new KnowledgeWebFetchError('KNOWLEDGE_WEB_CONTENT_TYPE_FORBIDDEN'));
          return;
        }
        const contentLengthHeader = response.headers['content-length'];
        const declaredLength = Number(contentLengthHeader);
        if (
          contentLengthHeader !== undefined &&
          (!/^(?:0|[1-9]\d*)$/u.test(String(contentLengthHeader)) ||
            !Number.isSafeInteger(declaredLength) ||
            declaredLength < 0 ||
            declaredLength > policy.maximumBytes)
        ) {
          response.destroy();
          fail(new KnowledgeWebFetchError('KNOWLEDGE_WEB_RESPONSE_TOO_LARGE'));
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        response.on('data', (chunk: unknown) => {
          if (settled) return;
          if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
            response.destroy();
            fail(new KnowledgeWebFetchError('KNOWLEDGE_WEB_FETCH_FAILED'));
            return;
          }
          const bytes = Buffer.from(chunk);
          received += bytes.byteLength;
          if (received > policy.maximumBytes) {
            response.destroy();
            fail(new KnowledgeWebFetchError('KNOWLEDGE_WEB_RESPONSE_TOO_LARGE'));
            return;
          }
          chunks.push(bytes);
        });
        response.once('end', () => {
          if (settled) return;
          if (received === 0) {
            fail(new KnowledgeWebFetchError('KNOWLEDGE_WEB_FETCH_FAILED'));
            return;
          }
          settled = true;
          if (deadline !== undefined) clearTimeout(deadline);
          resolve({
            sourceUri: url.toString(),
            bytes: Buffer.concat(chunks, received),
            mimeType,
          });
        });
        response.once('error', () =>
          fail(new KnowledgeWebFetchError('KNOWLEDGE_WEB_FETCH_FAILED')),
        );
      });
    } catch {
      fail(new KnowledgeWebFetchError('KNOWLEDGE_WEB_FETCH_FAILED'));
      return;
    }
    deadline = setTimeout(() => {
      request?.destroy();
      fail(new KnowledgeWebFetchError('KNOWLEDGE_WEB_FETCH_TIMEOUT'));
    }, policy.timeoutMs);
    deadline.unref();
    request.setTimeout(policy.timeoutMs, () => {
      request.destroy();
      fail(new KnowledgeWebFetchError('KNOWLEDGE_WEB_FETCH_TIMEOUT'));
    });
    request.once('error', () => fail(new KnowledgeWebFetchError('KNOWLEDGE_WEB_FETCH_FAILED')));
    request.end();
  });
}

export function validateKnowledgeWebUrl(sourceUri: string, allowedHosts: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(sourceUri);
  } catch {
    throw new KnowledgeWebFetchError('KNOWLEDGE_WEB_URL_INVALID');
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, '');
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    (url.port !== '' && url.port !== '443') ||
    hostname.length === 0
  ) {
    throw new KnowledgeWebFetchError('KNOWLEDGE_WEB_URL_INVALID');
  }
  if (allowedHosts.length > 0 && !allowedHosts.includes(hostname)) {
    throw new KnowledgeWebFetchError('KNOWLEDGE_WEB_HOST_NOT_ALLOWED');
  }
  url.hostname = hostname;
  url.port = '';
  return url;
}

export function isPublicAddress(address: string, family: number): boolean {
  const detectedFamily = isIP(address);
  if (detectedFamily === 0 || detectedFamily !== family) return false;
  if (detectedFamily === 6 && address.toLowerCase().includes('::ffff:')) return false;
  return !PRIVATE_ADDRESSES.check(address, detectedFamily === 4 ? 'ipv4' : 'ipv6');
}

function normalizeContentType(
  value: string | readonly string[] | undefined,
): 'text/html' | 'application/xhtml+xml' | null {
  if (Array.isArray(value)) return null;
  const mimeType = String(value ?? '')
    .split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  return mimeType !== undefined && ALLOWED_CONTENT_TYPES.has(mimeType)
    ? (mimeType as 'text/html' | 'application/xhtml+xml')
    : null;
}

function createPrivateAddressBlockList(): BlockList {
  const blockList = new BlockList();
  for (const [network, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const) {
    blockList.addSubnet(network, prefix, 'ipv4');
  }
  for (const [network, prefix] of [
    ['::', 128],
    ['::1', 128],
    ['64:ff9b::', 96],
    ['100::', 64],
    ['2001::', 23],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['fc00::', 7],
    ['fe80::', 10],
    ['fec0::', 10],
    ['ff00::', 8],
  ] as const) {
    blockList.addSubnet(network, prefix, 'ipv6');
  }
  return blockList;
}
