/**
 * AAC-ELD live audio (#269). The Video Doorbell S4 sends live audio type 7 as
 * raw AAC-ELD units, one per P2P audio message, without ADTS headers. The late
 * audio reader takes only ADTS, so this stage splits the audio at the client's
 * frame timing, decodes the units as a stream with the FDK AAC helper of #264
 * and lets FFmpeg encode the PCM to ADTS AAC-LC. Every failure ends only this
 * audio, which leaves live video without sound as before. Video never waits
 * for it, and the source is never paused.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { PassThrough, type Readable } from 'node:stream';
import { ELD_CONFIG, eldDecoderCommand } from './eld-audio.js';

/** The PCM that ELD_CONFIG decodes to: 16 kHz, mono, 480 samples per unit. */
export const ELD_PCM = { rate: 16000, channels: 1, frame: 480 } as const;
const UNIT_PCM_BYTES = ELD_PCM.frame * ELD_PCM.channels * 2;
// The helper's limit. A 16-bit length prefix carries it.
const MAX_UNIT_BYTES = 8192;
// Timed units whose bytes have not passed yet. Pacing holds about 700 ms, some 25 units.
const MAX_PENDING_UNITS = 1024;
/**
 * How long a unit written to the helper may wait for its PCM. The helper
 * answers each unit within a millisecond, so only a stalled helper or encoder
 * reaches this, and then the audio ends instead of falling further behind. A
 * burst after a P2P stall arrives in one go, so the bound is time, not count.
 */
const MAX_LAG_MS = 2000;
// Units waiting for their PCM at most, about two minutes of audio, as a memory bound.
const MAX_WAITING_UNITS = 4096;
const CLEANUP_MS = 1000;

const whole = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * The audio track's unit boundaries from the client's frame timing. A timing
 * arrives before its bytes, also when pacing holds the bytes back, and pacing
 * keeps every byte at its position, so the offsets fit both streams.
 */
export class LiveAudioUnits {
  broken?: 'frames_size' | 'frames_overflow';
  /** Bytes that no timing covered, dropped. */
  skipped = 0;
  private timings: { offset: number; bytes: number }[] = [];
  private pending: Buffer = Buffer.alloc(0);
  private position = 0;
  private closed = false;
  private stamps = 0;
  private firstStamp = 0;
  private lastStamp = 0;
  /** The audio part of `onFrameTiming`. It runs in the P2P receive path, so it only records numbers. */
  readonly timing = (timing: { kind?: unknown; offset?: unknown; bytes?: unknown; timestampMs?: unknown }): void => {
    if (this.closed || this.broken || timing?.kind !== 'audio') return;
    const { offset, bytes, timestampMs } = timing;
    if (!whole(offset) || !whole(bytes)) return;
    const last = this.timings.at(-1);
    if (last && offset < last.offset + last.bytes) return;
    if (bytes < 1 || bytes > MAX_UNIT_BYTES) this.broken = 'frames_size';
    else if (this.timings.length >= MAX_PENDING_UNITS) this.broken = 'frames_overflow';
    else {
      this.timings.push({ offset, bytes });
      if (whole(timestampMs)) {
        if (!this.stamps) this.firstStamp = timestampMs;
        this.lastStamp = timestampMs;
        this.stamps++;
      }
    }
  };
  /**
   * Mean step of the camera's clock between the first and the last timed unit
   * in milliseconds, one decimal, or null. Units lost on the way lengthen it,
   * so it shows the config's 30 ms only as an upper bound.
   */
  frameMs(): number | null {
    if (this.stamps < 2) return null;
    const step = (this.lastStamp - this.firstStamp) / (this.stamps - 1);
    return Number.isFinite(step) && step > 0 && step < 1000 ? Math.round(step * 10) / 10 : null;
  }
  /** The complete units in the bytes so far, in order. */
  split(chunk: Buffer): Buffer[] {
    const units: Buffer[] = [];
    if (this.closed) return units;
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    while (this.pending.length) {
      while (this.timings.length && this.timings[0]!.offset < this.position) this.timings.shift();
      const next = this.timings[0];
      if (!next) { this.drop(this.pending.length); break; }
      if (next.offset > this.position) { this.drop(Math.min(next.offset - this.position, this.pending.length)); continue; }
      if (this.pending.length < next.bytes) break;
      units.push(this.pending.subarray(0, next.bytes));
      this.pending = this.pending.subarray(next.bytes);
      this.position += next.bytes;
      this.timings.shift();
    }
    return units;
  }
  /** No further units are needed, for ADTS audio or after the stage stopped. */
  close(): void {
    this.closed = true;
    this.timings = [];
    this.pending = Buffer.alloc(0);
  }
  private drop(bytes: number): void {
    this.pending = this.pending.subarray(bytes);
    this.position += bytes;
    this.skipped += bytes;
  }
}

