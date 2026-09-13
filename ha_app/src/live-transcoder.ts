/** Optional GPU startup with bounded replay. No camera commands or raw diagnostics. */
import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { StreamDiagnostics } from './diagnostics.js';

export type LiveAcceleration = 'software' | 'nvidia';
export function liveAcceleration(value?: string): LiveAcceleration {
  if (value === undefined || value === 'software') return 'software';
  if (value === 'nvidia') return value;
  throw new Error('EUFY_LIVE_ACCELERATION must be software or nvidia');
}
export function liveArgs(codec: 'h264' | 'hevc', hasAudio: boolean, fps: number, mode: LiveAcceleration): string[] {
  const args = ['-hide_banner', '-loglevel', 'error', '-threads', '1', '-fflags', '+genpts', '-probesize', '32768', '-analyzeduration', '100000', '-r', String(Math.max(1, Math.min(30, fps || 15)))];
  // Let FFmpeg transfer decoded frames to RAM for the existing software scaler.
  // This needs NVDEC/NVENC, but does not require scale_cuda or libnpp.
  if (mode === 'nvidia') args.push('-hwaccel', 'cuda');
  args.push('-f', codec, '-i', 'pipe:0');
  if (hasAudio) args.push('-thread_queue_size', '64', '-probesize', '32768', '-analyzeduration', '100000', '-f', 'aac', '-i', 'pipe:3');
  args.push('-map', '0:v:0');
  if (hasAudio) args.push('-map', '1:a:0', '-c:a', 'aac', '-b:a', '64k', '-ar', '48000', '-ac', '1');
  if (mode === 'nvidia') args.push('-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'ull', '-zerolatency', '1', '-bf', '0', '-rc', 'cbr', '-b:v', '4M', '-maxrate', '4M', '-bufsize', '1M');
  else args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency');
  args.push('-pix_fmt', 'yuv420p', '-vf', "scale='min(1920,iw)':-2", '-threads', '1', '-g', '30');
  args.push('-mpegts_flags', '+resend_headers', '-muxdelay', '0', '-muxpreload', '0', '-f', 'mpegts', 'pipe:1');
  return args;
}
export type TranscoderSpawn = (args: string[]) => ChildProcess;
const launch: TranscoderSpawn = args => spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
export class LiveTranscoder {
  private process?: ChildProcess;
  private stopped = false;
  private transitioning = false;
  private outputStarted = false;
  private replay: [Buffer[], Buffer[]] = [[], []];
  private replayBytes = 0;
  private startupTimer?: NodeJS.Timeout;
  private cleanupTimer?: NodeJS.Timeout;
  private readonly inputs: [Readable, Readable?];
  private readonly captureVideo = (chunk: Buffer) => this.capture(0, chunk);
  private readonly captureAudio = (chunk: Buffer) => this.capture(1, chunk);
  constructor(
    private readonly serial: string,
    private readonly codec: 'h264' | 'hevc',
    video: Readable, audio: Readable,
    private readonly hasAudio: boolean,
    private readonly fps: number,
    private mode: LiveAcceleration,
    private readonly diagnostics: StreamDiagnostics,
    private readonly output: (chunk: Buffer) => void,
    private readonly failed: () => void,
    private readonly disableHardware: () => void,
    private readonly spawnProcess: TranscoderSpawn = launch,
    private readonly startupMs = 5000,
    private readonly maxReplayBytes = 8 * 1024 * 1024,
  ) { this.inputs = hasAudio ? [video, audio] : [video]; }
  start(): void {
    if (this.mode === 'nvidia') {
      this.inputs[0].on('data', this.captureVideo);
      this.inputs[1]?.on('data', this.captureAudio);
      this.startupTimer = setTimeout(() => this.hardwareFailure('media_hardware_timeout'), this.startupMs);
      this.startupTimer.unref();
    }
    this.startProcess();
  }
  private capture(index: 0 | 1, chunk: Buffer): void {
    if (this.stopped || this.outputStarted || this.mode !== 'nvidia') return;
    if (this.replayBytes + chunk.length > this.maxReplayBytes) {
      // A partial prefix cannot safely seed a decoder. End ownership, then use
      // software on the next explicit view instead of replaying corrupt media.
      this.disableHardware();
      this.diagnostics.mark(this.serial, 'media_hardware_buffer_limit');
      this.fail(); return;
    }
    this.replay[index].push(Buffer.from(chunk)); this.replayBytes += chunk.length;
  }
  private clearReplay(): void {
    this.inputs[0].off('data', this.captureVideo);
    this.inputs[1]?.off('data', this.captureAudio);
    this.replay = [[], []]; this.replayBytes = 0;
    clearTimeout(this.startupTimer);
  }
  private startProcess(): void {
    if (this.stopped) return;
    const process = this.spawnProcess(liveArgs(this.codec, this.hasAudio, this.fps, this.mode));
    this.process = process;
    this.diagnostics.encoder(this.serial, 'media', process);
    const failure = () => {
      if (this.stopped || this.transitioning || this.process !== process) return;
      if (this.mode === 'nvidia') this.hardwareFailure('media_hardware_failed');
      else this.fail();
    };
    process.on('error', failure); process.on('exit', failure);
    const pipes: [Writable, Writable] = [process.stdin!, process.stdio[3] as Writable];
    for (let i = 0; i < this.inputs.length; i++) {
      pipes[i]!.on('error', failure);
      for (const chunk of this.replay[i]!) pipes[i]!.write(chunk);
      this.inputs[i]!.pipe(pipes[i]!);
    }
    if (this.mode === 'software') this.clearReplay();
    process.stdout!.on('data', (chunk: Buffer) => {
      if (this.stopped || this.transitioning || this.process !== process) return;
      if (!this.outputStarted) {
        this.outputStarted = true;
        this.diagnostics.mark(this.serial, this.mode === 'nvidia' ? 'media_active_nvidia' : 'media_active_software');
        this.clearReplay();
      }
      this.output(chunk);
    });
  }
  private hardwareFailure(event: 'media_hardware_failed' | 'media_hardware_timeout'): void {
    if (this.stopped || this.transitioning) return;
    this.disableHardware(); this.diagnostics.mark(this.serial, event);
    if (this.outputStarted) { this.fail(); return; }
    this.transitioning = true;
    clearTimeout(this.startupTimer);
    const process = this.process!;
    for (const input of this.inputs) input?.pause();
    this.unpipe(process);
    const retry = () => {
      clearTimeout(this.cleanupTimer);
      if (this.stopped) return;
      this.transitioning = false; this.mode = 'software';
      this.diagnostics.mark(this.serial, 'media_software_fallback');
      this.startProcess();
    };
    // Wait for confirmed process exit before opening the replacement encoder.
    if (process.exitCode !== null || process.signalCode !== null) retry();
    else {
      process.once('close', retry);
      this.cleanupTimer = setTimeout(() => this.fail(), 1000);
      this.cleanupTimer.unref();
      process.kill('SIGKILL');
    }
  }
  private unpipe(process: ChildProcess): void {
    this.inputs[0].unpipe(process.stdin!);
    if (this.hasAudio) this.inputs[1]!.unpipe(process.stdio[3] as Writable);
    process.stdin?.destroy(); (process.stdio[3] as Writable)?.destroy();
  }
  private fail(): void { if (!this.stopped) { this.stop(); this.failed(); } }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.cleanupTimer); this.clearReplay();
    if (this.process) { this.unpipe(this.process); this.process.kill('SIGKILL'); }
    // Other owned consumers such as JPEG may share these Readables.
    if (this.transitioning) for (const input of this.inputs) input?.resume();
  }
}
