/** Bounded support reports from public library results. Never serialize raw input. */
import { readFileSync } from 'node:fs';
import type {
  CameraCapabilities,
  DeviceRelationship,
  Diagnostic,
  DiscoveryResult,
  RecordingObservation,
  StationConnectionProgress,
  StationKeySetupObservation,
  StationLookupObservation,
  StationState,
} from '@keesmod/eufy-mega-client';
import type { MigrationInventory } from './migration.js';

// Library error codes are machine identifiers, never messages or payloads.
// Validate the complete value so future codes survive without a duplicated list.
export const diagnosticCode = (value: unknown): string =>
  typeof value === 'string' &&
  value.length <= 64 &&
  /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.exec(value)?.[0] === value
    ? value
    : 'unclassified_error';
// A received model code of at most eight characters, optionally with a short
// hyphen suffix such as T8113-Z (#129) or an unhyphenated catalogue suffix such
// as T8410C (#149). Serials and free text never match. The value is shown as
// received or not at all: never trimmed, truncated, coerced or taken from a serial.
// The live video and audio rows use this same bound.
export const diagnosticModel = (value: unknown): string =>
  typeof value === 'string' &&
  value.length <= 8 &&
  /^T[A-Z0-9]{4}(?:[A-Z0-9]{1,3}|-[A-Z0-9]{1,2})?$/.test(value)
    ? value
    : 'unavailable';
const model = diagnosticModel;
export const connectionStages: ReadonlySet<string> = new Set(['none', 'lookup', 'station_found', 'session_open', 'encryption_ready']);
/** How far a failed station connection got, from the library's connection stages. */
export interface StationConnectionDetail {
  stage: string;
  inventoryAddress?: boolean;
  /** What the attempt's local lookup saw, from client 0.30.0. Revalidated before it is reported. */
  lookup?: StationLookupObservation;
  /** Milliseconds from the attempt's start to `session_open`, from the library's progress. */
  sessionOpenMs?: number;
  /** What the session saw between `session_open` and the command key, from client 0.30.2. Revalidated before it is reported. */
  keySetup?: StationKeySetupObservation;
}
/**
 * Records the last stage a station connection reached and what its local lookup
 * saw, for the diagnostic record of that attempt.
 */
export function connectionAttempt(): {
  detail: StationConnectionDetail;
  onProgress: (progress: StationConnectionProgress) => void;
  onLookup: (observation: StationLookupObservation) => void;
  onKeySetup: (observation: StationKeySetupObservation) => void;
} {
  const detail: StationConnectionDetail = { stage: 'none' };
  return {
    detail,
    onProgress: (progress) => {
      // A stage a newer library adds keeps the last known one.
      if (!connectionStages.has(progress.stage)) return;
      detail.stage = progress.stage;
      if (typeof progress.inventoryAddress === 'boolean')
        detail.inventoryAddress = progress.inventoryAddress;
      if (progress.stage === 'session_open') detail.sessionOpenMs = progress.elapsedMs;
    },
    // Observation only (#152). The diagnostics revalidate each value before
    // they report it, and the library ignores anything this throws.
    onLookup: (observation) => {
      detail.lookup = observation;
    },
    // Observation only (#142), revalidated like the lookup.
    onKeySetup: (observation) => {
      detail.keySetup = observation;
    },
  };
}
/** A recording request of the bridge, by the client operation it uses (#152). */
export type RecordingQuery = 'list' | 'calendar' | 'thumbnail' | 'download';
/** One recording operation of the bridge for the recording_query record (#152). */
export interface RecordingQueryReport {
  /** `probe` is the opt-in standalone recording probe of the login discovery (#178). */
  query: RecordingQuery | 'probe';
  /** The client's own report of the operation, revalidated here. Absent when it reported none. */
  observation?: RecordingObservation;
  /** Without an observation: the bridge's reason, such as client_disconnected. */
  reason?: string;
  /** Without an observation: the numeric remoteCode of the error. */
  remoteCode?: unknown;
  /** Without an observation: milliseconds the bridge measured until the failure. */
  elapsedMs?: number;
  /** How far the owner's connection got when the operation had to connect. */
  connection?: StationConnectionDetail;
  /** The HTTP status the bridge answered the request with. Absent for a probe, which answers no request. */
  returned?: number;
}
type LookupFields = Record<string, number | boolean | string>;
/**
 * Flat fields for the command key setup of one connection attempt (#142), with
 * the time its session opened. Each value is revalidated here. An integer out
 * of its range or a value that is not a real boolean is left out, and the
 * observation itself is never serialized.
 */
