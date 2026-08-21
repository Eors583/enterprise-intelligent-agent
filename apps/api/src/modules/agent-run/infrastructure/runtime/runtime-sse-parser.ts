export interface SseFrame {
  readonly id: string | null;
  readonly event: string | null;
  readonly data: string;
}

const MAX_EVENT_BYTES = 65_536;
const MAX_WIRE_BYTES = 8_388_608;

export class StrictSseParser {
  private buffer = new Uint8Array();
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private dataLines: string[] = [];
  private eventId: string | null = null;
  private eventType: string | null = null;
  private eventBytes = 0;
  private wireBytes = 0;

  feed(chunk: Uint8Array): SseFrame[] {
    this.wireBytes += chunk.byteLength;
    if (this.wireBytes > MAX_WIRE_BYTES) throw new Error('SSE wire limit exceeded.');
    const merged = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.byteLength);
    this.buffer = merged;

    const frames: SseFrame[] = [];
    let offset = 0;
    for (let index = 0; index < this.buffer.byteLength; index += 1) {
      if (this.buffer[index] !== 0x0a) continue;
      let end = index;
      if (end > offset && this.buffer[end - 1] === 0x0d) end -= 1;
      const lineBytes = this.buffer.slice(offset, end);
      this.eventBytes += index - offset + 1;
      if (this.eventBytes > MAX_EVENT_BYTES) throw new Error('SSE event limit exceeded.');
      const frame = this.consumeLine(this.decoder.decode(lineBytes));
      if (frame !== null) frames.push(frame);
      offset = index + 1;
    }
    this.buffer = this.buffer.slice(offset);
    if (this.buffer.byteLength + this.eventBytes > MAX_EVENT_BYTES) {
      throw new Error('SSE event limit exceeded.');
    }
    return frames;
  }

  finish(): SseFrame[] {
    if (this.buffer.byteLength > 0 || this.dataLines.length > 0) {
      throw new Error('SSE stream ended before an event delimiter.');
    }
    return [];
  }

  private consumeLine(line: string): SseFrame | null {
    if (line === '') {
      this.eventBytes = 0;
      if (this.dataLines.length === 0) {
        this.eventId = null;
        this.eventType = null;
        return null;
      }
      const frame = {
        id: this.eventId,
        event: this.eventType,
        data: this.dataLines.join('\n'),
      };
      this.dataLines = [];
      this.eventId = null;
      this.eventType = null;
      return frame;
    }
    if (line.startsWith(':')) return null;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') {
      this.dataLines.push(value);
      return null;
    }
    if (field === 'id') {
      if (value.includes('\0')) throw new Error('SSE id contains NUL.');
      this.eventId = value;
      return null;
    }
    if (field === 'event') {
      this.eventType = value;
      return null;
    }
    throw new Error('Unsupported SSE field.');
  }
}
