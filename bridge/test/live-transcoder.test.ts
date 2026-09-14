import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, type ChildProcess } from 'node:child_process';
import { LiveTranscoder, liveAcceleration, liveArgs } from '../src/live-transcoder.js';
import { StreamDiagnostics } from '../src/diagnostics.js';

class FakeProcess extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  audio = new PassThrough(); stdio = [this.stdin, this.stdout, this.stderr, this.audio];
  exitCode: number | null = null; signalCode: string | null = null;
  killed = false;
  kill() { this.killed = true; this.signalCode = 'SIGKILL'; queueMicrotask(() => this.emit('close', null, 'SIGKILL')); return true; }
}
function fixture(mode: 'nvidia' | 'software' = 'nvidia', timeout = 5000, max = 8 * 1024 * 1024) {
  const video = new PassThrough(), audio = new PassThrough();
  const children: FakeProcess[] = [], commands: string[][] = [], events: string[] = [], outputs: Buffer[] = [];
  let failures = 0, disabled = 0;
  const diagnostics = new StreamDiagnostics(line => events.push(JSON.parse(line).event));
  diagnostics.enabled = true; diagnostics.begin('private-camera');
  const session = new LiveTranscoder('private-camera', 'hevc', video, audio, true, 15, mode, diagnostics,
    chunk => outputs.push(chunk), () => failures++, () => disabled++, args => {
      commands.push(args); const child = new FakeProcess(); children.push(child); return child as unknown as ChildProcess;
    }, timeout, max);
  session.start();
  return { session, video, audio, children, commands, events, outputs, failures: () => failures, disabled: () => disabled };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('configuration is opt-in and rejects arbitrary FFmpeg input', () => {
  assert.equal(liveAcceleration(), 'software'); assert.equal(liveAcceleration('software'), 'software');
  assert.equal(liveAcceleration('nvidia'), 'nvidia');
  assert.throws(() => liveAcceleration('-gpu all')); assert.throws(() => liveAcceleration(''));
});
test('software command preserves defaults, audio, scale and MPEG-TS', () => {
  assert.deepEqual(liveArgs('h264', false, 15, 'software'), ['-hide_banner', '-loglevel', 'error', '-threads', '1', '-fflags', '+genpts', '-probesize', '32768', '-analyzeduration', '100000', '-r', '15', '-f', 'h264', '-i', 'pipe:0', '-map', '0:v:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-b:v', '4M', '-maxrate', '4M', '-bufsize', '1M', '-pix_fmt', 'yuv420p', '-vf', "scale='min(1920,iw)':-2", '-threads', '1', '-g', '30', '-mpegts_flags', '+resend_headers', '-muxdelay', '0', '-muxpreload', '0', '-f', 'mpegts', 'pipe:1']);
  assert.ok(liveArgs('hevc', true, 99, 'software').includes('pipe:3'));
});
test('NVIDIA uses input CUDA decode with host scaling and low latency H264 encode', () => {
  for (const codec of ['h264', 'hevc'] as const) {
    const args = liveArgs(codec, true, 15, 'nvidia');
    assert.ok(args.indexOf('-hwaccel') < args.indexOf('-i'));
    assert.ok(args.includes('h264_nvenc')); assert.ok(args.includes('ull'));
    assert.ok(args.includes("scale='min(1920,iw)':-2"));
    assert.ok(!args.includes('libx264')); assert.ok(!args.includes('scale_cuda'));
  }
});
test('failed hardware replays both initial tracks once to software without ending ownership', async () => {
  const f = fixture(); const video = Buffer.from('initial-video-headers'), audio = Buffer.from('initial-aac');
  f.video.write(video); f.audio.write(audio); await tick();
  f.children[0].emit('error', new Error('private driver detail'));
  f.children[0].emit('exit', 1); await tick();
  assert.equal(f.children.length, 2); assert.equal(f.children[0].killed, true);
  assert.equal(f.commands[1].includes('libx264'), true);
  assert.deepEqual(f.children[1].stdin.read(), video); assert.deepEqual(f.children[1].audio.read(), audio);
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
  assert.equal(f.audio.listenerCount('data'), 0); assert.equal(f.failures(), 0);
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
  const video = new PassThrough(), audio = new PassThrough(); const output: Buffer[] = [];
  const children: ChildProcess[] = [];
  const session = new LiveTranscoder('synthetic', 'h264', video, audio, false, 15, 'nvidia', new StreamDiagnostics(), chunk => output.push(chunk), () => {}, () => {}, args => {
    // Guaranteed missing encoder simulates builds without NVENC even on GPU CI.
    const child = spawn('ffmpeg', args.map(value => value === 'h264_nvenc' ? 'missing_test_encoder' : value), { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
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

test('complex synthetic video stays within the software output budget and remains decodable', { timeout: 15000 }, async () => {
  const producer = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=15,noise=alls=20:allf=t:all_seed=42', '-t', '3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-tune', 'zerolatency', '-f', 'h264', 'pipe:1']);
  const encoder = spawn('ffmpeg', liveArgs('h264', false, 15, 'software'));
  const chunks: Buffer[] = [];
  producer.stderr.resume(); encoder.stderr.resume();
  producer.stdout.pipe(encoder.stdin);
  encoder.stdout.on('data', chunk => chunks.push(chunk));
  try {
    const results = await Promise.all([once(producer, 'close'), once(encoder, 'close')]);
    assert.equal(results[0][0], 0); assert.equal(results[1][0], 0);
    const output = Buffer.concat(chunks);
    // Includes transport overhead and the one-megabit VBV startup allowance.
    assert.ok(output.length > 100_000 && output.length < 2_000_000, `Unexpected three-second output size: ${output.length}`);
    const { spawnSync } = await import('node:child_process');
    const decoded = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_name,nb_read_frames', '-of', 'json', 'pipe:0'], { input: output });
    assert.equal(decoded.status, 0);
    assert.equal(JSON.parse(decoded.stdout.toString()).streams[0].codec_name, 'h264');
    assert.equal(Number(JSON.parse(decoded.stdout.toString()).streams[0].nb_read_frames), 45);
  } finally { producer.kill('SIGKILL'); encoder.kill('SIGKILL'); }
});
