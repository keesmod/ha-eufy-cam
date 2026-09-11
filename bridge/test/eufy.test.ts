import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { Backend, AuthState } from '../src/backend.js';
import { Eufy } from '../src/eufy.js';
import { Storage } from '../src/storage.js';

function fixtureBackend(login: () => Promise<AuthState> = async () => ({ state: 'connected' })): Backend {
  const backend = Object.assign(new EventEmitter(), {
    connected: true,
    auth: { state: 'connected' } as AuthState,
    pictures: new Map(),
    recordings: { busy: false, metrics: {}, close() {} },
    stations: undefined,
    notifications: { metrics: {}, close() {} },
    inventory: () => [], hasCamera: () => true, canStartLive: () => true,
    startLive: async () => {}, stopLive: async () => {}, recoverStation: async () => [],
    login: async () => { backend.auth = await login(); return backend.auth; },
    close: async () => {},
  });
  return backend as unknown as Backend;
}
const provider = { login: async (): Promise<AuthState> => ({ state: 'connected' }) };
const makeBridge = (storage: Storage) => new Eufy(storage, 'mega', false, () => fixtureBackend(() => provider.login()));

test('shared bridge converts real media and retains last frame on close', { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eufy-viewer-test-'));
  const storage = new Storage(directory);
  const calls: string[] = [];
  const backend = fixtureBackend();
  backend.startLive = async serial => { calls.push(`start:${serial}`); };
  backend.stopLive = async serial => { calls.push(`stop:${serial}`); };
  const bridge = new Eufy(storage, 'mega', false, () => backend);
  let producer: ChildProcess | undefined;
  let producerClosed: Promise<unknown> | undefined;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new Error("No decoded frame within 15 seconds")), 15_000);
  try {
    assert.equal((await bridge.login({ username: 'test@example.invalid', password: 'fixture-only', country: 'NL' })).state, 'connected');
    assert.deepEqual(calls, []);
    const frames = new EventEmitter();
    const frame = once(frames, 'frame', { signal: controller.signal });
    bridge.hub.attach('CAM123', {
      bufferedAmount: 0,
      send: jpeg => frames.emit('frame', jpeg),
      close: (_code, reason) => controller.abort(new Error(`Viewer ended before first frame: ${reason}`)),
    });
    // A live camera keeps producing until its viewer closes. A finite fixture
    // lets the A/V encoder reach EOF and tear down the slower JPEG decoder.
    producer = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=8', '-c:v', 'libx264', '-threads', '1', '-tune', 'zerolatency', '-f', 'h264', 'pipe:1']);
    producerClosed = once(producer, 'close');
    // Register error handling immediately, including when the binary is missing.
    void producerClosed.catch(error => controller.abort(error));
    let stderr = '';
    producer.stderr!.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4096); });
    producer.on('exit', (code, signal) => controller.abort(new Error(`Test producer exited (${code ?? signal}): ${stderr}`)));
    backend.emit('live-start', { serial: 'CAM123', videoCodec: 'h264', audioSupported: false, fps: 8, video: producer.stdout, audio: Readable.from([]) });
    const [jpeg] = await frame;
    clearTimeout(deadline);
    assert.equal(jpeg[0], 255); assert.equal(jpeg[1], 216);
    bridge.hub.close();
    assert.ok(calls.includes('stop:CAM123'));
    assert.equal(bridge.metrics.start_requests, 1);
    assert.equal(bridge.metrics.started_events, 1);
    assert.ok(bridge.metrics.frames > 0);
    assert.ok(bridge.metrics.stop_requests > 0);
    assert.ok(bridge.pictures.get('CAM123')?.data.length);
    bridge.hub.stopped('CAM123');
  } finally {
    clearTimeout(deadline);
    controller.abort();
    producer?.kill("SIGKILL");
    await producerClosed?.catch(() => {});
    await bridge.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('saved login stays connecting through delayed initialization and retries boot network failures', async t => {
  const storage = new Storage('/unused');
  t.mock.method(storage, 'read', async (name: string) => name === 'mega-credentials.json' ? JSON.stringify({ username: 'fixture', password: 'fixture', country: 'NL' }) : undefined);
  t.mock.method(storage, 'write', async () => {});
  let attempts = 0;
  let initialized!: (state: AuthState) => void;
  const pending = new EventEmitter();
  const initialization = once(pending, 'initializing');
  t.mock.method(provider, 'login', async () => {
    if (++attempts === 1) throw new Error('DNS unavailable during boot');
    return new Promise<AuthState>(resolve => { initialized = resolve; pending.emit('initializing'); });
  });
  const bridge = makeBridge(storage);
  const states: string[] = [];
  bridge.on('change', () => states.push(bridge.auth.state));
  const retry = once(bridge, 'restore_retry');
  const restoring = bridge.restore();
  try {
    assert.equal(bridge.auth.state, 'connecting');
    await retry;
    assert.equal(attempts, 1);
    await assert.rejects(bridge.login(), /still being restored/);
    await initialization;
    assert.equal(attempts, 2);
    assert.equal(bridge.auth.state, 'connecting');
    initialized({ state: 'connected' } as AuthState);
    await restoring;
    assert.equal(bridge.auth.state, 'connected');
    assert.ok(!states.includes('unconfigured') && !states.includes('error'));
    assert.equal(bridge.metrics.start_requests, 0);
  } finally { await bridge.close(); }
});

test('restore distinguishes no account, corrupt storage and a genuine verification challenge', async t => {
  const storage = new Storage('/unused');
  const read = t.mock.method(storage, 'read', async () => undefined as string | undefined);
  t.mock.method(storage, 'write', async () => {});
  const bridge = makeBridge(storage);
  try {
    await bridge.restore(); assert.equal(bridge.auth.state, 'unconfigured');
    read.mock.mockImplementation(async (name: string) => name === 'mega-credentials.json' ? 'broken json' : undefined);
    await assert.rejects(bridge.restore()); assert.equal(bridge.auth.state, 'error');
    read.mock.mockImplementation(async (name: string) => name === 'mega-credentials.json' ? JSON.stringify({ username: 'fixture', password: 'fixture', country: 'NL' }) : undefined);
    const initialize = t.mock.method(provider, 'login', async () => ({ state: 'verify' } as AuthState));
    await bridge.restore(); assert.equal(bridge.auth.state, 'verify');
    assert.equal(initialize.mock.callCount(), 1);
  } finally { await bridge.close(); }
});

test('shutdown cancels pending automatic restore retry', async t => {
  const storage = new Storage('/unused');
  t.mock.method(storage, 'read', async (name: string) => name === 'mega-credentials.json' ? '{}' : undefined);
  const initialize = t.mock.method(provider, 'login', async () => { throw new Error('offline'); });
  const bridge = makeBridge(storage);
  const retry = once(bridge, 'restore_retry');
  const restoring = bridge.restore();
  await retry;
  await bridge.close();
  await restoring;
  assert.equal(initialize.mock.callCount(), 1);
});

test('refusing reauthentication during a viewer leaves the connected session intact', async () => {
  const bridge = new Eufy(new Storage('/unused'));
  bridge.auth = { state: 'connected' };
  Object.defineProperty(bridge.hub, 'active', { value: 1 });
  await assert.rejects(bridge.login({ username: 'fixture', password: 'fixture', country: 'NL' }), /Stop viewers/);
  assert.equal(bridge.auth.state, 'connected');
  await bridge.close();
});


test('explicit credentials recover during automatic restore backoff without overlapping SDK owners', async t => {
  const storage = new Storage('/unused');
  t.mock.method(storage, 'read', async (name: string) => name === 'mega-credentials.json' ? JSON.stringify({ username: 'old', password: 'fixture', country: 'NL' }) : undefined);
  t.mock.method(storage, 'write', async () => {});
  let attempts = 0;
  t.mock.method(provider, 'login', async () => {
    if (++attempts === 1) throw new Error('Saved settings cannot initialize');
    return { state: 'connected' } as AuthState;
  });
  const bridge = makeBridge(storage);
  const retry = once(bridge, 'restore_retry');
  const restoring = bridge.restore();
  try {
    await retry;
    const recovered = await bridge.login({ username: 'corrected', password: 'fixture', country: 'IT' });
    await restoring;
    assert.equal(recovered.state, 'connected');
    assert.equal(attempts, 2);
    assert.equal(bridge.auth.state, 'connected');
  } finally { await bridge.close(); }
});

test('manual recovery waits for in-flight automatic initialization to settle', async t => {
  const storage = new Storage('/unused');
  t.mock.method(storage, 'read', async (name: string) => name === 'mega-credentials.json' ? '{}' : undefined);
  t.mock.method(storage, 'write', async () => {});
  let rejectOld!: (error: Error) => void;
  const starting = new EventEmitter();
  const started = once(starting, 'started');
  let attempts = 0;
  t.mock.method(provider, 'login', async () => {
    if (++attempts === 1) return new Promise<AuthState>((_resolve, reject) => { rejectOld = reject; starting.emit('started'); });
    return { state: 'connected' } as AuthState;
  });
  const bridge = makeBridge(storage);
  const restoring = bridge.restore();
  try {
    await started;
    const recovery = bridge.login({ username: 'corrected', password: 'fixture', country: 'IT' });
    await Promise.resolve();
    assert.equal(attempts, 1);
    rejectOld(new Error('Old initialization failed'));
    assert.equal((await recovery).state, 'connected');
    await restoring;
    assert.equal(attempts, 2);
  } finally { await bridge.close(); }
});
