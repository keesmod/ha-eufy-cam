import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// Synthetic media only. Run in the built image with --network none, no GPU.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { RecordingTranscoder } from '/app/dist/recording-media.js';
import { LiveTranscoder } from '/app/dist/live-transcoder.js';
import { LateAudio } from '/app/dist/late-audio.js';
import { StreamDiagnostics } from '/app/dist/diagnostics.js';
import { AudioFrameLog } from '/app/dist/eld-audio.js';
import { LiveAudioUnits, LiveEldAudio } from '/app/dist/live-eld-audio.js';
const ELD_TONE = [
  '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',
].join('');
function ffmpeg(args) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, 'Synthetic FFmpeg input failed'); return result.stdout;
}
const audioBytes = ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1', '-c:a', 'aac', '-f', 'adts', 'pipe:1']);
for (const codec of ['h264', 'hevc']) {
  const videoBytes = ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15', '-t', '1', '-pix_fmt', 'yuv420p', '-c:v', codec === 'h264' ? 'libx264' : 'libx265', '-preset', 'ultrafast', '-threads', '1', ...(codec === 'hevc' ? ['-x265-params', 'pools=none:frame-threads=1'] : []), '-f', codec, 'pipe:1']);
  for (const mode of ['software', 'nvidia']) {
    const video = new PassThrough(), audio = new PassThrough(), chunks = [], audioFrames = [], events = [];
    let audioReady = false;
    const audioReader = new LateAudio(audio, () => { audioReady = true; }, frame => audioFrames.push(Buffer.from(frame)));
    const diagnostics = new StreamDiagnostics(line => events.push(JSON.parse(line).event));
    diagnostics.enabled = true; diagnostics.begin('synthetic');
    let ended;
    const done = new Promise(resolve => { ended = resolve; });
    const session = new LiveTranscoder('synthetic', codec, video, 15, mode, diagnostics, chunk => chunks.push(chunk), ended, () => {});
    const timer = setTimeout(() => { session.stop(); ended(); }, 10000);
    try {
      session.start(); video.end(videoBytes); audio.end(audioBytes); await done;
      assert.ok(events.includes('media_active_software'));
      assert.equal(events.includes('media_software_fallback'), mode === 'nvidia');
      const encoded = Buffer.concat(chunks);
      assert.ok(encoded.length > 188);
      const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name:packet=dts', '-of', 'json', '-i', 'pipe:0'], { input: encoded, timeout: 5000 });
      assert.equal(probe.status, 0);
      const observed = JSON.parse(probe.stdout);
      assert.deepEqual(observed.streams.map(stream => stream.codec_name), ['h264']);
      assert.equal(observed.packets.length, 15);
      for (let i = 1; i < observed.packets.length; i++) assert.ok(observed.packets[i].dts > observed.packets[i - 1].dts);
      // The fixture arrives in one burst. Preserve its 90 kHz timestamps in
      // the validation sink instead of rounding them back to nominal 15 fps.
      const decode = spawnSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-fps_mode', 'passthrough', '-enc_time_base', '1:90000', '-f', 'null', '-'], { input: encoded, timeout: 5000 });
      assert.equal(decode.status, 0); assert.equal(decode.stderr.length, 0, decode.stderr.toString());
      assert.equal(audioReady, true);
      assert.deepEqual(Buffer.concat(audioFrames), audioBytes, 'The independent audio reader retains every complete AAC frame');
      const audioDecode = spawnSync('ffmpeg', ['-v', 'error', '-f', 'aac', '-i', 'pipe:0', '-f', 'null', '-'], { input: Buffer.concat(audioFrames), timeout: 5000 });
      assert.equal(audioDecode.status, 0); assert.equal(audioDecode.stderr.length, 0, audioDecode.stderr.toString());
      assert.equal(audioReader.ready, false, 'Audio EOF releases its reader');
      assert.equal(audio.listenerCount('data'), 0);
      console.log(`${codec} ${mode}: separate decoded video and AAC, software fallback and cleanup passed`);
    } finally { clearTimeout(timer); session.stop(); audioReader.stop(); video.destroy(); audio.destroy(); }
  }
  // Raw recording tracks have no packet timestamps. Use a synthetic stream
  // without frame reordering for native remux checks. Keep the original HEVC
  // fixture above for the existing live decoding/transcoding checks.
  const recordingBytes = codec === 'hevc'
    ? ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15', '-t', '1', '-pix_fmt', 'yuv420p', '-c:v', 'libx265', '-preset', 'ultrafast', '-threads', '1', '-x265-params', 'pools=none:frame-threads=1:bframes=0', '-f', 'hevc', 'pipe:1'])
    : videoBytes;
  for (const mode of ['software', 'nvidia']) {
    for (const format of ['native', 'h264']) {
      const events = [];
      const dir = mkdtempSync(join(tmpdir(), 'recording-smoke-'));
      const files = { video: join(dir, 'video'), audio: join(dir, 'audio'), output: join(dir, 'output') };
      writeFileSync(files.video, recordingBytes); writeFileSync(files.audio, audioBytes);
      let output;
      try {
        const result = await new RecordingTranscoder(mode, e => events.push(e.event)).muxResult(
          { videoCodec: codec, fps: 15 }, files, AbortSignal.timeout(15000), format);
        output = readFileSync(result.path);
      } finally { rmSync(dir, { recursive: true, force: true }); }
      const transcode = codec === 'hevc' && format === 'h264';
      assert.ok(events.includes(transcode ? 'recording_active_software' : 'recording_remuxed'));
      assert.equal(events.includes('recording_software_fallback'), transcode && mode === 'nvidia');
      const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'json', '-i', 'pipe:0'], { input: output, timeout: 5000 });
      assert.equal(probe.status, 0);
      assert.deepEqual(JSON.parse(probe.stdout).streams.map(s => s.codec_name).sort(), ['aac', transcode ? 'h264' : codec]);
      const decode = spawnSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 'null', '-'], { input: output, timeout: 5000 });
      assert.equal(decode.status, 0); assert.equal(decode.stderr.length, 0, decode.stderr.toString());
      console.log(`recording ${codec} ${format} ${mode}: decoded complete MP4 A/V`);
    }
  }

}
// Raw AAC-ELD recording audio, as a Video Doorbell S4 sends it (#264), decodes
// through the image's FDK AAC helper and leaves as AAC-LC beside the video.
// The units are a 440 Hz tone that libfdk-aac 2.0.3 encoded as ER AAC-ELD at
// 16 kHz, mono, 480 samples, 24 kbit/s, each behind a 16-bit length.
{
  const framed = Buffer.from(ELD_TONE, 'base64'), units = [];
  for (let i = 0; i < framed.length;) { const n = framed.readUInt16BE(i); units.push(framed.subarray(i + 2, i + 2 + n)); i += 2 + n; }
  assert.equal(units.length, 34);
  const video = ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15', '-t', '1', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-f', 'h264', 'pipe:1']);
  const dir = mkdtempSync(join(tmpdir(), 'recording-eld-smoke-'));
  const frames = new AudioFrameLog();
  let offset = 0;
  units.forEach((unit, i) => { frames.add({ offset, bytes: unit.length, timestampMs: 1000 + 30 * i }); offset += unit.length; });
  const files = { video: join(dir, 'video'), audio: join(dir, 'audio'), output: join(dir, 'output'), audioFrames: frames };
  writeFileSync(files.video, video); writeFileSync(files.audio, Buffer.concat(units));
  const events = [];
  let output;
  try {
    await new RecordingTranscoder('software', e => events.push(e)).muxResult(
      { videoCodec: 'h264', fps: 15, audioCodec: 'aac-eld' }, files, AbortSignal.timeout(15000), 'native');
    output = readFileSync(files.output);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const input = events.find(e => e.event === 'recording_input_adjusted').input;
  assert.deepEqual({ decode: input.audio_decode, units: input.audio_units, errors: input.audio_errors, rate: input.audio_rate, ms: input.audio_frame_ms },
    { decode: 'decoded', units: 34, errors: 0, rate: 16000, ms: 30 });
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels', '-of', 'json', '-i', 'pipe:0'], { input: output, timeout: 5000 });
  assert.equal(probe.status, 0);
  const streams = JSON.parse(probe.stdout).streams;
  assert.deepEqual(streams.map(s => s.codec_name).sort(), ['aac', 'h264']);
  const audio = streams.find(s => s.codec_name === 'aac');
  assert.deepEqual([Number(audio.sample_rate), audio.channels], [16000, 1]);
  // The decoded tone, not silence: count zero crossings after the codec delay.
  const pcm = spawnSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-map', '0:a:0', '-f', 's16le', '-ac', '1', '-ar', '16000', 'pipe:1'], { input: output, timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(pcm.status, 0);
  const samples = new Int16Array(pcm.stdout.buffer, pcm.stdout.byteOffset, pcm.stdout.length >> 1).slice(4800);
  let crossings = 0, peak = 0;
  for (let i = 1; i < samples.length; i++) { if ((samples[i - 1] < 0) !== (samples[i] < 0)) crossings++; peak = Math.max(peak, Math.abs(samples[i])); }
  const hz = crossings / 2 / (samples.length / 16000);
  assert.ok(Math.abs(hz - 440) < 10 && peak > 4000, `decoded ${hz.toFixed(1)} Hz, peak ${peak}`);
  console.log(`recording aac-eld: 34 units decoded through FDK AAC, AAC-LC tone at ${hz.toFixed(1)} Hz beside H.264`);
}
// Live AAC-ELD, as the Video Doorbell S4 sends it (#269): the same units, three
// times and one every 30 ms like the camera, go through the image's helper in
// stream mode and FFmpeg, and reach the late audio reader as ADTS AAC-LC while
// the stream still runs.
{
  const framed = Buffer.from(ELD_TONE, 'base64'), tone = [];
  for (let i = 0; i < framed.length;) { const n = framed.readUInt16BE(i); tone.push(framed.subarray(i + 2, i + 2 + n)); i += 2 + n; }
  const units = [...tone, ...tone, ...tone];
  const source = new PassThrough(), timing = new LiveAudioUnits(), reports = [], frames = [];
  const eld = new LiveEldAudio(source, timing, () => 'aac-eld', { log: report => reports.push(report) });
  let readyAt;
  const reader = new LateAudio(eld.output, () => { readyAt = performance.now(); }, frame => frames.push(Buffer.from(frame)));
  const started = performance.now();
  let offset = 0, sentAt;
  try {
    for (let i = 0; i < units.length; i++) {
      await new Promise(resolve => setTimeout(resolve, Math.max(0, started + 30 * i - performance.now())));
      timing.timing({ kind: 'audio', offset, bytes: units[i].length, timestampMs: 30 * i, keyFrame: false });
      offset += units[i].length;
      source.write(units[i]);
    }
    sentAt = performance.now();
    await new Promise(resolve => setTimeout(resolve, 500));
    source.end();
    assert.equal(await eld.stop(), true, 'Both processes confirmed their stop');
  } finally { reader.stop(); source.destroy(); await eld.stop(); }
  assert.ok(readyAt !== undefined && readyAt < sentAt, 'The first ADTS frame arrived while units still flowed');
  // The helper reported 100 units without errors before its stop.
  const [report] = reports;
  assert.deepEqual({ outcome: report.outcome, units: report.units, errors: report.errors, skipped: report.skipped_bytes, confirmed: report.stop_confirmed },
    { outcome: 'ended', units: 102, errors: 0, skipped: 0, confirmed: true });
  const audio = Buffer.concat(frames);
  const probe = spawnSync('ffprobe', ['-v', 'error', '-f', 'aac', '-show_entries', 'stream=codec_name,profile,sample_rate,channels', '-of', 'json', 'pipe:0'], { input: audio, timeout: 5000 });
  assert.equal(probe.status, 0);
  const [stream] = JSON.parse(probe.stdout).streams;
  assert.deepEqual([stream.codec_name, stream.profile, Number(stream.sample_rate), stream.channels], ['aac', 'LC', 16000, 1]);
  const pcm = spawnSync('ffmpeg', ['-v', 'error', '-f', 'aac', '-i', 'pipe:0', '-f', 's16le', '-ac', '1', '-ar', '16000', 'pipe:1'], { input: audio, timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(pcm.status, 0); assert.equal(pcm.stderr.length, 0, pcm.stderr.toString());
  const samples = new Int16Array(pcm.stdout.buffer, pcm.stdout.byteOffset, pcm.stdout.length >> 1).slice(4800);
  let crossings = 0, peak = 0;
  for (let i = 1; i < samples.length; i++) { if ((samples[i - 1] < 0) !== (samples[i] < 0)) crossings++; peak = Math.max(peak, Math.abs(samples[i])); }
  const hz = crossings / 2 / (samples.length / 16000);
  assert.ok(samples.length >= 16000 * 2, `decoded ${samples.length} samples after the first 0.3 s`);
  assert.ok(Math.abs(hz - 440) < 10 && peak > 4000, `decoded ${hz.toFixed(1)} Hz, peak ${peak}`);
  console.log(`live aac-eld: 102 units streamed through FDK AAC and FFmpeg, first ADTS after ${report.first_output_ms} ms, AAC-LC tone at ${hz.toFixed(1)} Hz`);
}
// A mid-stream change of the frame size makes FFmpeg rebuild its filter graph.
// Paced in real time, the live encoder keeps its clock and every frame with the
// FFmpeg of this image (#122).
{
  const units = size => {
    const bytes = ffmpeg(['-f', 'lavfi', '-i', `testsrc=size=${size}:rate=15`, '-t', '2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '30', '-x264-params', 'aud=1', '-f', 'h264', 'pipe:1']);
    const starts = [];
    for (let i = 0; i + 4 < bytes.length; i++) if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1 && (bytes[i + 3] & 0x1f) === 9) starts.push(bytes[i - 1] === 0 ? i - 1 : i);
    return starts.map((start, k) => bytes.subarray(start, starts[k + 1] ?? bytes.length));
  };
  const frames = [...units('320x180'), ...units('480x270')];
  assert.equal(frames.length, 60);
  const video = new PassThrough(), chunks = [], progress = [];
  let ended;
  const done = new Promise(resolve => { ended = resolve; });
  const session = new LiveTranscoder('synthetic', 'h264', video, 15, 'software', new StreamDiagnostics(), chunk => chunks.push(chunk), () => ended(), () => {},
    undefined, undefined, undefined, undefined, value => progress.push(value));
  const timer = setTimeout(() => { session.stop(); ended(); }, 15000);
  try {
    session.start();
    const started = performance.now();
    for (let sent = 0; sent < frames.length; sent += 3) {
      await new Promise(resolve => setTimeout(resolve, Math.max(0, started + (sent + 3) * 200 / 3 - performance.now())));
      video.write(Buffer.concat(frames.slice(sent, sent + 3)));
    }
    // FFmpeg 5.1 reports only while input arrives, so the complete output
    // after the end of the input carries the frame count.
    video.end(); await done;
    assert.ok(progress.some(block => block.frames > 30), 'A progress block after the size change');
    assert.deepEqual(progress.map(block => block.dropped ?? 0).filter(Boolean), [], 'The video sync drops nothing after the size change');
    const probe = spawnSync('ffprobe', ['-v', 'error', '-f', 'mpegts', '-show_entries', 'frame=width,height', '-of', 'json', 'pipe:0'], { input: Buffer.concat(chunks), timeout: 5000 });
    assert.equal(probe.status, 0);
    const sizes = JSON.parse(probe.stdout).frames.map(frame => `${frame.width}x${frame.height}`);
    assert.ok(sizes.length >= 55, `decoded ${sizes.length} frames`);
    assert.deepEqual([...new Set(sizes)], ['320x180'], 'One output size across the change');
    console.log(`live size change: ${sizes.length} frames decoded, 0 dropped in ${progress.length} progress blocks, one output size`);
  } finally { clearTimeout(timer); session.stop(); video.destroy(); }
}
// A portrait HEVC source above the 1080p pixel count, like the T8213 doorbell,
// leaves within 1920 wide and the pixel count of 1920x1080 with the FFmpeg of
// this image (#186).
{
  const videoBytes = ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=1600x2300:rate=15', '-t', '0.4', '-pix_fmt', 'yuv420p', '-c:v', 'libx265', '-preset', 'ultrafast', '-threads', '1', '-x265-params', 'pools=none:frame-threads=1', '-f', 'hevc', 'pipe:1']);
  const video = new PassThrough(), chunks = [];
  let ended;
  const done = new Promise(resolve => { ended = resolve; });
  const session = new LiveTranscoder('synthetic', 'hevc', video, 15, 'software', new StreamDiagnostics(), chunk => chunks.push(chunk), ended, () => {});
  const timer = setTimeout(() => { session.stop(); ended(); }, 10000);
  try {
    session.start(); video.end(videoBytes); await done;
    const probe = spawnSync('ffprobe', ['-v', 'error', '-f', 'mpegts', '-show_entries', 'stream=width,height,level', '-of', 'json', 'pipe:0'], { input: Buffer.concat(chunks), timeout: 5000 });
    assert.equal(probe.status, 0);
    const [stream] = JSON.parse(probe.stdout).streams;
    assert.deepEqual([stream.width, stream.height], [1200, 1726]);
    assert.ok(stream.level <= 41, `level ${stream.level}`);
    console.log(`live portrait 1600x2300 hevc: ${stream.width}x${stream.height} at level ${stream.level}`);
  } finally { clearTimeout(timer); session.stop(); video.destroy(); }
}
