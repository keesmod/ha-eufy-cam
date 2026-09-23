/** Encoded A/V fan-out. Readers cannot start or renew camera ownership. */
import { StreamDiagnostics } from './diagnostics.js';
import { LiveTranscoder, defaultLiveRateControl, type LiveAcceleration, type LiveRateControl } from './live-transcoder.js';
import { LateAudio } from './late-audio.js';
import type { LiveVideoObserver, LiveVideoReaderKind } from './live-video-diagnostics.js';
import type { Readable } from 'node:stream';
import type { ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';

export class MediaRelay {
  private encoders = new Map<string, LiveTranscoder>();
  /**
   * Whether the video encoder behind /v1/media/<grant> exists. That MPEG-TS
   * never carries audio: a joint encoder emits nothing until the first AAC
   * frame and stalls video on every audio gap, so AAC only travels through
   * the late audio reader at /v1/media/<grant>/audio.
   */
  active(serial: string): boolean { return this.encoders.has(serial); }
  acceleration: LiveAcceleration = 'software';
  rateControl: LiveRateControl = defaultLiveRateControl;
  private hardwareFailed = false;
  private readers = new Map<string, Set<ServerResponse>>();
  private audioReaders = new Map<string, Set<ServerResponse>>();
  private lateAudio = new Map<string, LateAudio>();
  lateAudioSupported(serial: string): boolean { return this.lateAudio.get(serial)?.ready === true; }
  private grants = new Map<string, string>();
  private grantReaders = new Map<string, Set<ServerResponse>>();
  /** Per-session observers of output chunks and reader counts. Observation never changes media flow. */
  private observers = new Map<string, LiveVideoObserver>();
  private bridgeDestroyed = new WeakSet<ServerResponse>();
  private startup = new Map<string, { chunks: Buffer[]; bytes: number; timer?: ReturnType<typeof setTimeout> }>();
  constructor(private readonly failed: (serial: string) => void, private readonly diagnostics = new StreamDiagnostics(),
    private readonly audioAvailable: (serial: string) => void = () => {}) {}
  grant(serial: string): string {
    const key = randomBytes(32).toString('hex'); this.grants.set(key, serial); return key;
  }
  revoke(key: string): void {
    const serial = this.grants.get(key);
    this.grants.delete(key);
    for (const reader of this.grantReaders.get(key) ?? []) this.destroyReader(serial, this.readers.get(serial ?? '')?.has(reader) ? 'video' : 'audio', reader, 'revoked');
    this.grantReaders.delete(key);
  }
  /** A destroy by the bridge is counted once, so its later close event is not a client close. */
  private destroyReader(serial: string | undefined, kind: LiveVideoReaderKind, reader: ServerResponse, event: 'backpressure' | 'revoked'): void {
    if (!this.bridgeDestroyed.has(reader)) {
      this.bridgeDestroyed.add(reader);
      if (serial) this.observers.get(serial)?.reader(kind, event);
    }
    reader.destroy();
  }
  serve(key: string, response: ServerResponse): boolean {
    const serial = this.grants.get(key);
    if (!serial) return false;
    const readers = this.readers.get(serial) ?? new Set<ServerResponse>();
    if (readers.size + (this.audioReaders.get(serial)?.size ?? 0) >= 8) return false;
    this.readers.set(serial, readers); readers.add(response);
    const owned = this.grantReaders.get(key) ?? new Set<ServerResponse>();
    this.grantReaders.set(key, owned); owned.add(response);
    this.diagnostics.mark(serial, 'media_reader');
    this.observers.get(serial)?.reader('video', 'attached');
    response.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store' });
    response.on('close', () => { readers.delete(response); owned.delete(response); if (!this.bridgeDestroyed.has(response)) this.observers.get(serial)?.reader('video', 'closed'); });
    // Signaling can still take longer than the first encode. Replay a bounded
    // initial prefix so new readers receive its MPEG-TS headers and keyframe.
    for (const chunk of this.startup.get(serial)?.chunks ?? []) response.write(chunk);
    return true;
  }
  serveAudio(key: string, response: ServerResponse): boolean {
    const serial = this.grants.get(key);
    if (!serial || !this.lateAudioSupported(serial)) return false;
    const readers = this.audioReaders.get(serial) ?? new Set<ServerResponse>();
    if (readers.size + (this.readers.get(serial)?.size ?? 0) >= 8) return false;
    this.audioReaders.set(serial, readers); readers.add(response);
    const owned = this.grantReaders.get(key) ?? new Set<ServerResponse>();
    this.grantReaders.set(key, owned); owned.add(response);
    this.observers.get(serial)?.reader('audio', 'attached');
    response.writeHead(200, { 'Content-Type': 'audio/aac', 'Cache-Control': 'no-store' });
    response.on('close', () => { readers.delete(response); owned.delete(response); if (!this.bridgeDestroyed.has(response)) this.observers.get(serial)?.reader('audio', 'closed'); });
    // Every delivery is a complete frame. New readers need no replay cache.
    return true;
  }
  /**
   * Video goes to its own encoder at once. Audio, whether the library admitted
   * it within its startup deadline or not, is framed and forwarded whenever
   * its first complete ADTS frame arrives, 40 ms or 5 s after video.
   */
  start(serial: string, codec: 'h264' | 'hevc', video: Readable, audio: Readable, fps = 15, observer?: LiveVideoObserver): void {
    if (this.encoders.has(serial)) throw new Error('Duplicate media encoder');
    if (observer) this.observers.set(serial, observer);
    const startup = { chunks: [] as Buffer[], bytes: 0, timer: undefined as ReturnType<typeof setTimeout> | undefined };
    this.startup.set(serial, startup);
    this.lateAudio.set(serial, new LateAudio(audio, () => {
      this.diagnostics.mark(serial, 'audio_late');
      this.audioAvailable(serial);
    }, frame => {
      for (const reader of this.audioReaders.get(serial) ?? []) {
        if (reader.writableLength + frame.length > 256_000) this.destroyReader(serial, 'audio', reader, 'backpressure');
        else reader.write(frame);
      }
    }, () => {
      for (const reader of this.audioReaders.get(serial) ?? []) this.destroyReader(serial, 'audio', reader, 'revoked');
    }));
    const mode = this.hardwareFailed ? 'software' : this.acceleration;
    observer?.encoder(mode);
    const encoder = new LiveTranscoder(serial, codec, video, fps,
      mode, this.diagnostics, (chunk) => {
      if (this.encoders.get(serial) !== encoder) return;
      this.diagnostics.mark(serial, 'media_output');
      observer?.output(chunk.length);
      if (this.startup.get(serial) === startup) {
        if (!startup.timer) {
          startup.timer = setTimeout(() => this.clearStartup(serial), 2000);
          startup.timer.unref();
        }
        if (startup.bytes + chunk.length > 1_000_000) this.clearStartup(serial);
        else { startup.chunks.push(chunk); startup.bytes += chunk.length; }
      }
      for (const reader of this.readers.get(serial) ?? []) {
        // A slow consumer is disconnected instead of holding the camera pipeline.
        if (reader.writableLength > 1_000_000) this.destroyReader(serial, 'video', reader, 'backpressure');
        else reader.write(chunk);
      }
    }, () => { if (this.encoders.get(serial) === encoder) this.failed(serial); },
      () => { this.hardwareFailed = true; }, undefined, undefined, undefined, this.rateControl);
    this.encoders.set(serial, encoder);
    encoder.start();
  }
  /** Audio transport failure ends only its late delivery; video keeps its owner. */
  stopAudio(serial: string): void {
    const audio = this.lateAudio.get(serial);
    if (!audio) return;
    audio.stop(); this.lateAudio.delete(serial);
    for (const reader of this.audioReaders.get(serial) ?? []) this.destroyReader(serial, 'audio', reader, 'revoked');
    this.audioReaders.delete(serial);
  }
  private clearStartup(serial: string): void {
    const startup = this.startup.get(serial);
    clearTimeout(startup?.timer);
    if (startup) { startup.chunks = []; startup.bytes = 0; }
    this.startup.delete(serial);
  }
  stop(serial: string): void {
    const process = this.encoders.get(serial); this.encoders.delete(serial);
    this.stopAudio(serial);
    this.clearStartup(serial);
    process?.stop();
    for (const reader of this.readers.get(serial) ?? []) this.destroyReader(serial, 'video', reader, 'revoked');
    this.readers.delete(serial);
    for (const [key, camera] of this.grants) if (camera === serial) this.revoke(key);
    this.observers.delete(serial);
  }
}
