/** Opt-in, bounded live diagnostics. Never serialize upstream text or identities. */
import type { ChildProcess } from 'node:child_process';
const events = ['start', 'video_input', 'audio_input', 'jpeg_frame', 'media_output', 'media_reader', 'frame_ack', 'viewer_timeout', 'camera_timeout', 'session_end', 'stream_failure', 'no_viewers', 'h264', 'hevc', 'audio_supported', 'audio_absent', 'jpeg_encoder_exit', 'media_encoder_exit', 'jpeg_encoder_error', 'media_encoder_error', 'jpeg_invalid_data', 'media_invalid_data', 'jpeg_decode_error', 'media_decode_error', 'jpeg_encoder_stderr', 'media_encoder_stderr'] as const;
export type DiagnosticEvent = typeof events[number];
export class StreamDiagnostics {
  enabled = false;
  private sequence = 0;
  private sessions = new Map<string, { id: number; start: number; seen: Set<string> }>();
  constructor(private readonly output: (line: string) => void = console.info, private readonly now = () => performance.now()) {}
  begin(serial: string): void {
    if (!this.enabled || this.sessions.size >= 8 && !this.sessions.has(serial)) return;
    this.sessions.set(serial, { id: ++this.sequence, start: this.now(), seen: new Set() });
    this.mark(serial, 'start');
  }
  mark(serial: string, event: DiagnosticEvent): void {
    const session = this.sessions.get(serial);
    if (!this.enabled || !session || !events.includes(event) || session.seen.has(event)) return;
    session.seen.add(event);
    try { this.output(JSON.stringify({ diagnostic: 'live', attempt: session.id, elapsed_ms: Math.round(this.now() - session.start), event })); } catch { /* Diagnostics must not affect camera ownership. */ }
  }
  finish(serial: string): void { this.mark(serial, 'session_end'); this.sessions.delete(serial); }
  encoder(serial: string, kind: 'jpeg' | 'media', process: ChildProcess): void {
    if (!this.enabled) { process.stderr?.resume(); return; }
    // Classify a bounded tail to handle messages split across chunks. Never emit it.
    let tail = '';
    const session = this.sessions.get(serial);
    const mark = (event: DiagnosticEvent) => { if (this.sessions.get(serial) === session) this.mark(serial, event); };
    process.stderr?.on('data', (chunk: Buffer) => {
      tail = (tail + chunk.toString('utf8').slice(-2048)).slice(-2048);
      mark(`${kind}_encoder_stderr`);
      if (/invalid data|invalid nal|invalid argument/i.test(tail)) mark(`${kind}_invalid_data`);
      if (/error while decoding|decode_slice_header error|no frame!/i.test(tail)) mark(`${kind}_decode_error`);
    });
    process.on('error', () => mark(`${kind}_encoder_error`));
    process.on('exit', () => mark(`${kind}_encoder_exit`));
  }
}
