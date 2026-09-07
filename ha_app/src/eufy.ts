import "./sdk-compat.js";
import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { EufySecurity, CommandName, PropertyName, VideoCodec, AudioCodec, type Device, type Picture, type LoginOptions } from "eufy-security-client";
import { JpegFramer } from "./jpeg.js";
import { StreamHub } from "./streams.js";
import { MediaRelay } from "./media.js";
import { Recordings } from "./recordings.js";
import { Storage } from "./storage.js";
import { Stations } from "./stations.js";

export interface Credentials { username: string; password: string; country: string }
export interface CameraInfo {
  serial: string; name: string; model: string; hardware: string; software: string;
  battery: number | null; snapshot_received_at: string | null;
}
export type AuthState = { state: "unconfigured" | "connected" | "connecting" | "error" | "verify" | "captcha"; captcha?: string; captchaId?: string };

export class Eufy extends EventEmitter {
  private client?: EufySecurity;
  stations?: Stations;
  private loginBusy = false;
  private restoring = false;
  private readonly restoreAbort = new AbortController();
  private encoders = new Map<string, ChildProcessWithoutNullStreams>();
  private livePictures = new Map<string, { data: Buffer; mime: string; received: string }>();
  private devices = new Map<string, Device>();
  readonly media = new MediaRelay(serial => this.hub.end(serial, "Audio/video encoder failed"));
  readonly recordings: Recordings = new Recordings(() => this.client, () => this.hub.active ? "live_busy" : this.hub.quarantined ? "live_stopping" : false);
  readonly pictures = new Map<string, { data: Buffer; mime: string; received: string }>();
  readonly metrics = { start_requests: 0, stop_requests: 0, started_events: 0, stopped_events: 0, frames: 0, last_start_request: null as string | null, last_stop_request: null as string | null, last_started_event: null as string | null, last_stopped_event: null as string | null };
  auth: AuthState = { state: "unconfigured" };
  readonly hub: StreamHub = new StreamHub({
    admit: () => !this.recordings.busy && Boolean(this.client?.isConnected()),
    recover: serial => this.recoverStation(serial),
    start: async serial => { if (this.recordings.busy) throw new Error("Recording operation in progress"); if (!this.client?.isConnected()) throw new Error("Disconnected"); this.metrics.start_requests++; this.metrics.last_start_request = new Date().toISOString(); await this.client.startStationLivestream(serial); },
    stop: async serial => { this.metrics.stop_requests++; this.metrics.last_stop_request = new Date().toISOString(); await this.client?.stopStationLivestream(serial); },
    disposeMedia: serial => { this.media.stop(serial); const picture = this.livePictures.get(serial); if (picture) { this.pictures.set(serial, picture); this.livePictures.delete(serial); this.emit("change"); } const encoder = this.encoders.get(serial); this.encoders.delete(serial); if (encoder) { encoder.stdin.destroy(); encoder.kill("SIGKILL"); } },
  });
  constructor(private readonly storage: Storage) { super(); }

