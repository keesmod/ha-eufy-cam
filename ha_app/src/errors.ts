export class RecordingError extends Error {
  constructor(
    readonly code:
      | "live_busy"
      | "live_stopping"
      | "recording_busy"
      | "recording_unavailable"
      | "recording_expired"
      | "history_incomplete"
      | "thumbnail_unavailable"
      | "capability_unavailable",
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
