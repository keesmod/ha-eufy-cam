import { spawn, type ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';

export interface RecordingMetadata {
  videoCodec: 'h264' | 'hevc' | null;
  fps: number;
}
export type RecordingAcceleration = 'software' | 'nvidia';
export function recordingAcceleration(value?: string): RecordingAcceleration {
  if (value === undefined || value === 'software') return 'software';
  if (value === 'nvidia') return 'nvidia';
  throw new Error('EUFY_RECORDING_ACCELERATION must be software or nvidia');
}
const LIMIT = 32 * 1024 * 1024;
type Event = 'recording_active_nvidia' | 'recording_active_software' | 'recording_remuxed'
  | 'recording_hardware_failed' | 'recording_hardware_timeout' | 'recording_software_fallback';
interface Diagnostic { diagnostic: 'recording'; attempt: number; elapsed_ms: number; event: Event }
class ConversionError extends Error {
  constructor(readonly retryable: boolean, readonly timedOut = false) { super('Recording conversion failed'); }
}

export function recordingArgs(metadata: RecordingMetadata, hasAudio: boolean, format: 'h264' | 'native', mode: RecordingAcceleration): string[] {
  const codec = metadata.videoCodec;
  if (codec !== 'h264' && codec !== 'hevc') throw new Error('Unsupported recording codec');
  const transcode = codec === 'hevc' && format === 'h264';
  const hardware = transcode && mode === 'nvidia';
  const args = ['-hide_banner', '-loglevel', 'error', '-threads', '2'];
  if (hardware) args.push('-hwaccel', 'cuda');
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
    private readonly diagnostic: (event: Diagnostic) => void = () => {},
    private readonly launch: (args: string[]) => ChildProcess = args => spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] }),
    private readonly limits = { conversionMs: 45_000, remuxMs: 20_000, hardwareMs: 10_000, cleanupMs: 1000, bytes: LIMIT },
  ) {}
  async mux(metadata: RecordingMetadata, video: Buffer, audio: Buffer, signal: AbortSignal, format: 'h264' | 'native' = 'h264'): Promise<Buffer> {
    signal.throwIfAborted();
    if (this.unavailable) throw new Error('Recording converter requires restart');
    const transcode = metadata.videoCodec === 'hevc' && format === 'h264';
    const started = performance.now(), attempt = ++this.sequence;
    const deadline = started + (transcode ? this.limits.conversionMs : this.limits.remuxMs);
    const mark = (event: Event) => {
      try { this.diagnostic({ diagnostic: 'recording', attempt, elapsed_ms: Math.round(performance.now() - started), event }); } catch { /* Logging cannot affect playback. */ }
    };
    const run = (mode: RecordingAcceleration) => {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new ConversionError(false, true);
      return this.convert(recordingArgs(metadata, !!audio.length, format, mode), video, audio, signal,
        Math.min(remaining, mode === 'nvidia' ? this.limits.hardwareMs : remaining));
    };
    if (transcode && this.acceleration === 'nvidia' && !this.hardwareFailed) {
      try {
        const output = await run('nvidia');
        signal.throwIfAborted();
        mark('recording_active_nvidia');
        return output;
      } catch (error) {
        signal.throwIfAborted();
        this.hardwareFailed = true;
        mark(error instanceof ConversionError && error.timedOut ? 'recording_hardware_timeout' : 'recording_hardware_failed');
        if (!(error instanceof ConversionError) || !error.retryable || performance.now() >= deadline) throw error;
        mark('recording_software_fallback');
      }
    }
    const output = await run('software');
    signal.throwIfAborted();
    mark(transcode ? 'recording_active_software' : 'recording_remuxed');
    return output;
  }
  private convert(args: string[], video: Buffer, audio: Buffer, signal: AbortSignal, timeout: number): Promise<Buffer> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try { child = this.launch(args); } catch { reject(new ConversionError(true)); return; }
      const input = child.stdio[3] as Writable;
      const parts: Buffer[] = [];
      let size = 0, settled = false, failure: ConversionError | undefined;
      let cleanupTimer: NodeJS.Timeout | undefined;
      const finish = (error?: ConversionError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); clearTimeout(cleanupTimer);
        signal.removeEventListener('abort', abort);
        if (error) { parts.length = 0; reject(error); }
        else resolve(Buffer.concat(parts));
      };
      const fail = (error: ConversionError) => {
        if (settled || failure) return;
        failure = error;
        clearTimeout(timer);
        parts.length = 0;
        child.stdin?.destroy(); input.destroy();
        // A replacement may start only after close confirms the old process is gone.
        cleanupTimer = setTimeout(() => {
          this.unavailable = true;
          finish(new ConversionError(false));
        }, this.limits.cleanupMs);
        child.kill('SIGKILL');
      };
      const abort = () => fail(new ConversionError(false));
      const timer = setTimeout(() => fail(new ConversionError(true, true)), timeout);
      signal.addEventListener('abort', abort, { once: true });
      child.stdout!.on('data', (chunk: Buffer) => {
        if (settled || failure) return;
        size += chunk.length;
        if (size > this.limits.bytes) fail(new ConversionError(false));
        else parts.push(chunk);
      });
      child.stderr!.resume();
      child.once('error', () => fail(new ConversionError(true)));
      child.once('close', code => finish(failure ?? (code !== 0 || !size ? new ConversionError(true) : undefined)));
      child.stdin!.on('error', () => fail(new ConversionError(true)));
      input.on('error', () => fail(new ConversionError(true)));
      if (signal.aborted) abort();
      else { child.stdin!.end(video); input.end(audio); }
    });
  }
}
