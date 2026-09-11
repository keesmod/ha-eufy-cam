import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import {
  EufyError,
  type EufyMegaClient,
  type ClientOptions,
  type Device,
  type CameraCapabilities,
} from '@keesmod/eufy-mega-client';
import { MegaBackend } from '../src/mega-backend.js';
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
  const transfer = recordings.video('CAM', rows.recordings[0]!.id, abort.signal);
  const rejected = assert.rejects(transfer, { code: 'recording_unavailable' });
  await opening;
  assert.equal(recordings.busy, true);
  abort.abort();
  await rejected;
  assert.equal(recordings.busy, false);
  assert.equal(recordings.metrics.cancelled, 1);
});
function fixture() {
  const calls: string[] = [];
  let finish!: (value: { confirmed: boolean; reason: 'device' }) => void;
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
    listDevices: async () => devices,
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
    startLive: async () => {
      calls.push('start');
      const ended = new Promise<{ confirmed: boolean; reason: 'device' }>((resolve) => {
        finish = resolve;
      });
      return {
        id: 'stream',
        deviceId: 'CAM',
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
  const backend = new MegaBackend(
    storage,
    () => false,
    (options) => {
      void options.sessionStore.load();
      return client as unknown as EufyMegaClient;
    },
  );
  return { backend, client, calls, reads };
}
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
    assert.deepEqual(f.reads, ['mega-session.json']);
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
    await f.backend.stopLive('CAM');
    assert.deepEqual(stopped, [true]);
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

test('standalone capability reasons reach inventory and prevent every media operation', async () => {
  const f = fixture();
  f.client.listDevices = async () => [{ ...devices[1]!, stationId: 'CAM', model: 'T8134' }];
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
      () => f.backend.recordings.video('CAM', 'missing', abort.signal),
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
