/** Encoded A/V fan-out. Readers cannot start or renew camera ownership. */
import { StreamDiagnostics } from './diagnostics.js';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';

export class MediaRelay {
  private audioTracks = new Map<string, boolean>();
  audioSupported(serial: string): boolean | undefined { return this.audioTracks.get(serial); }
  private encoders = new Map<string, ChildProcess>();
  private readers = new Map<string, Set<ServerResponse>>();
  private grants = new Map<string, string>();
  private grantReaders = new Map<string, Set<ServerResponse>>();
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
    return true;
  }
  start(serial: string, codec: 'h264' | 'hevc', video: Readable, audio: Readable, hasAudio: boolean, fps = 15): void {
    if (this.encoders.has(serial)) throw new Error('Duplicate media encoder');
    const args = ['-hide_banner', '-loglevel', 'error', '-threads', '1', '-fflags', '+genpts', '-probesize', '1000000', '-analyzeduration', '1000000', '-r', String(Math.max(1, Math.min(30, fps || 15))), '-f', codec, '-i', 'pipe:0'];
    if (hasAudio) args.push('-thread_queue_size', '64', '-f', 'aac', '-i', 'pipe:3');
    args.push('-map', '0:v:0');
    if (hasAudio) args.push('-map', '1:a:0', '-c:a', 'aac', '-b:a', '64k', '-ar', '48000', '-ac', '1');
    args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-vf', "scale='min(1920,iw)':-2", '-threads', '1', '-g', '30');
    args.push('-mpegts_flags', '+resend_headers', '-muxdelay', '0', '-muxpreload', '0', '-f', 'mpegts', 'pipe:1');
    const process = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    this.encoders.set(serial, process);
    this.audioTracks.set(serial, hasAudio);
    this.diagnostics.encoder(serial, 'media', process);
    const failed = () => { if (this.encoders.get(serial) === process) this.failed(serial); };
    process.on('error', failed); process.on('exit', failed);
    process.stdin!.on('error', failed);
    video.pipe(process.stdin!);
    const input = process.stdio[3] as Writable;
    input.on('error', failed);
    if (hasAudio) audio.pipe(input);
    process.stdout!.on('data', (chunk: Buffer) => {
      this.diagnostics.mark(serial, 'media_output');
      for (const reader of this.readers.get(serial) ?? []) {
        // A slow consumer is disconnected instead of holding the camera pipeline.
        if (reader.writableLength > 1_000_000) reader.destroy();
        else reader.write(chunk);
      }
    });
  }
  stop(serial: string): void {
    const process = this.encoders.get(serial); this.encoders.delete(serial);
    this.audioTracks.delete(serial);
    if (process) { process.stdin?.destroy(); (process.stdio[3] as Writable)?.destroy(); process.kill('SIGKILL'); }
    for (const reader of this.readers.get(serial) ?? []) reader.destroy();
    this.readers.delete(serial);
    for (const [key, camera] of this.grants) if (camera === serial) this.revoke(key);
  }
}
