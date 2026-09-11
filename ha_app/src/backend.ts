import type { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';

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
export type CameraCapabilities = Record<'snapshot' | 'live' | 'recordings', MediaCapability>;
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
  modes: number[];
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
  video(
    serial: string,
    id: string,
    signal: AbortSignal,
    format?: 'h264' | 'native',
  ): Promise<Buffer>;
  close(): void;
}
export interface BackendStations {
  readonly metrics: { commands: number; accepted: number; failed: number };
  inventory(): StationInfo[];
  setMode(serial: string, mode: unknown): Promise<void>;
  close(): void;
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
}
export interface Backend extends EventEmitter {
  supportReport?(): import('./discovery-diagnostics.js').SupportReport;
  readonly connected: boolean;
  readonly auth: AuthState;
  readonly recordings: BackendRecordings;
  readonly stations: BackendStations | undefined;
  readonly notifications: { metrics: NotificationMetrics; close(): void };
  readonly pictures: Map<string, Picture>;
  login(credentials?: Credentials, options?: LoginOptions): Promise<AuthState>;
  inventory(): CameraInfo[];
  hasCamera(serial: string): boolean;
  canStartLive(serial: string): boolean;
  startLive(serial: string): Promise<void>;
  stopLive(serial: string): Promise<void>;
  recoverStation(serial: string): Promise<string[]>;
  close(): Promise<void>;
}
export type BackendName = 'mega';
export function backendName(value: string | undefined): BackendName {
  if (value === undefined || value === 'mega') return 'mega';
  throw new Error('Only Mega is supported. Legacy users must follow docs/MEGA_MIGRATION.md before upgrading.');
}
