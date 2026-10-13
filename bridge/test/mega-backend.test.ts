import { tmpdir } from 'node:os';
import { test } from 'node:test';
process.env.EUFY_DATA_DIR = tmpdir();
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import {
  EufyError,
  EufyMegaClient,
  type ClientOptions,
  type Device,
  type CameraCapabilities,
  type DiscoveryResult,
} from '@keesmod/eufy-mega-client';
import { MegaBackend, liveStreamsPerStation, liveMaxSecondsMains, experimentalStandalone } from '../src/mega-backend.js';
import { Storage } from '../src/storage.js';
import { backendName } from '../src/backend.js';
import { MegaRecordings } from '../src/mega-recordings.js';
const devices: Device[] = [
  {
    id: 'BASE',
    stationId: 'BASE',
    kind: 'station',
    model: 'T8030',
    name: 'HomeBase',
    hardware: '1',
    firmware: '3.8.6.0',
    battery: null,
  },
  {
    id: 'CAM',
    stationId: 'BASE',
    kind: 'camera',
    model: 'T8160',
    name: 'Camera',
    hardware: '1',
    firmware: '3.4.3.0',
    battery: 90,
  },
];
test('recording cancellation before the media handle arrives is counted and releases ownership', async () => {
  const abort = new AbortController();
  let started!: () => void;
  const opening = new Promise<void>((resolve) => {
    started = resolve;
  });
  const client = {
    connected: true,
    listRecordings: async () => ({
      complete: true,
      returned: 1,
      recordings: [
        {
          id: 'fixture',
          deviceId: 'CAM',
          stationId: 'BASE',
          start: '2026-09-08T10:00:00Z',
          end: '2026-09-08T10:00:10Z',
          bytes: 100,
          thumbnail: true,
        },
      ],
    }),
    downloadRecording: async (_id: string, signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new EufyError('download_cancelled')), {
          once: true,
        });
        started();
      }),
  };
  const recordings = new MegaRecordings(
    () => client as unknown as EufyMegaClient,
    () => devices,
    () => false,
  );
  const rows = await recordings.list('CAM', '2026-09-08', abort.signal);
  const transfer = recordings.video('CAM', rows.recordings[0]!.id, abort.signal, async () => {});
  const rejected = assert.rejects(transfer, { code: 'recording_unavailable' });
  await opening;
  assert.equal(recordings.busy, true);
  abort.abort();
  await rejected;
  assert.equal(recordings.busy, false);
  assert.equal(recordings.metrics.cancelled, 1);
});
function fixture(limit?: number, mainsSeconds?: number, standalone?: boolean) {
  const calls: string[] = [];
  const state = {
    id: 'BASE',
    connected: true,
    guardMode: 1,
    currentMode: 1,
    alarm: false,
    alarmDelay: 0,
    armDelay: 0,
    commandEncryption: 'lan-derived' as const,
  };
  const client = Object.assign(new EventEmitter(), {
    connected: true,
    eventStatus: {
      connected: true,
      received: 1,
      duplicates: 2,
      lastReceivedAt: null,
    },
    connect: async () => ({ state: 'connected' as const }),
    listDevices: async (): Promise<Device[]> => (await client.discoverDevices()).devices,
    discoverDevices: async (): Promise<DiscoveryResult> => ({
      devices,
      relationships: [],
      issues: [],
    }),
    getCameraCapabilities: async (_id: string): Promise<CameraCapabilities> => ({
      snapshot: {
        available: true,
        status: 'experimental' as const,
        reason: null as string | null,
      },
      live: {
        available: true,
        status: 'experimental' as const,
        reason: null as string | null,
      },
      recordings: {
        available: true,
        status: 'experimental' as const,
        reason: null as string | null,
      },
    }),
    connectStation: async () => state,
    refreshStationState: async () => state,
    startEvents: async () => {},
    setGuardMode: async (_id: string, mode: number) => ({
      confirmed: true,
      commandSent: true,
      state: { ...state, guardMode: mode, currentMode: mode },
    }),
    startLive: async (id: string, options?: { maxDurationMs?: number; onProgress?: (progress: { stage: string; elapsedMs: number }) => void }) => {
      calls.push('start');
      bounds.push(options?.maxDurationMs ?? null);
      options?.onProgress?.({ stage: 'metadata', elapsedMs: 12 });
      let finish!: (value: { confirmed: boolean; reason: 'device' }) => void;
      const ended = new Promise<{ confirmed: boolean; reason: 'device' }>((resolve) => {
        finish = resolve;
      });
      return {
        id: `stream-${id}`,
        deviceId: id,
        video: Readable.from([]),
        audio: Readable.from([]),
        metadata: {
          videoCodec: 'h264',
          audioCodec: 'aac',
          fps: 15,
          width: 1920,
          height: 1080,
        },
        ended,
        stop: async () => {
          calls.push('stop');
          finish({ confirmed: true, reason: 'device' });
          return ended;
        },
      };
    },
    shutdown: async () => {
      calls.push('shutdown');
    },
    ensureLiveStopped: async () => ({ confirmed: true, reason: 'device' }),
  });
  const storage = new Storage('/unused');
  const reads: string[] = [];
  storage.read = async (name) => {
    reads.push(name);
    return undefined;
  };
  storage.write = async () => {};
  const bounds: (number | null)[] = [];
  const options: ClientOptions[] = [];
  const backend = new MegaBackend(
    storage,
    () => false,
    (clientOptions) => {
      options.push(clientOptions);
      void clientOptions.sessionStore.load();
      return client as unknown as EufyMegaClient;
    },
    undefined,
    limit,
    mainsSeconds,
    standalone,
  );
  return { backend, client, calls, reads, storage, options, bounds };
}
test('EUFY_LIVE_MAX_SECONDS_MAINS accepts 120 to 3600 seconds and defaults to 120', () => {
  assert.equal(liveMaxSecondsMains(undefined), 120);
  assert.equal(liveMaxSecondsMains(''), 120);
  assert.equal(liveMaxSecondsMains(' 1800 '), 1800);
  assert.equal(liveMaxSecondsMains('3600'), 3600);
  for (const bad of ['119', '3601', '0120', '600.5', '1e3', 'long', '-600', '60'])
    assert.throws(() => liveMaxSecondsMains(bad), /EUFY_LIVE_MAX_SECONDS_MAINS/, bad);
  assert.throws(() => new MegaBackend(new Storage('/unused'), () => false, undefined, undefined, 1, 119), /120 to 3600/);
  assert.throws(() => new MegaBackend(new Storage('/unused'), () => false, undefined, undefined, 1, 3601), /120 to 3600/);
});
test('the mains bound reaches the client as the ceiling and applies only to cameras without a battery value', async () => {
  const mains: Device = { ...devices[1]!, id: 'MAINS', name: 'Mains', model: 'T8416', battery: null };
  for (const seconds of [undefined, 1800]) {
    const f = fixture(2, seconds);
    f.client.discoverDevices = async () => ({ devices: [...devices, mains], relationships: [], issues: [] });
    try {
      await f.backend.login({ username: 'fixture', password: 'fixture', country: 'NL' });
      assert.equal(f.options[0]?.liveUpperBoundMs, (seconds ?? 120) * 1000);
      assert.equal(f.backend.liveMaxSecondsMains, seconds ?? 120);
      assert.equal(f.backend.liveBoundMs('CAM'), 120000, 'a battery camera keeps 120 seconds');
      assert.equal(f.backend.liveBoundMs('MAINS'), (seconds ?? 120) * 1000);
      assert.equal(f.backend.liveBoundMs('BASE'), 120000);
      assert.equal(f.backend.liveBoundMs('UNKNOWN'), 120000);
      await f.backend.startLive('CAM');
      await f.backend.startLive('MAINS', f.backend.liveBoundMs('MAINS'));
      assert.deepEqual(f.bounds, [120000, (seconds ?? 120) * 1000]);
      await f.backend.stopLive('MAINS');
      await f.backend.stopLive('CAM');
      // A caller may lower the bound but never raise it above the camera's own.
      await f.backend.startLive('MAINS', 60000);
      await f.backend.startLive('CAM', 3600000);
      assert.deepEqual(f.bounds.slice(2), [60000, 120000]);
      await f.backend.stopLive('MAINS');
      await f.backend.stopLive('CAM');
    } finally {
      await f.backend.close();
    }
  }
});
test('the library\'s live start stages reach the caller unchanged', async () => {
  const f = fixture();
  try {
    await f.backend.login({ username: 'fixture', password: 'fixture', country: 'NL' });
    const seen: unknown[] = [];
    await f.backend.startLive('CAM', undefined, progress => seen.push(progress));
    assert.deepEqual(seen, [{ stage: 'metadata', elapsedMs: 12 }]);
    await f.backend.stopLive('CAM');
  } finally {
    await f.backend.close();
  }
});
test('EUFY_LIVE_MAX_STREAMS_PER_STATION accepts whole numbers from 1 to 4 and defaults to 1', () => {
  assert.equal(liveStreamsPerStation(undefined), 1);
  assert.equal(liveStreamsPerStation(''), 1);
  assert.equal(liveStreamsPerStation(' 2 '), 2);
  assert.equal(liveStreamsPerStation('4'), 4);
  for (const bad of ['0', '5', '02', '2.5', '1e0', 'two', '-1'])
    assert.throws(() => liveStreamsPerStation(bad), /EUFY_LIVE_MAX_STREAMS_PER_STATION/, bad);
  assert.throws(() => new MegaBackend(new Storage('/unused'), () => false, undefined, undefined, 5), /1 to 4/);
  assert.throws(() => new MegaBackend(new Storage('/unused'), () => false, undefined, undefined, 1.5), /1 to 4/);
});
test('the per-station live limit reaches the client, counts owned cameras and names the refusal', async () => {
  const more: Device[] = [
    { ...devices[1]!, id: 'CAM2', name: 'Second' },
    { ...devices[1]!, id: 'CAM3', name: 'Third' },
  ];
  for (const limit of [undefined, 2]) {
    const f = fixture(limit);
    f.client.discoverDevices = async () => ({ devices: [...devices, ...more], relationships: [], issues: [] });
    try {
      await f.backend.login({ username: 'fixture', password: 'fixture', country: 'NL' });
      assert.equal(f.options[0]?.maxLiveStreamsPerStation, limit ?? 1);
      assert.equal(f.backend.liveStreamsPerStation, limit ?? 1);
      assert.equal(f.backend.canStartLive('CAM'), true);
      await f.backend.startLive('CAM');
      assert.equal(f.backend.canStartLive('CAM'), false, 'the same camera never streams twice');
      assert.equal(f.backend.canStartLive('CAM2'), limit ? true : 'station_limit');
      await assert.rejects(f.backend.recoverStation('BASE'), /Station still owned/);
      if (limit) {
        await f.backend.startLive('CAM2');
        assert.equal(f.backend.canStartLive('CAM3'), 'station_limit');
        assert.equal(typeof f.backend.audioAttempt('CAM2'), 'number');
        assert.notEqual(f.backend.audioAttempt('CAM'), f.backend.audioAttempt('CAM2'));
        await f.backend.stopLive('CAM2');
        assert.equal(f.backend.canStartLive('CAM3'), true);
      }
      await f.backend.stopLive('CAM');
      assert.equal(f.backend.canStartLive('CAM2'), true);
      assert.deepEqual(f.calls, limit ? ['start', 'start', 'stop', 'stop'] : ['start', 'stop']);
      assert.equal(f.backend.supportReport().live_audio.every((row) => row.stop_confirmed === true), true);
    } finally {
      await f.backend.close();
    }
  }
});
test('Mega adapter preserves camera identity, notifications, and device-confirmed stream cleanup', async () => {
  const f = fixture();
  try {
    assert.equal(
      (
        await f.backend.login({
          username: 'fixture',
          password: 'fixture',
          country: 'NL',
        })
      ).state,
      'connected',
    );
    assert.deepEqual(f.reads, ['mega-session.json', 'migration-inventory.json']);
    assert.equal(f.backend.inventory()[0]?.serial, 'CAM');
    assert.equal(f.backend.inventory()[0]?.hardware, '1');
    const notifications: unknown[] = [];
    f.backend.on('notification', (e) => notifications.push(e));
    f.client.emit('event', {
      id: 'one',
      deviceId: 'CAM',
      type: 'person',
      receivedAt: 'time',
      occurredAt: null,
      source: 'push',
      personName: 'Fixture',
      recognition: 'known',
    });
    assert.equal((notifications[0] as { person_name: string }).person_name, 'Fixture');
    assert.equal(f.backend.notifications.metrics.duplicates, 2);
    const media: unknown[] = [];
    f.backend.on('live-start', (event) => media.push(event));
    const stopped: boolean[] = [];
    f.backend.on('live-stop', (event) => stopped.push(event.confirmed));
    await f.backend.startLive('CAM');
    assert.equal((media[0] as { videoCodec: string }).videoCodec, 'h264');
    f.backend.recordAudioEvent('CAM', 'audio_supported');
    const attempt = f.backend.audioAttempt('CAM');
    assert.equal(typeof attempt, 'number');
    assert.equal(f.backend.supportReport().live_audio[0]?.attempt, attempt);
    assert.equal(f.backend.supportReport().live_audio[0]?.initial_codec, 'aac');
    assert.equal(f.backend.supportReport().live_audio[0]?.admission, 'forwarded');
    await f.backend.stopLive('CAM');
    assert.deepEqual(stopped, [true]);
    assert.equal(f.backend.audioAttempt('CAM'), undefined);
    assert.equal(f.backend.supportReport().live_audio[0]?.state, 'ended');
    assert.equal(f.backend.supportReport().live_audio[0]?.stop_confirmed, true);
    assert.equal(f.backend.supportReport().live_audio[0]?.pipeline?.[0]?.event, 'audio_supported');
    assert.deepEqual(f.calls, ['start', 'stop']);
    await f.backend.stations.setMode('BASE', 0);
    assert.equal(f.backend.stations.inventory()[0]?.guard_mode, 0);
  } finally {
    await f.backend.close();
  }
});
test('Mega authentication failure does not load or fall back to the legacy SDK', async () => {
  const f = fixture();
  f.client.connect = async () => {
    throw new EufyError('request_timeout');
  };
  try {
    await assert.rejects(
      f.backend.login({
        username: 'fixture',
        password: 'fixture',
        country: 'NL',
      }),
      { code: 'request_timeout' },
    );
  } finally {
    await f.backend.close();
  }
  assert.equal(
    Object.keys(createRequire(import.meta.url).cache).some((path) =>
      path.includes('/node_modules/eufy-security-client/'),
    ),
    false,
  );
  assert.throws(() => backendName('unknown'));
  assert.equal(backendName('mega'), 'mega');
});

