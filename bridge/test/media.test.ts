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
// open. Startup must not need more footage, audio or EOF to finish probing.
for (const codec of ['h264', 'hevc'] as const) for (const mode of ['software', 'nvidia'] as const) {
  test(`live ${codec}, acceleration=${mode} produces decodable video-only MPEG-TS before input EOF`, { timeout: 10000 }, async t => {
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
    media.acceleration = mode;
    const chunks: Buffer[] = [];
    const response = Object.assign(new EventEmitter(), {
      writableLength: 0, writeHead() {},
      write(chunk: Buffer) { chunks.push(Buffer.from(chunk)); response.emit('data'); return true; },
      destroy() { response.emit('close'); },
    });
    t.after(() => { media.stop('fixture'); video.destroy(); audio.destroy(); });
    const grant = media.grant('fixture');
    assert.equal(media.serve(grant, response as any), true);
    assert.equal(media.active('fixture'), false);
    media.start('fixture', codec, video, audio, 15);
    assert.equal(media.active('fixture'), true);
    const first = once(response, 'data', { signal: AbortSignal.timeout(3000) });
    const started = performance.now();
    video.write(fixture.stdout);
    // Audio present from the start must neither be muxed nor delay the video.
    audio.write(sound.stdout);
    await first;
    t.diagnostic(`First encoded output ${Math.round(performance.now() - started)} ms after synthetic input`);
    // Allow already available packets through without supplying more input.
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(video.writableEnded, false); assert.equal(audio.writableEnded, false);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-f', 'mpegts', '-show_entries', 'stream=codec_name', '-of', 'json', 'pipe:0'], { input: Buffer.concat(chunks) });
    assert.equal(probe.status, 0, probe.stderr.toString());
    const codecs = JSON.parse(probe.stdout.toString()).streams.map((s: { codec_name: string }) => s.codec_name).sort();
    assert.deepEqual(codecs, ['h264'], 'The main stream is video-only even when AAC is available');
    assert.equal(media.lateAudioSupported('fixture'), true, 'AAC is offered on the late audio reader instead');
    const decoded = spawnSync('ffmpeg', ['-v', 'error', '-f', 'mpegts', '-i', 'pipe:0', '-frames:v', '1', '-an', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'], { input: Buffer.concat(chunks) });
    assert.equal(decoded.status, 0, decoded.stderr.toString());
    assert.ok(decoded.stdout.length > 100, 'Initial output includes a decodable keyframe');
    const replay: Buffer[] = [];
    let readerClosed = false;
    const late = Object.assign(new EventEmitter(), { writableLength: 0, writeHead() {}, write(chunk: Buffer) { replay.push(chunk); return true; }, destroy() { readerClosed = true; late.emit('close'); } });
    assert.equal(media.serve(grant, late as any), true);
    assert.deepEqual(Buffer.concat(replay), Buffer.concat(chunks), 'Signaling delay retains the first keyframe and headers');
    if (codec === 'h264' && mode === 'software') {
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
    assert.equal(media.active('fixture'), false);
    assert.equal(media.lateAudioSupported('fixture'), false);
  });
}

// A SoloCam behind a HomeBase delivers its first AAC frame 40 ms after video
// on a warm start and 4-5 s after video on a cold start. Video output must
// never wait for it, and the late reader must receive complete frames either way.
for (const delayMs of [40, 5000]) {
  test(`AAC starting ${delayMs} ms after video reaches late audio readers as complete frames while video already flows`, { timeout: 15000 }, async t => {
    const { spawnSync } = await import('node:child_process');
    const { PassThrough } = await import('node:stream');
    const { EventEmitter } = await import('node:events');
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
    const available: number[] = [];
    const media = new MediaRelay(() => assert.fail('encoder failed'), undefined, () => available.push(performance.now() - started));
    const tsChunks: Buffer[] = [];
    const reader = Object.assign(new EventEmitter(), { writableLength: 0, writeHead() {}, write(chunk: Buffer) { tsChunks.push(chunk); reader.emit('data'); return true; }, destroy() { reader.emit('close'); } });
    const listener = Object.assign(new EventEmitter(), { destroyed: false, writableLength: 0, chunks: [] as Buffer[], writeHead() {}, write(frame: Buffer) { listener.chunks.push(frame); return true; }, destroy() { listener.destroyed = true; listener.emit('close'); } });
    t.after(() => { media.stop('fixture'); video.destroy(); audio.destroy(); });
    const grant = media.grant('fixture');
    assert.equal(media.serve(grant, reader as any), true);
    const started = performance.now();
    media.start('fixture', 'h264', video, audio, 15);
    const firstVideo = once(reader, 'data', { signal: AbortSignal.timeout(3000) });
    video.write(fixture.stdout);
    await firstVideo;
    const videoAt = performance.now() - started;
    assert.equal(media.lateAudioSupported('fixture'), false);
    assert.equal(media.serveAudio(grant, listener as any), false, 'No audio reader before the first complete frame');
    await new Promise(resolve => setTimeout(resolve, Math.max(0, delayMs - (performance.now() - started))));
    // Deliver the first frame in two fragments, then the rest at once.
    audio.write(frames[0]!.subarray(0, 9));
    assert.deepEqual(available, []);
    audio.write(frames[0]!.subarray(9));
    assert.equal(available.length, 1);
    assert.ok(available[0]! >= delayMs - 5, `audio advertised ${available[0]} ms after start`);
    // Both timestamps come from the same monotonic clock at sub-millisecond
    // precision and video is sampled first, so an equal reading means the clock
    // did not tick in between, not that video waited for audio. Rounding to
    // whole milliseconds made this fail on slow runners when both landed in the
    // same millisecond.
    assert.ok(videoAt <= available[0]!, `video output at ${videoAt.toFixed(3)} ms preceded audio at ${available[0]!.toFixed(3)} ms`);
    assert.equal(media.lateAudioSupported('fixture'), true);
    assert.equal(media.serveAudio(grant, listener as any), true);
    audio.write(Buffer.concat(frames.slice(1)));
    assert.deepEqual(listener.chunks, frames.slice(1), 'Readers receive every later frame whole');
    const videoBytes = Buffer.concat(tsChunks).length;
    assert.ok(videoBytes > 188, 'Video kept flowing on its own reader');
    assert.equal(media.active('fixture'), true);
    media.stop('fixture');
    assert.equal(listener.destroyed, true);
  });
}
