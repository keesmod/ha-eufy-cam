import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import type { DiscoveryResult, Diagnostic, CameraCapabilities, RecordingObservation, StationKeySetupObservation, StationLookupObservation } from '@keesmod/eufy-mega-client';
import {
  DiscoveryDiagnostics, connectionAttempt, diagnosticCode, diagnosticModel, diagnosticReleaseVersion, diagnosticSoftware, diagnosticVersion,
  standalonePushReport,
  type RecordingQueryReport,
} from '../src/discovery-diagnostics.js';

const result = (): DiscoveryResult => ({
  devices: [
    {id:'PRIVATE_BASE',stationId:'PRIVATE_BASE',kind:'station',model:'T8030',name:'PRIVATE_NAME',firmware:'3.8.6.0',hardware:'1.0',battery:null},
    {id:'PRIVATE_CAMERA',stationId:'PRIVATE_BASE',kind:'camera',model:'T8224',name:'PRIVATE_NAME',firmware:'0.2.1.8',hardware:'1',battery:80,availability:'online'},
  ],
  relationships: [
    {deviceId:'PRIVATE_BASE',kind:'station',ownerId:'PRIVATE_BASE'},
    {deviceId:'PRIVATE_CAMERA',kind:'station',ownerId:'PRIVATE_BASE'},
  ],
  issues: [
    {index:2,deviceId:'PRIVATE_UNKNOWN',code:'unsupported_device',deviceModel:'T9999',deviceType:95},
    {index:3,deviceId:'PRIVATE_OTHER',code:'unsupported_device',deviceModel:'T9999',deviceType:96},
  ],
});
const collect = () => {
  const lines: string[] = [];
  return {lines, reporter:new DiscoveryDiagnostics(line=>lines.push(line)), rows:()=>lines.map(line=>JSON.parse(line))};
};
test('support report includes software, inventory, anonymous ownership, firmware and each rejection', () => {
  const f=collect();
  const capability={available:true,status:'experimental',reason:null} as const;
  f.reporter.inventory(result(),'accepted',undefined,true,new Map([['PRIVATE_CAMERA',
    {snapshot:capability,live:capability,recordings:capability}]]),new Map());
  const rows=f.rows();
  assert.equal(rows.length,6);
  assert.equal(rows[0].software.library,'0.30.3-beta.2');
  assert.equal(rows[0].software.bridge,diagnosticSoftware().bridge);
  assert.deepEqual([rows[0].cameras,rows[0].stations,rows[0].issues],[1,1,2]);
  assert.equal(rows[2].owner_ref,1);
  assert.equal(rows[2].firmware,'0.2.1.8');
  assert.equal(rows[2].relationship,'station');
  assert.equal(rows[2].media.live.available,true);
  assert.deepEqual(rows.filter(r=>r.event==='issue').map(r=>r.device_type),[95,96]);
  assert.equal(rows.at(-1).event,'end');
  assert.doesNotMatch(f.lines.join('\n'),/PRIVATE|serial|token|stationId|deviceId/);
  f.reporter.inventory(result(),'accepted',undefined,true,new Map(),new Map());
  f.lines.length=0;
  f.reporter.inventory(result(),'accepted',undefined,true,new Map(),new Map());
  assert.equal(f.rows().length,2);
  assert.equal(f.rows()[0].unchanged,true);
});
test('failure reports retain discovery and missing-baseline counts before setup rejection', () => {
  const f=collect();
  const baseline={version:1,bridge_id:'PRIVATE_BRIDGE',backend:'mega',cameras:['PRIVATE_CAMERA','PRIVATE_MISSING'],stations:['PRIVATE_BASE']} as const;
  f.reporter.inventory(result(),'expected_devices_missing', {...baseline,cameras:[...baseline.cameras],stations:[...baseline.stations]},true,new Map(),new Map());
  assert.equal(f.rows()[0].missing_expected_cameras,1);
  assert.equal(f.rows()[0].outcome,'expected_devices_missing');
  assert.doesNotMatch(f.lines.join('\n'),/PRIVATE/);
  f.lines.length=0;
  f.reporter.inventory(undefined,'invalid_inventory',undefined,false,new Map(),new Map());
  assert.equal(f.rows()[0].inventory_available,false);
  assert.equal(f.rows()[0].baseline,'unavailable');
  assert.equal(f.rows()[0].outcome,'invalid_inventory');
});
test('all new support fields are allowlisted, bounded and protected against log injection', () => {
  const f=collect();
  const value=result();
  value.devices[1]!.model='T8224\nPRIVATE_TOKEN';
  value.devices[1]!.firmware='http://192.0.2.1/PRIVATE_TOKEN';
  value.devices[1]!.hardware='1\n';
  Object.assign(value.devices[1]!,{name:'PRIVATE_NAME',address:'192.0.2.1',token:'PRIVATE_TOKEN',availability:'PRIVATE'});
  Object.assign(value.relationships[1]!,{kind:'PRIVATE',reason:'PRIVATE_TOKEN'});
  Object.assign(value.issues[0]!,{code:'PRIVATE_TOKEN',deviceModel:'T9999\n',deviceType:65536,index:-1});
  const malicious={available:true,status:'PRIVATE',reason:'PRIVATE_TOKEN'} as unknown as CameraCapabilities['live'];
  f.reporter.inventory(value,'PRIVATE_TOKEN',undefined,true,new Map([['PRIVATE_CAMERA',
    {snapshot:malicious,live:malicious,recordings:malicious}]]),new Map());
  assert.doesNotMatch(f.lines.join('\n'),/PRIVATE|192\.0\.2\.1|http:/);
  const camera=f.rows().find(row=>row.event==='device'&&row.ref===2);
  assert.equal(camera.model,'unavailable');
  assert.equal(camera.firmware,'unavailable');
  assert.equal(camera.hardware,'unavailable');
  assert.equal(camera.media.live.reason,'unclassified_error');
  assert.ok(f.lines.every(line=>!line.includes('\n')&&line.length<2000));
  const huge=result(); huge.devices=Array(150).fill(huge.devices[0]);huge.issues=Array(150).fill(huge.issues[0]);
  f.lines.length=0;
  f.reporter.inventory(huge,'accepted',undefined,true,new Map(),new Map());
  assert.equal(f.lines.length,200);
  assert.equal(f.rows()[0].truncated,true);
});
test('cloud and authentication diagnostics contain only named steps and numeric results', () => {
  const f=collect();
  f.reporter.cloud({operation:'PRIVATE',host:'192.0.2.1',path:'/app/house/get_devs_list',status:200,code:0,elapsedMs:21});
  f.reporter.cloud({path:'/PRIVATE_TOKEN',host:'PRIVATE',operation:'PRIVATE',elapsedMs:0});
  f.reporter.cloud({path:'/passport/login',host:'PRIVATE',status:Infinity,code:'PRIVATE',elapsedMs:-1} as unknown as Diagnostic);
  f.reporter.connection('authentication','PRIVATE_TOKEN',false);
  assert.equal(f.rows().length,3);
  assert.deepEqual([f.rows()[0].operation,f.rows()[0].http_status,f.rows()[0].result_code],['inventory',200,0]);
  assert.equal(f.rows()[1].result_code,null);
  assert.equal(f.rows()[2].outcome,'unclassified_error');
  assert.doesNotMatch(f.lines.join('\n'),/PRIVATE|192\.0\.2\.1/);
});
test('diagnostic output failures cannot interrupt discovery or login', () => {
  const reporter=new DiscoveryDiagnostics(()=>{throw Error('sink unavailable');});
  assert.doesNotThrow(()=>reporter.inventory(result(),'accepted',undefined,true,new Map(),new Map()));
  assert.doesNotThrow(()=>reporter.connection('authentication','connected',false));
  assert.doesNotThrow(()=>reporter.cloud({path:'/passport/login',host:'PRIVATE',operation:'cloud_request',elapsedMs:0}));
});

