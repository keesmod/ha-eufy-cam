import './sdk-compat.js';
import { EventEmitter } from 'node:events';
import {
  EufySecurity,
  CommandName,
  PropertyName,
  VideoCodec,
  AudioCodec,
  type Device,
  type Picture,
} from 'eufy-security-client';
import { Recordings } from './recordings.js';
import { Notifications } from './notifications.js';
import { Stations } from './stations.js';
import { Storage } from './storage.js';
import type {
  Backend,
  Credentials,
  LoginOptions,
  AuthState,
  CameraInfo,
  LiveMedia,
} from './backend.js';

/** The existing SDK is loaded only when the legacy backend is selected. */
export class LegacyBackend extends EventEmitter implements Backend {
  private client?: EufySecurity;
  private devices = new Map<string, Device>();
  private closed = false;
  stations: Stations | undefined;
  auth: AuthState = { state: 'unconfigured' };
  readonly pictures = new Map<string, { data: Buffer; mime: string; received: string }>();
  readonly recordings: Recordings;
  readonly notifications = new Notifications(
    (serial) =>
      this.devices.has(serial) ||
      Boolean(this.stations?.inventory().some((s) => s.serial === serial)),
    (event) => this.emit('notification', event),
    () => this.emit('change'),
  );
  constructor(
    private storage: Storage,
    liveBusy: () => boolean | 'live_busy' | 'live_stopping',
  ) {
    super();
    this.recordings = new Recordings(() => this.client, liveBusy);
  }
  get connected(): boolean {
    return Boolean(this.client?.isConnected());
  }
  async login(credentials?: Credentials, options?: LoginOptions): Promise<AuthState> {
    if (credentials) {
      this.client = await EufySecurity.initialize({
        ...credentials,
        persistentData:
          (await this.storage.read('session.json')) ??
          JSON.stringify({
            country: '',
            openudid: '',
            serial_number: '',
            push_persistentIds: [],
            login_hash: '',
            version: '',
          }),
        p2pConnectionSetup: 0,
        pollingIntervalMinutes: 0,
        eventDurationSeconds: 10,
        acceptInvitations: false,
        trustedDeviceName: 'Home Assistant Viewer',
      });
      if (this.closed) {
        this.client.close();
        throw new Error('Bridge closed');
      }
      this.client.setCameraMaxLivestreamDuration(120);
      this.stations = new Stations(this.client, () => this.emit('change'));
      this.bind(this.client);
    }
    if (!this.client) throw new Error('Credentials required');
    this.auth = { state: 'connecting' };
    await this.client.connect(options ? { ...options, force: options.force ?? false } : undefined);
    if (this.connected) this.auth = { state: 'connected' };
    if (this.auth.state === 'connecting') this.auth = { state: 'error' };
    return this.auth;
  }
  private bind(client: EufySecurity): void {
    this.notifications.bind(client);
    client.on('persistent data', (data) => {
      void this.storage.write('session.json', data).catch(() => this.emit('storage_error'));
    });
    client.on('connect', () => {
      this.auth = { state: 'connected' };
      this.emit('change');
    });
    client.on('close', () => {
      this.recordings.close();
      this.auth = { state: 'error' };
      this.emit('disconnected');
      this.emit('change');
    });
    client.on('connection error', () => {
      this.auth = { state: 'error' };
      this.emit('change');
    });
    client.on('tfa request', () => {
      this.auth = { state: 'verify' };
      this.emit('change');
    });
    client.on('captcha request', (captchaId, captcha) => {
      this.auth = { state: 'captcha', captchaId, captcha };
      this.emit('change');
    });
    client.on('device added', (device) => {
      if (!device.hasCommand(CommandName.DeviceStartLivestream)) return;
      this.devices.set(device.getSerial(), device);
      if (device.hasProperty(PropertyName.DevicePicture))
        this.picture(device.getSerial(), device.getPropertyValue(PropertyName.DevicePicture));
      this.emit('change');
    });
    client.on('device removed', (device) => {
      const serial = device.getSerial();
      this.devices.delete(serial);
      this.pictures.delete(serial);
      this.emit('camera-removed', serial);
      this.emit('change');
    });
    client.on('device property changed', (device, name, value) => {
      if (!this.devices.has(device.getSerial())) return;
      if (name === PropertyName.DevicePicture) this.picture(device.getSerial(), value);
      if (
        [PropertyName.DevicePicture, PropertyName.DeviceBattery, PropertyName.Name].includes(
          name as PropertyName,
        )
      )
        this.emit('change');
    });
    client.on('station livestream stop', (_station, device) =>
      this.emit('live-stop', { serial: device.getSerial(), confirmed: true }),
    );
    client.on('station livestream start', (_station, device, metadata, video, audio) => {
      const media: LiveMedia = {
        serial: device.getSerial(),
        videoCodec:
          metadata.videoCodec === VideoCodec.H264
            ? 'h264'
            : metadata.videoCodec === VideoCodec.H265
              ? 'hevc'
              : null,
        audioSupported: [AudioCodec.AAC, AudioCodec.AAC_LC, AudioCodec.AAC_ELD].includes(
          metadata.audioCodec,
        ),
        fps: metadata.videoFPS,
        video,
        audio,
      };
      this.emit('live-start', media);
    });
  }
  canStartLive(_serial: string): boolean {
    return true;
  }
  async startLive(serial: string): Promise<void> {
    if (!this.client) throw new Error('Disconnected');
    await this.client.startStationLivestream(serial);
  }
  async stopLive(serial: string): Promise<void> {
    await this.client?.stopStationLivestream(serial);
  }
  async recoverStation(serial: string): Promise<string[]> {
    if (!this.client) throw new Error('Disconnected');
    const device = await this.client.getDevice(serial),
      station = await this.client.getStation(device.getStationSerial());
    if (!station.isConnected()) throw new Error('Station disconnect not confirmed');
    await new Promise<void>((resolve, reject) => {
      const clean = () => {
        clearTimeout(timer);
        station.off('close', closed);
      };
      const closed = () => {
        clean();
        resolve();
      };
      const timer = setTimeout(() => {
        clean();
        reject(new Error('Station close unconfirmed'));
      }, 5000);
      station.once('close', closed);
      try {
        station.close();
      } catch {
        clean();
        reject(new Error('Station close failed'));
      }
    });
    return [...this.devices.values()]
      .filter((d) => d.getStationSerial() === station.getSerial())
      .map((d) => d.getSerial());
  }
  private picture(serial: string, value: unknown): void {
    const picture = value as Partial<Picture> | undefined;
    if (
      !picture ||
      !Buffer.isBuffer(picture.data) ||
      !picture.data.length ||
      picture.data.length > 5_000_000 ||
      !['image/jpeg', 'image/png'].includes(picture.type?.mime ?? '')
    )
      return;
    if (this.pictures.get(serial)?.data.equals(picture.data)) return;
    this.pictures.set(serial, {
      data: picture.data,
      mime: picture.type!.mime,
      received: new Date().toISOString(),
    });
  }
  inventory(): CameraInfo[] {
    return [...this.devices.values()].map((d) => ({
      serial: d.getSerial(),
      name: d.getName(),
      model: d.getModel(),
      hardware: d.getHardwareVersion(),
      software: d.getSoftwareVersion(),
      battery: d.hasProperty(PropertyName.DeviceBattery)
        ? Number(d.getPropertyValue(PropertyName.DeviceBattery))
        : null,
      snapshot_received_at: this.pictures.get(d.getSerial())?.received ?? null,
    }));
  }
  hasCamera(serial: string): boolean {
    return this.devices.has(serial);
  }
  async close(): Promise<void> {
    this.closed = true;
    this.notifications.close();
    this.stations?.close();
    this.recordings.close();
    this.client?.close();
    await this.storage.flush();
    this.removeAllListeners();
  }
}
