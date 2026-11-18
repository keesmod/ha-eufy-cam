import { RecordingError } from './errors.js';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import { stat } from 'node:fs/promises';
import { closeSync, openSync, readSync } from 'node:fs';
import { dirname } from 'node:path';
import { adtsHeader } from './audio-header-diagnostics.js';
import { eldDecoder, type AudioFrameLog, type EldDecoder, type EldOutcome } from './eld-audio.js';

export interface RecordingProgress { output_bytes?: number; encoded_frames?: number; process_closed?: boolean }
export interface RecordingObservationSink {
  attempt: number;
  mark: (event: RecordingDiagnostic) => void;
  limits: Record<string, number>;
  progress?: (value: RecordingProgress) => void;
}
export type RecordingAudioCodec = 'aac' | 'aac-lc' | 'aac-eld' | 'none' | 'unknown';
export interface RecordingMetadata {
  videoCodec: 'h264' | 'hevc' | null;
  fps: number;
  /** The client's audio label. Only the input report uses it. */
  audioCodec?: RecordingAudioCodec;
}
/** What the downloaded files contain, next to what the client reported (#252). */
export interface RecordingInput {
  reported_video: 'h264' | 'hevc' | 'unknown';
  /** none: no parameter set in the first 64 KiB. ambiguous: both kinds. */
  detected_video: 'h264' | 'hevc' | 'none' | 'ambiguous' | 'unread';
  reported_audio: RecordingAudioCodec;
  audio: 'adts' | 'not_adts' | 'absent' | 'unread';
  /** For AAC-ELD without ADTS: whether its units decoded (#264), and fixed counts. */
  audio_decode?: EldOutcome;
  audio_units?: number;
  audio_errors?: number;
  /** Mean step between the first and last unit timestamps, 30 for 480 samples at 16 kHz. */
  audio_frame_ms?: number | null;
  audio_rate?: number;
  decoder_exit?: number | null;
}
export type RecordingFormat = 'auto' | 'native' | 'h264';
export interface RecordingMedia {
  source: 'h264' | 'hevc';
  output: 'h264' | 'hevc';
  processing: 'remux' | 'software' | 'nvidia';
  fallback: boolean;
}
export interface RecordingResult { path: string; size: number; media: RecordingMedia }
export interface RecordingFiles {
  video: string;
  audio?: string;
  output: string;
  /** Unit boundaries of the audio file, from the client's download frame timing (#264). */
  audioFrames?: AudioFrameLog;
  /** Decoded AAC-ELD audio, which FFmpeg encodes to AAC-LC. Replaces `audio`. */
  pcm?: { path: string; rate: number; channels: number };
}
export type RecordingAcceleration = 'software' | 'nvidia';
export function recordingAcceleration(value?: string): RecordingAcceleration {
  if (value === undefined || value === 'software') return 'software';
  if (value === 'nvidia') return 'nvidia';
  throw new Error('EUFY_RECORDING_ACCELERATION must be software or nvidia');
}
// Disk budget, independent of the client's compressed source download limit.
export const RECORDING_BYTES = 256 * 1024 * 1024;
type Event = 'recording_active_nvidia' | 'recording_active_software' | 'recording_remuxed'
  | 'recording_hardware_failed' | 'recording_hardware_timeout' | 'recording_failed' | 'recording_software_fallback'
  | 'recording_input_adjusted';
