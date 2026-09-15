import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ServerResponse } from 'node:http';
import { LateAudio } from '../src/late-audio.js';
import { MediaRelay } from '../src/media.js';
import { adtsHeader } from '../src/audio-header-diagnostics.js';

const generated = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i',
  'sine=frequency=440:sample_rate=16000', '-t', '0.5', '-c:a', 'aac', '-f', 'adts', 'pipe:1']);
assert.equal(generated.status, 0, generated.stderr.toString());
const frames: Buffer[] = [];
for (let offset = 0; offset < generated.stdout.length;) {
  const header = adtsHeader(generated.stdout.subarray(offset));
  assert.ok(header);
  frames.push(generated.stdout.subarray(offset, offset + header.frame_bytes));
  offset += header.frame_bytes;
}

test('late AAC preserves complete frames across arbitrary fragmentation, without a startup deadline', () => {
  const source = new PassThrough();
  const delivered: Buffer[] = [];
  let available = 0;
  const audio = new LateAudio(source, () => available++, frame => delivered.push(frame));
  assert.equal(available, 0);
  for (let i = 0; i < generated.stdout.length; i += 3) source.write(generated.stdout.subarray(i, i + 3));
  assert.equal(available, 1);
  assert.deepEqual(delivered, frames);
  audio.stop();
  assert.equal(source.listenerCount('data'), 0);
  source.write(frames[0]);
  assert.equal(delivered.length, frames.length);
  source.destroy();
});

test('unknown and incomplete audio never advertise a track or affect their source owner', () => {
  for (const bytes of [Buffer.from('unknown stream'), frames[0]!.subarray(0, -1)]) {
    const source = new PassThrough(); let called = false;
    const audio = new LateAudio(source, () => { called = true; }, () => { called = true; });
    source.write(bytes);
    assert.equal(called, false); assert.equal(source.destroyed, false);
    audio.stop(); assert.equal(source.listenerCount('data'), 0); source.destroy();
  }
});

test('late audio readers join at frame boundaries, share revocation and cannot buffer the camera', () => {
  const video = new PassThrough(), source = new PassThrough();
  let available = 0;
  const relay = new MediaRelay(() => {}, undefined, () => available++);
  const first = relay.grant('camera'), second = relay.grant('camera');
  const response = () => Object.assign(new EventEmitter(), {
    destroyed: false, writableLength: 0, chunks: [] as Buffer[],
    writeHead() {}, write(frame: Buffer) { this.chunks.push(frame); return true; },
    destroy() { this.destroyed = true; this.emit('close'); },
  });
  const a = response(), b = response();
  assert.equal(relay.serveAudio(first, a as unknown as ServerResponse), false);
  // Exercise the production video-only admission, with metadata remaining false.
  relay.start('camera', 'h264', video, source, false);
  source.write(frames[0]);
  assert.equal(available, 1);
  assert.equal(relay.audioSupported('camera'), false);
  assert.equal(relay.lateAudioSupported('camera'), true);
  source.write(frames[1]!.subarray(0, 9));
  assert.equal(relay.serveAudio(first, a as unknown as ServerResponse), true);
  assert.equal(relay.serveAudio(second, b as unknown as ServerResponse), true);
  assert.equal(a.chunks.length, 0);
  source.write(frames[1]!.subarray(9));
  assert.deepEqual(a.chunks, [frames[1]]);
  a.writableLength = 256_000;
  source.write(frames[2]);
  assert.equal(a.destroyed, true); assert.equal(b.destroyed, false);
  relay.revoke(second);
  assert.equal(b.destroyed, true);
  assert.equal(relay.serveAudio(second, response() as unknown as ServerResponse), false);
  const c = response();
  assert.equal(relay.serveAudio(first, c as unknown as ServerResponse), true);
  source.write(Buffer.from('invalid audio'));
  assert.equal(c.destroyed, true);
  assert.equal(relay.lateAudioSupported('camera'), false);
  assert.equal(video.destroyed, false, 'Audio failure cannot stop the existing video source');
  relay.stop('camera');
  assert.equal(source.listenerCount('data'), 0);
  assert.equal(relay.serveAudio(first, response() as unknown as ServerResponse), false);
  source.destroy(); video.destroy();
});
