import { RecordingError } from './errors.js';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import { stat } from 'node:fs/promises';

export interface RecordingProgress { output_bytes?: number; encoded_frames?: number; process_closed?: boolean }
export interface RecordingObservationSink {
  attempt: number;
  mark: (event: RecordingDiagnostic) => void;
  limits: Record<string, number>;
  progress?: (value: RecordingProgress) => void;
}
export interface RecordingMetadata {
  videoCodec: 'h264' | 'hevc' | null;
  fps: number;
}
export type RecordingFormat = 'auto' | 'native' | 'h264';
export interface RecordingMedia {
  source: 'h264' | 'hevc';
  output: 'h264' | 'hevc';
  processing: 'remux' | 'software' | 'nvidia';
  fallback: boolean;
}
export interface RecordingResult { path: string; size: number; media: RecordingMedia }
export interface RecordingFiles { video: string; audio?: string; output: string }
export type RecordingAcceleration = 'software' | 'nvidia';
export function recordingAcceleration(value?: string): RecordingAcceleration {
  if (value === undefined || value === 'software') return 'software';
  if (value === 'nvidia') return 'nvidia';
  throw new Error('EUFY_RECORDING_ACCELERATION must be software or nvidia');
}
// Disk budget, independent of the client's compressed source download limit.
export const RECORDING_BYTES = 256 * 1024 * 1024;
type Event = 'recording_active_nvidia' | 'recording_active_software' | 'recording_remuxed'
  | 'recording_hardware_failed' | 'recording_hardware_timeout' | 'recording_failed' | 'recording_software_fallback';
export interface RecordingDiagnostic {
  diagnostic: 'recording'; attempt: number; elapsed_ms: number; event: Event;
  failure?: ConversionFailure;
}
type FailureReason = 'spawn' | 'process' | 'output_io' | 'timeout'
  | 'cancelled' | 'output_limit' | 'cleanup_unconfirmed' | 'empty_output';
