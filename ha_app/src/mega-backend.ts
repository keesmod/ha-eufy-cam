import { EventEmitter } from "node:events";
import {
  EufyMegaClient,
  EufyError,
  type ClientOptions,
  type Device,
  type StationState,
  type LiveStream,
  type AuthState as MegaAuth,
} from "@keesmod/eufy-mega-client";
import { Storage } from "./storage.js";
import { MegaRecordings } from "./mega-recordings.js";
import { RecordingError, StationError } from "./errors.js";
import type {
  Backend,
  BackendStations,
  Credentials,
  LoginOptions,
  AuthState,
  CameraInfo,
  CameraCapabilities,
  LiveMedia,
  Picture,
  StationInfo,
} from "./backend.js";

const modes = [0, 1, 2, 3, 4, 5, 47, 63];
const authState = (state: MegaAuth): AuthState => {
  switch (state.state) {
    case "connected":
      return { state: "connected" };
    case "captcha_required":
      return {
        state: "captcha",
        captcha: state.image,
        captchaId: state.captchaId,
      };
    case "verification_required":
      return { state: "verify" };
    default:
      return { state: "error" };
  }
};
class MegaStations implements BackendStations {
  readonly metrics = { commands: 0, accepted: 0, failed: 0 };
  constructor(
    private client: () => EufyMegaClient | undefined,
    private devices: () => Device[],
    private states: Map<string, StationState>,
    private changed: () => void,
  ) {}
  inventory(): StationInfo[] {
    return this.devices()
      .filter((d) => d.kind === "station")
      .map((device) => {
        const state = this.states.get(device.id);
        return {
          serial: device.id,
          name: device.name,
          model: device.model,
          hardware: device.hardware ?? "",
          software: device.firmware ?? "",
          connected: !!this.client()?.connected && !!state?.connected,
          guard_mode: state?.guardMode ?? null,
          current_mode: state?.currentMode ?? null,
          alarm: state?.alarm ?? false,
          alarm_delay: state?.alarmDelay ?? 0,
          arm_delay: state?.armDelay ?? 0,
          modes: [...modes],
        };
      });
  }
  async setMode(serial: string, mode: unknown): Promise<void> {
    if (typeof mode !== "number" || !modes.includes(mode))
      throw new StationError("invalid_mode", 400);
    const client = this.client();
    if (
      !client?.connected ||
      !this.devices().some((d) => d.kind === "station" && d.id === serial)
    )
      throw new StationError("station_unavailable");
    this.metrics.commands++;
    try {
      const result = await client.setGuardMode(
        serial,
        mode,
        AbortSignal.timeout(30000),
      );
      if (!result.confirmed) throw new StationError("station_unconfirmed");
      this.states.set(serial, result.state);
      this.metrics.accepted++;
    } catch (error) {
      this.metrics.failed++;
      if (error instanceof EufyError && error.code === "station_busy")
        throw new StationError("station_busy", 409);
      if (error instanceof EufyError && error.code === "guard_mode_rejected")
        throw new StationError("station_rejected");
      throw new StationError("station_unconfirmed");
    } finally {
      this.changed();
    }
  }
  close(): void {
    this.states.clear();
  }
}