test('an idle disconnected HomeBase reconnects without starting a camera or interrupting a viewer', async () => {
  const f = fixture();
  try {
    await f.backend.login({
      username: 'fixture',
      password: 'fixture',
      country: 'NL',
    });
    let connections = 0;
    const connect = f.client.connectStation;
    f.client.connectStation = async () => {
      connections++;
      return connect();
    };
    const refresh = () => (f.backend as unknown as { refresh(): Promise<void> }).refresh();
    const state = await connect();
    await f.backend.startLive('CAM');
    f.client.emit('station', { ...state, connected: false });
    await refresh();
    assert.equal(connections, 0);
    await f.backend.stopLive('CAM');
    await refresh();
    assert.equal(connections, 1);
    assert.equal(f.backend.stations.inventory()[0]?.connected, true);
    assert.deepEqual(f.calls, ['start', 'stop']);
  } finally {
    await f.backend.close();
  }
});

for (const empty of [false, true])
  test(`discovery reports rejection codes without identities for ${empty ? 'empty' : 'mixed'} inventory`, async () => {
    const f = fixture();
    const faults: unknown[][] = [];
    f.backend.on('backend_fault', (...args) => faults.push(args));
    f.client.discoverDevices = async () => ({
      devices: empty ? [] : devices,
      relationships: [],
      issues: [
        { index: 2, deviceId: 'PRIVATE-FLOODLIGHT', code: 'unsupported_device' },
        { index: 3, deviceId: 'PRIVATE-OTHER-CAMERA', code: 'unsupported_device' },
        { index: 4, deviceId: 'PRIVATE-ORPHAN', code: 'unsupported_station' },
      ],
    });
    try {
      const login = f.backend.login({ username: 'fixture', password: 'fixture', country: 'NL' });
      if (empty) await assert.rejects(login, { code: 'camera_inventory_empty' });
      else assert.equal((await login).state, 'connected');
      assert.deepEqual(faults, [
        ['unsupported_device', 'device_model=unavailable device_type=unavailable'],
        ['unsupported_station'],
      ]);
      assert.equal(f.backend.inventory().length, empty ? 0 : 1);
      assert.equal(f.backend.stations.inventory().length, empty ? 0 : 1);
      assert.deepEqual(f.calls, []);
    } finally {
      await f.backend.close();
    }
  });

