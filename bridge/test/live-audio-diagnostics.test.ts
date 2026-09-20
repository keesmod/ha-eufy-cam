import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { LiveAudioDiagnostics } from '../src/live-audio-diagnostics.js';

// Synthetic ADTS header with a ten-byte frame. No captured camera audio.
const frame = Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x01, 0x5f, 0xfc, 1, 2, 3]);

test('observation does not consume buffered audio before the media consumer attaches', async () => {
  let now = 0;
  const reports = new LiveAudioDiagnostics(() => now);
  const row = reports.begin('T8134');
  const stream = new Readable({ read() {} });
  stream.push(frame);
  now = 3000;
  row.attach(stream, 'aac-lc', true, () => 'aac-lc');
  await setImmediate();
  assert.equal(stream.readableFlowing, null);
  assert.equal(stream.readableLength, frame.length);
  assert.equal(row.snapshot().initial_buffered_bytes, frame.length);
  assert.equal(row.snapshot().buffered_bytes, frame.length);
  assert.equal(row.snapshot().chunks, 0);
  const received: Buffer[] = [];
  stream.on('data', chunk => received.push(chunk));
  await setImmediate();
  assert.deepEqual(Buffer.concat(received), frame);
  assert.equal(row.snapshot().header, 'adts');
  assert.equal(row.snapshot().first_data_ms, 3000);
  row.finish('ended');
  assert.equal(stream.listenerCount('data'), 1);
  stream.destroy();
});

test('late excluded audio retains admission and records codec at first data, with fragmented headers', () => {
  let now = 0;
  let codec = 'none';
  const reports = new LiveAudioDiagnostics(() => now);
  const row = reports.begin('T8134');
  const stream = new PassThrough();
  now = 3000;
  row.attach(stream, codec, false, () => codec);
  const received: Buffer[] = [];
  stream.on('data', chunk => received.push(chunk));
  now = 5200;
  codec = 'aac-lc';
  stream.write(frame.subarray(0, 2));
  assert.equal(row.snapshot().header, 'incomplete');
  stream.write(frame.subarray(2));
  assert.deepEqual(Buffer.concat(received), frame);
  const { format, last_data_ms, last_data_age_ms, max_gap_ms, min_chunk_bytes, max_chunk_bytes, latest_codec, ...baseline } = row.snapshot();
  assert.equal(format?.adts_frames, 1);
  assert.equal(last_data_ms, 5200); assert.equal(last_data_age_ms, 0);
  assert.equal(max_gap_ms, 0); assert.equal(min_chunk_bytes, 2); assert.equal(max_chunk_bytes, 8);
  assert.equal(latest_codec, 'aac-lc');
  assert.deepEqual({ ...baseline, attempt: 1 }, {
    attempt: 1, model: 'T8134', state: 'streaming', chunks: 2, bytes: 10,
    initial_buffered_bytes: 0, buffered_bytes: 0, stream_ended: false, stream_destroyed: false,
    age_ms: 5200, duration_ms: 5200, metadata_ms: 3000, initial_codec: 'none',
    first_data_codec: 'aac-lc', admission: 'excluded', first_data_ms: 5200,
    first_data_after_metadata_ms: 2200, header: 'adts',
  });
  row.finish('ended');
  now = 5500;
  stream.write(frame);
  assert.equal(row.snapshot().bytes, 10);
  assert.equal(row.snapshot().duration_ms, 5200);
  reports.close();
  assert.equal(row.snapshot().state, 'ended');
  stream.destroy();
});

test('absent audio remains distinct from an unsupported header and codec', async () => {
  const reports = new LiveAudioDiagnostics();
  const absent = reports.begin('T8134');
  const stream = new PassThrough();
  absent.attach(stream, 'none', false, () => 'none');
  absent.finish('ended');
  assert.equal(absent.snapshot().header, undefined);
  assert.equal(absent.snapshot().first_data_ms, undefined);
  const unsupported = reports.begin('T8134');
  unsupported.attach(stream, 'unknown', false, () => 'unknown');
  stream.resume();
  stream.write(Buffer.alloc(7));
  await setImmediate();
  assert.equal(unsupported.snapshot().header, 'other');
  assert.equal(unsupported.snapshot().first_data_codec, 'unknown');
  reports.close();
  assert.equal(stream.listenerCount('data'), 0);
  stream.destroy();
});

