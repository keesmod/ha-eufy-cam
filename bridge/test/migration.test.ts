import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage } from '../src/storage.js';
import { Eufy } from '../src/eufy.js';
import type { Backend, Credentials } from '../src/backend.js';
import { backendName } from '../src/backend.js';
import { migrationInventory, verifyInventory, parseMigrationInventory } from '../src/migration.js';

const baseline = { version: 1 as const, bridge_id: 'bridge-test', backend: 'legacy' as 'legacy' | 'mega', cameras: ['CAM'], stations: ['BASE'] };
const account = { username: 'fresh@example.invalid', password: 'synthetic', country: 'NL' };

test('selectors cannot activate a legacy backend', () => {
  assert.equal(backendName(undefined), 'mega');
  assert.equal(backendName('mega'), 'mega');
  for (const value of ['legacy', '', 'other']) assert.throws(() => backendName(value), /Only Mega/);
});

test('migration baseline validates identity and every expected device without an empty success', () => {
  for (const value of [null, {}, {...baseline, cameras: []}, {...baseline, cameras: ['CAM', 'CAM']}, {...baseline, cameras: ['../data']}, {...baseline, version: 2}])
    assert.throws(() => parseMigrationInventory(value, 'bridge-test'));
  assert.throws(() => parseMigrationInventory(baseline, 'other'), /bridge_identity_mismatch/);
  const devices = [{id: 'CAM', kind: 'camera'}, {id: 'BASE', kind: 'station'}];
  verifyInventory(baseline, devices);
  verifyInventory(baseline, [...devices, {id:'EXTRA', kind:'camera'}]);
  for (const inventory of [[], devices.slice(0,1), devices.slice(1), [{id:'OTHER', kind:'camera'}, devices[1]!]])
    assert.throws(() => verifyInventory(baseline, inventory));
  assert.throws(() => verifyInventory(undefined, []), /camera_inventory_empty/);
});

for (const source of ['legacy', 'mega'] as const) test(`${source} upgrade preserves old data and enforces credential ownership`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'camera-migration-'));
  const storage = new Storage(directory);
  const calls: Credentials[] = [];
  const old = JSON.stringify({...account, username:'old@example.invalid'});
  await storage.write('bridge-id', baseline.bridge_id);
  await storage.write('credentials.json', old);
  await storage.write('session.json', 'untouched legacy session bytes');
  if (source === 'mega') await storage.write('mega-session.json', '{}');
  const bridge = new Eufy(storage, 'mega', false, () => Object.assign(new EventEmitter(), {
    pictures: new Map(), recordings: {busy:false, close(){}},
    login: async (credentials: Credentials) => { calls.push(credentials); return {state:'connected'}; },
    close: async () => {}, inventory: () => [],
  }) as unknown as Backend);
  try {
    await assert.rejects(bridge.restore(), /inventory_required/);
    assert.equal(calls.length, 0);
    await assert.rejects(bridge.login(account), /inventory_required/);
    await bridge.acceptMigration({...baseline, backend: source, password:'must be discarded'});
    await bridge.restore();
    if (source === 'legacy') {
      assert.equal(calls.length, 0);
      assert.equal(bridge.auth.state, 'unconfigured');
      await bridge.login(account);
      assert.deepEqual(calls, [account]);
    } else assert.equal(calls[0]?.username, 'old@example.invalid');
    assert.equal(await storage.read('credentials.json'), old);
    assert.equal(await storage.read('session.json'), 'untouched legacy session bytes');
    assert.equal(await storage.read('bridge-id'), baseline.bridge_id);
    assert.equal(JSON.parse((await storage.read('migration-inventory.json'))!).password, undefined);
    assert.ok(await storage.exists('mega-credentials.json'));
    await bridge.acceptMigration({...baseline, backend:source});
    await assert.rejects(bridge.acceptMigration({...baseline, backend:source, cameras:['OTHER']}), /inventory_already_saved/);
  } finally { await bridge.close(); await rm(directory, {recursive:true, force:true}); }
});

test('corrupt baseline and legacy session without credentials cannot bypass migration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'camera-migration-'));
  const storage = new Storage(directory);
  try {
    assert.equal(await migrationInventory(storage), undefined);
    await storage.write('session.json', 'private legacy data');
    await assert.rejects(migrationInventory(storage), /inventory_required/);
    await storage.write('migration-inventory.json', '{');
    await assert.rejects(migrationInventory(storage), /inventory_invalid/);
    assert.equal(await readFile(join(directory,'session.json'), 'utf8'), 'private legacy data');
  } finally { await rm(directory, {recursive:true, force:true}); }
});