test('standalone capability reasons reach inventory and prevent every media operation', async () => {
  const f = fixture();
  f.client.listDevices = async () => [{ ...devices[1]!, stationId: 'CAM', model: 'T8134' }];
  f.client.discoverDevices = async () => ({
    devices: await f.client.listDevices(),
    relationships: [],
    issues: [],
  });
  f.client.getCameraCapabilities = async () => {
    const denied = {
      available: false,
      status: 'unsupported' as const,
      reason: 'standalone_transport_unverified',
    };
    return {
      snapshot: { ...denied },
      live: { ...denied },
      recordings: { ...denied },
    };
  };
  try {
    await f.backend.login({
      username: 'fixture',
      password: 'fixture',
      country: 'NL',
    });
    assert.deepEqual(f.backend.stations.inventory(), []);
    assert.equal(
      f.backend.inventory()[0]?.capabilities?.live.reason,
      'standalone_transport_unverified',
    );
    assert.equal(f.backend.canStartLive('CAM'), false);
    await assert.rejects(f.backend.startLive('CAM'), /standalone_transport_unverified/);
    const abort = new AbortController();
    for (const operation of [
      () => f.backend.recordings.list('CAM', '2026-09-11', abort.signal),
      () => f.backend.recordings.calendar(['CAM'], '2026-09', abort.signal),
      () => f.backend.recordings.video('CAM', 'missing', abort.signal, async () => {}),
      () => f.backend.recordings.thumbnail('CAM', 'missing', abort.signal),
    ])
      await assert.rejects(operation(), { code: 'capability_unavailable' });
    assert.deepEqual(f.calls, []);
    assert.equal(f.backend.recordings.metrics.queries, 0);
    assert.equal(f.backend.recordings.metrics.downloads, 0);
  } finally {
    await f.backend.close();
  }
});

test('a failed owner does not prevent camera setup and capability display', async () => {
  const f = fixture();
  f.client.connectStation = async () => {
    throw new EufyError('invalid_connection_credentials');
  };
  try {
    assert.equal(
      (
        await f.backend.login({
          username: 'fixture',
          password: 'fixture',
          country: 'NL',
        })
      ).state,
      'connected',
    );
    assert.equal(f.backend.inventory()[0]?.serial, 'CAM');
    assert.equal(f.backend.stations.inventory()[0]?.connected, false);
  } finally {
    await f.backend.close();
  }
});

test('concurrent capability reads cannot create two owners for one live start', async () => {
  const f = fixture();
  try {
    await f.backend.login({
      username: 'fixture',
      password: 'fixture',
      country: 'NL',
    });
    const outcomes = await Promise.allSettled([
      f.backend.startLive('CAM'),
      f.backend.startLive('CAM'),
    ]);
    assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter((result) => result.status === 'rejected').length, 1);
    assert.deepEqual(f.calls, ['start']);
    await f.backend.stopLive('CAM');
    assert.deepEqual(f.calls, ['start', 'stop']);
  } finally {
    await f.backend.close();
  }
});

test('missing migration devices close the new owner before events or connected acceptance', async () => {
  const { Eufy } = await import('../src/eufy.js');
  const f = fixture();
  const expected = { version:1, bridge_id:'bridge-test', backend:'legacy', cameras:['CAM','MISSING'], stations:['BASE'] };
  f.storage.read = async name => name === 'migration-inventory.json' ? JSON.stringify(expected) : name === 'bridge-id' ? 'bridge-test' : undefined;
  let events = 0;
  f.client.startEvents = async () => { events++; };
  const bridge = new Eufy(f.storage, 'mega', false, () => f.backend);
  try {
    await assert.rejects(bridge.login({username:'fixture',password:'fixture',country:'NL'}), /expected_devices_missing/);
    assert.equal(events, 0);
    assert.deepEqual(f.calls, ['shutdown']);
    assert.equal(bridge.auth.state, 'error');
    assert.equal(bridge.migrationError, 'expected_devices_missing');
    assert.deepEqual(bridge.inventory(), []);
    assert.equal(bridge.hub.active, 0);
  } finally { await bridge.close(); }
});

for (const empty of [false, true])
  test(`discovery keeps distinct safe pairs through the shipped client for ${empty ? 'empty' : 'mixed'} inventory`, async () => {
    const f = fixture();
    const faults: unknown[][] = [];
    f.backend.on('backend_fault', (...args) => faults.push(args));
    const rows = [
      { device_model: 'T9999', device_type: 95 },
      { device_model: 'T9999', device_type: 95 },
      { device_model: 'T9999', device_type: 96 },
      { device_model: 'T8224', device_type: 97 },
      { device_model: 'T8224PRIVATE_SERIAL', device_type: 95 },
      { device_model: 'T8224\nPRIVATE_TOKEN', device_type: 95 },
      { device_model: 'T8224\n', device_type: 95 },
      { device_model: 'T9999', device_type: 65536 },
      { device_model: 'T9999', device_type: 'PRIVATE_TOKEN' },
    ].map((row, index) => ({
      category: 'eufy_security',
      device_sn: `PRIVATE_${index}`,
      parent_sn: 'BASE',
      device_name: 'PRIVATE_NAME',
      token: 'PRIVATE_TOKEN',
      address: '192.0.2.1',
      ...row,
    }));
    if (!empty)
      rows.push(
        {
          ...rows[0]!,
          device_sn: 'BASE',
          parent_sn: '',
          device_model: 'T8030',
          device_type: 18,
        },
        {
          ...rows[0]!,
          device_sn: 'CAM',
          device_model: 'T8224',
          device_type: 95,
        },
        // The C30 pair reported on #40, admitted since client 0.18.1.
        {
          ...rows[0]!,
          device_sn: 'CAM_REPORTED',
          device_model: 'T8224',
          device_type: 96,
        },
      );
    // Exercise the installed library's public discovery API. Only the cloud
    // boundary is synthetic, with no network, authentication or device commands.
    const actual = Object.assign(Object.create(EufyMegaClient.prototype), {
      cloud: {
        call: async (...args: unknown[]) => {
          assert.equal(args[1], '/app/house/get_devs_list');
          return { devices: rows };
        },
      },
    }) as EufyMegaClient;
    f.client.discoverDevices = () => actual.discoverDevices();
    try {
      const login = f.backend.login({
        username: 'fixture',
        password: 'fixture',
        country: 'NL',
      });
      if (empty) await assert.rejects(login, { code: 'camera_inventory_empty' });
      else assert.equal((await login).state, 'connected');
      assert.deepEqual(faults, [
        ['unsupported_device', 'device_model=T9999 device_type=95'],
        ['unsupported_device', 'device_model=T9999 device_type=96'],
        ['unsupported_device', 'device_model=T8224 device_type=97'],
        ['unsupported_device', 'device_model=unavailable device_type=95'],
        ['unsupported_device', 'device_model=T9999 device_type=unavailable'],
        ['invalid_device_relationship'],
      ]);
      assert.equal(f.backend.inventory().length, empty ? 0 : 2);
      assert.equal(f.backend.stations.inventory().length, empty ? 0 : 1);
      assert.deepEqual(f.calls, []);
      assert.doesNotMatch(JSON.stringify(faults), /PRIVATE|192\.0\.2\.1/);
    } finally {
      await f.backend.close();
    }
  });

