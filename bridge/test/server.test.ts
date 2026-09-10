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

for (const hasAudio of [false, true]) test(`WebRTC grants report audio=${hasAudio} after the first frame and expire with their owner`, async t => {
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
    ws.on('message', (data, binary) => messages.push({ data: data.toString(), binary }));
    await once(ws, 'open');
    assert.deepEqual(messages, [], 'No fabricated audio capability before media arrives');
    const first = once(ws, 'message');
    hub.frame('CAM123', Buffer.from('jpeg-not-forwarded'));
    const [ready] = await first;
    const message = JSON.parse(ready.toString());
    assert.equal(message.type, 'ready'); assert.match(message.path, /^\/v1\/media\/[a-f0-9]{64}$/);
    assert.deepEqual(calls, ['start:CAM123']);
    assert.equal(message.audio, hasAudio);
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
