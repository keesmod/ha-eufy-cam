import { randomBytes } from 'node:crypto';
import {
  EufyError,
  type EufyMegaClient,
  type Device,
  type Recording as MegaRecording,
  type RecordingDownload,
} from '@keesmod/eufy-mega-client';
import { RecordingError } from './errors.js';
import { muxRecording } from './recording-media.js';
import type { BackendRecordings, Recording } from './backend.js';

/** Keeps bridge handles, conversion and limits stable across both backends. */
export class MegaRecordings implements BackendRecordings {
  private operation?: AbortController;
  private references = new Map<string, { record: MegaRecording; expires: number }>();
  readonly metrics = {
    queries: 0,
    downloads: 0,
    completed: 0,
    remuxed: 0,
    transcoded: 0,
    cancelled: 0,
  };
  constructor(
    private client: () => EufyMegaClient | undefined,
    private devices: () => Device[],
    private liveBusy: () => boolean | 'live_busy' | 'live_stopping',
    private checkCapability: (serial: string) => Promise<void> = async () => {},
  ) {}
  get busy(): boolean {
    return !!this.operation;
  }
  close(): void {
    this.operation?.abort();
    this.references.clear();
  }
  private async run<T>(
    signal: AbortSignal,
    action: (client: EufyMegaClient, abort: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.busy) throw new RecordingError('recording_busy', 409);
    const live = this.liveBusy();
    if (live)
      throw new RecordingError(live === 'live_stopping' ? 'live_stopping' : 'live_busy', 409);
    const client = this.client();
    if (!client?.connected) throw new RecordingError('recording_unavailable', 503);
    signal.throwIfAborted();
    const operation = (this.operation = new AbortController());
    const abort = () => operation.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 60000);
    try {
      return await action(client, operation.signal);
    } catch (error) {
      if (error instanceof RecordingError) throw error;
      if (
        error instanceof EufyError &&
        [
          'history_changed',
          'history_completeness_unconfirmed',
          'invalid_history_page',
          'invalid_recording',
        ].includes(error.code)
      )
        throw new RecordingError('history_incomplete', 503);
      throw new RecordingError('recording_unavailable', 503);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (this.operation === operation) this.operation = undefined;
    }
  }
  private stations(serials: string[]): string[] {
    if (!serials.length || serials.length > 100)
      throw new RecordingError('recording_unavailable', 400);
    const devices = this.devices();
    return [
      ...new Set(
        serials.map((serial) => {
          const device = devices.find((d) => d.id === serial && d.kind === 'camera');
          if (!device) throw new RecordingError('recording_unavailable', 400);
          return device.stationId;
        }),
      ),
    ];
  }
  async list(serial: string, date: string, signal: AbortSignal) {
    return this.timeline([serial], date, signal);
  }
  async timeline(
    serials: string[],
    date: string,
    signal: AbortSignal,
  ): Promise<{ recordings: Recording[]; returned: number; complete: true }> {
    return this.run(signal, async (client, abort) => {
      for (const serial of serials) await this.checkCapability(serial);
      const rows: MegaRecording[] = [];
      let returned = 0;
      const devices = this.devices();
      for (const id of this.stations(serials)) {
        this.metrics.queries++;
        const result = await client.listRecordings(
          id,
          date,
          serials.filter((serial) => devices.find((d) => d.id === serial)?.stationId === id),
          abort,
        );
        if (result.complete !== true) throw new RecordingError('history_incomplete', 503);
        rows.push(...result.recordings);
        returned += result.returned;
      }
      for (const [id, ref] of this.references)
        if (ref.expires <= Date.now()) this.references.delete(id);
      const recordings = rows.map((record) => {
        const id = randomBytes(16).toString('hex');
        this.references.set(id, { record, expires: Date.now() + 15 * 60000 });
        return {
          id,
          serial: record.deviceId,
          start: record.start,
          end: record.end,
          bytes: record.bytes,
          thumbnail: record.thumbnail,
        };
      });
      while (this.references.size > 20000)
        this.references.delete(this.references.keys().next().value!);
      return {
        recordings: recordings.sort(
          (a, b) => b.start.localeCompare(a.start) || a.id.localeCompare(b.id),
        ),
        returned,
        complete: true,
      };
    });
  }
  async calendar(
    serials: string[],
    month: string,
    signal: AbortSignal,
  ): Promise<{ days: string[] }> {
    return this.run(signal, async (client, abort) => {
      for (const serial of serials) await this.checkCapability(serial);
      const days = new Set<string>();
      for (const station of this.stations(serials)) {
        this.metrics.queries++;
        for (const day of await client.recordingCalendar(station, month, abort)) days.add(day);
      }
      return { days: [...days].sort() };
    });
  }
  private reference(serial: string, id: string): MegaRecording {
    const ref = this.references.get(id);
    if (!ref || ref.record.deviceId !== serial || ref.expires <= Date.now())
      throw new RecordingError('recording_expired', 410);
    return ref.record;
  }
  async thumbnail(serial: string, id: string, signal: AbortSignal): Promise<Buffer> {
    await this.checkCapability(serial);
    const record = this.reference(serial, id);
    return this.run(signal, (client, abort) => client.recordingThumbnail(record.id, abort));
  }
  async video(
    serial: string,
    id: string,
    signal: AbortSignal,
    format: 'h264' | 'native' = 'h264',
  ): Promise<Buffer> {
    await this.checkCapability(serial);
    const record = this.reference(serial, id);
    return this.run(signal, async (client, abort) => {
      this.metrics.downloads++;
      let transfer: RecordingDownload | undefined;
      const video: Buffer[] = [],
        audio: Buffer[] = [];
      try {
        transfer = await client.downloadRecording(record.id, abort);
        transfer.video.on('data', (chunk) => video.push(chunk));
        transfer.audio.on('data', (chunk) => audio.push(chunk));
        const result = await transfer.completed;
        if (!result.complete) throw new RecordingError('recording_unavailable', 503);
        const metadata = transfer.metadata;
        const codec =
          metadata.videoCodec === 'h264' ? 'h264' : metadata.videoCodec === 'h265' ? 'hevc' : null;
        const output = await muxRecording(
          { videoCodec: codec, fps: metadata.fps },
          Buffer.concat(video),
          Buffer.concat(audio),
          abort,
          format,
        );
        if (codec === 'hevc' && format === 'h264') this.metrics.transcoded++;
        else this.metrics.remuxed++;
        this.metrics.completed++;
        return output;
      } finally {
        if (abort.aborted) this.metrics.cancelled++;
        await transfer?.cancel();
      }
    });
  }
}