function keySetupFields(detail: StationConnectionDetail): LookupFields {
  const time: LookupFields = {};
  const opened = integer(detail.sessionOpenMs, 0, 120000);
  if (opened !== null) time.session_open_ms = opened;
  const fields: LookupFields = { ...time };
  try {
    const value: unknown = detail.keySetup;
    if (!value || typeof value !== 'object') return fields;
    const key = value as Record<string, unknown>;
    const count = (name: string, raw: unknown) => {
      const safe = integer(raw, 0, 999);
      if (safe !== null) fields[name] = safe;
    };
    const bool = (name: string, raw: unknown) => {
      if (typeof raw === 'boolean') fields[name] = raw;
    };
    count('key_request_sends', key.requestSends);
    bool('key_request_acknowledged', key.requestAcknowledged);
    bool('key_result_wait_expired', key.resultWaitExpired);
    count('key_answers', key.answers);
    count('key_data_datagrams', key.dataDatagrams);
    count('key_other_messages', key.otherMessages);
    count('key_heartbeats', key.heartbeats);
    bool('key_ended', key.ended);
    // Client 0.30.2: a DATA channel result to the key request and the
    // kind of the other messages, protocol numbers only.
    count('key_results', key.results);
    const code = integer(key.resultCode, -999999, 999999);
    if (code !== null) fields.key_result_code = code;
    bool('key_result_encrypted', key.resultEncrypted);
    count('key_control_messages', key.controlMessages);
    if (Array.isArray(key.otherCommands)) {
      const commands: readonly unknown[] = key.otherCommands;
      // A fixed loop and fixed names, so the list cannot choose a field name.
      for (const [index, name] of ['key_other_command_1', 'key_other_command_2', 'key_other_command_3'].entries()) {
        const command = integer(commands[index], 0, 65535);
        if (command !== null) fields[name] = command;
      }
    }
    count('key_media_datagrams', key.mediaDatagrams);
    count('key_repeated_datagrams', key.repeatedDatagrams);
    count('key_signed_messages', key.signedMessages);
    bool('key_without_answer', key.keyWithoutAnswer);
    return fields;
  } catch {
    // Diagnostics never alter discovery. An observation that cannot be read is
    // omitted, and the time of the stage stays.
    return time;
  }
}
const lookupReplies: ReadonlySet<unknown> = new Set(['none', 'own', 'account', 'foreign', 'near']);
/**
 * Flat fields for the local lookup of one connection attempt (#152). Each value
 * is revalidated here. An integer out of its range, a value that is not a real
 * boolean or a reply class outside the fixed set is left out, and the
 * observation itself is never serialized.
 */
function lookupFields(value: unknown): LookupFields {
  const fields: LookupFields = {};
  try {
    if (!value || typeof value !== 'object') return fields;
    const lookup = value as Record<string, unknown>;
    const count = (key: string, raw: unknown, max: number) => {
      const safe = integer(raw, 0, max);
      if (safe !== null) fields[key] = safe;
      return safe;
    };
    const bool = (key: string, raw: unknown) => {
      if (typeof raw === 'boolean') fields[key] = raw;
    };
    count('lookup_rounds', lookup.rounds, 99);
    count('lookup_broadcast_targets', lookup.broadcastTargets, 16);
    bool('lookup_broadcast_enabled', lookup.broadcastEnabled);
    count('lookup_send_errors', lookup.sendErrors, 999);
    count('lookup_datagrams', lookup.datagrams, 999);
    count('lookup_other_headers', lookup.otherHeaders, 999);
    const own = count('lookup_own_replies', lookup.ownReplies, 999);
    // The round of the first own reply exists only with an own reply.
    if (own !== null && own > 0) count('lookup_own_round', lookup.ownRound, 99);
    count('lookup_account_replies', lookup.accountReplies, 999);
    count('lookup_foreign_replies', lookup.foreignReplies, 999);
    count('lookup_near_replies', lookup.nearReplies, 999);
    if (lookupReplies.has(lookup.inventoryReply))
      fields.lookup_inventory_reply = lookup.inventoryReply as string;
    bool('inventory_address_on_subnet', lookup.inventoryAddressOnSubnet);
    bool('inventory_address_shared', lookup.inventoryAddressShared);
    return fields;
  } catch {
    // Diagnostics never alter discovery. A value that cannot be read is omitted.
    return {};
  }
}
/** Protocol numbers that are an outcome by their exact value, not counts (#142). */
const exactClassFields: ReadonlySet<string> = new Set([
  'key_result_code', 'key_other_command_1', 'key_other_command_2', 'key_other_command_3',
]);
/**
 * The coarse outcome of a lookup for the repeat check: whether each count is
 * zero, each boolean and the reply class, and the exact return code and command
 * numbers of the key setup. Changed counts alone are a repeat.
 */
const lookupClass = (fields: LookupFields): string | null =>
  Object.keys(fields).length === 0
    ? null
    : JSON.stringify(
        Object.entries(fields).map(([key, value]) => [
          key,
          typeof value === 'number' && !exactClassFields.has(key) ? value > 0 : value,
        ]),
      );
/** An opted-in standalone camera that is its own experimental owner. */
export const experimentalOwner = (
  relationship: DeviceRelationship | undefined,
): relationship is Extract<DeviceRelationship, { transport: 'experimental' }> =>
  relationship?.kind === 'standalone' &&
  'transport' in relationship &&
  relationship.transport === 'experimental';
const flag = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);
const integer = (value: unknown, min: number, max: number): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null;
const recordingQueries: ReadonlySet<unknown> = new Set(['list', 'calendar', 'thumbnail', 'download', 'probe']);
// #283: client 0.31.3 reasons and station relations of a push that produced no event.
const unroutedReasons: ReadonlySet<unknown> = new Set([
  'no_serial',
  'unknown_device',
  'camera_unavailable',
  'owner_mismatch',
  'unsupported_event',
  'station_detection',
]);
const unroutedStations: ReadonlySet<unknown> = new Set(['owner', 'device', 'station', 'unknown', 'missing']);
/** One unrouted_push line per distinct record per window, for at most this many records. */
const UNROUTED_WINDOW_MS = 600_000;
const UNROUTED_RECORDS = 32;
const recordingOwners: ReadonlySet<unknown> = new Set(['standalone', 'station']);
const queryStages: ReadonlySet<unknown> = new Set(['admission', 'connect', 'query', 'validate', 'transfer']);
const unhandledReasons: ReadonlySet<unknown> = new Set(['unknown_cmd', 'parse_error']);
const rowClasses = [
  ['own', 'rows_own'],
  ['otherDevice', 'rows_other_device'],
  ['stationMismatch', 'rows_station_mismatch'],
  ['invalidTime', 'rows_invalid_time'],
  ['otherDay', 'rows_other_day'],
  ['cipherId', 'rows_cipher_id'],
] as const;
/** Counts whose change alone repeats the previous recording_query record. */
const recordingCounts: ReadonlySet<string> = new Set([
  'query_rows',
  'unhandled_replies',
  ...rowClasses.map(([, field]) => field),
]);
const resultCode = (value: unknown) => integer(value, -999999, 999999);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
/**
 * Flat fields of one recording operation (#152): the client's observation, or
 * the bridge's own reason when the client reported none. Each value is
 * revalidated. A value out of its bound is null, and nothing else of the
 * observation is copied. The last page is the one a failure ended on.
 */
