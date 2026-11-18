import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { AudioFrameLog, ELD_CONFIG, eldDecoder } from '../src/eld-audio.js';

class Helper extends EventEmitter {
  stdout = new PassThrough();
  killed: string[] = [];
  kill(signal: string) { this.killed.push(signal); queueMicrotask(() => this.emit('close', null)); return true; }
}
const units = [Buffer.alloc(71, 0x5a), Buffer.alloc(142, 0x33), Buffer.alloc(90, 0x11)];
function frames(list = units, step = 30) {
  const log = new AudioFrameLog();
  let offset = 0;
  list.forEach((unit, i) => { log.add({ offset, bytes: unit.length, timestampMs: 1000 + step * i }); offset += unit.length; });
  return log;
}
function workspace(audio = Buffer.concat(units)) {
  const directory = mkdtempSync(join(tmpdir(), 'eufy-test-eld-'));
  writeFileSync(join(directory, 'audio'), audio);
  return { directory, audio: join(directory, 'audio'), done: () => rmSync(directory, { recursive: true, force: true }) };
}
/** A fake helper that answers with `stdout` and `code` after recording its call. */
function helper(stdout: string, code: number | null = 0) {
  const calls: { command: string; args: string[]; framed?: Buffer }[] = [];
  const children: Helper[] = [];
  const launch = (command: string, args: string[]) => {
    calls.push({ command, args, framed: readFileSync(args[1]!) });
    const child = new Helper(); children.push(child);
    setImmediate(() => { child.stdout.end(stdout); child.emit('close', code); });
    return child as unknown as ChildProcess;
  };
  return { calls, children, launch };
}

test('the frame log keeps contiguous unit lengths and their mean step (#264)', () => {
  const log = frames();
  assert.deepEqual(log.lengths, [71, 142, 90]);
  assert.equal(log.bytes, 303); assert.equal(log.broken, undefined); assert.equal(log.frameMs(), 30);
  // Coarse 40 ms stamps on 30 ms units still average 30.
  const coarse = new AudioFrameLog();
  let offset = 0;
  for (const stamp of [0, 0, 40, 80, 120, 120, 160, 200, 240]) { coarse.add({ offset, bytes: 10, timestampMs: stamp }); offset += 10; }
  assert.equal(coarse.frameMs(), 30);
  assert.equal(new AudioFrameLog().frameMs(), null);
  const still = new AudioFrameLog();
  still.add({ offset: 0, bytes: 10, timestampMs: 5 }); still.add({ offset: 10, bytes: 10, timestampMs: 5 });
  assert.equal(still.frameMs(), null, 'equal stamps say nothing');
  const gap = new AudioFrameLog();
  gap.add({ offset: 0, bytes: 10, timestampMs: 0 }); gap.add({ offset: 11, bytes: 10, timestampMs: 30 }); gap.add({ offset: 10, bytes: 10, timestampMs: 30 });
  assert.equal(gap.broken, 'frames_gap'); assert.deepEqual(gap.lengths, [10], 'nothing is recorded after a break');
  const size = new AudioFrameLog();
  size.add({ offset: 0, bytes: 8193, timestampMs: 0 });
  assert.equal(size.broken, 'frames_size');
  const empty = new AudioFrameLog();
  empty.add({ offset: 0, bytes: 0, timestampMs: 0 });
  assert.equal(empty.broken, 'frames_size');
  const overflow = new AudioFrameLog();
  for (let i = 0; i <= 16384; i++) overflow.add({ offset: i, bytes: 1, timestampMs: i });
  assert.equal(overflow.broken, 'frames_overflow'); assert.equal(overflow.lengths.length, 16384);
});

test('the decoder gets each unit with a big-endian length and the S4 config (#264)', async () => {
  const w = workspace(), fake = helper('rate=16000 channels=1 frame=480 units=3 errors=0\n');
  try {
    const result = await eldDecoder(fake.launch)({ audio: w.audio, frames: frames(), directory: w.directory }, new AbortController().signal);
    assert.deepEqual(result, { outcome: 'decoded', pcm: { path: join(w.directory, 'audio.pcm'), rate: 16000, channels: 1 }, units: 3, errors: 0 });
    assert.equal(ELD_CONFIG, 'f8f03000');
    assert.deepEqual(fake.calls[0]!.args, [ELD_CONFIG, join(w.directory, 'audio.eld'), join(w.directory, 'audio.pcm')]);
    assert.equal(fake.calls[0]!.command, process.env.EUFY_ELD_DECODER || '/usr/local/bin/eufy-eld-decode');
    const framed = fake.calls[0]!.framed!;
    assert.deepEqual(framed, Buffer.concat(units.map(unit => Buffer.concat([Buffer.from([unit.length >> 8, unit.length & 255]), unit]))));
  } finally { w.done(); }
});

