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
/** Encoder output cap in bits per second, with the VBV window derived from it. */
export interface LiveRateControl { maxrate: number; bufsize: number }
export const defaultLiveRateControl: LiveRateControl = { maxrate: 4_000_000, bufsize: 2_000_000 };
/** Parse EUFY_LIVE_MAX_BITRATE such as 4M or 2500k. Unset keeps the default cap. */
export function liveRateControl(value?: string): LiveRateControl {
  if (value === undefined || value === '') return defaultLiveRateControl;
  const match = /^(\d{1,9})([kKmM]?)$/.exec(value.trim());
  const maxrate = match ? Number(match[1]) * (match[2]!.toLowerCase() === 'm' ? 1_000_000 : match[2]!.toLowerCase() === 'k' ? 1000 : 1) : 0;
  if (!match || maxrate < 200_000 || maxrate > 50_000_000) throw new Error('EUFY_LIVE_MAX_BITRATE must be between 200k and 50M, for example 4M or 2500k');
  return { maxrate, bufsize: Math.round(maxrate / 2) };
}
/**
 * Arrival time drives the output clock. The camera header rate is nominal
 * only: a HomeBase delivers more frames than it announces, and an input -r
 * would count frames at the announced rate so that a WebRTC jitter buffer
 * grows without bound. A raw elementary stream carries no timestamps and
 * FFmpeg 6 discards any the demuxer invents (AVFMT_NOTIMESTAMPS), so each
 * decoded frame is stamped with the wall clock in the filter graph instead,
 * which FFmpeg 5.1 and 6 treat alike. VFR sync in the muxer's 90 kHz time
 * base keeps DTS strictly increasing when several frames arrive in one read.
 */
const wallclockStamp = "setpts='(time(0)-RTCSTART/1000000)/TB'";
export function liveArgs(codec: 'h264' | 'hevc', fps: number, mode: LiveAcceleration, rate: LiveRateControl = defaultLiveRateControl): string[] {
  // FFmpeg writes a key=value progress block to fd 3 once a second. Its
  // stderr stays silent at -loglevel error, so these counters are the only
  // view inside the process.
  const args = ['-hide_banner', '-loglevel', 'error', '-progress', 'pipe:3', '-stats_period', '1', '-threads', '1', '-probesize', '32768', '-analyzeduration', '100000'];
  // Let FFmpeg transfer decoded frames to RAM for the existing software scaler.
  // This needs NVDEC/NVENC, but does not require scale_cuda or libnpp.
  if (mode === 'nvidia') args.push('-hwaccel', 'cuda');
  // The demuxer hint is the nominal rate for rate control only (zero latency
  // x264 budgets the VBV per announced frame), never a timestamp source.
  args.push('-framerate', String(Math.max(1, Math.min(30, Math.round(fps) || 15))));
  // Audio is never muxed here. Waiting for the first AAC frame would hold all
  // video output, and any later audio gap would stall it again. The late audio
  // path delivers AAC frames to a separate reader as soon as they arrive.
  args.push('-f', codec, '-i', 'pipe:0', '-map', '0:v:0');
  if (mode === 'nvidia') args.push('-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'ull', '-zerolatency', '1', '-bf', '0', '-rc', 'cbr', '-b:v', String(rate.maxrate), '-maxrate', String(rate.maxrate), '-bufsize', String(Math.round(rate.maxrate / 4)));
  // A VBV cap keeps keyframe bursts and busy scenes within what a WiFi viewer
  // decodes in time; an unconstrained ultrafast CRF encode does not.
  else args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '26', '-maxrate', String(rate.maxrate), '-bufsize', String(rate.bufsize));
  args.push('-pix_fmt', 'yuv420p', '-vf', `${wallclockStamp},scale='min(1920,iw)':-2`, '-threads', '1', '-g', '30');
  args.push('-fps_mode', 'vfr', '-enc_time_base', '1:90000');
  args.push('-mpegts_flags', '+resend_headers', '-muxdelay', '0', '-muxpreload', '0', '-f', 'mpegts', 'pipe:1');
  return args;
}
/**
 * FFmpeg's -progress counters that the live row keeps, from one block. With
 * the Debian Bookworm FFmpeg 5.1 of the bridge images `frame` counts the
 * frames the video sync handed to the encoder, from 6.1 the packets the muxer
 * wrote. `drop_frames` counts frames the sync dropped, `total_size` the bytes
 * the muxer wrote.
 */
export interface LiveEncoderProgress { frames?: number; dropped?: number; duplicated?: number; out_time_ms?: number; bytes?: number }
const progressKeys = new Map<string, keyof LiveEncoderProgress>([['frame', 'frames'], ['drop_frames', 'dropped'], ['dup_frames', 'duplicated'], ['out_time_us', 'out_time_ms'], ['total_size', 'bytes']]);
const progressLineBytes = 64;
/**
 * Bounded reader of FFmpeg's -progress output. Only whole numbers of the
 * allowlisted keys are kept, capped, and a line longer than any of those
 * pairs is dropped whole, so no FFmpeg text survives. A block is handed on at
 * its progress=continue or progress=end line, also when all its values were
 * N/A, because the block itself shows that FFmpeg still reports.
 */
