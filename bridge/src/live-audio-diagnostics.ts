/** Observe audio admission without starting, buffering or changing media flow. */
import { randomInt } from 'node:crypto';
import type { Readable } from 'node:stream';

const codecs = ['aac', 'aac-lc', 'aac-eld', 'none', 'unknown'] as const;
type Codec = typeof codecs[number] | 'unavailable';
const codec = (value: unknown): Codec => typeof value === 'string' && (codecs as readonly string[]).includes(value) ? value as Codec : 'unavailable';
const elapsed = (value: number) => Math.min(120000, Math.max(0, Math.round(value)));
export interface LiveAudioReport {
  attempt: number;
  model: string;
  state: 'starting' | 'streaming' | 'ended' | 'failed' | 'closed';
  metadata_ms?: number;
  initial_codec?: Codec;
  first_data_codec?: Codec;
  admission?: 'forwarded' | 'excluded';
  first_data_ms?: number;
  first_data_after_metadata_ms?: number;
  header?: 'adts' | 'other' | 'incomplete';
  chunks: number;
  bytes: number;
  duration_ms: number;
}
export class LiveAudioObservation {
  readonly report: LiveAudioReport;
  private readonly started: number;
  private metadataAt = 0;
  private stream?: Readable;
  private readCodec?: () => unknown;
  private closed = false;
  private prefix = Buffer.alloc(7);
  private prefixBytes = 0;
  constructor(model: string, private readonly now: () => number) {
    this.started = now();
    this.report = { attempt: randomInt(1, 2 ** 48), model: /^T[A-Z0-9]{4}$/.test(model) ? model : 'unavailable', state: 'starting', chunks: 0, bytes: 0, duration_ms: 0 };
  }
  attach(stream: Readable, initialCodec: unknown, forwarded: boolean, readCodec: () => unknown): void {
    if (this.closed || this.stream) return;
    this.metadataAt = this.now();
    Object.assign(this.report, { state: 'streaming', metadata_ms: elapsed(this.metadataAt - this.started), initial_codec: codec(initialCodec), admission: forwarded ? 'forwarded' : 'excluded' });
    this.stream = stream; this.readCodec = readCodec;
    // EventEmitter.prependListener does not put a Readable into flowing mode.
    // Existing media consumers alone decide when buffered data is consumed.
    stream.prependListener('data', this.observe);
  }
  private readonly observe = (chunk: unknown) => {
    if (this.closed || !Buffer.isBuffer(chunk) || chunk.length === 0) return;
    if (!this.report.chunks) {
      this.report.first_data_ms = elapsed(this.now() - this.started);
      this.report.first_data_after_metadata_ms = elapsed(this.now() - this.metadataAt);
      try { this.report.first_data_codec = codec(this.readCodec?.()); }
      catch { this.report.first_data_codec = 'unavailable'; }
      this.report.header = 'incomplete';
    }
    this.report.chunks = Math.min(2147483647, this.report.chunks + 1);
    this.report.bytes = Math.min(2147483647, this.report.bytes + chunk.length);
    if (this.prefixBytes < 7) {
      this.prefixBytes += chunk.copy(this.prefix, this.prefixBytes, 0, 7 - this.prefixBytes);
      if (this.prefixBytes === 7) {
        const p = this.prefix;
        const frameBytes = ((p[3]! & 3) << 11) | (p[4]! << 3) | (p[5]! >> 5);
        this.report.header = p[0] === 0xff && (p[1]! & 0xf6) === 0xf0 && (p[2]! >> 2 & 15) < 13 && frameBytes >= ((p[1]! & 1) ? 7 : 9) ? 'adts' : 'other';
        this.prefix.fill(0);
      }
    }
  };
  snapshot(): LiveAudioReport { return { ...this.report, duration_ms: this.closed ? this.report.duration_ms : elapsed(this.now() - this.started) }; }
  finish(state: 'ended' | 'failed' | 'closed'): void {
    if (this.closed) return;
    this.report.duration_ms = elapsed(this.now() - this.started);
    this.report.state = state; this.closed = true;
    this.stream?.off('data', this.observe);
    this.stream = undefined; this.readCodec = undefined; this.prefix.fill(0);
  }
}
export class LiveAudioDiagnostics {
  private rows: LiveAudioObservation[] = [];
  constructor(private readonly now = () => performance.now()) {}
  begin(model: string): LiveAudioObservation {
    const row = new LiveAudioObservation(model, this.now);
    this.rows.push(row);
    if (this.rows.length > 8) this.rows.shift()!.finish('closed');
    return row;
  }
  report(): LiveAudioReport[] { return this.rows.map(row => row.snapshot()); }
  close(): void { for (const row of this.rows) row.finish('closed'); }
}