export interface RecordingDiagnostic {
  diagnostic: 'recording'; attempt: number; elapsed_ms: number; event: Event;
  failure?: ConversionFailure;
  input?: RecordingInput;
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

/** Failures and adjusted input remain visible without enabling verbose live/media diagnostics. */
export function logRecordingDiagnostic(event: RecordingDiagnostic, verbose: boolean,
  warning: (line: string) => void = console.warn, info: (line: string) => void = console.info): void {
  if (event.event === 'recording_hardware_failed' || event.event === 'recording_hardware_timeout' || event.event === 'recording_failed'
    || event.event === 'recording_input_adjusted') warning(JSON.stringify(event));
  else if (verbose) info(JSON.stringify(event));
}

const INSPECT_BYTES = 65536;
const h264Profiles = new Set([44, 66, 77, 83, 86, 88, 100, 110, 118, 122, 128, 134, 135, 138, 139, 244]);
/** The codec named by the parameter sets of an Annex B stream. */
export function annexBCodec(data: Uint8Array): 'h264' | 'hevc' | 'none' | 'ambiguous' {
  let h264 = false, hevc = false;
  for (let i = 0; i + 4 < data.length; i++) {
    if (data[i] !== 0 || data[i + 1] !== 0 || data[i + 2] !== 1) continue;
    const a = data[i + 3]!, b = data[i + 4]!;
    i += 2;
    if (a & 0x80) continue;
    const type = (a >> 1) & 0x3f;
    // HEVC VPS, SPS or PPS of layer 0 with a temporal ID plus one of at least 1.
    if (type >= 32 && type <= 34 && (a & 1) === 0 && b >> 3 === 0 && (b & 7) !== 0) hevc = true;
    // H.264 SPS with a reference priority and a known profile_idc.
    else if ((a & 0x1f) === 7 && (a & 0x60) !== 0 && h264Profiles.has(b)) h264 = true;
  }
  return h264 && hevc ? 'ambiguous' : hevc ? 'hevc' : h264 ? 'h264' : 'none';
}
/**
 * ADTS framing: two consecutive headers, or one frame that ends the data.
 * This is stricter than FFmpeg's forced ADTS demuxer, which resyncs past junk
 * between frames, so raw AAC-ELD with a chance sync word is not mistaken for ADTS.
 */
export function adtsAudio(data: Uint8Array): boolean {
  for (let i = 0; i + 7 <= data.length; i++) {
    const header = adtsHeader(data.subarray(i));
    if (!header) continue;
    const next = i + header.frame_bytes;
    if (next === data.length || (next + 7 <= data.length && adtsHeader(data.subarray(next)))) return true;
  }
  return false;
}
// At most 64 KiB from the bridge's own workspace, read before FFmpeg starts.
function head(path: string): Buffer {
  const file = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(INSPECT_BYTES);
    return buffer.subarray(0, readSync(file, buffer, 0, INSPECT_BYTES, 0));
  } finally { closeSync(file); }
}
/**
 * The client names the video codec from the first NAL unit only, and passes
 * AAC-ELD or unknown audio on without ADTS framing (#252). Parameter sets of
 * one kind in the first 64 KiB decide the video demuxer, otherwise the client's
 * label stays. Audio without ADTS frames is left out instead of failing the
 * whole recording. An unreadable file is left to FFmpeg, as before.
 */
export function inspectRecordingInput(metadata: RecordingMetadata, files: RecordingFiles): RecordingInput {
  const input: RecordingInput = {
    reported_video: metadata.videoCodec ?? 'unknown', detected_video: 'unread',
    reported_audio: metadata.audioCodec ?? 'unknown', audio: files.audio ? 'unread' : 'absent',
  };
  try { input.detected_video = annexBCodec(head(files.video)); } catch { /* FFmpeg reports it. */ }
  if (files.audio) try { input.audio = adtsAudio(head(files.audio)) ? 'adts' : 'not_adts'; } catch { /* FFmpeg reports it. */ }
  return input;
}