export function liveProgressParser(emit: (progress: LiveEncoderProgress) => void): (chunk: Buffer) => void {
  let line = '', overlong = false, block: LiveEncoderProgress = {};
  const complete = (text: string) => {
    if (/^progress=(?:continue|end)\r?$/.test(text)) { emit(block); block = {}; return; }
    const pair = /^([a-z_]{1,11})=(\d{1,15})\r?$/.exec(text);
    const key = pair ? progressKeys.get(pair[1]!) : undefined;
    if (!pair || !key) return;
    const value = Number(pair[2]);
    block[key] = Math.min(2147483647, key === 'out_time_ms' ? Math.round(value / 1000) : value);
  };
  return chunk => {
    // latin1 maps each byte to one character, so the bound counts bytes.
    const text = chunk.toString('latin1');
    let start = 0;
    for (let end = text.indexOf('\n'); end !== -1; end = text.indexOf('\n', start)) {
      if (!overlong && line.length + end - start <= progressLineBytes) complete(line + text.slice(start, end));
      line = ''; overlong = false; start = end + 1;
    }
    if (overlong || line.length + text.length - start > progressLineBytes) { line = ''; overlong = true; }
    else line += text.slice(start);
  };
}
export type TranscoderSpawn = (args: string[]) => ChildProcess;
const launch: TranscoderSpawn = args => spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
export class LiveTranscoder {
  private process?: ChildProcess;
  private stopped = false;
  private transitioning = false;
  private outputStarted = false;
  private replay: Buffer[] = [];
  private replayBytes = 0;
  private startupTimer?: NodeJS.Timeout;
  private cleanupTimer?: NodeJS.Timeout;
  private readonly captureVideo = (chunk: Buffer) => this.capture(chunk);
  constructor(
    private readonly serial: string,
    private readonly codec: 'h264' | 'hevc',
    private readonly video: Readable,
    private readonly fps: number,
    private mode: LiveAcceleration,
    private readonly diagnostics: StreamDiagnostics,
    private readonly output: (chunk: Buffer) => void,
    private readonly failed: () => void,
    private readonly disableHardware: () => void,
    private readonly spawnProcess: TranscoderSpawn = launch,
    private readonly startupMs = 5000,
    private readonly maxReplayBytes = 8 * 1024 * 1024,
    private readonly rate: LiveRateControl = defaultLiveRateControl,
    private readonly progress: (value: LiveEncoderProgress) => void = () => {},
  ) {}
  start(): void {
    if (this.mode === 'nvidia') {
      this.video.on('data', this.captureVideo);
      this.startupTimer = setTimeout(() => this.hardwareFailure('media_hardware_timeout'), this.startupMs);
      this.startupTimer.unref();
    }
    this.startProcess();
  }
  private capture(chunk: Buffer): void {
    if (this.stopped || this.outputStarted || this.mode !== 'nvidia') return;
    if (this.replayBytes + chunk.length > this.maxReplayBytes) {
      // A partial prefix cannot safely seed a decoder. End ownership, then use
      // software on the next explicit view instead of replaying corrupt media.
      this.disableHardware();
      this.diagnostics.mark(this.serial, 'media_hardware_buffer_limit');
      this.fail(); return;
    }
    this.replay.push(Buffer.from(chunk)); this.replayBytes += chunk.length;
  }
  private clearReplay(): void {
    this.video.off('data', this.captureVideo);
    this.replay = []; this.replayBytes = 0;
    clearTimeout(this.startupTimer);
  }
  private startProcess(): void {
    if (this.stopped) return;
    const process = this.spawnProcess(liveArgs(this.codec, this.fps, this.mode, this.rate));
    this.process = process;
    this.diagnostics.encoder(this.serial, 'media', process);
    const failure = () => {
      if (this.stopped || this.transitioning || this.process !== process) return;
      if (this.mode === 'nvidia') this.hardwareFailure('media_hardware_failed');
      else this.fail();
    };
    process.on('error', failure); process.on('exit', failure);
    const input = process.stdin as Writable;
    input.on('error', failure);
    for (const chunk of this.replay) input.write(chunk);
    this.video.pipe(input);
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
    // Always drained: a full progress pipe would block FFmpeg's reporting
    // loop. A spawn without a fourth pipe simply reports no progress.
    const pipe = process.stdio[3] as Readable | null | undefined;
    pipe?.on('error', () => {});
    pipe?.on('data', liveProgressParser(value => {
      if (!this.stopped && !this.transitioning && this.process === process) this.progress(value);
    }));
  }
  private hardwareFailure(event: 'media_hardware_failed' | 'media_hardware_timeout'): void {
    if (this.stopped || this.transitioning) return;
    this.disableHardware(); this.diagnostics.mark(this.serial, event);
    if (this.outputStarted) { this.fail(); return; }
    this.transitioning = true;
    clearTimeout(this.startupTimer);
    const process = this.process!;
    this.video.pause();
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
    this.video.unpipe(process.stdin!);
    process.stdin?.destroy();
  }
  private fail(): void { if (!this.stopped) { this.stop(); this.failed(); } }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.cleanupTimer); this.clearReplay();
    if (this.process) { this.unpipe(this.process); this.process.kill('SIGKILL'); }
    // Other owned consumers such as JPEG and late audio may share these Readables.
    if (this.transitioning) this.video.resume();
  }
}
