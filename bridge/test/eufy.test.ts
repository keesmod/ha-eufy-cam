import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { Backend, AuthState } from '../src/backend.js';
import { Eufy } from '../src/eufy.js';
import { Storage } from '../src/storage.js';
import { logBackendFault } from '../src/backend-log.js';

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

test('shared bridge converts real media, keeps video through audio failure and retains last frame on close', { timeout: 20_000 }, async () => {
  const { spawnSync } = await import('node:child_process');
  const directory = await mkdtemp(join(tmpdir(), 'eufy-viewer-test-'));
  const storage = new Storage(directory);
  const calls: string[] = [];
  const backend = fixtureBackend();
  const diagnosticEvents: string[] = [];
  backend.recordAudioEvent = (_serial, event) => { diagnosticEvents.push(event); };
  backend.audioAttempt = () => 4242;
  backend.startLive = async serial => { calls.push(`start:${serial}`); };
  backend.stopLive = async serial => { calls.push(`stop:${serial}`); };
  const bridge = new Eufy(storage, 'mega', false, () => backend);
  let producer: ChildProcess | undefined;
  let producerClosed: Promise<unknown> | undefined;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new Error("No decoded frame within 3 seconds")), 3_000);
  try {
    assert.equal((await bridge.login({ username: 'test@example.invalid', password: 'fixture-only', country: 'NL' })).state, 'connected');
    assert.deepEqual(calls, []);
    const frames = new EventEmitter();
    const frame = once(frames, 'frame', { signal: controller.signal });
    const peer = {
      bufferedAmount: 0,
      send: (jpeg: Buffer) => frames.emit('frame', jpeg),
      close: (_code: number, reason: string) => controller.abort(new Error(`Viewer ended before first frame: ${reason}`)),
    };
    bridge.hub.attach('CAM123', peer);
    // A live camera keeps producing until its viewer closes. A finite fixture
    // lets the A/V encoder reach EOF and tear down the slower JPEG decoder.
    producer = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=8', '-c:v', 'libx264', '-threads', '1', '-tune', 'zerolatency', '-f', 'h264', 'pipe:1']);
    producerClosed = once(producer, 'close');
    // Register error handling immediately, including when the binary is missing.
    void producerClosed.catch(error => controller.abort(error));
    let stderr = '';
    producer.stderr!.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4096); });
    producer.on('exit', (code, signal) => controller.abort(new Error(`Test producer exited (${code ?? signal}): ${stderr}`)));
    const ready = once(bridge, 'media-ready');
    const audio = new PassThrough();
    // The library's deadline classified audio as absent, as on a cold SoloCam start.
    backend.emit('live-start', { serial: 'CAM123', videoCodec: 'h264', audioSupported: false, fps: 8, video: producer.stdout, audio });
    assert.deepEqual(await ready, ['CAM123']);
    assert.equal(bridge.metrics.frames, 0, 'Actual metadata is ready before JPEG decoding');
    assert.equal(bridge.media.active('CAM123'), true);
    assert.equal(bridge.media.lateAudioSupported('CAM123'), false);
    const [jpeg] = await frame;
    const streaming = bridge.supportReport().live_video!;
    assert.equal(streaming.length, 1, 'One video row per live session');
    assert.equal(streaming[0]!.state, 'streaming'); assert.equal(streaming[0]!.codec, 'h264');
    assert.equal(streaming[0]!.encoder.mode, 'software'); assert.equal(streaming[0]!.audio_attempt, 4242);
    assert.ok(streaming[0]!.input.chunks > 0, 'P2P input chunks are counted'); assert.ok(streaming[0]!.jpeg.chunks > 0, 'JPEG frames are counted');
    assert.ok(diagnosticEvents.includes('audio_absent'), 'Classification is still observed');
    assert.ok(diagnosticEvents.includes('video_input'));
    clearTimeout(deadline);
    assert.equal(jpeg[0], 255); assert.equal(jpeg[1], 216);
    // AAC arriving after the deadline is still input, and its first complete
    // frame is advertised late without touching the running video session.
    const sound = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', '-t', '0.2', '-c:a', 'aac', '-f', 'adts', 'pipe:1']);
    assert.equal(sound.status, 0, sound.stderr.toString());
    const audioReady = once(bridge, 'audio-ready');
    audio.write(sound.stdout);
    assert.deepEqual(await audioReady, ['CAM123']);
    assert.ok(diagnosticEvents.includes('audio_input'));
    assert.ok(diagnosticEvents.includes('audio_late'));
    assert.equal(bridge.media.lateAudioSupported('CAM123'), true);
    // An audio transport failure ends only the late audio delivery.
    audio.destroy(new Error('private transport detail'));
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(diagnosticEvents.includes('audio_transport_error'));
    assert.equal(bridge.media.lateAudioSupported('CAM123'), false);
    assert.equal(bridge.hub.active, 1, 'Video session survives the audio failure');
    assert.equal(bridge.media.active('CAM123'), true);
    assert.equal(calls.includes('stop:CAM123'), false);
    const next = once(frames, 'frame', { signal: AbortSignal.timeout(3000) });
    assert.equal(bridge.hub.ack('CAM123', peer), true);
    await next;
    assert.equal(bridge.hub.active, 1, 'JPEG frames keep flowing after the audio failure');
    // FFmpeg reports once a second once its output starts. The viewer keeps
    // acknowledging frames until the row carries a block with encoded frames.
    const keepViewing = () => bridge.hub.ack('CAM123', peer);
    frames.on('frame', keepViewing); keepViewing();
    const reported = AbortSignal.timeout(10_000);
    while (!(bridge.supportReport().live_video![0]!.encoder.frames! > 0)) {
      assert.equal(reported.aborted, false, 'No progress block with frames within 10 seconds');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    frames.off('frame', keepViewing);
    const progressed = bridge.supportReport().live_video![0]!.encoder;
    for (const key of ['frames', 'dropped', 'duplicated', 'out_time_ms', 'bytes', 'last_progress_ms', 'last_progress_age_ms', 'last_frame_ms'] as const)
      assert.equal(typeof progressed[key], 'number', key);
    assert.ok(progressed.last_frame_ms! <= progressed.last_progress_ms!);
    assert.equal(typeof progressed.stderr_chunks, 'number');
    bridge.hub.close();
    assert.ok(calls.includes('stop:CAM123'));
    const [ended] = bridge.supportReport().live_video!;
    assert.equal(ended!.state, 'ended'); assert.ok(ended!.duration_ms > 0);
    assert.equal(typeof ended!.input.last_data_age_ms, 'number', 'The input age at the session end is frozen');
    assert.equal(typeof ended!.jpeg.last_data_age_ms, 'number');
    assert.ok(ended!.encoder.frames! >= progressed.frames!, 'The counters of the last block before the end');
    assert.equal(typeof ended!.encoder.last_progress_age_ms, 'number');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(bridge.supportReport().live_video![0]!.encoder, ended!.encoder, 'FFmpeg\'s counters and their age are frozen at the end');
    const events = ended!.pipeline!.map(row => row.event);
    for (const event of ['start', 'h264', 'video_input', 'jpeg_frame', 'frame_ack', 'audio_late', 'session_end']) assert.ok(events.includes(event as never), event);
    // The paced 8 fps fixture may end before the MPEG-TS encoder's first packet. The
    // output counter and its pipeline mark come from the same callback either way.
    assert.equal(events.includes('media_output' as never), ended!.output.chunks > 0, 'MPEG-TS output chunks follow the media_output mark');
    assert.ok(!JSON.stringify(ended).includes('CAM123'), 'No camera identifier in the row');
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


test('default bridge logger receives discovery detail through the Eufy event relay', async (t) => {
  const storage = new Storage('/unused');
  storage.read = async () => undefined;
  storage.write = async () => {};
  const backend = fixtureBackend();
  const bridge = new Eufy(storage, 'mega', false, () => backend);
  const output = t.mock.method(console, 'error', () => {});
  bridge.on('backend_fault', logBackendFault);
  try {
    await bridge.login({ username: 'fixture', password: 'fixture', country: 'NL' });
    backend.emit('backend_fault', 'unsupported_device', 'device_model=T9999 device_type=95');
    backend.emit('backend_fault', 'unsupported_station');
    assert.deepEqual(output.mock.calls.map(call => call.arguments), [
      ['Eufy backend:', 'unsupported_device', 'device_model=T9999 device_type=95'],
      ['Eufy backend:', 'unsupported_station'],
    ]);
    assert.equal(bridge.diagnostics.enabled, false);
  } finally { await bridge.close(); }
});
