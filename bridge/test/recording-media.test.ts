import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { RecordingTranscoder, recordingAcceleration, recordingArgs } from '../src/recording-media.js';

class Process extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough(); audio = new PassThrough();
  stdio = [this.stdin, this.stdout, this.stderr, this.audio];
  killed = false;
  kill() { this.killed = true; queueMicrotask(() => this.emit('close', null)); return true; }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const metadata = { videoCodec: 'hevc' as const, fps: 15 };
function fixture(overrides = {}, mode: 'nvidia' | 'software' = 'nvidia') {
  const children: Process[] = [], commands: string[][] = [], events: any[] = [];
  const media = new RecordingTranscoder(mode, event => events.push(event), args => {
    commands.push(args); const child = new Process(); children.push(child); return child as unknown as ChildProcess;
  }, { conversionMs: 1000, remuxMs: 1000, hardwareMs: 500, cleanupMs: 30, bytes: 1024, ...overrides });
  const abort = new AbortController();
  const run = () => media.mux(metadata, Buffer.from('original-video'), Buffer.from('original-audio'), abort.signal);
  return { media, children, commands, events, abort, run };
}
function complete(child: Process, value = 'complete-mp4') { child.stdout.write(value); child.emit('close', 0); }

test('recording acceleration is independently opt-in and validated', () => {
  assert.equal(recordingAcceleration(), 'software'); assert.equal(recordingAcceleration('nvidia'), 'nvidia');
  assert.equal(recordingAcceleration('software'), 'software');
  for (const value of ['', 'auto', '-gpu all']) assert.throws(() => recordingAcceleration(value), /EUFY_RECORDING_ACCELERATION/);
});
test('native HEVC and H264 are copied even when NVIDIA is selected', () => {
  for (const [codec, format] of [['h264', 'native'], ['h264', 'h264'], ['hevc', 'native']] as const) {
    const args = recordingArgs({ videoCodec: codec, fps: 15 }, true, format, 'nvidia');
    assert.equal(args[args.indexOf('-c:v') + 1], 'copy'); assert.ok(!args.includes('cuda'));
    assert.ok(args.includes('aac_adtstoasc'));
    assert.equal(args.includes('hvc1'), codec === 'hevc');
  }
  const args = recordingArgs(metadata, true, 'h264', 'nvidia');
  assert.ok(args.indexOf('-hwaccel') < args.indexOf('-i')); assert.ok(args.includes('h264_nvenc'));
  assert.ok(args.includes('yuv420p')); assert.ok(!args.includes('libx264'));
  assert.throws(() => recordingArgs({ videoCodec: null, fps: 15 }, false, 'h264', 'nvidia'));
});
test('hardware success returns complete output and anonymous diagnostics', async () => {
  const f = fixture(); const result = f.run(); complete(f.children[0]!);
  assert.equal((await result).toString(), 'complete-mp4'); assert.equal(f.children.length, 1);
  assert.equal(f.events[0].event, 'recording_active_nvidia');
  assert.deepEqual(Object.keys(f.events[0]).sort(), ['attempt', 'diagnostic', 'elapsed_ms', 'event']);
});
test('failure discards partial hardware output and reuses both tracks once after close', async () => {
  const f = fixture(); const result = f.run();
  f.children[0]!.stdout.write('discard-me'); f.children[0]!.emit('error', new Error('private driver details'));
  assert.equal(f.children.length, 1); await tick(); assert.equal(f.children[0]!.killed, true);
  assert.equal(f.children.length, 2); assert.ok(f.commands[1]!.includes('libx264'));
  assert.equal(f.children[1]!.stdin.read().toString(), 'original-video');
  assert.equal(f.children[1]!.audio.read().toString(), 'original-audio');
  complete(f.children[1]!); assert.equal((await result).toString(), 'complete-mp4');
  assert.ok(!JSON.stringify(f.events).includes('private'));
  const next = f.run(); assert.ok(f.commands[2]!.includes('libx264')); complete(f.children[2]!); await next;
});
test('hardware deadline falls back within the shared conversion deadline', async () => {
  const f = fixture({ hardwareMs: 10 }); const result = f.run();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(f.children.length, 2); complete(f.children[1]!); await result;
  assert.ok(f.events.some(e => e.event === 'recording_hardware_timeout'));
});
test('abort during hardware cleanup prevents a software retry', async () => {
  const f = fixture(); const result = f.run(); const rejected = assert.rejects(result);
  f.children[0]!.emit('error', new Error('failed')); f.abort.abort(); await rejected;
  assert.equal(f.children.length, 1);
});
test('unconfirmed process cleanup blocks retries and subsequent conversions until restart', async () => {
  const f = fixture(); const result = f.run(); const rejected = assert.rejects(result);
  f.children[0]!.kill = () => false; f.children[0]!.emit('error', new Error('stuck'));
  await rejected; assert.equal(f.children.length, 1);
  await assert.rejects(f.run(), /requires restart/); assert.equal(f.children.length, 1);
});
test('output size cap never falls back or returns partial media', async () => {
  const f = fixture({ bytes: 4 }); const result = f.run(); const rejected = assert.rejects(result);
  f.children[0]!.stdout.write('oversized'); await rejected;
  assert.equal(f.children.length, 1); assert.equal(f.children[0]!.killed, true);
});
test('software failure is not retried and total timeout remains bounded', async () => {
  const f = fixture({ conversionMs: 35, hardwareMs: 10 });
  await assert.rejects(f.run()); assert.equal(f.children.length, 2);
  assert.ok(f.children.every(child => child.killed));
});
test('cancelling software conversion terminates its process and returns no media', async () => {
  const f = fixture({}, 'software'); const result = f.run(); const rejected = assert.rejects(result);
  f.abort.abort(); await rejected; assert.equal(f.children.length, 1); assert.ok(f.children[0]!.killed);
});
test('remux diagnostic identifies unchanged native playback with NVIDIA enabled', async () => {
  const f = fixture(); const result = f.media.mux(metadata, Buffer.from('video'), Buffer.alloc(0), f.abort.signal, 'native');
  assert.ok(!f.commands[0]!.includes('cuda')); complete(f.children[0]!); await result;
  assert.equal(f.events[0].event, 'recording_remuxed');
});

