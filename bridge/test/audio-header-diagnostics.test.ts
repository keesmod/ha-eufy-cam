import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { AudioHeaderDiagnostics, adtsHeader } from '../src/audio-header-diagnostics.js';
function frame(rate = 4, channel = 2, blocks = 1, crc = false) {
  const length = crc ? 12 : 10;
  return Buffer.from([0xff, crc ? 0xf0 : 0xf1, 0x40 | rate << 2 | channel >> 2,
    (channel & 3) << 6, length >> 3, (length & 7) << 5 | 0x1f, 0xfc | blocks - 1,
    ...Array(length - 7).fill(0)]);
}
test('structural parser retains first and changed configuration without claiming channel count for PCE', () => {
  const d = new AudioHeaderDiagnostics(); const first = frame();
  d.write(first.subarray(0, 2)); assert.equal(d.snapshot().trailing_header_bytes, 2);
  d.write(first.subarray(2, 8)); assert.equal(d.snapshot().pending_frame_bytes, 2);
  assert.equal(d.snapshot().adts_frames, 0);
  d.write(first.subarray(8)); d.write(frame(8, 0, 4, true));
  const r = d.snapshot();
  assert.equal(r.adts_frames, 2); assert.equal(r.adts_header_changes, 1);
  assert.equal(r.adts_multiblock_frames, 1); assert.equal(r.first_adts?.sample_rate_hz, 44100);
  assert.deepEqual(r.adts, { mpeg_version: 4, object_type: 2, sample_rate_hz: 16000,
    channel_config: 0, crc_present: true, frame_bytes: 12, raw_data_blocks: 4 });
  assert.equal(r.adts_min_frame_bytes, 10); assert.equal(r.adts_max_frame_bytes, 12);
  r.adts!.sample_rate_hz = 0; assert.equal(d.snapshot().adts?.sample_rate_hz, 16000);
});
test('invalid prefixes, incomplete frames and scan limits remain explicit', () => {
  const d = new AudioHeaderDiagnostics(); d.write(Buffer.alloc(11)); d.write(frame().subarray(0, 8));
  const r = d.snapshot(); assert.equal(r.format_hint, 'unknown'); assert.equal(r.skipped_bytes, 11);
  assert.equal(r.adts_frames, 0); assert.equal(r.pending_frame_bytes, 2); assert.ok(r.adts);
  d.clear(); assert.equal(d.snapshot().pending_frame_bytes, 2);
  assert.equal(adtsHeader(frame(15)), undefined);
  const badLength = frame(); badLength[4] = 0; badLength[5] = 0;
  assert.equal(adtsHeader(badLength), undefined);
  const bounded = new AudioHeaderDiagnostics(64, 2); bounded.write(Buffer.alloc(1024 * 1024));
  assert.equal(bounded.snapshot().inspected_bytes, 64); assert.equal(bounded.snapshot().inspection_limited, true);
  const frames = new AudioHeaderDiagnostics(64, 2); frames.write(Buffer.concat(Array(1000).fill(frame())));
  assert.equal(frames.snapshot().adts_frames, 2); assert.equal(frames.snapshot().inspected_bytes, 20);
  assert.equal(frames.snapshot().inspection_limited, true);
});
for (const [prefix, hint] of [
  [Buffer.from('ADIFxxx'), 'adif'], [Buffer.from('RIFFxxx'), 'riff'],
  [Buffer.from('OggSxxx'), 'ogg'], [Buffer.from([0x56, 0xe0, 0, 0, 0, 0, 0]), 'loas'],
] as const) test(`${hint} signature is a hint without invented AAC properties`, () => {
  const d = new AudioHeaderDiagnostics(); d.write(prefix);
  assert.equal(d.snapshot().format_hint, hint); assert.equal(d.snapshot().adts, undefined);
});
for (const [rate, channels] of [[16000, 1], [48000, 2]]) test(`real AAC ${rate} Hz / ${channels} channels agrees with ffprobe through arbitrary fragments`, () => {
  const encoded = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${rate}`, '-t', '0.2', '-ac', String(channels), '-c:a', 'aac', '-f', 'adts', 'pipe:1']);
  assert.equal(encoded.status, 0, encoded.stderr.toString()); const original = Buffer.from(encoded.stdout);
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,profile,sample_rate,channels', '-of', 'json', '-i', 'pipe:0'], { input: original });
  assert.equal(probe.status, 0); const expected = JSON.parse(probe.stdout.toString()).streams[0];
  assert.equal(expected.codec_name, 'aac'); assert.equal(expected.profile, 'LC');
  const d = new AudioHeaderDiagnostics();
  for (let i = 0; i < original.length; i += 3) d.write(original.subarray(i, i + 3));
  const r = d.snapshot(); assert.equal(r.first_adts?.object_type, 2);
  assert.equal(r.first_adts?.sample_rate_hz, Number(expected.sample_rate));
  assert.equal(r.first_adts?.channel_config, expected.channels); assert.ok(r.adts_frames > 1);
  assert.equal(r.pending_frame_bytes, 0); assert.equal(r.trailing_header_bytes, 0); assert.equal(r.skipped_bytes, 0);
  assert.deepEqual(encoded.stdout, original, 'Never change input audio');
});