test('discovery revalidates diagnostics and ignores extra issue fields at the bridge boundary', async () => {
  const f = fixture();
  const faults: unknown[][] = [];
  f.backend.on('backend_fault', (...args) => faults.push(args));
  const malformed = [
    ['T8224\n', 95],
    ['T8224\r', 95],
    ['T8224\u001b[31m', 95],
    ['T8224PRIVATE_SERIAL', 95],
    [null, 95],
    [{ secret: 'PRIVATE_TOKEN' }, 95],
    ['T9999', '95'],
    ['T9999', -1],
    ['T9999', 65536],
    ['T9999', Infinity],
    ['T9999', 1.5],
    ['T9999', { secret: 'PRIVATE_TOKEN' }],
    ['T9999', 0],
    ['T9999', 65535],
  ];
  f.client.discoverDevices = async () => ({
    devices,
    relationships: [],
    issues: malformed.map(([deviceModel, deviceType], index) => ({
      index,
      deviceId: 'PRIVATE_SERIAL',
      code: 'unsupported_device',
      deviceModel,
      deviceType,
      token: 'PRIVATE_TOKEN',
      address: '192.0.2.1',
    })) as unknown as DiscoveryResult['issues'],
  });
  try {
    await f.backend.login({
      username: 'fixture',
      password: 'fixture',
      country: 'NL',
    });
    assert.deepEqual(faults, [
      ['unsupported_device', 'device_model=unavailable device_type=95'],
      ['unsupported_device', 'device_model=T9999 device_type=unavailable'],
      ['unsupported_device', 'device_model=T9999 device_type=0'],
      ['unsupported_device', 'device_model=T9999 device_type=65535'],
    ]);
  } finally {
    await f.backend.close();
  }
});

test('the backend log line shows unhyphenated catalogue codes as received, serials never (#149)', async () => {
  const f = fixture();
  const faults: unknown[][] = [];
  f.backend.on('backend_fault', (...args) => faults.push(args));
  const received = [
    ['T8410C', 31],
    ['T8160-C', 19],
    ['T8W11C', 31],
    ['T8419N', 31],
    ['T8410ABCD', 31],
    ['T8224-ABC', 31],
    ['T8224A-B', 31],
    ['T8410c', 31],
    ['T8410PRIVATE0001', 31],
    ['T8410C ', 31],
    [' T8410C', 31],
    ['T8410C\n', 31],
  ];
  f.client.discoverDevices = async () => ({
    devices,
    relationships: [],
    issues: received.map(([deviceModel, deviceType], index) => ({
      index,
      deviceId: 'PRIVATE_SERIAL',
      code: 'unsupported_device',
      deviceModel,
      deviceType,
    })) as unknown as DiscoveryResult['issues'],
  });
  try {
    await f.backend.login({ username: 'fixture', password: 'fixture', country: 'NL' });
    assert.deepEqual(faults, [
      ['unsupported_device', 'device_model=T8410C device_type=31'],
      ['unsupported_device', 'device_model=T8160-C device_type=19'],
      ['unsupported_device', 'device_model=T8W11C device_type=31'],
      ['unsupported_device', 'device_model=T8419N device_type=31'],
      ['unsupported_device', 'device_model=unavailable device_type=31'],
    ]);
    assert.doesNotMatch(JSON.stringify(faults), /PRIVATE/);
  } finally {
    await f.backend.close();
  }
});

for (const empty of [false,true])
  test(`support report crosses Eufy and its normal logger for ${empty?'blocked':'usable'} discovery`, async t => {
    const {Eufy}=await import('../src/eufy.js');
    const {logDiscoveryDiagnostic}=await import('../src/backend-log.js');
    const f=fixture();
    const original=f.client.discoverDevices;
    f.client.discoverDevices=async()=>({...await original(),devices:empty?[]:devices,
      issues:[{index:2,deviceId:'PRIVATE_REJECTED',code:'unsupported_device',deviceModel:'T9999',deviceType:95}]});
    const bridge=new Eufy(f.storage,'mega',false,()=>f.backend);
    const output=t.mock.method(console,'info',()=>{});
    bridge.on('discovery_diagnostic',logDiscoveryDiagnostic);
    try {
      const login=bridge.login({username:'fixture',password:'fixture',country:'NL'});
      if(empty) await assert.rejects(login,{code:'camera_inventory_empty'});
      else await login;
      const lines=output.mock.calls.map(call=>call.arguments[1] as string);
      const rows=lines.map(line=>JSON.parse(line));
      const summary=rows.find(row=>row.event==='summary');
      assert.equal(summary.outcome,empty?'camera_inventory_empty':'accepted');
      assert.equal(summary.experimental_standalone,false);
      assert.equal(summary.software.library,'0.29.2');
      assert.equal(summary.cameras,empty?0:1);
      assert.equal(rows.filter(row=>row.event==='issue').length,1);
      assert.equal(rows.find(row=>row.event==='issue').device_type,95);
      assert.doesNotMatch(lines.join('\n'),/PRIVATE|BASE|CAM/);
      assert.equal(bridge.diagnostics.enabled,false);
      assert.equal(bridge.supportReport().last_discovery.find(row=>row.event==='summary')?.outcome,empty?'camera_inventory_empty':'accepted');
    }finally{await bridge.close();}
  });

test('a failed station connect records the last stage the library reported', async () => {
  const f=fixture();
  const options:unknown[]=[];
  f.client.connectStation=async(_id:string,value?:any)=>{
    options.push(value);
    value?.onProgress?.({stage:'lookup',elapsedMs:0,inventoryAddress:false});
    value?.onProgress?.({stage:'station_found',elapsedMs:40});
    // A stage a newer library might add does not replace the last known one.
    value?.onProgress?.({stage:'future_stage',elapsedMs:50});
    throw new EufyError('device_request_timeout');
  };
  try {
    await f.backend.login({username:'fixture',password:'fixture',country:'NL'});
    const failure=f.backend.supportReport().recent_events.find(row=>row.event==='station_connection'&&row.status==='error')!;
    assert.equal(failure.phase,'connect');
    assert.equal(failure.stage,'station_found');
    assert.equal(failure.inventory_address,false);
    assert.equal(typeof (options[0] as any)?.onProgress,'function');
  } finally {await f.backend.close();}
});

for(const phase of ['connect','refresh_state'] as const)
  test(`station ${phase} failures and subsequent connection events are anonymous`, async () => {
    const f=fixture();
    if(phase==='connect')f.client.connectStation=async()=>{throw new EufyError('device_request_timeout');};
    else f.client.refreshStationState=async()=>{throw new EufyError('device_request_timeout');};
    try {
      await f.backend.login({username:'fixture',password:'fixture',country:'NL'});
      let report=f.backend.supportReport();
      const failure=report.recent_events.find(row=>row.event==='station_connection'&&row.status==='error')!;
      assert.equal(failure.phase,phase);assert.equal(failure.device_ref,1);
      assert.equal(failure.reason,'device_request_timeout');
      // A connect that reported no stage says so, a refresh failure carries none.
      assert.equal(failure.stage,phase==='connect'?'none':undefined);
      assert.equal(report.last_discovery.find(row=>row.event==='device'&&row.ref===1)?.station_status,'error');
      f.client.emit('station',{id:'BASE',connected:true});
      f.client.emit('station',{id:'BASE',connected:true});
      f.client.emit('station',{id:'BASE',connected:false});
      f.client.emit('events-connection',false);f.client.emit('events-connection',false);
      f.client.emit('events-connection',true);
      report=f.backend.supportReport();
      assert.equal(report.recent_events.filter(row=>row.event==='station_connection'&&row.status==='connected').length,1);
      assert.deepEqual(report.recent_events.filter(row=>row.event==='connection'&&row.phase==='events').slice(-2).map(row=>row.outcome),['disconnected','connected']);
      assert.doesNotMatch(JSON.stringify(report),/BASE|CAM|fixture/);
      assert.deepEqual(f.calls,[]);
    } finally {await f.backend.close();}
  });

