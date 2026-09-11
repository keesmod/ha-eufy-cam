import { Storage } from './storage.js';

export class MigrationError extends Error {
  constructor(readonly code: string) {
    super(`Camera migration requires attention (${code}). See docs/MEGA_MIGRATION.md before upgrading.`);
  }
}
export interface MigrationInventory {
  version: 1;
  bridge_id: string;
  backend: 'legacy' | 'mega';
  cameras: string[];
  stations: string[];
}
export function parseMigrationInventory(value: unknown, bridgeId: string | undefined): MigrationInventory {
  const data = value as MigrationInventory;
  if (!data || data.version !== 1 || !['legacy', 'mega'].includes(data.backend) ||
      typeof data.bridge_id !== 'string' || data.bridge_id.length > 128 || !identifiers(data.cameras) || !data.cameras.length ||
      !identifiers(data.stations)) throw new MigrationError('inventory_invalid');
  if (data.bridge_id !== bridgeId) throw new MigrationError('bridge_identity_mismatch');
  return { version: 1, bridge_id: data.bridge_id, backend: data.backend,
    cameras: [...data.cameras].sort(), stations: [...data.stations].sort() };
}
const identifiers = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= 100 &&
  value.every((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id)) &&
  new Set(value).size === value.length;

export async function migrationInventory(storage: Storage): Promise<MigrationInventory | undefined> {
  const raw = await storage.read('migration-inventory.json');
  if (!raw) {
    if (await storage.exists('credentials.json') || await storage.exists('session.json'))
      throw new MigrationError('inventory_required');
    return undefined;
  }
  let data: MigrationInventory;
  try { data = JSON.parse(raw); } catch { throw new MigrationError('inventory_invalid'); }
  return parseMigrationInventory(data, await storage.read('bridge-id'));
}

export function verifyInventory(
  expected: MigrationInventory | undefined,
  devices: ReadonlyArray<{ id: string; kind: string }>,
): void {
  const cameras = new Set(devices.filter((d) => d.kind === 'camera').map((d) => d.id));
  const stations = new Set(devices.filter((d) => d.kind === 'station').map((d) => d.id));
  if (!cameras.size) throw new MigrationError('camera_inventory_empty');
  if (expected && (expected.cameras.some((id) => !cameras.has(id)) ||
      expected.stations.some((id) => !stations.has(id)))) throw new MigrationError('expected_devices_missing');
}
