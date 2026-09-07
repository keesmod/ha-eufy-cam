import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { EufySecurity, VideoCodec } from 'eufy-security-client';
import { Eufy } from '../src/eufy.js';
import { Storage } from '../src/storage.js';

test('SDK adapter disables cloud polling, converts real media, and retains last frame on close', { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eufy-viewer-test-'));
  const storage = new Storage(directory);
  const calls: string[] = [];
  const sdk = Object.assign(new EventEmitter(), {
    isConnected: () => true,
    connect: async () => { sdk.emit('connect'); },
    close: () => {},
    setCameraMaxLivestreamDuration: (seconds: number) => assert.equal(seconds, 120),
    startStationLivestream: async (serial: string) => { calls.push(`start:${serial}`); },
    stopStationLivestream: async (serial: string) => { calls.push(`stop:${serial}`); },
  });
  const original = EufySecurity.initialize;
  EufySecurity.initialize = async config => {
    assert.equal(config.pollingIntervalMinutes, 0);
    assert.equal(config.acceptInvitations, false);
    assert.equal(typeof config.persistentData, 'string');
    assert.ok(Array.isArray(JSON.parse(config.persistentData!).push_persistentIds));
    return sdk as unknown as EufySecurity;
  };
  const bridge = new Eufy(storage);
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
    sdk.emit('station livestream start', {}, { getSerial: () => 'CAM123' }, { videoCodec: VideoCodec.H264 }, producer.stdout, Readable.from([]));
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
    EufySecurity.initialize = original;
    await bridge.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('saved login stays connecting through delayed initialization and retries boot network failures', async t => {
  const storage = new Storage('/unused');
  t.mock.method(storage, 'read', async (name: string) => name === 'credentials.json' ? JSON.stringify({ username: 'fixture', password: 'fixture', country: 'NL' }) : undefined);
  t.mock.method(storage, 'write', async () => {});
  const sdk = Object.assign(new EventEmitter(), { isConnected: () => true, connect: async () => {}, close: () => {}, setCameraMaxLivestreamDuration: () => {} });
  let attempts = 0;
  let initialized!: (sdk: EufySecurity) => void;
  const pending = new EventEmitter();
  const initialization = once(pending, 'initializing');
  t.mock.method(EufySecurity, 'initialize', async () => {
    if (++attempts === 1) throw new Error('DNS unavailable during boot');
    return new Promise<EufySecurity>(resolve => { initialized = resolve; pending.emit('initializing'); });
  });
  const bridge = new Eufy(storage);
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
    initialized(sdk as unknown as EufySecurity);
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
  const bridge = new Eufy(storage);
  try {
    await bridge.restore(); assert.equal(bridge.auth.state, 'unconfigured');
    read.mock.mockImplementation(async () => 'broken json');
    await assert.rejects(bridge.restore()); assert.equal(bridge.auth.state, 'error');
    read.mock.mockImplementation(async (name: string) => name === 'credentials.json' ? JSON.stringify({ username: 'fixture', password: 'fixture', country: 'NL' }) : undefined);
    const sdk = Object.assign(new EventEmitter(), { isConnected: () => false, connect: async () => { sdk.emit('tfa request'); }, close: () => {}, setCameraMaxLivestreamDuration: () => {} });
    const initialize = t.mock.method(EufySecurity, 'initialize', async () => sdk as unknown as EufySecurity);
    await bridge.restore(); assert.equal(bridge.auth.state, 'verify');
    assert.equal(initialize.mock.callCount(), 1);
  } finally { await bridge.close(); }
});

test('shutdown cancels pending automatic restore retry', async t => {
  const storage = new Storage('/unused');
  t.mock.method(storage, 'read', async (name: string) => name === 'credentials.json' ? '{}' : undefined);
  const initialize = t.mock.method(EufySecurity, 'initialize', async () => { throw new Error('offline'); });
  const bridge = new Eufy(storage);
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