export type LiveEldOutcome = 'ended' | 'frames_size' | 'frames_overflow' | 'backlog' | 'decoder_unavailable'
  | 'decoder_failed' | 'decode_errors' | 'encoder_unavailable' | 'encoder_failed';
/** One bridge log line per live session whose audio went through the decoder. Numbers only. */
export interface LiveEldReport {
  diagnostic: 'live_audio';
  event: 'eld_decode';
  outcome: LiveEldOutcome;
  /** Units written to the helper. */
  units: number;
  /** Units the helper could not decode, from its report every 100 units or its exit with code 7. */
  errors?: number;
  /** Mean step of the camera clock per unit, see LiveAudioUnits.frameMs. */
  frame_ms?: number;
  /** The exit code of the process that ended the decoding. */
  exit_code?: number;
  /** ADTS bytes handed to the late audio reader. */
  output_bytes: number;
  first_output_ms?: number;
  duration_ms: number;
  skipped_bytes: number;
  /** Both processes closed within the cleanup limit. */
  stop_confirmed: boolean;
}
export type LiveEldLaunch = (command: string, args: string[]) => ChildProcess;
export interface LiveEldOptions {
  launch?: LiveEldLaunch;
  log?: (report: LiveEldReport) => void;
  now?: () => number;
  cleanupMs?: number;
}

const launchProcess: LiveEldLaunch = (command, args) => spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });

/** A normal end is information, any other outcome a warning, like recording input that the bridge adjusted. */
export function logLiveEld(report: LiveEldReport, warning: (line: string) => void = console.warn,
  info: (line: string) => void = console.info): void {
  (report.outcome === 'ended' && report.stop_confirmed ? info : warning)(JSON.stringify(report));
}

/**
 * FFmpeg reads the helper's PCM and writes each AAC-LC frame at once. The
 * format is given, so FFmpeg probes nothing, and its AAC encoder holds about
 * two frames of 64 ms. The bit rate is that of decoded recording audio.
 */
export function liveEldEncoderArgs(): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-fflags', 'nobuffer', '-probesize', '32', '-analyzeduration', '0',
    '-f', 's16le', '-ar', String(ELD_PCM.rate), '-ac', String(ELD_PCM.channels), '-i', 'pipe:0',
    '-c:a', 'aac', '-b:a', '64k', '-f', 'adts', '-flush_packets', '1', 'pipe:1'];
}

/**
 * Takes the place of the live audio stream. The first audio bytes decide: with
 * the codec `aac-eld` the units go through the helper and FFmpeg, and `output`
 * carries ADTS AAC-LC. Any other codec passes through unchanged.
 */
export class LiveEldAudio {
  readonly output = new PassThrough();
  private state: 'deciding' | 'passthrough' | 'decoding' | 'stopped' = 'deciding';
  private decoder?: ChildProcess;
  private encoder?: ChildProcess;
  private readonly closing = new Map<ChildProcess, Promise<void>>();
  private stopping?: Promise<boolean>;
  private sourceDone = false;
  private started = 0;
  private written = 0;
  private pcmBytes = 0;
  /** Write times of the units whose PCM has not come back, oldest first. */
  private waiting: number[] = [];
  private answered = 0;
  private outputBytes = 0;
  private firstOutputMs?: number;
  private status = '';
  private errors?: number;
  private exitCode?: number;
  private outcome: LiveEldOutcome = 'ended';
  private readonly launch: LiveEldLaunch;
  private readonly log: (report: LiveEldReport) => void;
  private readonly now: () => number;
  private readonly cleanupMs: number;