test('reports are bounded, copied, sanitized and detach evicted observations', async () => {
  let now = 0;
  const reports = new LiveAudioDiagnostics(() => now);
  const streams = Array.from({ length: 10 }, () => new PassThrough());
  for (const stream of streams) {
    const row = reports.begin('T8134\nPRIVATE');
    row.attach(stream, 'PRIVATE', false, () => { throw new Error('PRIVATE'); });
    stream.resume();
    stream.write(frame);
    await setImmediate();
  }
  now = 200000;
  const snapshot = reports.report();
  assert.equal(snapshot.length, 8);
  assert.equal(new Set(snapshot.map(row => row.attempt)).size, 8);
  assert.equal(snapshot[0]!.first_data_codec, 'unavailable');
  assert.equal(snapshot[0]!.duration_ms, 200000, 'a raised session cap keeps durations beyond two minutes');
  let clock = 0;
  const long = new LiveAudioDiagnostics(() => clock).begin('T8425');
  clock = 3700000;
  long.finish('ended', true);
  assert.equal(long.snapshot().duration_ms, 3600000, 'times stay bounded to one hour');
  assert.ok(!JSON.stringify(snapshot).includes('PRIVATE'));
  assert.equal(streams[0]!.listenerCount('data'), 0);
  snapshot[0]!.bytes = 123;
  assert.equal(reports.report()[0]!.bytes, 10);
  reports.close();
  for (const stream of streams) {
    assert.equal(stream.listenerCount('data'), 0);
    stream.destroy();
  }
});


test('continuity and pipeline evidence survive close with bounded privacy and no payload', () => {
  let now = 0;
  const d = new LiveAudioDiagnostics(() => now);
  const row = d.begin('T8134', { firmware: '3.3.6.0', owner_model: 'T8030', owner_firmware: '3.8.5.2' });
  const stream = new PassThrough(); row.attach(stream, 'none', false, () => 'none');
  stream.on('data', () => {}); row.mark('audio_absent');
  now = 5000; stream.write(frame); now = 5700; stream.write(frame);
  for (let i = 0; i < 100; i++) row.mark('media_audio_error');
  row.mark('PRIVATE' as never); now = 10000; row.finish('ended');
  const r = row.snapshot();
  assert.equal(r.firmware, '3.3.6.0'); assert.equal(r.owner_model, 'T8030');
  assert.equal(r.latest_codec, 'none'); assert.equal(r.format?.adts_frames, 2);
  assert.equal(r.max_gap_ms, 700); assert.equal(r.last_data_age_ms, 4300);
  assert.deepEqual(r.pipeline, [{event:'audio_absent',elapsed_ms:0},{event:'media_audio_error',elapsed_ms:5700}]);
  assert.ok(!JSON.stringify(r).includes('PRIVATE'));
  const bad = d.begin('PRIVATE', { firmware: 'PRIVATE', owner_model:'PRIVATE', owner_firmware:'PRIVATE' });
  assert.ok(!JSON.stringify(bad.snapshot()).includes('PRIVATE')); stream.destroy();
});

test('the report keeps a row for fifteen minutes by default and for the live cap plus fifteen minutes when asked', () => {
  let now = 0;
  const reports = new LiveAudioDiagnostics(() => now);
  reports.begin('T8425');
  now = 899_999; assert.equal(reports.report().length, 1);
  now = 900_000; assert.equal(reports.report().length, 0);
  // A session that ran to a 1800-second cap is still in a report taken after its end.
  now = 1_800_000 + 600_000; assert.equal(reports.report(1_800_000 + 900_000).length, 1);
  now = 2_700_000; assert.equal(reports.report(2_700_000).length, 0);
});
