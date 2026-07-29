import { resolveTraceContext } from './trace-context.js';

describe('resolveTraceContext', () => {
  it('preserves valid correlation and W3C trace context', () => {
    const result = resolveTraceContext({
      requestId: 'request-1',
      correlationId: 'task:42',
      traceparent: '00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01',
    });

    expect(result).toEqual({
      correlationId: 'task:42',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    });
  });

  it('fails closed to generated context for malformed or all-zero trace IDs', () => {
    const result = resolveTraceContext({
      requestId: 'request-2',
      correlationId: 'contains a space',
      traceparent: '00-00000000000000000000000000000000-0000000000000000-01',
    });

    expect(result.correlationId).toBe('request-2');
    expect(result.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(result.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(result.traceId).not.toMatch(/^0+$/);
  });
});
