import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { StreamDiagnostics, type DiagnosticEvent } from '../src/diagnostics.js';
import { StreamHub } from '../src/streams.js';

test('diagnostics default off, bounded and contain no device or upstream text', () => {
  const lines: string[] = []; let time = 0;
  const d = new StreamDiagnostics(s => lines.push(s), () => time);
  const secret = 'PRIVATE_DEVICE_TOKEN';
  d.begin(secret); d.mark(secret, 'video_input'); assert.equal(lines.length, 0);
  d.enabled = true; d.begin(secret); time = 25;
  for (let i = 0; i < 1000; i++) d.mark(secret, 'video_input');
  d.mark(secret, secret as DiagnosticEvent);
  assert.equal(lines.length, 2); assert.equal(JSON.parse(lines[1]!).elapsed_ms, 25);
  assert.ok(!lines.join('').includes(secret));
  d.finish(secret); d.mark(secret, 'media_output'); assert.equal(lines.length, 3);
});

test('encoder diagnostics classify split errors without logging raw text', () => {
  const lines: string[] = []; const d = new StreamDiagnostics(s => lines.push(s));
  d.enabled = true; d.begin('private');
  const p = Object.assign(new EventEmitter(), { stderr: new PassThrough() });
  d.encoder('private', 'media', p as unknown as ChildProcess);
  p.stderr.write('http://secret/token Invalid da'); p.stderr.write('ta found private payload');
  p.emit('exit', 1);
  const events = lines.map(s => JSON.parse(s).event);
  assert.ok(events.includes('media_invalid_data')); assert.ok(events.includes('media_encoder_exit'));
  assert.ok(!lines.join('').match(/secret|private|payload|http/));
  d.finish('private'); d.begin('private'); const count = lines.length;
  p.emit('exit', 1); assert.equal(lines.length, count);
});

test('diagnostic sink failures cannot interrupt stream ownership', () => {
  const d = new StreamDiagnostics(() => { throw new Error('sink unavailable'); });
  d.enabled = true;
  assert.doesNotThrow(() => { d.begin('a'); d.mark('a', 'jpeg_frame'); d.finish('a'); });
});

test('twenty-second viewer timeout is reported even when JPEG frames arrive', () => {
  const events: string[] = []; let now = 0; let stops = 0;
  const hub = new StreamHub({ start: async () => {}, stop: async () => { stops++; }, disposeMedia: () => {}, diagnostic: (_s, event) => events.push(event) }, () => now);
  const peer = { send: () => {}, close: () => {}, bufferedAmount: 0 };
  hub.attach('private', peer); now = 19000; hub.frame('private', Buffer.from('frame'));
  now = 20000; hub.tick();
  assert.deepEqual(events, ['viewer_timeout', 'no_viewers']); assert.equal(stops, 1);
});

test('acknowledgement distinguishes successful playback from initial timeout', () => {
  const events: string[] = []; let now = 0;
  const hub = new StreamHub({ start: async () => {}, stop: async () => {}, disposeMedia: () => {}, diagnostic: (_s, event) => events.push(event) }, () => now);
  const peer = { send: () => {}, close: () => {}, bufferedAmount: 0 };
  hub.attach('a', peer); hub.frame('a', Buffer.from('frame')); hub.ack('a', peer);
  now = 10000; hub.tick(); assert.deepEqual(events, ['frame_ack', 'viewer_timeout', 'no_viewers']);
});
