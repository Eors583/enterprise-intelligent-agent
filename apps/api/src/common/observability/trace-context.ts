import { randomBytes } from 'node:crypto';

const SAFE_CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const TRACEPARENT =
  /^(?<version>[0-9a-f]{2})-(?<traceId>[0-9a-f]{32})-(?<parentId>[0-9a-f]{16})-(?<flags>[0-9a-f]{2})$/;

export interface TraceContext {
  readonly correlationId: string;
  readonly traceId: string;
  readonly traceparent: string;
}

export function resolveTraceContext(input: {
  readonly requestId: string;
  readonly correlationId?: string;
  readonly traceparent?: string;
}): TraceContext {
  const correlationId =
    input.correlationId !== undefined && SAFE_CORRELATION_ID.test(input.correlationId)
      ? input.correlationId
      : input.requestId;
  const incoming = parseTraceparent(input.traceparent);
  if (incoming !== null) {
    return {
      correlationId,
      traceId: incoming.traceId,
      traceparent: incoming.traceparent,
    };
  }

  const traceId = randomHex(16);
  return {
    correlationId,
    traceId,
    traceparent: `00-${traceId}-${randomHex(8)}-01`,
  };
}

function parseTraceparent(value: string | undefined): {
  readonly traceId: string;
  readonly traceparent: string;
} | null {
  if (value === undefined) return null;
  const normalized = value.toLowerCase();
  const match = TRACEPARENT.exec(normalized);
  const version = match?.groups?.version;
  const traceId = match?.groups?.traceId;
  const parentId = match?.groups?.parentId;
  if (
    version === undefined ||
    traceId === undefined ||
    parentId === undefined ||
    version === 'ff' ||
    /^0+$/.test(traceId) ||
    /^0+$/.test(parentId)
  ) {
    return null;
  }
  return { traceId, traceparent: normalized };
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}