function recordingFields(value: RecordingQueryReport, standalone: boolean): Record<string, unknown> {
  const observation = record(value.observation);
  // Without an observation no client operation reported itself: a bridge refusal
  // or an error before the client's recording access, always a failure.
  const pages = !observation ? [] : Array.isArray(observation.pages) ? observation.pages : null;
  const page = pages?.length ? record(pages.at(-1)) : undefined;
  const none = pages?.length === 0;
  const classes = observation ? observation.rowClasses : null;
  const code = observation ? observation.code : value.reason;
  const failed = !observation || code !== null;
  const connection = value.connection;
  // The stage and lookup of the owner's connection, only when the operation connected.
  const connected =
    connection !== undefined && (connection.stage !== 'none' || connection.lookup !== undefined);
  return {
    query: recordingQueries.has(value.query) ? value.query : null,
    owner: observation
      ? recordingOwners.has(observation.owner) ? observation.owner : null
      : standalone ? 'standalone' : 'station',
    status: failed ? 'error' : 'completed',
    // The client names any error that is not a EufyError unexpected_error.
    reason: !failed ? null : code === 'unexpected_error' ? 'unclassified_error' : diagnosticCode(code),
    result_code: resultCode(observation ? observation.remoteCode : value.remoteCode),
    session_open: observation ? flag(observation.sessionOpen) : null,
    query_stage: !observation
      ? 'admission'
      : queryStages.has(observation.stage) ? observation.stage : null,
    ...(connected
      ? {
          stage: connectionStages.has(connection.stage) ? connection.stage : 'none',
          ...(typeof connection.inventoryAddress === 'boolean'
            ? { inventory_address: connection.inventoryAddress }
            : {}),
          ...(connection.lookup === undefined ? {} : lookupFields(connection.lookup)),
        }
      : {}),
    elapsed_ms: integer(observation ? observation.elapsedMs : value.elapsedMs, 0, 3600000),
    pages: pages === null ? null : integer(pages.length, 0, 4),
    // A query that sent no page reports limit 0 and no answer.
    query_limit: page ? integer(page.limit, 0, 10000) : none ? 0 : null,
    query_answered: page ? flag(page.answered) : none ? false : null,
    ack_code: page ? resultCode(page.ackCode) : null,
    query_result_code: page ? resultCode(page.resultCode) : null,
    query_rows: page ? integer(page.rows, 0, 10000) : null,
    unhandled_replies: observation ? integer(observation.unhandledReplies, 0, 99) : 0,
    unhandled_reason:
      observation && unhandledReasons.has(observation.unhandledReason)
        ? observation.unhandledReason
        : null,
    unhandled_result_code: observation ? resultCode(observation.unhandledResultCode) : null,
    // Rows of the latest answered list page. Without one each count is 0.
    ...Object.fromEntries(
      rowClasses.map(([key, field]) => [
        field,
        classes === null || classes === undefined ? 0 : integer(record(classes)?.[key], 0, 10000),
      ]),
    ),
    returned: integer(value.returned, 100, 599),
  };
}
/**
 * The outcome of a recording record for the repeat check: every value except
 * the elapsed time, with each count reduced to whether it is zero.
 */
const recordingClass = (fields: Record<string, unknown>): string =>
  JSON.stringify(
    Object.entries(fields)
      .filter(([key]) => key !== 'elapsed_ms')
      .map(([key, value]) => [
        key,
        typeof value === 'number' && (recordingCounts.has(key) || key.startsWith('lookup_'))
          ? value > 0
          : value,
      ]),
  );
export const diagnosticVersion = (value: unknown): string =>
  typeof value === 'string' &&
  value.length <= 19 &&
  !/[^0-9.]/.test(value) &&
  /^[0-9]{1,4}(?:\.[0-9]{1,4}){0,3}$/.test(value)
    ? value
    : 'unavailable';
// The bridge and client library release versions: the numeric form above,
// optionally with a -beta.N suffix such as 0.8.38-beta.1, at most 24 characters.
// The HA download applies the same bound. Firmware, hardware and Node versions
// stay numeric.
export const diagnosticReleaseVersion = (value: unknown): string =>
  typeof value === 'string' &&
  value.length <= 24 &&
  /^[0-9]{1,4}(?:\.[0-9]{1,4}){0,3}(?:-beta\.[1-9][0-9]{0,3})?$/.test(value)
    ? value
    : 'unavailable';
function packageVersion(path: string): string {
  try {
    return diagnosticReleaseVersion(
      JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')).version,
    );
  } catch {
    return 'unavailable';
  }
}
export const diagnosticSoftware = () => ({
  bridge: packageVersion('../package.json'),
  library: packageVersion('../node_modules/@keesmod/eufy-mega-client/package.json'),
  node: diagnosticVersion(process.versions.node),
  platform: ['linux', 'darwin', 'win32'].includes(process.platform) ? process.platform : 'other',
  arch: ['x64', 'arm64', 'arm'].includes(process.arch) ? process.arch : 'other',
});
const cloudRoutes = new Map([
  ['/app/house/get_devs_list', 'inventory'],
  ['/passport/login', 'login'],
  ['/passport/estimate_domain', 'region'],
  ['/openapi/oauth/key/exchange', 'key_exchange'],
  ['/app/sendmsg/verify_code', 'verification'],
]);
/** One histogram row of the standalone push observation (#185). */
export interface StandalonePushRow {
  /** The decimal value 0 to 99999, `none` when the field was absent, `other` for anything else. */
  code: number | 'none' | 'other';
  count: number;
}
/**
 * The client's numbers-only observation of pushes that name an experimental
 * standalone owner (#185), revalidated here. A value outside its bound is null.
 */
