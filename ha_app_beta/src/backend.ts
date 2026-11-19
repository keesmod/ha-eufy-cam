import type { RecordingFormat, RecordingResult } from './recording-media.js';
import type { DiagnosticEvent } from './diagnostics.js';
import type { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import type { LiveAdmission } from './streams.js';
import type { LiveStartProgress } from '@keesmod/eufy-mega-client';

export interface Credentials {
  username: string;
  password: string;
  country: string;
}
export interface LoginOptions {
  verifyCode?: string;
  captcha?: { captchaCode: string; captchaId: string };
  force?: boolean;
}
export type AuthState = {
  state: 'unconfigured' | 'connected' | 'connecting' | 'error' | 'verify' | 'captcha';
  captcha?: string;
  captchaId?: string;
};
export interface MediaCapability {
  available: boolean;
  status: 'experimental' | 'unsupported';
  reason: string | null;
}
export type CameraCapabilities = Record<'snapshot' | 'live' | 'recordings', MediaCapability> & {
  /** Preset moves from client 0.30.3. Absent from older clients, which is unavailable (#229). */
  presets?: MediaCapability;
};
export interface CameraInfo {
  serial: string;
  name: string;
  model: string;
  hardware: string;
  software: string;
  battery: number | null;
  snapshot_received_at: string | null;
  capabilities?: CameraCapabilities;
}
export interface StationInfo {
  serial: string;
  name: string;
  model: string;
  hardware: string;
  software: string;
  connected: boolean;
  guard_mode: number | null;
  current_mode: number | null;
  alarm: boolean;
  alarm_delay: number;
  arm_delay: number;
  /** The legacy settable modes. Never 6, because integrations before 0.8.53 reject the frame then. */
  modes: number[];
  /** Further settable modes, today only 6 (Off) on a HomeBase with an admitted keypad (#275). */
  extra_modes: number[];
}
/** One value of a HomeBase accessory as the client last saw it (#275). */
export interface AccessoryReadingInfo {
  value: boolean;
  source: 'p2p' | 'push' | 'cloud';
  observed_at: string;
  /** Observed by P2P or push since the HomeBase session last closed. */
  live: boolean;
}
/**
 * A HomeBase accessory or a recognized chime (#275). It is no camera and no
 * station, has no media and accepts no command.
 */
export interface AccessoryInfo {
  serial: string;
  name: string;
  model: string;
  hardware: string;
  software: string;
  category: 'entry_sensor' | 'keypad' | 'chime';
  /** The HomeBase of an entry sensor or keypad, null for a chime. */
  station: string | null;
  readings: Partial<Record<'open' | 'battery_low' | 'charging', AccessoryReadingInfo | null>>;
}
export interface Picture {
  data: Buffer;
  mime: string;
  received: string;
}
export interface Recording {
  id: string;
  serial: string;
  start: string;
  end: string;
  bytes: number;
  thumbnail: boolean;
}
export interface BackendRecordings {
  readonly busy: boolean;
  readonly metrics: {
    queries: number;
    downloads: number;
    completed: number;
    remuxed: number;
    transcoded: number;
    cancelled: number;
  };
  list(
    serial: string,
    date: string,
    signal: AbortSignal,
  ): Promise<{ recordings: Recording[]; returned: number }>;
  timeline(
    serials: string[],
    date: string,
    signal: AbortSignal,
  ): Promise<{ recordings: Recording[]; returned: number; complete: true }>;
  calendar(serials: string[], month: string, signal: AbortSignal): Promise<{ days: string[] }>;
  thumbnail(serial: string, id: string, signal: AbortSignal): Promise<Buffer>;
  video(serial: string, id: string, signal: AbortSignal,
    consume: (result: RecordingResult, signal: AbortSignal) => Promise<void>,
    format?: RecordingFormat, hevcSupported?: boolean, started?: (attempt: number) => void): Promise<void>;
  close(): void;
}
export interface BackendStations {
  readonly metrics: { commands: number; accepted: number; failed: number };
  inventory(): StationInfo[];
  setMode(serial: string, mode: unknown): Promise<void>;
  close(): void;
}
/** Preset moves for cameras whose `presets` capability is available (#229). */
export interface BackendPresets {
  readonly metrics: { commands: number; accepted: number; rejected: number; unconfirmed: number; refused: number };
  /** Resolves once the HomeBase accepted the move, which is not move completion. */
  move(serial: string, preset: unknown): Promise<void>;
}
export interface NotificationMetrics {
  push_connected: boolean;
  received: number;
  duplicates: number;
  last_received_at: string | null;
}
export interface LiveMedia {
  serial: string;
  videoCodec: 'h264' | 'hevc' | null;
  audioSupported: boolean;
  fps: number;
  video: Readable;
  audio: Readable;
  /**
   * The library's own streams when `video` and `audio` are paced on the
   * camera's clock. Diagnostics observe the P2P input here.
   */
  source?: { video: Readable; audio: Readable };
}
export interface Backend extends EventEmitter {
  recordAudioEvent?(serial: string, event: DiagnosticEvent): void;
  audioAttempt?(serial: string): number | undefined;
  supportReport?(): import('./discovery-diagnostics.js').SupportReport;
  readonly connected: boolean;
  readonly auth: AuthState;
  readonly recordings: BackendRecordings;
  readonly stations: BackendStations | undefined;
  readonly presets?: BackendPresets;
  readonly notifications: { metrics: NotificationMetrics; close(): void };
  readonly pictures: Map<string, Picture>;
  login(credentials?: Credentials, options?: LoginOptions): Promise<AuthState>;
  inventory(): CameraInfo[];
  /** HomeBase accessories and recognized chimes, without I/O (#275). */
  accessories?(): AccessoryInfo[];
  hasCamera(serial: string): boolean;
  canStartLive(serial: string): LiveAdmission;
  /**
   * `onProgress` receives the library's start stages for the camera's live video
   * row. It must report `start_issued` before START reaches the device, because
   * the live hub releases a camera whose start failed without that stage.
   */
  startLive(serial: string, maxDurationMs?: number, onProgress?: (progress: LiveStartProgress) => void): Promise<void>;
  /** Upper bound in milliseconds for one live session of this camera, 120000 unless the backend allows more. */
  liveBoundMs?(serial: string): number;
  stopLive(serial: string): Promise<void>;
  recoverStation(serial: string): Promise<string[]>;
  close(): Promise<void>;
}
export type BackendName = 'mega';
export function backendName(value: string | undefined): BackendName {
  if (value === undefined || value === 'mega') return 'mega';
  throw new Error('Only Mega is supported. Legacy users must follow docs/MEGA_MIGRATION.md before upgrading.');
}