  constructor(private readonly source: Readable, private readonly units: LiveAudioUnits,
    private readonly codec: () => unknown, options: LiveEldOptions = {}) {
    this.launch = options.launch ?? launchProcess;
    this.log = options.log ?? (report => logLiveEld(report));
    this.now = options.now ?? (() => performance.now());
    this.cleanupMs = options.cleanupMs ?? CLEANUP_MS;
    // As with the paced streams, an error reaches consumers through their own
    // listeners and never the process as an uncaught exception.
    this.output.on('error', () => {});
    source.on('data', this.consume);
    source.once('end', this.sourceEnded);
    source.once('error', this.sourceFailed);
    // The library destroys a replaced stream without ending it.
    source.once('close', this.sourceClosed);
  }

  /**
   * Stops the processes once. Resolves true when both closed, false after the
   * cleanup limit. Before any audio, or for audio that passes through, there
   * is nothing to stop.
   */
  stop(): Promise<boolean> {
    if (this.state === 'deciding') { this.state = 'stopped'; this.units.close(); }
    if (this.state === 'decoding') this.end('ended');
    return this.stopping ?? Promise.resolve(true);
  }

  private readonly consume = (chunk: unknown): void => {
    if (!Buffer.isBuffer(chunk) || chunk.length === 0) return;
    if (this.state === 'deciding') this.decide();
    if (this.state === 'passthrough') { this.output.write(chunk); return; }
    // After a failure the source keeps draining here, as LateAudio drains a
    // stream that is not ADTS, without keeping its bytes.
    if (this.state !== 'decoding') return;
    if (this.units.broken) { this.fail(this.units.broken); return; }
    for (const unit of this.units.split(chunk)) if (!this.write(unit)) return;
  };

  private decide(): void {
    let eld = false;
    try { eld = this.codec() === 'aac-eld'; } catch { /* An unreadable codec keeps the previous path. */ }
    if (!eld) { this.state = 'passthrough'; this.units.close(); return; }
    this.state = 'decoding';
    this.started = this.now();
    const decoder = this.start(eldDecoderCommand(), ['--stream', ELD_CONFIG, String(ELD_PCM.rate), String(ELD_PCM.channels)], 'decoder');
    if (!decoder) return;
    this.decoder = decoder;
    const encoder = this.start('ffmpeg', liveEldEncoderArgs(), 'encoder');
    if (!encoder) return;
    this.encoder = encoder;
    decoder.stderr?.on('data', (chunk: Buffer) => {
      // latin1 keeps one character per byte, and the tail stays bounded.
      this.status = (this.status + chunk.toString('latin1')).slice(-64);
      const reports = [...this.status.matchAll(/units=(\d{1,9}) errors=(\d{1,9})\n/g)];
      if (reports.length) this.errors = Number(reports.at(-1)![2]);
    });
    decoder.stdout?.on('data', (chunk: Buffer) => {
      this.pcmBytes += chunk.length;
      const answered = Math.min(this.written, Math.floor(this.pcmBytes / UNIT_PCM_BYTES));
      this.waiting.splice(0, answered - this.answered);
      this.answered = answered;
    });
    if (decoder.stdout && encoder.stdin) decoder.stdout.pipe(encoder.stdin);
    encoder.stdout?.on('data', (chunk: Buffer) => {
      if (this.state !== 'decoding') return;
      this.firstOutputMs ??= Math.max(0, Math.round(this.now() - this.started));
      this.outputBytes += chunk.length;
      this.output.write(chunk);
    });
    encoder.stderr?.resume();
  }

  /**
   * Launches one process and records when it is gone. Its end, or an error,
   * ends the decoding unless the stage already stopped it.
   */
  private start(command: string, args: string[], role: 'decoder' | 'encoder'): ChildProcess | undefined {
    const outcomes = role === 'decoder'
      ? { unavailable: 'decoder_unavailable', failed: 'decoder_failed' } as const
      : { unavailable: 'encoder_unavailable', failed: 'encoder_failed' } as const;
    let child: ChildProcess;
    try { child = this.launch(command, args); }
    catch { this.fail(outcomes.unavailable); return undefined; }
    this.closing.set(child, new Promise<void>(resolve => {
      child.on('error', (error: NodeJS.ErrnoException) => {
        // A process that failed to spawn does not exist.
        if (child.pid === undefined) resolve();
        this.fail(error.code === 'ENOENT' ? outcomes.unavailable : outcomes.failed);
      });
      child.once('close', (code: number | null) => {
        resolve();
        this.fail(role === 'decoder' && code === 7 ? 'decode_errors' : outcomes.failed, code);
      });
    }));
    // A pipe that breaks when its process ends reports through 'close' above.
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.on('error', () => {});
    return child;
  }

