import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { createBridge } from '../src/server.js';
import { StreamHub } from '../src/streams.js';
import type { Eufy } from '../src/eufy.js';

const token = 'x'.repeat(32);

test('migration transfer requires authentication and reports only fixed refusal codes', async () => {
  const { MigrationError } = await import('../src/migration.js');
  const accepted: unknown[] = [];
  const fake = Object.assign(new EventEmitter(), {
    auth: {state:'error'}, backendName:'mega', migrationError:'inventory_required',
    inventory: () => [], pictures: new Map(),
    hub: new StreamHub({start:async()=>{},stop:async()=>{},disposeMedia:()=>{}}),
    acceptMigration: async (value: unknown) => {
      if ((value as {bridge_id:string}).bridge_id !== 'bridge-test') throw new MigrationError('bridge_identity_mismatch');
      accepted.push(value);
    },
  });
  const server = createBridge(fake as unknown as Eufy, token, 'bridge-test');
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/v1/migration`;
  try {
    assert.equal((await fetch(url,{method:'POST',body:'{}'})).status,401);
    assert.deepEqual(accepted,[]);
    const headers = {Authorization:`Bearer ${token}`};
    const wrong = await fetch(url,{method:'POST',headers,body:'{"bridge_id":"other"}'});
    assert.equal(wrong.status,409);
    assert.deepEqual(await wrong.json(),{error:'bridge_identity_mismatch'});
    const baseline = {bridge_id:'bridge-test',version:1,backend:'legacy',cameras:['CAM'],stations:[]};
    const result = await fetch(url,{method:'POST',headers,body:JSON.stringify(baseline)});
    assert.equal(result.status,200);
    assert.deepEqual(await result.json(),{accepted:true});
    assert.deepEqual(accepted,[baseline]);
  } finally { server.emit('shutdown'); server.closeAllConnections(); server.close(); await once(server,'close'); }
});

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

for (const hasAudio of [false, true]) test(`WebRTC grants report audio=${hasAudio} after the first frame and expire with their owner`, { timeout: 5000 }, async t => {
  const { MediaRelay } = await import('../src/media.js');
  const calls: string[] = [];
  const media = new MediaRelay(() => {});
  t.mock.method(media, 'audioSupported', () => hasAudio);
  const hub = new StreamHub({ start: async s => { calls.push(`start:${s}`); }, stop: async s => { calls.push(`stop:${s}`); }, disposeMedia: s => media.stop(s) });
  const fake = Object.assign(new EventEmitter(), { auth: { state: 'connected' }, inventory: () => [], hasCamera: (s: string) => s === 'CAM123', pictures: new Map(), hub, media, metrics: {} });
  const server = createBridge(fake as unknown as Eufy, token, 'bridge-test');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  let ws: WebSocket | undefined;
  try {
    assert.equal((await fetch(`${base}/v1/media/${'a'.repeat(64)}`)).status, 404);
    assert.deepEqual(calls, []);
    ws = new WebSocket(`${base}/v1/live/CAM123?transport=webrtc`, { headers: { Authorization: `Bearer ${token}` } });
    const messages: { data: string; binary: boolean }[] = [];
    let receivedBoth!: () => void;
    const bothMessages = new Promise<void>(resolve => { receivedBoth = resolve; });
    ws.on('message', (data, binary) => {
      messages.push({ data: data.toString(), binary });
      if (messages.length === 2) receivedBoth();
    });
    await once(ws, 'open');
    assert.deepEqual(messages, [], 'No fabricated audio capability before media arrives');
    const first = once(ws, 'message');
    hub.frame('CAM123', Buffer.from('jpeg-not-forwarded'));
    const [ready] = await first;
    const message = JSON.parse(ready.toString());
    assert.equal(message.type, 'ready'); assert.match(message.path, /^\/v1\/media\/[a-f0-9]{64}$/);
    assert.deepEqual(calls, ['start:CAM123']);
    assert.equal(message.audio, hasAudio);
    await bothMessages;
    assert.equal(messages.length, 2);
    assert.equal(messages[1]!.binary, false);
    assert.deepEqual(JSON.parse(messages[1]!.data), { type: 'tick' });
    const detached = new Promise<void>(resolve => { const original = hub.detach.bind(hub); hub.detach = (s, peer) => { original(s, peer); resolve(); }; });
    ws.close(); await Promise.all([once(ws, 'close'), detached]);
    assert.deepEqual(calls, ['start:CAM123', 'stop:CAM123']);
    assert.equal((await fetch(base + message.path)).status, 404);
    assert.equal(hub.active, 0);
  } finally { ws?.terminate(); server.emit('shutdown'); server.close(); await once(server, 'close'); }
});

test('timeline, calendar and stored thumbnails require auth and known camera IDs',async()=>{
  const calls:string[]=[];const hub=new StreamHub({start:async()=>{},stop:async()=>{},disposeMedia:()=>{}});
  const fake=Object.assign(new EventEmitter(),{auth:{state:'connected'},inventory:()=>[],hasCamera:(s:string)=>s==='CAM123',hub,recordings:{
    timeline:async(serials:string[],date:string)=>{calls.push('timeline');assert.deepEqual(serials,['CAM123']);assert.equal(date,'2026-09-05');return {recordings:[],complete:true};},
    video:async(_serial:string,_id:string,_signal:AbortSignal,format:string)=>{calls.push('video:'+format);return Buffer.from('mp4');},
    calendar:async()=>{calls.push('calendar');return {days:['2026-09-05']};},thumbnail:async()=>{calls.push('thumbnail');return Buffer.from([255,216,255]);}
  }});
  const server=createBridge(fake as unknown as Eufy,token,'fixture');server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`,headers={Authorization:`Bearer ${token}`};
  try{
    const path='/v1/recordings?cameras=CAM123&date=2026-09-05';assert.equal((await fetch(base+path)).status,401);assert.equal((await fetch(base+path.replace('CAM123','UNKNOWN'),{headers})).status,400);assert.deepEqual(calls,[]);
    assert.equal((await fetch(base+path,{headers})).status,200);assert.equal((await fetch(base+'/v1/recording-days?cameras=CAM123&month=2026-09',{headers})).status,200);
    const image=await fetch(base+'/v1/recordings/CAM123/'+'a'.repeat(32)+'/thumbnail',{headers});assert.equal(image.headers.get('content-type'),'image/jpeg');assert.equal((await image.arrayBuffer()).byteLength,3);assert.deepEqual(calls,['timeline','calendar','thumbnail']);
    const clip=base+'/v1/recordings/CAM123/'+'a'.repeat(32)+'/video';
    assert.equal((await fetch(clip+'?format=native')).status,401);
    assert.equal((await fetch(clip+'?format=bad',{headers})).status,400);
    assert.equal((await fetch(clip+'?format=native',{headers})).status,200);
    assert.equal((await fetch(clip,{headers})).status,200);
    assert.deepEqual(calls.slice(3),['video:native','video:h264']);
  }finally{server.emit('shutdown');server.close();await once(server,'close');}
});