test('owner status is explicit and station errors retain phase, reference and recovery', () => {
  const f=collect();
  const value=result();
  value.issues[0]!.context={firmware:'0.2.1.8',hardware:'1',parentStatus:'present',parentId:'PRIVATE_BASE',parentModel:'T8030',parentFirmware:'3.8.6.0'};
  f.reporter.prepare(value);
  f.reporter.station('PRIVATE_BASE','connect','error','connection_failed');
  f.reporter.inventory(value,'accepted',undefined,true,new Map(),new Map());
  let report=f.reporter.report();
  const camera=report.last_discovery.find(row=>row.event==='device'&&row.ref===2)!;
  assert.equal(camera.station_status,'not_applicable');
  assert.equal(camera.owner_status,'error');
  assert.equal(camera.owner_connected,null);
  const issue=report.last_discovery.find(row=>row.event==='issue')!;
  assert.equal(issue.owner_ref,1); assert.equal(issue.firmware,'0.2.1.8');
  assert.equal(issue.parent_model,'T8030');
  const fault=report.recent_events.find(row=>row.event==='station_connection')!;
  assert.equal(fault.device_ref,1);assert.equal(fault.phase,'connect');assert.equal(fault.reason,'connection_failed');
  f.reporter.station('PRIVATE_BASE','refresh_state','connected');
  f.reporter.station('PRIVATE_BASE','observation','connected');
  f.reporter.station('PRIVATE_BASE','observation','connected');
  f.reporter.station('PRIVATE_BASE','observation','disconnected');
  f.reporter.station('PRIVATE_BASE','observation','disconnected');
  f.reporter.station('PRIVATE_BASE','observation','connected');
  report=f.reporter.report();
  assert.deepEqual(report.recent_events.map(row=>row.status),['error','connected','disconnected','connected']);
  assert.ok(report.recent_events.every(row=>typeof row.timestamp==='string'));
  assert.doesNotMatch(JSON.stringify(report),/PRIVATE/);
});

test('downloads retain full unchanged inventory, isolate mutations and bound recent events', () => {
  const f=collect();
  f.reporter.inventory(result(),'accepted',undefined,true,new Map(),new Map());
  f.reporter.inventory(result(),'accepted',undefined,true,new Map(),new Map());
  const downloaded=f.reporter.report();
  assert.equal(downloaded.last_discovery.length,6);
  assert.equal(downloaded.last_discovery[0]!.report,2);
  downloaded.last_discovery.length=0;
  assert.equal(f.reporter.report().last_discovery.length,6);
  for(let i=0;i<120;i++)f.reporter.connection('events',i%2?'connected':'disconnected',!!(i%2));
  f.reporter.connection('events','connected',true);
  assert.equal(f.reporter.report().recent_events.length,100);
  assert.equal(f.reporter.report().recent_events.at(-1)!.outcome,'connected');
  f.reporter.fault('PRIVATE_TOKEN');f.reporter.fault('PRIVATE_TOKEN');
  assert.equal(f.reporter.report().recent_events.filter(row=>row.event==='fault').length,1);
  assert.doesNotMatch(JSON.stringify(f.reporter.report()),/PRIVATE/);
});

const codeCases = JSON.parse(readFileSync(
  new URL('../../tests/fixtures/diagnostic-codes.json', import.meta.url), 'utf8',
)) as { accepted: string[]; rejected: unknown[] };

test('machine code validation agrees with the HA download contract without enumerating codes', () => {
  for (const code of codeCases.accepted) assert.equal(diagnosticCode(code), code);
  for (const value of [...codeCases.rejected, undefined])
    assert.equal(diagnosticCode(value), 'unclassified_error');
});

test('future codes survive every report code field and normal log output', () => {
  for (const code of codeCases.accepted) {
    const f = collect();
    const value = result();
    Object.assign(value.issues[0]!, { code });
    Object.assign(value.relationships[1]!, { kind: 'standalone', reason: code });
    const capability = { available: false, status: 'unsupported', reason: code } as const;
    f.reporter.prepare(value);
    f.reporter.station('PRIVATE_BASE', 'connect', 'error', code);
    f.reporter.fault(code);
    f.reporter.connection('authentication', code, false);
    f.reporter.inventory(value, code, undefined, true, new Map([['PRIVATE_CAMERA',
      { snapshot: capability, live: capability, recordings: capability }]]), new Map());
    const report = f.reporter.report();
    assert.equal(report.recent_events.find(row => row.event === 'station_connection')!.reason, code);
    assert.equal(report.recent_events.find(row => row.event === 'fault')!.code, code);
    assert.equal(report.recent_events.find(row => row.event === 'connection')!.outcome, code);
    assert.equal(report.last_discovery[0]!.outcome, code);
    assert.equal(report.last_discovery.find(row => row.event === 'issue')!.code, code);
    const camera = report.last_discovery.find(row => row.event === 'device' && row.ref === 2)!;
    assert.equal(camera.relationship_reason, code);
    assert.equal((camera.media as any).live.reason, code);
    assert.ok(f.rows().some(row => row.event === 'station_connection' && row.reason === code));
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE/);
  }
});

test('a failed station connect records how far it got, without addresses', () => {
  const f=collect();
  f.reporter.prepare(result());
  f.reporter.station('PRIVATE_BASE','connect','error','device_request_timeout',{stage:'lookup',inventoryAddress:false});
  // The same failure at the same stage is not repeated, a later stage is recorded.
  f.reporter.station('PRIVATE_BASE','connect','error','device_request_timeout',{stage:'lookup',inventoryAddress:false});
  f.reporter.station('PRIVATE_BASE','connect','error','device_request_timeout',{stage:'station_found',inventoryAddress:true});
  f.reporter.station('PRIVATE_BASE','connect','error','device_request_timeout',{stage:'PRIVATE_192.168.1.2'});
  f.reporter.station('PRIVATE_BASE','refresh_state','error','device_request_timeout',{stage:'lookup',inventoryAddress:true});
  f.reporter.station('PRIVATE_BASE','observation','connected',undefined,{stage:'lookup'});
  const rows=f.reporter.report().recent_events.filter(row=>row.event==='station_connection');
  assert.deepEqual(rows.map(({stage,inventory_address,phase,status})=>({stage,inventory_address,phase,status})),[
    {stage:'lookup',inventory_address:false,phase:'connect',status:'error'},
    {stage:'station_found',inventory_address:true,phase:'connect',status:'error'},
    {stage:'none',inventory_address:undefined,phase:'connect',status:'error'},
    {stage:undefined,inventory_address:undefined,phase:'refresh_state',status:'error'},
    {stage:undefined,inventory_address:undefined,phase:'observation',status:'connected'},
  ]);
  assert.doesNotMatch(JSON.stringify(f.reporter.report()),/PRIVATE|192\.168/);
});

test('repeated failures at one stage are recorded once, and the latest record is the latest attempt', () => {
  const f=collect();
  f.reporter.prepare(result());
  for(const stage of ['lookup','lookup','lookup','station_found','lookup','lookup'])
    f.reporter.station('PRIVATE_BASE','connect','error','device_request_timeout',{stage,inventoryAddress:true});
  f.reporter.station('PRIVATE_BASE','observation','connected');
  f.reporter.station('PRIVATE_BASE','connect','error','device_request_timeout',{stage:'lookup',inventoryAddress:true});
  const rows=f.reporter.report().recent_events.filter(row=>row.event==='station_connection');
  assert.deepEqual(rows.map(row=>row.stage??row.status),['lookup','station_found','lookup','connected','lookup']);
});

// What the local lookup of one attempt saw, as client 0.30.0 reports it (#152).
const silentLookup: StationLookupObservation = {
  rounds: 3, broadcastTargets: 2, broadcastEnabled: true, sendErrors: 0, datagrams: 0, otherHeaders: 0,
  ownReplies: 0, accountReplies: 0, foreignReplies: 0, nearReplies: 0, inventoryReply: 'none',
  inventoryAddressOnSubnet: true, inventoryAddressShared: false,
};
const lookupKeys = (row: Record<string, unknown>) =>
  Object.keys(row).filter(key => key.startsWith('lookup_') || key.startsWith('inventory_address_'));

