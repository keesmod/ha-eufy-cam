import { DiscoveryDiagnostics, type SupportReport } from './discovery-diagnostics.js';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { JpegFramer } from './jpeg.js';
import { StreamHub } from './streams.js';
import { StreamDiagnostics } from './diagnostics.js';
import { MediaRelay } from './media.js';
import { Storage } from './storage.js';
import { MegaBackend } from './mega-backend.js';
import { migrationInventory, MigrationError, parseMigrationInventory } from './migration.js';
import type {
  Backend,
  BackendName,
  BackendRecordings,
  Credentials,
  LoginOptions,
  AuthState,
  CameraInfo,
  LiveMedia,
  Picture,
} from './backend.js';
export type { Credentials, AuthState, CameraInfo } from './backend.js';

const unavailable = async (): Promise<never> => {
  throw new Error('Recording backend unavailable');
};
export class Eufy extends EventEmitter {
  migrationError: string | null = null;
  private backend?: Backend;
  private failedSupportReport?: SupportReport;
  private readonly setupDiagnostics = new DiscoveryDiagnostics(line => this.emit('discovery_diagnostic', line));
  private loginBusy = false;
  private migrationBusy = false;
  private restoring = false;
  private restoreTask?: Promise<void>;
  private restoreRetryAbort = new AbortController();
  private readonly restoreAbort = new AbortController();
  private encoders = new Map<string, ChildProcessWithoutNullStreams>();
  private livePictures = new Map<string, Picture>();
  readonly pictures = new Map<string, Picture>();
  readonly diagnostics = new StreamDiagnostics();
  readonly media = new MediaRelay((serial) => this.hub.end(serial, 'Audio/video encoder failed'), this.diagnostics);
  private readonly unavailableRecordings: BackendRecordings = {
    busy: false,
    metrics: { queries: 0, downloads: 0, completed: 0, remuxed: 0, transcoded: 0, cancelled: 0 },
    list: unavailable,
    timeline: unavailable,
    calendar: unavailable,
    thumbnail: unavailable,
    video: unavailable,
    close() {},
  };
  get recordings() {
    return this.backend?.recordings ?? this.unavailableRecordings;
  }
  get stations() {
    return this.backend?.stations;
  }
  get notifications() {
    return this.backend?.notifications;
  }
  readonly metrics = {
    start_requests: 0,
    stop_requests: 0,
    started_events: 0,
    stopped_events: 0,
    frames: 0,
    last_start_request: null as string | null,
    last_stop_request: null as string | null,
    last_started_event: null as string | null,
    last_stopped_event: null as string | null,
  };
  auth: AuthState = { state: 'unconfigured' };
  readonly hub = new StreamHub({
    diagnostic: (serial, event) => this.diagnostics.mark(serial, event),
    admit: (serial) =>
      !this.recordings.busy &&
      Boolean(this.backend?.connected) &&
      Boolean(this.backend?.canStartLive(serial)),
    recover: (serial) => this.recoverStation(serial),
    start: async (serial) => {
      if (this.recordings.busy) throw new Error('Recording operation in progress');
      if (!this.backend?.connected) throw new Error('Disconnected');
      this.diagnostics.begin(serial);
      this.metrics.start_requests++;
      this.metrics.last_start_request = new Date().toISOString();
      await this.backend.startLive(serial);
    },
    stop: async (serial) => {
      this.metrics.stop_requests++;
      this.metrics.last_stop_request = new Date().toISOString();
      await this.backend?.stopLive(serial);
    },
    disposeMedia: (serial) => {
      this.diagnostics.finish(serial);
      this.media.stop(serial);
      const picture = this.livePictures.get(serial);
      if (picture) {
        this.pictures.set(serial, picture);
        this.livePictures.delete(serial);
        this.emit('change');
      }
      const encoder = this.encoders.get(serial);
      this.encoders.delete(serial);
      if (encoder) {
        encoder.stdin.destroy();
        encoder.kill('SIGKILL');
      }
    },
  });
  constructor(
    private readonly storage: Storage,
    readonly backendName: BackendName = 'mega',
    diagnostics = false,
    private readonly backendFactory: (storage: Storage, busy: () => boolean | 'live_busy' | 'live_stopping') => Backend =
      (storage, busy) => new MegaBackend(storage, busy),
  ) {
    super();
    this.diagnostics.enabled = diagnostics;
    this.on('backend_fault', code => { if (!this.backend) this.setupDiagnostics.fault(code); });
  }
  restore(): Promise<void> {
    if (this.restoreTask) return this.restoreTask;
    this.restoreRetryAbort = new AbortController();
    const task = this.restoreSaved();
    this.restoreTask = task;
    void task.finally(() => { if (this.restoreTask === task) this.restoreTask = undefined; }).catch(() => {});
    return task;
  }
  async acceptMigration(value: unknown): Promise<void> {
    if (this.migrationBusy) throw new MigrationError('bridge_busy');
    this.migrationBusy = true;
    try {
      const inventory = parseMigrationInventory(value, await this.storage.read('bridge-id'));
      const previous = await this.storage.read('migration-inventory.json');
      if (previous) {
        const parsed = parseMigrationInventory(JSON.parse(previous), inventory.bridge_id);
        if (JSON.stringify(parsed) !== JSON.stringify(inventory)) throw new MigrationError('inventory_already_saved');
        return;
      }
      if (this.backend || this.loginBusy || this.hub.active || this.recordings.busy)
        throw new MigrationError('bridge_busy');
      await this.restoreTask?.catch(() => {});
      await this.storage.writeOnce('migration-inventory.json', JSON.stringify(inventory));
      this.migrationError = null;
      void this.restore().catch(() => {});
    } finally { this.migrationBusy = false; }
  }
  private async restoreSaved(): Promise<void> {
    const signal = AbortSignal.any([this.restoreAbort.signal, this.restoreRetryAbort.signal]);
    this.restoring = true;
    this.auth = { state: 'connecting' };
    this.emit('change');
    try {
      const inventory = await migrationInventory(this.storage);
      let saved = await this.storage.read('mega-credentials.json');
      if (!saved && inventory?.backend === 'mega' && await this.storage.exists('mega-session.json'))
        saved = await this.storage.read('credentials.json');
      if (!saved) {
        this.auth = { state: 'unconfigured' };
        return;
      }
      const credentials = JSON.parse(saved) as Credentials;
      let retryDelay = 5000;
      while (!signal.aborted) {
        try {
          await this.loginAttempt(credentials);
          return;
        } catch (error) {
          if (error instanceof MigrationError) throw error;
          if (signal.aborted) return;
          // Startup can precede working DNS/networking. Retry failed SDK
          // initialization, but never retry a returned password/2FA challenge.
          this.auth = { state: 'connecting' };
          this.emit('change');
          this.emit('restore_retry');
          await delay(retryDelay, undefined, { signal });
          retryDelay = Math.min(retryDelay * 2, 60_000);
        }
      }
    } catch (error) {
      if (!signal.aborted) {
        if (error instanceof MigrationError) this.migrationError = error.code;
        this.auth = { state: 'error' };
        throw error;
      }
    } finally {
      this.restoring = false;
      this.emit('change');
    }
  }
  async login(credentials?: Credentials, options?: LoginOptions): Promise<AuthState> {
    if (this.restoring) {
      if (!credentials) throw new Error('Saved login is still being restored');
      // User-provided credentials supersede automatic retries. Wait for an
      // in-flight attempt to settle so two SDK owners can never overlap.
      this.restoreRetryAbort.abort();
      await this.restoreTask;
    }
    if (this.restoreAbort.signal.aborted) throw new Error('Bridge is shutting down');
    return this.loginAttempt(credentials, options);
  }
  private async loginAttempt(
    credentials?: Credentials,
    options?: LoginOptions,
  ): Promise<AuthState> {
    if (this.migrationBusy) throw new MigrationError('bridge_busy');
    if (this.loginBusy) throw new Error('Login already in progress');
    if (credentials && (this.hub.active || this.hub.quarantined || this.recordings.busy))
      throw new Error('Stop viewers before reauthenticating');
    this.loginBusy = true;
    try {
      await migrationInventory(this.storage);
      if (credentials) {
        this.auth = { state: 'connecting' };
        this.emit('change');
        await this.backend?.close();
        this.backend = undefined;
        this.pictures.clear();
        const busy = () =>
          this.hub.active
            ? ('live_busy' as const)
            : this.hub.quarantined
              ? ('live_stopping' as const)
              : false;
        this.backend = this.backendFactory(this.storage, busy);
        this.bind(this.backend);
      }
      if (!this.backend) throw new Error('Credentials required');
      this.auth = { state: 'connecting' };
      this.auth = await this.backend.login(credentials, options);
      if (this.auth.state === 'connected') {
        this.migrationError = null;
        this.emit('change');
      }
      if (credentials) await this.storage.write('mega-credentials.json', JSON.stringify(credentials));
      if (this.restoreAbort.signal.aborted) {
        await this.backend.close();
        return this.auth;
      }
      return this.auth;
    } catch (error) {
      if (error instanceof MigrationError) {
        this.migrationError = error.code;
        this.failedSupportReport = this.backend?.supportReport?.() ?? this.failedSupportReport;
        await this.backend?.close();
        this.backend = undefined;
        this.emit('backend_fault', error.code);
      }
      this.auth = { state: this.restoring ? 'connecting' : 'error' };
      throw error;
    } finally {
      this.loginBusy = false;
      this.emit('change');
    }
  }
  private bind(backend: Backend): void {
    backend.on('change', () => {
      this.auth = backend.auth;
      for (const [serial, picture] of backend.pictures) this.pictures.set(serial, picture);
      this.emit('change');
    });
    backend.on('storage_error', () => this.emit('storage_error'));
    backend.on('discovery_diagnostic', line => this.emit('discovery_diagnostic', line));
    backend.on('backend_fault', (code, detail) =>
      this.emit('backend_fault', code, ...(detail ? [detail] : [])));
    backend.on('notification', (event) => this.emit('notification', event));
    backend.on('disconnected', () => this.hub.close());
    backend.on('camera-removed', (serial) => {
      this.hub.end(serial, 'Device removed');
      this.pictures.delete(serial);
    });
    backend.on('live-stop', ({ serial, confirmed }) => {
      this.metrics.stopped_events++;
      this.metrics.last_stopped_event = new Date().toISOString();
      if (confirmed) this.hub.stopped(serial);
      else this.hub.end(serial, 'Device stop unconfirmed');
    });
    backend.on(
      'live-start',
      ({ serial, videoCodec, audioSupported, fps, video, audio }: LiveMedia) => {
        this.metrics.started_events++;
        this.metrics.last_started_event = new Date().toISOString();
        audio.on('error', () => this.hub.end(serial, 'Audio transport error'));
        if (!this.hub.started(serial)) {
          video.resume();
          audio.resume();
          return;
        }
        if (this.encoders.has(serial)) {
          this.hub.end(serial, 'Duplicate stream');
          video.resume();
          return;
        }
        const codec = videoCodec;
        if (!codec) {
          this.hub.end(serial, 'Unsupported codec');
          video.resume();
          return;
        }
        this.diagnostics.mark(serial, codec);
        this.diagnostics.mark(serial, audioSupported ? 'audio_supported' : 'audio_absent');
        video.once('data', () => this.diagnostics.mark(serial, 'video_input'));
        if (audioSupported) audio.once('data', () => this.diagnostics.mark(serial, 'audio_input'));
        this.media.start(serial, codec, video, audio, audioSupported, fps);
        if (!audioSupported) audio.resume();
        const encoder = spawn(
          'ffmpeg',
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-threads',
            '1',
            '-f',
            codec,
            '-i',
            'pipe:0',
            '-an',
            '-vf',
            "fps=8,scale='min(960,iw)':-2",
            '-threads',
            '1',
            '-q:v',
            '6',
            '-f',
            'image2pipe',
            '-vcodec',
            'mjpeg',
            'pipe:1',
          ],
          { stdio: ['pipe', 'pipe', 'pipe'] },
        );
        this.encoders.set(serial, encoder);
        const framer = new JpegFramer((frame) => {
          this.diagnostics.mark(serial, 'jpeg_frame');
          this.metrics.frames++;
          this.livePictures.set(serial, {
            data: frame,
            mime: 'image/jpeg',
            received: new Date().toISOString(),
          });
          this.hub.frame(serial, frame);
        });
        encoder.stdout.on('data', (chunk: Buffer) => {
          try {
            framer.push(chunk);
          } catch {
            this.hub.end(serial, 'Invalid media');
          }
        });
        this.diagnostics.encoder(serial, 'jpeg', encoder);
        encoder.stdin.on('error', () => this.hub.end(serial, 'Encoder input failed'));
        encoder.on('error', () => this.hub.end(serial, 'Encoder unavailable'));
        encoder.on('exit', () => {
          if (this.encoders.get(serial) === encoder) this.hub.end(serial, 'Encoder stopped');
        });
        video.on('error', () => this.hub.end(serial, 'Camera transport failed'));
        video.pipe(encoder.stdin);
      },
    );
  }
  private async recoverStation(serial: string): Promise<string[]> {
    if (!this.backend || this.hub.active || this.recordings.busy)
      throw new Error('Station still owned');
    return this.backend.recoverStation(serial);
  }
  supportReport(): SupportReport {
    const setup = this.setupDiagnostics.report();
    const report = this.backend?.supportReport?.() ?? this.failedSupportReport ?? setup;
    return {...report, generated_at:setup.generated_at, recent_events:
      report === setup ? setup.recent_events : [...report.recent_events, ...setup.recent_events]
        .sort((a,b) => String(a.timestamp).localeCompare(String(b.timestamp))).slice(-100)};
  }
  inventory(): CameraInfo[] {
    return (
      this.backend
        ?.inventory()
        .map((d) => ({
          ...d,
          snapshot_received_at: this.pictures.get(d.serial)?.received ?? d.snapshot_received_at,
        })) ?? []
    );
  }
  hasCamera(serial: string): boolean {
    return this.backend?.hasCamera(serial) ?? false;
  }
  async close(): Promise<void> {
    this.restoreAbort.abort();
    this.recordings.close();
    this.hub.close();
    await delay(1500);
    await this.backend?.close();
    await this.storage.flush();
  }
}
