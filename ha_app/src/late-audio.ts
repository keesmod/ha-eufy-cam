/** AAC arriving after video-only startup. Readers join at complete ADTS frames. */
import type { Readable } from 'node:stream';
import { adtsHeader } from './audio-header-diagnostics.js';

export class LateAudio {
  ready = false;
  private stopped = false;
  private header = Buffer.alloc(7);
  private used = 0;
  private frame?: Buffer;
  constructor(private readonly source: Readable, private readonly available: () => void,
    private readonly output: (frame: Buffer) => void, private readonly unavailable: () => void = () => {}) {
    // This owns the existing drain of initially excluded audio. No timer or
    // camera command is needed, and a silent source cannot delay video.
    source.on('data', this.consume);
    source.on('end', this.ended);
  }
  private readonly consume = (chunk: Buffer) => {
    if (this.stopped || !Buffer.isBuffer(chunk)) return;
    let offset = 0;
    while (offset < chunk.length && !this.stopped) {
      if (!this.frame) {
        const size = Math.min(7 - this.used, chunk.length - offset);
        chunk.copy(this.header, this.used, offset, offset + size);
        this.used += size; offset += size;
        if (this.used < 7) return;
        const header = adtsHeader(this.header);
        // An unknown elementary stream must not be advertised as AAC. Keep
        // draining it without retaining payloads or affecting the video owner.
        if (!header) { this.ended(); return; }
        this.frame = Buffer.alloc(header.frame_bytes);
        this.header.copy(this.frame);
      }
      const size = Math.min(this.frame.length - this.used, chunk.length - offset);
      chunk.copy(this.frame, this.used, offset, offset + size);
      this.used += size; offset += size;
      if (this.used === this.frame.length) {
        const frame = this.frame;
        this.frame = undefined; this.used = 0;
        if (!this.ready) { this.ready = true; this.available(); }
        if (!this.stopped) this.output(frame);
      }
    }
  };
  private readonly ended = () => { this.stop(); this.unavailable(); };
  stop(): void {
    this.stopped = true;
    this.ready = false;
    this.source.off('data', this.consume);
    this.source.off('end', this.ended);
    this.header.fill(0); this.frame?.fill(0); this.frame = undefined; this.used = 0;
  }
}
