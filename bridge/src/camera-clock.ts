/**
 * Release live frames on the camera's clock (#230, #231).
 *
 * A camera key frame can take half a second to arrive over P2P while the
 * camera's own timestamps stay even. The live encoder stamps frames with their
 * arrival time, so that pause reached the browser as a freeze every two
 * seconds. Here each frame waits until an anchor plus its camera time plus a
 * fixed playout delay, so the encoder sees the camera's even rhythm.
 *
 * Each track keeps its own anchor: the smallest arrival minus camera time over
 * a sliding window, so the fastest delivery waits the full delay and no frame
 * waits longer. A frame later than its slot leaves at once, and the buffer
 * never holds more than the delay. Video and audio are paced separately,
 * because audio with the same timestamp arrives up to 1.2 s after video, and a
 * shared anchor would delay video by that much as well. Bytes without timing,
 * from before the first frame the library timed or from an older library, pass
 * straight through in order.
 */
import { PassThrough, type Readable } from 'node:stream';

/** Playout delay in milliseconds. It covers the p99 key frame lag of 443 to 555 ms measured in #230. */
export const LIVE_PLAYOUT_DELAY_MS = 700;
const WINDOW_MS = 10_000;
// A camera timestamp that jumps by more than this restarts the track's clock.
const JUMP_MS = 5_000;
// Timings whose bytes have not arrived yet. One second of video holds about 15.
const MAX_TIMINGS = 4_096;

/** The library's timing of one live frame (eufy-mega-client 0.30.3 `LiveFrameTiming`). */
export interface CameraFrameTiming {
  kind: 'video' | 'audio';
  offset: number;
  bytes: number;
  timestampMs: number;
  keyFrame: boolean;
}