export interface StandalonePushReport {
  arrived: number | null;
  admitted: number | null;
  refused: Record<(typeof standalonePushRefusals)[number], number | null>;
  sources: { cloud: number | null; local: number | null };
  event_codes: StandalonePushRow[];
  push_types: StandalonePushRow[];
}
const standalonePushRefusals = [
  'events_not_enabled',
  'owner_unavailable',
  'serial_mismatch',
  'type_mismatch',
  'unsupported_event',
] as const;
/** A push count, the same bound as the integration's other counters. */
const pushCount = (value: unknown) => integer(value, 0, 2 ** 31 - 1);
/** At most 16 numeric keys, as the client bounds them, then `none` and `other`. */
const STANDALONE_PUSH_CODES = 16;
function standalonePushRows(value: unknown): StandalonePushRow[] {
  const histogram = record(value);
  if (!histogram || Array.isArray(histogram)) return [];
  const numeric: StandalonePushRow[] = [];
  const named: StandalonePushRow[] = [];
  for (const [key, raw] of Object.entries(histogram)) {
    const count = pushCount(raw);
    if (count === null) continue;
    if (/^(?:0|[1-9][0-9]{0,4})$/.test(key)) numeric.push({ code: Number(key), count });
  }
  for (const code of ['none', 'other'] as const) {
    const count = pushCount(histogram[code]);
    if (count !== null) named.push({ code, count });
  }
  numeric.sort((a, b) => (a.code as number) - (b.code as number));
  return [...numeric.slice(0, STANDALONE_PUSH_CODES), ...named];
}
/**
 * Project the client's `standalonePushStatus` for the support report (#185).
 * It crosses a library boundary, so every value is checked again and nothing
 * but bounded integers and the code keys above leaves. Null without an
 * observation.
 */
export function standalonePushReport(value: unknown): StandalonePushReport | null {
  const observation = record(value);
  if (!observation || Array.isArray(observation)) return null;
  const refused = record(observation.refused);
  const sources = record(observation.sources);
  return {
    arrived: pushCount(observation.arrived),
    admitted: pushCount(observation.admitted),
    refused: Object.fromEntries(
      standalonePushRefusals.map((reason) => [reason, pushCount(refused?.[reason])]),
    ) as StandalonePushReport['refused'],
    sources: { cloud: pushCount(sources?.cloud), local: pushCount(sources?.local) },
    event_codes: standalonePushRows(observation.eventCodes),
    push_types: standalonePushRows(observation.pushTypes),
  };
}
/**
 * How the running client received HomeBase accessory state, by route (#275).
 * Counts only, never a serial, channel, name, door state or time.
 */
export const accessoryObservationKeys = [
  'hub_notify',
  'sensor_status',
  'push_door_sensor',
  'camera_info',
  'cloud_seeded',
  'conflicts',
  'unknown_channel',
] as const;
export type AccessoryObservationReport = Record<(typeof accessoryObservationKeys)[number], number | null>;
/**
 * Project the client's `accessoryObservation` for the support report (#275).
 * It crosses a library boundary, so only the known keys leave, each as a
 * bounded integer or null. Null without an observation, as before client 0.31.0.
 */
export function accessoryObservationReport(value: unknown): AccessoryObservationReport | null {
  const observation = record(value);
  if (!observation || Array.isArray(observation)) return null;
  return Object.fromEntries(
    accessoryObservationKeys.map((key) => [key, pushCount(observation[key])]),
  ) as AccessoryObservationReport;
}
/** The queries, row outcomes, event_count changes and download outcomes of client 0.31.3 (#293). */
export const snapshotTriggers = ['push', 'request', 'connect'] as const;
export const snapshotRowOutcomes = [
  'no_row',
  'homebase_path',
  'unchanged_path',
  'cloud_path_only',
  'no_path',
  'path_absent',
  'invalid_path',
] as const;
export const snapshotEventCounts = ['first', 'increased', 'unchanged', 'decreased', 'unavailable'] as const;
export const snapshotDownloadOutcomes = ['kept', 'not_jpeg', 'too_large', 'superseded', 'no_reply'] as const;
type SnapshotTrigger = (typeof snapshotTriggers)[number];
/**
 * At most this many rows per list. Only counts above 0 are listed, and an account
 * has few camera models, so this stays far above what one account produces. Rows
 * beyond it are left out.
 */
export const SNAPSHOT_REFRESH_ROWS = 96;
export interface SnapshotRefreshReport {
  replies: Record<SnapshotTrigger | 'failed', number | null>;
  rows: { model: string; trigger: SnapshotTrigger; outcome: (typeof snapshotRowOutcomes)[number]; count: number }[];
  event_counts: { model: string; trigger: SnapshotTrigger; change: (typeof snapshotEventCounts)[number]; count: number }[];
  downloads: { model: string; outcome: (typeof snapshotDownloadOutcomes)[number]; count: number }[];
}
/**
 * Project the client's `snapshotRefreshStatus` for the support report (#293).
 * It crosses a library boundary, so only known keys leave: the model as the
 * bounded model code, `other` or `unavailable`, and each count above 0 as a
 * bounded integer. Rows of the same values are added up. Null without an
 * observation, as before client 0.31.3.
 */