test('the local lookup of an attempt is reported as flat fields on its error and connected records (#152)', () => {
  const f=collect();
  f.reporter.prepare(result());
  f.reporter.station('PRIVATE_BASE','connect','error','device_request_timeout',{stage:'lookup',inventoryAddress:true,lookup:silentLookup});
  // A HomeBase's successful connect is reported by the refresh_state record after it.
  f.reporter.station('PRIVATE_BASE','refresh_state','connected',undefined,{stage:'encryption_ready',inventoryAddress:true,
    lookup:{...silentLookup,rounds:1,broadcastTargets:0,datagrams:2,otherHeaders:1,ownReplies:1,ownRound:0,inventoryReply:'own'}});
  const [failed,connected]=f.reporter.report().recent_events.filter(row=>row.event==='station_connection');
  assert.deepEqual(Object.fromEntries(lookupKeys(failed!).map(key=>[key,failed![key]])),{
    lookup_rounds:3, lookup_broadcast_targets:2, lookup_broadcast_enabled:true, lookup_send_errors:0,
    lookup_datagrams:0, lookup_other_headers:0, lookup_own_replies:0, lookup_account_replies:0,
    lookup_foreign_replies:0, lookup_near_replies:0, lookup_inventory_reply:'none',
    inventory_address_on_subnet:true, inventory_address_shared:false,
  });
  assert.deepEqual([failed!.stage,failed!.inventory_address,failed!.phase],['lookup',true,'connect']);
  assert.deepEqual([connected!.phase,connected!.status,connected!.stage],['refresh_state','connected',undefined]);
  assert.deepEqual([connected!.lookup_own_replies,connected!.lookup_own_round,connected!.lookup_inventory_reply,connected!.lookup_datagrams],[1,0,'own',2]);
  // Every reply class in the fixed set passes through unchanged.
  for (const inventoryReply of ['none','own','account','foreign','near'] as const) {
    const g=collect();
    g.reporter.prepare(result());
    g.reporter.station('PRIVATE_BASE','connect','error','device_request_timeout',{stage:'lookup',inventoryAddress:true,lookup:{...silentLookup,inventoryReply}});
    assert.equal(g.reporter.report().recent_events[0]!.lookup_inventory_reply,inventoryReply);
  }
  // The log line carries the same record as the download.
  assert.deepEqual(f.rows().filter(row=>row.event==='station_connection'),f.reporter.report().recent_events.filter(row=>row.event==='station_connection'));
  assert.ok(f.rows().every(row=>!('lookup' in row)));
  assert.equal(failed!.schema,2);
});

test('hostile lookup values are left out, the rest of the record stays (#152)', () => {
  const hostile = {
    rounds:100, broadcastTargets:17, broadcastEnabled:'true', sendErrors:-1, datagrams:1.5, otherHeaders:'3',
    ownReplies:0, ownRound:4, accountReplies:Infinity, foreignReplies:1000, nearReplies:Number.NaN,
    inventoryReply:'PRIVATE_192.168.1.2', inventoryAddressOnSubnet:1, inventoryAddressShared:null,
    did:'PRIVATE_DID', address:'192.168.1.2', port:32108, serial:'PRIVATE_SERIAL',
  } as unknown as StationLookupObservation;
  const f=collect();
  f.reporter.prepare(result());
  f.reporter.station('PRIVATE_BASE','connect','error','device_request_timeout',{stage:'lookup',inventoryAddress:true,lookup:hostile});
  let [row]=f.reporter.report().recent_events.filter(r=>r.event==='station_connection');
  assert.deepEqual(lookupKeys(row!),['lookup_own_replies']);
  assert.deepEqual([row!.stage,row!.inventory_address,row!.reason],['lookup',true,'device_request_timeout']);
  // An own round without an own reply is not reported, nor one out of range.
  for (const [ownReplies,ownRound,expected] of [[0,3,undefined],[2,100,undefined],[2,99,99]] as const) {
    const g=collect();
    g.reporter.prepare(result());
    g.reporter.station('PRIVATE_BASE','connect','connected',undefined,{stage:'encryption_ready',lookup:{...silentLookup,ownReplies,ownRound}});
    assert.equal(g.reporter.report().recent_events[0]!.lookup_own_round,expected);
  }
  // A value that is no object, or one that cannot be read, adds no field and never throws.
  const throwing = new Proxy({}, {get:()=>{throw new Error('PRIVATE_TOKEN');}}) as StationLookupObservation;
  for (const lookup of ['PRIVATE_TOKEN', 7, null, throwing] as unknown as StationLookupObservation[]) {
    const g=collect();
    g.reporter.prepare(result());
    assert.doesNotThrow(()=>g.reporter.station('PRIVATE_BASE','connect','error','device_request_timeout',{stage:'lookup',lookup}));
    [row]=g.reporter.report().recent_events;
    assert.deepEqual(lookupKeys(row!),[]);
    assert.equal(row!.stage,'lookup');
    assert.ok(!('lookup' in row!));
    assert.doesNotMatch(JSON.stringify(g.reporter.report())+g.lines.join('\n'),/PRIVATE/);
  }
  assert.doesNotMatch(JSON.stringify(f.reporter.report())+f.lines.join('\n'),/PRIVATE|192\.168|32108/);
});

test('a record without a lookup observation has no lookup fields (#152)', () => {
  const f=collect();
  f.reporter.prepare(result());
  f.reporter.station('PRIVATE_BASE','connect','error','connection_busy',{stage:'none'});
  f.reporter.station('PRIVATE_BASE','connect','error','device_request_timeout',{stage:'lookup',inventoryAddress:false});
  f.reporter.station('PRIVATE_BASE','refresh_state','connected',undefined,{stage:'encryption_ready'});
  f.reporter.station('PRIVATE_BASE','observation','disconnected');
  const rows=f.reporter.report().recent_events.filter(row=>row.event==='station_connection');
  assert.equal(rows.length,4);
  for (const row of rows) assert.deepEqual(lookupKeys(row),[]);
});

test('a changed lookup outcome is recorded, changed counts alone repeat the previous record (#152)', () => {
  const f=collect();
  f.reporter.prepare(result());
  const fail=(lookup?:Partial<StationLookupObservation>)=>f.reporter.station('PRIVATE_BASE','connect','error','device_request_timeout',
    {stage:'lookup',inventoryAddress:true,...(lookup?{lookup:{...silentLookup,...lookup}}:{})});
  fail();
  fail({});
  fail({rounds:5});
  fail({rounds:7,broadcastTargets:3});
  fail({datagrams:4,accountReplies:4});
  fail({datagrams:9,accountReplies:6});
  fail({datagrams:9,accountReplies:6,inventoryReply:'account'});
  // An attempt without an observation repeats the previous failure.
  fail();
  f.reporter.station('PRIVATE_BASE','observation','connected');
  fail({});
  const rows=f.reporter.report().recent_events.filter(row=>row.event==='station_connection');
  assert.deepEqual(rows.map(row=>[row.status,row.lookup_datagrams,row.lookup_account_replies,row.lookup_inventory_reply]),[
    ['error',undefined,undefined,undefined],
    ['error',0,0,'none'],
    ['error',4,4,'none'],
    ['error',9,6,'account'],
    ['connected',undefined,undefined,undefined],
    ['error',0,0,'none'],
  ]);
  // A connected record with the lookup follows the session's own connected observation.
  const g=collect();
  g.reporter.prepare(result());
  g.reporter.station('PRIVATE_BASE','observation','connected');
  g.reporter.station('PRIVATE_BASE','connect','connected',undefined,{stage:'encryption_ready',lookup:{...silentLookup,datagrams:1,ownReplies:1,ownRound:0,inventoryReply:'own'}});
  g.reporter.station('PRIVATE_BASE','observation','connected');
  assert.deepEqual(g.reporter.report().recent_events.map(row=>[row.phase,row.lookup_own_replies]),[['observation',undefined],['connect',1]]);
});

test('a changed boolean alone is a new lookup outcome (#152)', () => {
  const f=collect();
  f.reporter.prepare(result());
  const fail=(lookup:Partial<StationLookupObservation>)=>f.reporter.station('PRIVATE_BASE','connect','error','device_request_timeout',
    {stage:'lookup',inventoryAddress:true,lookup:{...silentLookup,...lookup}});
  fail({});
  fail({broadcastEnabled:false});
  fail({broadcastEnabled:false,rounds:9});
  fail({broadcastEnabled:false,inventoryAddressShared:true});
  const rows=f.reporter.report().recent_events.filter(row=>row.event==='station_connection');
  assert.deepEqual(rows.map(row=>[row.lookup_broadcast_enabled,row.inventory_address_shared]),[[true,false],[false,false],[false,true]]);
});

// What the session of one attempt saw between session_open and the key, as client 0.30.2 reports it (#142).
const unansweredKey: StationKeySetupObservation = {
  requestSends: 3, requestAcknowledged: true, resultWaitExpired: true, answers: 0,
  dataDatagrams: 0, otherMessages: 0, heartbeats: 4, ended: false,
  results: 0, resultEncrypted: false, controlMessages: 0, otherCommands: [], mediaDatagrams: 0, repeatedDatagrams: 0,
  signedMessages: 0, keyWithoutAnswer: false,
};
const keyKeys = (row: Record<string, unknown>) =>
  Object.keys(row).filter(key => key.startsWith('key_') || key === 'session_open_ms');

