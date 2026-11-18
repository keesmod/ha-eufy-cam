/**
 * AAC-ELD recording audio (#264). Audio type 7 arrives as raw access units,
 * one per frame, without ADTS headers or a decoder config. The client's frame
 * timing gives each unit's offset and length. A helper decodes the units with
 * Fraunhofer FDK AAC, because Debian's FFmpeg has no 16 kHz AAC-ELD tables.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * ER AAC-ELD, 16 kHz, mono, 480-sample frames, no LD-SBR. mega-yfue/eufy-sdk#317
 * reports these bytes from the vendor app's decoder setup for audio type 7, and
 * libfdk's encoder writes exactly them for those settings.
 */
export const ELD_CONFIG = 'f8f03000';
const DECODER = '/usr/local/bin/eufy-eld-decode';
// A download is bounded to 32 MiB and 40 s, about 1,400 units at 30 ms.
const MAX_UNITS = 16384;
const MAX_UNIT_BYTES = 8192;
const DECODE_MS = 15_000;

export type EldOutcome = 'decoded' | 'no_frames' | 'frames_gap' | 'frames_overflow' | 'frames_size'
  | 'frames_mismatch' | 'io' | 'decoder_unavailable' | 'decoder_failed' | 'decoder_output' | 'decode_errors'
  | 'cadence_mismatch' | 'timeout' | 'cancelled' | 'cleanup_unconfirmed';
export interface EldResult {
  outcome: EldOutcome;
  /** Interleaved signed 16-bit little-endian PCM, only when decoded. */
  pcm?: { path: string; rate: number; channels: number };
  units?: number;
  errors?: number;
  exit_code?: number | null;
}
export interface FrameTiming { offset: number; bytes: number; timestampMs: number }

/** The units of one download's audio, in order. Bounded, numbers only. */
export class AudioFrameLog {
  readonly lengths: number[] = [];
  readonly timestamps: number[] = [];
  broken?: 'frames_gap' | 'frames_overflow' | 'frames_size';
  private next = 0;
  /** Runs in the client's P2P receive path, so it only records numbers. */
  readonly add = (timing: FrameTiming): void => {
    if (this.broken) return;
    if (timing.offset !== this.next) this.broken = 'frames_gap';
    else if (!Number.isSafeInteger(timing.bytes) || timing.bytes < 1 || timing.bytes > MAX_UNIT_BYTES) this.broken = 'frames_size';
    else if (this.lengths.length >= MAX_UNITS) this.broken = 'frames_overflow';
    else {
      this.lengths.push(timing.bytes);
      this.timestamps.push(timing.timestampMs);
      this.next += timing.bytes;
    }
  };
  get bytes(): number { return this.next; }
  /**
   * Mean step between the first and last unit timestamps in milliseconds, one
   * decimal, or null. Coarse or repeated stamps still average out over a clip.
   */
  frameMs(): number | null {
    const count = this.timestamps.length;
    if (count < 2) return null;
    const step = (this.timestamps[count - 1]! - this.timestamps[0]!) / (count - 1);
    return Number.isFinite(step) && step > 0 && step < 1000 ? Math.round(step * 10) / 10 : null;
  }
}
// Below 100 units, or with a mean outside this range, the camera's clock says too
// little: stamps quantized to 40 ms move a 100-unit mean by under 1.5 percent.
const CADENCE_UNITS = 100;
const CADENCE_MS = [5, 200] as const;
// 512 samples where the config says 480 run 6.7 percent slow per unit, and the
// helper decodes them without errors, so the tolerance stays below that.
const CADENCE_TOLERANCE = 0.05;

export type EldDecoder = (input: { audio: string; frames: AudioFrameLog; directory: string }, signal: AbortSignal) => Promise<EldResult>;
type Launch = (command: string, args: string[]) => ChildProcess;
const launchHelper: Launch = (command, args) => spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });

/**
 * Writes the units with a 16-bit big-endian length each, runs the helper and
 * checks its report. Any failure leaves the recording without sound, as before.
 */