/** Only library-owned types enter the bridge. This adapter has no SDK fallback. */
export class MegaBackend extends EventEmitter implements Backend {
  private client?: EufyMegaClient;
  private devices = new Map<string, Device>();
  private capabilities = new Map<string, CameraCapabilities>();
  private stationStates = new Map<string, StationState>();
  private streams = new Map<
    string,
    { abort: AbortController; handle?: LiveStream; starting: Promise<void> }
  >();
  private closed = false;
  private ready = false;
  private timer?: NodeJS.Timeout;
  private refreshing = false;
  auth: AuthState = { state: "unconfigured" };
  readonly pictures = new Map<string, Picture>();
  readonly recordings: MegaRecordings;
  readonly stations: MegaStations;
  constructor(
    private storage: Storage,
    private readonly liveBusy: () => boolean | "live_busy" | "live_stopping",
    private factory: (options: ClientOptions) => EufyMegaClient = (options) =>
      new EufyMegaClient(options),
  ) {
    super();
    this.recordings = new MegaRecordings(
      () => this.client,
      () => [...this.devices.values()],
      liveBusy,
      async (serial) => {
        const capabilities = await this.client!.getCameraCapabilities(serial);
        if (!capabilities.recordings.available)
          throw new RecordingError("capability_unavailable", 503);
      },
    );
    this.stations = new MegaStations(
      () => this.client,
      () => [...this.devices.values()],
      this.stationStates,
      () => this.emit("change"),
    );
  }
  get connected(): boolean {
    return this.ready && (this.client?.connected ?? false);
  }
  get notifications() {
    const owner = this;
    return {
      get metrics() {
        const status = owner.client?.eventStatus;
        return {
          push_connected: status?.connected ?? false,
          received: status?.received ?? 0,
          duplicates: status?.duplicates ?? 0,
          last_received_at: status?.lastReceivedAt ?? null,
        };
      },
      close() {},
    };
  }
  async login(
    credentials?: Credentials,
    options?: LoginOptions,
  ): Promise<AuthState> {
    if (credentials) {
      this.client = this.factory({
        credentials: {
          email: credentials.username,
          password: credentials.password,
          country: credentials.country,
        },
        sessionStore: {
          load: async () => {
            const raw = await this.storage.read("mega-session.json");
            return raw ? JSON.parse(raw) : undefined;
          },
          save: (session) =>
            this.storage.write("mega-session.json", JSON.stringify(session)),
        },
      });
      this.bind(this.client);
    }
    const client = this.client;
    if (!client || this.closed) throw new Error("Credentials required");
    this.auth = { state: "connecting" };
    const answer = options?.verifyCode
      ? { verifyCode: options.verifyCode }
      : options?.captcha
        ? {
            captchaId: options.captcha.captchaId,
            answer: options.captcha.captchaCode,
          }
        : undefined;
    let authenticated: AuthState;
    try {
      authenticated = authState(await client.connect(answer));
    } catch (error) {
      if (
        error instanceof EufyError &&
        ["authentication_rejected", "invalid_authentication"].includes(
          error.code,
        )
      ) {
        this.auth = { state: "error" };
        return this.auth;
      }
      throw error;
    }
    if (authenticated.state !== "connected") {
      this.auth = authenticated;
      return this.auth;
    }
    await this.discover();
    await client.startEvents();
    if (this.closed) {
      await client.shutdown();
      throw new Error("Bridge closed");
    }
    if (!this.timer) {
      this.timer = setInterval(() => void this.refresh(), 60000);
      this.timer.unref();
    }
    this.ready = true;
    this.auth = { state: "connected" };
    this.emit("change");
    return this.auth;
  }
  private async discover(): Promise<void> {
    const client = this.client!;
    const devices = await client.listDevices();
    const next = new Map(devices.map((d) => [d.id, d]));
    for (const device of this.devices.values())
      if (device.kind === "camera" && !next.has(device.id)) {
        this.pictures.delete(device.id);
        this.emit("camera-removed", device.id);
      }
    this.devices = next;
    this.capabilities.clear();
    for (const device of devices.filter((d) => d.kind === "camera"))
      this.capabilities.set(
        device.id,
        await client.getCameraCapabilities(device.id),
      );
    for (const station of devices.filter((d) => d.kind === "station")) {
      try {
        await client.connectStation(station.id);
        this.stationStates.set(
          station.id,
          await client.refreshStationState(station.id),
        );
      } catch (error) {
        this.stationStates.set(station.id, {
          id: station.id,
          connected: false,
          guardMode: null,
          currentMode: null,
          alarm: false,
          alarmDelay: 0,
          armDelay: 0,
          commandEncryption: null,
        });
        this.emit(
          "backend_fault",
          error instanceof EufyError ? error.code : "connection_failed",
        );
      }
    }
    // HomeBase connection already requests existing cover images. This does not
    // start cameras or manufacture a new snapshot by briefly opening live video.
    this.emit("change");
  }
  private async refresh(): Promise<void> {
    if (this.closed || this.refreshing || !this.client) return;
    this.refreshing = true;
    try {
      if (!this.client.connected) {
        this.auth = authState(await this.client.connect());
        this.emit("change");
        if (this.auth.state !== "connected") return;
        if (!this.streams.size && !this.recordings.busy) await this.discover();
      }
      if (!this.streams.size && !this.recordings.busy && !this.liveBusy()) {
        for (const [id, state] of this.stationStates) {
          if (state.connected) continue;
          // Error/cancellation cleanup deliberately closes the device session.
          // Restore station telemetry while idle without waking a camera.
          await this.client.connectStation(id);
          this.stationStates.set(id, await this.client.refreshStationState(id));
          this.emit("change");
        }
      }
      if (!this.client.eventStatus.connected) await this.client.startEvents();
    } catch (error) {
      this.emit(
        "backend_fault",
        error instanceof EufyError ? error.code : "connection_failed",
      );
    } finally {
      this.refreshing = false;
    }
  }
  private async refreshCapabilities(id: string): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      const capabilities = await client.getCameraCapabilities(id);
      if (!this.closed && this.client === client && this.devices.has(id)) {
        this.capabilities.set(id, capabilities);
        this.emit("change");
      }
    } catch {
      // Preserve the last software admission. Operations recheck the client guard.
    }
  }
  private bind(client: EufyMegaClient): void {
    client.on("auth", (state) => {
      if (state.state !== "connected" || this.ready)
        this.auth = authState(state);
      this.emit("change");
    });
    client.on("device", (device) => {
      if (this.devices.has(device.id)) {
        this.devices.set(device.id, device);
        if (device.kind === "camera") void this.refreshCapabilities(device.id);
        this.emit("change");
      }
    });
    client.on("station", (state) => {
      this.stationStates.set(state.id, state);
      this.emit("change");
    });
    client.on("snapshot", (snapshot) => {
      this.pictures.set(snapshot.deviceId, {
        data: snapshot.data,
        mime: snapshot.mime,
        received: snapshot.receivedAt,
      });
      this.emit("change");
    });
    client.on("events-connection", () => this.emit("change"));
    client.on("live-stop", (result) => {
      // A cancelled start can stop the device before returning a media handle.
      // Established handles already deliver their result through handle.ended.
      const owned = this.streams.get(result.deviceId);
      if (owned && !owned.handle)
        this.emit("live-stop", {
          serial: result.deviceId,
          confirmed: result.confirmed,
        });
    });
    client.on("event", (event) => {
      this.emit("notification", {
        id: event.id,
        serial: event.deviceId,
        event_type: event.type,
        received_at: event.receivedAt,
        source: event.source,
        person_name: event.personName,
        recognition: event.recognition,
        occurred_at: event.occurredAt,
        ...(event.vendorEventType === undefined
          ? {}
          : { eufy_event_type: event.vendorEventType }),
      });
      this.emit("change");
    });
    client.on("fault", (error) =>
      this.emit(
        "backend_fault",
        error instanceof EufyError ? error.code : "device_failed",
      ),
    );
  }
  canStartLive(serial: string): boolean {
    if (!this.capabilities.get(serial)?.live.available) return false;
    const station = this.devices.get(serial)?.stationId;
    return (
      !!station &&
      ![...this.streams.keys()].some(
        (id) => this.devices.get(id)?.stationId === station,
      )
    );
  }
  async startLive(serial: string): Promise<void> {
    if (!this.client || !this.hasCamera(serial) || this.streams.has(serial))
      throw new Error("Camera unavailable");
    const client = this.client;
    const capability = (await client.getCameraCapabilities(serial)).live;
    if (this.closed || this.client !== client || this.streams.has(serial))
      throw new Error("Camera unavailable");
    if (!capability.available)
      throw new Error(capability.reason ?? "capability_unavailable");
    const abort = new AbortController();
    const owned: {
      abort: AbortController;
      handle?: LiveStream;
      starting: Promise<void>;
    } = {
      abort,
      starting: Promise.resolve(),
    };
    this.streams.set(serial, owned);
    owned.starting = (async () => {
      try {
        const handle = await this.client!.startLive(serial, abort.signal);
        owned.handle = handle;
        void handle.ended.then((result) => {
          if (this.streams.get(serial) === owned) this.streams.delete(serial);
          this.emit("live-stop", { serial, confirmed: result.confirmed });
        });
        const metadata = handle.metadata;
        const media: LiveMedia = {
          serial,
          videoCodec:
            metadata.videoCodec === "h264"
              ? "h264"
              : metadata.videoCodec === "h265"
                ? "hevc"
                : null,
          audioSupported: ["aac", "aac-lc", "aac-eld"].includes(
            metadata.audioCodec,
          ),
          fps: metadata.fps,
          video: handle.video,
          audio: handle.audio,
        };
        this.emit("live-start", media);
      } catch (error) {
        if (this.streams.get(serial) === owned) this.streams.delete(serial);
        throw error;
      }
    })();
    return owned.starting;
  }
  async stopLive(serial: string): Promise<void> {
    const owned = this.streams.get(serial);
    if (!owned) return;
    if (!owned.handle) {
      owned.abort.abort();
      await owned.starting.catch(() => {});
    }
    if (owned.handle) {
      const result = await owned.handle.stop();
      if (!result.confirmed) throw new Error("Device stop unconfirmed");
    }
  }
  async recoverStation(serial: string): Promise<string[]> {
    if (!this.client || this.streams.size || this.recordings.busy)
      throw new Error("Station still owned");
    const result = await this.client.ensureLiveStopped(
      serial,
      AbortSignal.timeout(28000),
    );
    if (!result.confirmed) throw new Error("Device stop unconfirmed");
    return [serial];
  }
  inventory(): CameraInfo[] {
    return [...this.devices.values()]
      .filter((d) => d.kind === "camera")
      .map((d) => ({
        serial: d.id,
        name: d.name,
        model: d.model,
        hardware: d.hardware ?? "",
        software: d.firmware ?? "",
        battery: d.battery,
        capabilities: this.capabilities.get(d.id),
        snapshot_received_at: this.pictures.get(d.id)?.received ?? null,
      }));
  }
  hasCamera(serial: string): boolean {
    return this.devices.get(serial)?.kind === "camera";
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    this.recordings.close();
    await Promise.allSettled(
      [...this.streams.keys()].map((serial) => this.stopLive(serial)),
    );
    try {
      await this.client?.shutdown();
    } finally {
      this.stations.close();
      this.devices.clear();
      this.pictures.clear();
      await this.storage.flush();
      this.removeAllListeners();
    }
  }
}