export function snapshotRefreshReport(value: unknown): SnapshotRefreshReport | null {
  const observation = record(value);
  if (!observation || Array.isArray(observation)) return null;
  const replies = record(observation.replies);
  const models = record(observation.models);
  const rows = new Map<string, SnapshotRefreshReport['rows'][number]>();
  const changes = new Map<string, SnapshotRefreshReport['event_counts'][number]>();
  const downloads = new Map<string, SnapshotRefreshReport['downloads'][number]>();
  const add = <T extends { count: number }>(target: Map<string, T>, row: Omit<T, 'count'>, raw: unknown) => {
    const count = pushCount(raw);
    if (!count) return;
    const key = JSON.stringify(row);
    const existing = target.get(key);
    if (existing) existing.count = Math.min(2 ** 31 - 1, existing.count + count);
    else if (target.size < SNAPSHOT_REFRESH_ROWS) target.set(key, { ...row, count } as T);
  };
  if (models && !Array.isArray(models))
    for (const [key, raw] of Object.entries(models)) {
      const counts = record(raw);
      if (!counts) continue;
      const name = key === 'other' ? 'other' : model(key);
      const byTrigger = record(counts.rows);
      const changeByTrigger = record(counts.eventCounts);
      for (const trigger of snapshotTriggers) {
        const outcomes = record(byTrigger?.[trigger]);
        for (const outcome of snapshotRowOutcomes) add(rows, { model: name, trigger, outcome }, outcomes?.[outcome]);
        const kinds = record(changeByTrigger?.[trigger]);
        for (const change of snapshotEventCounts) add(changes, { model: name, trigger, change }, kinds?.[change]);
      }
      const fetched = record(counts.downloads);
      for (const outcome of snapshotDownloadOutcomes) add(downloads, { model: name, outcome }, fetched?.[outcome]);
    }
  return {
    replies: {
      push: pushCount(replies?.push),
      request: pushCount(replies?.request),
      connect: pushCount(replies?.connect),
      failed: pushCount(observation.failedReplies),
    },
    rows: [...rows.values()],
    event_counts: [...changes.values()],
    downloads: [...downloads.values()],
  };
}
/** The routes of the client's accessory parameters (#286, #306). */
export const accessoryParameterRoutes = ['cloud', 'camera_info', 'hub_notify'] as const;
/** The battery keys whose raw values the client keeps for a keypad (#286). */
const keypadCodeKeys = ['1101', '1653', '1654', '1655'] as const;
/** The battery keys whose raw values the client keeps for an entry sensor (#306). */
const entrySensorCodeKeys = ['1101', '1552'] as const;
/** The client keeps 64 parameter types per route besides the battery keys. */
const ACCESSORY_PARAMETER_TYPES = 64;
/** At most this many keypads in the support report. */
export const KEYPAD_PARAMETER_ROWS = 8;
/** At most this many entry sensors in the support report. */
export const ENTRY_SENSOR_PARAMETER_ROWS = 16;
export interface AccessoryParameterRoute {
  types: number[];
  codes: Partial<Record<string, string>>;
}
export type AccessoryParameterReport = { inventory_row: number | null } & Record<
  (typeof accessoryParameterRoutes)[number],
  AccessoryParameterRoute
>;
const accessoryParameterRoute = (value: unknown, codeKeys: readonly string[]): AccessoryParameterRoute => {
  const route = record(value);
  const types = Array.isArray(route?.types) ? route.types.slice(0, 256) : [];
  const codes = record(route?.codes);
  return {
    types: [...new Set(types.filter((type) => integer(type, 0, 65535) !== null) as number[])]
      .sort((a, b) => a - b)
      .slice(0, ACCESSORY_PARAMETER_TYPES + codeKeys.length),
    codes: Object.fromEntries(
      codeKeys.flatMap((key) => {
        const code = codes && !Array.isArray(codes) ? codes[key] : undefined;
        return typeof code === 'string' && (code === 'other' || /^-?[0-9]{1,6}$/.test(code)) ? [[key, code]] : [];
      }),
    ),
  };
};
const accessoryParametersReport = (
  codeKeys: readonly string[],
  inventoryRow: unknown,
  value: unknown,
): AccessoryParameterReport | null => {
  const parameters = record(value);
  if (!parameters || Array.isArray(parameters)) return null;
  return {
    inventory_row: integer(inventoryRow, 0, 98),
    ...(Object.fromEntries(
      accessoryParameterRoutes.map((route) => [route, accessoryParameterRoute(parameters[route], codeKeys)]),
    ) as Record<(typeof accessoryParameterRoutes)[number], AccessoryParameterRoute>),
  };
};
/**
 * Project the client's `accessoryParameters` of one keypad for the support
 * report (#286). It crosses a library boundary, so only the three routes leave,
 * each with bounded parameter types and the battery codes. The row is the
 * keypad's inventory row, never its serial. Null for anything that is no object.
 */
export function keypadParametersReport(inventoryRow: unknown, value: unknown): AccessoryParameterReport | null {
  return accessoryParametersReport(keypadCodeKeys, inventoryRow, value);
}
/**
 * The same projection for one entry sensor (#306), with its battery codes
 * `1101` and `1552` only.
 */