test('a decoder report that does not fit the units keeps the recording muted (#264)', async () => {
  const cases: [string, number | null, object][] = [
    ['rate=16000 channels=1 frame=480 units=3 errors=0\n', 0, { outcome: 'decoded', units: 3, errors: 0 }],
    ['rate=16000 channels=1 frame=480 units=3 errors=2\n', 0, { outcome: 'decode_errors', units: 3, errors: 2 }],
    ['rate=16000 channels=1 frame=480 units=2 errors=0\n', 0, { outcome: 'decoder_output', units: 3, exit_code: 0 }],
    ['rate=96000 channels=1 frame=480 units=3 errors=0\n', 0, { outcome: 'decoder_output', units: 3, exit_code: 0 }],
    ['rate=16000 channels=3 frame=480 units=3 errors=0\n', 0, { outcome: 'decoder_output', units: 3, exit_code: 0 }],
    ['garbage', 0, { outcome: 'decoder_output', units: 3, exit_code: 0 }],
    ['', 3, { outcome: 'decoder_failed', units: 3, exit_code: 3 }],
    ['', null, { outcome: 'decoder_failed', units: 3, exit_code: null }],
  ];
  for (const [stdout, code, expected] of cases) {
    const w = workspace(), fake = helper(stdout, code);
    try {
      const result = await eldDecoder(fake.launch)({ audio: w.audio, frames: frames(), directory: w.directory }, new AbortController().signal);
      const { pcm, ...rest } = result;
      assert.deepEqual(rest, expected, stdout || String(code));
      assert.equal(pcm !== undefined, result.outcome === 'decoded');
    } finally { w.done(); }
  }
  // Up to one unit in ten may fail, as a lost P2P message does.
  const many = Array.from({ length: 20 }, (_, i) => Buffer.alloc(40 + i, i));
  for (const [errors, outcome] of [[2, 'decoded'], [3, 'decode_errors']] as const) {
    const w = workspace(Buffer.concat(many)), fake = helper(`rate=16000 channels=1 frame=480 units=20 errors=${errors}\n`);
    try {
      const result = await eldDecoder(fake.launch)({ audio: w.audio, frames: frames(many), directory: w.directory }, new AbortController().signal);
      assert.equal(result.outcome, outcome); assert.equal(result.errors, errors);
    } finally { w.done(); }
  }
});

test('missing frames, a size mismatch or a missing file never start the decoder (#264)', async () => {
  const fake = helper('rate=16000 channels=1 frame=480 units=3 errors=0\n');
  const decode = eldDecoder(fake.launch), signal = new AbortController().signal;
  const w = workspace(Buffer.concat(units).subarray(1));
  try {
    assert.deepEqual(await decode({ audio: w.audio, frames: frames(), directory: w.directory }, signal), { outcome: 'frames_mismatch' });
    assert.deepEqual(await decode({ audio: w.audio, frames: new AudioFrameLog(), directory: w.directory }, signal), { outcome: 'no_frames' });
    const broken = frames(); broken.add({ offset: 0, bytes: 1, timestampMs: 0 });
    assert.deepEqual(await decode({ audio: w.audio, frames: broken, directory: w.directory }, signal), { outcome: 'frames_gap' });
    assert.deepEqual(await decode({ audio: join(w.directory, 'missing'), frames: frames(), directory: w.directory }, signal), { outcome: 'io' });
    const aborted = new AbortController(); aborted.abort();
    assert.deepEqual(await decode({ audio: w.audio, frames: frames(), directory: w.directory }, aborted.signal), { outcome: 'cancelled' });
    assert.equal(fake.calls.length, 0);
  } finally { w.done(); }
});