test('the key setup of an attempt and the time its session opened are flat fields on its record (#142)', () => {
  const f=collect();
  f.reporter.prepare(result());
  const stages=connectionAttempt();
  stages.onProgress({stage:'lookup',elapsedMs:0,inventoryAddress:true});
  stages.onProgress({stage:'station_found',elapsedMs:300});
  stages.onProgress({stage:'session_open',elapsedMs:450});
  stages.onLookup(silentLookup);
  stages.onKeySetup(unansweredKey);
  f.reporter.station('PRIVATE_BASE','connect','error','device_request_timeout',stages.detail);
  const [row]=f.reporter.report().recent_events.filter(r=>r.event==='station_connection');
  assert.deepEqual(Object.fromEntries(keyKeys(row!).map(key=>[key,row![key]])),{
    session_open_ms:450, key_request_sends:3, key_request_acknowledged:true, key_result_wait_expired:true,
    key_answers:0, key_data_datagrams:0, key_other_messages:0, key_heartbeats:4, key_ended:false,
    key_results:0, key_result_encrypted:false, key_control_messages:0, key_media_datagrams:0, key_repeated_datagrams:0,
    key_signed_messages:0, key_without_answer:false,
  });
  assert.deepEqual([row!.stage,row!.lookup_rounds],['session_open',3]);
  // The log line carries the same record, and never the observation itself.
  assert.deepEqual(f.rows().filter(r=>r.event==='station_connection'),[row]);
  assert.ok(f.rows().every(r=>!('keySetup' in r) && !('detail' in r)));
  // An attempt that never opened its session has none of the fields.
  const g=collect();
  g.reporter.prepare(result());
  g.reporter.station('PRIVATE_BASE','connect','error','device_request_timeout',{stage:'lookup',lookup:silentLookup});
  assert.deepEqual(keyKeys(g.reporter.report().recent_events[0]!),[]);
});

test('hostile key setup values are left out and each count keeps its bound (#142)', () => {
  const hostile = {
    requestSends:1000, requestAcknowledged:'true', resultWaitExpired:1, answers:-1, dataDatagrams:1.5,
    otherMessages:'2', heartbeats:999, ended:null, cipherId:7, key:'PRIVATE_KEY', address:'192.168.1.2',
  } as unknown as StationKeySetupObservation;
  const f=collect();
  f.reporter.prepare(result());
  f.reporter.station('PRIVATE_BASE','connect','error','device_request_timeout',{stage:'session_open',sessionOpenMs:120001,keySetup:hostile});
  const [row]=f.reporter.report().recent_events;
  assert.deepEqual(keyKeys(row!),['key_heartbeats']);
  assert.doesNotMatch(f.lines.join('\n'),/PRIVATE|192\.168|cipher/);
  for (const value of ['PRIVATE_TOKEN', 7, null, new Proxy({}, {get:()=>{throw new Error('PRIVATE_TOKEN');}})]) {
    const g=collect();
    g.reporter.prepare(result());
    assert.doesNotThrow(()=>g.reporter.station('PRIVATE_BASE','connect','error','device_request_timeout',
      {stage:'session_open',sessionOpenMs:20000,keySetup:value as unknown as StationKeySetupObservation}));
    const [r]=g.reporter.report().recent_events;
    assert.deepEqual(keyKeys(r!),['session_open_ms']);
    assert.equal(r!.reason,'device_request_timeout');
  }
  for (const key of ['requestSends','answers','dataDatagrams','otherMessages','heartbeats',
    'results','controlMessages','mediaDatagrams','repeatedDatagrams','signedMessages'] as const) {
    for (const [value,expected] of [[0,0],[999,999],[1000,undefined]]) {
      const g=collect();
      g.reporter.prepare(result());
      g.reporter.station('PRIVATE_BASE','connect','error','device_request_timeout',{stage:'session_open',keySetup:{...unansweredKey,[key]:value}});
      const field=`key_${key.replace(/[A-Z]/g,c=>`_${c.toLowerCase()}`)}`;
      assert.equal(g.reporter.report().recent_events[0]![field],expected,`${key} ${value}`);
    }
  }
});

test('a key request result, its return code and the other commands are flat fields within their bounds (#142)', () => {
  const answered = {
    ...unansweredKey, resultWaitExpired:false, otherMessages:5, dataDatagrams:32,
    results:1, resultCode:-103, controlMessages:2, otherCommands:[1100, 1350, 0], mediaDatagrams:20, repeatedDatagrams:7,
  };
  const f=collect();
  f.reporter.prepare(result());
  f.reporter.station('PRIVATE_BASE','connect','error','device_request_timeout',{stage:'session_open',keySetup:answered});
  const [row]=f.reporter.report().recent_events;
  assert.deepEqual(
    [row!.key_results,row!.key_result_code,row!.key_result_encrypted,row!.key_control_messages,
      row!.key_other_command_1,row!.key_other_command_2,row!.key_other_command_3,
      row!.key_media_datagrams,row!.key_repeated_datagrams],
    [1,-103,false,2,1100,1350,0,20,7]);
  const read=(keySetup: unknown)=>{
    const g=collect();
    g.reporter.prepare(result());
    g.reporter.station('PRIVATE_BASE','connect','error','device_request_timeout',
      {stage:'session_open',keySetup:keySetup as StationKeySetupObservation});
    return g.reporter.report().recent_events[0]!;
  };
  for (const [value,expected] of [[-999999,-999999],[999999,999999],[1000000,undefined],[-1.5,undefined],['-103',undefined]] as const)
    assert.equal(read({...answered,resultCode:value}).key_result_code,expected,`${value}`);
  assert.equal(read({...answered,resultEncrypted:'true'}).key_result_encrypted,undefined);
  assert.equal(read({...answered,keyWithoutAnswer:true}).key_without_answer,true);
  assert.equal(read({...answered,keyWithoutAnswer:1}).key_without_answer,undefined);
  // Only the first three commands count, each a protocol number from 0 to 65535.
  const commands=read({...answered,otherCommands:[65536,-1,65535,7]});
  assert.deepEqual(
    [commands.key_other_command_1,commands.key_other_command_2,commands.key_other_command_3,commands.key_other_command_4],
    [undefined,undefined,65535,undefined]);
  // A list whose own methods are replaced cannot choose a field name.
  const tampered=[1100,1350,7];
  Object.assign(tampered,{slice:()=>({forEach:(f: (v: unknown, i: unknown)=>void)=>f(7,'PRIVATE_ID')})});
  const named=read({...answered,otherCommands:tampered});
  assert.deepEqual(keyKeys(named).filter(key=>key.startsWith('key_other_command')),
    ['key_other_command_1','key_other_command_2','key_other_command_3']);
  assert.doesNotMatch(JSON.stringify(named),/PRIVATE/);
  for (const value of ['1100',{0:1100},null]) {
    const r=read({...answered,otherCommands:value});
    assert.deepEqual(keyKeys(r).filter(key=>key.startsWith('key_other_command')),[]);
    assert.equal(r.key_results,1);
  }
});

test('a changed key setup outcome adds a record, changed counts alone do not (#142)', () => {
  const f=collect();
  f.reporter.prepare(result());
  const fail=(keySetup: StationKeySetupObservation, sessionOpenMs=400)=>
    f.reporter.station('PRIVATE_BASE','connect','error','device_request_timeout',{stage:'session_open',lookup:silentLookup,sessionOpenMs,keySetup});
  fail({...unansweredKey,requestAcknowledged:false,resultWaitExpired:false});
  // More resends and a later handshake with the same outcome are a repeat.
  fail({...unansweredKey,requestAcknowledged:false,resultWaitExpired:false,requestSends:190},900);
  fail({...unansweredKey,ended:true,otherMessages:2});
  const rows=f.reporter.report().recent_events.filter(r=>r.event==='station_connection');
  assert.deepEqual(rows.map(r=>[r.key_request_acknowledged,r.key_ended,r.key_other_messages,r.session_open_ms]),
    [[false,false,0,400],[true,true,2,400]]);
  // A return code and a command number count by their exact value, a result count by whether it is zero.
  const g=collect();
  g.reporter.prepare(result());
  const again=(keySetup: StationKeySetupObservation)=>
    g.reporter.station('PRIVATE_BASE','connect','error','device_request_timeout',{stage:'session_open',lookup:silentLookup,keySetup});
  const coded={...unansweredKey,resultWaitExpired:false,results:1,resultCode:-103,otherMessages:1,otherCommands:[1100]};
  again(unansweredKey);
  again(coded);
  again({...coded,results:2});
  again({...coded,resultCode:-1});
  again({...coded,resultCode:-1,otherCommands:[1350]});
  const codes=g.reporter.report().recent_events.filter(r=>r.event==='station_connection');
  assert.deepEqual(codes.map(r=>[r.key_results,r.key_result_code,r.key_other_command_1]),
    [[0,undefined,undefined],[1,-103,1100],[1,-1,1100],[1,-1,1350]]);
  // A key set without an answer is an outcome, more signed messages alone are not.
  const h=collect();
  h.reporter.prepare(result());
  const keyed=(keySetup: StationKeySetupObservation)=>
    h.reporter.station('PRIVATE_BASE','connect','error','device_request_timeout',{stage:'session_open',lookup:silentLookup,keySetup});
  keyed({...unansweredKey,signedMessages:1});
  keyed({...unansweredKey,signedMessages:2});
  keyed({...unansweredKey,signedMessages:2,keyWithoutAnswer:true});
  assert.deepEqual(h.reporter.report().recent_events.filter(r=>r.event==='station_connection')
    .map(r=>[r.key_signed_messages,r.key_without_answer]),[[1,false],[2,true]]);
});

