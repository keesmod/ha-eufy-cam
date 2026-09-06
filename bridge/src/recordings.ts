import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { EufySecurity, Station, Device, VideoCodec, type StreamMetadata, type DatabaseQueryByDate } from 'eufy-security-client';

import { completeDay, recordingDays } from './history.js';

const LIMIT = 32 * 1024 * 1024;
const TTL = 15 * 60_000;
export class RecordingError extends Error {
  constructor(readonly code: "live_busy" | "live_stopping" | "recording_busy" | "recording_unavailable" | "recording_expired" | "history_incomplete" | "thumbnail_unavailable", readonly status: number) { super(code); }
}
export interface Recording { id: string; start: string; end: string; bytes: number; thumbnail: boolean; serial: string }
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
    const result = await this.timeline([serial], date, signal);
    return { recordings: result.recordings, returned: result.returned };
  }

  async timeline(serials: string[], date: string, signal: AbortSignal): Promise<{recordings: Recording[]; returned: number; complete: true}> {
    const start = new Date(`${date}T12:00:00`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(start.valueOf()) || this.localTime(start).slice(0,10) !== date) throw new Error('Invalid date');
    const end = new Date(start); end.setDate(end.getDate()+1);
    return this.run(signal, async (client, abort) => {
      const stations = await this.stations(client, serials);
      const all: Recording[] = []; let returned = 0;
      const pending = new Map<string, Reference>();
      const now = Date.now();
      for (const [id, ref] of this.references) if (ref.expires <= now) this.references.delete(id);
      for (const station of stations) {
        const opened = !station.isConnected();
        try {
          await this.connected(station, abort); abort.throwIfAborted();
          let records: DatabaseQueryByDate[];
          try { records = await completeDay(station, start, end, abort, () => { this.metrics.queries++; }); }
          catch { throw new RecordingError('history_incomplete', 503); }
          returned += records.length;
          for (const record of records) {
            const serial = record.device_sn;
            if (!serials.includes(serial)) continue;
            if (record.station_sn !== station.getSerial() || typeof record.storage_path !== 'string' || !record.storage_path || record.storage_path.length > 2048 || !Number.isFinite(record.start_time?.valueOf()) || !Number.isFinite(record.end_time?.valueOf())) throw new RecordingError('history_incomplete', 503);
            if (this.localTime(record.start_time).slice(0,10) !== date) continue;
            const id = randomBytes(16).toString('hex');
            pending.set(id, { serial, station, record, expires: now + TTL });
            all.push({ id, serial, start: this.localTime(record.start_time), end: this.localTime(record.end_time), bytes: record.folder_size || 0, thumbnail: typeof record.thumb_path === 'string' && record.thumb_path.length > 0 && record.thumb_path.length <= 2048 });
            if (all.length > 10000) throw new RecordingError('history_incomplete', 503);
          }
        } finally { if (opened || abort.aborted) station.close(); }
      }
      for (const [id, ref] of pending) this.references.set(id, ref);
      while (this.references.size > 20000) this.references.delete(this.references.keys().next().value!);
      return { recordings: all.sort((a,b)=>b.start.localeCompare(a.start) || a.id.localeCompare(b.id)), returned, complete: true };
    });
  }

  private async stations(client: EufySecurity, serials: string[]): Promise<Station[]> {
    if (!serials.length || serials.length > 100) throw new Error('Invalid cameras');
    const result = new Map<string, Station>();
    for (const serial of serials) {
      const device = await client.getDevice(serial);
      const station = await client.getStation(device.getStationSerial());
      result.set(station.getSerial(), station);
    }
    return [...result.values()];
  }

  async calendar(serials: string[], month: string, signal: AbortSignal): Promise<{days: string[]}> {
    const start = new Date(`${month}-01T12:00:00`);
    if (!/^\d{4}-\d{2}$/.test(month) || !Number.isFinite(start.valueOf()) || this.localTime(start).slice(0,7) !== month) throw new Error('Invalid month');
    const end = new Date(start); end.setMonth(end.getMonth()+1);
    return this.run(signal, async (client, abort) => {
      const days = new Set<string>();
      for (const station of await this.stations(client, serials)) {
        const opened = !station.isConnected();
        try {
          await this.connected(station, abort); abort.throwIfAborted();
          this.metrics.queries++;
          for (const day of await recordingDays(station, start, end, abort)) if (day.startsWith(`${month}-`)) days.add(day);
        } finally { if (opened || abort.aborted) station.close(); }
      }
      return { days: [...days].sort() };
    });
  }

  async thumbnail(serial: string, id: string, signal: AbortSignal): Promise<Buffer> {
    const ref = this.references.get(id);
    if (!ref || ref.serial !== serial || ref.expires <= Date.now()) throw new RecordingError('recording_expired', 410);
    const file = ref.record.thumb_path;
    if (typeof file !== 'string' || !file || file.length > 2048) throw new RecordingError('thumbnail_unavailable', 503);
    return this.run(signal, async (_client, abort) => {
      const station = ref.station; const opened = !station.isConnected();
      try {
        await this.connected(station, abort); abort.throwIfAborted();
        return await new Promise<Buffer>((resolve, reject) => {
          const clean = () => { clearTimeout(timer); station.off('image download', received); abort.removeEventListener('abort', fail); };
          const fail = () => { clean(); reject(new RecordingError('thumbnail_unavailable', 503)); };
          const received = (_station: Station, path: string, data: Buffer) => {
            if (path !== file) return;
            if (!Buffer.isBuffer(data) || data.length < 3 || data.length > 2*1024*1024 || data[0] !== 255 || data[1] !== 216 || data[2] !== 255) { fail(); return; }
            clean(); resolve(data);
          };
          const timer = setTimeout(fail, 8000);
          station.on('image download', received); abort.addEventListener('abort', fail, {once:true});
          try { station.downloadImage(file); } catch { fail(); }
        });
      } finally { if (opened || abort.aborted) station.close(); }
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
      } finally { if (abort.aborted) this.metrics.cancelled++; if (opened || abort.aborted) station.close(); }
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
