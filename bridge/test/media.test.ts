import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { JpegFramer } from '../src/jpeg.js';

test('real FFmpeg produces bounded decoded JPEG frames from fragmented H264', async () => {
  const producer = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=8', '-t', '1', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-f', 'h264', 'pipe:1']);
  const decoder = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'h264', '-i', 'pipe:0', '-an', '-vf', "fps=8,scale='min(960,iw)':-2", '-q:v', '6', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1']);
  const frames: Buffer[] = [];
  const framer = new JpegFramer(frame => frames.push(frame));
  decoder.stdout.on('data', chunk => { for (let start = 0; start < chunk.length; start += 31) framer.push(chunk.subarray(start, start + 31)); });
  producer.stdout.pipe(decoder.stdin);
  const results = await Promise.all([once(producer, 'close'), once(decoder, 'close')]);
  assert.equal(results[0][0], 0); assert.equal(results[1][0], 0);
  assert.equal(frames.length, 8);
  assert.ok(frames.every(frame => frame.length < 256_000 && frame[0] === 255 && frame[1] === 216));
});
