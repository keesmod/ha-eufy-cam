/** Bounded JPEG framing for arbitrarily fragmented FFmpeg stdout. */
export class JpegFramer {
  private buffer: Buffer = Buffer.alloc(0);
  constructor(private readonly emit: (jpeg: Buffer) => void) {}
  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > 1_048_576) throw new Error("Encoder frame exceeds limit");
    for (;;) {
      const start = this.buffer.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) { this.buffer = this.buffer.subarray(-1); return; }
      const end = this.buffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end < 0) { this.buffer = this.buffer.subarray(start); return; }
      const frame = this.buffer.subarray(start, end + 2);
      this.buffer = this.buffer.subarray(end + 2);
      if (frame.length > 256_000) throw new Error("JPEG exceeds transport limit");
      this.emit(frame);
    }
  }
}
