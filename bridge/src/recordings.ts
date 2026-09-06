import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { EufySecurity, Station, Device, VideoCodec, type StreamMetadata, type DatabaseQueryByDate } from 'eufy-security-client';

const LIMIT = 32 * 1024 * 1024;
const TTL = 15 * 60_000;
export class RecordingError extends Error {
  constructor(readonly code: "live_busy" | "live_stopping" | "recording_busy" | "recording_unavailable" | "recording_expired", readonly status: number) { super(code); }
}
export interface Recording { id: string; start: string; end: string; bytes: number }
interface Reference { serial: string; station: Station; record: DatabaseQueryByDate; expires: number }

/** Existing HomeBase files only. No polling, live capture, guessed paths, or disk cache. */
export class Recordings {
  private references = new Map<string, Reference>();
  private operation?: AbortController;
  readonly metrics = { queries: 0, downloads: 0, completed: 0, cancelled: 0 };
  get busy(): boolean { return this.operation !== undefined; }
  constructor(private client: () => EufySecurity | undefined, private liveBusy: () => boolean | "live_busy" | "live_stopping") {}
  close(): void { this.operation?.abort(); this.references.clear(); }

  private async run<T>(signal: AbortSignal, action: (client: EufySecurity, signal: AbortSignal) => Promise<T>): Promise<T> {
    const client = this.client();
    if (this.busy) throw new RecordingError("recording_busy", 409);
    const live = this.liveBusy();
    if (live) throw new RecordingError(live === "live_stopping" ? "live_stopping" : "live_busy", 409);
    if (!client?.isConnected()) throw new RecordingError("recording_unavailable", 503);
    signal.throwIfAborted();
    const operation = this.operation = new AbortController();
    const abort = () => operation.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 60_000);
    try { return await action(client, operation.signal); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort); if (this.operation === operation) this.operation = undefined; }
  }

  private async connected(station: Station, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (station.isConnected()) return;
    await new Promise<void>((resolve, reject) => {
      const clean = () => { clearTimeout(timer); station.off('connect', done); signal.removeEventListener('abort', abort); };
      const done = () => { clean(); resolve(); };
      const abort = () => { clean(); reject(new Error('Recording connection cancelled')); };
      const timer = setTimeout(abort, 18_000);
      station.once('connect', done); signal.addEventListener('abort', abort, { once: true });
      void station.connect().catch(abort);
    });
  }

  async list(serial: string, date: string, signal: AbortSignal): Promise<{ recordings: Recording[]; returned: number }> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid date');
    const start = new Date(`${date}T12:00:00`);
    if (Number.isNaN(start.valueOf()) || `${start.getFullYear()}-${String(start.getMonth()+1).padStart(2,'0')}-${String(start.getDate()).padStart(2,'0')}` !== date) throw new Error('Invalid date');
    const end = new Date(start); end.setDate(end.getDate() + 1);
    return this.run(signal, async (client, abort) => {
      const device = await client.getDevice(serial);
      const station = await client.getStation(device.getStationSerial());
      const opened = !station.isConnected();
      try {
        await this.connected(station, abort); abort.throwIfAborted();
        this.metrics.queries++;
        const records = await new Promise<DatabaseQueryByDate[]>((resolve, reject) => {
          const clean = () => { clearTimeout(timer); station.off('database query by date', received); abort.removeEventListener('abort', cancelled); };
          const cancelled = () => { clean(); reject(new Error('History query cancelled or timed out')); };
          const received = (_station: Station, code: number, data: DatabaseQueryByDate[]) => { clean(); if (code !== 0 || !Array.isArray(data) || data.length > 1000) reject(new Error('History query rejected')); else resolve(data); };
          const timer = setTimeout(cancelled, 20_000);
          station.on('database query by date', received); abort.addEventListener('abort', cancelled, { once: true });
          // Upstream PR #768, confirmed on T8030 / 3.8.6.0: all cameras, [day,next day].
          try { station.databaseQueryByDate([], start, end); } catch { cancelled(); }
        });
        const now = Date.now();
        for (const [id, ref] of this.references) if (ref.expires <= now) this.references.delete(id);
        const result: Recording[] = [];
        for (const record of records) {
          if (record.device_sn !== serial || record.station_sn !== station.getSerial() || !record.storage_path || typeof record.storage_path !== 'string' || record.storage_path.length > 2048 || !Number.isFinite(record.start_time?.valueOf()) || !Number.isFinite(record.end_time?.valueOf())) continue;
          const id = randomBytes(16).toString('hex');
          this.references.set(id, { serial, station, record, expires: now + TTL });
          result.push({ id, start: this.localTime(record.start_time), end: this.localTime(record.end_time), bytes: record.folder_size });
        }
        while (this.references.size > 1000) this.references.delete(this.references.keys().next().value!);
        return { recordings: result, returned: records.length };
      } finally { if (opened) station.close(); }
    });
  }
  private localTime(date: Date): string {
    // SDK parses the station's wall-clock text in the bridge timezone. Keep its calendar values.
    const p = (v: number) => String(v).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth()+1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
  }

  async video(serial: string, id: string, signal: AbortSignal): Promise<Buffer> {
    const ref = this.references.get(id);
    if (!ref || ref.serial !== serial || ref.expires <= Date.now()) throw new RecordingError("recording_expired", 410);
    return this.run(signal, async (client, abort) => {
      const device = await client.getDevice(serial); const station = ref.station;
      const opened = !station.isConnected();
      try {
        await this.connected(station, abort); abort.throwIfAborted();
        this.metrics.downloads++;
        const source = await this.download(station, device, ref.record, abort);
        const mp4 = await muxRecording(source.metadata, source.video, source.audio, abort);
        this.metrics.completed++;
        return mp4;
      } finally { if (abort.aborted) this.metrics.cancelled++; if (opened) station.close(); }
    });
  }

  private download(station: Station, device: Device, record: DatabaseQueryByDate, signal: AbortSignal): Promise<{metadata: StreamMetadata; video: Buffer; audio: Buffer}> {
    return new Promise((resolve, reject) => {
      let metadata: StreamMetadata | undefined; let size = 0; let done = false;
      const video: Buffer[] = []; const audio: Buffer[] = []; const streams: Readable[] = [];
      const cleanup = () => {
        clearTimeout(timer); signal.removeEventListener('abort', cancelled);
        station.off('download start', started); station.off('download finish', finished); station.off('command result', command);
      };
      const fail = () => { if (done) return; done = true; cleanup(); try { station.cancelDownload(device); } catch {} for (const s of streams) s.resume(); reject(new Error('Recording download failed or cancelled')); };
      const cancelled = () => fail();
      const take = (target: Buffer[], chunk: Buffer) => { if (done) return; size += chunk.length; if (size > LIMIT) fail(); else target.push(chunk); };
      const started = (_station: Station, channel: number, info: StreamMetadata, v: Readable, a: Readable) => {
        if (channel !== device.getChannel() || metadata) { v.resume(); a.resume(); fail(); return; }
        metadata = info; streams.push(v, a);
        v.on('data', b => take(video, b)); a.on('data', b => take(audio, b)); v.once('error', fail); a.once('error', fail);
      };
      const finished = (_station: Station, channel: number) => {
        if (channel !== device.getChannel()) return;
        if (!metadata || !video.length) { fail(); return; }
        done = true; cleanup(); resolve({ metadata, video: Buffer.concat(video), audio: Buffer.concat(audio) });
      };
      const command = (_station: Station, result: {command_type: number; return_code: number}) => { if (result.command_type === 1024 && result.return_code !== 0) fail(); };
      const timer = setTimeout(fail, 40_000);
      station.on('download start', started); station.on('download finish', finished); station.on('command result', command);
      signal.addEventListener('abort', cancelled, { once: true });
      void station.startDownload(device, record.storage_path, record.cipher_id).catch(fail);
    });
  }
}