  async restore(): Promise<void> {
    this.restoring = true;
    this.auth = { state: "connecting" }; this.emit("change");
    try {
      const saved = await this.storage.read("credentials.json");
      if (!saved) { this.auth = { state: "unconfigured" }; return; }
      const credentials = JSON.parse(saved) as Credentials;
      let retryDelay = 5000;
      while (!this.restoreAbort.signal.aborted) {
        try { await this.loginAttempt(credentials); return; }
        catch {
          // Startup can precede working DNS/networking. Retry failed SDK
          // initialization, but never retry a returned password/2FA challenge.
          this.auth = { state: "connecting" }; this.emit("change");
          this.emit("restore_retry");
          await delay(retryDelay, undefined, { signal: this.restoreAbort.signal });
          retryDelay = Math.min(retryDelay * 2, 60_000);
        }
      }
    } catch (error) {
      if (!this.restoreAbort.signal.aborted) { this.auth = { state: "error" }; throw error; }
    } finally { this.restoring = false; this.emit("change"); }
  }
  async login(credentials?: Credentials, options?: LoginOptions): Promise<AuthState> {
    if (this.restoring) throw new Error("Saved login is still being restored");
    return this.loginAttempt(credentials, options);
  }
  private async loginAttempt(credentials?: Credentials, options?: LoginOptions): Promise<AuthState> {
    if (this.loginBusy) throw new Error("Login already in progress");
    if (credentials && (this.hub.active || this.hub.quarantined || this.recordings.busy)) throw new Error("Stop viewers before reauthenticating");
    this.loginBusy = true;
    try {
      if (credentials) {
        this.auth = { state: "connecting" }; this.emit("change");
        this.recordings.close();
        this.stations?.close();
        this.client?.removeAllListeners();
        this.client?.close();
        this.devices.clear(); this.pictures.clear();
        this.client = await EufySecurity.initialize({
          ...credentials, persistentData: (await this.storage.read("session.json")) ?? JSON.stringify({ country: "", openudid: "", serial_number: "", push_persistentIds: [], login_hash: "", version: "" }),
          p2pConnectionSetup: 0, pollingIntervalMinutes: 0, eventDurationSeconds: 10,
          acceptInvitations: false, trustedDeviceName: "Home Assistant Viewer",
        });
        if (this.restoreAbort.signal.aborted) { this.client.close(); return this.auth; }
        this.client.setCameraMaxLivestreamDuration(120);
        this.stations = new Stations(this.client, () => this.emit("change"));
        this.bind(this.client);
        await this.storage.write("credentials.json", JSON.stringify(credentials));
      }
      if (!this.client) throw new Error("Credentials required");
      this.auth = { state: "connecting" };
      await this.client.connect(options);
      if (this.client.isConnected()) this.auth = { state: "connected" };
      if (this.auth.state === "connecting") this.auth = { state: "error" };
      return this.auth;
    } catch (error) {
      this.auth = { state: this.restoring ? "connecting" : "error" };
      throw error;
    } finally { this.loginBusy = false; this.emit("change"); }
  }