test('setup errors before backend creation are retained without raw storage errors', async () => {
  const {Eufy}=await import('../src/eufy.js');
  const f=fixture();
  f.storage.read=async()=>'{PRIVATE';
  const bridge=new Eufy(f.storage,'mega',false,()=>f.backend);
  try {
    await assert.rejects(bridge.login({username:'fixture',password:'fixture',country:'NL'}));
    const report=bridge.supportReport();
    assert.equal(report.recent_events.at(-1)!.event,'fault');
    assert.equal(report.recent_events.at(-1)!.code,'inventory_invalid');
    assert.doesNotMatch(JSON.stringify(report),/PRIVATE|fixture/);
  } finally {await bridge.close();}
});

// keesmod/eufy-mega-client#142: an opted-in standalone T84A1 is its own owner.
const wallLight: Device = {
  id: 'WALL',
  stationId: 'WALL',
  kind: 'camera',
  model: 'T84A1',
  name: 'Wall light',
  hardware: '1',
  firmware: '1.1.0.4',
  battery: null,
};
const descriptor = { did: true, license: true, adminUser: true, lanAddress: false };
function standaloneInventory(transport: boolean): DiscoveryResult {
  return {
    devices: [...devices, wallLight],
    relationships: [
      { deviceId: 'BASE', kind: 'station', ownerId: 'BASE' },
      { deviceId: 'CAM', kind: 'station', ownerId: 'BASE' },
      transport
        ? { deviceId: 'WALL', kind: 'standalone', ownerId: 'WALL', transport: 'experimental', descriptor }
        : { deviceId: 'WALL', kind: 'standalone', ownerId: 'WALL', reason: 'standalone_transport_unverified', descriptor },
    ],
    issues: transport ? [] : [{ index: 2, deviceId: 'WALL', code: 'standalone_transport_unverified' }],
  };
}
test('EUFY_EXPERIMENTAL_STANDALONE accepts only true or false and defaults to off', () => {
  assert.equal(experimentalStandalone(undefined), false);
  assert.equal(experimentalStandalone(''), false);
  assert.equal(experimentalStandalone('false'), false);
  assert.equal(experimentalStandalone(' true '), true);
  for (const bad of ['TRUE', 'yes', '1', 'on', 'truee'])
    assert.throws(() => experimentalStandalone(bad), /EUFY_EXPERIMENTAL_STANDALONE/, bad);
});
for (const enabled of [undefined, false, true])
  test(`the experimentalStandalone option ${enabled ? 'reaches' : 'stays off in'} the client (${enabled})`, async () => {
    const f = fixture(undefined, undefined, enabled);
    const events: unknown[] = [];
    f.backend.on('standalone_not_admitted', (model) => events.push(model));
    try {
      await f.backend.login({ username: 'fixture', password: 'fixture', country: 'NL' });
      assert.equal(f.options[0]?.experimentalStandalone, enabled === true);
      assert.equal(f.backend.experimentalStandalone, enabled === true);
      // The report states the option the library received (#154).
      const summary = f.backend.supportReport().last_discovery[0]!;
      assert.equal(summary.event, 'summary');
      assert.equal(summary.experimental_standalone, enabled === true);
      // The default inventory has no standalone row.
      assert.deepEqual(events, []);
    } finally {
      await f.backend.close();
    }
  });
