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

// Feed one second of permitted synthetic media, then keep the camera inputs
// open. Startup must not need more footage or EOF to finish stream probing.
for (const codec of ['h264', 'hevc'] as const) for (const hasAudio of [false, true]) {
  test(`live ${codec}, audio=${hasAudio} produces decodable A/V before input EOF`, { timeout: 10000 }, async t => {
    const { spawnSync } = await import('node:child_process');
    const { PassThrough } = await import('node:stream');
    const { EventEmitter } = await import('node:events');
    const { MediaRelay } = await import('../src/media.js');
    const videoArgs = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15', '-t', '1', '-c:v', codec === 'h264' ? 'libx264' : 'libx265', '-threads', '1', '-preset', 'ultrafast', '-tune', 'zerolatency'];
    if (codec === 'hevc') videoArgs.push('-x265-params', 'pools=none:log-level=error');
    const fixture = spawnSync('ffmpeg', [...videoArgs, '-f', codec, 'pipe:1']);
    assert.equal(fixture.status, 0, fixture.stderr.toString());
    const sound = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', '-t', '1', '-c:a', 'aac', '-f', 'adts', 'pipe:1']);
    assert.equal(sound.status, 0, sound.stderr.toString());
    const video = new PassThrough(), audio = new PassThrough();
    const failures: string[] = [];
    const media = new MediaRelay(serial => failures.push(serial));
    const chunks: Buffer[] = [];
    const response = Object.assign(new EventEmitter(), {
      writableLength: 0, writeHead() {},
      write(chunk: Buffer) { chunks.push(Buffer.from(chunk)); response.emit('data'); return true; },
      destroy() { response.emit('close'); },
    });
    t.after(() => { media.stop('fixture'); video.destroy(); audio.destroy(); });
    const grant = media.grant('fixture');
    assert.equal(media.serve(grant, response as any), true);
    media.start('fixture', codec, video, audio, hasAudio, 15);
    const first = once(response, 'data', { signal: AbortSignal.timeout(3000) });
    const started = performance.now();
    video.write(fixture.stdout);
    if (hasAudio) audio.write(sound.stdout);
    await first;
    t.diagnostic(`First encoded output ${Math.round(performance.now() - started)} ms after synthetic input`);
    // Allow already available packets through without supplying more input.
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(video.writableEnded, false); assert.equal(audio.writableEnded, false);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-f', 'mpegts', '-show_entries', 'stream=codec_name', '-of', 'json', 'pipe:0'], { input: Buffer.concat(chunks) });
    assert.equal(probe.status, 0, probe.stderr.toString());
    const codecs = JSON.parse(probe.stdout.toString()).streams.map((s: { codec_name: string }) => s.codec_name).sort();
    assert.deepEqual(codecs, hasAudio ? ['aac', 'h264'] : ['h264']);
    const decoded = spawnSync('ffmpeg', ['-v', 'error', '-f', 'mpegts', '-i', 'pipe:0', '-frames:v', '1', '-an', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'], { input: Buffer.concat(chunks) });
    assert.equal(decoded.status, 0, decoded.stderr.toString());
    assert.ok(decoded.stdout.length > 100, 'Initial output includes a decodable keyframe');
    const replay: Buffer[] = [];
    let readerClosed = false;
    const late = Object.assign(new EventEmitter(), { writableLength: 0, writeHead() {}, write(chunk: Buffer) { replay.push(chunk); return true; }, destroy() { readerClosed = true; late.emit('close'); } });
    assert.equal(media.serve(grant, late as any), true);
    assert.deepEqual(Buffer.concat(replay), Buffer.concat(chunks), 'Signaling delay retains the first keyframe and headers');
    if (codec === 'h264' && !hasAudio) {
      await new Promise(resolve => setTimeout(resolve, 2100));
      const expired: Buffer[] = [];
      const later = Object.assign(new EventEmitter(), { writableLength: 0, writeHead() {}, write(chunk: Buffer) { expired.push(chunk); return true; }, destroy() { later.emit('close'); } });
      assert.equal(media.serve(grant, later as any), true);
      assert.deepEqual(expired, [], 'Initial prefix expires while the camera stays open');
    }
    assert.deepEqual(failures, []);
    media.stop('fixture');
    assert.equal(readerClosed, true);
    assert.equal(media.serve(grant, response as any), false);
    assert.equal(media.audioSupported('fixture'), undefined);
  });
}
