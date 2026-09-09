import { randomUUID, createHash } from "node:crypto";
import type { EufySecurity, Device, PushMessage } from "eufy-security-client";

export const detectionEvents = {
  "device motion detected": "motion", "device person detected": "person",
  "device stranger person detected": "person", "device rings": "ring",
  "device vehicle detected": "vehicle", "device pet detected": "pet",
  "device crying detected": "crying", "device sound detected": "sound",
  "device package delivered": "package_delivered", "device package stranded": "package_stranded",
  "device package taken": "package_taken", "device someone loitering": "loitering",
  "device radar motion detected": "radar_motion", "device dog detected": "dog",
  "device dog lick detected": "dog_lick", "device dog poop detected": "dog_poop",
} as const;

// Eufy's DoorbellPushEvent, IndoorPushEvent and HB3PairedDevicePushEvent codes.
const pushTypes: Record<number, string> = {
  3101: "motion", 3102: "person", 3103: "ring", 3104: "crying", 3105: "sound",
  3106: "pet", 3107: "vehicle", 3108: "dog", 3109: "dog_lick", 3110: "dog_poop",
  3111: "person", 3112: "person", 3301: "package_delivered", 3302: "package_taken",
  3303: "person", 3304: "package_stranded", 3305: "loitering", 3306: "radar_motion",
};
export type Recognition = "known" | "unknown" | "unidentified" | "not_applicable";
export interface Notification {
  id: string; serial: string; event_type: string; received_at: string;
  source: "device" | "push"; person_name: string | null; recognition: Recognition;
  occurred_at: string | null; eufy_event_type?: number;
}
type Draft = Omit<Notification, "id">;
interface Pending { event: Draft; identities: Set<string>; transports: Set<number>; timer: ReturnType<typeof setTimeout> }

export function personName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return name && name.length <= 128 && !["unknown", "unknown person", "unbekannt", "onbekend"].includes(name.toLowerCase()) ? name : null;
}
function occurredAt(value: unknown): string | null {
  const time = typeof value === "number" ? value : typeof value === "string" && /^\d+(\.\d+)?$/.test(value) ? Number(value) : NaN;
  const ms = time < 1e12 ? time * 1000 : time;
  return Number.isFinite(ms) && ms >= 946684800000 && ms <= 4102444800000 ? new Date(ms).toISOString() : null;
}

/** One actionable detection, never SDK property resets or raw transport copies. */
export class Notifications {
  readonly metrics = { push_connected: false, received: 0, duplicates: 0, last_received_at: null as string | null };
  private pending = new Set<Pending>();
  private seen = new Map<string, number>();
  private lastPush = new Map<string, number>();
  constructor(private known: (serial: string) => boolean, private deliver: (event: Notification) => void, private changed: () => void, private settleMs = 500) {}

  bind(client: EufySecurity): void {
    this.close();
    client.on("push connect", () => { this.metrics.push_connected = true; this.changed(); });
    client.on("push close", () => { this.metrics.push_connected = false; this.changed(); });
    client.on("close", () => { this.close(); this.changed(); });
    client.on("push message", message => this.push(message));
    for (const [sdkEvent, eventType] of Object.entries(detectionEvents)) {
      client.on(sdkEvent as keyof typeof detectionEvents, (device: Device, active: boolean, name?: string) => {
        if (active !== true || !this.known(device.getSerial())) return;
        this.device(device.getSerial(), eventType, name, sdkEvent === "device stranger person detected");
      });
    }
  }