test('an opted-in standalone camera connects once at discovery and never becomes a HomeBase', async () => {
  const f = fixture(undefined, undefined, true);
  const connected: string[] = [];
  const connect = f.client.connectStation;
  f.client.connectStation = async (id: string, value?: any) => {
    connected.push(id);
    if (id === 'WALL') {
      value?.onProgress?.({ stage: 'lookup', elapsedMs: 0, inventoryAddress: false });
      value?.onProgress?.({ stage: 'encryption_ready', elapsedMs: 900 });
      value?.onLookup?.({ rounds: 1, broadcastTargets: 1, broadcastEnabled: true, sendErrors: 0, datagrams: 1, otherHeaders: 0, ownReplies: 1, ownRound: 0, accountReplies: 0, foreignReplies: 0, nearReplies: 0, inventoryReply: 'none' });
      // Like the library, the session reports itself before the connect resolves.
      const session = { id: 'WALL', connected: true, guardMode: null, currentMode: null, alarm: false, alarmDelay: 0, armDelay: 0, commandEncryption: 'lan-derived' as const };
      f.client.emit('station', session);
      return session;
    }
    return connect();
  };
  f.client.discoverDevices = async () => standaloneInventory(true);
  try {
    await f.backend.login({ username: 'fixture', password: 'fixture', country: 'NL' });
    assert.deepEqual(connected, ['BASE', 'WALL']);
    const report = f.backend.supportReport();
    const row = report.last_discovery.find((r) => r.event === 'device' && r.model === 'T84A1')!;
    assert.equal(row.relationship, 'standalone');
    assert.equal(row.relationship_transport, 'experimental');
    assert.equal(row.relationship_reason, null);
    assert.equal(row.owner_status, 'connected');
    assert.equal(row.owner_connected, true);
    assert.equal(row.station_status, 'not_applicable');
    assert.deepEqual(row.descriptor, { did: true, license: true, admin_user: true, lan_address: false });
    const events = report.recent_events.filter((r) => r.event === 'station_connection' && r.model === 'T84A1');
    // The session's own connected observation comes first. The connect record
    // that follows carries the lookup of that attempt (#152).
    assert.deepEqual(
      events.map((r) => [r.phase, r.status, r.stage, r.lookup_rounds, r.lookup_own_replies, r.lookup_own_round, r.lookup_inventory_reply]),
      [
        ['observation', 'connected', undefined, undefined, undefined, undefined, undefined],
        ['connect', 'connected', undefined, 1, 1, 0, 'none'],
      ],
    );
    assert.equal((f.backend as any).stationStates.has('WALL'), false);
    // Its session is no HomeBase: no alarm entity and no idle reconnect.
    f.client.emit('station', { id: 'WALL', connected: false });
    assert.deepEqual(
      f.backend.stations.inventory().map((station) => station.serial),
      ['BASE'],
    );
    assert.equal((f.backend as any).stationStates.has('WALL'), false);
    assert.equal(f.backend.inventory().find((camera) => camera.serial === 'WALL')?.model, 'T84A1');
    assert.doesNotMatch(JSON.stringify(report), /WALL|BASE|CAM|Wall light/);
  } finally {
    await f.backend.close();
  }
});
test('a failed standalone connect records its stage and leaves the HomeBase connected', async () => {
  const f = fixture(undefined, undefined, true);
  const faults: string[] = [];
  f.backend.on('backend_fault', (code) => faults.push(code));
  const connect = f.client.connectStation;
  f.client.connectStation = async (id: string, value?: any) => {
    if (id !== 'WALL') return connect();
    value?.onProgress?.({ stage: 'lookup', elapsedMs: 0, inventoryAddress: true });
    throw new EufyError('device_request_timeout');
  };
  f.client.discoverDevices = async () => standaloneInventory(true);
  try {
    assert.deepEqual(await f.backend.login({ username: 'fixture', password: 'fixture', country: 'NL' }), { state: 'connected' });
    const report = f.backend.supportReport();
    const failure = report.recent_events.find((r) => r.event === 'station_connection' && r.status === 'error')!;
    assert.equal(failure.model, 'T84A1');
    assert.equal(failure.stage, 'lookup');
    assert.equal(failure.inventory_address, true);
    assert.equal(failure.reason, 'device_request_timeout');
    const row = report.last_discovery.find((r) => r.event === 'device' && r.model === 'T84A1')!;
    assert.equal(row.owner_status, 'error');
    assert.equal(row.owner_connected, null);
    assert.ok(faults.includes('device_request_timeout'));
    assert.equal(f.backend.stations.inventory()[0]?.connected, true);
  } finally {
    await f.backend.close();
  }
});
// What client 0.30.0 reports through onLookup when an attempt's lookup ends (#152).
const lookupSeen = {
  rounds: 3, broadcastTargets: 2, broadcastEnabled: true, sendErrors: 0, datagrams: 0, otherHeaders: 0,
  ownReplies: 0, accountReplies: 0, foreignReplies: 0, nearReplies: 0, inventoryReply: 'none' as const,
  inventoryAddressOnSubnet: true, inventoryAddressShared: false,
};
test('discovery connects pass onLookup, and each lookup reaches the log line and the bridge download (#152)', async t => {
  const {Eufy}=await import('../src/eufy.js');
  const {logDiscoveryDiagnostic}=await import('../src/backend-log.js');
  const f = fixture(undefined, undefined, true);
  const options = new Map<string, any>();
  const connect = f.client.connectStation;
  f.client.connectStation = async (id: string, value?: any) => {
    options.set(id, value);
    value?.onProgress?.({ stage: 'lookup', elapsedMs: 0, inventoryAddress: true });
    if (id === 'BASE') {
      value?.onLookup?.({ ...lookupSeen, rounds: 1, broadcastTargets: 0, datagrams: 1, ownReplies: 1, ownRound: 0, inventoryReply: 'own' });
      return connect();
    }
    // A reply from another device in the account, and none from the camera itself.
    value?.onLookup?.({ ...lookupSeen, datagrams: 2, accountReplies: 2, inventoryAddressShared: true, did: 'PRIVATE_DID', address: '192.0.2.7' });
    throw new EufyError('device_request_timeout');
  };
  f.client.discoverDevices = async () => standaloneInventory(true);
  const bridge = new Eufy(f.storage, 'mega', false, () => f.backend);
  const output = t.mock.method(console, 'info', () => {});
  bridge.on('discovery_diagnostic', logDiscoveryDiagnostic);
  try {
    await bridge.login({ username: 'fixture', password: 'fixture', country: 'NL' });
    for (const id of ['BASE', 'WALL']) {
      assert.equal(typeof options.get(id)?.onProgress, 'function', id);
      assert.equal(typeof options.get(id)?.onLookup, 'function', id);
    }
    const download = bridge.supportReport().recent_events.filter((r) => r.event === 'station_connection');
    // The HomeBase's connect is reported by the refresh_state record that follows it.
    const base = download.find((r) => r.model === 'T8030')!;
    assert.deepEqual([base.phase, base.status, base.stage], ['refresh_state', 'connected', undefined]);
    assert.deepEqual([base.lookup_rounds, base.lookup_own_replies, base.lookup_own_round, base.lookup_inventory_reply], [1, 1, 0, 'own']);
    const wall = download.find((r) => r.model === 'T84A1')!;
    assert.deepEqual([wall.phase, wall.status, wall.stage, wall.inventory_address], ['connect', 'error', 'lookup', true]);
    assert.deepEqual(
      [wall.lookup_rounds, wall.lookup_datagrams, wall.lookup_account_replies, wall.lookup_inventory_reply, wall.inventory_address_shared],
      [3, 2, 2, 'none', true],
    );
    // The Eufy discovery: log lines carry the same records.
    const logged = output.mock.calls
      .filter((call) => call.arguments[0] === 'Eufy discovery:')
      .map((call) => JSON.parse(call.arguments[1] as string))
      .filter((r) => r.event === 'station_connection');
    assert.deepEqual(logged, download);
    assert.doesNotMatch(JSON.stringify(bridge.supportReport()) + JSON.stringify(output.mock.calls), /PRIVATE|192\.0\.2\.7|WALL|BASE|CAM/);
  } finally {
    await bridge.close();
  }
});
test('the idle reconnect of a HomeBase records its lookup like a discovery connect (#152)', async () => {
  const f = fixture();
  const connect = f.client.connectStation;
  try {
    await f.backend.login({ username: 'fixture', password: 'fixture', country: 'NL' });
    let options: any;
    f.client.connectStation = async (_id: string, value?: any) => {
      options = value;
      value?.onProgress?.({ stage: 'lookup', elapsedMs: 0, inventoryAddress: true });
      value?.onLookup?.({ ...lookupSeen, rounds: 0, broadcastEnabled: false });
      throw new EufyError('device_request_timeout');
    };
    f.client.emit('station', { id: 'BASE', connected: false });
    await (f.backend as unknown as { refresh(): Promise<void> }).refresh();
    assert.equal(typeof options?.onLookup, 'function');
    const failure = f.backend.supportReport().recent_events.filter((r) => r.event === 'station_connection').at(-1)!;
    assert.deepEqual([failure.phase, failure.status, failure.stage], ['connect', 'error', 'lookup']);
    assert.deepEqual([failure.lookup_rounds, failure.lookup_broadcast_enabled], [0, false]);
    // A successful idle reconnect reports its lookup on the refresh_state record.
    f.client.connectStation = async (_id: string, value?: any) => {
      value?.onLookup?.({ ...lookupSeen, rounds: 1, datagrams: 1, ownReplies: 1, ownRound: 0, inventoryReply: 'own' });
      return connect();
    };
    await (f.backend as unknown as { refresh(): Promise<void> }).refresh();
    const restored = f.backend.supportReport().recent_events.filter((r) => r.event === 'station_connection').at(-1)!;
    assert.deepEqual([restored.phase, restored.status, restored.stage], ['refresh_state', 'connected', undefined]);
    assert.deepEqual([restored.lookup_rounds, restored.lookup_own_replies, restored.lookup_inventory_reply], [1, 1, 'own']);
  } finally {
    await f.backend.close();
  }
});
test('a HomeBase refresh_state failure carries the lookup of the connect before it (#152)', async () => {
  const f = fixture();
  const connect = f.client.connectStation;
  f.client.connectStation = async (_id: string, value?: any) => {
    value?.onProgress?.({ stage: 'lookup', elapsedMs: 0, inventoryAddress: true });
    value?.onLookup?.({ ...lookupSeen, rounds: 1, datagrams: 1, ownReplies: 1, ownRound: 0, inventoryReply: 'own' });
    return connect();
  };
  f.client.refreshStationState = async () => { throw new EufyError('device_request_timeout'); };
  try {
    await f.backend.login({ username: 'fixture', password: 'fixture', country: 'NL' });
    const failure = f.backend.supportReport().recent_events.find((r) => r.event === 'station_connection' && r.status === 'error')!;
    assert.deepEqual([failure.phase, failure.status, failure.stage], ['refresh_state', 'error', undefined]);
    assert.deepEqual([failure.lookup_rounds, failure.lookup_own_replies, failure.lookup_inventory_reply], [1, 1, 'own']);
  } finally {
    await f.backend.close();
  }
});

test('an unverified standalone camera is never connected and reports its descriptor', async () => {
  const f = fixture();
  const events: unknown[] = [];
  f.backend.on('standalone_not_admitted', (model) => events.push(model));
  const connected: string[] = [];
  const connect = f.client.connectStation;
  f.client.connectStation = async (id: string) => {
    connected.push(id);
    return connect();
  };
  f.client.discoverDevices = async () => standaloneInventory(false);
  try {
    await f.backend.login({ username: 'fixture', password: 'fixture', country: 'NL' });
    assert.deepEqual(connected, ['BASE']);
    const row = f.backend.supportReport().last_discovery.find((r) => r.event === 'device' && r.model === 'T84A1')!;
    assert.equal(row.relationship_reason, 'standalone_transport_unverified');
    assert.equal(row.relationship_transport, null);
    assert.equal(row.owner_status, 'not_applicable');
    assert.equal(row.owner_connected, null);
    assert.deepEqual(row.descriptor, { did: true, license: true, admin_user: true, lan_address: false });
    // With the option off the row says nothing about admission (#154).
    assert.equal(f.backend.supportReport().last_discovery[0]!.experimental_standalone, false);
    assert.deepEqual(events, []);
  } finally {
    await f.backend.close();
  }
});

// A standalone camera row with a complete descriptor and an empty or self parent.
function rawStandalone(id: string, parent: string, model: string, type: number, firmware: string, address: string) {
  return {
    category: 'eufy_security',
    device_sn: id,
    parent_sn: parent,
    device_model: model,
    device_type: type,
    device_name: 'PRIVATE_NAME',
    main_sw_version: firmware,
    p2p_did: 'PRIVATE_DID',
    p2p_license: 'PRIVATE_LICENSE',
    member: { admin_user_id: 'PRIVATE_ADMIN' },
    params: [{ param_type: 1176, param_value: address }],
  };
}