export function eldDecoder(launch: Launch = launchHelper, timeoutMs = DECODE_MS, cleanupMs = 1000): EldDecoder {
  return async ({ audio, frames, directory }, signal) => {
    if (signal.aborted) return { outcome: 'cancelled' };
    if (frames.broken) return { outcome: frames.broken };
    if (!frames.lengths.length) return { outcome: 'no_frames' };
    const framed = join(directory, 'audio.eld'), pcm = join(directory, 'audio.pcm');
    try {
      const data = await readFile(audio);
      if (data.length !== frames.bytes) return { outcome: 'frames_mismatch' };
      const out = Buffer.alloc(data.length + 2 * frames.lengths.length);
      let from = 0, to = 0;
      for (const length of frames.lengths) {
        out.writeUInt16BE(length, to);
        data.copy(out, to + 2, from, from + length);
        from += length; to += 2 + length;
      }
      await writeFile(framed, out, { mode: 0o600 });
    } catch { return { outcome: 'io' }; }
    const units = frames.lengths.length;
    if (signal.aborted) return { outcome: 'cancelled', units };
    const run = await new Promise<{ outcome?: EldOutcome; code?: number | null; stdout: string }>(resolve => {
      let child: ChildProcess, stdout = '', done = false, stopping: EldOutcome | undefined;
      let cleanup: NodeJS.Timeout | undefined;
      const finish = (value: { outcome?: EldOutcome; code?: number | null }) => {
        if (done) return;
        done = true; clearTimeout(timer); clearTimeout(cleanup); signal.removeEventListener('abort', cancel);
        resolve({ ...value, stdout });
      };
      try { child = launch(process.env.EUFY_ELD_DECODER || DECODER, [ELD_CONFIG, framed, pcm]); }
      catch { resolve({ outcome: 'decoder_unavailable', stdout }); return; }
      // As for FFmpeg, a stop counts once 'close' confirms the helper is gone.
      // Without that confirmation the converter must not start another process.
      const stop = (outcome: EldOutcome) => {
        if (done || stopping) return;
        stopping = outcome; clearTimeout(timer);
        try { child.kill('SIGKILL'); } catch { /* 'close' or the cleanup limit decides. */ }
        cleanup = setTimeout(() => finish({ outcome: 'cleanup_unconfirmed' }), cleanupMs);
      };
      const cancel = () => stop('cancelled');
      const timer = setTimeout(() => stop('timeout'), timeoutMs);
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      child.stdout?.on('data', (chunk: Buffer) => { if (stdout.length < 512) stdout += chunk.toString('latin1').slice(0, 512 - stdout.length); });
      // During a stop an 'error', such as a failed kill, confirms nothing.
      child.on('error', (error: NodeJS.ErrnoException) => {
        if (!stopping) finish({ outcome: error.code === 'ENOENT' ? 'decoder_unavailable' : 'decoder_failed' });
      });
      child.once('close', code => finish(stopping ? { outcome: stopping } : { code }));
    });
    if (run.outcome) return { outcome: run.outcome, units };
    const exit_code = typeof run.code === 'number' && Number.isInteger(run.code) && run.code >= 0 && run.code <= 255 ? run.code : null;
    if (run.code !== 0) return { outcome: 'decoder_failed', units, exit_code };
    const report = /^rate=(\d{1,6}) channels=(\d) frame=(\d{1,5}) units=(\d{1,9}) errors=(\d{1,9})\n?$/.exec(run.stdout);
    if (!report) return { outcome: 'decoder_output', units, exit_code };
    const [rate, channels, frame, decodedUnits, errors] = report.slice(1).map(Number) as [number, number, number, number, number];
    if (decodedUnits !== units || rate < 8000 || rate > 48000 || channels < 1 || channels > 2 || frame < 1)
      return { outcome: 'decoder_output', units, exit_code };
    // A corrupt stream fails most units. Keep it muted.
    if (errors * 10 > units) return { outcome: 'decode_errors', units, errors };
    // Another sample rate decodes without errors at the wrong speed, so the
    // camera's own clock must agree with the config's frame duration.
    const cadence = frames.frameMs(), expected = frame / rate * 1000;
    if (units >= CADENCE_UNITS && cadence !== null && cadence >= CADENCE_MS[0] && cadence <= CADENCE_MS[1]
      && Math.abs(cadence - expected) > expected * CADENCE_TOLERANCE) return { outcome: 'cadence_mismatch', units, errors };
    return { outcome: 'decoded', pcm: { path: pcm, rate, channels }, units, errors };
  };
}
