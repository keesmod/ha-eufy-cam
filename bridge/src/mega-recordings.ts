import { RecordingDiagnostics } from './recording-diagnostics.js';
import { createWriteStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { recordingWorkspace } from './recording-workspace.js';
import { randomBytes } from 'node:crypto';
import {
  EufyError,
  type EufyMegaClient,
  type Device,
  type Recording as MegaRecording,
  type RecordingDownload,
  type RecordingObservation,
  type RecordingOperationOptions,
} from '@keesmod/eufy-mega-client';
import { RecordingError } from './errors.js';
import { RecordingTranscoder, type RecordingFormat, type RecordingResult } from './recording-media.js';
import type { BackendRecordings, Recording } from './backend.js';
import {
  connectionAttempt,
  type RecordingQuery,
  type RecordingQueryReport,
  type StationConnectionDetail,
} from './discovery-diagnostics.js';

/** Receives each recorded recording operation with the ID of its owner (#152). */
export type RecordingQueryRecorder = (owner: string, report: RecordingQueryReport) => void;
/** One client recording operation of a request and what the client reported about it. */
interface RecordingCall {
  owner: string;
  connection: StationConnectionDetail;
  observation?: RecordingObservation;
}
const elapsed = (from: number) => Math.min(3600000, Math.max(0, Math.round(performance.now() - from)));
/**
 * The answer the bridge sends for a failed operation. The HTTP code and body
 * are the same as before #152. The client's original error is kept as the cause
 * for the playback diagnostics only.
 */
function bridgeError(error: unknown): RecordingError {
  if (error instanceof RecordingError) return error;
  let mapped: RecordingError;
  if (['ENOSPC', 'EDQUOT', 'EROFS', 'EACCES'].includes((error as NodeJS.ErrnoException)?.code ?? ''))
    mapped = new RecordingError('recording_storage_unavailable', 503);
  else if (
    error instanceof EufyError &&
    [
      'history_changed',
      'history_completeness_unconfirmed',
      'invalid_history_page',
      'invalid_recording',
    ].includes(error.code)
  )
    mapped = new RecordingError('history_incomplete', 503);
  else mapped = new RecordingError('recording_unavailable', 503);
  mapped.cause = error;
  return mapped;
}

/** Keeps bridge handles, conversion and limits stable across both backends. */
export class MegaRecordings implements BackendRecordings {
  readonly diagnostics = new RecordingDiagnostics();
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
    private readonly media = new RecordingTranscoder(),
    private readonly recorder?: RecordingQueryRecorder,
  ) {}
  get busy(): boolean {
    return !!this.operation;
  }
  close(): void {
    this.operation?.abort();
    this.references.clear();
  }
  private record(owner: string, report: RecordingQueryReport): void {
    try {
      this.recorder?.(owner, report);
    } catch {
      /* Diagnostics never alter a recording request. */
    }
  }
  /**
   * Runs one bridge request. `options(owner)` gives each client recording call
   * its signal, connection callbacks and observation callback.
   */
  private async run<T>(
    signal: AbortSignal,
    query: RecordingQuery,
    owners: string[],
    action: (
      client: EufyMegaClient,
      abort: AbortSignal,
      options: (owner: string) => RecordingOperationOptions,
    ) => Promise<T>,
  ): Promise<T> {
    if (this.busy) throw new RecordingError('recording_busy', 409);
    const live = this.liveBusy();
    if (live)
      throw new RecordingError(live === 'live_stopping' ? 'live_stopping' : 'live_busy', 409);
    const started = performance.now();
    const client = this.client();
    if (!client?.connected) {
      // Refused before any client operation, so the client reports nothing (#152).
      for (const owner of owners)
        this.record(owner, { query, reason: 'client_disconnected', elapsedMs: elapsed(started), returned: 503 });
      throw new RecordingError('recording_unavailable', 503);
    }
    signal.throwIfAborted();
    const operation = (this.operation = new AbortController());
    const abort = () => operation.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 60000);
    const calls: RecordingCall[] = [];
    const options = (owner: string): RecordingOperationOptions => {
      const stages = connectionAttempt();
      const call: RecordingCall = { owner, connection: stages.detail };
      calls.push(call);
      return {
        signal: operation.signal,
        onProgress: stages.onProgress,
        onLookup: stages.onLookup,
        onObservation: (observation) => {
          call.observation = observation;
        },
      };
    };
    let failure: { error: unknown; answer: RecordingError } | undefined;
    try {
      return await action(client, operation.signal, options);
    } catch (error) {
      failure = { error, answer: bridgeError(error) };
      throw failure.answer;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (this.operation === operation) this.operation = undefined;
      this.report(query, owners, calls, failure, started);
    }
  }
  /**
   * Records the client operations of one request (#152): each operation on an
   * experimental standalone owner except a successful thumbnail, and each
   * failed operation on any owner. A generic recording_unavailable that no
   * client report explains is recorded with the bridge's own reason.
   */
  private report(
    query: RecordingQuery,
    owners: string[],
    calls: RecordingCall[],
    failure: { error: unknown; answer: RecordingError } | undefined,
    started: number,
  ): void {
    const returned = failure?.answer.status ?? 200;
    for (const { owner, connection, observation } of calls) {
      if (!observation) continue;
      if (observation.code !== null || (observation.owner === 'standalone' && query !== 'thumbnail'))
        this.record(owner, { query, observation, connection, returned });
    }
    if (
      failure?.answer.code !== 'recording_unavailable' ||
      failure.error instanceof RecordingError ||
      calls.some((call) => call.observation && call.observation.code !== null)
    )
      return;
    // The latest operation reported success and the bridge failed after it, as
    // in a video conversion. The playback attempt keeps that cause.
    const last = calls.at(-1);
    if (last?.observation) return;
    // Otherwise the error came before the client's recording access, such as
    // client_closed, or from the bridge before any operation.
    const { error } = failure;
    for (const owner of last ? [last.owner] : owners)
      this.record(owner, {
        query,
        reason: error instanceof EufyError ? error.code : 'unclassified_error',
        remoteCode: error instanceof EufyError ? error.remoteCode : undefined,
        elapsedMs: elapsed(started),
        connection: last?.connection,
        returned: failure.answer.status,
      });
  }
  /** The owners of the given cameras, for a request refused before its operations. */
  private owners(serials: string[]): string[] {
    const devices = this.devices();
    return [
      ...new Set(
        serials.flatMap((serial) => {
          const device = devices.find((d) => d.id === serial && d.kind === 'camera');
          return device ? [device.stationId] : [];
        }),
      ),
    ];
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
    return this.run(signal, 'list', this.owners(serials), async (client, _abort, options) => {
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
          options(id),
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
    return this.run(signal, 'calendar', this.owners(serials), async (client, _abort, options) => {
      for (const serial of serials) await this.checkCapability(serial);
      const days = new Set<string>();
      for (const station of this.stations(serials)) {
        this.metrics.queries++;
        for (const day of await client.recordingCalendar(station, month, options(station))) days.add(day);
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
    return this.run(signal, 'thumbnail', [record.stationId], (client, _abort, options) =>
      client.recordingThumbnail(record.id, options(record.stationId)),
    );
  }
  async video(serial: string, id: string, signal: AbortSignal,
    consume: (result: RecordingResult, signal: AbortSignal) => Promise<void>,
    format: RecordingFormat = 'h264', hevcSupported = false, started?: (attempt: number) => void): Promise<void> {
    const observation = this.diagnostics.begin(format);
    try { started?.(observation.data.attempt); } catch { /* Diagnostic delivery is optional. */ }
    try {
      await this.checkCapability(serial);
      const record = this.reference(serial, id);
      await this.run(signal, 'download', [record.stationId], async (client, abort, options) => {
        this.metrics.downloads++;
        observation.stage('download');
        let transfer: RecordingDownload | undefined;
        const directory = await recordingWorkspace();
        const video = join(directory, 'video'), audio = join(directory, 'audio');
        try {
          transfer = await client.downloadRecording(record.id, options(record.stationId));
          const downloads = [
            pipeline(transfer.video, createWriteStream(video, { mode: 0o600 }), { signal: abort }),
            pipeline(transfer.audio, createWriteStream(audio, { mode: 0o600 }), { signal: abort }),
            transfer.completed,
          ] as const;
          // On any write/transfer error cancel the source and wait for both writers.
          let result;
          try { [, , result] = await Promise.all(downloads); }
          catch (error) { await transfer.cancel(); await Promise.allSettled(downloads); throw error; }
          if (!result.complete) throw new RecordingError('recording_unavailable', 503);
          const metadata = transfer.metadata;
          const codec =
            metadata.videoCodec === 'h264' ? 'h264' : metadata.videoCodec === 'h265' ? 'hevc' : null;
          const audioBytes = (await stat(audio)).size;
          try { observation.data.source_bytes = (await stat(video)).size + audioBytes; } catch { /* Optional size observation cannot fail playback. */ }
          observation.stage('conversion');
          const output = await this.media.muxResult(
            { videoCodec: codec, fps: metadata.fps },
            { video, audio: audioBytes ? audio : undefined, output: join(directory, 'output.mp4') },
            abort,
            format,
            hevcSupported,
            { attempt: observation.data.attempt, mark: observation.conversion, progress: observation.progress, limits: observation.data.limits },
          );
          observation.data.output_bytes = output.size;
          observation.data.media = output.media;
          observation.stage('transfer');
          if (output.media.processing !== 'remux') this.metrics.transcoded++;
          else this.metrics.remuxed++;
          this.metrics.completed++;
          await consume(output, abort);
        } finally {
          observation.cleanup();
          if (abort.aborted) { this.metrics.cancelled++; observation.finish("cancelled"); }
          try { await transfer?.cancel(); if (transfer) observation.data.source_cancel_confirmed = true; }
          catch (error) { observation.data.source_cancel_confirmed = false; throw error; }
          finally {
            try { await rm(directory, { recursive: true, force: true }); observation.data.files_removed = true; }
            catch (error) { observation.data.files_removed = false; throw error; }
          }
        }
      });
      if (observation.data.outcome !== 'cancelled') observation.finish('completed');
    } catch (error) {
      observation.finish(signal.aborted || observation.data.outcome === 'cancelled' ? 'cancelled' : 'failed', error);
      throw error;
    }
  }
}
