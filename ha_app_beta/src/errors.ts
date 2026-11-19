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
const presetStatus = {
  invalid_preset: 400,
  capability_unavailable: 503,
  not_connected: 503,
  preset_not_sent: 503,
  station_busy: 409,
  preset_rejected: 502,
  preset_unconfirmed: 504,
} as const;
/** A preset move refused before the send, or after it without HomeBase acceptance (#229). */
export class PresetError extends Error {
  constructor(
    readonly code: keyof typeof presetStatus,
    readonly status: number = presetStatus[code],
  ) {
    super(code);
  }
}
/**
 * The guard modes every HomeBase accepts, in the order the inventory offers
 * them. State reports them as `modes`, which never holds 6, because
 * integrations before 0.8.53 reject a state frame whose `modes` holds it.
 */
export const guardModes: readonly number[] = [0, 1, 2, 3, 4, 5, 47, 63];
/**
 * Modes a HomeBase accepts only when the client says so, reported as
 * `extra_modes`. 6 is Off, settable on a HomeBase with an admitted keypad (#275).
 */
export const extraGuardModes: readonly number[] = [6];
/**
 * The guard mode of a request. Anything else is invalid_mode. Whether this
 * HomeBase accepts an extra mode is checked later against its state.
 */
export function guardMode(value: unknown): number {
  if (typeof value !== 'number' || (!guardModes.includes(value) && !extraGuardModes.includes(value)))
    throw new StationError('invalid_mode', 400);
  return value;
}
/** The wire index 0..3 of a preset request. Anything else, also `'1'` or `'PRESET_1'`, is invalid_preset. */
export function presetIndex(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 3)
    throw new PresetError('invalid_preset');
  return value;
}
