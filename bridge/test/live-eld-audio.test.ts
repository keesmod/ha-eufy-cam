import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { ELD_CONFIG } from '../src/eld-audio.js';
import { ELD_PCM, LiveAudioUnits, LiveEldAudio, liveEldEncoderArgs, logLiveEld, type LiveEldReport } from '../src/live-eld-audio.js';
import { LateAudio } from '../src/late-audio.js';
import { LivePacing } from '../src/camera-clock.js';

/** A child process whose pipes the test drives. */
class Child extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid: number | undefined = 4242;
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed: string[] = [];
  written: Buffer[] = [];
  /** Answers kill with close, unless the test keeps the process alive. */
  constructor(private readonly closeOnKill = true) {
    super();
    this.stdin.on('data', (chunk: Buffer) => this.written.push(Buffer.from(chunk)));
  }
  kill(signal: string) {
    this.killed.push(signal);
    if (this.closeOnKill) queueMicrotask(() => this.exit(null, signal));
    return true;
  }
  exit(code: number | null, signal: string | null = null) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code; this.signalCode = signal;
    this.emit('close', code, signal);
  }
}
function launcher(options: { closeOnKill?: boolean; throws?: 'decoder' | 'encoder' } = {}) {
  const calls: { command: string; args: string[] }[] = [];
  const children: Child[] = [];
  const launch = (command: string, args: string[]) => {
    calls.push({ command, args });
    if (options.throws === (command === 'ffmpeg' ? 'encoder' : 'decoder')) throw new Error('spawn failed');
    const child = new Child(options.closeOnKill ?? true);
    children.push(child);
    return child as unknown as ChildProcess;
  };
  return { calls, children, launch };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
/** A source with timed units, as the library pushes them. */
function stage(codec: unknown = 'aac-eld', options: { closeOnKill?: boolean; throws?: 'decoder' | 'encoder'; cleanupMs?: number } = {}) {
  const source = new PassThrough();
  const units = new LiveAudioUnits();
  const reports: LiveEldReport[] = [];
  const processes = launcher(options);
  let time = 1000;
  const eld = new LiveEldAudio(source, units, () => codec, {
    launch: processes.launch, log: report => reports.push(report), now: () => time, cleanupMs: options.cleanupMs ?? 1000,
  });
  const out: Buffer[] = [];
  eld.output.on('data', (chunk: Buffer) => out.push(chunk));
  let offset = 0, stamp = 0;
  const push = (unit: Buffer) => {
    units.timing({ kind: 'audio', offset, bytes: unit.length, timestampMs: stamp });
    offset += unit.length; stamp += 30;
    source.write(unit);
  };
  return { source, units, eld, reports, out, push, ...processes, advance: (ms: number) => { time += ms; } };
}
const framed = (units: Buffer[]) => Buffer.concat(units.flatMap(unit => { const n = Buffer.alloc(2); n.writeUInt16BE(unit.length); return [n, unit]; }));
const adts = (payload: number) => {
  const length = 7 + payload, frame = Buffer.alloc(length);
  frame[0] = 0xff; frame[1] = 0xf1; frame[2] = 0x60; frame[3] = 0x40 | ((length >> 11) & 3);
  frame[4] = (length >> 3) & 0xff; frame[5] = ((length & 7) << 5) | 0x1f; frame[6] = 0xfc;
  return frame;
};

test('audio units follow the frame timing across chunks and drop untimed bytes (#269)', () => {
  const units = new LiveAudioUnits();
  units.timing({ kind: 'video', offset: 0, bytes: 500 });
  units.timing({ kind: 'audio', offset: 4, bytes: 3 });
  units.timing({ kind: 'audio', offset: 7, bytes: 2 });
  units.timing({ kind: 'audio', offset: 8, bytes: 2 });
  units.timing({ kind: 'audio', offset: 9, bytes: 4 });
  assert.deepEqual(units.split(Buffer.from([9, 9, 9, 9, 1, 1])), [], 'the first unit is still incomplete');
  assert.deepEqual(units.split(Buffer.from([1, 2, 2, 3, 3, 3])), [Buffer.from([1, 1, 1]), Buffer.from([2, 2])]);
  assert.equal(units.skipped, 4, 'bytes before the first timing are dropped');
  assert.deepEqual(units.split(Buffer.from([3, 4, 4])), [Buffer.from([3, 3, 3, 3])], 'an overlapping timing is ignored');
  assert.equal(units.skipped, 6, 'bytes without any timing are dropped');
  units.timing({ kind: 'audio', offset: 20, bytes: 2 });
  assert.deepEqual(units.split(Buffer.from([0, 0, 0, 0, 0, 7, 7, 8])), [Buffer.from([7, 7])], 'a gap is skipped up to the next unit');
  assert.equal(units.broken, undefined);
  units.close();
  units.timing({ kind: 'audio', offset: 22, bytes: 2 });
  assert.deepEqual(units.split(Buffer.from([5, 5])), [], 'a closed splitter returns nothing');
});

test('audio units break on an impossible size or too many waiting timings (#269)', () => {
  for (const bytes of [0, 8193]) {
    const units = new LiveAudioUnits();
    units.timing({ kind: 'audio', offset: 0, bytes });
    assert.equal(units.broken, 'frames_size', String(bytes));
  }
  const ok = new LiveAudioUnits();
  ok.timing({ kind: 'audio', offset: 0, bytes: 8192 });
  ok.timing({ kind: 'audio', offset: -1, bytes: 1 });
  ok.timing({ kind: 'audio', offset: 8192, bytes: 1.5 });
  assert.equal(ok.broken, undefined, 'malformed numbers are ignored');
  const many = new LiveAudioUnits();
  for (let i = 0; i < 1024; i++) many.timing({ kind: 'audio', offset: i, bytes: 1 });
  assert.equal(many.broken, undefined);
  many.timing({ kind: 'audio', offset: 1024, bytes: 1 });
  assert.equal(many.broken, 'frames_overflow');
});

test('ADTS and other codecs pass through unchanged and start no process (#269)', async () => {
  for (const codec of ['aac', 'aac-lc', 'none', 'unknown', null]) {
    const s = stage(codec);
    const bytes = [adts(20), adts(5), Buffer.from([1, 2, 3])];
    for (const chunk of bytes) s.push(chunk);
    s.source.end();
    await tick();
    assert.deepEqual(Buffer.concat(s.out), Buffer.concat(bytes), String(codec));
    assert.equal(s.calls.length, 0);
    assert.equal(s.eld.output.readableEnded, true);
    assert.equal(await s.eld.stop(), true);
    assert.equal(s.reports.length, 0, 'passthrough writes no decode line');
  }
  const failing = stage('aac');
  failing.push(adts(3));
  const seen: unknown[] = [];
  failing.eld.output.on('error', error => seen.push(error));
  failing.source.destroy(new Error('transport'));
  await tick();
  assert.equal((seen[0] as Error).message, 'transport', 'a transport error still reaches the audio consumer');
  const replaced = stage('aac');
  replaced.push(adts(3));
  replaced.source.destroy();
  await tick();
  assert.equal(replaced.eld.output.destroyed, true, 'a destroyed source destroys the output');
  const unreadable = stage();
  const source = new PassThrough();
  const eld = new LiveEldAudio(source, new LiveAudioUnits(), () => { throw new Error('gone'); }, { launch: unreadable.launch });
  const out: Buffer[] = [];
  eld.output.on('data', (chunk: Buffer) => out.push(chunk));
  source.write(Buffer.from([4, 5]));
  await tick();
  assert.deepEqual(out, [Buffer.from([4, 5])], 'an unreadable codec keeps the previous path');
});

test('AAC-ELD units reach the helper framed, and its PCM reaches FFmpeg and the output (#269)', async () => {
  const s = stage();
  const units = [Buffer.alloc(71, 0x5a), Buffer.alloc(142, 0x33), Buffer.alloc(90, 0x11)];
  s.push(units[0]!);
  await tick();
  assert.deepEqual(s.calls, [
    { command: '/usr/local/bin/eufy-eld-decode', args: ['--stream', ELD_CONFIG, '16000', '1'] },
    { command: 'ffmpeg', args: liveEldEncoderArgs() },
  ]);
  const [decoder, encoder] = s.children as [Child, Child];
  // Two units arrive in one chunk, and the PCM comes back between them.
  decoder.stdout.write(Buffer.alloc(960, 1));
  s.units.timing({ kind: 'audio', offset: 71, bytes: 142, timestampMs: 40 });
  s.units.timing({ kind: 'audio', offset: 213, bytes: 90, timestampMs: 60 });
  s.source.write(Buffer.concat([units[1]!, units[2]!]));
  await tick();
  assert.deepEqual(Buffer.concat(decoder.written), framed(units));
  assert.deepEqual(Buffer.concat(encoder.written), Buffer.alloc(960, 1), 'PCM flows from the helper into FFmpeg');
  s.advance(180);
  encoder.stdout.write(adts(10));
  decoder.stderr.write('units=3 errors=1\n');
  await tick();
  assert.deepEqual(Buffer.concat(s.out), adts(10));
  assert.equal(s.source.isPaused(), false, 'the source keeps flowing');
  s.advance(1000);
  // The end of the source alone stops both processes and ends the output.
  s.source.end();
  await tick(); await tick();
  assert.deepEqual(decoder.killed, ['SIGKILL']); assert.deepEqual(encoder.killed, ['SIGKILL']);
  assert.equal(s.eld.output.readableEnded, true);
  assert.equal(s.reports.length, 1);
  assert.equal(await s.eld.stop(), true);
  assert.deepEqual(s.reports, [{
    diagnostic: 'live_audio', event: 'eld_decode', outcome: 'ended', units: 3, errors: 1, frame_ms: 30, output_bytes: 17,
    first_output_ms: 180, duration_ms: 1180, skipped_bytes: 0, stop_confirmed: true,
  }]);
  assert.equal(await s.eld.stop(), true, 'a second stop changes nothing');
  assert.equal(s.reports.length, 1);
});

test('decoded AAC-ELD reaches the late audio reader as complete ADTS frames (#269)', async () => {
  const s = stage();
  const frames: Buffer[] = [];
  let ready = false;
  const reader = new LateAudio(s.eld.output, () => { ready = true; }, frame => frames.push(frame));
  s.push(Buffer.alloc(80, 7));
  await tick();
  const encoder = s.children[1]!;
  const frame = adts(30);
  encoder.stdout.write(frame.subarray(0, 9));
  encoder.stdout.write(frame.subarray(9));
  await tick();
  assert.equal(ready, true);
  assert.deepEqual(frames, [frame]);
  reader.stop();
  await s.eld.stop();
});

test('every decoding failure ends only the audio output and stops both processes (#269)', async () => {
  const cases: [string, (s: ReturnType<typeof stage>) => void, Partial<LiveEldReport>][] = [
    ['decoder_unavailable', s => s.children[0]!.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' })), {}],
    ['decoder_failed', s => s.children[0]!.exit(4), { exit_code: 4 }],
    ['decode_errors', s => { s.children[0]!.stderr.write('units=50 errors=38\n'); s.children[0]!.exit(7); }, { exit_code: 7, errors: 38 }],
    ['encoder_unavailable', s => s.children[1]!.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' })), {}],
    ['encoder_failed', s => s.children[1]!.exit(1), { exit_code: 1 }],
    ['frames_size', s => { s.units.timing({ kind: 'audio', offset: 80, bytes: 9000 }); s.source.write(Buffer.alloc(10)); }, {}],
  ];
  for (const [outcome, cause, extra] of cases) {
    const s = stage();
    s.push(Buffer.alloc(80, 7));
    await tick();
    cause(s);
    await tick(); await tick();
    assert.equal(s.eld.output.readableEnded, true, outcome);
    for (const child of s.children) if (child.exitCode === null && child.signalCode === null) assert.fail(`${outcome}: a process is still running`);
    assert.equal(s.reports[0]?.outcome, outcome);
    assert.equal(s.reports[0]?.stop_confirmed, true, outcome);
    for (const [key, value] of Object.entries(extra)) assert.equal(s.reports[0]?.[key as keyof LiveEldReport], value, `${outcome} ${key}`);
    // Later audio drains without reaching either process.
    const before = s.children[0]!.written.length;
    s.push(Buffer.alloc(80, 8));
    await tick();
    assert.equal(s.children[0]!.written.length, before, outcome);
  }
  for (const role of ['decoder', 'encoder'] as const) {
    const s = stage('aac-eld', { throws: role });
    s.push(Buffer.alloc(80, 7));
    await tick(); await tick();
    assert.equal(s.reports[0]?.outcome, `${role}_unavailable`);
    assert.equal(s.eld.output.readableEnded, true);
    assert.equal(s.children.every(child => child.killed.length === 1), true, 'a started helper is stopped');
  }
});

test('a burst after a stall may wait, a helper that does not answer for two seconds ends the audio (#269)', async () => {
  const s = stage();
  // A P2P stall releases many units in one go, before any PCM can come back.
  for (let i = 0; i < 200; i++) s.push(Buffer.alloc(40, i));
  await tick();
  assert.equal(s.reports.length, 0, 'a burst is no backlog');
  assert.equal(s.children[0]!.written.length > 0, true);
  // All PCM came back, so later units start a new wait.
  s.children[0]!.stdout.write(Buffer.alloc(200 * ELD_PCM.frame * 2));
  await tick();
  s.advance(5000);
  s.push(Buffer.alloc(40, 1));
  await tick();
  assert.equal(s.reports.length, 0, 'an answered helper is not behind');
  s.advance(2000);
  s.push(Buffer.alloc(40, 2));
  await tick();
  assert.equal(s.reports.length, 0, 'two seconds may pass');
  s.advance(1);
  s.push(Buffer.alloc(40, 3));
  await tick(); await tick();
  assert.equal(s.reports[0]?.outcome, 'backlog');
  assert.equal(s.reports[0]?.units, 203, 'the verdict follows the next I/O phase');
  assert.equal(s.eld.output.readableEnded, true);
});

test('PCM in uneven chunks answers only whole units (#269)', async () => {
  for (const [bytes, outcome] of [[199 * 960 + 500, 'backlog'], [200 * 960, undefined]] as const) {
    const s = stage();
    for (let i = 0; i < 200; i++) s.push(Buffer.alloc(40, i));
    await tick();
    s.children[0]!.stdout.write(Buffer.alloc(1000));
    s.children[0]!.stdout.write(Buffer.alloc(bytes - 1000));
    await tick();
    s.advance(2001);
    s.push(Buffer.alloc(40, 1));
    await tick(); await tick();
    assert.equal(s.reports[0]?.outcome, outcome, `${bytes} bytes`);
    await s.eld.stop();
  }
});

test('a helper slower than the camera ends the audio once it is two seconds behind (#269)', async () => {
  const s = stage();
  let time = 0, answered = 0;
  for (let i = 0; i < 400 && !s.reports.length; i++) {
    s.push(Buffer.alloc(40, i & 0xff));
    await tick();
    // One unit every 40 ms against one every 30 ms from the camera.
    const due = Math.floor(time / 40);
    if (due > answered) { s.children[0]!.stdout.write(Buffer.alloc((due - answered) * 960)); answered = due; }
    await tick();
    s.advance(30); time += 30;
  }
  assert.equal(s.reports[0]?.outcome, 'backlog');
  // The oldest waiting unit was written at 30 ms per unit and answered at 40, so it is 2 s old near 8 s.
  assert.ok(s.reports[0]!.units > 260 && s.reports[0]!.units < 280, String(s.reports[0]!.units));
});

test('PCM that is already in the pipe counts before an old unit ends the audio (#269)', async () => {
  const s = stage();
  const decoder = () => s.children[0]!;
  s.push(Buffer.alloc(40, 1));
  await tick();
  // The event loop was blocked. An immediate queued before the next unit
  // stands in for the read of PCM already in the pipe, before the verdict.
  s.advance(2500);
  setImmediate(() => decoder().stdout.write(Buffer.alloc(2 * 960)));
  s.push(Buffer.alloc(40, 2));
  await tick(); await tick();
  assert.equal(s.reports.length, 0);
  assert.equal(s.eld.output.readableEnded, false);
  // The check stays armed: a helper that stalls later still ends the audio.
  s.push(Buffer.alloc(40, 3));
  await tick();
  s.advance(2001);
  s.push(Buffer.alloc(40, 4));
  await tick(); await tick();
  assert.equal(s.reports[0]?.outcome, 'backlog');
});

test('at most 4096 units wait for their PCM (#269)', async () => {
  const s = stage();
  for (let i = 0; i < 4097; i++) s.push(Buffer.alloc(4, i & 0xff));
  await tick(); await tick();
  assert.equal(s.reports[0]?.outcome, 'backlog');
  assert.equal(s.reports[0]?.units, 4096);
});

test('the camera clock gives the mean step per unit, or nothing (#269)', () => {
  const units = new LiveAudioUnits();
  assert.equal(units.frameMs(), null);
  let offset = 0;
  for (const stamp of [1000, 1040, 1040, 1080, 1120, 1160, 1160, 1210]) { units.timing({ kind: 'audio', offset, bytes: 10, timestampMs: stamp }); offset += 10; }
  assert.equal(units.frameMs(), 30);
  units.close();
  assert.equal(units.frameMs(), 30, 'kept after close for the log line');
  const still = new LiveAudioUnits();
  still.timing({ kind: 'audio', offset: 0, bytes: 1, timestampMs: 5 }); still.timing({ kind: 'audio', offset: 1, bytes: 1, timestampMs: 5 });
  assert.equal(still.frameMs(), null, 'equal stamps say nothing');
  const unstamped = new LiveAudioUnits();
  unstamped.timing({ kind: 'audio', offset: 0, bytes: 1 }); unstamped.timing({ kind: 'audio', offset: 1, bytes: 1, timestampMs: -1 });
  assert.equal(unstamped.frameMs(), null);
  // The bounds apply to the step as logged.
  const near = new LiveAudioUnits();
  near.timing({ kind: 'audio', offset: 0, bytes: 1, timestampMs: 0 }); near.timing({ kind: 'audio', offset: 1, bytes: 1, timestampMs: 999_999 });
  for (let i = 2; i < 1001; i++) near.timing({ kind: 'audio', offset: i, bytes: 1, timestampMs: 999_999 });
  assert.equal(near.frameMs(), null, '999.999 ms logs as 1000');
});

test('a stop is confirmed only when both processes closed, within the cleanup limit (#269)', async () => {
  const s = stage('aac-eld', { closeOnKill: false, cleanupMs: 20 });
  s.push(Buffer.alloc(80, 7));
  await tick();
  assert.equal(await s.eld.stop(), false);
  assert.equal(s.reports[0]?.stop_confirmed, false);
  assert.deepEqual(s.children.map(child => child.killed), [['SIGKILL'], ['SIGKILL']]);
  const early = stage();
  assert.equal(await early.eld.stop(), true, 'nothing to stop before audio');
  early.push(Buffer.alloc(80, 7));
  await tick();
  assert.equal(early.calls.length, 0, 'audio after a stop starts nothing');
  assert.equal(early.reports.length, 0);
});

test('a source error or close also stops the decoding (#269)', async () => {
  for (const how of ['error', 'close'] as const) {
    const s = stage();
    s.push(Buffer.alloc(80, 7));
    await tick();
    const errors: Error[] = [];
    s.eld.output.on('error', error => errors.push(error));
    if (how === 'error') s.source.destroy(new Error('transport')); else s.source.destroy();
    await tick(); await tick();
    assert.equal(s.reports[0]?.outcome, 'ended', how);
    assert.equal(s.eld.output.destroyed, true, how);
    assert.equal(errors.length, how === 'error' ? 1 : 0, how);
  }
});

test('paced AAC-ELD keeps its unit boundaries (#269)', async () => {
  const pacing = new LivePacing(10);
  const video = new PassThrough(), audio = new PassThrough(), units = new LiveAudioUnits();
  const paced = pacing.attach(video, audio);
  const processes = launcher();
  const eld = new LiveEldAudio(paced.audio, units, () => 'aac-eld', { launch: processes.launch, log: () => {} });
  const parts = [Buffer.alloc(60, 1), Buffer.alloc(75, 2), Buffer.alloc(66, 3)];
  let offset = 0;
  parts.forEach((part, i) => {
    const timing = { kind: 'audio' as const, offset, bytes: part.length, timestampMs: 30 * i, keyFrame: false };
    pacing.timing(timing); units.timing(timing);
    offset += part.length;
  });
  // The library's bytes arrive in one burst, and pacing releases them later.
  audio.write(Buffer.concat(parts));
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(Buffer.concat(processes.children[0]!.written), framed(parts));
  await eld.stop();
});

test('the decode line is information after a confirmed end and a warning otherwise (#269)', () => {
  const base: LiveEldReport = { diagnostic: 'live_audio', event: 'eld_decode', outcome: 'ended', units: 1, output_bytes: 0, duration_ms: 1, skipped_bytes: 0, stop_confirmed: true };
  for (const [report, level] of [[base, 'info'], [{ ...base, stop_confirmed: false }, 'warn'], [{ ...base, outcome: 'backlog' as const }, 'warn']] as const) {
    const lines: string[] = [];
    logLiveEld(report, line => lines.push(`warn ${line}`), line => lines.push(`info ${line}`));
    assert.deepEqual(lines, [`${level} ${JSON.stringify(report)}`]);
  }
});

test('the encoder reads 16 kHz mono PCM and writes ADTS AAC-LC without buffering (#269)', () => {
  const args = liveEldEncoderArgs();
  const input = args.indexOf('-i');
  assert.deepEqual(args.slice(input - 6, input + 2), ['-f', 's16le', '-ar', '16000', '-ac', '1', '-i', 'pipe:0']);
  assert.deepEqual(args.slice(input + 2), ['-c:a', 'aac', '-b:a', '64k', '-f', 'adts', '-flush_packets', '1', 'pipe:1']);
});
