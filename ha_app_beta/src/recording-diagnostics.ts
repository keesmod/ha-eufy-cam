/** Cached scalar observations only. No identifiers, source bytes or stderr survive. */
import { randomInt } from 'node:crypto';
import type { RecordingDiagnostic, RecordingFormat, RecordingMedia, RecordingProgress } from './recording-media.js';

export const RECORDING_RETENTION_MS = 15 * 60_000;
export const recordingEvents = ['admission', 'download', 'conversion', 'transfer', 'cleanup',
  'recording_active_nvidia', 'recording_active_software', 'recording_remuxed',
  'recording_hardware_failed', 'recording_hardware_timeout', 'recording_failed',
  'recording_software_fallback'] as const;
const failureReasons = ['spawn', 'process', 'output_io', 'timeout', 'cancelled', 'output_limit', 'cleanup_unconfirmed', 'empty_output'];
const categories = ['storage', 'memory', 'cuda_device', 'cuda_driver', 'nvenc_session', 'nvenc_open_session', 'nvenc_unavailable', 'unsupported_format', 'decode', 'invalid_input', 'unclassified'];
const bounded = (n: number, max = 2 ** 31 - 1) => Math.min(max, Math.max(0, Math.round(n)));
export interface RecordingAttemptReport {
  attempt: number;
  age_ms: number;
  duration_ms: number;
  format: RecordingFormat;
  outcome: 'active' | 'completed' | 'failed' | 'cancelled';
  stage: 'admission' | 'download' | 'conversion' | 'transfer';
  error?: string;
  source_cancel_confirmed?: boolean;
  files_removed?: boolean;
  source_bytes?: number;
  output_bytes?: number;
  media?: RecordingMedia;
  progress?: RecordingProgress;
  limits: Record<string, number>;
  events: Record<string, unknown>[];
}
export class RecordingObservation {
  private readonly started: number;
  private ended?: number;
  readonly data: RecordingAttemptReport;
  constructor(format: RecordingFormat, private readonly now: () => number) {
    this.started = now();
    this.data = { attempt: randomInt(1, 2 ** 48), age_ms: 0, duration_ms: 0,
      format, outcome: 'active', stage: 'admission', limits: { operation_ms: 60000 }, events: [] };
    this.stage('admission');
  }
  stage(stage: RecordingAttemptReport['stage']): void {
    this.data.stage = stage;
    this.event({ event: stage });
  }
  cleanup(): void { this.event({ event: "cleanup" }); }
  private event(row: Record<string, unknown>): void {
    if (this.data.events.length < 16) this.data.events.push({ ...row, elapsed_ms: bounded(this.now() - this.started, 120000) });
  }
  progress = (value: RecordingProgress): void => {
    const progress: RecordingProgress = {};
    for (const key of ['output_bytes', 'encoded_frames'] as const) {
      const count = value[key];
      if (typeof count === 'number' && Number.isFinite(count) && count >= 0) progress[key] = bounded(count);
    }
    if (typeof value.process_closed === 'boolean') progress.process_closed = value.process_closed;
    this.data.progress = progress;
  };
  conversion = (raw: RecordingDiagnostic): void => {
    if (!(recordingEvents as readonly string[]).includes(raw.event)) return;
    const row: Record<string, unknown> = { event: raw.event };
    const failure = raw.failure;
    if (failure) {
      const safe: Record<string, unknown> = {};
      if (failureReasons.includes(failure.reason)) safe.reason = failure.reason;
      for (const key of ['timeout_ms', 'encoded_frames', 'output_bytes'] as const) {
        const value = failure[key];
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) safe[key] = bounded(value);
      }
      if (failure.timeout_scope === 'conversion' || failure.timeout_scope === 'hardware_progress') safe.timeout_scope = failure.timeout_scope;
      safe.ffmpeg = failure.ffmpeg.filter(value => categories.includes(value)).slice(0, categories.length);
      // Process close is known only when the converter supplied its exit result.
      if ('exit_code' in failure) safe.process_closed = true;
      if (failure.reason === 'cleanup_unconfirmed') safe.process_closed = false;
      row.failure = safe;
    }
    this.event(row);
  };
  finish(outcome: RecordingAttemptReport['outcome'], error?: unknown): void {
    this.ended = this.now(); this.data.outcome = outcome;
    const code = (error as { code?: unknown })?.code;
    this.data.error = typeof code === 'string' && ['live_busy', 'live_stopping', 'recording_busy', 'recording_expired', 'recording_unavailable', 'recording_storage_unavailable', 'capability_unavailable'].includes(code) ? code : error ? 'unclassified' : undefined;
  }
  snapshot(): RecordingAttemptReport {
    return structuredClone({ ...this.data, age_ms: bounded(this.now() - this.started), duration_ms: bounded((this.ended ?? this.now()) - this.started, 120000) });
  }
  expired(): boolean { return this.now() - this.started >= RECORDING_RETENTION_MS; }
}
export class RecordingDiagnostics {
  private rows: RecordingObservation[] = [];
  private expiredCount = 0;
  constructor(private readonly now = () => performance.now()) {}
  private prune(): void {
    const keep = this.rows.filter(row => !row.expired());
    this.expiredCount = bounded(this.expiredCount + this.rows.length - keep.length);
    this.rows = keep;
  }
  begin(format: RecordingFormat): RecordingObservation {
    this.prune();
    const row = new RecordingObservation(format, this.now);
    this.rows.push(row);
    if (this.rows.length > 8) this.rows.shift();
    return row;
  }
  report() { this.prune(); return { schema: 1 as const, retention_ms: RECORDING_RETENTION_MS, expired: this.expiredCount, attempts: this.rows.map(row => row.snapshot()) }; }
}