export function entrySensorParametersReport(inventoryRow: unknown, value: unknown): AccessoryParameterReport | null {
  return accessoryParametersReport(entrySensorCodeKeys, inventoryRow, value);
}
const accessoryCategories: ReadonlySet<string> = new Set(['entry_sensor', 'keypad', 'chime']);
export interface SupportReport {
  /** Standalone push counts of the running client, null without one (#185). */
  standalone_pushes?: StandalonePushReport | null;
  /** Accessory observation counts of the running client, null without one (#275). */
  accessory_observations?: AccessoryObservationReport | null;
  /** Parameters and battery codes of each keypad, null without a client or before client 0.31.3 (#286). */
  keypad_parameters?: AccessoryParameterReport[] | null;
  /** Parameters and battery codes of each entry sensor, null without a client or before client 0.31.3 (#306). */
  entry_sensor_parameters?: AccessoryParameterReport[] | null;
  cache_age_ms?: number;
  recording?: ReturnType<import("./recording-diagnostics.js").RecordingDiagnostics["report"]>;
  software?: ReturnType<typeof diagnosticSoftware>;
  live_audio?: import("./live-audio-diagnostics.js").LiveAudioReport[];
  live_video?: import("./live-video-diagnostics.js").LiveVideoReport[];
  schema: 2;
  generated_at: string;
  last_discovery: Record<string, unknown>[];
  recent_events: Record<string, unknown>[];
}
type ConnectionStatus = 'not_checked' | 'connected' | 'disconnected' | 'error' | 'not_applicable';
export class DiscoveryDiagnostics {
  private sequence = 0;
  private previous = '';
  private refs = new Map<string, number>();
  private pendingReport = 0;
  private models = new Map<string, string>();
  private stationOutcomes = new Map<string, ConnectionStatus>();
  private stationEvents = new Map<
    number,
    {
      report: number;
      phase: string;
      status: ConnectionStatus;
      reason: string | null;
      stage: string | null;
      lookup: string | null;
    }
  >();
  private lastDiscovery: Record<string, unknown>[] = [];
  private recentEvents: Record<string, unknown>[] = [];
  private connections = new Map<string, string>();
  private lastFault = '';
  /** Experimental standalone owners of the latest inventory, for a record without an observation. */
  private standaloneOwners = new Set<string>();
  /** The latest recording_query outcome per owner reference and query. */
  private recordingEvents = new Map<string, { report: number; outcome: string }>();
  /** #283: the last unrouted_push line per distinct record, and the copies since. */
  private unrouted = new Map<string, { at: number; repeats: number }>();
  prepare(result: DiscoveryResult): void {
    this.refs = new Map(result.devices.slice(0, 99).map((device, index) => [device.id, index + 1]));
    this.pendingReport = this.sequence + 1;
    this.models = new Map(
      result.devices.slice(0, 99).map((device) => [device.id, model(device.model)]),
    );
    this.standaloneOwners = new Set(
      result.relationships.flatMap((relationship) =>
        experimentalOwner(relationship) ? [relationship.ownerId] : [],
      ),
    );
    this.stationOutcomes.clear();
    this.lastFault = '';
  }
  report(): SupportReport {
    return JSON.parse(
      JSON.stringify({
        schema: 2,
        generated_at: new Date().toISOString(),
        last_discovery: this.lastDiscovery,
        recent_events: this.recentEvents,
      }),
    );
  }
  station(
    id: string,
    phase: 'connect' | 'refresh_state' | 'observation',
    status: ConnectionStatus,
    reason?: string,
    detail?: StationConnectionDetail,
  ): void {
    const ref = this.refs.get(id);
    if (ref === undefined) return;
    const code = reason ? diagnosticCode(reason) : null;
    // Only a failed connect attempt says how far it got.
    const stage =
      detail && status === 'error' && phase === 'connect'
        ? connectionStages.has(detail.stage)
          ? detail.stage
          : 'none'
        : null;
    // The local lookup of the connect attempt behind this record, on a failed
    // connect and on the record that reports a successful one. For a HomeBase
    // that is the refresh_state record after its connect.
    const lookup = detail?.lookup === undefined ? {} : lookupFields(detail.lookup);
    // The key setup of the same attempt, on the same records as its lookup (#142).
    const keySetup = detail === undefined ? {} : keySetupFields(detail);
    // The key setup counts in the coarse outcome too, so a changed key outcome
    // adds a record (#142).
    const outcome = lookupClass({ ...lookup, ...keySetup });
    const previous = this.stationEvents.get(ref);
    this.stationOutcomes.set(id, status);
    // Only a repeat of the previous record is left out, so the latest record of
    // a station is always its latest attempt. A record with lookup fields
    // repeats it only with the same coarse lookup outcome.
    if (
      previous?.report === this.pendingReport &&
      previous.status === status &&
      previous.reason === code &&
      previous.stage === stage &&
      (status !== 'error' || previous.phase === phase) &&
      (outcome === null || previous.lookup === outcome)
    )
      return;
    this.stationEvents.set(ref, {
      report: this.pendingReport,
      phase,
      status,
      reason: code,
      stage,
      lookup: outcome,
    });
    this.emit({
      event: 'station_connection',
      report: this.pendingReport,
      device_ref: ref,
      model: this.models.get(id) ?? 'unavailable',
      phase,
      status,
      reason: code,
      ...(stage === null
        ? {}
        : {
            stage,
            ...(typeof detail?.inventoryAddress === 'boolean'
              ? { inventory_address: detail.inventoryAddress }
              : {}),
          }),
      ...lookup,
      ...keySetup,
    });
  }
  /**
   * One recording operation of the bridge on its owner (#152). The caller
   * decides which operations are recorded. An owner outside the latest
   * inventory is not. A repeat of the previous record of the same owner and
   * query in this report is left out, like a station_connection record:
   * a changed elapsed time or changed counts alone are a repeat.
   */
  recording(id: string, value: RecordingQueryReport): void {
    const ref = this.refs.get(id);
    if (ref === undefined) return;
    let fields: Record<string, unknown>;
    try {
      fields = recordingFields(value, this.standaloneOwners.has(id));
    } catch {
      // Diagnostics never alter a recording request. An unreadable report is left out.
      return;
    }
    const key = `${ref} ${String(fields.query)}`;
    const outcome = recordingClass(fields);
    const previous = this.recordingEvents.get(key);
    if (previous?.report === this.pendingReport && previous.outcome === outcome) return;
    this.recordingEvents.set(key, { report: this.pendingReport, outcome });
    this.emit({
      event: 'recording_query',
      report: this.pendingReport,
      device_ref: ref,
      model: this.models.get(id) ?? 'unavailable',
      ...fields,
    });
  }