test('session_open_ms keeps its bounds (#142)', () => {
  for (const [value,expected] of [[0,0],[120000,120000],[120001,undefined],[-1,undefined],[1.5,undefined]]) {
    const f=collect();
    f.reporter.prepare(result());
    f.reporter.station('PRIVATE_BASE','connect','error','device_request_timeout',{stage:'session_open',sessionOpenMs:value});
    assert.equal(f.reporter.report().recent_events[0]!.session_open_ms,expected,`${value}`);
  }
});

test('each lookup count keeps its bounds and leaves out the value past them (#152)', () => {
  const bounds = [
    ['rounds','lookup_rounds',99], ['broadcastTargets','lookup_broadcast_targets',16],
    ['sendErrors','lookup_send_errors',999], ['datagrams','lookup_datagrams',999],
    ['otherHeaders','lookup_other_headers',999], ['ownReplies','lookup_own_replies',999],
    ['accountReplies','lookup_account_replies',999], ['foreignReplies','lookup_foreign_replies',999],
    ['nearReplies','lookup_near_replies',999],
  ] as const;
  for (const [key,field,max] of bounds) {
    for (const [value,expected] of [[0,0],[max,max],[max+1,undefined],[-1,undefined]]) {
      const f=collect();
      f.reporter.prepare(result());
      f.reporter.station('PRIVATE_BASE','connect','error','device_request_timeout',{stage:'lookup',lookup:{...silentLookup,[key]:value}});
      assert.equal(f.reporter.report().recent_events[0]![field],expected,`${key} ${value}`);
    }
  }
});

test('model codes with a short suffix are reported as received, serials never', () => {
  const f=collect();
  const value=result();
  value.devices[1]!.model='T8113-Z';
  value.issues[0]!.deviceModel='T8113-X';
  value.issues[1]!.deviceModel='T8113-PRIVATE';
  f.reporter.inventory(value,'accepted',undefined,true,new Map(),new Map());
  const rows=f.rows();
  assert.equal(rows.find(r=>r.event==='device'&&r.ref===2).model,'T8113-Z');
  assert.deepEqual(rows.filter(r=>r.event==='issue').map(r=>r.model),['T8113-X','unavailable']);
  assert.doesNotMatch(f.lines.join('\n'),/PRIVATE/);
});

// The same bound applies to the live video and audio rows and the HA download (#149).
const modelBound = {
  shown: ['T8030', 'T8113-Z', 'T8160-C', 'T8410C', 'T8W11C', 'T8419N', 'T8410AB', 'T8410ABC'],
  hidden: [
    'T8410ABCD', 'T8224-ABC', 'T8224A-B', 'T8224-', 'T8224-z', 'T8410c', 't8410C', 'T8410PRIVATE0001',
    'T8410C ', ' T8410C', 'T8410C\n', 'T84 10C', 'T841', '', undefined, null, 8410, {}, [],
  ] as unknown[],
};

test('unhyphenated catalogue codes are reported as received, serials and free text never (#149)', () => {
  for (const value of modelBound.shown) assert.equal(diagnosticModel(value), value, String(value));
  for (const value of modelBound.hidden) assert.equal(diagnosticModel(value), 'unavailable', JSON.stringify(value));
  const f=collect();
  const value=result();
  value.devices[1]!.model='T8160-C';
  value.issues[0]!.deviceModel='T8410C';
  value.issues[0]!.deviceType=31;
  value.issues[0]!.context={firmware:'3.3.4.4',hardware:'1',parentStatus:'present',parentId:'PRIVATE_BASE',parentModel:'T8030',parentFirmware:'3.8.7.4'};
  value.issues[1]!.deviceModel='T8410PRIVATE0001';
  f.reporter.inventory(value,'accepted',undefined,true,new Map(),new Map());
  const rows=f.rows();
  assert.equal(rows.find(r=>r.event==='device'&&r.ref===2).model,'T8160-C');
  assert.deepEqual(rows.filter(r=>r.event==='issue').map(r=>[r.model,r.device_type,r.parent_model]),
    [['T8410C',31,'T8030'],['unavailable',96,'unavailable']]);
  assert.doesNotMatch(f.lines.join('\n'),/PRIVATE/);
});

test('standalone descriptors are booleans only and other relationships have none', () => {
  const f=collect();
  const value=result();
  value.devices.push({id:'PRIVATE_WALL',stationId:'PRIVATE_WALL',kind:'camera',model:'T84A1',name:'PRIVATE_NAME',firmware:'1.1.0.4',hardware:'1',battery:null});
  value.relationships.push({deviceId:'PRIVATE_WALL',kind:'standalone',ownerId:'PRIVATE_WALL',transport:'experimental',
    descriptor:{did:true,license:'PRIVATE' as unknown as boolean,adminUser:false,lanAddress:1 as unknown as boolean}});
  f.reporter.prepare(value);
  f.reporter.inventory(value,'accepted',undefined,true,new Map(),new Map());
  const rows=f.reporter.report().last_discovery.filter(row=>row.event==='device');
  const wall=rows.find(row=>row.model==='T84A1')!;
  assert.deepEqual(wall.descriptor,{did:true,license:null,admin_user:false,lan_address:null});
  assert.equal(wall.relationship_transport,'experimental');
  assert.equal(wall.owner_status,'not_checked');
  assert.equal(wall.owner_ref,3);
  for (const row of rows.filter(row=>row.model!=='T84A1')) {
    assert.equal(row.descriptor,null);
    assert.equal(row.relationship_transport,null);
  }
  assert.doesNotMatch(JSON.stringify(f.reporter.report()),/PRIVATE/);
});

