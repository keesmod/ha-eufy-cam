import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { Readable, PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { LiveVideoDiagnostics } from '../src/live-video-diagnostics.js';

// Synthetic bytes stand in for an H.264 access unit. No captured camera video.
const chunk = Buffer.alloc(1000, 7);

test('input observation does not consume buffered video and measures chunks, bytes and gaps', async () => {
  let now = 0;
  const reports = new LiveVideoDiagnostics(() => now);
  const row = reports.begin('T8425');
  const stream = new Readable({ read() {} });
  stream.push(chunk);
  now = 2000;
  row.attach(stream, 'h264');
  await setImmediate();
  assert.equal(stream.readableFlowing, null, 'Observation alone never starts the flow');
  assert.equal(stream.readableLength, chunk.length);
  assert.equal(row.snapshot().input.chunks, 0);
  assert.equal(row.snapshot().state, 'streaming');
  assert.equal(row.snapshot().codec, 'h264');
  const received: Buffer[] = [];
  stream.on('data', data => received.push(data));
  await setImmediate();
  assert.equal(Buffer.concat(received).length, chunk.length);
  assert.deepEqual(row.snapshot().input, { chunks: 1, bytes: 1000, first_data_ms: 2000, last_data_ms: 2000, last_data_age_ms: 0 });
  now = 2700; stream.push(chunk.subarray(0, 10)); await setImmediate();
  now = 3000; stream.push(chunk); await setImmediate();
  now = 3500;
  assert.deepEqual(row.snapshot().input, { chunks: 3, bytes: 2010, first_data_ms: 2000, last_data_ms: 3000, last_data_age_ms: 500, max_gap_ms: 700 });
  assert.equal(row.snapshot().output.chunks, 0);
  assert.equal(row.snapshot().output.first_data_ms, undefined, 'No output means no first data, never zero');
  now = 12000;
  row.finish('ended');
  assert.equal(stream.listenerCount('data'), 1, 'The observer detaches at the end');
  stream.push(chunk); await setImmediate();
  const ended = row.snapshot();
  assert.equal(ended.state, 'ended');
  assert.equal(ended.duration_ms, 12000);
  assert.equal(ended.input.chunks, 3, 'Data after the end is not counted');
  assert.equal(ended.input.last_data_age_ms, 9000, 'The age at the end says how long before the end the input stopped');
  now = 20000;
  assert.equal(row.snapshot().input.last_data_age_ms, 9000, 'The age stays frozen after the end');
  assert.equal(row.snapshot().duration_ms, 12000);
  stream.destroy();
});

test('output, JPEG, readers, encoder mode and exits are counted with bounded fixed categories', () => {
  let now = 0;
  const reports = new LiveVideoDiagnostics(() => now);
  const row = reports.begin('T8425');
  row.encoder('nvidia');
  assert.equal(row.snapshot().encoder.mode, 'nvidia');
  now = 100; row.mark('start');
  now = 4000; row.mark('media_hardware_timeout'); row.mark('media_encoder_exit');
  now = 4100; row.mark('media_software_fallback');
  now = 4600; row.mark('media_active_software'); row.output(188 * 7);
  now = 4700; row.output(188 * 3); row.jpeg(30000);
  now = 4800; row.reader('video', 'attached'); row.reader('video', 'attached'); row.reader('audio', 'attached');
  now = 5000; row.reader('video', 'backpressure');
  now = 5200; row.reader('video', 'closed'); row.reader('audio', 'revoked');
  now = 5300; row.mark('media_encoder_exit'); row.mark('media_encoder_exit');
  for (let i = 0; i < 100; i++) row.mark('media_encoder_stderr');
  row.mark('PRIVATE' as never); row.reader('PRIVATE' as never, 'attached'); row.reader('video', 'PRIVATE' as never);
  row.encoder('PRIVATE' as never); row.output(-5); row.jpeg(Number.NaN);
  row.correlate('PRIVATE'); row.correlate(2 ** 48); row.correlate(0); row.correlate(1.5);
  assert.equal(row.snapshot().audio_attempt, undefined);
  row.correlate(77);
  now = 6000;
  const { attempt, age_ms, ...report } = row.snapshot();
  assert.ok(Number.isInteger(attempt) && attempt >= 1 && attempt < 2 ** 48);
  assert.equal(age_ms, 6000);
  assert.deepEqual(report, {
    model: 'T8425', state: 'starting', audio_attempt: 77, duration_ms: 6000,
    encoder: { mode: 'software', exits: 3, software_fallback_ms: 4100 },
    input: { chunks: 0, bytes: 0 },
    output: { chunks: 2, bytes: 1880, first_data_ms: 4600, last_data_ms: 4700, last_data_age_ms: 1300, max_gap_ms: 100 },
    jpeg: { chunks: 1, bytes: 30000, first_data_ms: 4700, last_data_ms: 4700, last_data_age_ms: 1300 },
    readers: { attached: 2, backpressure: 1, closed: 1, revoked: 0, last_destroy_ms: 5000 },
    audio_readers: { attached: 1, backpressure: 0, closed: 0, revoked: 1, last_destroy_ms: 5200 },
    pipeline: [
      { event: 'start', elapsed_ms: 100 }, { event: 'media_hardware_timeout', elapsed_ms: 4000 },
      { event: 'media_encoder_exit', elapsed_ms: 4000 }, { event: 'media_software_fallback', elapsed_ms: 4100 },
      { event: 'media_active_software', elapsed_ms: 4600 }, { event: 'media_encoder_stderr', elapsed_ms: 5300 },
    ],
  });
  assert.ok(!JSON.stringify(row.snapshot()).includes('PRIVATE'));
  const snapshot = row.snapshot();
  snapshot.output.chunks = 99; snapshot.readers.attached = 99; snapshot.encoder.exits = 99; snapshot.pipeline![0]!.elapsed_ms = 99;
  assert.equal(row.snapshot().output.chunks, 2); assert.equal(row.snapshot().readers.attached, 2);
  assert.equal(row.snapshot().encoder.exits, 3); assert.equal(row.snapshot().pipeline![0]!.elapsed_ms, 100);
  row.finish('failed');
  row.output(188); row.jpeg(1); row.reader('video', 'attached'); row.mark('session_end'); row.encoder('nvidia'); row.correlate(78);
  assert.equal(row.snapshot().state, 'failed');
  assert.equal(row.snapshot().output.chunks, 2); assert.equal(row.snapshot().readers.attached, 2);
  assert.equal(row.snapshot().encoder.mode, 'software'); assert.equal(row.snapshot().audio_attempt, 77);
  assert.equal(row.snapshot().pipeline!.length, 6);
});

test('reports are bounded, sanitized, capped at one hour and detach evicted observations', async () => {
  let now = 0;
  const reports = new LiveVideoDiagnostics(() => now);
  const streams = Array.from({ length: 10 }, () => new PassThrough());
  for (const stream of streams) {
    const row = reports.begin('T8425\nPRIVATE');
    row.attach(stream, 'PRIVATE');
    stream.resume();
    stream.write(chunk);
    await setImmediate();
  }
  now = 200000;
  const snapshot = reports.report();
  assert.equal(snapshot.length, 8);
  assert.equal(new Set(snapshot.map(row => row.attempt)).size, 8);
  assert.equal(snapshot[0]!.model, 'unavailable');
  assert.equal(snapshot[0]!.codec, undefined);
  assert.equal(snapshot[0]!.duration_ms, 200000, 'a raised session cap keeps durations beyond two minutes');
  assert.ok(!JSON.stringify(snapshot).includes('PRIVATE'));
  assert.equal(streams[0]!.listenerCount('data'), 0, 'An evicted row detaches from its stream');
  assert.equal(streams[9]!.listenerCount('data'), 1);
  let clock = 0;
  const long = new LiveVideoDiagnostics(() => clock).begin('T8425');
  const stream = new PassThrough(); long.attach(stream, 'hevc'); stream.resume();
  clock = 100; stream.write(chunk); await setImmediate();
  clock = 3700000;
  long.finish('ended');
  assert.equal(long.snapshot().duration_ms, 3600000, 'times stay bounded to one hour');
  assert.equal(long.snapshot().input.last_data_age_ms, 3600000);
  assert.equal(long.snapshot().codec, 'hevc');
  reports.close();
  for (const stream of streams) {
    assert.equal(stream.listenerCount('data'), 0);
    stream.destroy();
  }
  assert.equal(reports.report(10_000_000).every(row => row.state === 'closed'), true);
  stream.destroy();
});

test('the report keeps a row for fifteen minutes by default and for the live cap plus fifteen minutes when asked', () => {
  let now = 0;
  const reports = new LiveVideoDiagnostics(() => now);
  reports.begin('T8425');
  now = 899_999; assert.equal(reports.report().length, 1);
  now = 900_000; assert.equal(reports.report().length, 0);
  // A session that ran to a 1800-second cap is still in a report taken after its end.
  now = 1_800_000 + 600_000; assert.equal(reports.report(1_800_000 + 900_000).length, 1);
  now = 2_700_000; assert.equal(reports.report(2_700_000).length, 0);
});

// The relay counts readers and output chunks per session against real FFmpeg
// output, so the row says which reader the bridge dropped and why.
test('the media relay reports output chunks and reader attach, backpressure, client close and revoke counts', { timeout: 15000 }, async t => {
  const { spawnSync } = await import('node:child_process');
  const { MediaRelay } = await import('../src/media.js');
  const { adtsHeader } = await import('../src/audio-header-diagnostics.js');
  const fixture = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15', '-t', '1', '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-tune', 'zerolatency', '-f', 'h264', 'pipe:1']);
  assert.equal(fixture.status, 0, fixture.stderr.toString());
  const sound = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', '-t', '0.5', '-c:a', 'aac', '-f', 'adts', 'pipe:1']);
  assert.equal(sound.status, 0, sound.stderr.toString());
  const frames: Buffer[] = [];
  for (let offset = 0; offset < sound.stdout.length;) {
    const header = adtsHeader(sound.stdout.subarray(offset)); assert.ok(header);
    frames.push(sound.stdout.subarray(offset, offset + header.frame_bytes)); offset += header.frame_bytes;
  }
  const video = new PassThrough(), audio = new PassThrough();
  const media = new MediaRelay(() => assert.fail('encoder failed'));
  const reader = (writableLength = 0) => Object.assign(new EventEmitter(), { writableLength, destroyed: false, writeHead() {}, write() { return true; }, destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } } });
  const row = new LiveVideoDiagnostics().begin('T8425');
  t.after(() => { media.stop('fixture'); video.destroy(); audio.destroy(); });
  const grant = media.grant('fixture');
  const slow = reader(2_000_000), kept = reader(), client = reader();
  assert.equal(media.serve(grant, slow as any), true, 'A reader before start is counted once the session observes');
  media.start('fixture', 'h264', video, audio, 15, row);
  assert.equal(row.snapshot().encoder.mode, 'software');
  assert.equal(media.serve(grant, kept as any), true);
  assert.equal(media.serve(grant, client as any), true);
  assert.deepEqual(row.snapshot().readers, { attached: 2, backpressure: 0, closed: 0, revoked: 0 });
  const first = once(slow, 'close', { signal: AbortSignal.timeout(5000) });
  video.write(fixture.stdout);
  await first;
  assert.equal(slow.destroyed, true, 'The 1 MB rule drops the slow reader');
  assert.ok(row.snapshot().output.chunks > 0); assert.ok(row.snapshot().output.bytes >= 188);
  assert.equal(typeof row.snapshot().output.first_data_ms, 'number');
  assert.deepEqual({ ...row.snapshot().readers, last_destroy_ms: 0 }, { attached: 2, backpressure: 1, closed: 0, revoked: 0, last_destroy_ms: 0 });
  client.emit('close');
  assert.equal(row.snapshot().readers.closed, 1, 'A close without a bridge destroy is the client closing');
  const listener = reader(), full = reader(300_000);
  audio.write(frames[0]!);
  assert.equal(media.lateAudioSupported('fixture'), true);
  assert.equal(media.serveAudio(grant, listener as any), true);
  assert.equal(media.serveAudio(grant, full as any), true);
  audio.write(frames[1]!);
  assert.equal(full.destroyed, true, 'The 256 000 byte rule drops the full audio reader');
  assert.deepEqual({ ...row.snapshot().audio_readers, last_destroy_ms: 0 }, { attached: 2, backpressure: 1, closed: 0, revoked: 0, last_destroy_ms: 0 });
  media.revoke(grant);
  assert.equal(kept.destroyed, true); assert.equal(listener.destroyed, true);
  assert.deepEqual({ ...row.snapshot().readers, last_destroy_ms: 0 }, { attached: 2, backpressure: 1, closed: 1, revoked: 1, last_destroy_ms: 0 });
  assert.deepEqual({ ...row.snapshot().audio_readers, last_destroy_ms: 0 }, { attached: 2, backpressure: 1, closed: 0, revoked: 1, last_destroy_ms: 0 });
  assert.equal(typeof row.snapshot().readers.last_destroy_ms, 'number');
  media.stop('fixture');
  assert.deepEqual({ ...row.snapshot().readers, last_destroy_ms: 0 }, { attached: 2, backpressure: 1, closed: 1, revoked: 1, last_destroy_ms: 0 }, 'A stop after the revoke counts nothing twice');
  assert.ok(!JSON.stringify(row.snapshot()).includes('fixture'));
});