  /**
   * #283: a push that produced no detection event, from client 0.31.3, revalidated
   * here. One line per distinct record per 10 minutes, for at most 32 records,
   * with the identical pushes left out since the previous line as `repeats`, until
   * the record is dropped to make room for another. Never in recent_events, so it
   * cannot push recording or fault records out.
   */
  unroutedPush(push: unknown, now = Date.now()): void {
    const value = (typeof push === 'object' && push !== null ? push : {}) as Record<string, unknown>;
    const fields = {
      reason: unroutedReasons.has(value.reason) ? value.reason : 'unavailable',
      source: value.source === 'cloud' || value.source === 'local' ? value.source : 'unavailable',
      model: value.model === null ? null : model(value.model),
      station: unroutedStations.has(value.station) ? value.station : 'unavailable',
      push_type: integer(value.pushType, -1, 99999),
      event_code: integer(value.eventCode, -1, 99999),
      msg_type: integer(value.msgType, -1, 99999),
    };
    const key = JSON.stringify(fields);
    const entry = this.unrouted.get(key);
    if (entry && now - entry.at < UNROUTED_WINDOW_MS) {
      entry.repeats++;
      return;
    }
    if (!entry && this.unrouted.size >= UNROUTED_RECORDS) {
      for (const [record, old] of this.unrouted)
        if (now - old.at >= UNROUTED_WINDOW_MS) this.unrouted.delete(record);
      if (this.unrouted.size >= UNROUTED_RECORDS) return;
    }
    this.unrouted.set(key, { at: now, repeats: 0 });
    this.emit({ event: 'unrouted_push', ...fields, repeats: entry?.repeats ?? 0 });
  }