test('real software and missing-GPU HEVC conversion preserve decodable H264/AAC MP4', async () => {
  const generate = (args: string[]) => {
    const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { timeout: 10000, maxBuffer: 4*1024*1024 });
    assert.equal(result.status, 0); return result.stdout;
  };
  const video = generate(['-f','lavfi','-i','testsrc=size=320x180:rate=15','-t','1','-pix_fmt','yuv420p','-c:v','libx265','-preset','ultrafast','-threads','1','-x265-params','pools=none:frame-threads=1','-f','hevc','pipe:1']);
  const audio = generate(['-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','1','-c:a','aac','-f','adts','pipe:1']);
  for (const mode of ['software','nvidia'] as const) {
    const events: string[] = [];
    const output = await new RecordingTranscoder(mode, e => events.push(e.event)).mux(metadata, video, audio, AbortSignal.timeout(15000));
    assert.ok(events.includes('recording_active_software') || events.includes('recording_active_nvidia'));
    if (mode === 'nvidia' && !events.includes('recording_active_nvidia')) assert.ok(events.includes('recording_software_fallback'));
    const probe = spawnSync('ffprobe', ['-v','error','-show_entries','stream=codec_name','-of','json','-i','pipe:0'], { input: output, timeout: 5000 });
    assert.equal(probe.status, 0); assert.deepEqual(JSON.parse(probe.stdout.toString()).streams.map((s: any) => s.codec_name).sort(), ['aac','h264']);
    const decode = spawnSync('ffmpeg', ['-v','error','-i','pipe:0','-f','null','-'], { input: output, timeout: 5000 });
    assert.equal(decode.status, 0); assert.equal(decode.stderr.length, 0);
  }
});