  private bind(client: EufySecurity): void {
    client.on("persistent data", data => { void this.storage.write("session.json", data).catch(() => this.emit("storage_error")); });
    client.on("connect", () => { this.auth = { state: "connected" }; this.emit("change"); });
    client.on("close", () => { this.recordings.close(); this.auth = { state: "error" }; this.hub.close(); this.emit("change"); });
    client.on("connection error", () => { this.auth = { state: "error" }; this.emit("change"); });
    client.on("tfa request", () => { this.auth = { state: "verify" }; this.emit("change"); });
    client.on("captcha request", (captchaId, captcha) => { this.auth = { state: "captcha", captchaId, captcha }; this.emit("change"); });
    client.on("device added", device => {
      if (!device.hasCommand(CommandName.DeviceStartLivestream)) return;
      this.devices.set(device.getSerial(), device);
      if (device.hasProperty(PropertyName.DevicePicture)) this.picture(device.getSerial(), device.getPropertyValue(PropertyName.DevicePicture));
      this.emit("change");
    });
    client.on("device removed", device => { const serial = device.getSerial(); this.hub.end(serial, "Device removed"); this.devices.delete(serial); this.pictures.delete(serial); this.emit("change"); });
    client.on("device property changed", (device, name, value) => {
      if (!this.devices.has(device.getSerial())) return;
      if (name === PropertyName.DevicePicture) this.picture(device.getSerial(), value);
      // Only push properties we expose; raw events contain sensitive data.
      if ([PropertyName.DevicePicture, PropertyName.DeviceBattery, PropertyName.Name].includes(name as PropertyName)) this.emit("change");
    });
    client.on("station livestream stop", (_station, device) => { this.metrics.stopped_events++; this.metrics.last_stopped_event = new Date().toISOString(); this.hub.stopped(device.getSerial()); });
    client.on("station livestream start", (_station, device, metadata, video, audio) => {
      this.metrics.started_events++; this.metrics.last_started_event = new Date().toISOString();
      const serial = device.getSerial();
      audio.on("error", () => this.hub.end(serial, "Audio transport error"));
      if (!this.hub.started(serial)) { video.resume(); audio.resume(); return; }
      if (this.encoders.has(serial)) { this.hub.end(serial, "Duplicate stream"); video.resume(); return; }
      const codec = metadata.videoCodec === VideoCodec.H264 ? "h264" : metadata.videoCodec === VideoCodec.H265 ? "hevc" : null;
      if (!codec) { this.hub.end(serial, "Unsupported codec"); video.resume(); return; }
      this.media.start(serial, codec, video, audio, [AudioCodec.AAC, AudioCodec.AAC_LC, AudioCodec.AAC_ELD].includes(metadata.audioCodec), metadata.videoFPS);
      if (![AudioCodec.AAC, AudioCodec.AAC_LC, AudioCodec.AAC_ELD].includes(metadata.audioCodec)) audio.resume();
      const encoder = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-threads", "1", "-f", codec, "-i", "pipe:0", "-an", "-vf", "fps=8,scale='min(960,iw)':-2", "-threads", "1", "-q:v", "6", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"], { stdio: ["pipe", "pipe", "pipe"] });
      this.encoders.set(serial, encoder);
      const framer = new JpegFramer(frame => { this.metrics.frames++; this.livePictures.set(serial, { data: frame, mime: "image/jpeg", received: new Date().toISOString() }); this.hub.frame(serial, frame); });
      encoder.stdout.on("data", (chunk: Buffer) => { try { framer.push(chunk); } catch { this.hub.end(serial, "Invalid media"); } });
      encoder.stderr.resume(); // Never expose SDK credentials or device addresses in logs.
      encoder.stdin.on("error", () => this.hub.end(serial, "Encoder input failed"));
      encoder.on("error", () => this.hub.end(serial, "Encoder unavailable"));
      encoder.on("exit", () => { if (this.encoders.get(serial) === encoder) this.hub.end(serial, "Encoder stopped"); });
      video.on("error", () => this.hub.end(serial, "Camera transport failed"));
      video.pipe(encoder.stdin);
    });
  }
  private async recoverStation(serial: string): Promise<string[]> {
    if (!this.client || this.hub.active || this.recordings.busy) throw new Error("Station still owned");
    const device = await this.client.getDevice(serial);
    const station = await this.client.getStation(device.getStationSerial());
    // Do not interpret a local no-stream flag as a physical stop. Require the
    // SDK transport close event after sending END and clearing its command queue.
    if (!station.isConnected()) throw new Error("Station disconnect not confirmed");
    await new Promise<void>((resolve, reject) => {
      const clean = () => { clearTimeout(timer); station.off("close", closed); };
      const closed = () => { clean(); resolve(); };
      const timer = setTimeout(() => { clean(); reject(new Error("Station close unconfirmed")); }, 5000);
      station.once("close", closed);
      try { station.close(); } catch { clean(); reject(new Error("Station close failed")); }
    });
    return [...this.devices.values()].filter(d => d.getStationSerial() === station.getSerial()).map(d => d.getSerial());
  }
  private picture(serial: string, value: unknown): void {
    const picture = value as Partial<Picture> | undefined;
    if (!picture || !Buffer.isBuffer(picture.data) || !picture.data.length || picture.data.length > 5_000_000 || !["image/jpeg", "image/png"].includes(picture.type?.mime ?? "")) return;
    if (this.pictures.get(serial)?.data.equals(picture.data)) return;
    this.pictures.set(serial, { data: picture.data, mime: picture.type!.mime, received: new Date().toISOString() });
  }
  inventory(): CameraInfo[] {
    return [...this.devices.values()].map(device => ({
      serial: device.getSerial(), name: device.getName(), model: device.getModel(), hardware: device.getHardwareVersion(), software: device.getSoftwareVersion(),
      battery: device.hasProperty(PropertyName.DeviceBattery) ? Number(device.getPropertyValue(PropertyName.DeviceBattery)) : null,
      snapshot_received_at: this.pictures.get(device.getSerial())?.received ?? null,
    }));
  }
  hasCamera(serial: string): boolean { return this.devices.has(serial); }
  async close(): Promise<void> { this.restoreAbort.abort(); this.stations?.close(); this.recordings.close(); this.hub.close(); await new Promise(resolve => setTimeout(resolve, 1500)); this.client?.close(); await this.storage.flush(); }
}
