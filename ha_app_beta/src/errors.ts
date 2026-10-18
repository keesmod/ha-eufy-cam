export class RecordingError extends Error {
  constructor(
    readonly code:
      | 'live_busy'
      | 'live_stopping'
      | 'recording_busy'
      | 'recording_unavailable'
      | 'recording_storage_unavailable'
      | 'recording_expired'
      | 'history_incomplete'
      | 'thumbnail_unavailable'
      | 'capability_unavailable',
    readonly status: number,
  ) {
    super(code);
  }
}
export class StationError extends Error {
  constructor(
    readonly code: string,
    readonly status = 503,
  ) {
    super(code);
  }
}
const snapshotStatus = {
  capability_unavailable: 503,
  not_connected: 503,
  recording_busy: 409,
  live_stopping: 409,
  station_limit: 409,
  camera_busy: 409,
  refresh_timeout: 504,
  refresh_failed: 502,
} as const;
export class SnapshotError extends Error {
  constructor(
    readonly code: keyof typeof snapshotStatus,
    readonly status: number = snapshotStatus[code],
  ) {
    super(code);
  }
}