interface ConversionFailure {
  reason: FailureReason;
  timeout_ms?: number;
  timeout_scope?: 'conversion' | 'hardware_progress';
  encoded_frames?: number;
  output_bytes?: number;
  exit_code?: number | null;
  signal?: string | null;
  ffmpeg: string[];
  ffmpeg_detail?: string;
}
// Fixed labels are always safe to log. Unknown text requires explicit diagnostics.
const ffmpegFailures = [
  ['storage', /No space left on device|Disk quota exceeded|Read-only file system|Error opening output.*Permission denied|av_interleaved_write_frame.*Input.output error/i],
  ['memory', /CUDA_ERROR_OUT_OF_MEMORY|out of memory/i],
  ['cuda_device', /CUDA_ERROR_(?:NO_DEVICE|INVALID_DEVICE|DEVICE_UNAVAILABLE)|no CUDA.capable device|Cannot load libcuda/i],
  ['cuda_driver', /CUDA_ERROR_(?:INSUFFICIENT_DRIVER|SYSTEM_DRIVER_MISMATCH|NOT_INITIALIZED)|minimum required Nvidia driver|driver does not support/i],
  ['nvenc_session', /too many concurrent sessions|NV_ENC_ERR_ENCODER_BUSY|encoder busy/i],
  ['nvenc_open_session', /OpenEncodeSessionEx failed/i],
  ['nvenc_unavailable', /Cannot load libnvidia-encode|No capable devices found|Unknown encoder.*h264_nvenc/i],
  ['unsupported_format', /unsupported (?:pixel format|bit depth|chroma format)|(?:10 bit|10-bit) encode not supported|Impossible to convert between the formats/i],
  ['decode', /error while decoding|decode_slice_header error|No decoder surfaces left|Failed setup for format cuda/i],
  ['invalid_input', /invalid data|invalid NAL|invalid argument|could not find codec parameters/i],
] as const;
/** Optional support excerpt, bounded and scrubbed before it enters any log. */
function recordingErrorText(tail: string, truncated: boolean): string {
  // A truncated first line could have lost the label identifying a secret.
  // Omit that partial line instead of attempting to redact an orphaned value.
  if (truncated) tail = tail.includes('\n') ? tail.slice(tail.indexOf('\n') + 1) : '';
  const text = tail
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/\b(?:https?|rtsp|rtmp|file):\/\/[^\s"'<>]+/gi, '[url]')
    .replace(/\b(?:Bearer\s+)[^\s"',;]+/gi, 'Bearer [redacted]')
    .replace(/\b(token|password|passwd|secret|api[_-]?key|device[_-]?key|serial|authorization)\b["']?\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, '$1=[redacted]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/(?:[A-Z]:\\|\/)[^\s"'<>]+/gi, '[path]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[address]')
    .replace(/\b(?:[a-f\d]{0,4}:){2,}[a-f\d]{0,4}\b/gi, '[address]')
    .replace(/\bT[A-Z0-9]{15,}\b/g, '[serial]')
    .replace(/\b[A-Za-z0-9_=-]{32,}\b/g, '[identifier]')
    .trim();
  return (truncated ? '[earlier output omitted] ' : '') + text.slice(0, 2000);
}
class ConversionError extends RecordingError {
  constructor(readonly retryable: boolean, readonly details: ConversionFailure) { super(['output_limit', 'output_io'].includes(details.reason) ? 'recording_storage_unavailable' : 'recording_unavailable', 503); }
  get timedOut(): boolean { return this.details.reason === 'timeout'; }
}

/** Failures remain visible without enabling verbose live/media diagnostics. */
export function logRecordingDiagnostic(event: RecordingDiagnostic, verbose: boolean,
  warning: (line: string) => void = console.warn, info: (line: string) => void = console.info): void {
  if (event.event === 'recording_hardware_failed' || event.event === 'recording_hardware_timeout' || event.event === 'recording_failed') warning(JSON.stringify(event));
  else if (verbose) info(JSON.stringify(event));
}

export function recordingArgs(metadata: RecordingMetadata, hasAudio: boolean, format: 'h264' | 'native', mode: RecordingAcceleration, files: RecordingFiles, bytes = RECORDING_BYTES): string[] {
  const codec = metadata.videoCodec;
  if (codec !== 'h264' && codec !== 'hevc') throw new Error('Unsupported recording codec');
  const transcode = codec === 'hevc' && format === 'h264';
  const hardware = transcode && mode === 'nvidia';
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '2'];
  if (hardware) args.push('-progress', 'pipe:4', '-stats_period', '0.5', '-nostats', '-hwaccel', 'cuda');
  args.push('-r', String(metadata.fps || 15), '-f', codec, '-i', files.video);
  if (hasAudio) args.push('-f', 'aac', '-i', files.audio!);
  args.push('-map', '0:v:0', '-c:v', transcode ? hardware ? 'h264_nvenc' : 'libx264' : 'copy');
  if (codec === 'hevc' && !transcode) args.push('-tag:v', 'hvc1');
  if (transcode) {
    if (hardware) args.push('-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-cq', '23', '-b:v', '0', '-bf', '0');
    else args.push('-preset', 'veryfast');
    args.push('-pix_fmt', 'yuv420p', '-threads', '2');
  }
  if (hasAudio) args.push('-map', '1:a:0', '-c:a', 'copy', '-bsf:a', 'aac_adtstoasc');
  // Seekable output avoids buffering a whole MP4 fragment inside FFmpeg.
  // faststart keeps duration, audio discovery and native Apple seeking intact.
  args.push('-y', '-fs', String(bytes), '-movflags', '+faststart', '-f', 'mp4', files.output);
  return args;
}

/** Converts downloaded bytes only. Never owns or repeats a camera transfer. */
export class RecordingTranscoder {
  private unavailable = false;
  private sequence = 0;
  constructor(
    private readonly acceleration: RecordingAcceleration = 'software',
    private readonly diagnostic: (event: RecordingDiagnostic) => void = () => {},
    private readonly launch: (args: string[]) => ChildProcess = args => spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe', 'ignore', 'pipe'] }),
    private readonly limits = { conversionMs: 45_000, remuxMs: 20_000, hardwareMs: 10_000, cleanupMs: 1000, bytes: RECORDING_BYTES },
    private readonly includeErrorText = false,
  ) {}
  async muxResult(metadata: RecordingMetadata, files: RecordingFiles, signal: AbortSignal, requested: RecordingFormat = 'h264', hevcSupported = false, observation?: RecordingObservationSink): Promise<RecordingResult> {
    signal.throwIfAborted();
    const format = requested === 'auto' ? (this.acceleration === 'nvidia' || !hevcSupported ? 'h264' : 'native') : requested;
    const source = metadata.videoCodec;
    if (source !== 'h264' && source !== 'hevc') throw new Error('Unsupported recording codec');
    let fallback = false;
    const result = (size: number, processing: RecordingMedia['processing']): RecordingResult => ({ path: files.output, size, media: { source, output: transcode ? 'h264' : source, processing, fallback } });
    if (this.unavailable) throw new Error('Recording converter requires restart');
    const transcode = metadata.videoCodec === 'hevc' && format === 'h264';
    const started = performance.now(), attempt = observation?.attempt ?? ++this.sequence;
    if (observation) Object.assign(observation.limits, { output_bytes: this.limits.bytes, conversion_ms: transcode ? this.limits.conversionMs : this.limits.remuxMs, hardware_progress_ms: this.limits.hardwareMs, cleanup_ms: this.limits.cleanupMs });
    const deadline = started + (transcode ? this.limits.conversionMs : this.limits.remuxMs);
    const mark = (event: Event, failure?: ConversionFailure, log = true) => {
      const row: RecordingDiagnostic = { diagnostic: 'recording', attempt, elapsed_ms: Math.round(performance.now() - started), event, ...(failure ? { failure } : {}) };
      try { observation?.mark(row); } catch { /* Observation cannot affect conversion. */ }
      try { if (log) this.diagnostic(row); } catch { /* Logging cannot affect playback. */ }
    };
    const run = (mode: RecordingAcceleration) => {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new ConversionError(false, { reason: 'timeout', ffmpeg: [] });
      return this.convert(recordingArgs(metadata, !!files.audio, format, mode, files, this.limits.bytes), files.output, signal,
        remaining, mode === 'nvidia' && transcode ? this.limits.hardwareMs : undefined, observation?.progress);
    };
    if (transcode && this.acceleration === 'nvidia') {
      try {
        const output = await run('nvidia');
        signal.throwIfAborted();
        mark('recording_active_nvidia');
        return result(output, 'nvidia');
      } catch (error) {
        if (signal.aborted) mark('recording_failed', error instanceof ConversionError ? error.details : undefined, false);
        signal.throwIfAborted();
        if (!(error instanceof ConversionError) || !error.retryable) {
          mark('recording_failed', error instanceof ConversionError ? error.details : undefined);
          throw error;
        }
        mark(error.timedOut ? 'recording_hardware_timeout' : 'recording_hardware_failed',
          error.details);
        if (performance.now() >= deadline) throw error;
        fallback = true;
        mark('recording_software_fallback');
      }
    }
    let output: number;
    try { output = await run('software'); }
    catch (error) {
      if (signal.aborted) mark('recording_failed', error instanceof ConversionError ? error.details : undefined, false);
      signal.throwIfAborted();
      mark('recording_failed', error instanceof ConversionError ? error.details : undefined);
      throw error;
    }
    signal.throwIfAborted();
    mark(transcode ? 'recording_active_software' : 'recording_remuxed');
    return result(output, transcode ? 'software' : 'remux');
  }
  private convert(args: string[], output: string, signal: AbortSignal, timeout: number, hardwareIdleMs?: number, observe?: (value: RecordingProgress) => void): Promise<number> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try { child = this.launch(args); } catch { reject(new ConversionError(true, { reason: 'spawn', ffmpeg: [] })); return; }
      let size = 0, settled = false, failure: ConversionError | undefined;
      let cleanupTimer: NodeJS.Timeout | undefined;
      let tail = '', stderrSeen = false, stderrTruncated = false, progressTail = '', encodedFrames = 0;
      let progressTimer: NodeJS.Timeout | undefined;
      const progress = child.stdio[4] as Readable | undefined;
      const categories = new Set<string>();
      const error = (retryable: boolean, reason: FailureReason) => new ConversionError(retryable,
        { reason, output_bytes: size,
          ...(hardwareIdleMs === undefined ? {} : { encoded_frames: encodedFrames }), ffmpeg: [] });
      const reportProgress = (closed?: boolean) => {
        try { observe?.({ ...(closed === true ? { output_bytes: size } : {}), ...(hardwareIdleMs === undefined ? {} : { encoded_frames: encodedFrames }), ...(closed === undefined ? {} : { process_closed: closed }) }); } catch { /* Observation cannot affect conversion. */ }
      };
      const finish = (error?: ConversionError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); clearTimeout(progressTimer); clearTimeout(cleanupTimer);
        signal.removeEventListener('abort', abort);
        progress?.off('data', observeProgress);
        if (error) {
          error.details.ffmpeg = categories.size ? [...categories] : stderrSeen ? ['unclassified'] : [];
          if (this.includeErrorText && stderrSeen && !categories.size) error.details.ffmpeg_detail = recordingErrorText(tail, stderrTruncated);
          reject(error);
        } else resolve(size);
        tail = ''; progressTail = '';
      };
      const fail = (cause: ConversionError) => {
        if (settled || failure) return;
        failure = cause;
        clearTimeout(timer); clearTimeout(progressTimer);
        // A replacement may start only after close confirms the old process is gone.
        cleanupTimer = setTimeout(() => {
          this.unavailable = true;
          reportProgress(false);
          finish(error(false, 'cleanup_unconfirmed'));
        }, this.limits.cleanupMs);
        child.kill('SIGKILL');
      };
      const abort = () => fail(error(false, 'cancelled'));
      const timedOut = (scope: 'conversion' | 'hardware_progress', budget: number) => {
        const cause = error(true, 'timeout');
        cause.details.timeout_scope = scope; cause.details.timeout_ms = Math.round(budget);
        fail(cause);
      };
      // Frame progress identifies a stalled encoder independently of file writes.
      const refreshProgress = () => {
        clearTimeout(progressTimer);
        progressTimer = setTimeout(() => timedOut('hardware_progress', hardwareIdleMs!), hardwareIdleMs!);
      };
      const observeProgress = (chunk: Buffer) => {
        if (settled || failure || hardwareIdleMs === undefined) return;
        for (let offset = 0; offset < chunk.length; offset += 2048) {
          progressTail = (progressTail + chunk.subarray(offset, offset + 2048).toString('utf8')).slice(-4096);
          for (const match of progressTail.matchAll(/(?:^|\n)frame=(\d{1,10})\r?\n/g)) {
            const frames = Number(match[1]);
            if (frames > encodedFrames) { encodedFrames = frames; reportProgress(); refreshProgress(); }
          }
        }
      };
      const timer = setTimeout(() => timedOut('conversion', timeout), timeout);
      if (hardwareIdleMs !== undefined) { progress?.on('data', observeProgress); refreshProgress(); }
      else progress?.resume();
      signal.addEventListener('abort', abort, { once: true });
      child.stderr!.on('data', (chunk: Buffer) => {
        if (settled) return;
        stderrSeen ||= chunk.length > 0;
        // Examine bounded windows with overlap, including very large/split writes.
        for (let offset = 0; offset < chunk.length; offset += 2048) {
          const next = tail + chunk.subarray(offset, offset + 2048).toString('utf8');
          stderrTruncated ||= next.length > 4096;
          tail = next.slice(-4096);
          for (const [category, pattern] of ffmpegFailures) if (pattern.test(tail)) categories.add(category);
        }
      });
      child.once('error', () => fail(error(true, 'process')));
      child.once('close', async (code, signal) => {
        clearTimeout(timer); clearTimeout(progressTimer); clearTimeout(cleanupTimer);
        try { size = (await stat(output)).size; } catch { /* Missing output is a failure. */ }
        if (categories.has('storage') && (!failure || failure.retryable)) failure = error(false, 'output_io');
        if (size >= this.limits.bytes && !failure) failure = error(false, 'output_limit');
        const cause = failure ?? (code !== 0 || !size ? error(true, code !== 0 ? 'process' : 'empty_output') : undefined);
        if (cause) {
          cause.details.output_bytes = size;
          cause.details.exit_code = typeof code === 'number' && Number.isInteger(code) && code >= 0 && code <= 255 ? code : null;
          cause.details.signal = signal == null ? null : ['SIGKILL', 'SIGTERM', 'SIGSEGV', 'SIGABRT', 'SIGBUS', 'SIGILL'].includes(signal) ? signal : 'other';
        }
        reportProgress(true);
        finish(cause);
      });
      if (signal.aborted) abort();
    });
  }
}
