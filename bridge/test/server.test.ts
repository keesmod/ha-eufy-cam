import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { createBridge } from '../src/server.js';
import { StreamHub } from '../src/streams.js';
import type { Eufy } from '../src/eufy.js';

const token = 'x'.repeat(32);

test('authenticated bridge snapshots never start; websocket close stops last viewer', async () => {
  const calls: string[] = [];
  const fake = Object.assign(new EventEmitter(), {
    auth: { state: 'connected' }, inventory: () => [], hasCamera: (s: string) => s === 'CAM123',
    pictures: new Map([['CAM123', { data: Buffer.from([255, 216, 255, 217]), mime: 'image/jpeg' }]]),
    hub: new StreamHub({ start: async s => { calls.push(`start:${s}`); }, stop: async s => { calls.push(`stop:${s}`); }, disposeMedia: () => {} }),
  });
  const server = createBridge(fake as unknown as Eufy, token, 'bridge-test');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${base}/v1/state`)).status, 401);
    const headers = { Authorization: `Bearer ${token}` };
    assert.equal((await fetch(`${base}/v1/snapshot/CAM123`, { headers })).status, 200);
    assert.deepEqual(calls, []);
    const ws = new WebSocket(`${base}/v1/live/CAM123`, { headers });
    await once(ws, 'open'); assert.deepEqual(calls, ['start:CAM123']);
    const delivered = once(ws, 'message');
    fake.hub.frame('CAM123', Buffer.from('frame'));
    const [data] = await delivered; assert.equal(data.toString(), 'frame');
    ws.send('ack');
    const stopped = new Promise<void>(resolve => { const original = fake.hub.detach.bind(fake.hub); fake.hub.detach = (s, p) => { original(s, p); resolve(); }; });
    ws.close(); await stopped;
    assert.deepEqual(calls, ['start:CAM123', 'stop:CAM123']);
  } finally { server.emit('shutdown'); server.close(); await once(server, 'close'); }
});
