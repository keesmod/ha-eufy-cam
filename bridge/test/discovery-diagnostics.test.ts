import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DiscoveryResult, Diagnostic, CameraCapabilities } from '@keesmod/eufy-mega-client';
import { DiscoveryDiagnostics, diagnosticSoftware } from '../src/discovery-diagnostics.js';

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
  assert.equal(rows[0].software.library,'0.12.1');
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