  /** Writes one unit behind its 16-bit big-endian length, or ends the audio when the helper fell behind. */
  private write(unit: Buffer): boolean {
    const now = this.now();
    if (this.waiting.length >= MAX_WAITING_UNITS || (this.waiting.length && now - this.waiting[0]! > MAX_LAG_MS)) {
      this.fail('backlog');
      return false;
    }
    const stdin = this.decoder?.stdin;
    // A helper that is gone reports through 'close'.
    if (!stdin?.writable) return true;
    const framed = Buffer.allocUnsafe(2 + unit.length);
    framed.writeUInt16BE(unit.length, 0);
    unit.copy(framed, 2);
    stdin.write(framed);
    this.written++;
    this.waiting.push(now);
    return true;
  }

  /** A failure ends the output, so the late audio reader stops and video goes on without sound. */
  private fail(outcome: LiveEldOutcome, code?: number | null): void {
    if (this.state !== 'decoding') return;
    this.end(outcome, code);
    if (!this.output.writableEnded && !this.output.destroyed) this.output.end();
  }

  private end(outcome: LiveEldOutcome, code?: number | null): void {
    this.state = 'stopped';
    this.outcome = outcome;
    if (typeof code === 'number' && Number.isInteger(code) && code >= 0 && code <= 255) this.exitCode = code;
    this.units.close();
    this.waiting = [];
    const stopped = this.now();
    const children = [...this.closing.keys()];
    if (this.decoder?.stdout && this.encoder?.stdin) this.decoder.stdout.unpipe(this.encoder.stdin);
    for (const child of children) {
      child.stdin?.destroy();
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL'); } catch { /* 'close' or the cleanup limit decides. */ }
      }
    }
    this.stopping = new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), this.cleanupMs);
      void Promise.all(children.map(child => this.closing.get(child))).then(() => { clearTimeout(timer); resolve(true); });
    }).then(confirmed => {
      try { this.log(this.report(confirmed, stopped)); } catch { /* Logging cannot affect playback. */ }
      return confirmed;
    });
  }

  private report(confirmed: boolean, stopped: number): LiveEldReport {
    const frameMs = this.units.frameMs();
    return {
      diagnostic: 'live_audio', event: 'eld_decode', outcome: this.outcome, units: this.written,
      ...(this.errors === undefined ? {} : { errors: this.errors }),
      ...(frameMs === null ? {} : { frame_ms: frameMs }),
      ...(this.exitCode === undefined ? {} : { exit_code: this.exitCode }),
      output_bytes: this.outputBytes,
      ...(this.firstOutputMs === undefined ? {} : { first_output_ms: this.firstOutputMs }),
      duration_ms: Math.max(0, Math.round(stopped - this.started)),
      skipped_bytes: this.units.skipped, stop_confirmed: confirmed,
    };
  }

  private readonly sourceEnded = (): void => {
    if (this.sourceDone) return;
    this.sourceDone = true;
    if (this.state === 'decoding') this.end('ended');
    if (!this.output.writableEnded && !this.output.destroyed) this.output.end();
  };

  private readonly sourceFailed = (error: Error): void => {
    if (this.sourceDone) return;
    this.sourceDone = true;
    if (this.state === 'decoding') this.end('ended');
    if (!this.output.writableEnded && !this.output.destroyed) this.output.destroy(error);
  };

  private readonly sourceClosed = (): void => {
    if (this.sourceDone) return;
    this.sourceDone = true;
    if (this.state === 'decoding') this.end('ended');
    if (!this.output.writableEnded && !this.output.destroyed) this.output.destroy();
  };
}
