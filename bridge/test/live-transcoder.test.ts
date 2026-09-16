import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, type ChildProcess } from 'node:child_process';
import { LiveTranscoder, liveAcceleration, liveArgs, liveRateControl } from '../src/live-transcoder.js';
import { StreamDiagnostics } from '../src/diagnostics.js';

class FakeProcess extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  stdio = [this.stdin, this.stdout, this.stderr];
  exitCode: number | null = null; signalCode: string | null = null;
  killed = false;
  kill() { this.killed = true; this.signalCode = 'SIGKILL'; queueMicrotask(() => this.emit('close', null, 'SIGKILL')); return true; }
}
function fixture(mode: 'nvidia' | 'software' = 'nvidia', timeout = 5000, max = 8 * 1024 * 1024) {
  const video = new PassThrough();
  const children: FakeProcess[] = [], commands: string[][] = [], events: string[] = [], outputs: Buffer[] = [];
  let failures = 0, disabled = 0;
  const diagnostics = new StreamDiagnostics(line => events.push(JSON.parse(line).event));
  diagnostics.enabled = true; diagnostics.begin('private-camera');
  const session = new LiveTranscoder('private-camera', 'hevc', video, 15, mode, diagnostics,
    chunk => outputs.push(chunk), () => failures++, () => disabled++, args => {
      commands.push(args); const child = new FakeProcess(); children.push(child); return child as unknown as ChildProcess;
    }, timeout, max);
  session.start();
  return { session, video, children, commands, events, outputs, failures: () => failures, disabled: () => disabled };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('configuration is opt-in and rejects arbitrary FFmpeg input', () => {
  assert.equal(liveAcceleration(), 'software'); assert.equal(liveAcceleration('software'), 'software');
  assert.equal(liveAcceleration('nvidia'), 'nvidia');
  assert.throws(() => liveAcceleration('-gpu all')); assert.throws(() => liveAcceleration(''));
});
test('bitrate cap accepts k/M suffixes, derives half as VBV window and rejects arbitrary input', () => {
  assert.deepEqual(liveRateControl(), { maxrate: 4_000_000, bufsize: 2_000_000 });
  assert.deepEqual(liveRateControl(''), { maxrate: 4_000_000, bufsize: 2_000_000 });
  assert.deepEqual(liveRateControl('4M'), { maxrate: 4_000_000, bufsize: 2_000_000 });
  assert.deepEqual(liveRateControl('2500k'), { maxrate: 2_500_000, bufsize: 1_250_000 });
  assert.deepEqual(liveRateControl(' 1500000 '), { maxrate: 1_500_000, bufsize: 750_000 });
  for (const bad of ['fast', '4 M', '-maxrate 4M', '100k', '99M', '4.5M', '0'])
    assert.throws(() => liveRateControl(bad), /EUFY_LIVE_MAX_BITRATE/, bad);
});
test('software command is video-only, rate bounded and wall-clock stamped', () => {
  assert.deepEqual(liveArgs('h264', 15, 'software'), ['-hide_banner', '-loglevel', 'error', '-threads', '1', '-probesize', '32768', '-analyzeduration', '100000', '-framerate', '15', '-f', 'h264', '-i', 'pipe:0', '-map', '0:v:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '26', '-maxrate', '4000000', '-bufsize', '2000000', '-pix_fmt', 'yuv420p', '-vf', "setpts='(time(0)-RTCSTART/1000000)/TB',scale='min(1920,iw)':-2", '-threads', '1', '-g', '30', '-fps_mode', 'vfr', '-enc_time_base', '1:90000', '-mpegts_flags', '+resend_headers', '-muxdelay', '0', '-muxpreload', '0', '-f', 'mpegts', 'pipe:1']);
  for (const codec of ['h264', 'hevc'] as const) for (const mode of ['software', 'nvidia'] as const) {
    const args = liveArgs(codec, 15, mode, liveRateControl('2500k'));
    // No second input, no audio stream and no audio encoder anywhere.
    assert.ok(!args.includes('pipe:3')); assert.ok(!args.includes('aac')); assert.ok(!args.includes('-c:a'));
    assert.equal(args.filter(value => value === '-i').length, 1);
    assert.ok(!args.includes('-r'), 'input -r would force the announced frame rate onto arrival timestamps');
    assert.ok(!args.includes('-use_wallclock_as_timestamps'), 'discarded by FFmpeg 6 for raw elementary streams');
    assert.ok(args.includes('-fps_mode') && args.includes('vfr'));
    assert.ok(args.includes('-enc_time_base') && args.includes('1:90000'));
    assert.match(args[args.indexOf('-vf') + 1]!, /^setpts='\(time\(0\)-RTCSTART\/1000000\)\/TB',scale=/);
    assert.equal(args[args.indexOf('-maxrate') + 1], '2500000');
    assert.equal(args[args.indexOf('-bufsize') + 1], mode === 'software' ? '1250000' : '625000');
  }
  // The announced rate is a demuxer hint only, clamped like the former input rate.
  assert.equal(liveArgs('hevc', 99, 'software')[liveArgs('hevc', 99, 'software').indexOf('-framerate') + 1], '30');
  assert.equal(liveArgs('hevc', 0, 'software')[liveArgs('hevc', 0, 'software').indexOf('-framerate') + 1], '15');
  assert.equal(liveArgs('hevc', NaN, 'software')[liveArgs('hevc', NaN, 'software').indexOf('-framerate') + 1], '15');
});
test('NVIDIA uses input CUDA decode with host scaling and low latency H264 encode', () => {
  for (const codec of ['h264', 'hevc'] as const) {
    const args = liveArgs(codec, 15, 'nvidia');
    assert.ok(args.indexOf('-hwaccel') < args.indexOf('-i'));
    assert.ok(args.includes('h264_nvenc')); assert.ok(args.includes('ull'));
    assert.ok(args.includes("setpts='(time(0)-RTCSTART/1000000)/TB',scale='min(1920,iw)':-2"));
    assert.ok(!args.includes('libx264')); assert.ok(!args.includes('scale_cuda'));
    assert.deepEqual(args.slice(args.indexOf('-rc'), args.indexOf('-rc') + 8), ['-rc', 'cbr', '-b:v', '4000000', '-maxrate', '4000000', '-bufsize', '1000000']);
  }
});
test('failed hardware replays the initial video once to software without ending ownership', async () => {
  const f = fixture(); const video = Buffer.from('initial-video-headers');
  f.video.write(video); await tick();
  f.children[0].emit('error', new Error('private driver detail'));
  f.children[0].emit('exit', 1); await tick();
  assert.equal(f.children.length, 2); assert.equal(f.children[0].killed, true);
  assert.equal(f.commands[1].includes('libx264'), true);
  assert.deepEqual(f.children[1].stdin.read(), video);
  f.video.write(Buffer.from('next')); await tick(); assert.equal(f.children[1].stdin.read().toString(), 'next');
  f.children[0].stdout.write('stale'); f.children[1].stdout.write('mpegts');
  assert.equal(f.outputs.length, 1); assert.equal(f.failures(), 0); assert.equal(f.disabled(), 1);
  assert.ok(f.events.includes('media_active_software')); assert.ok(f.events.includes('media_software_fallback'));
  assert.ok(!JSON.stringify(f.events).includes('private'));
  f.children[1].emit('error', new Error('software failure')); f.children[1].emit('exit', 1);
  assert.equal(f.failures(), 1); assert.equal(f.children.length, 2); f.session.stop();
});
test('silent hardware startup falls back once within its deadline', async () => {
  const f = fixture('nvidia', 15); f.video.write('headers');
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(f.children.length, 2); assert.ok(f.events.includes('media_hardware_timeout')); f.session.stop();
});
test('unconfirmed hardware termination never overlaps a software replacement', async () => {
  const f = fixture();
  f.children[0].kill = () => false;
  f.children[0].emit('error', new Error('driver stuck'));
  await new Promise(resolve => setTimeout(resolve, 1050));
  assert.equal(f.children.length, 1); assert.equal(f.failures(), 1); assert.equal(f.disabled(), 1);
  f.children[0].emit('close', 1); await tick(); assert.equal(f.children.length, 1);
  f.session.stop();
});
test('stop during pending hardware cleanup cancels fallback and removes input listeners', async () => {
  const f = fixture(); f.video.write('headers'); f.children[0].emit('error', new Error('failure')); f.session.stop();
  await tick(); assert.equal(f.children.length, 1); assert.equal(f.video.listenerCount('data'), 0);
  assert.equal(f.failures(), 0);
});
test('replay overflow terminates safely and disables hardware without partial replay', async () => {
  const f = fixture('nvidia', 5000, 8); f.video.write(Buffer.alloc(9)); await tick();
  assert.equal(f.failures(), 1); assert.equal(f.disabled(), 1); assert.equal(f.children.length, 1);
  assert.ok(f.events.includes('media_hardware_buffer_limit')); f.session.stop();
});
test('hardware output confirms active encoder, later failure does not splice MPEG-TS', async () => {
  const f = fixture(); f.video.write('headers'); f.children[0].stdout.write('mpegts');
  assert.ok(f.events.includes('media_active_nvidia'));
  f.children[0].emit('exit', 1); await tick();
  assert.equal(f.failures(), 1); assert.equal(f.disabled(), 1); assert.equal(f.children.length, 1); f.session.stop();
});
test('software mode never starts hardware or keeps replay listeners', async () => {
  const f = fixture('software'); f.video.write('video'); await tick();
  assert.equal(f.children[0].stdin.read().toString(), 'video');
  assert.equal(f.commands[0].includes('cuda'), false); assert.equal(f.disabled(), 0);
  f.session.stop(); assert.equal(f.video.listenerCount('data'), 0);
});
test('real FFmpeg fallback decodes a replayed synthetic H264 prefix on a CPU-only process', async () => {
  const producer = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15', '-t', '1', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-f', 'h264', 'pipe:1']);
  const chunks: Buffer[] = []; producer.stdout.on('data', chunk => chunks.push(chunk));
  assert.equal((await once(producer, 'close'))[0], 0);
  const video = new PassThrough(); const output: Buffer[] = [];
  const children: ChildProcess[] = [];
  const session = new LiveTranscoder('synthetic', 'h264', video, 15, 'nvidia', new StreamDiagnostics(), chunk => output.push(chunk), () => {}, () => {}, args => {
    // Guaranteed missing encoder simulates builds without NVENC even on GPU CI.
    const child = spawn('ffmpeg', args.map(value => value === 'h264_nvenc' ? 'missing_test_encoder' : value), { stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child); return child;
  });
  session.start(); video.end(Buffer.concat(chunks));
  try {
    const deadline = Date.now() + 7000;
    while (children.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(children.length, 2);
    if (children[1].exitCode === null) await once(children[1], 'close');
    assert.equal(children[1].exitCode, 0); const encoded = Buffer.concat(output);
    assert.ok(encoded.length > 188); assert.equal(encoded[0], 0x47);
  } finally { session.stop(); }
});

test('complex synthetic video remains decodable and bounded with the software defaults', { timeout: 15000 }, async () => {
  const producer = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=15,noise=alls=20:allf=t:all_seed=42', '-t', '3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-tune', 'zerolatency', '-f', 'h264', 'pipe:1']);
  const encoder = spawn('ffmpeg', liveArgs('h264', 15, 'software'));
  const chunks: Buffer[] = [];
  producer.stderr.resume(); encoder.stderr.resume();
  producer.stdout.pipe(encoder.stdin);
  encoder.stdout.on('data', chunk => chunks.push(chunk));
  try {
    const results = await Promise.all([once(producer, 'close'), once(encoder, 'close')]);
    assert.equal(results[0][0], 0); assert.equal(results[1][0], 0);
    const output = Buffer.concat(chunks);
    assert.ok(output.length > 188);
    const { spawnSync } = await import('node:child_process');
    const decoded = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_name,nb_read_frames', '-of', 'json', 'pipe:0'], { input: output });
    assert.equal(decoded.status, 0);
    assert.equal(JSON.parse(decoded.stdout.toString()).streams[0].codec_name, 'h264');
    // Frames delivered faster than real time keep distinct, increasing stamps: none are dropped.
    assert.equal(Number(JSON.parse(decoded.stdout.toString()).streams[0].nb_read_frames), 45);
    // A 4 Mbit/s cap at 15 announced frames bounds 45 noisy 720p frames to about 1.5 MB.
    assert.ok(output.length < 2_000_000, `bounded output, got ${output.length} bytes`);
  } finally { producer.kill('SIGKILL'); encoder.kill('SIGKILL'); }
});

test('real FFmpeg stamps output with arrival time, not the announced rate, without dropping frames', { timeout: 20000 }, async () => {
  const { spawnSync } = await import('node:child_process');
  // 15 fps is announced in the header and SPS. Frames are delivered at 20 fps, three per write.
  const fixture = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15', '-t', '4', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '30', '-x264-params', 'aud=1', '-f', 'h264', 'pipe:1']);
  assert.equal(fixture.status, 0, fixture.stderr.toString());
  const starts: number[] = [];
  for (let i = 0; i + 4 < fixture.stdout.length; i++) {
    if (fixture.stdout[i] === 0 && fixture.stdout[i + 1] === 0 && fixture.stdout[i + 2] === 1 && (fixture.stdout[i + 3]! & 0x1f) === 9) starts.push(fixture.stdout[i - 1] === 0 ? i - 1 : i);
  }
  const frames = starts.map((start, k) => fixture.stdout.subarray(start, starts[k + 1] ?? fixture.stdout.length));
  assert.equal(frames.length, 60);
  const encoder = spawn('ffmpeg', liveArgs('h264', 15, 'software'));
  const chunks: Buffer[] = []; let stderr = '';
  encoder.stdout.on('data', chunk => chunks.push(chunk)); encoder.stderr.on('data', chunk => { stderr += chunk.toString(); });
  try {
    const started = performance.now();
    for (let sent = 0; sent < frames.length; sent += 3) {
      await new Promise(resolve => setTimeout(resolve, Math.max(0, started + (sent + 3) * 50 - performance.now())));
      encoder.stdin.write(Buffer.concat(frames.slice(sent, sent + 3)));
    }
    const fed = (performance.now() - started) / 1000;
    encoder.stdin.end();
    assert.equal((await once(encoder, 'close'))[0], 0, stderr);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-f', 'mpegts', '-show_packets', '-show_entries', 'packet=pts,dts', '-of', 'json', 'pipe:0'], { input: Buffer.concat(chunks) });
    assert.equal(probe.status, 0, probe.stderr.toString());
    const packets = JSON.parse(probe.stdout.toString()).packets as { pts: number; dts: number }[];
    assert.equal(packets.length, 60, 'every delivered frame is encoded');
    for (let i = 1; i < packets.length; i++) assert.ok(packets[i]!.dts > packets[i - 1]!.dts, 'DTS strictly increases across frames read from one write');
    const span = (packets.at(-1)!.pts - packets[0]!.pts) / 90000;
    // 60 frames at the announced 15 fps would span 3.93 s; arrival stamping follows the 3 s feed.
    assert.ok(span > fed - 0.6 && span < fed + 0.1, `output spans ${span.toFixed(2)} s for a ${fed.toFixed(2)} s feed`);
    assert.doesNotMatch(stderr, /monoton/i);
  } finally { encoder.kill('SIGKILL'); }
});
