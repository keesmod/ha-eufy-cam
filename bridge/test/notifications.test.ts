import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { EufySecurity } from 'eufy-security-client';
import { Notifications, personName, type Notification } from '../src/notifications.js';

function fixture(t: any) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1788943276000 });
  const sdk = new EventEmitter(); const events: Notification[] = [];
  const notifications = new Notifications(s => ['FRONT','BELL'].includes(s), e => events.push(e), () => {});
  notifications.bind(sdk as EufySecurity);
  return {sdk,events,notifications, flush:()=>t.mock.timers.tick(501)};
}
test('HB3 double-format recognition plus SDK person/person/motion becomes one named event', t => {
  const {sdk,events,notifications,flush}=fixture(t);
  sdk.emit('push connect'); assert.equal(notifications.metrics.push_connected,true);
  const first={device_sn:'FRONT',type:18,event_type:3111,event_session:'a',person_name:'Peter',email:'SECRET',pin:'SECRET',pic_url:'SECRET'};
  sdk.emit('push message',first);
  sdk.emit('device person detected',{getSerial:()=> 'FRONT'},true,'Peter');
  sdk.emit('device person detected',{getSerial:()=> 'FRONT'},true,'Peter');
  sdk.emit('device motion detected',{getSerial:()=> 'FRONT'},true);
  sdk.emit('push message',{...first,type:91,event_time:1788943276000});
  flush(); assert.equal(events.length,1);
  assert.equal(events[0]!.event_type,'person');assert.equal(events[0]!.person_name,'Peter');assert.equal(events[0]!.recognition,'known');
  assert.equal(events[0]!.occurred_at,'2026-09-09T08:41:16.000Z');assert.ok(!JSON.stringify(events).includes('SECRET'));
  sdk.emit('push message',first);flush();assert.equal(events.length,1);
  sdk.emit('device person detected',{getSerial:()=> 'FRONT'},false,'Peter');flush();assert.equal(events.length,1);
});
test('different cameras and distinct detection identities remain separate, even within 500ms',t=>{
  const {sdk,events,flush}=fixture(t);
  for(const [serial,id] of [['FRONT','one'],['FRONT','two'],['BELL','one']]) sdk.emit('push message',{device_sn:serial,type:18,event_type:3102,event_session:id});
  flush();assert.equal(events.length,3);assert.equal(new Set(events.map(e=>e.id)).size,3);
  assert.ok(events.every(e=>e.person_name===null&&e.recognition==='unidentified'));
});
test('ring is not a motion/person alert and explicit stranger stays distinguishable',t=>{
  const {sdk,events,flush}=fixture(t);
  sdk.emit('push message',{device_sn:'BELL',type:18,event_type:3103,event_session:'ring'});
  sdk.emit('device rings',{getSerial:()=> 'BELL'},true);
  sdk.emit('push message',{device_sn:'FRONT',type:18,event_type:3112,event_session:'stranger',person_name:'Unknown'});
  flush();assert.deepEqual(events.map(e=>[e.event_type,e.person_name,e.recognition]),[['ring',null,'not_applicable'],['person',null,'unknown']]);
});
test('SDK-only detections enrich names and coalesce inferred motion but retain a separate ring',t=>{
  const {sdk,events,flush}=fixture(t);
  sdk.emit('device motion detected',{getSerial:()=> 'FRONT'},true);
  sdk.emit('device person detected',{getSerial:()=> 'FRONT'},true,'Peter');
  sdk.emit('device person detected',{getSerial:()=> 'FRONT'},true,'Peter');
  sdk.emit('device rings',{getSerial:()=> 'FRONT'},true);
  flush();assert.equal(events.length,2);assert.equal(events[0]!.person_name,'Peter');assert.equal(events[1]!.event_type,'ring');
});
test('unmapped push uses SDK semantics; unrecognized device alerts still have a notification event',t=>{
  const {sdk,events,flush}=fixture(t);
  sdk.emit('push message',{device_sn:'FRONT',type:1,event_type:1,event_session:'old-format'});
  sdk.emit('device person detected',{getSerial:()=> 'FRONT'},true,'Peter');
  sdk.emit('push message',{device_sn:'BELL',type:18,event_type:9999,event_session:'unknown'});
  flush();assert.deepEqual(events.map(e=>e.event_type),['person','notification']);assert.equal(events[0]!.person_name,'Peter');
});
test('new detections after the settling window survive; close cancels pending alerts',t=>{
  const {sdk,events,notifications,flush}=fixture(t);
  sdk.emit('push message',{device_sn:'BELL',type:18,event_type:3103,event_session:'one'});flush();
  sdk.emit('push message',{device_sn:'BELL',type:18,event_type:3103,event_session:'two'});flush();assert.equal(events.length,2);
  sdk.emit('push message',{device_sn:'OTHER',type:18,event_type:3103});
  sdk.emit('push message',{device_sn:'BELL',type:18,event_type:3103,event_session:'three'});notifications.close();flush();assert.equal(events.length,2);
});
test('person names are bounded and placeholders do not become recognized identities',()=>{
  assert.equal(personName(' Peter '),'Peter');assert.equal(personName('Unknown'),null);assert.equal(personName('Onbekend'),null);assert.equal(personName('x'.repeat(129)),null);assert.equal(personName({pin:'SECRET'}),null);
});
