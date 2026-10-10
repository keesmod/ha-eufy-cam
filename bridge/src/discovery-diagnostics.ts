/** Bounded support reports from public library results. Never serialize raw input. */
import { readFileSync } from 'node:fs';
import type {
  CameraCapabilities,
  DeviceRelationship,
  Diagnostic,
  DiscoveryResult,
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
// A received model code, optionally with a short suffix such as T8113-Z (#129).
// Serials and free text never match.
export const diagnosticModel = (value: unknown): string =>
  typeof value === 'string' && value.length <= 8 && /^T[A-Z0-9]{4}(?:-[A-Z0-9]{1,2})?$/.test(value)
    ? value
    : 'unavailable';
const model = diagnosticModel;
export const connectionStages: ReadonlySet<string> = new Set(['none', 'lookup', 'station_found', 'session_open', 'encryption_ready']);
/** How far a failed station connection got, from the library's connection stages. */
export interface StationConnectionDetail {
  stage: string;
  inventoryAddress?: boolean;
}
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
export const diagnosticVersion = (value: unknown): string =>
  typeof value === 'string' &&
  value.length <= 19 &&
  !/[^0-9.]/.test(value) &&
  /^[0-9]{1,4}(?:\.[0-9]{1,4}){0,3}$/.test(value)
    ? value
    : 'unavailable';
function packageVersion(path: string): string {
  try {
    return diagnosticVersion(
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
export interface SupportReport {
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
    }
  >();
  private lastDiscovery: Record<string, unknown>[] = [];
  private recentEvents: Record<string, unknown>[] = [];
  private connections = new Map<string, string>();
  private lastFault = '';
  prepare(result: DiscoveryResult): void {
    this.refs = new Map(result.devices.slice(0, 99).map((device, index) => [device.id, index + 1]));
    this.pendingReport = this.sequence + 1;
    this.models = new Map(
      result.devices.slice(0, 99).map((device) => [device.id, model(device.model)]),
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
    const previous = this.stationEvents.get(ref);
    this.stationOutcomes.set(id, status);
    // Only a repeat of the previous record is left out, so the latest record of
    // a station is always its latest attempt.
    if (
      previous?.report === this.pendingReport &&
      previous.status === status &&
      previous.reason === code &&
      previous.stage === stage &&
      (status !== 'error' || previous.phase === phase)
    )
      return;
    this.stationEvents.set(ref, {
      report: this.pendingReport,
      phase,
      status,
      reason: code,
      stage,
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
    });
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
    if (!['summary', 'device', 'issue', 'end'].includes(String(value.event))) {
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
    const summary = {
      event: 'summary',
      software: diagnosticSoftware(),
      outcome: outcome === 'accepted' ? outcome : diagnosticCode(outcome),
      inventory_available: result !== undefined,
      scope: 'public_discovery_result',
      cameras: devices.filter((device) => device.kind === 'camera').length,
      stations: devices.filter((device) => device.kind === 'station').length,
      issues: issues.length,
      truncated: !!result && (result.devices.length > 99 || result.issues.length > 99),
      baseline: !baselineChecked ? 'unavailable' : expected ? 'present' : 'absent',
      expected_cameras: expected ? integer(expected.cameras.length, 0, 100) : null,
      expected_stations: expected ? integer(expected.stations.length, 0, 100) : null,
      missing_expected_cameras: expected
        ? integer(expected.cameras.filter((id) => !accepted.has(id)).length, 0, 100)
        : null,
      missing_expected_stations: expected
        ? integer(expected.stations.filter((id) => !accepted.has(id)).length, 0, 100)
        : null,
    };
    const snapshot = JSON.stringify([summary, rows, rejections]);
    const unchanged = snapshot === this.previous;
    this.previous = snapshot;
    const report = ++this.sequence;
    this.pendingReport = report;
    this.lastDiscovery = [
      this.record({ ...summary, report, unchanged: false }),
      ...[...rows, ...rejections].map((row) => this.record({ ...row, report })),
      this.record({
        event: 'end',
        report,
        rows: rows.length + rejections.length,
      }),
    ];
    this.emit({ ...summary, report, unchanged });
    if (!unchanged) for (const row of [...rows, ...rejections]) this.emit({ ...row, report });
    this.emit({
      event: 'end',
      report,
      rows: unchanged ? 0 : rows.length + rejections.length,
    });
  }
}
