import { agentRunStreamEventSchema, type AgentRunStreamEvent } from '@enterprise/contracts';

const MAX_BUFFERED_SSE_BYTES = 128 * 1024;

export interface AgentRunSseResult {
  readonly cursor: number;
  readonly terminal: boolean;
}

export async function consumeAgentRunSse(input: {
  readonly response: Response;
  readonly runId: string;
  readonly cursor: number;
  readonly signal: AbortSignal;
  readonly onEvent: (event: AgentRunStreamEvent) => void;
}): Promise<AgentRunSseResult> {
  if (input.response.body === null) {
    throw new Error('Agent Run SSE response did not contain a body.');
  }
  const reader = input.response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let cursor = input.cursor;
  let terminal = false;

  const consumeFrame = (frame: string): void => {
    const parsed = parseSseFrame(frame);
    if (parsed === null) return;
    const result = agentRunStreamEventSchema.safeParse(parsed.data);
    if (!result.success) throw new Error('Agent Run SSE event failed contract validation.');
    const event = result.data;
    if (
      parsed.id !== event.eventId ||
      parsed.event !== event.type ||
      event.eventId !== `${input.runId}:${event.sequence}`
    ) {
      throw new Error('Agent Run SSE event identity is invalid.');
    }
    if (event.sequence <= cursor) return;
    if (event.sequence !== cursor + 1) {
      throw new Error('Agent Run SSE replay is not contiguous.');
    }
    cursor = event.sequence;
    terminal = event.type !== 'delta' && event.status !== 'UNKNOWN';
    input.onEvent(event);
  };

  try {
    while (!input.signal.aborted) {
      const next = await reader.read();
      buffer += decoder.decode(next.value, { stream: !next.done });
      if (Buffer.byteLength(buffer, 'utf8') > MAX_BUFFERED_SSE_BYTES) {
        throw new Error('Agent Run SSE frame exceeded the desktop safety limit.');
      }
      buffer = buffer.replace(/\r\n/gu, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        consumeFrame(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
      }
      if (next.done) break;
    }
    if (buffer.trim().length > 0) consumeFrame(buffer);
    return { cursor, terminal };
  } finally {
    reader.releaseLock();
  }
}

function parseSseFrame(
  frame: string,
): { readonly id: string; readonly event: string; readonly data: unknown } | null {
  const lines = frame.split('\n');
  let id: string | null = null;
  let event: string | null = null;
  const data: string[] = [];
  for (const line of lines) {
    if (line.length === 0 || line.startsWith(':')) continue;
    const delimiter = line.indexOf(':');
    const field = delimiter < 0 ? line : line.slice(0, delimiter);
    const rawValue = delimiter < 0 ? '' : line.slice(delimiter + 1);
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;
    if (field === 'id') id = value;
    else if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length === 0) return null;
  if (id === null || event === null) {
    throw new Error('Agent Run SSE event is missing its id or type.');
  }
  try {
    return { id, event, data: JSON.parse(data.join('\n')) as unknown };
  } catch {
    throw new Error('Agent Run SSE event did not contain valid JSON.');
  }
}
