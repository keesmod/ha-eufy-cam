import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { LIVE_PLAYOUT_DELAY_MS, LivePacing, TrackPacer, liveSmoothing } from '../src/camera-clock.js';

/** A track on a mocked clock. `releases` holds each output chunk with the clock time it left at. */
function track(t: { mock: { timers: { enable(o: { apis: string[] }): void; tick(ms: number): void } } }, delay = LIVE_PLAYOUT_DELAY_MS) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 0;
  const pacer = new TrackPacer(delay, () => clock);
  const releases: { at: number; data: Buffer }[] = [];
  pacer.output.on('data', (data: Buffer) => releases.push({ at: clock, data }));
  const advance = (ms: number) => { for (let i = 0; i < ms; i++) { clock++; t.mock.timers.tick(1); } };
  const advanceTo = (time: number) => advance(Math.max(0, time - clock));
  let offset = 0;
  /** One frame: its timing first, then its bytes, like the library. */
  const frame = (timestampMs: number, bytes = 10, fill = 0) => {
    pacer.timing(offset, bytes, timestampMs);
    offset += bytes;
    pacer.data(Buffer.alloc(bytes, fill));
  };
  return { pacer, releases, advance, advanceTo, frame, now: () => clock };
}

test('frames delayed behind a key frame leave on the camera rhythm, never later than the delay', async (t) => {
  const f = track(t);
  // 15 fps on the camera clock. Each 30th frame, a key frame, arrives 500 ms
  // late and the two frames behind it wait for it, as measured in #230.
  const arrivals: { at: number; ts: number; index: number }[] = [];
  let held = 0;
  for (let i = 0; i < 150; i++) {
    const ts = 100_000 + i * 67;
    const late = i % 30 === 0 && i > 0 ? 500 : 0;
    held = late || Math.max(0, held - 67);
    arrivals.push({ at: 40 + i * 67 + held, ts, index: i });
  }
  arrivals.sort((a, b) => a.at - b.at || a.index - b.index);
  for (const arrival of arrivals) {
    f.advanceTo(arrival.at);
    f.frame(arrival.ts, 10, arrival.index % 256);
  }
  f.advance(LIVE_PLAYOUT_DELAY_MS + 10);
  assert.equal(f.releases.length, 150);
  assert.deepEqual(f.releases.map((r) => r.data[0]), Array.from({ length: 150 }, (_, i) => i % 256), 'order kept');
  const gaps = f.releases.slice(1).map((r, i) => r.at - f.releases[i].at);
  assert.ok(Math.max(...gaps) <= 68, `largest gap ${Math.max(...gaps)} ms`);
  for (const [i, release] of f.releases.entries()) {
    const arrival = arrivals.find((a) => a.index === i)!;
    assert.ok(release.at - arrival.at <= LIVE_PLAYOUT_DELAY_MS + 1, `frame ${i} waited ${release.at - arrival.at} ms`);
  }
});

test('a frame later than its slot leaves at once and keeps its place in the order', async (t) => {
  const f = track(t);
  f.frame(1000, 10, 1);
  f.advance(67);
  f.frame(1067, 10, 2);
  f.advance(1500);
  assert.equal(f.releases.length, 2);
  f.frame(1134, 10, 3);
  assert.equal(f.releases.length, 3, 'a frame 1.4 s late is not held');
  assert.equal(f.releases[2].at, f.now());
});

test('bytes without timing pass straight through in order, also before the first timing', async (t) => {
  const f = track(t);
  f.pacer.data(Buffer.from('ab'));
  assert.equal(f.releases.length, 1, 'untimed bytes are not held');
  // The library's offsets count every byte, so the first timed frame starts at 2.
  f.pacer.timing(2, 3, 5000);
  f.pacer.data(Buffer.from('cde'));
  f.pacer.data(Buffer.from('f'));
  assert.equal(Buffer.concat(f.releases.map((r) => r.data)).toString(), 'ab', 'the timed frame waits, and so does what follows it');
  f.advance(LIVE_PLAYOUT_DELAY_MS);
  assert.equal(Buffer.concat(f.releases.map((r) => r.data)).toString(), 'abcdef');
});

test('frames are cut by offset however the bytes are chunked', async (t) => {
  const f = track(t);
  f.pacer.timing(0, 4, 1000);
  f.pacer.timing(4, 3, 1067);
  f.pacer.timing(7, 5, 1134);
  for (const chunk of ['ab', 'cdefg', 'hijkl']) f.pacer.data(Buffer.from(chunk));
  f.advance(LIVE_PLAYOUT_DELAY_MS + 200);
  assert.deepEqual(f.releases.map((r) => r.data.toString()), ['abcd', 'efg', 'hijkl']);
  // They arrived together, so none waits longer than the first, whose slot
  // was set before the others were known. Order is kept.
  assert.deepEqual(f.releases.map((r) => r.at), [LIVE_PLAYOUT_DELAY_MS, LIVE_PLAYOUT_DELAY_MS, LIVE_PLAYOUT_DELAY_MS]);
});

test('invalid and overlapping timings are ignored', async (t) => {
  const f = track(t);
  for (const bad of [[-1, 4, 1], [0, 0, 1], [0, 4, -5], [0.5, 4, 1], [0, Number.NaN, 1]] as const) f.pacer.timing(bad[0], bad[1], bad[2]);
  f.pacer.timing(0, 4, 1000);
  f.pacer.timing(2, 4, 1067);
  f.pacer.data(Buffer.from('abcdefgh'));
  assert.equal(Buffer.concat(f.releases.map((r) => r.data)).toString(), '', 'the first frame waits for its slot');
  f.advance(LIVE_PLAYOUT_DELAY_MS);
  assert.equal(Buffer.concat(f.releases.map((r) => r.data)).toString(), 'abcdefgh', 'bytes after the only valid timing pass through behind it');
});

