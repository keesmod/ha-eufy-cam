import { EufySecurity, PropertyName, type Station, type CommandResult } from "eufy-security-client";

const MODES = new Set([0, 1, 2, 3, 4, 5, 47, 63]);
import {StationError} from './errors.js';
export {StationError} from './errors.js';

/** One command owner per station. State always comes from SDK telemetry. */
export class Stations {
  private stations = new Map<string, Station>();
  private pending = new Map<string, { mode: number; finish: (error?: Error) => void }>();
  private uncertain = new Set<string>();
  private removeListeners: (() => void)[] = [];
  readonly metrics = { commands: 0, accepted: 0, failed: 0 };
  constructor(private client: EufySecurity, private changed: () => void, private timeoutMs = 20_000) {
    const listen = (name: string, fn: (...args: any[]) => void) => {
      client.on(name as any, fn); this.removeListeners.push(() => client.off(name as any, fn));
    };
    listen("station added", (station: Station) => {
      if (station.hasProperty(PropertyName.StationGuardMode)) this.stations.set(station.getSerial(), station);
      changed();
    });
    listen("station removed", (station: Station) => {
      this.pending.get(station.getSerial())?.finish(new StationError("station_unavailable"));
      this.stations.delete(station.getSerial()); changed();
    });
    listen("station property changed", (_station: Station, name: string) => {
      if (["guardMode", "currentMode", "alarm", "alarmDelay", "alarmArmDelay"].includes(name)) changed();
    });
    listen("station connect", (station: Station) => { this.uncertain.delete(station.getSerial()); changed(); });
    listen("station close", (station: Station) => {
      this.pending.get(station.getSerial())?.finish(new StationError("station_unavailable")); changed();
    });
    listen("close", () => this.cancel());
    listen("station command result", (station: Station, result: CommandResult) => {
      const pending = this.pending.get(station.getSerial());
      const property = result.customData?.property;
      if (!pending || property?.name !== PropertyName.StationGuardMode || Number(property.value) !== pending.mode) return;
      pending.finish(result.return_code === 0 ? undefined : new StationError("station_rejected"));
    });
  }
  inventory() {
    return [...this.stations.values()].map(station => {
      const value = (name: PropertyName) => station.hasProperty(name) ? station.getPropertyValue(name) : undefined;
      const number = (name: PropertyName): number | null => {
        const v = value(name); return typeof v === "number" && Number.isFinite(v) ? v : null;
      };
      const metadata = station.getPropertyMetadata(PropertyName.StationGuardMode);
      const states = "states" in metadata ? metadata.states : undefined;
      return {
        serial: station.getSerial(), name: station.getName(), model: station.getModel(),
        hardware: station.getHardwareVersion(), software: station.getSoftwareVersion(),
        connected: this.client.isConnected() && station.isConnected(),
        guard_mode: number(PropertyName.StationGuardMode), current_mode: number(PropertyName.StationCurrentMode),
        alarm: value(PropertyName.StationAlarm) === true,
        alarm_delay: number(PropertyName.StationAlarmDelay) ?? 0,
        arm_delay: number(PropertyName.StationAlarmArmDelay) ?? 0,
        modes: Object.keys(states ?? {}).map(Number).filter(mode => MODES.has(mode)),
      };
    });
  }
  async setMode(serial: string, mode: unknown): Promise<void> {
    const info = this.inventory().find(s => s.serial === serial);
    if (!info?.connected) throw new StationError("station_unavailable");
    if (typeof mode !== "number" || !MODES.has(mode) || !info.modes.includes(mode)) throw new StationError("invalid_mode", 400);
    if (this.pending.has(serial)) throw new StationError("station_busy", 409);
    if (this.uncertain.has(serial)) throw new StationError("station_unconfirmed");
    this.metrics.commands++;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.uncertain.add(serial);
        finish(new StationError("station_unconfirmed"));
      }, this.timeoutMs);
      const finish = (error?: Error) => {
        if (!this.pending.has(serial)) return;
        clearTimeout(timer); this.pending.delete(serial);
        if (error) { this.metrics.failed++; reject(error); }
        else { this.metrics.accepted++; resolve(); }
        this.changed();
      };
      this.pending.set(serial, { mode, finish });
      void this.client.setStationProperty(serial, PropertyName.StationGuardMode, mode)
        .catch(() => finish(new StationError("station_rejected")));
    });
  }
  private cancel() {
    for (const request of this.pending.values()) request.finish(new StationError("station_unavailable"));
  }
  close() {
    this.cancel(); this.removeListeners.forEach(remove => remove()); this.stations.clear();
  }
}