test('notification frames require opt-in and subscriptions are removed on disconnect', async () => {
  const hub = new StreamHub({ start: async () => {}, stop: async () => {}, disposeMedia: () => {} });
  const fake = Object.assign(new EventEmitter(), {auth: {state: 'connected'}, inventory: () => [], hub});
  const server = createBridge(fake as unknown as Eufy, token, 'fixture');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `ws://127.0.0.1:${address.port}/v1/events`;
  const clients: WebSocket[] = [];
  try {
    for (const suffix of ['', '?notifications=1']) {
      const ws = new WebSocket(base + suffix, {headers: {Authorization: `Bearer ${token}`}});
      clients.push(ws);
      const first = once(ws, 'message'); await once(ws, 'open');
      assert.equal(JSON.parse((await first)[0].toString()).protocol, 1);
    }
    assert.equal(fake.listenerCount('notification'), 1);
    const next = once(clients[1]!, 'message');
    fake.emit('notification', {id: 'one', serial: 'CAM123', event_type: 'ring'});
    assert.equal(JSON.parse((await next)[0].toString()).event_type, 'ring');
    const removed = new Promise<void>(resolve => { fake.on('removeListener', name => { if (name === 'notification') resolve(); }); });
    const gone = once(clients[1]!, 'close'); clients[1]!.close(); await Promise.all([gone, removed]);
    assert.equal(fake.listenerCount('notification'), 0);
  } finally { clients.forEach(ws => ws.terminate()); server.emit('shutdown'); server.close(); await once(server, 'close'); }
});