test('the summary carries the experimental_standalone option and no other record does (#154)', () => {
  const summary = (f: ReturnType<typeof collect>) => f.rows().find(row => row.event === 'summary');
  for (const enabled of [true, false]) {
    const f = collect();
    f.reporter.connection('authentication', 'connected', false);
    f.reporter.inventory(result(), 'accepted', undefined, true, new Map(), new Map(), enabled);
    assert.equal(summary(f).experimental_standalone, enabled);
    const report = f.reporter.report();
    assert.equal(report.last_discovery[0]!.event, 'summary');
    assert.equal(report.last_discovery[0]!.experimental_standalone, enabled);
    assert.deepEqual([...new Set(report.last_discovery.map(row => row.event))], ['summary', 'device', 'issue', 'end']);
    assert.deepEqual(report.recent_events.map(row => row.event), ['connection']);
    for (const row of [...f.rows(), ...report.last_discovery, ...report.recent_events]) {
      assert.equal(row.schema, 2);
      if (row.event !== 'summary') assert.equal('experimental_standalone' in row, false, String(row.event));
    }
  }
  // Only the boolean true the library receives turns it on.
  for (const value of ['true', 1, {}, null, undefined]) {
    const f = collect();
    f.reporter.inventory(result(), 'accepted', undefined, true, new Map(), new Map(), value as unknown as boolean);
    assert.equal(summary(f).experimental_standalone, false, JSON.stringify(value));
    assert.equal(f.reporter.report().last_discovery[0]!.experimental_standalone, false);
  }
  const omitted = collect();
  omitted.reporter.inventory(result(), 'accepted', undefined, true, new Map(), new Map());
  assert.equal(summary(omitted).experimental_standalone, false);
  // An unchanged inventory still states the option on its summary line and download.
  const f = collect();
  f.reporter.inventory(result(), 'accepted', undefined, true, new Map(), new Map(), true);
  f.lines.length = 0;
  f.reporter.inventory(result(), 'accepted', undefined, true, new Map(), new Map(), true);
  assert.equal(f.lines.length, 2);
  assert.equal(f.rows()[0].unchanged, true);
  assert.equal(f.rows()[0].experimental_standalone, true);
  const downloaded = f.reporter.report();
  assert.equal(downloaded.last_discovery.length, 6);
  assert.equal(downloaded.last_discovery[0]!.report, 2);
  assert.equal(downloaded.last_discovery[0]!.experimental_standalone, true);
  // Without an inventory the summary still says which option the library had.
  f.lines.length = 0;
  f.reporter.inventory(undefined, 'invalid_inventory', undefined, false, new Map(), new Map(), true);
  assert.equal(f.rows()[0].inventory_available, false);
  assert.equal(f.rows()[0].experimental_standalone, true);
  // The option changes no device row: the library's relationship stays the evidence.
  const mixed = (): DiscoveryResult => {
    const value = result();
    const descriptor = { did: true, license: true, adminUser: true, lanAddress: true };
    value.devices.push(
      {id:'PRIVATE_SOLO',stationId:'PRIVATE_SOLO',kind:'camera',model:'T8410C',name:'PRIVATE_NAME',firmware:'3.3.4.4',hardware:'1',battery:null},
      {id:'PRIVATE_WALL',stationId:'PRIVATE_WALL',kind:'camera',model:'T84A1',name:'PRIVATE_NAME',firmware:'1.1.0.4',hardware:'1',battery:null},
    );
    value.relationships.push(
      {deviceId:'PRIVATE_SOLO',kind:'standalone',ownerId:'PRIVATE_SOLO',reason:'standalone_transport_unverified',descriptor},
      {deviceId:'PRIVATE_WALL',kind:'standalone',ownerId:'PRIVATE_WALL',transport:'experimental',descriptor},
    );
    return value;
  };
  const devices = (enabled: boolean) => {
    const g = collect();
    g.reporter.inventory(mixed(), 'accepted', undefined, true, new Map(), new Map(), enabled);
    assert.doesNotMatch(g.lines.join('\n'), /PRIVATE/);
    return g.rows().filter(row => row.event === 'device').map(({ timestamp: _, ...row }) => row);
  };
  const on = devices(true);
  assert.deepEqual(on, devices(false));
  assert.deepEqual(
    on.filter(row => row.relationship === 'standalone').map(row => [row.model, row.relationship_reason, row.relationship_transport]),
    [['T8410C', 'standalone_transport_unverified', null], ['T84A1', null, 'experimental']],
  );
});

test('the summary carries the standalone_recording_probe option and no other record does (#178)', () => {
  const summary = (f: ReturnType<typeof collect>) => f.rows().find(row => row.event === 'summary');
  for (const [standalone, probe] of [[true, true], [false, true], [true, false], [false, false]] as const) {
    const f = collect();
    f.reporter.inventory(result(), 'accepted', undefined, true, new Map(), new Map(), standalone, probe);
    // The option is reported as set, also when experimental_standalone is off and nothing is probed.
    assert.equal(summary(f).standalone_recording_probe, probe);
    assert.equal(summary(f).experimental_standalone, standalone);
    const keys = Object.keys(summary(f));
    assert.equal(keys.indexOf('standalone_recording_probe'), keys.indexOf('experimental_standalone') + 1);
    const report = f.reporter.report();
    assert.equal(report.last_discovery[0]!.standalone_recording_probe, probe);
    for (const row of [...f.rows(), ...report.last_discovery])
      if (row.event !== 'summary') assert.equal('standalone_recording_probe' in row, false, String(row.event));
  }
  // Only the boolean true turns it on. Omitted, it is false.
  for (const value of ['true', 1, {}, null, undefined]) {
    const f = collect();
    f.reporter.inventory(result(), 'accepted', undefined, true, new Map(), new Map(), true, value as unknown as boolean);
    assert.equal(summary(f).standalone_recording_probe, false, JSON.stringify(value));
  }
  const omitted = collect();
  omitted.reporter.inventory(result(), 'accepted', undefined, true, new Map(), new Map(), true);
  assert.equal(summary(omitted).standalone_recording_probe, false);
  // Without an inventory the summary still states the option.
  const failed = collect();
  failed.reporter.inventory(undefined, 'invalid_inventory', undefined, false, new Map(), new Map(), true, true);
  assert.equal(summary(failed).standalone_recording_probe, true);
});
// The HA download applies the same release and numeric version bounds.
const versionCases = JSON.parse(readFileSync(
  new URL('../../tests/fixtures/diagnostic-versions.json', import.meta.url), 'utf8',
)) as Record<'release' | 'numeric', { accepted: string[]; rejected: unknown[] }>;

test('bridge and library versions may be betas, device and Node versions stay numeric', () => {
  for (const value of versionCases.release.accepted) assert.equal(diagnosticReleaseVersion(value), value, value);
  for (const value of versionCases.release.rejected)
    assert.equal(diagnosticReleaseVersion(value), 'unavailable', JSON.stringify(value));
  for (const value of versionCases.numeric.accepted) assert.equal(diagnosticVersion(value), value, value);
  for (const value of versionCases.numeric.rejected)
    assert.equal(diagnosticVersion(value), 'unavailable', JSON.stringify(value));
  // Both package versions go through the release bound, such as a 0.8.38-beta.1 bridge.
  const installed = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')).version;
  const software = diagnosticSoftware();
  assert.equal(software.bridge, installed('../package.json'));
  assert.equal(software.library, installed('../node_modules/@keesmod/eufy-mega-client/package.json'));
  assert.equal(software.node, diagnosticVersion(process.versions.node));
  const f = collect();
  const value = result();
  value.devices[1]!.firmware = '0.2.1.8-beta.1';
  value.devices[1]!.hardware = '1-beta.1';
  value.issues[0]!.context = {firmware:'3.3.4.4-beta.1',parentStatus:'present',parentId:'PRIVATE_BASE',parentModel:'T8030',parentFirmware:'3.8.7.4-beta.1'};
  f.reporter.inventory(value, 'accepted', undefined, true, new Map(), new Map());
  const rows = f.rows();
  assert.deepEqual(rows[0].software, software);
  const camera = rows.find(row => row.event === 'device' && row.ref === 2);
  assert.deepEqual([camera.firmware, camera.hardware], ['unavailable', 'unavailable']);
  const issue = rows.find(row => row.event === 'issue');
  assert.deepEqual([issue.firmware, issue.parent_firmware], ['unavailable', 'unavailable']);
  assert.doesNotMatch(f.lines.join('\n'), /PRIVATE/);
});

// Recording query rows of bridge 0.8.39 (#152), shared with the HA download tests.
type QueryRow = Record<string, any>;
const queryRows = (JSON.parse(readFileSync(
  new URL('../../tests/fixtures/recording-query.json', import.meta.url), 'utf8',
)) as { rows: Record<string, QueryRow> }).rows;
const lookupNames = {
  rounds: 'lookup_rounds', broadcastTargets: 'lookup_broadcast_targets', broadcastEnabled: 'lookup_broadcast_enabled',
  sendErrors: 'lookup_send_errors', datagrams: 'lookup_datagrams', otherHeaders: 'lookup_other_headers',
  ownReplies: 'lookup_own_replies', ownRound: 'lookup_own_round', accountReplies: 'lookup_account_replies',
  foreignReplies: 'lookup_foreign_replies', nearReplies: 'lookup_near_replies', inventoryReply: 'lookup_inventory_reply',
  inventoryAddressOnSubnet: 'inventory_address_on_subnet', inventoryAddressShared: 'inventory_address_shared',
} as const;
/** The client observation and connection a fixture row stands for, in the client's own names. */
function queryReport(row: QueryRow): RecordingQueryReport {
  const pages = Array.from({ length: row.pages }, (_, index) => index < row.pages - 1
    ? { limit: 100, elapsedMs: 800, answered: true, ackCode: 0, resultCode: 0, rows: 100 }
    : { limit: row.query_limit, elapsedMs: 900, answered: row.query_answered, ackCode: row.ack_code,
        resultCode: row.query_result_code, rows: row.query_rows });
  const lookup = Object.fromEntries(Object.entries(lookupNames)
    .filter(([, field]) => field in row).map(([key, field]) => [key, row[field]]));
  return {
    query: row.query,
    observation: {
      operation: row.query, owner: row.owner, sessionOpen: row.session_open, stage: row.query_stage,
      code: row.reason, remoteCode: row.result_code, elapsedMs: row.elapsed_ms, pages,
      unhandledReplies: row.unhandled_replies, unhandledReason: row.unhandled_reason,
      unhandledResultCode: row.unhandled_result_code,
      rowClasses: row.query_rows === null ? null : {
        own: row.rows_own, otherDevice: row.rows_other_device, stationMismatch: row.rows_station_mismatch,
        invalidTime: row.rows_invalid_time, otherDay: row.rows_other_day, cipherId: row.rows_cipher_id,
      },
    },
    connection: row.stage ? { stage: row.stage, lookup: lookup as unknown as StationLookupObservation } : { stage: 'none' },
    returned: row.returned,
  };
}
/** An experimental standalone T8410 first, then a HomeBase with its camera. */
const solo = (): DiscoveryResult => {
  const value = result();
  value.devices.unshift({id:'PRIVATE_SOLO',stationId:'PRIVATE_SOLO',kind:'camera',model:'T8410',name:'PRIVATE_NAME',firmware:'2.3.2.4',hardware:'1',battery:null});
  value.relationships.unshift({deviceId:'PRIVATE_SOLO',kind:'standalone',ownerId:'PRIVATE_SOLO',transport:'experimental',
    descriptor:{did:true,license:true,adminUser:true,lanAddress:true}});
  return value;
};
const recordingRows = (f: ReturnType<typeof collect>) =>
  f.reporter.report().recent_events.filter(row => row.event === 'recording_query');