test('bridge fallback converts one completed transfer while retaining recording ownership', async () => {
  const { MegaRecordings } = await import('../src/mega-recordings.js');
  const f = fixture(); let downloads = 0, cancellations = 0;
  const client = {
    connected: true,
    listRecordings: async () => ({ complete: true, returned: 1, recordings: [{ id: 'fixture', deviceId: 'CAM', stationId: 'BASE', start: '2026-09-13T10:00:00Z', end: '2026-09-13T10:00:01Z', bytes: 100, thumbnail: false }] }),
    downloadRecording: async () => {
      downloads++;
      const video = new PassThrough(), audio = new PassThrough();
      return { video, audio, metadata: { videoCodec: 'h265', fps: 15 },
        completed: new Promise(resolve => setImmediate(() => { video.end('original-video'); audio.end('original-audio'); resolve({ complete: true }); })),
        cancel: async () => { cancellations++; } };
    },
  };
  const recordings = new MegaRecordings(() => client as any, () => [{ id: 'CAM', stationId: 'BASE', kind: 'camera' }] as any, () => false, undefined, f.media);
  const rows = await recordings.list('CAM', '2026-09-13', f.abort.signal);
  const result = recordings.video('CAM', rows.recordings[0]!.id, f.abort.signal);
  while (!f.children.length) await tick();
  assert.ok(recordings.busy); f.children[0]!.emit('error', new Error('missing GPU')); await tick();
  assert.ok(recordings.busy); assert.equal(downloads, 1); assert.equal(f.children.length, 2);
  complete(f.children[1]!); await result;
  assert.equal(downloads, 1); assert.equal(cancellations, 1); assert.equal(recordings.busy, false);
  assert.equal(recordings.metrics.transcoded, 1); assert.equal(recordings.metrics.completed, 1);
});


test('Auto resolves each codec with configured acceleration and browser support', async () => {
  for (const codec of ['h264', 'hevc'] as const) for (const mode of ['software', 'nvidia'] as const)
    for (const supports of [false, true]) for (const format of ['auto', 'native', 'h264'] as const) {
      const f = fixture({}, mode);
      const transcode = codec === 'hevc' && (format === 'h264' || (format === 'auto' && (mode === 'nvidia' || !supports)));
      const result = f.media.muxResult({ videoCodec: codec, fps: 15 }, Buffer.from('v'), Buffer.from('a'), f.abort.signal, format, supports);
      assert.equal(f.commands[0]![f.commands[0]!.indexOf('-c:v') + 1], transcode ? mode === 'nvidia' ? 'h264_nvenc' : 'libx264' : 'copy');
      complete(f.children[0]!);
      assert.deepEqual((await result).media, { source: codec, output: transcode ? 'h264' : codec, processing: transcode ? mode : 'remux', fallback: false });
    }
});
test('result describes actual software fallback and circuit breaker per request', async () => {
  const f = fixture();
  const result = f.media.muxResult(metadata, Buffer.from('v'), Buffer.from('a'), f.abort.signal, 'auto', true);
  f.children[0]!.emit('error', new Error('GPU failed')); await tick(); complete(f.children[1]!);
  assert.deepEqual((await result).media, { source: 'hevc', output: 'h264', processing: 'software', fallback: true });
  const next = f.media.muxResult(metadata, Buffer.from('v'), Buffer.alloc(0), f.abort.signal, 'auto', true);
  complete(f.children[2]!); assert.equal((await next).media.fallback, true);
  const native = f.media.muxResult(metadata, Buffer.from('v'), Buffer.alloc(0), f.abort.signal, 'native', true);
  complete(f.children[3]!); assert.deepEqual((await native).media, { source: 'hevc', output: 'hevc', processing: 'remux', fallback: false });
});