export function recordingArgs(metadata: RecordingMetadata, hasAudio: boolean, format: 'h264' | 'native', mode: RecordingAcceleration, files: RecordingFiles, bytes = RECORDING_BYTES): string[] {
  const codec = metadata.videoCodec;
  if (codec !== 'h264' && codec !== 'hevc') throw new Error('Unsupported recording codec');
  const transcode = codec === 'hevc' && format === 'h264';
  const hardware = transcode && mode === 'nvidia';
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '2'];
  if (hardware) args.push('-progress', 'pipe:4', '-stats_period', '0.5', '-nostats', '-hwaccel', 'cuda');
  args.push('-r', String(metadata.fps || 15), '-f', codec, '-i', files.video);
  if (hasAudio && files.pcm) args.push('-f', 's16le', '-ar', String(files.pcm.rate), '-ac', String(files.pcm.channels), '-i', files.pcm.path);
  else if (hasAudio) args.push('-f', 'aac', '-i', files.audio!);
  args.push('-map', '0:v:0', '-c:v', transcode ? hardware ? 'h264_nvenc' : 'libx264' : 'copy');
  if (codec === 'hevc' && !transcode) args.push('-tag:v', 'hvc1');
  if (transcode) {
    if (hardware) args.push('-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-cq', '23', '-b:v', '0', '-bf', '0');
    else args.push('-preset', 'veryfast');
    args.push('-pix_fmt', 'yuv420p', '-threads', '2');
  }
  if (hasAudio) args.push('-map', '1:a:0', ...(files.pcm ? ['-c:a', 'aac', '-b:a', '64k'] : ['-c:a', 'copy', '-bsf:a', 'aac_adtstoasc']));
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
    private readonly decodeAudio: EldDecoder = eldDecoder(undefined, undefined, limits.cleanupMs),
  ) {}
  async muxResult(reported: RecordingMetadata, reportedFiles: RecordingFiles, signal: AbortSignal, requested: RecordingFormat = 'h264', hevcSupported = false, observation?: RecordingObservationSink): Promise<RecordingResult> {
    signal.throwIfAborted();
    const input = inspectRecordingInput(reported, reportedFiles);
    const format = requested === 'auto' ? (this.acceleration === 'nvidia' || !hevcSupported ? 'h264' : 'native') : requested;
    const source = input.detected_video === 'h264' || input.detected_video === 'hevc' ? input.detected_video : reported.videoCodec;
    if (source !== 'h264' && source !== 'hevc') throw new Error('Unsupported recording codec');
    const metadata: RecordingMetadata = { ...reported, videoCodec: source };
    let files: RecordingFiles = input.audio === 'not_adts' ? { ...reportedFiles, audio: undefined } : reportedFiles;
    // A converter that needs a restart starts no process, the decoder included.
    if (this.unavailable) throw new Error('Recording converter requires restart');
    const transcode = source === 'hevc' && format === 'h264';
    const started = performance.now(), attempt = observation?.attempt ?? ++this.sequence;
    if (observation) Object.assign(observation.limits, { output_bytes: this.limits.bytes, conversion_ms: transcode ? this.limits.conversionMs : this.limits.remuxMs, hardware_progress_ms: this.limits.hardwareMs, cleanup_ms: this.limits.cleanupMs });
    const mark = (event: Event, failure?: ConversionFailure, log = true) => {
      const row: RecordingDiagnostic = { diagnostic: 'recording', attempt, elapsed_ms: Math.round(performance.now() - started), event, ...(failure ? { failure } : {}),
        ...(event === 'recording_failed' || event === 'recording_input_adjusted' ? { input } : {}) };
      try { observation?.mark(row); } catch { /* Observation cannot affect conversion. */ }
      try { if (log) this.diagnostic(row); } catch { /* Logging cannot affect playback. */ }
    };
    if (input.audio === 'not_adts' && input.reported_audio === 'aac-eld') {
      const frames = reportedFiles.audioFrames;
      const decoded = frames && reportedFiles.audio
        ? await this.decodeAudio({ audio: reportedFiles.audio, frames, directory: dirname(reportedFiles.output) }, signal)
        : { outcome: 'no_frames' as const };
      input.audio_decode = decoded.outcome;
      if (decoded.units !== undefined) input.audio_units = decoded.units;
      if (decoded.errors !== undefined) input.audio_errors = decoded.errors;
      if (frames) input.audio_frame_ms = frames.frameMs();
      if (decoded.pcm) input.audio_rate = decoded.pcm.rate;
      if (decoded.exit_code !== undefined) input.decoder_exit = decoded.exit_code;
      if (decoded.outcome === 'cleanup_unconfirmed') {
        // As for FFmpeg: a helper whose exit is not confirmed blocks every later process.
        this.unavailable = true;
        const failure: ConversionFailure = { reason: 'cleanup_unconfirmed', ffmpeg: [] };
        mark('recording_failed', failure, !signal.aborted);
        signal.throwIfAborted();
        throw new ConversionError(false, failure);
      }
      signal.throwIfAborted();
      if (decoded.pcm) files = { ...files, pcm: decoded.pcm };
    }
    let fallback = false;
    const result = (size: number, processing: RecordingMedia['processing']): RecordingResult => ({ path: files.output, size, media: { source, output: transcode ? 'h264' : source, processing, fallback } });
    // The conversion budget starts after any audio decoding.
    const deadline = performance.now() + (transcode ? this.limits.conversionMs : this.limits.remuxMs);
    if (source !== reported.videoCodec || input.audio === 'not_adts') mark('recording_input_adjusted');
    const run = (mode: RecordingAcceleration) => {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new ConversionError(false, { reason: 'timeout', ffmpeg: [] });
      return this.convert(recordingArgs(metadata, !!(files.audio || files.pcm), format, mode, files, this.limits.bytes), files.output, signal,
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