const withoutEnvelope = ({ diagnostic: _d, schema: _s, timestamp: _t, ...row }: Record<string, unknown>) => row;

test('each shared recording_query fixture row is what the bridge emits for its observation (#152)', () => {
  for (const [name, expected] of Object.entries(queryRows)) {
    const f = collect();
    // The fixture rows belong to the third inventory report.
    for (let n = 0; n < 3; n++) f.reporter.inventory(solo(), 'accepted', undefined, true, new Map(), new Map());
    f.lines.length = 0;
    f.reporter.recording('PRIVATE_SOLO', queryReport(expected));
    const [row] = recordingRows(f);
    assert.deepEqual(withoutEnvelope(row!), expected, name);
    assert.deepEqual(Object.keys(withoutEnvelope(row!)), Object.keys(expected), name);
    assert.deepEqual([row!.diagnostic, row!.schema, typeof row!.timestamp], ['discovery', 2, 'string']);
    // The 'Eufy discovery:' log line carries the same record.
    assert.deepEqual(f.rows(), [row]);
    assert.doesNotMatch(f.lines.join('\n'), /PRIVATE/);
  }
});

test('a recording_query record without a client observation is a failure at admission (#152)', () => {
  const f = collect();
  f.reporter.prepare(solo());
  f.reporter.recording('PRIVATE_SOLO', { query: 'list', reason: 'client_disconnected', elapsedMs: 0, returned: 503 });
  f.reporter.recording('PRIVATE_BASE', { query: 'calendar', reason: 'client_closed', remoteCode: -7, elapsedMs: 12, returned: 503 });
  const [standalone, station] = recordingRows(f).map(withoutEnvelope);
  const neutral = {
    session_open: null, query_stage: 'admission', pages: 0, query_limit: 0, query_answered: false,
    ack_code: null, query_result_code: null, query_rows: null, unhandled_replies: 0, unhandled_reason: null,
    unhandled_result_code: null, rows_own: 0, rows_other_device: 0, rows_station_mismatch: 0,
    rows_invalid_time: 0, rows_other_day: 0, rows_cipher_id: 0, returned: 503,
  };
  assert.deepEqual(standalone, {
    event: 'recording_query', report: 1, device_ref: 1, model: 'T8410', query: 'list', owner: 'standalone',
    status: 'error', reason: 'client_disconnected', result_code: null, elapsed_ms: 0, ...neutral,
  });
  assert.deepEqual(station, {
    event: 'recording_query', report: 1, device_ref: 2, model: 'T8030', query: 'calendar', owner: 'station',
    status: 'error', reason: 'client_closed', result_code: -7, elapsed_ms: 12, ...neutral,
  });
  // An owner outside the inventory is not recorded.
  f.reporter.recording('PRIVATE_UNKNOWN', { query: 'list', reason: 'client_disconnected', returned: 503 });
  assert.equal(recordingRows(f).length, 2);
  assert.doesNotMatch(JSON.stringify(f.reporter.report()) + f.lines.join('\n'), /PRIVATE/);
});

test('a probe record has returned null and keeps the record shape of a list (#178)', () => {
  const f = collect();
  f.reporter.prepare(solo());
  f.reporter.recording('PRIVATE_SOLO', { query: 'probe', reason: 'operation_outside_hardware_scope', elapsedMs: 0 });
  f.reporter.recording('PRIVATE_SOLO', { query: 'list', reason: 'client_disconnected', elapsedMs: 0, returned: 503 });
  const [probe, list] = recordingRows(f).map(withoutEnvelope);
  assert.deepEqual(Object.keys(probe!), Object.keys(list!));
  assert.deepEqual([probe!.query, probe!.owner, probe!.query_stage, probe!.returned], ['probe', 'standalone', 'admission', null]);
  assert.equal(list!.returned, 503);
  assert.doesNotMatch(f.lines.join('\n'), /PRIVATE/);
});

test('hostile recording observations keep only bounded values and never throw (#152)', () => {
  const base = queryReport(queryRows.completed_with_rows!);
  const record = (report: RecordingQueryReport) => {
    const f = collect();
    f.reporter.prepare(solo());
    assert.doesNotThrow(() => f.reporter.recording('PRIVATE_SOLO', report));
    assert.doesNotMatch(JSON.stringify(f.reporter.report()) + f.lines.join('\n'), /PRIVATE|192\.168|mIntRet/);
    return recordingRows(f)[0];
  };
  const hostile = {
    ...base.observation!,
    operation: 'PRIVATE', owner: 'homebase', sessionOpen: 'true', stage: 'PRIVATE_STAGE',
    code: 'PRIVATE_TOKEN', remoteCode: 2 ** 53, elapsedMs: 3600001,
    pages: [{ limit: 10001, elapsedMs: -1, answered: 1, ackCode: -1000000, resultCode: 1.5, rows: 10001,
      device_sn: 'PRIVATE_SERIAL', storage_path: '/PRIVATE/path' }],
    unhandledReplies: 100, unhandledReason: 'PRIVATE', unhandledResultCode: '-6006',
    rowClasses: { own: -1, otherDevice: 10001, stationMismatch: '1', invalidTime: null, otherDay: 1.5, cipherId: true },
    serial: 'PRIVATE_SERIAL', did: 'PRIVATE_DID', path: '/PRIVATE/recording.mp4', payload: '{"mIntRet":-6006}',
  } as unknown as RecordingObservation;
  const row = record({ ...base, observation: hostile, returned: 600,
    connection: { stage: 'PRIVATE_192.168.1.2', inventoryAddress: 'yes' as unknown as boolean,
      lookup: { did: 'PRIVATE_DID', address: '192.168.1.2' } as unknown as StationLookupObservation } })!;
  assert.deepEqual(withoutEnvelope(row), {
    event: 'recording_query', report: 1, device_ref: 1, model: 'T8410', query: 'list', owner: null,
    status: 'error', reason: 'unclassified_error', result_code: null, session_open: null, query_stage: null,
    stage: 'none', elapsed_ms: null, pages: 1, query_limit: null, query_answered: null, ack_code: null,
    query_result_code: null, query_rows: null, unhandled_replies: null, unhandled_reason: null,
    unhandled_result_code: null, rows_own: null, rows_other_device: null, rows_station_mismatch: null,
    rows_invalid_time: null, rows_other_day: null, rows_cipher_id: null, returned: null,
  });
  // The client's name for an error that is not a EufyError is the bridge's unclassified_error.
  assert.equal(record({ ...base, observation: { ...base.observation!, code: 'unexpected_error' } })!.reason, 'unclassified_error');
  // More than four pages, pages that are no array and row classes that are no object.
  const pages = record({ ...base, observation: { ...base.observation!, pages: Array(5).fill(base.observation!.pages[0]) } })!;
  assert.deepEqual([pages.pages, pages.query_limit, pages.query_rows], [null, 100, 12]);
  const broken = record({ ...base, observation: { ...base.observation!,
    pages: 'PRIVATE' as unknown as [], rowClasses: 'PRIVATE' as unknown as null } })!;
  assert.deepEqual([broken.pages, broken.query_limit, broken.query_answered, broken.ack_code, broken.rows_own],
    [null, null, null, null, null]);
  // An observation that cannot be read leaves no record.
  const throwing = new Proxy({}, { get: () => { throw new Error('PRIVATE_TOKEN'); } }) as RecordingObservation;
  assert.equal(record({ ...base, observation: throwing }), undefined);
  assert.equal(record({ ...base, query: 'PRIVATE' as unknown as 'list' })!.query, null);
});