for (const acknowledge of [false, true]) test(`JPEG downgrade preserves one camera owner and its deadline, ack=${acknowledge}`, { timeout: 5000 }, async t => {
  const { MediaRelay } = await import('../src/media.js');
  const calls: string[] = [];
  let now = 0, acknowledgements = 0;
  const media = new MediaRelay(() => {});
  t.mock.method(media, 'audioSupported', () => true);
  const hub = new StreamHub({ start: async () => { calls.push('start'); }, stop: async () => { calls.push('stop'); hub.stopped('CAM123'); }, disposeMedia: s => media.stop(s) }, () => now);
  const originalAck = hub.ack.bind(hub);
  t.mock.method(hub, 'ack', (s, peer) => { const accepted = originalAck(s, peer); if (accepted) acknowledgements++; return accepted; });
  const fake = Object.assign(new EventEmitter(), { auth: { state: 'connected' }, inventory: () => [], hasCamera: (s: string) => s === 'CAM123', pictures: new Map(), hub, media, metrics: {} });
  const server = createBridge(fake as unknown as Eufy, token, 'test');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const ws = new WebSocket(`${base}/v1/live/CAM123?transport=webrtc`, { headers: { Authorization: `Bearer ${token}` } });
  const messages: { data: Buffer; binary: boolean }[] = [];
  ws.on('message', (data, binary) => messages.push({ data: data as Buffer, binary }));
  const until = async (count: number) => { while (messages.length < count) await once(ws, 'message'); };
  const ack = async () => { const next = acknowledgements + 1; ws.send('ack:jpeg'); while (acknowledgements < next) await new Promise(r => setTimeout(r, 1)); };
  try {
    await once(ws, 'open'); now = 14000;
    hub.frame('CAM123', Buffer.from('actual-jpeg-frame')); await until(2);
    const ready = JSON.parse(messages[0]!.data.toString()); assert.equal(ready.fallback, true);
    ws.send('fallback:connection_failed'); await until(4);
    assert.deepEqual(JSON.parse(messages[2]!.data.toString()), { type: 'fallback', reason: 'connection_failed' });
    assert.equal(messages[3]!.binary, true); assert.equal(messages[3]!.data.toString(), 'actual-jpeg-frame');
    assert.equal((await fetch(base + ready.path)).status, 404);
    assert.deepEqual(calls, ['start']);
    ws.send('ack'); // A delayed WebRTC ACK must not acknowledge the JPEG replay.
    const pong = once(ws, 'pong'); ws.ping(); await pong;
    assert.equal(acknowledgements, 0);
    const closed = once(ws, 'close');
    if (acknowledge) {
      await ack();
      for (now = 19000; now < 120000; now += 5000) {
        const next = messages.length + 1; hub.frame('CAM123', Buffer.from('next-frame')); await until(next);
        assert.equal(messages.at(-1)!.binary, true); await ack();
      }
      now = 120000; hub.tick(); // Absolute lifetime wins over recent real ACKs.
    } else { now = 20000; hub.tick(); }
    await closed;
    assert.deepEqual(calls, ['start', 'stop']);
    assert.equal(hub.active, 0); assert.equal(hub.quarantined, 0);
  } finally { ws.terminate(); server.emit('shutdown'); server.close(); await once(server, 'close'); }
});

