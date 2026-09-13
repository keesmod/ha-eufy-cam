// Synthetic media only. Run in the built image with --network none, no GPU.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { LiveTranscoder } from '/app/dist/live-transcoder.js';
import { StreamDiagnostics } from '/app/dist/diagnostics.js';
function ffmpeg(args) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, 'Synthetic FFmpeg input failed'); return result.stdout;
}
const audioBytes = ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1', '-c:a', 'aac', '-f', 'adts', 'pipe:1']);
for (const codec of ['h264', 'hevc']) {
  const videoBytes = ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15', '-t', '1', '-pix_fmt', 'yuv420p', '-c:v', codec === 'h264' ? 'libx264' : 'libx265', '-preset', 'ultrafast', '-threads', '1', ...(codec === 'hevc' ? ['-x265-params', 'pools=none:frame-threads=1'] : []), '-f', codec, 'pipe:1']);
  for (const mode of ['software', 'nvidia']) {
    const video = new PassThrough(), audio = new PassThrough(), chunks = [], events = [];
    const diagnostics = new StreamDiagnostics(line => events.push(JSON.parse(line).event));
    diagnostics.enabled = true; diagnostics.begin('synthetic');
    let ended;
    const done = new Promise(resolve => { ended = resolve; });
    const session = new LiveTranscoder('synthetic', codec, video, audio, true, 15, mode, diagnostics, chunk => chunks.push(chunk), ended, () => {});
    const timer = setTimeout(() => { session.stop(); ended(); }, 10000);
    try {
      session.start(); video.end(videoBytes); audio.end(audioBytes); await done;
      assert.ok(events.includes('media_active_software'));
      assert.equal(events.includes('media_software_fallback'), mode === 'nvidia');
      const encoded = Buffer.concat(chunks);
      assert.ok(encoded.length > 188);
      const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'json', '-i', 'pipe:0'], { input: encoded, timeout: 5000 });
      assert.equal(probe.status, 0);
      assert.deepEqual(JSON.parse(probe.stdout).streams.map(stream => stream.codec_name).sort(), ['aac', 'h264']);
      const decode = spawnSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 'null', '-'], { input: encoded, timeout: 5000 });
      assert.equal(decode.status, 0); assert.equal(decode.stderr.length, 0);
      console.log(`${codec} ${mode}: real A/V software output and cleanup passed`);
    } finally { clearTimeout(timer); session.stop(); }
  }
}
