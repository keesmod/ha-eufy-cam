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
