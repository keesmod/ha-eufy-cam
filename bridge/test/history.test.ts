import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Station } from 'eufy-security-client';
import { completeDay, issueCalendarQuery, recordingDays } from '../src/history.js';

function fixture(total: number) {
  const requested: number[] = [];
  const source = Array.from({length:total},(_,i)=>({record_id:total-i,start_time:new Date('2026-09-05T12:00:00')}));
  const station = Object.assign(new EventEmitter(), {
    p2pSession: { sendCommandWithStringPayload(command: {value:string}) { const n = JSON.parse(command.value).payload.payload.count; requested.push(n); queueMicrotask(()=>station.emit('database query by date',station,0,source.slice(0,n))); } },
    databaseQueryByDate: (serials: string[]) => { assert.deepEqual(serials,[]); station.p2pSession.sendCommandWithStringPayload({value:JSON.stringify({payload:{cmd:10006,payload:{count:100,start_time:'20260905000000',flag:0}}})}); },
    databaseCountByDate: () => queueMicrotask(()=>station.emit('database count by date',station,0,[{day:new Date('2026-09-05T00:00:00'),count:1}]))
  });
  return { station:station as unknown as Station, raw:station, requested, source };
}
const start = new Date('2026-09-05T12:00:00'), end = new Date('2026-09-06T12:00:00');

test('a 105-record day expands beyond SDK 100 and preserves events sharing a timestamp',async()=>{
  const {station,requested} = fixture(105);
  const records = await completeDay(station,start,end,new AbortController().signal);
  assert.equal(records.length,105);assert.deepEqual(requested,[100,500]);assert.equal(records.at(-1)?.record_id,1);
});
test('an exact page boundary remains unconfirmed when expansion returns the same prefix',async()=>{
  const {station,requested}=fixture(500);
  await assert.rejects(completeDay(station,start,end,new AbortController().signal),/completeness unconfirmed/);
  assert.deepEqual(requested,[100,500,2000]);
});
test('fixed firmware cap and safety ceiling never masquerade as complete history',async()=>{
  const capped=fixture(1000); const original=capped.raw.p2pSession.sendCommandWithStringPayload;
  capped.raw.p2pSession.sendCommandWithStringPayload=function(command){const data=JSON.parse(command.value);data.payload.payload.count=100;original.call(this,{value:JSON.stringify(data)});};
  await assert.rejects(completeDay(capped.station,start,end,new AbortController().signal),/completeness unconfirmed/);
  const full=fixture(10000);await assert.rejects(completeDay(full.station,start,end,new AbortController().signal),/safety limit/);
});
test('cancelled history removes listeners and restores the SDK sender',async()=>{
  const {station,raw}=fixture(0);raw.p2pSession.sendCommandWithStringPayload=()=>{};
  const send=raw.p2pSession.sendCommandWithStringPayload;const cancel=new AbortController();
  const pending=completeDay(station,start,end,cancel.signal);cancel.abort();await assert.rejects(pending);
  assert.equal(raw.listenerCount('database query by date'),0);assert.equal(raw.p2pSession.sendCommandWithStringPayload,send);
  raw.databaseQueryByDate=()=>{throw new Error('rejected');};
  assert.throws(()=>issueCalendarQuery(station,start,end,500));assert.equal(raw.p2pSession.sendCommandWithStringPayload,send);
});
test('calendar exposes presence dates rather than pretending count one is one recording',async()=>{
  const {station}=fixture(105);assert.deepEqual(await recordingDays(station,start,end,new AbortController().signal),['2026-09-05']);
});