  fault(code: unknown): void {
    const safe = diagnosticCode(code);
    if (safe === this.lastFault) return;
    this.lastFault = safe;
    this.emit({
      event: 'fault',
      code: safe,
      report: this.pendingReport || null,
    });
  }
  constructor(private readonly output: (line: string) => void) {}
  private record(value: Record<string, unknown>): Record<string, unknown> {
    return {
      diagnostic: 'discovery',
      schema: 2,
      timestamp: new Date().toISOString(),
      ...value,
    };
  }
  private emit(value: Record<string, unknown>): void {
    const record = this.record(value);
    if (!['summary', 'device', 'issue', 'accessory', 'end', 'unrouted_push'].includes(String(value.event))) {
      this.recentEvents.push(record);
      if (this.recentEvents.length > 100) this.recentEvents.shift();
    }
    try {
      this.output(JSON.stringify(record));
    } catch {
      /* Logging must never alter authentication, discovery or ownership. */
    }
  }
  cloud(event: Diagnostic): void {
    const operation = cloudRoutes.get(event.path);
    if (!operation) return;
    this.emit({
      event: 'cloud',
      operation,
      http_status: integer(event.status, 100, 599),
      result_code: integer(event.code, -999999, 999999),
      elapsed_ms: integer(event.elapsedMs, 0, 120000),
    });
  }
  connection(phase: 'authentication' | 'events', outcome: string, pushConnected: boolean): void {
    const safeOutcome = [
      'connected',
      'disconnected',
      'connecting',
      'captcha',
      'verify',
      'error',
    ].includes(outcome)
      ? outcome
      : diagnosticCode(outcome);
    const signature = JSON.stringify([safeOutcome, pushConnected === true]);
    if (this.connections.get(phase) === signature) return;
    this.connections.set(phase, signature);
    this.lastFault = '';
    this.emit({
      event: 'connection',
      software: diagnosticSoftware(),
      phase,
      outcome: safeOutcome,
      push_connected: pushConnected === true,
    });
  }
  inventory(
    result: DiscoveryResult | undefined,
    outcome: string,
    expected: MigrationInventory | undefined,
    baselineChecked: boolean,
    capabilities: ReadonlyMap<string, CameraCapabilities>,
    states: ReadonlyMap<string, StationState>,
    experimentalStandalone = false,
    standaloneRecordingProbe = false,
  ): void {
    if (result && this.pendingReport !== this.sequence + 1) this.prepare(result);
    const devices = result?.devices.slice(0, 99) ?? [];
    const issues = result?.issues.slice(0, 99) ?? [];
    const refs = new Map(devices.map((device, index) => [device.id, index + 1]));
    const accepted = new Set(devices.map((device) => device.id));
    const connectionStatus = (id: string): ConnectionStatus =>
      this.stationOutcomes.get(id) ??
      (!states.has(id)
        ? 'not_checked'
        : states.get(id)!.connected === true
          ? 'connected'
          : 'disconnected');
    const connectionBoolean = (status: ConnectionStatus): boolean | null =>
      status === 'connected' ? true : status === 'disconnected' ? false : null;
    const rows = devices.map((device, index) => {
      const relationship = result?.relationships.find((row) => row.deviceId === device.id);
      const owner =
        relationship && 'ownerId' in relationship ? refs.get(relationship.ownerId) : undefined;
      // An opted-in standalone camera owns its own session, so its status is checked.
      const experimental = experimentalOwner(relationship);
      const descriptor =
        relationship?.kind === 'standalone' && relationship.descriptor
          ? relationship.descriptor
          : undefined;
      const media = capabilities.get(device.id);
      const capability = (name: keyof CameraCapabilities) => {
        const value = media?.[name];
        return !value
          ? null
          : {
              available: value.available === true,
              status: ['experimental', 'unsupported'].includes(value.status)
                ? value.status
                : 'unavailable',
              reason: value.reason === null ? null : diagnosticCode(value.reason),
            };
      };
      return {
        event: 'device',
        ref: index + 1,
        kind: ['camera', 'station'].includes(device.kind) ? device.kind : 'unavailable',
        model: model(device.model),
        firmware: diagnosticVersion(device.firmware),
        hardware: diagnosticVersion(device.hardware),
        availability: ['online', 'offline', 'disabled'].includes(device.availability ?? '')
          ? device.availability
          : null,
        relationship:
          relationship && ['station', 'standalone', 'unsupported'].includes(relationship.kind)
            ? relationship.kind
            : 'unavailable',
        relationship_reason:
          relationship && 'reason' in relationship ? diagnosticCode(relationship.reason) : null,
        relationship_transport: experimental ? 'experimental' : null,
        // Presence of the standalone row's connection fields, never their values.
        descriptor: descriptor
          ? {
              did: flag(descriptor.did),
              license: flag(descriptor.license),
              admin_user: flag(descriptor.adminUser),
              lan_address: flag(descriptor.lanAddress),
            }
          : null,
        owner_ref: owner ?? null,
        owner_connected:
          relationship?.kind === 'station' || experimental
            ? connectionBoolean(connectionStatus(relationship.ownerId))
            : null,
        owner_status: experimental
          ? connectionStatus(relationship.ownerId)
          : relationship?.kind === 'standalone'
            ? 'not_applicable'
            : relationship?.kind === 'station'
              ? connectionStatus(relationship.ownerId)
              : 'not_checked',
        station_status: device.kind !== 'station' ? 'not_applicable' : connectionStatus(device.id),
        station_connected:
          device.kind === 'station' ? connectionBoolean(connectionStatus(device.id)) : null,
        media:
          device.kind === 'camera'
            ? {
                snapshot: capability('snapshot'),
                live: capability('live'),
                recordings: capability('recordings'),
              }
            : null,
      };
    });
    const rejections = issues.map((issue) => ({
      event: 'issue',
      inventory_row: integer(issue.index, 0, 98),
      code: diagnosticCode(issue.code),
      device_ref: issue.deviceId === null ? null : (refs.get(issue.deviceId) ?? null),
      model: model(issue.deviceModel),
      device_type: integer(issue.deviceType, 0, 65535),
      firmware: diagnosticVersion(issue.context?.firmware),
      hardware: diagnosticVersion(issue.context?.hardware),
      parent_status: ['none', 'self', 'present', 'missing', 'ambiguous', 'invalid'].includes(
        issue.context?.parentStatus ?? '',
      )
        ? issue.context!.parentStatus
        : 'unavailable',
      owner_ref:
        issue.context?.parentStatus === 'present' && issue.context.parentId
          ? (refs.get(issue.context.parentId) ?? null)
          : null,
      parent_model: model(issue.context?.parentModel),
      parent_firmware: diagnosticVersion(issue.context?.parentFirmware),
    }));
    // Admitted HomeBase accessories and recognized chimes (#275). Their refs
    // follow the device refs. Category, model, versions and the owner
    // reference only, never a serial, name or reading.
    const accessories = (result?.accessories ?? []).slice(0, 99);
    const accessoryRows = accessories.map((accessory, index) => {
      const hasStation = typeof accessory.stationId === 'string';
      return {
        event: 'accessory',
        ref: devices.length + index + 1,
        inventory_row: integer(accessory.index, 0, 98),
        category: accessoryCategories.has(accessory.category) ? accessory.category : 'unavailable',
        model: model(accessory.model),
        device_type: integer(accessory.deviceType, 0, 65535),
        firmware: diagnosticVersion(accessory.firmware),
        hardware: diagnosticVersion(accessory.hardware),
        has_station: hasStation,
        ...(hasStation ? { owner_ref: refs.get(accessory.stationId!) ?? null } : {}),
      };
    });
    const summary = {
      event: 'summary',
      software: diagnosticSoftware(),
      outcome: outcome === 'accepted' ? outcome : diagnosticCode(outcome),
      inventory_available: result !== undefined,
      scope: 'public_discovery_result',
      cameras: devices.filter((device) => device.kind === 'camera').length,
      stations: devices.filter((device) => device.kind === 'station').length,
      accessories: accessories.length,
      issues: issues.length,
      truncated:
        !!result &&
        (result.devices.length > 99 ||
          result.issues.length > 99 ||
          (result.accessories?.length ?? 0) > 99),
      baseline: !baselineChecked ? 'unavailable' : expected ? 'present' : 'absent',
      expected_cameras: expected ? integer(expected.cameras.length, 0, 100) : null,
      expected_stations: expected ? integer(expected.stations.length, 0, 100) : null,
      missing_expected_cameras: expected
        ? integer(expected.cameras.filter((id) => !accepted.has(id)).length, 0, 100)
        : null,
      missing_expected_stations: expected
        ? integer(expected.stations.filter((id) => !accepted.has(id)).length, 0, 100)
        : null,
      // The opt-in the library received, so a standalone row with
      // standalone_transport_unverified can be read as not admitted (#154).
      experimental_standalone: experimentalStandalone === true,
      // The opt-in standalone recording probe of the login discovery (#178).
      standalone_recording_probe: standaloneRecordingProbe === true,
    };
    const snapshot = JSON.stringify([summary, rows, rejections, accessoryRows]);
    const unchanged = snapshot === this.previous;
    this.previous = snapshot;
    const report = ++this.sequence;
    this.pendingReport = report;
    this.lastDiscovery = [
      this.record({ ...summary, report, unchanged: false }),
      ...[...rows, ...rejections, ...accessoryRows].map((row) => this.record({ ...row, report })),
      this.record({
        event: 'end',
        report,
        rows: rows.length + rejections.length + accessoryRows.length,
      }),
    ];
    this.emit({ ...summary, report, unchanged });
    if (!unchanged)
      for (const row of [...rows, ...rejections, ...accessoryRows]) this.emit({ ...row, report });
    this.emit({
      event: 'end',
      report,
      rows: unchanged ? 0 : rows.length + rejections.length + accessoryRows.length,
    });
  }
}