test('one viewer downgrades while another keeps WebRTC on the same camera', { timeout: 5000 }, async t => {
  const { MediaRelay } = await import('../src/media.js');
  let starts = 0, stops = 0;
  let stopObserved!: () => void;
  const stopComplete = new Promise<void>(resolve => { stopObserved = resolve; });
  const media = new MediaRelay(() => {});
  t.mock.method(media, 'audioSupported', () => true);
  const hub = new StreamHub({ start: async () => { starts++; }, stop: async () => { stops++; hub.stopped('CAM123'); stopObserved(); }, disposeMedia: s => media.stop(s) });
  const fake = Object.assign(new EventEmitter(), { auth: { state: 'connected' }, inventory: () => [], hasCamera: (s: string) => s === 'CAM123', pictures: new Map(), hub, media, metrics: {} });
  const server = createBridge(fake as unknown as Eufy, token, 'test');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const sockets = [0, 1].map(() => new WebSocket(`${base}/v1/live/CAM123?transport=webrtc`, { headers: { Authorization: `Bearer ${token}` } }));
  const messages: Buffer[][] = [[], []];
  sockets.forEach((ws, i) => ws.on('message', data => messages[i]!.push(data as Buffer)));
  const until = async (i: number, n: number) => { while (messages[i]!.length < n) await once(sockets[i]!, 'message'); };
  try {
    await Promise.all(sockets.map(ws => once(ws, 'open')));
    hub.frame('CAM123', Buffer.from('jpeg')); await Promise.all([until(0, 2), until(1, 2)]);
    assert.ok(JSON.parse(messages[0]![0]!.toString()).fallback_after_ms <= 15000);
    assert.ok(JSON.parse(messages[1]![0]!.toString()).fallback_after_ms <= 5000);
    const secondGrant = JSON.parse(messages[1]![0]!.toString()).path.split('/').at(-1);
    sockets[0]!.send('fallback:connection_failed'); await until(0, 4);
    assert.equal(starts, 1); assert.equal(stops, 0);
    assert.equal(messages[1]!.length, 2);
    // Only the first viewer's grant is revoked. The second still serves media.
    const reader = Object.assign(new EventEmitter(), { writeHead() {}, destroy() {}, writableLength: 0 });
    assert.equal(media.serve(secondGrant, reader as any), true);
    const firstClosed = once(sockets[0]!, 'close'); sockets[0]!.close(); await firstClosed;
    const pong = once(sockets[1]!, 'pong'); sockets[1]!.ping(); await pong;
    assert.equal(stops, 0); assert.equal(hub.active, 1);
    const secondClosed = once(sockets[1]!, 'close'); sockets[1]!.close(); await Promise.all([secondClosed, stopComplete]);
    assert.equal(starts, 1); assert.equal(stops, 1); assert.equal(hub.active, 0);
  } finally { sockets.forEach(ws => ws.terminate()); server.emit('shutdown'); server.close(); await once(server, 'close'); }
});

test('explicit unavailable capabilities reject cached snapshots and websocket media before the hub', async () => {
  let starts = 0;
  const denied = { available: false, status: 'unsupported', reason: 'camera_media_unverified' };
  const fake = Object.assign(new EventEmitter(), {
    auth: { state: 'connected' },
    inventory: () => [{ serial: 'CAM123', capabilities: { snapshot: denied, live: denied, recordings: denied } }],
    hasCamera: (serial: string) => serial === 'CAM123',
    pictures: new Map([['CAM123', { data: Buffer.from('stale'), mime: 'image/jpeg' }]]),
    hub: new StreamHub({ start: async () => { starts++; }, stop: async () => {}, disposeMedia: () => {} }),
  });
  const server = createBridge(fake as unknown as Eufy, token, 'bridge-test');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: `Bearer ${token}` };
  try {
    const response = await fetch(`${base}/v1/snapshot/CAM123`, { headers });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'capability_unavailable' });
    for (const suffix of ['', '?transport=webrtc']) {
      const socket = new WebSocket(`${base}/v1/live/CAM123${suffix}`, { headers });
      const closed = once(socket, 'close');
      const [code, reason] = await closed;
      assert.equal(code, 1008);
      assert.equal(reason.toString(), 'capability_unavailable');
    }
    assert.equal(starts, 0);
    assert.equal(fake.hub.active, 0);
  } finally { server.emit('shutdown'); server.close(); await once(server, 'close'); }
});
