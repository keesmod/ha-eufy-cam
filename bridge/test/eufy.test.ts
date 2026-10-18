import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { Backend, AuthState, CameraInfo, Picture } from '../src/backend.js';
import { Eufy } from '../src/eufy.js';
import { SnapshotError } from '../src/errors.js';
import { Storage } from '../src/storage.js';
import { logBackendFault, logStandaloneNotAdmitted } from '../src/backend-log.js';

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

test('a start without media keeps the library\'s start stages in the camera\'s live video row', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eufy-viewer-test-'));
  const backend = fixtureBackend();
  // The HomeBase answers START and sends no stream, so no live-start follows.
  backend.startLive = async (_serial, _bound, onProgress) => {
    for (const stage of ['session_ready', 'start_issued'] as const) onProgress?.({ stage, elapsedMs: 1 });
    onProgress?.({ stage: 'start_result', elapsedMs: 2, returnCode: 0 });
    onProgress?.({ stage: 'no_data_end', elapsedMs: 3 });
  };
  const bridge = new Eufy(new Storage(directory), 'mega', false, () => backend);
  try {
    await bridge.login({ username: 'test@example.invalid', password: 'fixture-only', country: 'NL' });
    const peer = { bufferedAmount: 0, send: () => {}, close: () => {} };
    bridge.hub.attach('CAM1', peer);
    await new Promise(resolve => setImmediate(resolve));
    const [row] = bridge.supportReport().live_video!;
    assert.equal(row!.input.chunks, 0);
    assert.deepEqual(Object.keys(row!.start!), ['session_ready_ms', 'issued_ms', 'result_ms', 'return_code', 'no_data_end_ms']);
    assert.equal(row!.start!.return_code, 0);
    bridge.hub.detach('CAM1', peer);
    const [ended] = bridge.supportReport().live_video!;
    assert.equal(ended!.state, 'ended');
    assert.deepEqual(ended!.start, row!.start, 'The stages stay with the finished row');
    bridge.hub.stopped('CAM1');
  } finally {
    await bridge.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('a failed start releases the camera only when the library never issued START', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eufy-viewer-test-'));
  const backend = fixtureBackend();
  let issue = false;
  // A camera that never connects fails before START. After START the device
  // may be streaming, so the camera waits for a confirmed stop.
  backend.startLive = async (_serial, _bound, onProgress) => {
    if (issue) for (const stage of ['session_ready', 'start_issued'] as const) onProgress?.({ stage, elapsedMs: 1 });
    throw new Error('device_request_timeout');
  };
  const bridge = new Eufy(new Storage(directory), 'mega', false, () => backend);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  try {
    await bridge.login({ username: 'test@example.invalid', password: 'fixture-only', country: 'NL' });
    bridge.hub.attach('CAM1', { bufferedAmount: 0, send: () => {}, close: () => {} });
    await settle();
    assert.equal(bridge.hub.quarantined, 0);
    assert.equal(bridge.supportReport().live_video![0]!.state, 'failed');
    issue = true;
    assert.equal(bridge.hub.attach('CAM1', { bufferedAmount: 0, send: () => {}, close: () => {} }), true);
    await settle();
    assert.equal(bridge.hub.quarantined, 1);
    bridge.hub.stopped('CAM1');
  } finally {
    await bridge.close(); await rm(directory, { recursive: true, force: true });
  }
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

test('an unadmitted standalone camera reaches the default info logger by model code only (#154)', async (t) => {
  const storage = new Storage('/unused');
  storage.read = async () => undefined;
  storage.write = async () => {};
  const backend = fixtureBackend();
  const bridge = new Eufy(storage, 'mega', false, () => backend);
  const info = t.mock.method(console, 'info', () => {});
  const error = t.mock.method(console, 'error', () => {});
  bridge.on('standalone_not_admitted', logStandaloneNotAdmitted);
  const text = (model: string) =>
    `model=${model} is not admitted to the experimental route. The option is on, but the bundled library allows that route only for specific standalone models, so this camera stays standalone_transport_unverified without a connection attempt.`;
  try {
    await bridge.login({ username: 'fixture', password: 'fixture', country: 'NL' });
    backend.emit('standalone_not_admitted', 'T8410C');
    backend.emit('standalone_not_admitted', 'T8410C\nPRIVATE');
    backend.emit('standalone_not_admitted', undefined);
    const calls = info.mock.calls.map(call => call.arguments);
    assert.deepEqual(calls, [
      ['Eufy experimental standalone:', text('T8410C')],
      ['Eufy experimental standalone:', text('unavailable')],
      ['Eufy experimental standalone:', text('unavailable')],
    ]);
    assert.equal(error.mock.callCount(), 0);
    for (const value of calls.flat()) assert.doesNotMatch(String(value), /PRIVATE|\n/);
  } finally { await bridge.close(); }
});

const camera = (snapshot = true, live = true): CameraInfo => {
  const capability = (available: boolean) => ({ available, status: available ? 'experimental' as const : 'unsupported' as const, reason: available ? null : 'camera_media_unverified' });
  return { serial: 'CAM1', name: 'Fixture', model: 'T8214', hardware: '', software: '', battery: 80, snapshot_received_at: null,
    capabilities: { snapshot: capability(snapshot), live: capability(live), recordings: capability(true) } };
};
async function refreshBridge() {
  const storage = new Storage('/unused');
  storage.read = async () => undefined;
  storage.write = async () => {};
  const calls: string[] = [];
  const backend = fixtureBackend();
  backend.inventory = () => [camera()];
  backend.startLive = async serial => { calls.push(`start:${serial}`); };
  backend.stopLive = async serial => { calls.push(`stop:${serial}`); };
  const bridge = new Eufy(storage, 'mega', false, () => backend);
  await bridge.login({ username: 'fixture', password: 'fixture', country: 'NL' });
  bridge.snapshotRefreshSettleMs = 0;
  return { bridge, backend, calls };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const jpeg = (marker: number) => Buffer.from([255, 216, marker, 255, 217]);
const refusal = (code: string, status: number) => (error: unknown) => error instanceof SnapshotError && error.code === code && error.status === status;
const refreshMetrics = (bridge: Eufy) => [bridge.metrics.snapshot_refresh_requests, bridge.metrics.snapshot_refresh_completed, bridge.metrics.snapshot_refresh_failed];

test('a snapshot refresh wakes the camera as a viewer, keeps its frame and ends with the confirmed stop (#182)', async () => {
  const { bridge, backend, calls } = await refreshBridge();
  try {
    const cover = { data: Buffer.from('cover'), mime: 'image/jpeg', received: '2026-10-18T08:00:00.000Z' };
    backend.pictures.set('CAM1', cover); backend.emit('change');
    assert.equal(bridge.pictures.get('CAM1'), cover);
    let changes = 0; bridge.on('change', () => changes++);
    const refresh = bridge.refreshSnapshot('CAM1');
    assert.deepEqual(calls, ['start:CAM1']);
    assert.equal(bridge.hub.phase('CAM1'), 'starting');
    const frame = jpeg(1);
    bridge.hub.frame('CAM1', frame);
    const picture = await refresh;
    assert.equal(picture.data, frame); assert.equal(picture.mime, 'image/jpeg');
    assert.ok(Date.parse(picture.received) >= Date.parse(cover.received));
    assert.equal(bridge.pictures.get('CAM1'), picture);
    assert.equal(bridge.inventory()[0]!.snapshot_received_at, picture.received);
    assert.equal(changes, 1);
    // The refresh was the only viewer, so the hub ends the session and asks for the confirmed stop.
    assert.equal(bridge.hub.phase('CAM1'), 'stopping'); assert.equal(bridge.hub.active, 0);
    assert.deepEqual(calls, ['start:CAM1', 'stop:CAM1']);
    assert.deepEqual(refreshMetrics(bridge), [1, 1, 0]);
    const [row] = bridge.supportReport().live_video!;
    const events = row!.pipeline!.map(entry => entry.event);
    for (const event of ['start', 'snapshot_refresh', 'no_viewers', 'session_end']) assert.ok(events.includes(event as never), event);
    assert.doesNotMatch(JSON.stringify(row), /CAM1/);
    // An unrelated backend update no longer brings the older cover back.
    backend.emit('change');
    assert.equal(bridge.pictures.get('CAM1'), picture);
    bridge.hub.stopped('CAM1');
    assert.equal(bridge.hub.phase('CAM1'), undefined);
  } finally { await bridge.close(); }
});

test('a refresh acknowledges frames until the settle time has passed and keeps the latest one', async () => {
  const { bridge } = await refreshBridge();
  try {
    bridge.snapshotRefreshSettleMs = 100;
    let finished = false;
    const refresh = bridge.refreshSnapshot('CAM1').finally(() => { finished = true; });
    bridge.hub.frame('CAM1', jpeg(1)); await settle();
    // Delivered only because the refresh acknowledged the first frame.
    bridge.hub.frame('CAM1', jpeg(2)); await settle();
    assert.equal(finished, false);
    await new Promise(resolve => setTimeout(resolve, 120));
    const last = jpeg(3);
    bridge.hub.frame('CAM1', last);
    assert.equal((await refresh).data, last);
    assert.ok(bridge.supportReport().live_video![0]!.pipeline!.some(entry => entry.event === 'frame_ack'));
    bridge.hub.stopped('CAM1');
  } finally { await bridge.close(); }
});

test('a refresh joins a watched camera without starting or stopping it', async () => {
  const { bridge, calls } = await refreshBridge();
  try {
    const delivered: Buffer[] = [], closed: string[] = [];
    const viewer = { bufferedAmount: 0, send: (frame: Buffer) => { delivered.push(frame); }, close: (_code: number, reason: string) => { closed.push(reason); } };
    assert.equal(bridge.hub.attach('CAM1', viewer), true);
    const refresh = bridge.refreshSnapshot('CAM1');
    const frame = jpeg(1);
    bridge.hub.frame('CAM1', frame);
    assert.equal((await refresh).data, frame);
    await settle();
    assert.deepEqual(calls, ['start:CAM1']);
    assert.equal(bridge.hub.phase('CAM1'), 'playing'); assert.equal(bridge.hub.active, 1);
    assert.deepEqual(delivered, [frame]); assert.deepEqual(closed, []);
    assert.ok(bridge.supportReport().live_video![0]!.pipeline!.some(entry => entry.event === 'snapshot_refresh'));
    assert.equal(bridge.hub.ack('CAM1', viewer), true, 'The viewer keeps watching');
    bridge.hub.detach('CAM1', viewer);
    assert.deepEqual(calls, ['start:CAM1', 'stop:CAM1']);
    bridge.hub.stopped('CAM1');
  } finally { await bridge.close(); }
});

test('a refresh is refused, never queued, with a fixed code for each blocked state', async () => {
  const { bridge, backend, calls } = await refreshBridge();
  const state = backend as unknown as { connected: boolean; recordings: { busy: boolean } };
  const idle = () => ({ bufferedAmount: 0, send: () => {}, close: () => {} });
  try {
    for (const [snapshot, live] of [[false, true], [true, false]]) {
      backend.inventory = () => [camera(snapshot, live)];
      state.connected = false;
      await assert.rejects(bridge.refreshSnapshot('CAM1'), refusal('capability_unavailable', 503));
      state.connected = true;
    }
    backend.inventory = () => [camera()];
    state.connected = false; state.recordings.busy = true;
    await assert.rejects(bridge.refreshSnapshot('CAM1'), refusal('not_connected', 503));
    state.connected = true; bridge.auth = { state: 'connecting' };
    await assert.rejects(bridge.refreshSnapshot('CAM1'), refusal('not_connected', 503));
    bridge.auth = { state: 'connected' };
    await assert.rejects(bridge.refreshSnapshot('CAM1'), refusal('recording_busy', 409));
    state.recordings.busy = false;
    assert.deepEqual(calls, []);
    // A previous session that waits for its confirmed stop.
    const viewer = idle(); bridge.hub.attach('CAM1', viewer); bridge.hub.detach('CAM1', viewer);
    await assert.rejects(bridge.refreshSnapshot('CAM1'), refusal('live_stopping', 409));
    bridge.hub.stopped('CAM1');
    Object.defineProperty(bridge.hub, 'recoveringStation', { value: true, configurable: true });
    await assert.rejects(bridge.refreshSnapshot('CAM1'), refusal('live_stopping', 409));
    delete (bridge.hub as { recoveringStation?: boolean }).recoveringStation;
    calls.length = 0;
    backend.canStartLive = () => 'station_limit';
    await assert.rejects(bridge.refreshSnapshot('CAM1'), refusal('station_limit', 409));
    backend.canStartLive = () => false;
    await assert.rejects(bridge.refreshSnapshot('CAM1'), refusal('camera_busy', 409));
    assert.deepEqual(calls, [], 'A refused refresh starts and stops nothing');
    assert.equal(bridge.hub.active, 0); assert.equal(bridge.hub.quarantined, 0);
    backend.canStartLive = () => true;
    // Four viewers already watch the camera.
    const viewers = [idle(), idle(), idle(), idle()];
    for (const peer of viewers) assert.equal(bridge.hub.attach('CAM1', peer), true);
    await assert.rejects(bridge.refreshSnapshot('CAM1'), refusal('camera_busy', 409));
    assert.equal(bridge.hub.phase('CAM1'), 'starting');
    for (const peer of viewers) bridge.hub.detach('CAM1', peer);
    bridge.hub.stopped('CAM1');
    assert.deepEqual(refreshMetrics(bridge), [10, 0, 10]);
  } finally { await bridge.close(); }
});

test('a refresh without a frame reports the hub\'s timeouts apart from other session ends', async t => {
  const { bridge, backend, calls } = await refreshBridge();
  try {
    for (const [reason, code, status] of [['Viewing time limit or stalled camera', 'refresh_timeout', 504], ['Device stop unconfirmed', 'refresh_failed', 502], ['Bridge shutting down', 'refresh_failed', 502]] as const) {
      const refresh = bridge.refreshSnapshot('CAM1');
      bridge.hub.end('CAM1', reason);
      await assert.rejects(refresh, refusal(code, status));
      bridge.hub.stopped('CAM1');
    }
    // The hub's first-frame timeout ends the session.
    const base = performance.now();
    const expired = bridge.refreshSnapshot('CAM1');
    const clock = t.mock.method(performance, 'now', () => base + 20_001);
    bridge.hub.tick();
    clock.mock.restore();
    await assert.rejects(expired, refusal('refresh_timeout', 504));
    bridge.hub.stopped('CAM1');
    const removed = bridge.refreshSnapshot('CAM1');
    backend.emit('camera-removed', 'CAM1');
    await assert.rejects(removed, refusal('refresh_failed', 502));
    bridge.hub.stopped('CAM1');
    calls.length = 0;
    backend.startLive = async () => { throw new Error('device_request_timeout'); };
    await assert.rejects(bridge.refreshSnapshot('CAM1'), refusal('refresh_failed', 502));
    assert.deepEqual(calls, [], 'A start that never reached the device needs no stop');
    assert.equal(bridge.hub.quarantined, 0);
    assert.deepEqual(refreshMetrics(bridge), [6, 0, 6]);
  } finally { await bridge.close(); }
});

test('a refresh that joins a starting session waits for its first frame, not the 10 s join deadline', async t => {
  const { bridge, calls } = await refreshBridge();
  const base = performance.now();
  let now = base;
  t.mock.method(performance, 'now', () => now);
  try {
    // A double press while the camera wakes.
    const first = bridge.refreshSnapshot('CAM1'), second = bridge.refreshSnapshot('CAM1');
    now = base + 12_000; bridge.hub.tick();
    assert.equal(bridge.hub.phase('CAM1'), 'starting');
    const frame = jpeg(1);
    bridge.hub.frame('CAM1', frame);
    assert.equal((await first).data, frame); assert.equal((await second).data, frame);
    assert.deepEqual(calls, ['start:CAM1', 'stop:CAM1']);
    bridge.hub.stopped('CAM1');
    // A refresh joins a starting live view, and the frame comes after its deadline but before the next tick.
    const delivered: Buffer[] = [];
    const viewer = { bufferedAmount: 0, send: (frame: Buffer) => { delivered.push(frame); }, close: () => {} };
    bridge.hub.attach('CAM1', viewer);
    const joined = bridge.refreshSnapshot('CAM1');
    now += 10_001;
    const late = jpeg(2);
    bridge.hub.frame('CAM1', late);
    assert.equal((await joined).data, late);
    assert.deepEqual(delivered, [late]); assert.equal(bridge.hub.phase('CAM1'), 'playing');
    bridge.hub.detach('CAM1', viewer); bridge.hub.stopped('CAM1');
    // The rejoined refresh still ends with the hub's first-frame timeout.
    const started = now;
    const a = bridge.refreshSnapshot('CAM1'), b = bridge.refreshSnapshot('CAM1');
    now = started + 12_000; bridge.hub.tick();
    now = started + 20_000; bridge.hub.tick();
    await assert.rejects(a, refusal('refresh_timeout', 504)); await assert.rejects(b, refusal('refresh_timeout', 504));
    assert.equal(bridge.hub.phase('CAM1'), 'stopping');
    bridge.hub.stopped('CAM1');
    assert.equal(calls.filter(call => call.startsWith('start')).length, 3);
    assert.deepEqual(refreshMetrics(bridge), [5, 3, 2]);
  } finally { await bridge.close(); }
});

test('a refresh that already holds a frame succeeds when the session ends early or its guard fires', async t => {
  const { bridge, calls } = await refreshBridge();
  try {
    bridge.snapshotRefreshSettleMs = 60_000;
    const ended = bridge.refreshSnapshot('CAM1');
    const first = jpeg(1);
    bridge.hub.frame('CAM1', first); await settle();
    bridge.hub.end('CAM1', 'Viewing time limit or stalled camera');
    assert.equal((await ended).data, first);
    assert.equal(bridge.pictures.get('CAM1')!.data, first);
    bridge.hub.stopped('CAM1');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let finished = false;
    const silent = bridge.refreshSnapshot('CAM1').finally(() => { finished = true; });
    t.mock.timers.tick(29_999); await settle();
    assert.equal(finished, false);
    t.mock.timers.tick(1);
    await assert.rejects(silent, refusal('refresh_timeout', 504));
    assert.equal(bridge.hub.phase('CAM1'), 'stopping', 'The guard detaches the viewer');
    bridge.hub.stopped('CAM1');
    const guarded = bridge.refreshSnapshot('CAM1');
    const second = jpeg(2);
    bridge.hub.frame('CAM1', second); await settle();
    t.mock.timers.tick(30_000);
    assert.equal((await guarded).data, second);
    bridge.hub.stopped('CAM1');
    assert.deepEqual(calls.filter(call => call.startsWith('stop')).length, 3);
    assert.deepEqual(refreshMetrics(bridge), [3, 2, 1]);
  } finally { t.mock.timers.reset(); await bridge.close(); }
});

test('an aborted refresh detaches its viewer, so the camera gets its confirmed stop', async () => {
  const { bridge, calls } = await refreshBridge();
  try {
    const cancel = new AbortController();
    const refresh = bridge.refreshSnapshot('CAM1', cancel.signal);
    assert.equal(bridge.hub.active, 1);
    cancel.abort();
    await assert.rejects(refresh, { name: 'AbortError' });
    assert.equal(bridge.hub.phase('CAM1'), 'stopping');
    assert.deepEqual(calls, ['start:CAM1', 'stop:CAM1']);
    bridge.hub.stopped('CAM1');
    await assert.rejects(bridge.refreshSnapshot('CAM1', AbortSignal.abort()), { name: 'AbortError' });
    assert.equal(calls.length, 2, 'An aborted request never starts the camera');
    // A frame does not make an abandoned request succeed.
    bridge.snapshotRefreshSettleMs = 60_000;
    const late = new AbortController();
    const held = bridge.refreshSnapshot('CAM1', late.signal);
    bridge.hub.frame('CAM1', jpeg(1)); await settle();
    late.abort();
    await assert.rejects(held, { name: 'AbortError' });
    assert.equal(bridge.pictures.has('CAM1'), false);
    bridge.hub.stopped('CAM1');
    assert.deepEqual(refreshMetrics(bridge), [3, 0, 3]);
  } finally { await bridge.close(); }
});

test('a finished live view keeps its last frame until the backend stores a newer cover (#182)', async () => {
  const { bridge, backend } = await refreshBridge();
  // Without FFmpeg the test puts a decoded frame where the JPEG framer puts it.
  const decoded = (bridge as unknown as { livePictures: Map<string, Picture> }).livePictures;
  try {
    const cover = { data: Buffer.from('cover'), mime: 'image/jpeg', received: '2026-10-18T08:00:00.000Z' };
    backend.pictures.set('CAM1', cover); backend.emit('change');
    const viewer = { bufferedAmount: 0, send: () => {}, close: () => {} };
    bridge.hub.attach('CAM1', viewer);
    const live = { data: jpeg(1), mime: 'image/jpeg', received: '2026-10-18T09:00:00.000Z' };
    decoded.set('CAM1', live);
    bridge.hub.detach('CAM1', viewer);
    assert.equal(bridge.pictures.get('CAM1'), live);
    backend.emit('change');
    assert.equal(bridge.pictures.get('CAM1'), live, 'An unrelated backend update keeps the live frame');
    assert.equal(bridge.inventory()[0]!.snapshot_received_at, live.received);
    const newer = { data: Buffer.from('newer cover'), mime: 'image/jpeg', received: '2026-10-18T10:00:00.000Z' };
    backend.pictures.set('CAM1', newer); backend.emit('change');
    assert.equal(bridge.pictures.get('CAM1'), newer, 'A new cover object replaces it');
    bridge.hub.stopped('CAM1');
    // A refresh frame that is the decoded live picture keeps that picture and its time.
    const refresh = bridge.refreshSnapshot('CAM1');
    const frame = { data: jpeg(2), mime: 'image/jpeg', received: '2026-10-18T11:00:00.000Z' };
    decoded.set('CAM1', frame);
    bridge.hub.frame('CAM1', frame.data);
    assert.equal(await refresh, frame);
    assert.equal(bridge.pictures.get('CAM1'), frame, 'The promotion at the session end changes nothing');
    bridge.hub.stopped('CAM1');
  } finally { await bridge.close(); }
});

test('a refresh keeps the newest decoded frame when FFmpeg emits several in one chunk (#182)', async () => {
  const { bridge } = await refreshBridge();
  const decoded = (bridge as unknown as { livePictures: Map<string, Picture> }).livePictures;
  // As the JPEG framer emits a frame: the decoded picture first, then the hub.
  const emit = (picture: Picture) => { decoded.set('CAM1', picture); bridge.hub.frame('CAM1', picture.data); };
  const seen: (string | null)[] = [];
  bridge.on('change', () => seen.push(bridge.inventory()[0]!.snapshot_received_at));
  try {
    const refresh = bridge.refreshSnapshot('CAM1');
    const a = { data: jpeg(1), mime: 'image/jpeg', received: '2026-10-18T10:00:00.000Z' };
    const b = { data: jpeg(2), mime: 'image/jpeg', received: '2026-10-18T10:00:00.050Z' };
    // One stdout chunk: b arrives while the refresh still owes the ack for a.
    emit(a); emit(b);
    const picture = await refresh;
    assert.equal(picture, b);
    assert.equal(bridge.hub.phase('CAM1'), 'stopping');
    assert.equal(bridge.pictures.get('CAM1'), picture, 'The promotion at the session end changes nothing');
    assert.deepEqual([...new Set(seen)], [picture.received], 'snapshot_received_at changes once');
    bridge.hub.stopped('CAM1');
    // A camera that stops by itself promotes the frame before the refresh hears of it.
    bridge.snapshotRefreshSettleMs = 60_000;
    seen.length = 0;
    const stopped = bridge.refreshSnapshot('CAM1');
    const c = { data: jpeg(3), mime: 'image/jpeg', received: '2026-10-18T11:00:00.000Z' };
    emit(c); await settle();
    bridge.hub.stopped('CAM1');
    assert.equal(await stopped, c);
    assert.equal(bridge.pictures.get('CAM1'), c);
    assert.deepEqual(seen, [c.received], 'Only the promotion reports a change');
    // Also the newest frame of one chunk, skipped for the refresh, stays the snapshot.
    seen.length = 0;
    const skipped = bridge.refreshSnapshot('CAM1');
    const d = { data: jpeg(4), mime: 'image/jpeg', received: '2026-10-18T12:00:00.000Z' };
    emit(d);
    // Stamped as the framer does, after the refresh received d.
    const e = { data: jpeg(5), mime: 'image/jpeg', received: new Date().toISOString() };
    emit(e); await settle();
    bridge.hub.stopped('CAM1');
    assert.equal(await skipped, e);
    assert.equal(bridge.pictures.get('CAM1'), e);
    assert.deepEqual(seen, [e.received], 'Only the promotion reports a change');
    assert.deepEqual(refreshMetrics(bridge), [3, 3, 0]);
  } finally { await bridge.close(); }
});