test('a missing, hanging or cancelled decoder is stopped and reported (#264)', async () => {
  const signal = new AbortController().signal;
  const w = workspace();
  try {
    const missing = (() => { const child = new Helper(); setImmediate(() => child.emit('error', Object.assign(new Error('spawn'), { code: 'ENOENT' }))); return child as unknown as ChildProcess; });
    assert.deepEqual(await eldDecoder(missing)({ audio: w.audio, frames: frames(), directory: w.directory }, signal), { outcome: 'decoder_unavailable', units: 3 });
    const throws = () => { throw new Error('spawn'); };
    assert.deepEqual(await eldDecoder(throws)({ audio: w.audio, frames: frames(), directory: w.directory }, signal), { outcome: 'decoder_unavailable', units: 3 });
    const hung: Helper[] = [];
    const hang = () => { const child = new Helper(); hung.push(child); return child as unknown as ChildProcess; };
    assert.deepEqual(await eldDecoder(hang, 20)({ audio: w.audio, frames: frames(), directory: w.directory }, signal), { outcome: 'timeout', units: 3 });
    assert.deepEqual(hung[0]!.killed, ['SIGKILL']);
    const controller = new AbortController();
    const pending = eldDecoder(hang, 5000)({ audio: w.audio, frames: frames(), directory: w.directory }, controller.signal);
    setTimeout(() => controller.abort(), 10);
    assert.deepEqual(await pending, { outcome: 'cancelled', units: 3 });
    assert.deepEqual(hung[1]!.killed, ['SIGKILL']);
  } finally { w.done(); }
});

test('a cancel during the file work or the launch never leaves the decoder running (#264)', async () => {
  const w = workspace();
  try {
    const fake = helper('rate=16000 channels=1 frame=480 units=3 errors=0\n');
    const early = new AbortController();
    const pending = eldDecoder(fake.launch)({ audio: w.audio, frames: frames(), directory: w.directory }, early.signal);
    early.abort();
    assert.deepEqual(await pending, { outcome: 'cancelled', units: 3 });
    assert.equal(fake.calls.length, 0, 'aborted while the units were written: no launch');
    const during = new AbortController(), started: Helper[] = [];
    const launch = () => { const child = new Helper(); started.push(child); during.abort(); return child as unknown as ChildProcess; };
    assert.deepEqual(await eldDecoder(launch, 5000)({ audio: w.audio, frames: frames(), directory: w.directory }, during.signal), { outcome: 'cancelled', units: 3 });
    assert.deepEqual(started[0]!.killed, ['SIGKILL']);
  } finally { w.done(); }
});

test('units whose timestamps disagree with the config are left out, not played at the wrong speed (#264)', async () => {
  const many = Array.from({ length: 120 }, (_, i) => Buffer.alloc(60 + (i % 40), i + 1));
  const cases: [Buffer[], number, string][] = [
    [many, 60, 'cadence_mismatch'], // 8 kHz audio read as 16 kHz
    [many, 20, 'cadence_mismatch'], // 24 kHz audio read as 16 kHz
    [many, 32, 'cadence_mismatch'], // 512-sample frames read as 480, 6.7 percent off
    [many, 23, 'cadence_mismatch'], // 22.05 kHz with 512 samples
    [many, 31, 'decoded'], // within 5 percent
    [many, 30, 'decoded'],
    [many, 0, 'decoded'], // no usable clock
    [many.slice(0, 99), 60, 'decoded'], // too few units to judge
  ];
  for (const [list, step, outcome] of cases) {
    const w = workspace(Buffer.concat(list)), fake = helper(`rate=16000 channels=1 frame=480 units=${list.length} errors=0\n`);
    try {
      const result = await eldDecoder(fake.launch)({ audio: w.audio, frames: frames(list, step), directory: w.directory }, new AbortController().signal);
      assert.equal(result.outcome, outcome, `${list.length} units ${step} ms apart`);
      assert.equal(result.pcm !== undefined, outcome === 'decoded');
    } finally { w.done(); }
  }
});

test('a stopped decoder counts only once its exit is confirmed (#264)', async () => {
  const signal = new AbortController().signal;
  const w = workspace();
  try {
    // The exit arrives 40 ms after the kill: the timeout waits for it.
    let closed = false;
    const slow = () => {
      const child = new Helper();
      child.kill = (sig: string) => { child.killed.push(sig); setTimeout(() => { closed = true; child.emit('close', null); }, 40); return true; };
      return child as unknown as ChildProcess;
    };
    const result = await eldDecoder(slow, 10, 1000)({ audio: w.audio, frames: frames(), directory: w.directory }, signal);
    assert.deepEqual(result, { outcome: 'timeout', units: 3 });
    assert.equal(closed, true, 'resolved only after close');
    // A helper that never exits is reported, so the converter can stop launching.
    const stuck: Helper[] = [];
    const deaf = () => { const child = new Helper(); child.kill = (sig: string) => { child.killed.push(sig); return true; }; stuck.push(child); return child as unknown as ChildProcess; };
    assert.deepEqual(await eldDecoder(deaf, 10, 30)({ audio: w.audio, frames: frames(), directory: w.directory }, signal), { outcome: 'cleanup_unconfirmed', units: 3 });
    assert.deepEqual(stuck[0]!.killed, ['SIGKILL']);
  } finally { w.done(); }
});

