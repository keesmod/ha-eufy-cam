/** Structural audio evidence. Keep only a seven-byte window, never frame payloads. */
const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
export interface AdtsHeader {
  mpeg_version: 2 | 4;
  object_type: number;
  sample_rate_hz: number;
  channel_config: number;
  crc_present: boolean;
  frame_bytes: number;
  raw_data_blocks: number;
}
export function adtsHeader(p: Uint8Array): AdtsHeader | undefined {
  if (p.length < 7 || p[0] !== 0xff || (p[1]! & 0xf6) !== 0xf0) return;
  const rate = rates[(p[2]! >> 2) & 15];
  const bytes = ((p[3]! & 3) << 11) | (p[4]! << 3) | (p[5]! >> 5);
  const crc = (p[1]! & 1) === 0;
  if (!rate || bytes < (crc ? 9 : 7)) return;
  return {
    mpeg_version: p[1]! & 8 ? 2 : 4,
    object_type: (p[2]! >> 6) + 1,
    sample_rate_hz: rate,
    channel_config: ((p[2]! & 1) << 2) | (p[3]! >> 6),
    crc_present: crc, frame_bytes: bytes, raw_data_blocks: (p[6]! & 3) + 1,
  };
}
export interface AudioHeaderReport {
  inspected_bytes: number;
  inspection_limited: boolean;
  format_hint?: 'adts' | 'loas' | 'adif' | 'ogg' | 'riff' | 'unknown';
  adts?: AdtsHeader;
  first_adts?: AdtsHeader;
  adts_frames: number;
  adts_header_changes: number;
  adts_multiblock_frames: number;
  skipped_bytes: number;
  pending_frame_bytes: number;
  trailing_header_bytes: number;
  adts_min_frame_bytes?: number;
  adts_max_frame_bytes?: number;
}
export class AudioHeaderDiagnostics {
  private window = Buffer.alloc(7);
  private used = 0;
  private remaining = 0;
  private report: AudioHeaderReport = {
    inspected_bytes: 0, inspection_limited: false, adts_frames: 0,
    adts_header_changes: 0, adts_multiblock_frames: 0, skipped_bytes: 0,
    pending_frame_bytes: 0, trailing_header_bytes: 0,
  };
  // Bound both scanning and frame inspection independently of stream duration.
  constructor(private readonly maxBytes = 262144, private readonly maxFrames = 128) {}
  write(chunk: Buffer): void {
    let i = 0;
    while (i < chunk.length) {
      if (this.report.inspected_bytes >= this.maxBytes || this.report.adts_frames >= this.maxFrames) {
        this.report.inspection_limited = true;
        break;
      }
      if (this.remaining) {
        const n = Math.min(this.remaining, chunk.length - i, this.maxBytes - this.report.inspected_bytes);
        this.remaining -= n; i += n; this.report.inspected_bytes += n;
        if (!this.remaining) this.report.adts_frames++;
        continue;
      }
      this.window[this.used++] = chunk[i++]!;
      this.report.inspected_bytes++;
      if (this.used < 7) continue;
      const p = this.window;
      const header = adtsHeader(p);
      if (!this.report.format_hint) {
        this.report.format_hint = header ? 'adts'
          : p[0] === 0x56 && (p[1]! & 0xe0) === 0xe0 ? 'loas'
          : p.subarray(0, 4).equals(Buffer.from('ADIF')) ? 'adif'
          : p.subarray(0, 4).equals(Buffer.from('OggS')) ? 'ogg'
          : p.subarray(0, 4).equals(Buffer.from('RIFF')) ? 'riff' : 'unknown';
      }
      if (header) {
        const previous = this.report.adts;
        if (previous && ['mpeg_version', 'object_type', 'sample_rate_hz', 'channel_config', 'crc_present']
          .some(key => previous[key as keyof AdtsHeader] !== header[key as keyof AdtsHeader])) this.report.adts_header_changes++;
        // Retain the latest structural configuration and extrema, not every frame.
        this.report.first_adts ??= header;
        this.report.adts = header;
        this.report.adts_min_frame_bytes = Math.min(this.report.adts_min_frame_bytes ?? header.frame_bytes, header.frame_bytes);
        this.report.adts_max_frame_bytes = Math.max(this.report.adts_max_frame_bytes ?? 0, header.frame_bytes);
        if (header.raw_data_blocks > 1) this.report.adts_multiblock_frames++;
        this.remaining = header.frame_bytes - 7;
        if (!this.remaining) this.report.adts_frames++;
        this.used = 0;
        p.fill(0);
      } else {
        p.copyWithin(0, 1);
        this.used = 6;
        this.report.skipped_bytes++;
      }
    }
    if (this.report.inspected_bytes >= this.maxBytes || this.report.adts_frames >= this.maxFrames) this.report.inspection_limited = true;
  }
  snapshot(): AudioHeaderReport {
    return { ...this.report, pending_frame_bytes: this.remaining, trailing_header_bytes: this.used,
      ...(this.report.adts ? { adts: { ...this.report.adts } } : {}),
      ...(this.report.first_adts ? { first_adts: { ...this.report.first_adts } } : {}) };
  }
  clear(): void { this.window.fill(0); }
}