// The T8410 rows mirror ha-eufy-cam#152: two standalone type 31 cameras without a HomeBase.
for (const enabled of [true, false])
  test(`raw standalone T84A1 and T8410 rows through the shipped client ${enabled ? 'each connect and report presence only' : 'stay unverified'}`, async () => {
    const f = fixture(undefined, undefined, enabled);
    const events: unknown[] = [];
    f.backend.on('standalone_not_admitted', (model) => events.push(model));
    const connected: string[] = [];
    const connect = f.client.connectStation;
    f.client.connectStation = async (id: string) => {
      connected.push(id);
      return connect();
    };
    const rows = [
      { category: 'eufy_security', device_sn: 'BASE', parent_sn: '', device_model: 'T8030', device_type: 18, device_name: 'PRIVATE_NAME', main_sw_version: '3.8.7.4', p2p_did: 'PRIVATE_DID', member: { admin_user_id: 'PRIVATE_ADMIN' } },
      { category: 'eufy_security', device_sn: 'CAM', parent_sn: 'BASE', device_model: 'T8161', device_type: 23, device_name: 'PRIVATE_NAME' },
      rawStandalone('WALL', '', 'T84A1', 151, '1.1.0.4', '192.168.1.40'),
      rawStandalone('PAN_A', '', 'T8410', 31, '2.3.2.4', '192.168.1.41'),
      rawStandalone('PAN_B', 'PAN_B', 'T8410', 31, '2.3.1.6', '192.168.1.42'),
    ];
    // The installed library's discovery, with only the cloud boundary synthetic.
    const actual = Object.assign(Object.create(EufyMegaClient.prototype), {
      experimentalStandalone: enabled,
      cloud: { call: async () => ({ devices: rows }) },
    }) as EufyMegaClient;
    f.client.discoverDevices = () => actual.discoverDevices();
    try {
      assert.equal((await f.backend.login({ username: 'fixture', password: 'fixture', country: 'NL' })).state, 'connected');
      assert.deepEqual([...connected].sort(), enabled ? ['BASE', 'PAN_A', 'PAN_B', 'WALL'] : ['BASE']);
      const report = f.backend.supportReport();
      const wall = report.last_discovery.filter((r) => r.event === 'device' && r.model === 'T84A1');
      const pans = report.last_discovery.filter((r) => r.event === 'device' && r.model === 'T8410');
      assert.equal(wall.length, 1);
      assert.equal(pans.length, 2);
      assert.deepEqual(pans.map((r) => r.firmware).sort(), ['2.3.1.6', '2.3.2.4']);
      for (const row of [...wall, ...pans]) {
        assert.equal(row.relationship_transport, enabled ? 'experimental' : null);
        assert.equal(row.relationship_reason, enabled ? null : 'standalone_transport_unverified');
        assert.equal(row.owner_status, enabled ? 'connected' : 'not_applicable');
        assert.deepEqual(row.descriptor, { did: true, license: true, admin_user: true, lan_address: true });
      }
      assert.doesNotMatch(JSON.stringify(report), /PRIVATE|192\.168\.1\.4[0-2]|WALL|BASE|PAN_/);
      // Admitted models are never named, and with the option off nothing is (#154).
      assert.deepEqual(events, []);
      assert.equal(report.last_discovery[0]!.experimental_standalone, enabled);
    } finally {
      await f.backend.close();
    }
  });

// #149: raw rows go through the installed client, so a pin without the T8160-C and
// T8410C admissions fails here even when its version string matches the notes.
for (const enabled of [true, false])
  test(`raw T8160-C, T8410C and T8410 rows through the shipped client with the opt-in ${enabled ? 'on' : 'off'} (#149, #152)`, async () => {
    const f = fixture(undefined, undefined, enabled);
    const faults: unknown[][] = [];
    f.backend.on('backend_fault', (...args) => faults.push(args));
    const events: unknown[] = [];
    f.backend.on('standalone_not_admitted', (model) => events.push(model));
    const connected: string[] = [];
    const connect = f.client.connectStation;
    f.client.connectStation = async (id: string) => {
      connected.push(id);
      return connect();
    };
    const row = (device_sn: string, parent_sn: string, device_model: string, device_type: number, main_sw_version: string) => ({
      category: 'eufy_security',
      device_sn,
      parent_sn,
      device_model,
      device_type,
      main_sw_version,
      device_name: 'PRIVATE_NAME',
      p2p_did: 'PRIVATE_DID',
      p2p_license: 'PRIVATE_LICENSE',
      member: { admin_user_id: 'PRIVATE_ADMIN' },
      params: [{ param_type: 1176, param_value: '192.168.1.42' }],
    });
    const rows = [
      row('BASE', '', 'T8030', 18, '3.8.7.4'),
      row('H3_EUFYCAM', 'BASE', 'T8160-C', 19, '1.5.8.6'),
      row('H3_INDOOR', 'BASE', 'T8410C', 31, '3.3.4.4'),
      row('SOLO_C', '', 'T8410C', 31, '3.3.4.4'),
      row('SOLO', 'SOLO', 'T8410', 31, '2.3.2.4'),
    ];
    // The installed library's discovery, with only the cloud boundary synthetic.
    const actual = Object.assign(Object.create(EufyMegaClient.prototype), {
      experimentalStandalone: enabled,
      cloud: { call: async () => ({ devices: rows }) },
    }) as EufyMegaClient;
    f.client.discoverDevices = () => actual.discoverDevices();
    const unverified = ['standalone', 'standalone_transport_unverified', null, 'not_applicable'];
    try {
      assert.equal((await f.backend.login({ username: 'fixture', password: 'fixture', country: 'NL' })).state, 'connected');
      assert.deepEqual([...connected].sort(), enabled ? ['BASE', 'SOLO'] : ['BASE']);
      // Only the standalone T8410C, and a T8410 without the opt-in, stay unverified.
      assert.deepEqual(faults, [['standalone_transport_unverified']]);
      // With the opt-in the standalone T8410C is named as not admitted (#154).
      assert.deepEqual(events, enabled ? ['T8410C'] : []);
      const report = f.backend.supportReport();
      assert.equal(report.last_discovery[0]!.experimental_standalone, enabled);
      const cameras = report.last_discovery
        .filter((r) => r.event === 'device' && r.model !== 'T8030')
        .map((r) => [r.model, r.relationship, r.relationship_reason, r.relationship_transport, r.owner_status]);
      const t8410 = enabled ? ['standalone', null, 'experimental', 'connected'] : unverified;
      assert.deepEqual(cameras, [
        ['T8160-C', 'station', null, null, 'connected'],
        ['T8410C', 'station', null, null, 'connected'],
        // T8410C has no experimental standalone route, also with the opt-in.
        ['T8410C', ...unverified],
        ['T8410', ...t8410],
      ]);
      assert.deepEqual(f.backend.inventory().map((camera) => camera.model), ['T8160-C', 'T8410C', 'T8410C', 'T8410']);
      assert.doesNotMatch(JSON.stringify(report), /PRIVATE|192\.168\.1\.42|BASE|H3_|SOLO/);
    } finally {
      await f.backend.close();
    }
  });

