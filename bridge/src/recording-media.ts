import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

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
export interface RecordingResult { body: Buffer; media: RecordingMedia }
export type RecordingAcceleration = 'software' | 'nvidia';
export function recordingAcceleration(value?: string): RecordingAcceleration {
  if (value === undefined || value === 'software') return 'software';
  if (value === 'nvidia') return 'nvidia';
  throw new Error('EUFY_RECORDING_ACCELERATION must be software or nvidia');
}
const LIMIT = 32 * 1024 * 1024;
type Event = 'recording_active_nvidia' | 'recording_active_software' | 'recording_remuxed'
  | 'recording_hardware_failed' | 'recording_hardware_timeout' | 'recording_hardware_disabled' | 'recording_software_fallback';
export interface RecordingDiagnostic {
  diagnostic: 'recording'; attempt: number; elapsed_ms: number; event: Event;
  failure?: ConversionFailure;
}
type FailureReason = 'spawn' | 'process' | 'video_input' | 'audio_input' | 'timeout'
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
}
// Only these fixed labels leave the process. Never log raw FFmpeg/driver text.
const ffmpegFailures = [
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
class ConversionError extends Error {
  constructor(readonly retryable: boolean, readonly details: ConversionFailure) { super('Recording conversion failed'); }
  get timedOut(): boolean { return this.details.reason === 'timeout'; }
}

/** Failures remain visible without enabling verbose live/media diagnostics. */
export function logRecordingDiagnostic(event: RecordingDiagnostic, verbose: boolean,
  warning: (line: string) => void = console.warn, info: (line: string) => void = console.info): void {
  if (event.event === 'recording_hardware_failed' || event.event === 'recording_hardware_timeout') warning(JSON.stringify(event));
  else if (verbose) info(JSON.stringify(event));
}

export function recordingArgs(metadata: RecordingMetadata, hasAudio: boolean, format: 'h264' | 'native', mode: RecordingAcceleration): string[] {
  const codec = metadata.videoCodec;
  if (codec !== 'h264' && codec !== 'hevc') throw new Error('Unsupported recording codec');
  const transcode = codec === 'hevc' && format === 'h264';
  const hardware = transcode && mode === 'nvidia';
  const args = ['-hide_banner', '-loglevel', 'error', '-threads', '2'];
  if (hardware) args.push('-progress', 'pipe:4', '-stats_period', '0.5', '-nostats', '-hwaccel', 'cuda');
  args.push('-r', String(metadata.fps || 15), '-f', codec, '-i', 'pipe:0');
  if (hasAudio) args.push('-f', 'aac', '-i', 'pipe:3');
  args.push('-map', '0:v:0', '-c:v', transcode ? hardware ? 'h264_nvenc' : 'libx264' : 'copy');
  if (codec === 'hevc' && !transcode) args.push('-tag:v', 'hvc1');
  if (transcode) {
    if (hardware) args.push('-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-cq', '23', '-b:v', '0', '-bf', '0');
    else args.push('-preset', 'veryfast');
    args.push('-pix_fmt', 'yuv420p', '-threads', '2');
  }
  if (hasAudio) args.push('-map', '1:a:0', '-c:a', 'copy', '-bsf:a', 'aac_adtstoasc');
  // Keep one buffered MP4 fragment and discover AAC before writing its header.
  // This preserves full duration and audio in native Apple playback.
  args.push('-movflags', 'frag_custom+empty_moov+delay_moov+default_base_moof',
    '-frag_size', String(LIMIT), '-f', 'mp4', 'pipe:1');
  return args;
}

/** Converts downloaded bytes only. Never owns or repeats a camera transfer. */
export class RecordingTranscoder {
  private hardwareFailed = false;
  private unavailable = false;
  private sequence = 0;
  constructor(
    private readonly acceleration: RecordingAcceleration = 'software',
    private readonly diagnostic: (event: RecordingDiagnostic) => void = () => {},
    private readonly launch: (args: string[]) => ChildProcess = args => spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'] }),
    private readonly limits = { conversionMs: 45_000, remuxMs: 20_000, hardwareMs: 10_000, cleanupMs: 1000, bytes: LIMIT },
  ) {}
  async mux(metadata: RecordingMetadata, video: Buffer, audio: Buffer, signal: AbortSignal, format: 'h264' | 'native' = 'h264'): Promise<Buffer> {
    return (await this.muxResult(metadata, video, audio, signal, format)).body;
  }
  async muxResult(metadata: RecordingMetadata, video: Buffer, audio: Buffer, signal: AbortSignal, requested: RecordingFormat = 'h264', hevcSupported = false): Promise<RecordingResult> {
    signal.throwIfAborted();
    const format = requested === 'auto' ? (this.acceleration === 'nvidia' || !hevcSupported ? 'h264' : 'native') : requested;
    const source = metadata.videoCodec;
    if (source !== 'h264' && source !== 'hevc') throw new Error('Unsupported recording codec');
    const result = (body: Buffer, processing: RecordingMedia['processing']): RecordingResult => ({ body, media: { source, output: transcode ? 'h264' : source, processing, fallback: transcode && this.acceleration === 'nvidia' && this.hardwareFailed } });
    if (this.unavailable) throw new Error('Recording converter requires restart');
    const transcode = metadata.videoCodec === 'hevc' && format === 'h264';
    const started = performance.now(), attempt = ++this.sequence;
    const deadline = started + (transcode ? this.limits.conversionMs : this.limits.remuxMs);
    const mark = (event: Event, failure?: ConversionFailure) => {
      try { this.diagnostic({ diagnostic: 'recording', attempt, elapsed_ms: Math.round(performance.now() - started), event, ...(failure ? { failure } : {}) }); } catch { /* Logging cannot affect playback. */ }
    };
    const run = (mode: RecordingAcceleration) => {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new ConversionError(false, { reason: 'timeout', ffmpeg: [] });
      return this.convert(recordingArgs(metadata, !!audio.length, format, mode), video, audio, signal,
        remaining, mode === 'nvidia' && transcode ? this.limits.hardwareMs : undefined);
    };
    if (transcode && this.acceleration === 'nvidia' && !this.hardwareFailed) {
      try {
        const output = await run('nvidia');
        signal.throwIfAborted();
        mark('recording_active_nvidia');
        return result(output, 'nvidia');
      } catch (error) {
        signal.throwIfAborted();
        this.hardwareFailed = true;
        mark(error instanceof ConversionError && error.timedOut ? 'recording_hardware_timeout' : 'recording_hardware_failed',
          error instanceof ConversionError ? error.details : { reason: 'process', ffmpeg: [] });
        if (!(error instanceof ConversionError) || !error.retryable || performance.now() >= deadline) throw error;
        mark('recording_software_fallback');
      }
    } else if (transcode && this.acceleration === 'nvidia') mark('recording_hardware_disabled');
    const output = await run('software');
    signal.throwIfAborted();
    mark(transcode ? 'recording_active_software' : 'recording_remuxed');
    return result(output, transcode ? 'software' : 'remux');
  }
  private convert(args: string[], video: Buffer, audio: Buffer, signal: AbortSignal, timeout: number, hardwareIdleMs?: number): Promise<Buffer> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try { child = this.launch(args); } catch { reject(new ConversionError(true, { reason: 'spawn', ffmpeg: [] })); return; }
      const input = child.stdio[3] as Writable;
      const parts: Buffer[] = [];
      let size = 0, settled = false, failure: ConversionError | undefined;
      let cleanupTimer: NodeJS.Timeout | undefined;
      let tail = '', stderrSeen = false, progressTail = '', encodedFrames = 0;
      let progressTimer: NodeJS.Timeout | undefined;
      const progress = child.stdio[4] as Readable | undefined;
      const categories = new Set<string>();
      const error = (retryable: boolean, reason: FailureReason) => new ConversionError(retryable,
        { reason, timeout_ms: Math.round(hardwareIdleMs ?? timeout), output_bytes: size,
          ...(hardwareIdleMs === undefined ? {} : { encoded_frames: encodedFrames }), ffmpeg: [] });
      const finish = (error?: ConversionError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); clearTimeout(progressTimer); clearTimeout(cleanupTimer);
        signal.removeEventListener('abort', abort);
        tail = ''; progressTail = '';
        progress?.off('data', observeProgress);
        if (error) { error.details.ffmpeg = categories.size ? [...categories] : stderrSeen ? ['unclassified'] : []; parts.length = 0; reject(error); }
        else resolve(Buffer.concat(parts));
      };
      const fail = (cause: ConversionError) => {
        if (settled || failure) return;
        failure = cause;
        clearTimeout(timer); clearTimeout(progressTimer);
        parts.length = 0;
        child.stdin?.destroy(); input.destroy();
        // A replacement may start only after close confirms the old process is gone.
        cleanupTimer = setTimeout(() => {
          this.unavailable = true;
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
      // A complete MP4 is buffered until conversion ends. Its output bytes cannot
      // distinguish a long, healthy encode from a hung GPU. Watch encoded frames,
      // while the original overall deadline remains fixed across both attempts.
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
            if (frames > encodedFrames) { encodedFrames = frames; refreshProgress(); }
          }
        }
      };
      const timer = setTimeout(() => timedOut('conversion', timeout), timeout);
      if (hardwareIdleMs !== undefined) { progress?.on('data', observeProgress); refreshProgress(); }
      else progress?.resume();
      signal.addEventListener('abort', abort, { once: true });
      child.stdout!.on('data', (chunk: Buffer) => {
        if (settled || failure) return;
        size += chunk.length;
        if (size > this.limits.bytes) fail(error(false, 'output_limit'));
        else parts.push(chunk);
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        if (settled) return;
        stderrSeen ||= chunk.length > 0;
        // Examine bounded windows with overlap, including very large/split writes.
        for (let offset = 0; offset < chunk.length; offset += 2048) {
          tail = (tail + chunk.subarray(offset, offset + 2048).toString('utf8')).slice(-4096);
          for (const [category, pattern] of ffmpegFailures) if (pattern.test(tail)) categories.add(category);
        }
      });
      child.once('error', () => fail(error(true, 'process')));
      child.once('close', (code, signal) => {
        const cause = failure ?? (code !== 0 || !size ? error(true, code !== 0 ? 'process' : 'empty_output') : undefined);
        if (cause) {
          cause.details.exit_code = typeof code === 'number' && Number.isInteger(code) && code >= 0 && code <= 255 ? code : null;
          cause.details.signal = signal == null ? null : ['SIGKILL', 'SIGTERM', 'SIGSEGV', 'SIGABRT', 'SIGBUS', 'SIGILL'].includes(signal) ? signal : 'other';
        }
        finish(cause);
      });
      child.stdin!.on('error', () => fail(error(true, 'video_input')));
      input.on('error', () => fail(error(true, 'audio_input')));
      if (signal.aborted) abort();
      else { child.stdin!.end(video); input.end(audio); }
    });
  }
}