/** Parse EUFY_LIVE_SMOOTHING. Unset keeps smoothing on. */
export function liveSmoothing(value: string | undefined): boolean {
  if (value === undefined || value === '' || value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('EUFY_LIVE_SMOOTHING must be true or false');
}

const whole = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;

interface Scheduled { data: Buffer; at: number }

/** One track: pairs the byte stream with the timings by offset and releases each frame at its slot. */
export class TrackPacer {
  readonly output = new PassThrough();
  private readonly timings: { offset: number; bytes: number; timestampMs: number }[] = [];
  private pending: Buffer = Buffer.alloc(0);
  private pendingStart = 0;
  private readonly queue: Scheduled[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private lastRelease = -Infinity;
  private lastTimestamp?: number;
  // Arrival minus camera time, increasing, so the first entry is the window's minimum.
  private window: { at: number; lag: number }[] = [];
  private finished = false;

  constructor(private readonly delayMs = LIVE_PLAYOUT_DELAY_MS, private readonly now: () => number = () => performance.now()) {}

  /** A timing from the library. It arrives before the bytes it describes. */
  timing(offset: unknown, bytes: unknown, timestampMs: unknown): void {
    if (this.finished || !whole(offset, Number.MAX_SAFE_INTEGER) || !whole(bytes, 64 * 1024 * 1024) || bytes === 0 || !whole(timestampMs, Number.MAX_SAFE_INTEGER)) return;
    const last = this.timings.at(-1);
    if (last && offset < last.offset + last.bytes) return;
    this.timings.push({ offset, bytes, timestampMs });
    if (this.timings.length > MAX_TIMINGS) this.timings.shift();
  }

  /** Bytes from the library's stream, in order. */
  data(chunk: Buffer): void {
    if (this.finished || chunk.length === 0) return;
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    this.assign();
  }

  /** The source ended: everything still waiting leaves now. */
  end(): void {
    if (this.finished) return;
    this.flush();
    this.finished = true;
    this.output.end();
  }

  /** The source failed. */
  destroy(error?: Error): void {
    if (this.finished) return;
    this.finished = true;
    this.clearTimer();
    this.queue.length = 0;
    this.output.destroy(error);
  }

  private assign(): void {
    const arrival = this.now();
    while (this.pending.length) {
      const end = this.pendingStart + this.pending.length;
      while ((this.timings[0]?.offset ?? Infinity) < this.pendingStart) this.timings.shift();
      const timing = this.timings[0];
      if (!timing) { this.take(this.pending.length, arrival); return; }
      if (timing.offset > this.pendingStart) { this.take(Math.min(timing.offset, end) - this.pendingStart, arrival); continue; }
      if (end < timing.offset + timing.bytes) return;
      this.timings.shift();
      this.take(timing.bytes, this.slot(timing.timestampMs, arrival));
    }
  }

  /** Move `bytes` from the pending bytes to the release queue at `at`, behind every earlier frame. */
  private take(bytes: number, at: number): void {
    const data = this.pending.subarray(0, bytes);
    this.pending = this.pending.subarray(bytes);
    this.pendingStart += bytes;
    const release = Math.max(at, this.lastRelease);
    this.lastRelease = release;
    this.queue.push({ data, at: release });
    this.schedule();
  }

  private slot(timestampMs: number, arrival: number): number {
    if (this.lastTimestamp !== undefined && Math.abs(timestampMs - this.lastTimestamp) > JUMP_MS) this.window = [];
    this.lastTimestamp = timestampMs;
    const lag = arrival - timestampMs;
    while ((this.window.at(-1)?.lag ?? -Infinity) >= lag) this.window.pop();
    this.window.push({ at: arrival, lag });
    while ((this.window[0]?.at ?? Infinity) < arrival - WINDOW_MS) this.window.shift();
    // The window holds this frame, so its minimum lag is at most this frame's
    // lag and the frame waits at most the playout delay.
    return (this.window[0]?.lag ?? lag) + timestampMs + this.delayMs;
  }

  private schedule(): void {
    const head = this.queue[0];
    if (this.timer || !head) return;
    const wait = head.at - this.now();
    if (wait <= 0) { this.release(); return; }
    this.timer = setTimeout(() => { this.timer = undefined; this.release(); }, Math.ceil(wait));
  }

  private release(): void {
    const now = this.now();
    for (let head = this.queue[0]; head && head.at <= now; head = this.queue[0]) {
      this.queue.shift();
      this.write(head.data);
    }
    this.schedule();
  }

  private flush(): void {
    this.clearTimer();
    if (this.pending.length) this.take(this.pending.length, -Infinity);
    this.clearTimer();
    for (const item of this.queue.splice(0)) this.write(item.data);
  }

  private write(data: Buffer): void {
    if (!this.output.destroyed && !this.output.writableEnded) this.output.write(data);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/** Video and audio of one live stream, each on its own track. */
export class LivePacing {
  private readonly video: TrackPacer;
  private readonly audio: TrackPacer;
  constructor(delayMs = LIVE_PLAYOUT_DELAY_MS, now?: () => number) {
    this.video = new TrackPacer(delayMs, now);
    this.audio = new TrackPacer(delayMs, now);
  }

  /** The `onFrameTiming` callback for the library. Errors cannot reach the library. */
  readonly timing = (timing: CameraFrameTiming): void => {
    if (timing?.kind === 'video') this.video.timing(timing.offset, timing.bytes, timing.timestampMs);
    else if (timing?.kind === 'audio') this.audio.timing(timing.offset, timing.bytes, timing.timestampMs);
  };

  /** Consume the library's streams and return the paced ones in their place. */
  attach(video: Readable, audio: Readable): { video: Readable; audio: Readable } {
    return { video: this.pipe(video, this.video), audio: this.pipe(audio, this.audio) };
  }

  private pipe(source: Readable, track: TrackPacer): Readable {
    source.on('data', (chunk: unknown) => { if (Buffer.isBuffer(chunk)) track.data(chunk); });
    source.once('end', () => track.end());
    source.once('error', (error: Error) => track.destroy(error));
    // The library destroys a replaced stream without ending it. The paced
    // stream then closes the same way, as the library's stream did before.
    source.once('close', () => track.destroy());
    return track.output;
  }
}