// #154: with the opt-in, each standalone row the installed client keeps at
// standalone_transport_unverified is named once per discovery by model code only.
for (const enabled of [true, false])
  test(`raw mixed standalone rows through the shipped client name only the rows the client did not admit, opt-in ${enabled ? 'on' : 'off'} (#154)`, async () => {
    const f = fixture(undefined, undefined, enabled);
    const events: unknown[] = [];
    f.backend.on('standalone_not_admitted', (model) => events.push(model));
    const connected: string[] = [];
    const connect = f.client.connectStation;
    f.client.connectStation = async (id: string) => {
      connected.push(id);
      return connect();
    };
    const rows = [
      { category: 'eufy_security', device_sn: 'BASE', parent_sn: '', device_model: 'T8030', device_type: 18, device_name: 'PRIVATE_NAME', main_sw_version: '3.8.7.4', p2p_did: 'PRIVATE_DID', member: { admin_user_id: 'PRIVATE_ADMIN' } },
      { category: 'eufy_security', device_sn: 'CAM', parent_sn: 'BASE', device_model: 'T8161', device_type: 23, device_name: 'PRIVATE_NAME' },
      rawStandalone('WALL', '', 'T84A1', 151, '1.1.0.4', '192.168.1.40'),
      rawStandalone('PAN', 'PAN', 'T8410', 31, '2.3.2.4', '192.168.1.41'),
      rawStandalone('SOLO_C', '', 'T8410C', 31, '3.3.4.4', '192.168.1.42'),
      rawStandalone('INDOOR_A', '', 'T8400', 30, '2.1.6.4', '192.168.1.43'),
      rawStandalone('INDOOR_B', 'INDOOR_B', 'T8400', 30, '2.1.6.4', '192.168.1.44'),
      { category: 'eufy_security', device_sn: 'ORPHAN', parent_sn: 'MISSING', device_model: 'T8161', device_type: 23, device_name: 'PRIVATE_NAME' },
    ];
    // The installed library's discovery, with only the cloud boundary synthetic.
    const actual = Object.assign(Object.create(EufyMegaClient.prototype), {
      experimentalStandalone: enabled,
      cloud: { call: async () => ({ devices: rows }) },
    }) as EufyMegaClient;
    f.client.discoverDevices = () => actual.discoverDevices();
    try {
      assert.equal((await f.backend.login({ username: 'fixture', password: 'fixture', country: 'NL' })).state, 'connected');
      const notAdmitted = ['T8410C', 'T8400', 'T8400'];
      assert.deepEqual(events, enabled ? notAdmitted : []);
      assert.deepEqual([...connected].sort(), enabled ? ['BASE', 'PAN', 'WALL'] : ['BASE']);
      const report = f.backend.supportReport();
      assert.equal(report.last_discovery[0]!.experimental_standalone, enabled);
      const standalone = report.last_discovery
        .filter((r) => r.event === 'device' && ['T8410C', 'T8400'].includes(r.model as string))
        .map((r) => [r.model, r.relationship, r.relationship_reason, r.relationship_transport, r.owner_status]);
      const unverified = ['standalone', 'standalone_transport_unverified', null, 'not_applicable'];
      assert.deepEqual(standalone, [['T8410C', ...unverified], ['T8400', ...unverified], ['T8400', ...unverified]]);
      const orphan = report.last_discovery.filter((r) => r.event === 'device' && r.relationship === 'unsupported');
      assert.deepEqual(orphan.map((r) => [r.model, r.relationship_reason]), [['T8161', 'unsupported_station']]);
      // A rediscovery after a reconnect names them again.
      await (f.backend as any).discover();
      assert.deepEqual(events, enabled ? [...notAdmitted, ...notAdmitted] : []);
      const ids = /PRIVATE|192\.168\.|BASE|CAM|WALL|PAN|SOLO_C|INDOOR_|ORPHAN|MISSING/;
      assert.doesNotMatch(JSON.stringify(events), ids);
      assert.doesNotMatch(JSON.stringify(f.backend.supportReport()), ids);
    } finally {
      await f.backend.close();
    }
  });

test('hostile standalone rows are named only as unavailable, and only for a matching unadmitted device row (#154)', async () => {
  const f = fixture(undefined, undefined, true);
  const events: unknown[] = [];
  f.backend.on('standalone_not_admitted', (model) => events.push(model));
  const connected: string[] = [];
  const connect = f.client.connectStation;
  f.client.connectStation = async (id: string) => {
    connected.push(id);
    return connect();
  };
  const camera = (id: string, model: string): Device => ({ id, stationId: id, kind: 'camera', model, name: 'PRIVATE_NAME', hardware: '1', firmware: '1.0.0.0', battery: null });
  const descriptor = { did: true, license: true, adminUser: true, lanAddress: true };
  f.client.discoverDevices = async () => ({
    devices: [
      ...devices,
      camera('HOSTILE_A', 'T8400\nPRIVATE_TOKEN'),
      camera('HOSTILE_B', 'T8410PRIVATE0001'),
      camera('BOTH', 'T8410C'),
      camera('FUTURE', 'T8400'),
    ],
    relationships: [
      { deviceId: 'BASE', kind: 'station', ownerId: 'BASE' },
      { deviceId: 'CAM', kind: 'station', ownerId: 'BASE' },
      { deviceId: 'HOSTILE_A', kind: 'standalone', ownerId: 'HOSTILE_A', reason: 'standalone_transport_unverified', descriptor },
      { deviceId: 'HOSTILE_B', kind: 'standalone', ownerId: 'HOSTILE_B', reason: 'standalone_transport_unverified', descriptor },
      // A relationship without a device row is never named.
      { deviceId: 'GHOST', kind: 'standalone', ownerId: 'GHOST', reason: 'standalone_transport_unverified', descriptor },
      // The client's experimental transport wins over a reason, whatever the model.
      { deviceId: 'BOTH', kind: 'standalone', ownerId: 'BOTH', transport: 'experimental', reason: 'standalone_transport_unverified', descriptor } as unknown as DiscoveryResult['relationships'][number],
      // Only the exact standalone_transport_unverified reason is named, as in HA,
      // so a future client reason is never mislabelled as not admitted.
      { deviceId: 'FUTURE', kind: 'standalone', ownerId: 'FUTURE', reason: 'future_standalone_reason', descriptor } as unknown as DiscoveryResult['relationships'][number],
    ],
    issues: [],
  });
  try {
    await f.backend.login({ username: 'fixture', password: 'fixture', country: 'NL' });
    assert.deepEqual(events, ['unavailable', 'unavailable']);
    assert.deepEqual([...connected].sort(), ['BASE', 'BOTH']);
    for (const model of events) assert.doesNotMatch(String(model), /PRIVATE|\n/);
    assert.doesNotMatch(JSON.stringify(f.backend.supportReport()), /PRIVATE|HOSTILE|GHOST|FUTURE/);
  } finally {
    await f.backend.close();
  }
});

test('only a boolean true option names unadmitted standalone rows (#154)', async () => {
  const f = fixture(undefined, undefined, 'true' as unknown as boolean);
  const events: unknown[] = [];
  f.backend.on('standalone_not_admitted', (model) => events.push(model));
  f.client.discoverDevices = async () => standaloneInventory(false);
  try {
    await f.backend.login({ username: 'fixture', password: 'fixture', country: 'NL' });
    assert.equal(f.backend.supportReport().last_discovery[0]!.experimental_standalone, false);
    assert.deepEqual(events, []);
  } finally {
    await f.backend.close();
  }
});

test('an unadmitted standalone row is named before a failing migration baseline rejects login (#154)', async () => {
  const f = fixture(undefined, undefined, true);
  const order: unknown[] = [];
  f.backend.on('standalone_not_admitted', (model) => order.push(model));
  const expected = { version: 1, bridge_id: 'bridge-test', backend: 'legacy', cameras: ['CAM', 'MISSING'], stations: ['BASE'] };
  f.storage.read = async (name) => {
    if (name === 'migration-inventory.json') {
      order.push('baseline');
      return JSON.stringify(expected);
    }
    return name === 'bridge-id' ? 'bridge-test' : undefined;
  };
  const rows = [
    { category: 'eufy_security', device_sn: 'BASE', parent_sn: '', device_model: 'T8030', device_type: 18, device_name: 'PRIVATE_NAME' },
    { category: 'eufy_security', device_sn: 'CAM', parent_sn: 'BASE', device_model: 'T8161', device_type: 23, device_name: 'PRIVATE_NAME' },
    rawStandalone('SOLO_C', '', 'T8410C', 31, '3.3.4.4', '192.168.1.42'),
  ];
  const actual = Object.assign(Object.create(EufyMegaClient.prototype), {
    experimentalStandalone: true,
    cloud: { call: async () => ({ devices: rows }) },
  }) as EufyMegaClient;
  f.client.discoverDevices = () => actual.discoverDevices();
  try {
    await assert.rejects(f.backend.login({ username: 'fixture', password: 'fixture', country: 'NL' }), /expected_devices_missing/);
    assert.deepEqual(order, ['T8410C', 'baseline']);
    const summary = f.backend.supportReport().last_discovery[0]!;
    assert.equal(summary.outcome, 'expected_devices_missing');
    assert.equal(summary.experimental_standalone, true);
    assert.doesNotMatch(JSON.stringify(f.backend.supportReport()), /PRIVATE|192\.168\.|SOLO_C/);
  } finally {
    await f.backend.close();
  }
});