test('a repeated recording outcome is recorded once per owner, query and report (#152)', () => {
  const f = collect();
  f.reporter.inventory(solo(), 'accepted', undefined, true, new Map(), new Map());
  const silent = queryReport(queryRows.silent_timeout!);
  const variant = (change: Partial<RecordingObservation>, query: RecordingQueryReport['query'] = 'list') =>
    ({ ...silent, query, observation: { ...silent.observation!, ...change } });
  f.reporter.recording('PRIVATE_SOLO', silent);
  // Another elapsed time alone repeats it.
  f.reporter.recording('PRIVATE_SOLO', variant({ elapsedMs: 15104 }));
  // A device ACK code is a new outcome, a later repeat of it is left out.
  f.reporter.recording('PRIVATE_SOLO', variant({ pages: [{ ...silent.observation!.pages[0]!, ackCode: -104 }] }));
  f.reporter.recording('PRIVATE_SOLO', variant({ pages: [{ ...silent.observation!.pages[0]!, ackCode: -104, elapsedMs: 1 }] }));
  // Changed counts alone repeat it, a count that becomes non-zero does not.
  const rows = (classes: Partial<Record<string, number>>) => ({ rowClasses: { own: 0, otherDevice: 0, stationMismatch: 0, invalidTime: 0, otherDay: 0, cipherId: 0, ...classes } });
  f.reporter.recording('PRIVATE_SOLO', variant(rows({ own: 2, cipherId: 2 })));
  f.reporter.recording('PRIVATE_SOLO', variant(rows({ own: 7, cipherId: 7 })));
  f.reporter.recording('PRIVATE_SOLO', variant(rows({ own: 7, cipherId: 0 })));
  // Another query of the same owner, and the same outcome on another owner.
  f.reporter.recording('PRIVATE_SOLO', variant({ operation: 'calendar' }, 'calendar'));
  f.reporter.recording('PRIVATE_BASE', silent);
  f.reporter.recording('PRIVATE_SOLO', silent);
  let recorded = recordingRows(f);
  assert.deepEqual(recorded.map(row => [row.device_ref, row.query, row.ack_code, row.rows_own, row.rows_cipher_id]), [
    [1, 'list', null, 0, 0],
    [1, 'list', -104, 0, 0],
    [1, 'list', null, 2, 2],
    [1, 'list', null, 7, 0],
    [1, 'calendar', null, 0, 0],
    [2, 'list', null, 0, 0],
    [1, 'list', null, 0, 0],
  ]);
  // A new inventory report records the same outcome again.
  f.reporter.recording('PRIVATE_SOLO', silent);
  f.reporter.inventory(solo(), 'accepted', undefined, true, new Map(), new Map());
  f.reporter.recording('PRIVATE_SOLO', silent);
  recorded = recordingRows(f);
  assert.deepEqual(recorded.slice(-1).map(row => [row.report, row.reason]), [[2, 'device_request_timeout']]);
  assert.equal(recorded.length, 8);
});

test('recording_query records share the bounded ring of recent events (#152)', () => {
  const f = collect();
  f.reporter.prepare(solo());
  f.reporter.connection('authentication', 'connected', false);
  const silent = queryReport(queryRows.silent_timeout!);
  for (let n = 0; n < 150; n++)
    f.reporter.recording('PRIVATE_SOLO', { ...silent, observation: { ...silent.observation!,
      pages: [{ ...silent.observation!.pages[0]!, ackCode: -n }] } });
  const events = f.reporter.report().recent_events;
  assert.equal(events.length, 100);
  assert.ok(events.every(row => row.event === 'recording_query'));
  assert.equal(events.at(-1)!.ack_code, -149);
  assert.equal(f.lines.length, 151);
});

// ha-eufy-cam#185: the client's standalone push observation, revalidated at the library boundary.
const pushObservation = () => ({
  arrived: 7,
  admitted: 3,
  refused: { events_not_enabled: 0, owner_unavailable: 1, serial_mismatch: 1, type_mismatch: 1, unsupported_event: 1 },
  sources: { cloud: 6, local: 1 },
  eventCodes: { '3101': 2, '3102': 1, '3103': 2, none: 1, other: 1 },
  pushTypes: { '151': 6, '18': 1 },
});
test('the standalone push observation becomes snake_case counts and bounded {code, count} rows (#185)', () => {
  assert.deepEqual(standalonePushReport(pushObservation()), {
    arrived: 7,
    admitted: 3,
    refused: { events_not_enabled: 0, owner_unavailable: 1, serial_mismatch: 1, type_mismatch: 1, unsupported_event: 1 },
    sources: { cloud: 6, local: 1 },
    event_codes: [
      { code: 3101, count: 2 }, { code: 3102, count: 1 }, { code: 3103, count: 2 },
      { code: 'none', count: 1 }, { code: 'other', count: 1 },
    ],
    push_types: [{ code: 18, count: 1 }, { code: 151, count: 6 }],
  });
  // The client's zero observation before its device transport exists.
  assert.deepEqual(standalonePushReport({
    arrived: 0, admitted: 0,
    refused: { events_not_enabled: 0, owner_unavailable: 0, serial_mismatch: 0, type_mismatch: 0, unsupported_event: 0 },
    sources: { cloud: 0, local: 0 }, eventCodes: {}, pushTypes: {},
  }), {
    arrived: 0, admitted: 0,
    refused: { events_not_enabled: 0, owner_unavailable: 0, serial_mismatch: 0, type_mismatch: 0, unsupported_event: 0 },
    sources: { cloud: 0, local: 0 }, event_codes: [], push_types: [],
  });
});
test('a hostile standalone push observation leaves only bounded integers and no serial (#185)', () => {
  for (const missing of [undefined, null, 'PRIVATE_SERIAL', 7, true, [1, 2]])
    assert.equal(standalonePushReport(missing), null);
  const report = standalonePushReport({
    arrived: 1.5,
    admitted: -1,
    refused: { events_not_enabled: '2', owner_unavailable: 2 ** 31, serial_mismatch: Number.NaN, type_mismatch: null, unsupported_event: 2 ** 31 - 1, PRIVATE_SERIAL: 4 },
    sources: ['PRIVATE_SERIAL', 2],
    serial: 'PRIVATE_SERIAL',
    address: '192.168.1.20',
    image: 'data:image/jpeg;base64,PRIVATE',
    eventCodes: {
      PRIVATE_SERIAL: 1, '192.168.1.20': 1, '-1': 1, '01': 1, '100000': 1, '1e3': 1, ' 3101': 1, '3101.0': 1,
      '99999': 1, '0': 2 ** 31 - 1, '3101': 2 ** 31, '3102': '1', '3103': 1.5, '3104': -1, none: true, other: 0,
    },
    pushTypes: ['PRIVATE_SERIAL', 151],
  })!;
  assert.deepEqual(report, {
    arrived: null,
    admitted: null,
    refused: { events_not_enabled: null, owner_unavailable: null, serial_mismatch: null, type_mismatch: null, unsupported_event: 2 ** 31 - 1 },
    sources: { cloud: null, local: null },
    event_codes: [{ code: 0, count: 2 ** 31 - 1 }, { code: 99999, count: 1 }, { code: 'other', count: 0 }],
    push_types: [],
  });
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|192\.168|base64|"(?:serial|address|image)"/);
  // At most 16 numeric keys plus none and other, as the client bounds them.
  const many = Object.fromEntries([...Array.from({ length: 40 }, (_, index) => [String(index * 10), 1]), ['none', 2], ['other', 3]]);
  const rows = standalonePushReport({ ...pushObservation(), eventCodes: many })!.event_codes;
  assert.equal(rows.length, 18);
  assert.deepEqual(rows.slice(-3), [{ code: 150, count: 1 }, { code: 'none', count: 2 }, { code: 'other', count: 3 }]);
  assert.ok(rows.every((row) => Number.isInteger(row.count) && (typeof row.code === 'number' ? Number.isInteger(row.code) && row.code >= 0 && row.code <= 99999 : row.code === 'none' || row.code === 'other')));
});