export async function muxRecording(metadata: StreamMetadata, video: Buffer, audio: Buffer, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  const codec = metadata.videoCodec === VideoCodec.H264 ? 'h264' : metadata.videoCodec === VideoCodec.H265 ? 'hevc' : null;
  if (!codec) throw new Error('Unsupported recording codec');
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner','-loglevel','error','-threads','2','-r',String(metadata.videoFPS || 15),'-f',codec,'-i','pipe:0'];
    if (audio.length) args.push('-f','aac','-i','pipe:3');
    args.push('-map','0:v:0','-c:v',codec === 'h264' ? 'copy' : 'libx264');
    if (codec === 'hevc') args.push('-preset','veryfast','-pix_fmt','yuv420p','-threads','2');
    if (audio.length) args.push('-map','1:a:0','-c:a','aac','-b:a','64k');
    args.push('-movflags','frag_keyframe+empty_moov+default_base_moof','-f','mp4','pipe:1');
    const process = spawn('ffmpeg', args, { stdio: ['pipe','pipe','pipe','pipe'] });
    const parts: Buffer[] = []; let size = 0; let settled = false;
    const fail = () => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', fail); process.kill('SIGKILL'); reject(new Error('Recording conversion failed')); };
    const timer = setTimeout(fail, 20_000); signal.addEventListener('abort', fail, { once: true });
    process.stdout!.on('data', (b: Buffer) => { size += b.length; if (size > LIMIT) fail(); else parts.push(b); });
    process.stderr!.resume(); process.once('error', fail);
    process.once('close', code => { if (settled) return; if (code !== 0 || !size) { fail(); return; } settled = true; clearTimeout(timer); signal.removeEventListener('abort', fail); resolve(Buffer.concat(parts)); });
    process.stdin!.on('error', fail); process.stdin!.end(video);
    const input = process.stdio[3] as import('node:stream').Writable; input.on('error', fail); input.end(audio);
  });
}
