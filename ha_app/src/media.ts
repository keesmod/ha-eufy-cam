/** Encoded A/V fan-out. Readers cannot start or renew camera ownership. */
import { StreamDiagnostics } from './diagnostics.js';
import { LiveTranscoder, type LiveAcceleration } from './live-transcoder.js';
import type { Readable } from 'node:stream';
import type { ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';

export class MediaRelay {
  private audioTracks = new Map<string, boolean>();
  audioSupported(serial: string): boolean | undefined { return this.audioTracks.get(serial); }
  private encoders = new Map<string, LiveTranscoder>();
  acceleration: LiveAcceleration = 'software';
  private hardwareFailed = false;
  private readers = new Map<string, Set<ServerResponse>>();
  private grants = new Map<string, string>();
  private grantReaders = new Map<string, Set<ServerResponse>>();
  private startup = new Map<string, { chunks: Buffer[]; bytes: number; timer?: ReturnType<typeof setTimeout> }>();
  constructor(private readonly failed: (serial: string) => void, private readonly diagnostics = new StreamDiagnostics()) {}
  grant(serial: string): string {
    const key = randomBytes(32).toString('hex'); this.grants.set(key, serial); return key;
  }
  revoke(key: string): void {
    this.grants.delete(key);
    for (const reader of this.grantReaders.get(key) ?? []) reader.destroy();
    this.grantReaders.delete(key);
  }
  serve(key: string, response: ServerResponse): boolean {
    const serial = this.grants.get(key);
    if (!serial) return false;
    const readers = this.readers.get(serial) ?? new Set<ServerResponse>();
    if (readers.size >= 8) return false;
    this.readers.set(serial, readers); readers.add(response);
    const owned = this.grantReaders.get(key) ?? new Set<ServerResponse>();
    this.grantReaders.set(key, owned); owned.add(response);
    this.diagnostics.mark(serial, 'media_reader');
    response.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store' });
    response.on('close', () => { readers.delete(response); owned.delete(response); });
    // Signaling can still take longer than the first encode. Replay a bounded
    // initial prefix so new readers receive its MPEG-TS headers and keyframe.
    for (const chunk of this.startup.get(serial)?.chunks ?? []) response.write(chunk);
    return true;
  }
  start(serial: string, codec: 'h264' | 'hevc', video: Readable, audio: Readable, hasAudio: boolean, fps = 15): void {
    if (this.encoders.has(serial)) throw new Error('Duplicate media encoder');
    const startup = { chunks: [] as Buffer[], bytes: 0, timer: undefined as ReturnType<typeof setTimeout> | undefined };
    this.startup.set(serial, startup);
    this.audioTracks.set(serial, hasAudio);
    const encoder = new LiveTranscoder(serial, codec, video, audio, hasAudio, fps,
      this.hardwareFailed ? 'software' : this.acceleration, this.diagnostics, (chunk) => {
      if (this.encoders.get(serial) !== encoder) return;
      this.diagnostics.mark(serial, 'media_output');
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
        if (reader.writableLength > 1_000_000) reader.destroy();
        else reader.write(chunk);
      }
    }, () => { if (this.encoders.get(serial) === encoder) this.failed(serial); },
      () => { this.hardwareFailed = true; });
    this.encoders.set(serial, encoder);
    encoder.start();
  }
  private clearStartup(serial: string): void {
    const startup = this.startup.get(serial);
    clearTimeout(startup?.timer);
    if (startup) { startup.chunks = []; startup.bytes = 0; }
    this.startup.delete(serial);
  }
  stop(serial: string): void {
    const process = this.encoders.get(serial); this.encoders.delete(serial);
    this.audioTracks.delete(serial);
    this.clearStartup(serial);
    process?.stop();
    for (const reader of this.readers.get(serial) ?? []) reader.destroy();
    this.readers.delete(serial);
    for (const [key, camera] of this.grants) if (camera === serial) this.revoke(key);
  }
}
