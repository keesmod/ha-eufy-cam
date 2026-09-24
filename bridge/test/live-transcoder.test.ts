import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough, type Readable } from 'node:stream';
import { spawn, type ChildProcess } from 'node:child_process';
import { LiveTranscoder, liveAcceleration, liveArgs, liveProgressParser, liveRateControl, type LiveEncoderProgress } from '../src/live-transcoder.js';
import { StreamDiagnostics } from '../src/diagnostics.js';

class FakeProcess extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough(); progress = new PassThrough();
  stdio = [this.stdin, this.stdout, this.stderr];
  exitCode: number | null = null; signalCode: string | null = null;
  killed = false;
  /** Only a process built with the progress pipe offers FFmpeg's fd 3, like the bridge's own spawn. */
  constructor(withProgress = false) { super(); if (withProgress) this.stdio.push(this.progress); }
  kill() { this.killed = true; this.signalCode = 'SIGKILL'; queueMicrotask(() => this.emit('close', null, 'SIGKILL')); return true; }
}
function fixture(mode: 'nvidia' | 'software' = 'nvidia', timeout = 5000, max = 8 * 1024 * 1024, progress?: LiveEncoderProgress[]) {
  const video = new PassThrough();
  const children: FakeProcess[] = [], commands: string[][] = [], events: string[] = [], outputs: Buffer[] = [];
  let failures = 0, disabled = 0;
  const diagnostics = new StreamDiagnostics(line => events.push(JSON.parse(line).event));
  diagnostics.enabled = true; diagnostics.begin('private-camera');
  const session = new LiveTranscoder('private-camera', 'hevc', video, 15, mode, diagnostics,
    chunk => outputs.push(chunk), () => failures++, () => disabled++, args => {
      commands.push(args); const child = new FakeProcess(progress !== undefined); children.push(child); return child as unknown as ChildProcess;
    }, timeout, max, undefined, value => progress?.push(value));
  session.start();
  return { session, video, children, commands, events, outputs, failures: () => failures, disabled: () => disabled };
}
/** The bridge's own spawn: FFmpeg's progress goes to a fourth pipe, which the caller drains. */
const liveSpawn = (args: string[]) => spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
/** A synthetic H.264 stream split into access units at its AUD NAL units. No captured camera video. */
async function accessUnits(seconds: number, size = '320x180'): Promise<Buffer[]> {
  const { spawnSync } = await import('node:child_process');
  const fixture = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=15`, '-t', String(seconds), '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '30', '-x264-params', 'aud=1', '-f', 'h264', 'pipe:1']);
  assert.equal(fixture.status, 0, fixture.stderr.toString());
  const starts: number[] = [];
  for (let i = 0; i + 4 < fixture.stdout.length; i++) {
    if (fixture.stdout[i] === 0 && fixture.stdout[i + 1] === 0 && fixture.stdout[i + 2] === 1 && (fixture.stdout[i + 3]! & 0x1f) === 9) starts.push(fixture.stdout[i - 1] === 0 ? i - 1 : i);
  }
  return starts.map((start, k) => fixture.stdout.subarray(start, starts[k + 1] ?? fixture.stdout.length));
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
  assert.deepEqual(liveArgs('h264', 15, 'software', undefined, 1790000000123), ['-hide_banner', '-loglevel', 'error', '-progress', 'pipe:3', '-stats_period', '1', '-threads', '1', '-probesize', '32768', '-analyzeduration', '100000', '-framerate', '15', '-f', 'h264', '-i', 'pipe:0', '-map', '0:v:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '26', '-maxrate', '4000000', '-bufsize', '2000000', '-pix_fmt', 'yuv420p', '-vf', "setpts='(time(0)-1790000000.123)/TB',scale='min(1920,iw)':-2", '-threads', '1', '-g', '30', '-fps_mode', 'vfr', '-enc_time_base', '1:90000', '-mpegts_flags', '+resend_headers', '-muxdelay', '0', '-muxpreload', '0', '-f', 'mpegts', 'pipe:1']);
  for (const codec of ['h264', 'hevc'] as const) for (const mode of ['software', 'nvidia'] as const) {
    const args = liveArgs(codec, 15, mode, liveRateControl('2500k'));
    // No second input, no audio stream and no audio encoder anywhere. Fd 3
    // carries FFmpeg's progress output only, once a second.
    assert.equal(args.filter(value => value === 'pipe:3').length, 1); assert.equal(args[args.indexOf('pipe:3') - 1], '-progress');
    assert.equal(args[args.indexOf('-stats_period') + 1], '1');
    assert.ok(!args.includes('aac')); assert.ok(!args.includes('-c:a'));
    assert.equal(args.filter(value => value === '-i').length, 1);
    assert.ok(!args.includes('-r'), 'input -r would force the announced frame rate onto arrival timestamps');
    assert.ok(!args.includes('-use_wallclock_as_timestamps'), 'discarded by FFmpeg 6 for raw elementary streams');
    assert.ok(args.includes('-fps_mode') && args.includes('vfr'));
    assert.ok(args.includes('-enc_time_base') && args.includes('1:90000'));
    // Stamped from the spawn time, not RTCSTART, which a filter graph rebuild resets.
    assert.match(args[args.indexOf('-vf') + 1]!, /^setpts='\(time\(0\)-\d{10}\.\d{3}\)\/TB',scale=/);
    assert.ok(!args.join(' ').includes('RTCSTART'));
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
    const args = liveArgs(codec, 15, 'nvidia', undefined, 1790000000123);
    assert.ok(args.indexOf('-hwaccel') < args.indexOf('-i'));
    assert.ok(args.includes('h264_nvenc')); assert.ok(args.includes('ull'));
    assert.ok(args.includes("setpts='(time(0)-1790000000.123)/TB',scale='min(1920,iw)':-2"));
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
test('each encoder process stamps from its own spawn time', async () => {
  const origin = (args: string[]) => Math.round(Number(/^setpts='\(time\(0\)-(\d+\.\d{3})\)\/TB',/.exec(args[args.indexOf('-vf') + 1]!)![1]) * 1000);
  const before = Date.now(); const f = fixture();
  assert.ok(origin(f.commands[0]!) >= before && origin(f.commands[0]!) <= Date.now());
  f.video.write('headers'); await tick();
  f.children[0].emit('error', new Error('failure')); f.children[0].emit('exit', 1); await tick();
  assert.equal(f.commands.length, 2);
  assert.ok(origin(f.commands[1]!) >= origin(f.commands[0]!) && origin(f.commands[1]!) <= Date.now(), 'the software replacement gets its own origin');
  f.session.stop();
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
    const child = liveSpawn(args.map(value => value === 'h264_nvenc' ? 'missing_test_encoder' : value));
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
  const encoder = liveSpawn(liveArgs('h264', 15, 'software'));
  const chunks: Buffer[] = [];
  producer.stderr.resume(); encoder.stderr!.resume(); (encoder.stdio[3] as Readable).resume();
  producer.stdout.pipe(encoder.stdin!);
  encoder.stdout!.on('data', chunk => chunks.push(chunk));
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
  const frames = await accessUnits(4);
  assert.equal(frames.length, 60);
  const encoder = liveSpawn(liveArgs('h264', 15, 'software'));
  const chunks: Buffer[] = []; let stderr = '';
  encoder.stdout!.on('data', chunk => chunks.push(chunk)); encoder.stderr!.on('data', chunk => { stderr += chunk.toString(); });
  (encoder.stdio[3] as Readable).resume();
  try {
    const started = performance.now();
    for (let sent = 0; sent < frames.length; sent += 3) {
      await new Promise(resolve => setTimeout(resolve, Math.max(0, started + (sent + 3) * 50 - performance.now())));
      encoder.stdin!.write(Buffer.concat(frames.slice(sent, sent + 3)));
    }
    const fed = (performance.now() - started) / 1000;
    encoder.stdin!.end();
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

test('the progress parser keeps capped whole numbers of five keys and drops every other line whole', () => {
  const blocks: LiveEncoderProgress[] = [];
  const parse = liveProgressParser(block => blocks.push(block));
  // One FFmpeg block, written in 7-byte pieces: lines split across writes parse as one.
  const block = ['frame=90', 'fps=15.00', 'stream_0_0_q=-1.0', 'bitrate= 175.7kbits/s', 'total_size=55648', 'out_time_us=2533333',
    'out_time_ms=2533333', 'out_time=00:00:02.533333', 'dup_frames=0', 'drop_frames=4', 'speed=0.998x', 'progress=continue', ''].join('\n');
  for (let i = 0; i < block.length; i += 7) parse(Buffer.from(block.slice(i, i + 7), 'latin1'));
  assert.deepEqual(blocks, [{ frames: 90, bytes: 55648, out_time_ms: 2533, duplicated: 0, dropped: 4 }]);
  // N/A and negative values are not numbers, and a block of them still says FFmpeg reported.
  parse(Buffer.from('frame=91\ntotal_size=N/A\nout_time_us=N/A\nout_time_us=-9223372036854775807\nspeed=N/A\nprogress=continue\nprogress=end\n'));
  assert.deepEqual(blocks.slice(1), [{ frames: 91 }, {}]);
  // Capped at 2^31 - 1, and anything beyond 15 digits is not a counter.
  parse(Buffer.from('frame=999999999999999\ntotal_size=4294967296\nout_time_us=999999999999999\ndrop_frames=1234567890123456\nprogress=continue\n'));
  assert.deepEqual(blocks[3], { frames: 2147483647, bytes: 2147483647, out_time_ms: 2147483647 });
  // Free text, other keys, prototype names, fractions, padding and unknown terminators never enter a block.
  parse(Buffer.from('frame=12 PRIVATE\nframe=http://PRIVATE.invalid/\n__proto__=5\nconstructor=7\nframe=1.5\n frame=3\nFRAME=3\nPRIVATE=4\nprogress=PRIVATE\ndup_frames=2\r\nprogress=continue\r\n'));
  assert.deepEqual(blocks[4], { duplicated: 2 });
  // A line longer than 64 bytes is dropped whole, also when it spans writes, and parsing resumes at the next line.
  parse(Buffer.from('frame=5' + 'x'.repeat(80))); parse(Buffer.from('frame=6'));
  parse(Buffer.alloc(1_000_000, 0x61)); parse(Buffer.from('\nfra')); parse(Buffer.from('me=7\nprogress=end\n'));
  assert.deepEqual(blocks[5], { frames: 7 });
  assert.equal(blocks.length, 6);
  assert.ok(blocks.every(value => Object.values(value).every(Number.isInteger)));
  assert.ok(!JSON.stringify(blocks).includes('PRIVATE'));
});

test('progress of the current encoder reaches the observer and the pipe is always drained, never after a replacement or a stop', async () => {
  const progress: LiveEncoderProgress[] = [];
  const f = fixture('nvidia', 5000, 8 * 1024 * 1024, progress);
  assert.equal(f.children[0].progress.readableFlowing, true, 'FFmpeg never blocks on an unread progress pipe');
  f.video.write('headers'); await tick();
  f.children[0].progress.write('frame=3\ndrop_frames=0\nprogress=continue\n');
  assert.deepEqual(progress, [{ frames: 3, dropped: 0 }]);
  // The hardware process fails before output. Its later blocks are stale.
  f.children[0].emit('error', new Error('failure')); f.children[0].emit('exit', 1);
  f.children[0].progress.write('frame=9\nprogress=continue\n');
  await tick();
  assert.equal(f.children.length, 2);
  f.children[0].progress.write('frame=10\nprogress=continue\n');
  assert.equal(f.children[1].progress.readableFlowing, true);
  f.children[1].progress.write('fra'); f.children[1].progress.write('me=1\nprogress=continue\n');
  assert.deepEqual(progress, [{ frames: 3, dropped: 0 }, { frames: 1 }]);
  f.session.stop();
  f.children[1].progress.write('frame=2\nprogress=end\n');
  assert.equal(progress.length, 2, 'Nothing after the stop');
  assert.equal(f.failures(), 0);
});

test('real FFmpeg reports rising frames, bytes and output time once a second on the fourth pipe of the bridge spawn', { timeout: 20000 }, async () => {
  const frames = await accessUnits(4);
  assert.equal(frames.length, 60);
  const video = new PassThrough(); const output: Buffer[] = []; const progress: LiveEncoderProgress[] = [];
  const session = new LiveTranscoder('synthetic', 'h264', video, 15, 'software', new StreamDiagnostics(), chunk => output.push(chunk),
    () => {}, () => {}, undefined, undefined, undefined, undefined, value => progress.push(value));
  session.start();
  try {
    // Real time, 15 frames a second, so the one-second reports interleave with the frames.
    const started = performance.now();
    for (let sent = 0; sent < frames.length; sent += 3) {
      await new Promise(resolve => setTimeout(resolve, Math.max(0, started + (sent + 3) * 200 / 3 - performance.now())));
      video.write(Buffer.concat(frames.slice(sent, sent + 3)));
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.ok(progress.length >= 3, `one block a second, got ${progress.length}`);
    assert.ok(output.length > 0 && output[0]![0] === 0x47, 'MPEG-TS output flows next to the progress pipe');
    for (const [i, block] of progress.entries()) {
      assert.deepEqual(Object.keys(block).filter(key => !['frames', 'dropped', 'duplicated', 'out_time_ms', 'bytes'].includes(key)), []);
      assert.equal(block.dropped, 0, 'Wall-clock stamps delivered in real time drop nothing');
      if (i) for (const key of ['frames', 'out_time_ms', 'bytes'] as const) assert.ok(block[key]! >= progress[i - 1]![key]!, key);
    }
    const last = progress.at(-1)!;
    assert.ok(last.frames! > progress[0]!.frames! && last.frames! <= 60, `frames rose to ${last.frames}`);
    assert.ok(last.bytes! > 188 && last.bytes! <= Buffer.concat(output).length + 65536, `muxer bytes ${last.bytes}`);
    assert.ok(last.out_time_ms! > 1000 && last.out_time_ms! < 6000, `output time ${last.out_time_ms} ms`);
  } finally { session.stop(); video.destroy(); }
});
test('real FFmpeg keeps its clock and every frame across a mid-stream change of the frame size', { timeout: 20000 }, async () => {
  // A new size makes FFmpeg rebuild its filter graph, which resets setpts's
  // RTCSTART. Stamps from RTCSTART restarted near zero there, and the VFR sync
  // dropped every frame until they caught up again (#94, #122).
  const frames = [...await accessUnits(2), ...await accessUnits(2, '480x270')];
  assert.equal(frames.length, 60);
  const video = new PassThrough(); const output: Buffer[] = []; const progress: LiveEncoderProgress[] = [];
  let ended!: () => void; const done = new Promise<void>(resolve => { ended = resolve; });
  const session = new LiveTranscoder('synthetic', 'h264', video, 15, 'software', new StreamDiagnostics(), chunk => output.push(chunk),
    () => ended(), () => {}, undefined, undefined, undefined, undefined, value => progress.push(value));
  session.start();
  try {
    // Real time, 15 frames a second: the change comes 2 s after the first frame.
    const started = performance.now();
    for (let sent = 0; sent < frames.length; sent += 3) {
      await new Promise(resolve => setTimeout(resolve, Math.max(0, started + (sent + 3) * 200 / 3 - performance.now())));
      video.write(Buffer.concat(frames.slice(sent, sent + 3)));
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
    const last = progress.at(-1)!;
    assert.equal(last.dropped, 0, 'the video sync drops nothing after the change');
    assert.ok(last.frames! >= 55, `frames rose to ${last.frames}`);
    video.end(); await done;
    const { spawnSync } = await import('node:child_process');
    const probe = spawnSync('ffprobe', ['-v', 'error', '-f', 'mpegts', '-show_entries', 'frame=width,height', '-of', 'json', 'pipe:0'], { input: Buffer.concat(output) });
    assert.equal(probe.status, 0, probe.stderr.toString());
    const sizes = (JSON.parse(probe.stdout.toString()).frames as { width: number; height: number }[]).map(frame => `${frame.width}x${frame.height}`);
    assert.ok(sizes.length >= 55, `decoded ${sizes.length} frames`);
    assert.deepEqual([...new Set(sizes)], ['320x180'], 'the encoder keeps one output size across the change');
  } finally { session.stop(); video.destroy(); }
});
