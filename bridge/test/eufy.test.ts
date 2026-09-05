import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { EufySecurity, VideoCodec } from 'eufy-security-client';
import { Eufy } from '../src/eufy.js';
import { Storage } from '../src/storage.js';

test('SDK adapter disables cloud polling, converts real media, and retains last frame on close', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eufy-viewer-test-'));
  const storage = new Storage(directory);
  const calls: string[] = [];
  const sdk = Object.assign(new EventEmitter(), {
    isConnected: () => true,
    connect: async () => { sdk.emit('connect'); },
    close: () => {},
    setCameraMaxLivestreamDuration: (seconds: number) => assert.equal(seconds, 120),
    startStationLivestream: async (serial: string) => { calls.push(`start:${serial}`); },
    stopStationLivestream: async (serial: string) => { calls.push(`stop:${serial}`); },
  });
  const original = EufySecurity.initialize;
  EufySecurity.initialize = async config => {
    assert.equal(config.pollingIntervalMinutes, 0);
    assert.equal(config.acceptInvitations, false);
    assert.equal(typeof config.persistentData, 'string');
    assert.ok(Array.isArray(JSON.parse(config.persistentData!).push_persistentIds));
    return sdk as unknown as EufySecurity;
  };
  const bridge = new Eufy(storage);
  try {
    assert.equal((await bridge.login({ username: 'test@example.invalid', password: 'fixture-only', country: 'NL' })).state, 'connected');
    assert.deepEqual(calls, []);
    const frame = new Promise<Buffer>((resolve) => {
      bridge.hub.attach('CAM123', { bufferedAmount: 0, send: resolve, close: () => {} });
    });
    const producer = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=8', '-t', '1', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-f', 'h264', 'pipe:1']);
    sdk.emit('station livestream start', {}, { getSerial: () => 'CAM123' }, { videoCodec: VideoCodec.H264 }, producer.stdout, Readable.from([]));
    const jpeg = await frame;
    assert.equal(jpeg[0], 255); assert.equal(jpeg[1], 216);
    bridge.hub.close();
    assert.ok(calls.includes('stop:CAM123'));
    assert.equal(bridge.metrics.start_requests, 1);
    assert.equal(bridge.metrics.started_events, 1);
    assert.ok(bridge.metrics.frames > 0);
    assert.ok(bridge.metrics.stop_requests > 0);
    assert.ok(bridge.pictures.get('CAM123')?.data.length);
    producer.kill();
    bridge.hub.stopped('CAM123');
  } finally {
    EufySecurity.initialize = original;
    await bridge.close(); await rm(directory, { recursive: true, force: true });
  }
});
