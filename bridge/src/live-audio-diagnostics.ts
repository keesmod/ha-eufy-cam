/** Observe audio admission without starting or changing media flow. */
import { AudioHeaderDiagnostics, type AudioHeaderReport } from './audio-header-diagnostics.js';
import { diagnosticEvents, type DiagnosticEvent } from './diagnostics.js';
import { randomInt } from 'node:crypto';
import type { Readable } from 'node:stream';

const codecs = ['aac', 'aac-lc', 'aac-eld', 'none', 'unknown'] as const;
type Codec = typeof codecs[number] | 'unavailable';
const codec = (value: unknown): Codec => typeof value === 'string' && (codecs as readonly string[]).includes(value) ? value as Codec : 'unavailable';
const elapsed = (value: number) => Math.min(3600000, Math.max(0, Math.round(value)));
export interface LiveAudioReport {
  attempt: number;
  age_ms?: number;
  model: string;
  state: 'starting' | 'streaming' | 'ended' | 'failed' | 'closed';
  firmware?: string;
  owner_model?: string;
  owner_firmware?: string;
  initial_buffered_bytes?: number;
  buffered_bytes?: number;
  stream_ended?: boolean;
  stream_destroyed?: boolean;
  stop_confirmed?: boolean;
  metadata_ms?: number;
  last_data_ms?: number;
  last_data_age_ms?: number;
  max_gap_ms?: number;
  min_chunk_bytes?: number;
  max_chunk_bytes?: number;
  latest_codec?: Codec;
  format?: AudioHeaderReport;
  pipeline?: { event: DiagnosticEvent; elapsed_ms: number }[];
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
  private readonly headers = new AudioHeaderDiagnostics();
  private lastDataAt?: number;
  private prefix = Buffer.alloc(7);
  private prefixBytes = 0;
  constructor(model: string, private readonly now: () => number, context: { firmware?: string; owner_model?: string; owner_firmware?: string } = {}) {
    this.started = now();
    this.report = { attempt: randomInt(1, 2 ** 48), model: /^T[A-Z0-9]{4}$/.test(model) ? model : 'unavailable', state: 'starting', chunks: 0, bytes: 0, duration_ms: 0 };
    for (const key of ['firmware', 'owner_firmware'] as const) {
      const value = context[key];
      if (value && /^\d{1,4}(?:\.\d{1,4}){1,4}$/.test(value)) this.report[key] = value;
    }
    if (context.owner_model && /^T[A-Z0-9]{4}$/.test(context.owner_model)) this.report.owner_model = context.owner_model;
  }
  attach(stream: Readable, initialCodec: unknown, forwarded: boolean, readCodec: () => unknown): void {
    if (this.closed || this.stream) return;
    this.metadataAt = this.now();
    Object.assign(this.report, { state: 'streaming', metadata_ms: elapsed(this.metadataAt - this.started), initial_codec: codec(initialCodec), admission: forwarded ? 'forwarded' : 'excluded' });
    this.stream = stream; this.readCodec = readCodec;
    this.report.initial_buffered_bytes = Math.min(2147483647, stream.readableLength);
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
    const now = this.now();
    if (this.lastDataAt !== undefined) this.report.max_gap_ms = Math.max(this.report.max_gap_ms ?? 0, elapsed(now - this.lastDataAt));
    this.lastDataAt = now;
    this.report.last_data_ms = elapsed(now - this.started);
    this.report.min_chunk_bytes = Math.min(this.report.min_chunk_bytes ?? chunk.length, chunk.length, 2147483647);
    this.report.max_chunk_bytes = Math.min(2147483647, Math.max(this.report.max_chunk_bytes ?? 0, chunk.length));
    try { this.report.latest_codec = codec(this.readCodec?.()); }
    catch { this.report.latest_codec = 'unavailable'; }
    this.headers.write(chunk);
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
  mark(event: DiagnosticEvent): void {
    if (this.closed || !diagnosticEvents.includes(event)) return;
    if (event === 'audio_late') this.report.admission = 'forwarded';
    const rows = this.report.pipeline ??= [];
    if (rows.length < 48 && !rows.some(row => row.event === event)) rows.push({ event, elapsed_ms: elapsed(this.now() - this.started) });
  }
  snapshot(): LiveAudioReport {
    return { ...this.report, age_ms: Math.max(0, Math.round(this.now() - this.started)),
      ...(this.stream ? { buffered_bytes: Math.min(2147483647, this.stream.readableLength), stream_ended: this.stream.readableEnded, stream_destroyed: this.stream.destroyed } : {}),
      duration_ms: this.closed ? this.report.duration_ms : elapsed(this.now() - this.started),
      ...(this.lastDataAt !== undefined ? {
        last_data_age_ms: this.closed ? this.report.last_data_age_ms : elapsed(this.now() - this.lastDataAt),
        format: this.headers.snapshot(),
      } : {}),
      ...(this.report.pipeline ? { pipeline: this.report.pipeline.map(row => ({ ...row })) } : {}),
    };
  }
  finish(state: 'ended' | 'failed' | 'closed', stopConfirmed?: boolean): void {
    if (this.closed) return;
    this.report.duration_ms = elapsed(this.now() - this.started);
    if (this.lastDataAt !== undefined) this.report.last_data_age_ms = elapsed(this.now() - this.lastDataAt);
    if (typeof stopConfirmed === 'boolean') this.report.stop_confirmed = stopConfirmed;
    if (this.stream) Object.assign(this.report, { buffered_bytes: Math.min(2147483647, this.stream.readableLength), stream_ended: this.stream.readableEnded, stream_destroyed: this.stream.destroyed });
    this.headers.clear();
    this.report.state = state; this.closed = true;
    this.stream?.off('data', this.observe);
    this.stream = undefined; this.readCodec = undefined; this.prefix.fill(0);
  }
}
export class LiveAudioDiagnostics {
  private rows: LiveAudioObservation[] = [];
  constructor(private readonly now = () => performance.now()) {}
  begin(model: string, context?: { firmware?: string; owner_model?: string; owner_firmware?: string }): LiveAudioObservation {
    const row = new LiveAudioObservation(model, this.now, context);
    this.rows.push(row);
    if (this.rows.length > 8) this.rows.shift()!.finish('closed');
    return row;
  }
  /** Rows younger than the window, fifteen minutes unless the caller adds the live session cap. */
  report(windowMs = 900_000): LiveAudioReport[] { return this.rows.map(row => row.snapshot()).filter(row => row.age_ms! < windowMs); }
  close(): void { for (const row of this.rows) row.finish('closed'); }
}
