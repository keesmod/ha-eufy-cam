import { tmpdir } from 'node:os';
import { test } from 'node:test';
process.env.EUFY_DATA_DIR = tmpdir();
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import {
  EufyError,
  EufyMegaClient,
  type ClientOptions,
  type Device,
  type CameraCapabilities,
  type DiscoveryResult,
  type RecordingObservation,
  type RecordingOperationOptions,
} from '@keesmod/eufy-mega-client';
import {
  MegaBackend,
  liveStreamsPerStation,
  liveMaxSecondsMains,
  experimentalStandalone,
  standaloneRecordingProbe,
  recordingProbeNotice,
} from '../src/mega-backend.js';
import { Storage } from '../src/storage.js';
import { backendName, type LiveMedia } from '../src/backend.js';
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
    // Since client 0.30.1 the bridge passes the options form (#152).
    downloadRecording: async (_id: string, options: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new EufyError('download_cancelled')), {
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
function fixture(limit?: number, mainsSeconds?: number, standalone?: boolean, probe?: boolean, smoothing?: boolean) {
  const calls: string[] = [];
  // Each standalone recording probe the backend asks the client for (#178).
  const probes: { id: string; options: unknown }[] = [];
  // Each preset move the backend hands the client (#229).
  const moves: { id: string; preset: number; signal: AbortSignal | undefined }[] = [];
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
    moveToPreset: async (id: string, preset: number, signal?: AbortSignal) => {
      moves.push({ id, preset, signal });
      return { preset, elapsedMs: 5 };
    },
    startLive: async (id: string, options?: { maxDurationMs?: number; onProgress?: (progress: { stage: string; elapsedMs: number }) => void; onFrameTiming?: (timing: unknown) => void }) => {
      calls.push('start');
      timings.push(options?.onFrameTiming);
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
    probeStandaloneRecordings: async (id: string, options?: unknown): Promise<RecordingObservation> => {
      probes.push({ id, options });
      return probeAnswer();
    },
  });
  const storage = new Storage('/unused');
  const reads: string[] = [];
  storage.read = async (name) => {
    reads.push(name);
    return undefined;
  };
  storage.write = async () => {};
  const bounds: (number | null)[] = [];
  const timings: unknown[] = [];
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
    probe,
    smoothing,
  );
  return { backend, client, calls, reads, storage, options, bounds, probes, timings, moves };
}
/** The client's observation of a standalone probe answered with an empty page (#178). */
function probeAnswer(change: Partial<RecordingObservation> = {}): RecordingObservation {
  return {
    operation: 'probe', owner: 'standalone', sessionOpen: true, stage: 'validate', code: null, remoteCode: null,
    elapsedMs: 640, pages: [{ limit: 20, elapsedMs: 600, answered: true, ackCode: 0, resultCode: 0, rows: 0 }],
    unhandledReplies: 0, unhandledReason: null, unhandledResultCode: null,
    rowClasses: { own: 0, otherDevice: 0, stationMismatch: 0, invalidTime: 0, otherDay: 0, cipherId: 0 },
    ...change,
  };
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
test('live media is paced on the camera clock by default and observed at the library streams', async () => {
  for (const smoothing of [undefined, false]) {
    const f = fixture(undefined, undefined, undefined, undefined, smoothing);
    try {
      await f.backend.login({ username: 'fixture', password: 'fixture', country: 'NL' });
      const media: LiveMedia[] = [];
      f.backend.on('live-start', (event: LiveMedia) => media.push(event));
      await f.backend.startLive('CAM');
      if (smoothing === false) {
        assert.equal(f.timings[0], undefined, 'no timing callback without smoothing');
        assert.equal(media[0]?.source, undefined);
      } else {
        assert.equal(typeof f.timings[0], 'function');
        assert.ok(media[0]?.source, 'diagnostics get the library streams');
        assert.notEqual(media[0]?.video, media[0]?.source?.video);
        assert.notEqual(media[0]?.audio, media[0]?.source?.audio);
      }
      await f.backend.stopLive('CAM');
    } finally {
      await f.backend.close();
    }
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
      assert.equal(summary.software.library,'0.30.3-beta.1');
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
// ha-eufy-cam#185: the client's standalone push counts in the support report.
const pushStatus = () => ({
  arrived: 5,
  admitted: 2,
  refused: { events_not_enabled: 0, owner_unavailable: 0, serial_mismatch: 1, type_mismatch: 1, unsupported_event: 1 },
  sources: { cloud: 5, local: 0 },
  eventCodes: { '3101': 1, '3102': 1, '3105': 2, none: 1 },
  pushTypes: { '151': 4, other: 1 },
});
const pushReport = {
  arrived: 5,
  admitted: 2,
  refused: { events_not_enabled: 0, owner_unavailable: 0, serial_mismatch: 1, type_mismatch: 1, unsupported_event: 1 },
  sources: { cloud: 5, local: 0 },
  event_codes: [{ code: 3101, count: 1 }, { code: 3102, count: 1 }, { code: 3105, count: 2 }, { code: 'none', count: 1 }],
  push_types: [{ code: 151, count: 4 }, { code: 'other', count: 1 }],
};
test('the support report carries the client standalone push counts, null without a client (#185)', async () => {
  const f = fixture(undefined, undefined, true);
  assert.equal(f.backend.supportReport().standalone_pushes, null, 'no client before the first login');
  let status: unknown = pushStatus();
  Object.defineProperty(f.client, 'standalonePushStatus', { get: () => status, configurable: true });
  f.client.discoverDevices = async () => standaloneInventory(true);
  try {
    await f.backend.login({ username: 'fixture', password: 'fixture', country: 'NL' });
    assert.deepEqual(f.backend.supportReport().standalone_pushes, pushReport);
    // Hostile values from the library boundary leave only bounded integers.
    status = {
      ...pushStatus(),
      arrived: 2 ** 31,
      admitted: '2',
      serial: 'WALL',
      sources: { cloud: 1.5, local: -1, WALL: 1 },
      eventCodes: { WALL: 1, '192.168.1.20': 2, '3101': 1 },
      pushTypes: { '151': { WALL: 1 } },
    };
    const hostile = f.backend.supportReport().standalone_pushes!;
    assert.equal(hostile.arrived, null);
    assert.equal(hostile.admitted, null);
    assert.deepEqual(hostile.sources, { cloud: null, local: null });
    assert.deepEqual(hostile.event_codes, [{ code: 3101, count: 1 }]);
    assert.deepEqual(hostile.push_types, []);
    assert.doesNotMatch(JSON.stringify(f.backend.supportReport()), /PRIVATE|WALL|BASE|CAM|192\.168|fixture/);
    // A getter that throws or a client without it never fails the download.
    Object.defineProperty(f.client, 'standalonePushStatus', { get: () => { throw new Error('PRIVATE WALL'); }, configurable: true });
    assert.equal(f.backend.supportReport().standalone_pushes, null);
    Object.defineProperty(f.client, 'standalonePushStatus', { value: undefined, configurable: true });
    assert.equal(f.backend.supportReport().standalone_pushes, null);
  } finally {
    await f.backend.close();
  }
});
test('a standalone T84A1 motion and person event reaches the notification path like a HomeBase camera, without a camera call (#185)', async () => {
  const f = fixture(undefined, undefined, true);
  f.client.discoverDevices = async () => standaloneInventory(true);
  const commands: string[] = [];
  try {
    await f.backend.login({ username: 'fixture', password: 'fixture', country: 'NL' });
    f.client.connectStation = async () => { commands.push('connect'); throw new Error('no connection'); };
    const notifications: Record<string, unknown>[] = [];
    f.backend.on('notification', (event) => notifications.push(event));
    for (const [id, type] of [['m', 'motion'], ['p', 'person']] as const)
      f.client.emit('event', {
        id, deviceId: 'WALL', type, receivedAt: 'time', occurredAt: null, source: 'push',
        personName: null, recognition: type === 'person' ? 'unidentified' : 'not_applicable', vendorEventType: type === 'motion' ? 3101 : 3102,
      });
    assert.deepEqual(notifications.map((n) => [n.serial, n.event_type, n.recognition, n.eufy_event_type]), [
      ['WALL', 'motion', 'not_applicable', 3101],
      ['WALL', 'person', 'unidentified', 3102],
    ]);
    assert.deepEqual(commands, [], 'an event opens no connection');
    assert.deepEqual(f.calls, [], 'an event starts no live view');
  } finally {
    await f.backend.close();
  }
});
test('the shipped client\'s standalone push counts pass the bridge projection as zeros (#185)', async () => {
  const client = new EufyMegaClient({
    credentials: { email: 'fixture@example.invalid', password: 'fixture', country: 'NL' },
    sessionStore: { load: async () => undefined, save: async () => {} },
  });
  try {
    const { standalonePushReport } = await import('../src/discovery-diagnostics.js');
    assert.deepEqual(standalonePushReport(client.standalonePushStatus), {
      arrived: 0,
      admitted: 0,
      refused: { events_not_enabled: 0, owner_unavailable: 0, serial_mismatch: 0, type_mismatch: 0, unsupported_event: 0 },
      sources: { cloud: 0, local: 0 },
      event_codes: [],
      push_types: [],
    });
  } finally {
    await client.shutdown();
  }
});
for (const failed of [false, true])
  test(`the bridge download keeps standalone_pushes ${failed ? 'from a failed login' : 'as null before any backend'} (#185)`, async () => {
    const { Eufy } = await import('../src/eufy.js');
    const f = fixture();
    Object.defineProperty(f.client, 'standalonePushStatus', { get: pushStatus, configurable: true });
    if (failed) f.client.discoverDevices = async () => ({ devices: [], relationships: [], issues: [] });
    else f.storage.read = async () => '{PRIVATE';
    const bridge = new Eufy(f.storage, 'mega', false, () => f.backend);
    try {
      assert.equal(bridge.supportReport().standalone_pushes, null, 'the setup report has no client');
      await assert.rejects(bridge.login({ username: 'fixture', password: 'fixture', country: 'NL' }));
      // A failed migration check caches the closed backend's report with its counts.
      assert.deepEqual(bridge.supportReport().standalone_pushes, failed ? pushReport : null);
    } finally {
      await bridge.close();
    }
  });
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
// Issue #175: the client refuses recordings on an experimental standalone owner
// with standalone_recordings_unverified. Its snapshot and live stay available.
test('standalone_recordings_unverified refuses every recording operation before the client and keeps live (#175)', async () => {
  const f = fixture(undefined, undefined, true);
  f.client.discoverDevices = async () => standaloneInventory(true);
  const homebase = f.client.getCameraCapabilities;
  const allowed = { available: true, status: 'experimental' as const, reason: null as string | null };
  const refused = { available: false, status: 'unsupported' as const, reason: 'standalone_recordings_unverified' };
  f.client.getCameraCapabilities = async (id: string) =>
    id === 'WALL' ? { snapshot: { ...allowed }, live: { ...allowed }, recordings: { ...refused } } : homebase(id);
  const call = (name: string) => async () => {
    f.calls.push(name);
    return { complete: true, returned: 0, recordings: [] };
  };
  Object.assign(f.client, {
    listRecordings: call('listRecordings'),
    recordingCalendar: call('recordingCalendar'),
    recordingThumbnail: call('recordingThumbnail'),
    downloadRecording: call('downloadRecording'),
  });
  try {
    await f.backend.login({ username: 'fixture', password: 'fixture', country: 'NL' });
    assert.deepEqual(f.backend.inventory().find((camera) => camera.serial === 'WALL')?.capabilities?.recordings, refused);
    const row = f.backend.supportReport().last_discovery.find((r) => r.event === 'device' && r.model === 'T84A1')!;
    assert.deepEqual((row.media as Record<string, unknown>).recordings, refused);
    assert.equal(f.backend.canStartLive('WALL'), true);
    const abort = new AbortController();
    for (const operation of [
      () => f.backend.recordings.list('WALL', '2026-10-16', abort.signal),
      () => f.backend.recordings.calendar(['WALL'], '2026-10', abort.signal),
      () => f.backend.recordings.thumbnail('WALL', 'missing', abort.signal),
      () => f.backend.recordings.video('WALL', 'missing', abort.signal, async () => {}),
    ])
      await assert.rejects(operation(), { code: 'capability_unavailable', status: 503 });
    assert.deepEqual(f.calls, []);
    assert.equal(f.backend.recordings.metrics.queries, 0);
    assert.equal(f.backend.recordings.metrics.downloads, 0);
    assert.deepEqual(f.backend.supportReport().recent_events.filter((r) => r.event === 'recording_query'), []);
    // The HomeBase camera of the same account still reaches the client.
    await f.backend.recordings.list('CAM', '2026-10-16', abort.signal);
    assert.deepEqual(f.calls, ['listRecordings']);
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
test('a standalone connect that stops at session_open reports its key setup in the log line and the download (#142)', async t => {
  const {Eufy}=await import('../src/eufy.js');
  const {logDiscoveryDiagnostic}=await import('../src/backend-log.js');
  const f = fixture(undefined, undefined, true);
  const options = new Map<string, any>();
  const connect = f.client.connectStation;
  f.client.connectStation = async (id: string, value?: any) => {
    options.set(id, value);
    if (id === 'BASE') return connect();
    value?.onProgress?.({ stage: 'lookup', elapsedMs: 0, inventoryAddress: true });
    value?.onProgress?.({ stage: 'station_found', elapsedMs: 120 });
    value?.onProgress?.({ stage: 'session_open', elapsedMs: 180 });
    value?.onLookup?.({ ...lookupSeen, rounds: 1, datagrams: 1, ownReplies: 1, ownRound: 0, inventoryReply: 'own' });
    value?.onKeySetup?.({
      requestSends: 199, requestAcknowledged: false, resultWaitExpired: false, answers: 0,
      dataDatagrams: 0, otherMessages: 0, heartbeats: 4, ended: false, key: 'PRIVATE_KEY',
    });
    throw new EufyError('device_request_timeout');
  };
  f.client.discoverDevices = async () => standaloneInventory(true);
  const bridge = new Eufy(f.storage, 'mega', false, () => f.backend);
  const output = t.mock.method(console, 'info', () => {});
  bridge.on('discovery_diagnostic', logDiscoveryDiagnostic);
  try {
    await bridge.login({ username: 'fixture', password: 'fixture', country: 'NL' });
    for (const id of ['BASE', 'WALL']) assert.equal(typeof options.get(id)?.onKeySetup, 'function', id);
    const download = bridge.supportReport().recent_events.filter((r) => r.event === 'station_connection');
    const wall = download.find((r) => r.model === 'T84A1')!;
    assert.deepEqual([wall.phase, wall.status, wall.stage, wall.reason], ['connect', 'error', 'session_open', 'device_request_timeout']);
    assert.deepEqual(
      [wall.session_open_ms, wall.key_request_sends, wall.key_request_acknowledged, wall.key_result_wait_expired,
        wall.key_answers, wall.key_data_datagrams, wall.key_other_messages, wall.key_heartbeats, wall.key_ended],
      [180, 199, false, false, 0, 0, 0, 4, false],
    );
    const logged = output.mock.calls
      .filter((call) => call.arguments[0] === 'Eufy discovery:')
      .map((call) => JSON.parse(call.arguments[1] as string))
      .filter((r) => r.event === 'station_connection');
    assert.deepEqual(logged, download);
    assert.doesNotMatch(JSON.stringify(bridge.supportReport()) + JSON.stringify(output.mock.calls), /PRIVATE|WALL|BASE/);
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
      value?.onKeySetup?.({
        requestSends: 0, requestAcknowledged: false, resultWaitExpired: false, answers: 0,
        dataDatagrams: 0, otherMessages: 0, heartbeats: 0, ended: false,
      });
      throw new EufyError('device_request_timeout');
    };
    f.client.emit('station', { id: 'BASE', connected: false });
    await (f.backend as unknown as { refresh(): Promise<void> }).refresh();
    assert.equal(typeof options?.onLookup, 'function');
    assert.equal(typeof options?.onKeySetup, 'function');
    const failure = f.backend.supportReport().recent_events.filter((r) => r.event === 'station_connection').at(-1)!;
    assert.deepEqual([failure.phase, failure.status, failure.stage], ['connect', 'error', 'lookup']);
    assert.deepEqual([failure.lookup_rounds, failure.lookup_broadcast_enabled], [0, false]);
    assert.deepEqual([failure.key_request_sends, failure.key_request_acknowledged], [0, false]);
    // A successful idle reconnect reports its lookup on the refresh_state record.
    f.client.connectStation = async (_id: string, value?: any) => {
      value?.onLookup?.({ ...lookupSeen, rounds: 1, datagrams: 1, ownReplies: 1, ownRound: 0, inventoryReply: 'own' });
      return connect();
    };
    await (f.backend as unknown as { refresh(): Promise<void> }).refresh();
    const restored = f.backend.supportReport().recent_events.filter((r) => r.event === 'station_connection').at(-1)!;
    assert.deepEqual([restored.phase, restored.status, restored.stage], ['refresh_state', 'connected', undefined]);
    assert.deepEqual([restored.lookup_rounds, restored.lookup_own_replies, restored.lookup_inventory_reply], [1, 1, 'own']);
    // A refresh_state failure after a successful idle connect carries that connect's lookup.
    const refreshState = f.client.refreshStationState;
    f.client.refreshStationState = async () => { throw new EufyError('device_request_timeout'); };
    f.client.emit('station', { id: 'BASE', connected: false });
    await (f.backend as unknown as { refresh(): Promise<void> }).refresh();
    f.client.refreshStationState = refreshState;
    const refreshFailure = f.backend.supportReport().recent_events.filter((r) => r.event === 'station_connection').at(-1)!;
    assert.deepEqual([refreshFailure.phase, refreshFailure.status, refreshFailure.stage], ['refresh_state', 'error', undefined]);
    assert.deepEqual([refreshFailure.lookup_rounds, refreshFailure.lookup_own_replies, refreshFailure.lookup_inventory_reply], [1, 1, 'own']);
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

// The T8410 rows mirror ha-eufy-cam#152, the T8410C row #168 and the T8424 row
// keesmod/eufy-mega-client#142: standalone cameras without a HomeBase.
for (const enabled of [true, false])
  test(`raw standalone T84A1, T8410, T8410C and T8424 rows through the shipped client ${enabled ? 'each connect and report presence only' : 'stay unverified'}`, async () => {
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
      rawStandalone('PAN_C', '', 'T8410C', 31, '3.3.4.4', '192.168.1.43'),
      rawStandalone('FLOOD', '', 'T8424', 39, '2.1.1.5', '192.168.1.44'),
    ];
    // The installed library's discovery, with only the cloud boundary synthetic.
    const actual = Object.assign(Object.create(EufyMegaClient.prototype), {
      experimentalStandalone: enabled,
      cloud: { call: async () => ({ devices: rows }) },
    }) as EufyMegaClient;
    f.client.discoverDevices = () => actual.discoverDevices();
    try {
      assert.equal((await f.backend.login({ username: 'fixture', password: 'fixture', country: 'NL' })).state, 'connected');
      assert.deepEqual([...connected].sort(), enabled ? ['BASE', 'FLOOD', 'PAN_A', 'PAN_B', 'PAN_C', 'WALL'] : ['BASE']);
      const report = f.backend.supportReport();
      const wall = report.last_discovery.filter((r) => r.event === 'device' && r.model === 'T84A1');
      const pans = report.last_discovery.filter((r) => r.event === 'device' && r.model === 'T8410');
      assert.equal(wall.length, 1);
      assert.equal(pans.length, 2);
      assert.deepEqual(pans.map((r) => r.firmware).sort(), ['2.3.1.6', '2.3.2.4']);
      const pansC = report.last_discovery.filter((r) => r.event === 'device' && r.model === 'T8410C');
      assert.equal(pansC.length, 1);
      assert.equal(pansC[0]!.firmware, '3.3.4.4');
      const flood = report.last_discovery.filter((r) => r.event === 'device' && r.model === 'T8424');
      assert.equal(flood.length, 1);
      assert.equal(flood[0]!.firmware, '2.1.1.5');
      for (const row of [...wall, ...pans, ...pansC, ...flood]) {
        assert.equal(row.relationship_transport, enabled ? 'experimental' : null);
        assert.equal(row.relationship_reason, enabled ? null : 'standalone_transport_unverified');
        assert.equal(row.owner_status, enabled ? 'connected' : 'not_applicable');
        assert.deepEqual(row.descriptor, { did: true, license: true, admin_user: true, lan_address: true });
      }
      assert.doesNotMatch(JSON.stringify(report), /PRIVATE|192\.168\.1\.4[0-4]|WALL|BASE|PAN_|FLOOD/);
      // Admitted models are never named, and with the option off nothing is (#154).
      assert.deepEqual(events, []);
      assert.equal(report.last_discovery[0]!.experimental_standalone, enabled);
    } finally {
      await f.backend.close();
    }
  });

// #149, #168: raw rows go through the installed client, so a pin without the T8160-C
// and T8410C admissions, or without the standalone T8410C route, fails here even when
// its version string matches the notes.
for (const enabled of [true, false])
  test(`raw T8160-C, T8410C and T8410 rows through the shipped client with the opt-in ${enabled ? 'on' : 'off'} (#149, #152, #168)`, async () => {
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
      assert.deepEqual([...connected].sort(), enabled ? ['BASE', 'SOLO', 'SOLO_C'] : ['BASE']);
      // Without the opt-in the standalone T8410C and T8410 stay unverified. With it both connect.
      assert.deepEqual(faults, enabled ? [] : [['standalone_transport_unverified']]);
      // The client admits both, so neither is named as not admitted (#154, #168).
      assert.deepEqual(events, []);
      const report = f.backend.supportReport();
      assert.equal(report.last_discovery[0]!.experimental_standalone, enabled);
      const cameras = report.last_discovery
        .filter((r) => r.event === 'device' && r.model !== 'T8030')
        .map((r) => [r.model, r.relationship, r.relationship_reason, r.relationship_transport, r.owner_status]);
      const standalone = enabled ? ['standalone', null, 'experimental', 'connected'] : unverified;
      assert.deepEqual(cameras, [
        ['T8160-C', 'station', null, null, 'connected'],
        ['T8410C', 'station', null, null, 'connected'],
        // A standalone T8410C takes the experimental route like the T8410 (#168).
        ['T8410C', ...standalone],
        ['T8410', ...standalone],
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
      const notAdmitted = ['T8400', 'T8400'];
      assert.deepEqual(events, enabled ? notAdmitted : []);
      assert.deepEqual([...connected].sort(), enabled ? ['BASE', 'PAN', 'SOLO_C', 'WALL'] : ['BASE']);
      const report = f.backend.supportReport();
      assert.equal(report.last_discovery[0]!.experimental_standalone, enabled);
      const standalone = report.last_discovery
        .filter((r) => r.event === 'device' && ['T8410C', 'T8400'].includes(r.model as string))
        .map((r) => [r.model, r.relationship, r.relationship_reason, r.relationship_transport, r.owner_status]);
      const unverified = ['standalone', 'standalone_transport_unverified', null, 'not_applicable'];
      // Since #168 the standalone T8410C takes the experimental route with the opt-in.
      const t8410c = enabled ? ['standalone', null, 'experimental', 'connected'] : unverified;
      assert.deepEqual(standalone, [['T8410C', ...t8410c], ['T8400', ...unverified], ['T8400', ...unverified]]);
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
    rawStandalone('SOLO', '', 'T8400', 30, '2.1.6.4', '192.168.1.42'),
  ];
  const actual = Object.assign(Object.create(EufyMegaClient.prototype), {
    experimentalStandalone: true,
    cloud: { call: async () => ({ devices: rows }) },
  }) as EufyMegaClient;
  f.client.discoverDevices = () => actual.discoverDevices();
  try {
    await assert.rejects(f.backend.login({ username: 'fixture', password: 'fixture', country: 'NL' }), /expected_devices_missing/);
    assert.deepEqual(order, ['T8400', 'baseline']);
    const summary = f.backend.supportReport().last_discovery[0]!;
    assert.equal(summary.outcome, 'expected_devices_missing');
    assert.equal(summary.experimental_standalone, true);
    assert.doesNotMatch(JSON.stringify(f.backend.supportReport()), /PRIVATE|192\.168\.|SOLO/);
  } finally {
    await f.backend.close();
  }
});

// Recording operation observations of client 0.30.1 reach a recording_query record (#152).
const silentPage = { limit: 100, elapsedMs: 15050, answered: false, ackCode: null, resultCode: null, rows: null };
const noRows = { own: 0, otherDevice: 0, stationMismatch: 0, invalidTime: 0, otherDay: 0, cipherId: 0 };
const observed = (change: Partial<RecordingObservation> = {}): RecordingObservation => ({
  operation: 'list', owner: 'standalone', sessionOpen: true, stage: 'query', code: null, remoteCode: null,
  elapsedMs: 15053, pages: [silentPage], unhandledReplies: 0, unhandledReason: null, unhandledResultCode: null,
  rowClasses: null, ...change,
});
const wallRecording = {
  id: 'PRIVATE_RECORDING', deviceId: 'WALL', stationId: 'WALL', start: '2026-10-15T10:00:00',
  end: '2026-10-15T10:00:10', bytes: 100, thumbnail: true,
};
type Operation = (options: RecordingOperationOptions) => Promise<unknown>;
/** An opted-in standalone T84A1 (WALL, ref 3) and a HomeBase (BASE, ref 1) with its camera. */
async function recordingBackend(operations: { list?: Operation; calendar?: Operation; thumbnail?: Operation; download?: Operation }) {
  const f = fixture(undefined, undefined, true);
  f.client.discoverDevices = async () => standaloneInventory(true);
  const options: RecordingOperationOptions[] = [];
  const call = (operation: Operation | undefined, value: unknown) => {
    const settings = value as RecordingOperationOptions;
    options.push(settings);
    return (operation ?? (async () => { throw new Error('unexpected call'); }))(settings);
  };
  Object.assign(f.client, {
    listRecordings: (_id: string, _day: string, _cameras: string[], value: unknown) => call(operations.list, value),
    recordingCalendar: (_id: string, _month: string, value: unknown) => call(operations.calendar, value),
    recordingThumbnail: (_id: string, value: unknown) => call(operations.thumbnail, value),
    downloadRecording: (_id: string, value: unknown) => call(operations.download, value),
  });
  await f.backend.login({ username: 'fixture', password: 'fixture', country: 'NL' });
  const queries = () => f.backend.supportReport().recent_events.filter((row) => row.event === 'recording_query');
  return { ...f, options, queries };
}
/** The client reports the operation, then fails like it. */
const fails = (observation: Partial<RecordingObservation>, error: unknown): Operation => async (options) => {
  options.onObservation?.(observed(observation));
  throw error;
};
const lookupFields = {
  lookup_rounds: 10, lookup_broadcast_targets: 1, lookup_broadcast_enabled: true, lookup_send_errors: 0,
  lookup_datagrams: 0, lookup_other_headers: 0, lookup_own_replies: 0, lookup_account_replies: 0,
  lookup_foreign_replies: 0, lookup_near_replies: 0, lookup_inventory_reply: 'none',
  inventory_address_on_subnet: true, inventory_address_shared: false,
};
const recordingFailures: [string, Operation, [string, number], Record<string, unknown> | null][] = [
  ['a silent device', fails({ code: 'device_request_timeout' }, new EufyError('device_request_timeout')),
    ['recording_unavailable', 503], { reason: 'device_request_timeout', query_stage: 'query', session_open: true,
      pages: 1, query_limit: 100, query_answered: false, ack_code: null, unhandled_replies: 0, query_rows: null }],
  ['a negative device ACK', fails({ code: 'device_request_timeout', pages: [{ ...silentPage, ackCode: -104 }] }, new EufyError('device_request_timeout')),
    ['recording_unavailable', 503], { reason: 'device_request_timeout', ack_code: -104, query_answered: false }],
  ['an answer without an inner command', fails({ code: 'device_request_timeout', pages: [{ ...silentPage, ackCode: 0 }],
    unhandledReplies: 1, unhandledReason: 'unknown_cmd', unhandledResultCode: -6006 }, new EufyError('device_request_timeout')),
    ['recording_unavailable', 503], { ack_code: 0, unhandled_replies: 1, unhandled_reason: 'unknown_cmd', unhandled_result_code: -6006 }],
  ['an unparsable answer', fails({ code: 'device_request_timeout', unhandledReplies: 1, unhandledReason: 'parse_error' }, new EufyError('device_request_timeout')),
    ['recording_unavailable', 503], { unhandled_replies: 1, unhandled_reason: 'parse_error', unhandled_result_code: null }],
  ['history_rejected with its mIntRet', fails({ code: 'history_rejected', remoteCode: -1100, stage: 'validate', elapsedMs: 1210,
    pages: [{ limit: 100, elapsedMs: 1200, answered: true, ackCode: 0, resultCode: -1100, rows: 0 }], rowClasses: noRows },
    new EufyError('history_rejected', -1100)),
    ['recording_unavailable', 503], { reason: 'history_rejected', result_code: -1100, query_stage: 'validate',
      query_answered: true, query_result_code: -1100, query_rows: 0, rows_own: 0, elapsed_ms: 1210 }],
  ['a session that closed during the query', fails({ code: 'device_disconnected', elapsedMs: 900 }, new EufyError('device_disconnected')),
    ['recording_unavailable', 503], { reason: 'device_disconnected', query_stage: 'query', session_open: true }],
  ['a busy owner', fails({ code: 'station_busy', stage: 'admission', pages: [], elapsedMs: 0 }, new EufyError('station_busy')),
    ['recording_unavailable', 503], { reason: 'station_busy', query_stage: 'admission', pages: 0, query_limit: 0, query_answered: false }],
  ['a connection already in flight', fails({ code: 'connection_busy', stage: 'connect', sessionOpen: false, pages: [], elapsedMs: 0 }, new EufyError('connection_busy')),
    ['recording_unavailable', 503], { reason: 'connection_busy', query_stage: 'connect', session_open: false, pages: 0 }],
  ['a connect that failed at its lookup', async (options) => {
    options.onProgress?.({ stage: 'lookup', elapsedMs: 0, inventoryAddress: true });
    options.onLookup?.({ rounds: 10, broadcastTargets: 1, broadcastEnabled: true, sendErrors: 0, datagrams: 0, otherHeaders: 0,
      ownReplies: 0, accountReplies: 0, foreignReplies: 0, nearReplies: 0, inventoryReply: 'none',
      inventoryAddressOnSubnet: true, inventoryAddressShared: false });
    options.onObservation?.(observed({ code: 'device_request_timeout', stage: 'connect', sessionOpen: false, pages: [], elapsedMs: 20012 }));
    throw new EufyError('device_request_timeout');
  }, ['recording_unavailable', 503], { reason: 'device_request_timeout', query_stage: 'connect', session_open: false,
    stage: 'lookup', inventory_address: true, ...lookupFields, elapsed_ms: 20012, pages: 0 }],
  ['a cancelled query', fails({ code: 'cancelled' }, new EufyError('cancelled')),
    ['recording_unavailable', 503], { reason: 'cancelled' }],
  ['an invalid recording row', fails({ code: 'invalid_recording', stage: 'validate', rowClasses: { ...noRows, stationMismatch: 1 } }, new EufyError('invalid_recording')),
    ['history_incomplete', 503], { reason: 'invalid_recording', rows_station_mismatch: 1, returned: 503 }],
  ['an error of the client that is no EufyError', fails({ code: 'unexpected_error' }, new TypeError('PRIVATE_TOKEN')),
    ['recording_unavailable', 503], { reason: 'unclassified_error' }],
  ['an error before the recording access', async () => { throw new EufyError('client_closed'); },
    ['recording_unavailable', 503], { reason: 'client_closed', query_stage: 'admission', session_open: null, pages: 0,
      query_limit: 0, result_code: null }],
  ['an unexpected error without an observation', async () => { throw new TypeError('PRIVATE_TOKEN'); },
    ['recording_unavailable', 503], { reason: 'unclassified_error', query_stage: 'admission' }],
  ['a full disk', async () => { throw Object.assign(new Error('/PRIVATE/path'), { code: 'ENOSPC' }); },
    ['recording_storage_unavailable', 503], null],
];
for (const [name, list, [code, status], expected] of recordingFailures)
  test(`a standalone list with ${name} answers ${code} ${status} unchanged and records ${expected ? 'it' : 'nothing'} (#152)`, async () => {
    const f = await recordingBackend({ list });
    try {
      await assert.rejects(f.backend.recordings.list('WALL', '2026-10-15', new AbortController().signal), { code, status });
      const rows = f.queries();
      if (expected === null) assert.deepEqual(rows, []);
      else {
        assert.equal(rows.length, 1);
        const row = rows[0]!;
        assert.deepEqual(Object.fromEntries(Object.keys(expected).map((key) => [key, row[key]])), expected);
        assert.deepEqual([row.device_ref, row.model, row.query, row.owner, row.status, row.returned], [3, 'T84A1', 'list', 'standalone', 'error', status]);
        assert.ok(Number.isInteger(row.elapsed_ms));
        // Only an operation that connected carries the connection stage and lookup.
        if (!('stage' in expected)) assert.equal('stage' in row, false);
      }
      assert.doesNotMatch(JSON.stringify(f.backend.supportReport()), /PRIVATE|WALL|BASE|CAM|fixture/);
    } finally {
      await f.backend.close();
    }
  });

test('each recording call gets the options form with the request signal and the observation callbacks (#152)', async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const f = await recordingBackend({
    list: async (options) => {
      release();
      await new Promise((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(new EufyError('cancelled')), { once: true }));
    },
  });
  try {
    const abort = new AbortController();
    const pending = assert.rejects(f.backend.recordings.list('WALL', '2026-10-15', abort.signal), { code: 'recording_unavailable', status: 503 });
    await waiting;
    const [options] = f.options;
    assert.ok(options?.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    for (const key of ['onObservation', 'onProgress', 'onLookup'] as const) assert.equal(typeof options[key], 'function', key);
    abort.abort();
    await pending;
    assert.equal(options.signal.aborted, true);
    // Without an observation from the client the cancelled failure is the bridge's own record.
    assert.deepEqual(f.queries().map((row) => [row.reason, row.query_stage]), [['cancelled', 'admission']]);
  } finally {
    await f.backend.close();
  }
});

test('standalone operations are recorded, HomeBase operations only when they fail, thumbnails only on failure (#152)', async () => {
  let fail = false;
  const f = await recordingBackend({
    list: async (options) => {
      options.onObservation?.(observed({ stage: 'validate', elapsedMs: 1840,
        pages: [{ limit: 100, elapsedMs: 1800, answered: true, ackCode: 0, resultCode: 0, rows: 12 }],
        rowClasses: { ...noRows, own: 9, otherDay: 3, cipherId: 9 } }));
      return { complete: true, returned: 12, recordings: [wallRecording] };
    },
    thumbnail: async (options) => {
      if (fail) return fails({ operation: 'thumbnail', code: 'device_request_timeout', pages: [] }, new EufyError('device_request_timeout'))(options);
      options.onObservation?.(observed({ operation: 'thumbnail', stage: 'query', pages: [] }));
      return Buffer.from('jpeg');
    },
  });
  try {
    const signal = new AbortController().signal;
    const listed = await f.backend.recordings.list('WALL', '2026-10-15', signal);
    assert.deepEqual(f.queries().map((row) => [row.device_ref, row.query, row.owner, row.status, row.returned,
      row.query_rows, row.rows_own, row.rows_other_day, row.rows_cipher_id]), [[3, 'list', 'standalone', 'completed', 200, 12, 9, 3, 9]]);
    // A HomeBase success is not recorded, its failure is.
    const base = f.client as unknown as { listRecordings: (...args: unknown[]) => Promise<unknown> };
    const standalone = base.listRecordings;
    base.listRecordings = async (...args: unknown[]) => {
      const options = args[3] as RecordingOperationOptions;
      options.onObservation?.(observed({ owner: 'station', stage: 'validate', pages: [{ ...silentPage, answered: true, ackCode: 0, resultCode: 0, rows: 0 }], rowClasses: noRows }));
      return { complete: true, returned: 0, recordings: [] };
    };
    await f.backend.recordings.list('CAM', '2026-10-15', signal);
    assert.equal(f.queries().length, 1);
    base.listRecordings = async (...args: unknown[]) => fails({ owner: 'station', code: 'device_request_timeout' }, new EufyError('device_request_timeout'))(args[3] as RecordingOperationOptions);
    await assert.rejects(f.backend.recordings.list('CAM', '2026-10-15', signal), { code: 'recording_unavailable', status: 503 });
    assert.deepEqual(f.queries().slice(-1).map((row) => [row.device_ref, row.model, row.owner, row.status, row.reason]),
      [[1, 'T8030', 'station', 'error', 'device_request_timeout']]);
    base.listRecordings = standalone;
    // A standalone thumbnail success is not recorded, its failure is.
    const id = listed.recordings[0]!.id;
    assert.equal((await f.backend.recordings.thumbnail('WALL', id, signal)).toString(), 'jpeg');
    assert.equal(f.queries().length, 2);
    fail = true;
    await assert.rejects(f.backend.recordings.thumbnail('WALL', id, signal), { code: 'recording_unavailable', status: 503 });
    assert.deepEqual(f.queries().slice(-1).map((row) => [row.query, row.owner, row.reason, row.pages]),
      [['thumbnail', 'standalone', 'device_request_timeout', 0]]);
    assert.doesNotMatch(JSON.stringify(f.backend.supportReport()), /PRIVATE|WALL|BASE|CAM/);
  } finally {
    await f.backend.close();
  }
});

test('a multi-owner timeline records the failed owner, and a disconnected client records every owner (#152)', async () => {
  const f = await recordingBackend({});
  const client = f.client as unknown as { connected: boolean; listRecordings: (...args: unknown[]) => Promise<unknown> };
  client.listRecordings = async (...args: unknown[]) => {
    const options = args[3] as RecordingOperationOptions;
    if (args[0] === 'BASE') {
      options.onObservation?.(observed({ owner: 'station', stage: 'validate', pages: [{ ...silentPage, answered: true, ackCode: 0, resultCode: 0, rows: 0 }], rowClasses: noRows }));
      return { complete: true, returned: 0, recordings: [] };
    }
    return fails({ code: 'device_request_timeout' }, new EufyError('device_request_timeout'))(options);
  };
  try {
    const signal = new AbortController().signal;
    await assert.rejects(f.backend.recordings.timeline(['CAM', 'WALL'], '2026-10-15', signal), { code: 'recording_unavailable', status: 503 });
    assert.deepEqual(f.queries().map((row) => [row.device_ref, row.owner, row.status, row.reason, row.returned]),
      [[3, 'standalone', 'error', 'device_request_timeout', 503]]);
    // The bridge refuses before any client call. Each owner gets a record of its own.
    client.connected = false;
    await assert.rejects(f.backend.recordings.timeline(['CAM', 'WALL'], '2026-10-15', signal), { code: 'recording_unavailable', status: 503 });
    await assert.rejects(f.backend.recordings.calendar(['WALL'], '2026-10', signal), { code: 'recording_unavailable', status: 503 });
    assert.deepEqual(f.queries().slice(1).map((row) => [row.device_ref, row.query, row.owner, row.reason, row.query_stage, row.session_open, row.returned]), [
      [1, 'list', 'station', 'client_disconnected', 'admission', null, 503],
      [3, 'list', 'standalone', 'client_disconnected', 'admission', null, 503],
      [3, 'calendar', 'standalone', 'client_disconnected', 'admission', null, 503],
    ]);
    // A bridge refusal with its own answer is not a recording_query record.
    client.connected = true;
    const busy = await recordingBackend({});
    try {
      (busy.backend.recordings as unknown as { liveBusy: () => string }).liveBusy = () => 'live_busy';
      await assert.rejects(busy.backend.recordings.list('WALL', '2026-10-15', signal), { code: 'live_busy', status: 409 });
      assert.deepEqual(busy.queries(), []);
    } finally {
      await busy.backend.close();
    }
  } finally {
    await f.backend.close();
  }
});

test('a standalone download refusal is recorded with its cause on the record and the playback attempt (#152)', async () => {
  const f = await recordingBackend({
    list: async (options) => {
      options.onObservation?.(observed({ stage: 'validate', pages: [{ ...silentPage, answered: true, ackCode: 0, resultCode: 0, rows: 1 }], rowClasses: { ...noRows, own: 1, cipherId: 1 } }));
      return { complete: true, returned: 1, recordings: [wallRecording] };
    },
    download: fails({ operation: 'download', code: 'recording_cipher_unavailable', stage: 'admission', pages: [], elapsedMs: 0 }, new EufyError('recording_cipher_unavailable')),
  });
  try {
    const signal = new AbortController().signal;
    const id = (await f.backend.recordings.list('WALL', '2026-10-15', signal)).recordings[0]!.id;
    await assert.rejects(f.backend.recordings.video('WALL', id, signal, async () => assert.fail('no output')), { code: 'recording_unavailable', status: 503 });
    assert.deepEqual(f.queries().map((row) => [row.query, row.status, row.reason, row.query_stage, row.rows_cipher_id]), [
      ['list', 'completed', null, 'validate', 1],
      ['download', 'error', 'recording_cipher_unavailable', 'admission', 0],
    ]);
    const attempt = f.backend.supportReport().recording.attempts.at(-1)!;
    assert.deepEqual([attempt.outcome, attempt.stage, attempt.error, attempt.cause, attempt.result_code],
      ['failed', 'download', 'recording_unavailable', 'recording_cipher_unavailable', null]);
  } finally {
    await f.backend.close();
  }
});

test('an incomplete standalone transfer keeps its reason as the attempt cause (#152)', async () => {
  const f = await recordingBackend({
    list: async (options) => {
      options.onObservation?.(observed({ stage: 'validate', pages: [{ ...silentPage, answered: true, ackCode: 0, resultCode: 0, rows: 1 }], rowClasses: { ...noRows, own: 1 } }));
      return { complete: true, returned: 1, recordings: [wallRecording] };
    },
    download: async (options) => {
      options.onObservation?.(observed({ operation: 'download', stage: 'transfer', pages: [], elapsedMs: 0 }));
      return {
        video: Readable.from([]),
        audio: Readable.from([]),
        metadata: { videoCodec: 'h264' },
        completed: Promise.resolve({ complete: false, bytes: 0, reason: 'rejected', stopConfirmed: true }),
        cancel: async () => {},
      };
    },
  });
  try {
    const signal = new AbortController().signal;
    const id = (await f.backend.recordings.list('WALL', '2026-10-15', signal)).recordings[0]!.id;
    await assert.rejects(f.backend.recordings.video('WALL', id, signal, async () => assert.fail('no output')), { code: 'recording_unavailable', status: 503 });
    const attempt = f.backend.supportReport().recording.attempts.at(-1)!;
    assert.deepEqual([attempt.outcome, attempt.stage, attempt.error, attempt.cause, attempt.result_code],
      ['failed', 'download', 'recording_unavailable', 'transfer_rejected', null]);
    // The download record reports the started transfer, as the client observed it.
    assert.deepEqual(f.queries().map((row) => [row.query, row.status, row.reason]), [
      ['list', 'completed', null],
      ['download', 'completed', null],
    ]);
  } finally {
    await f.backend.close();
  }
});

test('recording_query records reach the Eufy discovery: log line as in the download (#152)', async (t) => {
  const { Eufy } = await import('../src/eufy.js');
  const { logDiscoveryDiagnostic } = await import('../src/backend-log.js');
  const f = fixture(undefined, undefined, true);
  f.client.discoverDevices = async () => standaloneInventory(true);
  Object.assign(f.client, {
    listRecordings: (_id: string, _day: string, _cameras: string[], options: RecordingOperationOptions) =>
      fails({ code: 'device_request_timeout', pages: [{ ...silentPage, ackCode: -104 }] }, new EufyError('device_request_timeout'))(options),
  });
  const bridge = new Eufy(f.storage, 'mega', false, () => f.backend);
  const output = t.mock.method(console, 'info', () => {});
  bridge.on('discovery_diagnostic', logDiscoveryDiagnostic);
  try {
    await bridge.login({ username: 'fixture', password: 'fixture', country: 'NL' });
    await assert.rejects(bridge.recordings.list('WALL', '2026-10-15', new AbortController().signal), { code: 'recording_unavailable', status: 503 });
    const download = bridge.supportReport().recent_events.filter((row) => row.event === 'recording_query');
    const logged = output.mock.calls
      .filter((call) => call.arguments[0] === 'Eufy discovery:')
      .map((call) => JSON.parse(call.arguments[1] as string))
      .filter((row) => row.event === 'recording_query');
    assert.equal(download.length, 1);
    assert.deepEqual(logged, download);
    assert.equal(download[0]!.ack_code, -104);
    assert.doesNotMatch(JSON.stringify(output.mock.calls), /PRIVATE|WALL|BASE|CAM|fixture/);
  } finally {
    await bridge.close();
  }
});

// Issue #178: the opt-in standalone recording probe of the login discovery.
const login = { username: 'fixture', password: 'fixture', country: 'NL' };
const probeQueries = (backend: MegaBackend) =>
  backend.supportReport().recent_events.filter((row) => row.event === 'recording_query' && row.query === 'probe');
const solo: Device = { ...wallLight, id: 'SOLO', stationId: 'SOLO', model: 'T8410', name: 'Indoor', firmware: '2.3.2.4' };
/** The HomeBase, its camera, WALL and optionally SOLO, both experimental standalone owners. */
function probeInventory(second = false): DiscoveryResult {
  const value = standaloneInventory(true);
  if (second) {
    value.devices.push(solo);
    value.relationships.push({ deviceId: 'SOLO', kind: 'standalone', ownerId: 'SOLO', transport: 'experimental', descriptor });
  }
  return value;
}
/** A probe fixture that logs each connect, state refresh and probe in order. */
function probeFixture(probe: boolean | undefined, inventory = probeInventory()) {
  const f = fixture(undefined, undefined, true, probe);
  const order: string[] = [];
  f.client.discoverDevices = async () => inventory;
  const connect = f.client.connectStation;
  f.client.connectStation = async (id: string) => {
    order.push(`connect ${id}`);
    return connect();
  };
  const refresh = f.client.refreshStationState;
  f.client.refreshStationState = async (id?: string) => {
    order.push(`refresh_state ${id}`);
    return refresh();
  };
  const probeCall = f.client.probeStandaloneRecordings;
  f.client.probeStandaloneRecordings = async (id: string, options?: unknown) => {
    order.push(`probe ${id}`);
    return probeCall(id, options);
  };
  return { ...f, order };
}
test('EUFY_STANDALONE_RECORDING_PROBE accepts only true or false and defaults to off (#178)', () => {
  assert.equal(standaloneRecordingProbe(undefined), false);
  assert.equal(standaloneRecordingProbe(''), false);
  assert.equal(standaloneRecordingProbe(' '), false);
  assert.equal(standaloneRecordingProbe('false'), false);
  assert.equal(standaloneRecordingProbe('true'), true);
  assert.equal(standaloneRecordingProbe(' true '), true);
  for (const bad of ['TRUE', 'True', 'yes', '1', 'on', 'truee', 'false,true'])
    assert.throws(() => standaloneRecordingProbe(bad), /EUFY_STANDALONE_RECORDING_PROBE must be true or false/, bad);
  // The startup line says when the option is on, and that it does nothing without the standalone option.
  assert.equal(recordingProbeNotice(false, true), undefined);
  assert.equal(recordingProbeNotice(false, false), undefined);
  assert.match(recordingProbeNotice(true, true)!, /^Eufy standalone recording probe enabled: .*read-only.*15 seconds/);
  assert.match(recordingProbeNotice(true, false)!, /no effect.*nothing is probed.*EUFY_EXPERIMENTAL_STANDALONE=true/);
});
for (const probe of [undefined, false])
  test(`with the probe option ${String(probe)} discovery sends no probe and the summary says false (#178)`, async () => {
    const f = probeFixture(probe);
    try {
      assert.deepEqual(await f.backend.login(login), { state: 'connected' });
      assert.equal(f.backend.standaloneRecordingProbe, false);
      assert.deepEqual(f.probes, []);
      assert.deepEqual(f.order, ['connect BASE', 'refresh_state BASE', 'connect WALL']);
      assert.deepEqual(probeQueries(f.backend), []);
      assert.equal(f.backend.supportReport().last_discovery[0]!.standalone_recording_probe, false);
    } finally {
      await f.backend.close();
    }
  });
test('the login discovery probes a standalone camera once after its connect, HomeBase requests unchanged (#178)', async () => {
  const off = probeFixture(false);
  const f = probeFixture(true);
  const faults: string[] = [];
  f.backend.on('backend_fault', (code) => faults.push(code));
  const lines: string[] = [];
  f.backend.on('discovery_diagnostic', (line) => lines.push(line));
  const homebase = f.client.getCameraCapabilities;
  const allowed = { available: true, status: 'experimental' as const, reason: null as string | null };
  const refused = { available: false, status: 'unsupported' as const, reason: 'standalone_recordings_unverified' };
  for (const g of [off, f])
    g.client.getCameraCapabilities = async (id: string) =>
      id === 'WALL' ? { snapshot: { ...allowed }, live: { ...allowed }, recordings: { ...refused } } : homebase(id);
  const call = (name: string) => async () => {
    f.calls.push(name);
    return { complete: true, returned: 0, recordings: [] };
  };
  Object.assign(f.client, {
    listRecordings: call('listRecordings'),
    recordingCalendar: call('recordingCalendar'),
    recordingThumbnail: call('recordingThumbnail'),
    downloadRecording: call('downloadRecording'),
  });
  try {
    await off.backend.login(login);
    assert.deepEqual(await f.backend.login(login), { state: 'connected' });
    assert.equal(f.backend.standaloneRecordingProbe, true);
    // One probe, right after the camera's own connect. The HomeBase calls are those of a run without it.
    assert.deepEqual(f.order, ['connect BASE', 'refresh_state BASE', 'connect WALL', 'probe WALL']);
    assert.deepEqual(f.order.filter((entry) => !entry.startsWith('probe')), off.order);
    // Only the connection callbacks reach the client. Its own bounds apply, so the bridge passes no signal.
    assert.equal(f.probes.length, 1);
    assert.equal(f.probes[0]!.id, 'WALL');
    const options = f.probes[0]!.options as Record<string, unknown>;
    assert.deepEqual(Object.keys(options).sort(), ['onLookup', 'onProgress']);
    assert.equal(typeof options.onProgress, 'function');
    assert.equal(typeof options.onLookup, 'function');
    const report = f.backend.supportReport();
    const [record, ...more] = probeQueries(f.backend);
    assert.deepEqual(more, []);
    const summary = report.last_discovery[0]!;
    assert.equal(summary.standalone_recording_probe, true);
    assert.equal(summary.experimental_standalone, true);
    assert.deepEqual(
      [record!.report, record!.device_ref, record!.model, record!.owner, record!.status, record!.reason, record!.query_stage],
      [summary.report, 3, 'T84A1', 'standalone', 'completed', null, 'validate'],
    );
    assert.deepEqual([record!.pages, record!.query_limit, record!.query_answered, record!.query_rows, record!.returned], [1, 20, true, 0, null]);
    assert.equal('stage' in record!, false);
    // The record and the summary field reach the log lines. No ID, serial or name leaves the bridge.
    const logged = lines.map((line) => JSON.parse(line));
    assert.deepEqual(logged.filter((row) => row.query === 'probe'), [record]);
    assert.equal(logged.find((row) => row.event === 'summary').standalone_recording_probe, true);
    assert.doesNotMatch(lines.join('\n') + JSON.stringify(report), /WALL|BASE|CAM|Wall light|HomeBase|Camera/);
    assert.deepEqual(faults, []);
    // Recordings stay unavailable on the standalone camera, and its HTTP operations never reach the client.
    assert.deepEqual(f.backend.inventory().find((camera) => camera.serial === 'WALL')?.capabilities?.recordings, refused);
    const abort = new AbortController();
    for (const operation of [
      () => f.backend.recordings.list('WALL', '2026-10-16', abort.signal),
      () => f.backend.recordings.calendar(['WALL'], '2026-10', abort.signal),
      () => f.backend.recordings.thumbnail('WALL', 'missing', abort.signal),
      () => f.backend.recordings.video('WALL', 'missing', abort.signal, async () => {}),
    ])
      await assert.rejects(operation(), { code: 'capability_unavailable', status: 503 });
    assert.deepEqual(f.calls, []);
    assert.equal(f.backend.recordings.metrics.queries, 0);
    assert.equal(f.backend.canStartLive('WALL'), true);
  } finally {
    await off.backend.close();
    await f.backend.close();
  }
});
test('each standalone owner is probed once in its own turn, a HomeBase-only inventory never (#178)', async () => {
  const f = probeFixture(true, probeInventory(true));
  const homebase = probeFixture(true, { devices, relationships: [
    { deviceId: 'BASE', kind: 'station', ownerId: 'BASE' },
    { deviceId: 'CAM', kind: 'station', ownerId: 'BASE' },
  ], issues: [] });
  try {
    await f.backend.login(login);
    assert.deepEqual(f.order, ['connect BASE', 'refresh_state BASE', 'connect WALL', 'probe WALL', 'connect SOLO', 'probe SOLO']);
    assert.deepEqual(probeQueries(f.backend).map((row) => [row.device_ref, row.model]), [[3, 'T84A1'], [4, 'T8410']]);
    await homebase.backend.login(login);
    assert.deepEqual(homebase.order, ['connect BASE', 'refresh_state BASE']);
    assert.deepEqual(homebase.probes, []);
    assert.equal(homebase.backend.supportReport().last_discovery[0]!.standalone_recording_probe, true);
  } finally {
    await f.backend.close();
    await homebase.backend.close();
  }
});
test('a failed standalone connect is not probed and the next camera still is (#178)', async () => {
  const f = probeFixture(true, probeInventory(true));
  const connect = f.client.connectStation;
  f.client.connectStation = async (id: string) => {
    if (id === 'WALL') {
      f.order.push('connect WALL failed');
      throw new EufyError('device_request_timeout');
    }
    return connect(id);
  };
  try {
    assert.deepEqual(await f.backend.login(login), { state: 'connected' });
    assert.deepEqual(f.order, ['connect BASE', 'refresh_state BASE', 'connect WALL failed', 'connect SOLO', 'probe SOLO']);
    assert.deepEqual(probeQueries(f.backend).map((row) => row.model), ['T8410']);
  } finally {
    await f.backend.close();
  }
});
test('a discovery after a cloud reconnect never probes, a new login attempt probes again (#178)', async () => {
  const f = probeFixture(true);
  try {
    await f.backend.login(login);
    assert.deepEqual(f.probes.map((call) => call.id), ['WALL']);
    // The cloud session dropped. refresh() reconnects and runs discovery again while live view is allowed.
    f.client.connected = false;
    await (f.backend as unknown as { refresh(): Promise<void> }).refresh();
    assert.deepEqual(f.order.slice(4), ['connect BASE', 'refresh_state BASE', 'connect WALL']);
    assert.deepEqual(f.probes.map((call) => call.id), ['WALL']);
    const reports = f.backend.supportReport();
    assert.equal(reports.last_discovery[0]!.report, 2);
    assert.equal(reports.last_discovery[0]!.standalone_recording_probe, true);
    assert.equal(probeQueries(f.backend).length, 1);
  } finally {
    await f.backend.close();
  }
  // A login that failed after its discovery is retried on a new backend, which probes again.
  const g = probeFixture(true);
  g.client.startEvents = async () => {
    throw new EufyError('push_unavailable');
  };
  try {
    await assert.rejects(g.backend.login(login), { code: 'push_unavailable' });
    assert.deepEqual(g.probes.map((call) => call.id), ['WALL']);
  } finally {
    await g.backend.close();
  }
  g.client.startEvents = async () => {};
  const retry = new MegaBackend(g.storage, () => false, () => g.client as unknown as EufyMegaClient, undefined, undefined, undefined, true, true);
  try {
    assert.deepEqual(await retry.login(login), { state: 'connected' });
    assert.deepEqual(g.probes.map((call) => call.id), ['WALL', 'WALL']);
  } finally {
    await retry.close();
  }
});
test('a bridge closed during discovery sends no probe (#178)', async () => {
  const f = probeFixture(true);
  const connect = f.client.connectStation;
  let closing: Promise<void> | undefined;
  f.client.connectStation = async (id: string) => {
    if (id === 'WALL') closing = f.backend.close();
    return connect(id);
  };
  await assert.rejects(f.backend.login(login));
  await closing;
  assert.deepEqual(f.probes, []);
});
for (const [name, thrown, reason, remote] of [
  ['an out-of-scope refusal', new EufyError('operation_outside_hardware_scope'), 'operation_outside_hardware_scope', null],
  ['a client error with a remote code', new EufyError('client_closed', -7), 'client_closed', -7],
  ['an error that is no EufyError', new Error('PRIVATE WALL failure'), 'unclassified_error', null],
] as const)
  test(`a probe that throws ${name} is recorded and never fails login (#178)`, async () => {
    const f = probeFixture(true);
    const faults: string[] = [];
    f.backend.on('backend_fault', (code) => faults.push(code));
    f.client.probeStandaloneRecordings = async (id: string, options?: unknown) => {
      f.probes.push({ id, options });
      throw thrown;
    };
    try {
      assert.deepEqual(await f.backend.login(login), { state: 'connected' });
      assert.equal(f.backend.connected, true);
      const report = f.backend.supportReport();
      assert.equal(report.last_discovery[0]!.outcome, 'accepted');
      assert.equal(report.last_discovery.at(-1)!.event, 'end');
      const [record, ...more] = probeQueries(f.backend);
      assert.deepEqual(more, []);
      const { diagnostic: _d, schema: _s, timestamp: _t, elapsed_ms: elapsed, ...fields } = record!;
      assert.equal(typeof elapsed, 'number');
      assert.deepEqual(fields, {
        event: 'recording_query', report: 1, device_ref: 3, model: 'T84A1', query: 'probe', owner: 'standalone',
        status: 'error', reason, result_code: remote, session_open: null, query_stage: 'admission',
        pages: 0, query_limit: 0, query_answered: false, ack_code: null, query_result_code: null, query_rows: null,
        unhandled_replies: 0, unhandled_reason: null, unhandled_result_code: null, rows_own: 0,
        rows_other_device: 0, rows_station_mismatch: 0, rows_invalid_time: 0, rows_other_day: 0,
        rows_cipher_id: 0, returned: null,
      });
      assert.deepEqual(faults, []);
      assert.doesNotMatch(JSON.stringify(report), /PRIVATE|WALL/);
    } finally {
      await f.backend.close();
    }
  });
test('an unreadable probe observation or a throwing recorder never fails login (#178)', async () => {
  const f = probeFixture(true);
  // Not thenable, so the promise resolves with it. Every other property throws.
  f.client.probeStandaloneRecordings = async () =>
    new Proxy({}, { get: (_target, key) => { if (key === 'then') return undefined; throw new Error('PRIVATE_TOKEN'); } }) as RecordingObservation;
  try {
    assert.deepEqual(await f.backend.login(login), { state: 'connected' });
    assert.deepEqual(probeQueries(f.backend), []);
    assert.equal(f.backend.supportReport().last_discovery[0]!.standalone_recording_probe, true);
  } finally {
    await f.backend.close();
  }
  // Even a recorder that throws cannot fail the discovery or the login.
  const g = probeFixture(true);
  (g.backend as unknown as { discoveryDiagnostics: { recording: () => void } }).discoveryDiagnostics.recording = () => {
    throw new Error('PRIVATE_TOKEN');
  };
  try {
    assert.deepEqual(await g.backend.login(login), { state: 'connected' });
    assert.deepEqual(g.probes.map((call) => call.id), ['WALL']);
    assert.equal(g.backend.supportReport().last_discovery[0]!.outcome, 'accepted');
  } finally {
    await g.backend.close();
  }
});
test('a probe that had to connect carries that connection stage and lookup (#178)', async () => {
  const f = probeFixture(true);
  f.client.probeStandaloneRecordings = async (_id: string, options?: unknown) => {
    const callbacks = options as RecordingOperationOptions;
    callbacks.onProgress?.({ stage: 'lookup', elapsedMs: 0, inventoryAddress: true });
    callbacks.onLookup?.({ ...lookupSeen, rounds: 10, broadcastTargets: 1 });
    return probeAnswer({ sessionOpen: false, stage: 'connect', code: 'device_request_timeout', elapsedMs: 20012, pages: [], rowClasses: null });
  };
  try {
    await f.backend.login(login);
    const [record] = probeQueries(f.backend);
    assert.deepEqual(
      [record!.status, record!.reason, record!.session_open, record!.query_stage, record!.stage, record!.inventory_address],
      ['error', 'device_request_timeout', false, 'connect', 'lookup', true],
    );
    assert.deepEqual([record!.lookup_rounds, record!.lookup_broadcast_targets, record!.pages, record!.query_limit, record!.returned], [10, 1, 0, 0, null]);
  } finally {
    await f.backend.close();
  }
});
test('the device row reports the session the client last observed, closed after a silent probe (#178)', async () => {
  const session = { id: 'WALL', connected: true, guardMode: null, currentMode: null, alarm: false, alarmDelay: 0, armDelay: 0, commandEncryption: 'lan-derived' as const };
  for (const silent of [false, true]) {
    const f = probeFixture(true);
    const connect = f.client.connectStation;
    f.client.connectStation = async (id: string, value?: any) => {
      if (id !== 'WALL') return connect(id);
      // Like the library, the session reports itself before the connect resolves,
      // and the connect record carries the attempt's lookup.
      value?.onLookup?.({ ...lookupSeen, rounds: 1, datagrams: 1, ownReplies: 1, ownRound: 0, inventoryReply: 'own' });
      f.client.emit('station', session);
      return session;
    };
    f.client.probeStandaloneRecordings = async () => {
      if (!silent) return probeAnswer();
      // The client closes the session of a probe without an answer before it resolves.
      f.client.emit('station', { ...session, connected: false, commandEncryption: null });
      return probeAnswer({ stage: 'query', code: 'device_request_timeout', elapsedMs: 15031,
        pages: [{ limit: 20, elapsedMs: 15030, answered: false, ackCode: 0, resultCode: null, rows: null }], rowClasses: null });
    };
    try {
      await f.backend.login(login);
      const report = f.backend.supportReport();
      const timeline = report.recent_events
        .filter((row) => row.device_ref === 3)
        .map((row) => [row.event, row.phase ?? row.query, row.status]);
      assert.deepEqual(timeline, [
        ['station_connection', 'observation', 'connected'],
        ['station_connection', 'connect', 'connected'],
        ...(silent ? [['station_connection', 'observation', 'disconnected']] : []),
        ['recording_query', 'probe', silent ? 'error' : 'completed'],
      ]);
      const row = report.last_discovery.find((r) => r.event === 'device' && r.model === 'T84A1')!;
      assert.deepEqual([row.owner_status, row.owner_connected], silent ? ['disconnected', false] : ['connected', true]);
    } finally {
      await f.backend.close();
    }
  }
});
// The probe rows of the fixture shared with the HA download tests.
type FixtureRow = Record<string, any>;
const sharedProbeRows = Object.entries((JSON.parse(readFileSync(
  new URL('../../tests/fixtures/recording-query.json', import.meta.url), 'utf8',
)) as { rows: Record<string, FixtureRow> }).rows).filter(([, row]) => row.query === 'probe');
test('each shared probe fixture row is what the bridge logs and keeps for its observation (#178)', async (t) => {
  const { Eufy } = await import('../src/eufy.js');
  const { logDiscoveryDiagnostic } = await import('../src/backend-log.js');
  assert.ok(sharedProbeRows.length >= 2);
  for (const [name, row] of sharedProbeRows) {
    // A probe sends one page. The fixture row stands for that observation without a connect.
    assert.equal(row.pages, 1, name);
    const observation: RecordingObservation = {
      operation: 'probe', owner: row.owner, sessionOpen: row.session_open, stage: row.query_stage, code: row.reason,
      remoteCode: row.result_code, elapsedMs: row.elapsed_ms,
      pages: [{ limit: row.query_limit, elapsedMs: row.elapsed_ms, answered: row.query_answered, ackCode: row.ack_code,
        resultCode: row.query_result_code, rows: row.query_rows }],
      unhandledReplies: row.unhandled_replies, unhandledReason: row.unhandled_reason,
      unhandledResultCode: row.unhandled_result_code,
      rowClasses: row.query_rows === null ? null : {
        own: row.rows_own, otherDevice: row.rows_other_device, stationMismatch: row.rows_station_mismatch,
        invalidTime: row.rows_invalid_time, otherDay: row.rows_other_day, cipherId: row.rows_cipher_id,
      },
    };
    const f = probeFixture(true);
    f.client.probeStandaloneRecordings = async () => observation;
    const bridge = new Eufy(f.storage, 'mega', false, () => f.backend);
    const output = t.mock.method(console, 'info', () => {});
    bridge.on('discovery_diagnostic', logDiscoveryDiagnostic);
    try {
      await bridge.login(login);
      const download = bridge.supportReport().recent_events.filter((r) => r.event === 'recording_query');
      const logged = output.mock.calls
        .filter((call) => call.arguments[0] === 'Eufy discovery:')
        .map((call) => JSON.parse(call.arguments[1] as string))
        .filter((r) => r.event === 'recording_query');
      assert.equal(download.length, 1, name);
      assert.deepEqual(logged, download, name);
      const { diagnostic: _d, schema: _s, timestamp: _t, ...fields } = download[0]!;
      // Only the report, reference and model of this inventory differ from the fixture.
      const expected = { ...row, report: 1, device_ref: 3, model: 'T84A1' };
      assert.deepEqual(fields, expected, name);
      assert.deepEqual(Object.keys(fields), Object.keys(expected), name);
      assert.doesNotMatch(JSON.stringify(output.mock.calls), /PRIVATE|WALL|BASE|CAM|fixture/);
    } finally {
      output.mock.restore();
      await bridge.close();
    }
  }
});

const presetLogin = { username: 'fixture', password: 'fixture', country: 'NL' };
const presetsAvailable = { available: true, status: 'experimental' as const, reason: null };
/** A fixture whose camera reports the given presets capability, or none like client 0.30.2 (#229). */
function presetFixture(presets?: { available: boolean; status: 'experimental' | 'unsupported'; reason: string | null }) {
  const f = fixture();
  const media = f.client.getCameraCapabilities;
  f.client.getCameraCapabilities = async (id: string) => ({ ...(await media(id)), ...(presets ? { presets } : {}) });
  return f;
}
test('a preset move reaches the client once with a 50-second signal and resolves on acceptance (#229)', async (t) => {
  const f = presetFixture(presetsAvailable);
  const timeouts: number[] = [];
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    timeouts.push(ms);
    return timeout(ms);
  });
  try {
    await assert.rejects(f.backend.presets.move('CAM', 0), { code: 'not_connected', status: 503 });
    await f.backend.login(presetLogin);
    // The client's capability reaches the inventory unchanged, so HA can gate on it.
    assert.deepEqual(f.backend.inventory()[0]?.capabilities?.presets, presetsAvailable);
    let changes = 0;
    f.backend.on('change', () => changes++);
    timeouts.length = 0;
    for (const preset of [0, 1, 2, 3]) await f.backend.presets.move('CAM', preset);
    assert.deepEqual(f.moves.map(({ id, preset }) => [id, preset]), [['CAM', 0], ['CAM', 1], ['CAM', 2], ['CAM', 3]]);
    assert.ok(f.moves.every(({ signal }) => signal instanceof AbortSignal && !signal.aborted));
    assert.deepEqual(timeouts, [50000, 50000, 50000, 50000]);
    assert.equal(changes, 4);
    assert.deepEqual(f.backend.presets.metrics, { commands: 4, accepted: 4, rejected: 0, unconfirmed: 0, refused: 0 });
  } finally {
    await f.backend.close();
  }
});
test('a preset move is refused before the client for an invalid preset, a camera without presets or no connection (#229)', async () => {
  for (const presets of [undefined, { available: false, status: 'unsupported' as const, reason: 'operation_outside_hardware_scope' }]) {
    const f = presetFixture(presets);
    try {
      await f.backend.login(presetLogin);
      let changes = 0;
      f.backend.on('change', () => changes++);
      for (const bad of [undefined, null, '1', 'PRESET_1', true, 1.5, -1, 4, Number.NaN, Infinity, [0], {}])
        await assert.rejects(f.backend.presets.move('CAM', bad), { code: 'invalid_preset', status: 400 }, String(bad));
      // A camera reported without presets, like by client 0.30.2, is unavailable, as are unknown serials and HomeBases.
      for (const serial of ['CAM', 'OTHER', 'BASE'])
        await assert.rejects(f.backend.presets.move(serial, 0), { code: 'capability_unavailable', status: 503 }, serial);
      f.client.connected = false;
      await assert.rejects(f.backend.presets.move('CAM', 0), { code: 'not_connected', status: 503 });
      assert.deepEqual(f.moves, []);
      assert.equal(changes, 0);
      assert.deepEqual(f.backend.presets.metrics, { commands: 0, accepted: 0, rejected: 0, unconfirmed: 0, refused: 0 });
    } finally {
      await f.backend.close();
    }
  }
});
test('a refreshed presets capability gates the next move without a client call (#229)', async () => {
  let presets = presetsAvailable as { available: boolean; status: 'experimental' | 'unsupported'; reason: string | null };
  const f = fixture();
  const media = f.client.getCameraCapabilities;
  f.client.getCameraCapabilities = async (id: string) => ({ ...(await media(id)), presets });
  try {
    await f.backend.login(presetLogin);
    await f.backend.presets.move('CAM', 1);
    presets = { available: false, status: 'unsupported', reason: 'camera_media_unverified' };
    // The device event refreshes the capability in the background.
    f.client.emit('device', devices[1]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.backend.inventory()[0]?.capabilities?.presets?.available, false);
    await assert.rejects(f.backend.presets.move('CAM', 1), { code: 'capability_unavailable' });
    assert.deepEqual(f.moves.map(({ preset }) => preset), [1]);
  } finally {
    await f.backend.close();
  }
});
test('every library failure of a preset move becomes a fixed code and is counted once (#229)', async () => {
  const f = presetFixture(presetsAvailable);
  try {
    await f.backend.login(presetLogin);
    let changes = 0;
    f.backend.on('change', () => changes++);
    const cases: [unknown, string, number][] = [
      [new EufyError('preset_move_unconfirmed', -133), 'preset_unconfirmed', 504],
      [new EufyError('preset_move_unconfirmed', -134), 'preset_unconfirmed', 504],
      [new EufyError('preset_move_unconfirmed'), 'preset_unconfirmed', 504],
      [new EufyError('preset_move_rejected', -1), 'preset_rejected', 502],
      [new EufyError('station_busy'), 'station_busy', 409],
      [new EufyError('connection_busy'), 'station_busy', 409],
      [new EufyError('operation_outside_hardware_scope'), 'capability_unavailable', 503],
      [new EufyError('camera_media_unverified'), 'capability_unavailable', 503],
      [new EufyError('unknown_camera'), 'capability_unavailable', 503],
      [new EufyError('invalid_preset'), 'invalid_preset', 400],
      [new EufyError('cancelled'), 'preset_not_sent', 503],
      [new EufyError('preset_move_failed'), 'preset_not_sent', 503],
      [new EufyError('connection_timeout'), 'preset_not_sent', 503],
      [new EufyError('unknown_station'), 'preset_not_sent', 503],
      // Whether an unclassified failure sent the move is unknown.
      [new Error('PRIVATE detail'), 'preset_unconfirmed', 504],
    ];
    let total = 0;
    for (const [failure, code, status] of cases) {
      const label = `${(failure as EufyError).code ?? 'Error'} -> ${code}`;
      let calls = 0;
      f.client.moveToPreset = async () => {
        calls++;
        total++;
        throw failure;
      };
      await assert.rejects(
        f.backend.presets.move('CAM', 3),
        (error: Error & { code?: string; status?: number }) =>
          error.code === code && error.status === status && error.message === code,
        label,
      );
      // The bridge never retries, also not after an unconfirmed or unclassified failure.
      assert.equal(calls, 1, label);
    }
    assert.equal(total, cases.length);
    assert.equal(changes, cases.length);
    assert.deepEqual(f.backend.presets.metrics, { commands: 15, accepted: 0, rejected: 1, unconfirmed: 4, refused: 10 });
  } finally {
    await f.backend.close();
  }
});
test('a preset move is refused before the client while the hub holds an unconfirmed stop or recovers the HomeBase (#229)', async (t) => {
  const { Eufy } = await import('../src/eufy.js');
  const f = presetFixture(presetsAvailable);
  let issued!: () => void;
  const reached = new Promise<void>((resolve) => {
    issued = resolve;
  });
  // A start that reached the camera and never answered, so no stop can confirm it.
  f.client.startLive = async (_id: string, options?: { signal?: AbortSignal; onProgress?: (progress: { stage: string; elapsedMs: number }) => void }) => {
    options?.onProgress?.({ stage: 'start_issued', elapsedMs: 1 });
    issued();
    return new Promise<never>((_resolve, reject) =>
      options?.signal?.addEventListener('abort', () => reject(new EufyError('cancelled')), { once: true }));
  };
  let recover!: () => void;
  const recoveries: string[] = [];
  f.client.ensureLiveStopped = (id: string) => {
    recoveries.push(id);
    return new Promise((resolve) => {
      recover = () => resolve({ confirmed: true, reason: 'device' });
    });
  };
  let clock = performance.now();
  t.mock.method(performance, 'now', () => clock);
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  const bridge = new Eufy(f.storage, 'mega', false, () => f.backend);
  try {
    await bridge.login(presetLogin);
    const viewer = { bufferedAmount: 0, send: () => {}, close: () => {} };
    assert.equal(bridge.hub.attach('CAM', viewer), true);
    await reached;
    bridge.hub.detach('CAM', viewer);
    await settle();
    // The client freed its session, the hub still waits for the confirmed stop.
    assert.equal(bridge.hub.phase('CAM'), 'stopping');
    assert.equal(bridge.hub.active, 0);
    await assert.rejects(bridge.movePreset('CAM', 1), { code: 'station_busy', status: 409 });
    // Three stop attempts three seconds apart, then the one-shot HomeBase recovery.
    for (let i = 0; i < 3; i++) {
      clock += 3000;
      bridge.hub.tick();
      await settle();
    }
    assert.deepEqual(recoveries, ['CAM']);
    assert.equal(bridge.hub.recoveringStation, true);
    await assert.rejects(bridge.movePreset('CAM', 1), { code: 'station_busy', status: 409 });
    // A recovery that is still running holds the HomeBase also after the camera confirmed its stop.
    bridge.hub.stopped('CAM');
    assert.equal(bridge.hub.phase('CAM'), undefined);
    await assert.rejects(bridge.movePreset('CAM', 2), { code: 'station_busy', status: 409 });
    assert.deepEqual(f.moves, [], 'No refused move reaches the client');
    assert.deepEqual(f.backend.presets.metrics, { commands: 0, accepted: 0, rejected: 0, unconfirmed: 0, refused: 0 });
    recover();
    await settle();
    assert.equal(bridge.hub.recoveringStation, false);
    assert.equal(bridge.hub.quarantined, 0);
    await bridge.movePreset('CAM', 2);
    assert.deepEqual(f.moves.map(({ id, preset }) => [id, preset]), [['CAM', 2]]);
    assert.deepEqual(f.backend.presets.metrics, { commands: 1, accepted: 1, rejected: 0, unconfirmed: 0, refused: 0 });
  } finally {
    await bridge.close();
  }
});
