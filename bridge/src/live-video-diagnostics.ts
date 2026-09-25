/** Observe the live video path without starting or changing media flow. */
import { diagnosticEvents, type DiagnosticEvent } from './diagnostics.js';
import type { LiveEncoderProgress } from './live-transcoder.js';
import { randomInt } from 'node:crypto';
import type { Readable } from 'node:stream';

const elapsed = (value: number) => Math.min(3600000, Math.max(0, Math.round(value)));
const bounded = (value: number) => Math.min(2147483647, Math.max(0, value));
export type LiveVideoReaderKind = 'video' | 'audio';
export type LiveVideoReaderEvent = 'attached' | 'backpressure' | 'closed' | 'revoked';
const readerEvents: readonly LiveVideoReaderEvent[] = ['attached', 'backpressure', 'closed', 'revoked'];
/** What the media relay tells the row of one live session. Every call is bounded and never throws. */
export interface LiveVideoObserver {
  encoder(mode: 'software' | 'nvidia'): void;
  output(bytes: number): void;
  progress(value: LiveEncoderProgress): void;
  reader(kind: LiveVideoReaderKind, event: LiveVideoReaderEvent): void;
}
const progressCounters = ['frames', 'dropped', 'duplicated', 'out_time_ms', 'bytes'] as const;
/** Chunk continuity of one point in the chain: the P2P input, the encoder output or the JPEG frames. */
export interface LiveVideoStageReport {
  chunks: number;
  bytes: number;
  first_data_ms?: number;
  last_data_ms?: number;
  last_data_age_ms?: number;
  max_gap_ms?: number;
}
/** HTTP readers of one grant kind: attached, destroyed by the bridge for backpressure or at a revoke, or closed by the client. */
export interface LiveVideoReaderReport {
  attached: number;
  backpressure: number;
  closed: number;
  revoked: number;
  last_destroy_ms?: number;
}
/**
 * The live encoder process. `stderr_chunks` counts its stderr data events at
 * -loglevel error. The counters are those of FFmpeg's latest progress block
 * from the current process, `last_frame_ms` and `last_drop_ms` the times of
 * the blocks in which `frames` and `dropped` last rose, and the block's age
 * is frozen at the session's end like the three points.
 */
export interface LiveVideoEncoderReport extends LiveEncoderProgress {
  mode: 'software' | 'nvidia' | 'unavailable';
  exits: number;
  stderr_chunks: number;
  software_fallback_ms?: number;
  last_progress_ms?: number;
  last_progress_age_ms?: number;
  last_frame_ms?: number;
  last_drop_ms?: number;
}
/**
 * How far the library's live start got, in milliseconds since the bridge
 * requested the stream: the camera's P2P session ready, START issued, the
 * station's answer with its numeric `return_code`, the library ending the
 * stream without media, and the stream's metadata. Each is kept once. The
 * object exists from the row's start, so an empty one means no stage yet.
 */
