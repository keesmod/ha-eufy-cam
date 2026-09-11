/** Bounded support reports from public library results. Never serialize raw input. */
import { readFileSync } from 'node:fs';
import type {
  CameraCapabilities,
  Diagnostic,
  DiscoveryResult,
  StationState,
} from '@keesmod/eufy-mega-client';
import type { MigrationInventory } from './migration.js';

const codes = new Set([
  'invalid_device_identity',
  'invalid_device_relationship',
  'unsupported_device',
  'unsupported_station',
  'standalone_transport_unverified',
  'camera_inventory_empty',
  'expected_devices_missing',
  'inventory_required',
  'inventory_invalid',
  'bridge_identity_mismatch',
  'invalid_inventory',
  'inventory_completeness_unconfirmed',
  'authentication_rejected',
  'authentication_required',
  'invalid_authentication',
  'domain_discovery_failed',
  'domain_unresolved',
  'request_failed',
  'request_rejected',
  'http_error',
  'invalid_response',
  'response_decryption_failed',
  'response_too_large',
  'key_exchange_failed',
  'invalid_key_exchange',
  'client_closed',
  'camera_media_unverified',
  'device_initialization_failed',
  'device_connection_failed',
  'unknown_device',
  'unknown_camera',
  'unknown_station',
  'invalid_connection_credentials',
  'station_busy',
  'connection_failed',
]);
export const diagnosticCode = (value: unknown): string =>
  typeof value === 'string' && codes.has(value) ? value : 'unclassified_error';
const model = (value: unknown): string =>
  typeof value === 'string' && value.length === 5 && /^T[A-Z0-9]{4}$/.test(value)
    ? value
    : 'unavailable';
const integer = (value: unknown, min: number, max: number): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null;
const version = (value: unknown): string =>
  typeof value === 'string' &&
  value.length <= 19 &&
  !/[^0-9.]/.test(value) &&
  /^[0-9]{1,4}(?:\.[0-9]{1,4}){0,3}$/.test(value)
    ? value
    : 'unavailable';
function packageVersion(path: string): string {
  try {
    return version(JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')).version);
  } catch {
    return 'unavailable';
  }
}
export const diagnosticSoftware = () => ({
  bridge: packageVersion('../package.json'),
  library: packageVersion('../node_modules/@keesmod/eufy-mega-client/package.json'),
  node: version(process.versions.node),
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
export class DiscoveryDiagnostics {
  private sequence = 0;
  private previous = '';
  constructor(private readonly output: (line: string) => void) {}
  private emit(value: object): void {
    try {
      this.output(JSON.stringify({ diagnostic: 'discovery', schema: 1, ...value }));
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
    this.emit({
      event: 'connection',
      software: diagnosticSoftware(),
      phase,
      outcome: ['connected', 'captcha', 'verify', 'error'].includes(outcome)
        ? outcome
        : diagnosticCode(outcome),
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
    const devices = result?.devices.slice(0, 99) ?? [];
    const issues = result?.issues.slice(0, 99) ?? [];
    const refs = new Map(devices.map((device, index) => [device.id, index + 1]));
    const accepted = new Set(devices.map((device) => device.id));
    const rows = devices.map((device, index) => {
      const relationship = result?.relationships.find((row) => row.deviceId === device.id);
      const owner =
        relationship && 'ownerId' in relationship ? refs.get(relationship.ownerId) : undefined;
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
        firmware: version(device.firmware),
        hardware: version(device.hardware),
        availability: ['online', 'offline', 'disabled'].includes(device.availability ?? '')
          ? device.availability
          : null,
        relationship:
          relationship && ['station', 'standalone', 'unsupported'].includes(relationship.kind)
            ? relationship.kind
            : 'unavailable',
        relationship_reason:
          relationship && 'reason' in relationship ? diagnosticCode(relationship.reason) : null,
        owner_ref: owner ?? null,
        station_connected:
          device.kind === 'station' && states.has(device.id)
            ? states.get(device.id)?.connected === true
            : null,
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
    this.emit({ ...summary, report, unchanged });
    if (!unchanged) for (const row of [...rows, ...rejections]) this.emit({ ...row, report });
    this.emit({ event: 'end', report, rows: unchanged ? 0 : rows.length + rejections.length });
  }
}