test('a backward camera clock jump restarts the anchor, so the next frame keeps its playout delay', async (t) => {
  const f = track(t);
  const base = 3_700_000;
  f.frame(base);
  f.advance(67);
  f.frame(base + 67);
  f.advance(1000);
  // The camera clock jumps back by an hour while the arrival keeps its pace.
  // Without the restart the old anchor would put this frame an hour in the
  // past and it would leave at once, unpaced.
  const arrival = f.now();
  f.frame(base + 134 - 3_600_000);
  assert.equal(f.releases.length, 2);
  f.advance(LIVE_PLAYOUT_DELAY_MS);
  assert.equal(f.releases.length, 3);
  assert.equal(f.releases[2].at - arrival, LIVE_PLAYOUT_DELAY_MS);
});

test('the anchor follows a delivery that becomes slower after the window', async (t) => {
  const f = track(t);
  let ts = 0;
  // Ten seconds at a 50 ms delivery lag, then a lag of 900 ms that persists.
  for (; ts < 10_000; ts += 67) { f.advanceTo(ts + 50); f.frame(10_000 + ts); }
  const before = f.releases.length;
  // Every 30th frame is a key frame 500 ms late and the frames behind it wait
  // for it. Only an anchor that moved to the new lag absorbs that again.
  let held = 0;
  for (let i = 0; ts < 30_000; ts += 67, i++) {
    held = i % 30 === 15 ? 500 : Math.max(0, held - 67);
    f.advanceTo(ts + 900 + held);
    f.frame(10_000 + ts);
  }
  f.advance(LIVE_PLAYOUT_DELAY_MS + 10);
  const late = f.releases.slice(before);
  const tail = late.slice(-100);
  const gaps = tail.slice(1).map((r, i) => r.at - tail[i].at);
  assert.ok(Math.max(...gaps) <= 68, 'smooth again once the window holds only the new lag');
});

test('the end of the source releases everything at once and ends the paced stream', async (t) => {
  const f = track(t);
  f.frame(1000, 4, 1);
  f.frame(1067, 4, 2);
  let ended = false;
  f.pacer.output.on('end', () => { ended = true; });
  f.pacer.end();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.releases.length, 2);
  assert.equal(ended, true);
  f.frame(1134);
  assert.equal(f.releases.length, 2, 'nothing after the end');
});

test('LivePacing routes timings by kind and mirrors end, close and errors of the library streams', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 0;
  const pacing = new LivePacing(LIVE_PLAYOUT_DELAY_MS, () => clock);
  const video = new PassThrough(), audio = new PassThrough();
  const paced = pacing.attach(video, audio);
  const got = { video: [] as string[], audio: [] as string[] };
  paced.video.on('data', (d: Buffer) => got.video.push(d.toString()));
  paced.audio.on('data', (d: Buffer) => got.audio.push(d.toString()));
  pacing.timing({ kind: 'video', offset: 0, bytes: 2, timestampMs: 5000, keyFrame: true });
  pacing.timing({ kind: 'audio', offset: 0, bytes: 1, timestampMs: 6200, keyFrame: false });
  pacing.timing({ kind: 'other', offset: 0, bytes: 1, timestampMs: 1 } as never);
  pacing.timing(undefined as never);
  video.write('vv');
  audio.write('a');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(got, { video: [], audio: [] }, 'each track waits for its own slot, audio is not tied to video');
  clock = LIVE_PLAYOUT_DELAY_MS;
  t.mock.timers.tick(LIVE_PLAYOUT_DELAY_MS);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(got, { video: ['vv'], audio: ['a'] });
  const errors: Error[] = [];
  paced.audio.on('error', (error) => errors.push(error));
  audio.destroy(new Error('transport'));
  let videoEnded = false;
  paced.video.on('end', () => { videoEnded = true; });
  video.end();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors[0]?.message, 'transport');
  assert.equal(videoEnded, true);
  // A paced stream that only gets drained, with no error listener of its own,
  // does not turn the library's error into an uncaught exception.
  const drained = new PassThrough(), quiet = new PassThrough();
  const third = new LivePacing(LIVE_PLAYOUT_DELAY_MS, () => clock).attach(drained, quiet);
  third.video.resume();
  drained.destroy(new Error('transport'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(third.video.destroyed, true);
  const replaced = new PassThrough(), other = new PassThrough();
  const second = new LivePacing(LIVE_PLAYOUT_DELAY_MS, () => clock).attach(replaced, other);
  replaced.destroy();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(second.video.destroyed, true, 'a stream destroyed without its end closes the paced stream');
});

test('EUFY_LIVE_SMOOTHING defaults to on and accepts only true or false', () => {
  assert.equal(liveSmoothing(undefined), true);
  assert.equal(liveSmoothing(''), true);
  assert.equal(liveSmoothing('true'), true);
  assert.equal(liveSmoothing('false'), false);
  for (const bad of ['0', 'off', 'FALSE', ' false', 'yes']) assert.throws(() => liveSmoothing(bad), /EUFY_LIVE_SMOOTHING/, bad);
});