  private push(message: PushMessage): void {
    const serial = message.device_sn || message.station_sn;
    if (!this.known(serial)) return;
    const now = Date.now();
    for (const [key, expires] of this.seen) if (expires <= now) this.seen.delete(key);
    const type = pushTypes[message.event_type ?? -1] ?? "notification";
    const occurred_at = occurredAt(message.event_time);
    const identity = message.unique_id || message.event_session;
    const key = identity || occurred_at ? createHash("sha256").update(JSON.stringify([serial, type, identity || null, occurred_at])).digest("hex") : undefined;
    if (key && this.seen.has(key)) { this.metrics.duplicates++; return; }
    const name = type === "person" ? personName(message.person_name) : null;
    const event: Draft = {
      serial, event_type: type, received_at: new Date(now).toISOString(), source: "push", occurred_at,
      person_name: name, recognition: type !== "person" ? "not_applicable" : name || [3111, 3303].includes(message.event_type!) ? "known" : message.event_type === 3112 ? "unknown" : "unidentified",
      ...(Number.isSafeInteger(message.event_type) ? { eufy_event_type: message.event_type } : {}),
    };
    // Distinct IDs in the SAME format are distinct detections, even very close
    // together. Cross-format companions are correlated within the settling window.
    const existing = [...this.pending].find(p => p.event.serial === serial && (
      (p.event.source === "device" && (p.event.event_type === type || p.event.event_type === "motion" || type === "notification")) || ((p.event.event_type === type || p.event.eufy_event_type === message.event_type) && (
        (key !== undefined && p.identities.has(key)) ||
        (!p.transports.has(message.type) && (!occurred_at || !p.event.occurred_at || Math.abs(Date.parse(occurred_at) - Date.parse(p.event.occurred_at)) <= 1000)) ||
        (!key && p.identities.size === 0)
      ))
    ));
    this.lastPush.set(serial, now);
    if (existing) {
      const previous = existing.event;
      existing.event = { ...event, received_at: previous.received_at, occurred_at: event.occurred_at ?? previous.occurred_at };
      if (type === "notification" && previous.event_type !== "notification") {
        existing.event.event_type = previous.event_type;
        existing.event.person_name = previous.person_name;
        existing.event.recognition = previous.recognition;
      }
      if (!name && previous.event_type === "person" && type === "person" && previous.person_name) {
        existing.event.person_name = previous.person_name; existing.event.recognition = "known";
      }
      this.metrics.duplicates++;
      if (key) existing.identities.add(key);
      existing.transports.add(message.type);
    } else this.queue(event, key, message.type);
  }

  private device(serial: string, type: string, rawName?: string, stranger = false): void {
    const name = type === "person" ? personName(rawName) : null;
    const pending = [...this.pending].filter(p => p.event.serial === serial);
    const push = pending.find(p => p.event.source === "push" && p.event.event_type === type);
    const undecoded = pending.find(p => p.event.source === "push" && p.event.event_type === "notification");
    if (undecoded) {
      undecoded.event.event_type = type;
      undecoded.event.person_name = name;
      undecoded.event.recognition = type === "person" ? name ? "known" : stranger ? "unknown" : "unidentified" : "not_applicable";
    }
    if (push && name) { push.event.person_name = name; push.event.recognition = "known"; }
    // SDK simultaneousDetections synthesizes motion from people/vehicle alerts.
    // Prefer the upstream event, with its actual occurrence identity.
    if (pending.some(p => p.event.source === "push") || Date.now() - (this.lastPush.get(serial) ?? -Infinity) < 1500) { this.metrics.duplicates++; return; }
    const existing = pending.find(p => p.event.source === "device" && (p.event.event_type === type || p.event.event_type === "motion" || type === "motion"));
    const event: Draft = { serial, event_type: type, received_at: new Date().toISOString(), source: "device", occurred_at: null, person_name: name, recognition: type === "person" ? name ? "known" : stranger ? "unknown" : "unidentified" : "not_applicable" };
    if (existing) {
      // Merge the SDK's identity/person flags and generic motion fallback.
      if (type !== "motion" || existing.event.event_type === "motion") existing.event = { ...event, received_at: existing.event.received_at, person_name: name ?? existing.event.person_name, recognition: name || existing.event.person_name ? "known" : event.recognition };
      this.metrics.duplicates++;
    } else this.queue(event);
  }

  private queue(event: Draft, key?: string, transport?: number): void {
    if (this.pending.size >= 256) this.flush(this.pending.values().next().value!);
    const pending: Pending = { event, identities: new Set(key ? [key] : []), transports: new Set(transport === undefined ? [] : [transport]), timer: setTimeout(() => this.flush(pending), this.settleMs) };
    pending.timer.unref(); this.pending.add(pending);
  }
  private flush(pending: Pending): void {
    clearTimeout(pending.timer); this.pending.delete(pending);
    if (!this.known(pending.event.serial)) return;
    for (const key of pending.identities) this.seen.set(key, Date.now() + 300_000);
    while (this.seen.size > 2048) this.seen.delete(this.seen.keys().next().value!);
    this.metrics.received++; this.metrics.last_received_at = pending.event.received_at;
    this.deliver({ ...pending.event, id: randomUUID() }); this.changed();
  }
  close(): void {
    for (const p of this.pending) clearTimeout(p.timer);
    this.pending.clear(); this.lastPush.clear(); this.metrics.push_connected = false;
  }
}