export interface LiveVideoStartReport {
  session_ready_ms?: number;
  issued_ms?: number;
  result_ms?: number;
  return_code?: number;
  no_data_end_ms?: number;
  metadata_ms?: number;
}
const startStages = {
  session_ready: 'session_ready_ms',
  start_issued: 'issued_ms',
  start_result: 'result_ms',
  no_data_end: 'no_data_end_ms',
  metadata: 'metadata_ms',
} as const;
const int32 = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
export interface LiveVideoReport {
  attempt: number;
  audio_attempt?: number;
  age_ms?: number;
  model: string;
  state: 'starting' | 'streaming' | 'ended' | 'failed' | 'closed';
  codec?: 'h264' | 'hevc';
  encoder: LiveVideoEncoderReport;
  input: LiveVideoStageReport;
  output: LiveVideoStageReport;
  jpeg: LiveVideoStageReport;
  readers: LiveVideoReaderReport;
  audio_readers: LiveVideoReaderReport;
  start: LiveVideoStartReport;
  pipeline?: { event: DiagnosticEvent; elapsed_ms: number }[];
  duration_ms: number;
}
class Stage {
  readonly report: LiveVideoStageReport = { chunks: 0, bytes: 0 };
  private lastAt?: number;
  constructor(private readonly started: number, private readonly now: () => number) {}
  observe(bytes: number): void {
    const now = this.now();
    if (!this.report.chunks) this.report.first_data_ms = elapsed(now - this.started);
    if (this.lastAt !== undefined) this.report.max_gap_ms = Math.max(this.report.max_gap_ms ?? 0, elapsed(now - this.lastAt));
    this.lastAt = now;
    this.report.last_data_ms = elapsed(now - this.started);
    this.report.chunks = bounded(this.report.chunks + 1);
    this.report.bytes = bounded(this.report.bytes + bounded(bytes));
  }
  snapshot(closed: boolean): LiveVideoStageReport {
    return { ...this.report, ...(this.lastAt !== undefined && !closed ? { last_data_age_ms: elapsed(this.now() - this.lastAt) } : {}) };
  }
  /** The age at the session's end says how long before the end this point stopped. */
  finish(): void { if (this.lastAt !== undefined) this.report.last_data_age_ms = elapsed(this.now() - this.lastAt); }
}
class Readers {
  readonly report: LiveVideoReaderReport = { attached: 0, backpressure: 0, closed: 0, revoked: 0 };
  constructor(private readonly started: number, private readonly now: () => number) {}
  observe(event: LiveVideoReaderEvent): void {
    this.report[event] = bounded(this.report[event] + 1);
    if (event === 'backpressure' || event === 'revoked') this.report.last_destroy_ms = elapsed(this.now() - this.started);
  }
}
export class LiveVideoObservation implements LiveVideoObserver {
  readonly report: LiveVideoReport;
  private readonly started: number;
  private closed = false;
  private stream?: Readable;
  private readonly stages: Record<'input' | 'output' | 'jpeg', Stage>;
  private readonly readerCounts: Record<LiveVideoReaderKind, Readers>;
  /** When the latest progress block arrived, and the counts the next block of the same process is compared with. */
  private progressAt?: number;
  private progressSeen = { frames: 0, dropped: 0 };
  constructor(model: string, private readonly now: () => number) {
    this.started = now();
    this.stages = { input: new Stage(this.started, now), output: new Stage(this.started, now), jpeg: new Stage(this.started, now) };
    this.readerCounts = { video: new Readers(this.started, now), audio: new Readers(this.started, now) };
    this.report = {
      attempt: randomInt(1, 2 ** 48), model: /^T[A-Z0-9]{4}$/.test(model) ? model : 'unavailable', state: 'starting',
      encoder: { mode: 'unavailable', exits: 0, stderr_chunks: 0 },
      input: this.stages.input.report, output: this.stages.output.report, jpeg: this.stages.jpeg.report,
      readers: this.readerCounts.video.report, audio_readers: this.readerCounts.audio.report, start: {}, duration_ms: 0,
    };
  }
  /** One stage of the library's live start, timed on the bridge's clock. Anything else is ignored. */
  startStage(progress: unknown): void {
    if (this.closed || typeof progress !== 'object' || progress === null) return;
    const { stage, returnCode } = progress as { stage?: unknown; returnCode?: unknown };
    if (typeof stage !== 'string' || !Object.hasOwn(startStages, stage)) return;
    const start = this.report.start;
    const key = startStages[stage as keyof typeof startStages];
    if (start[key] !== undefined) return;
    start[key] = elapsed(this.now() - this.started);
    if (stage === 'start_result' && int32(returnCode)) start.return_code = returnCode;
  }
  /** The audio row's attempt, so HA can put both bridge rows next to its live_playback row. */
  correlate(audioAttempt: unknown): void {
    if (!this.closed && typeof audioAttempt === 'number' && Number.isInteger(audioAttempt) && audioAttempt >= 1 && audioAttempt < 2 ** 48) this.report.audio_attempt = audioAttempt;
  }
  attach(stream: Readable, codec: unknown): void {
    if (this.closed || this.stream) return;
    this.stream = stream;
    this.report.state = 'streaming';
    if (codec === 'h264' || codec === 'hevc') this.report.codec = codec;
    // EventEmitter.prependListener does not put a Readable into flowing mode.
    // The existing encoder and JPEG consumers alone decide when data flows.
    stream.prependListener('data', this.observeInput);
  }
  private readonly observeInput = (chunk: unknown) => {
    if (this.closed || !Buffer.isBuffer(chunk) || chunk.length === 0) return;
    this.stages.input.observe(chunk.length);
  };
  encoder(mode: 'software' | 'nvidia'): void {
    if (!this.closed && (mode === 'software' || mode === 'nvidia')) this.report.encoder.mode = mode;
  }
  output(bytes: number): void { if (!this.closed && typeof bytes === 'number' && bytes > 0) this.stages.output.observe(bytes); }
  progress(value: LiveEncoderProgress): void {
    if (this.closed || typeof value !== 'object' || value === null) return;
    const now = this.now(), at = elapsed(now - this.started), encoder = this.report.encoder;
    for (const key of progressCounters) {
      const count = value[key];
      if (typeof count === 'number' && Number.isInteger(count) && count >= 0) encoder[key] = bounded(count);
    }
    // A rise against the previous block of the same process dates the last frame and the last drop.
    if ((encoder.frames ?? 0) > this.progressSeen.frames) encoder.last_frame_ms = at;
    if ((encoder.dropped ?? 0) > this.progressSeen.dropped) encoder.last_drop_ms = at;
    this.progressSeen = { frames: encoder.frames ?? 0, dropped: encoder.dropped ?? 0 };
    encoder.last_progress_ms = at;
    this.progressAt = now;
  }
  /** A replacement encoder process counts from zero, so the row keeps only its counters. */
  private resetProgress(): void {
    for (const key of [...progressCounters, 'last_progress_ms', 'last_frame_ms', 'last_drop_ms'] as const) delete this.report.encoder[key];
    this.progressAt = undefined;
    this.progressSeen = { frames: 0, dropped: 0 };
  }
  jpeg(bytes: number): void { if (!this.closed && typeof bytes === 'number' && bytes > 0) this.stages.jpeg.observe(bytes); }
  reader(kind: LiveVideoReaderKind, event: LiveVideoReaderEvent): void {
    if (this.closed || !readerEvents.includes(event)) return;
    const counts = kind === 'video' ? this.readerCounts.video : kind === 'audio' ? this.readerCounts.audio : undefined;
    counts?.observe(event);
  }
  mark(event: DiagnosticEvent): void {
    if (this.closed || !diagnosticEvents.includes(event)) return;
    if (event === 'media_encoder_exit') this.report.encoder.exits = bounded(this.report.encoder.exits + 1);
    if (event === 'media_encoder_stderr') this.report.encoder.stderr_chunks = bounded(this.report.encoder.stderr_chunks + 1);
    if (event === 'media_active_nvidia') this.report.encoder.mode = 'nvidia';
    if (event === 'media_active_software') this.report.encoder.mode = 'software';
    if (event === 'media_software_fallback') {
      this.report.encoder.mode = 'software';
      this.report.encoder.software_fallback_ms ??= elapsed(this.now() - this.started);
      this.resetProgress();
    }
    const rows = this.report.pipeline ??= [];
    if (rows.length < 48 && !rows.some(row => row.event === event)) rows.push({ event, elapsed_ms: elapsed(this.now() - this.started) });
  }
  snapshot(): LiveVideoReport {
    return {
      ...this.report,
      age_ms: Math.max(0, Math.round(this.now() - this.started)),
      encoder: { ...this.report.encoder, ...(this.progressAt !== undefined && !this.closed ? { last_progress_age_ms: elapsed(this.now() - this.progressAt) } : {}) },
      input: this.stages.input.snapshot(this.closed),
      output: this.stages.output.snapshot(this.closed),
      jpeg: this.stages.jpeg.snapshot(this.closed),
      readers: { ...this.report.readers },
      audio_readers: { ...this.report.audio_readers },
      start: { ...this.report.start },
      duration_ms: this.closed ? this.report.duration_ms : elapsed(this.now() - this.started),
      ...(this.report.pipeline ? { pipeline: this.report.pipeline.map(row => ({ ...row })) } : {}),
    };
  }
  finish(state: 'ended' | 'failed' | 'closed'): void {
    if (this.closed) return;
    this.report.duration_ms = elapsed(this.now() - this.started);
    for (const stage of Object.values(this.stages)) stage.finish();
    if (this.progressAt !== undefined) this.report.encoder.last_progress_age_ms = elapsed(this.now() - this.progressAt);
    this.report.state = state;
    this.closed = true;
    this.stream?.off('data', this.observeInput);
    this.stream = undefined;
  }
}
export class LiveVideoDiagnostics {
  private rows: LiveVideoObservation[] = [];
  constructor(private readonly now = () => performance.now()) {}
  begin(model: string): LiveVideoObservation {
    const row = new LiveVideoObservation(model, this.now);
    this.rows.push(row);
    if (this.rows.length > 8) this.rows.shift()!.finish('closed');
    return row;
  }
  /** Rows younger than the window, fifteen minutes unless the caller adds the live session cap. */
  report(windowMs = 900_000): LiveVideoReport[] { return this.rows.map(row => row.snapshot()).filter(row => row.age_ms! < windowMs); }
  close(): void { for (const row of this.rows) row.finish('closed'); }
}
