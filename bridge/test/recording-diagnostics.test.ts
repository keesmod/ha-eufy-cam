import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { Readable, PassThrough } from 'node:stream';
import { writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { RecordingDiagnostics } from '../src/recording-diagnostics.js';
import { RecordingTranscoder } from '../src/recording-media.js';
import { MegaRecordings } from '../src/mega-recordings.js';
import { createBridge } from '../src/server.js';
import { StreamHub } from '../src/streams.js';
process.env.EUFY_DATA_DIR = tmpdir();

test('bounded reports expire without retaining upstream text or identity and snapshots do not mutate ownership', () => {
  let now = 0;
  const reports = new RecordingDiagnostics(() => now);
  const first = reports.begin('auto');
  for (let n = 0; n < 10; n++) reports.begin('native');
  const row = reports.begin('h264');
  for (let n = 0; n < 50; n++) row.conversion({diagnostic:'recording',attempt:999,event:'recording_failed',elapsed_ms:1,
    failure:{reason:'process',encoded_frames:10,output_bytes:20,timeout_ms:100,timeout_scope:'conversion',exit_code:1,signal:'PRIVATE',ffmpeg:['decode','PRIVATE'],ffmpeg_detail:'PRIVATE path token serial'}});
  row.finish('failed', {code:'PRIVATE'});
  const result = reports.report();
  assert.equal(result.attempts.length,8); assert.equal(result.attempts.at(-1)!.events.length,16);
  assert.equal(new Set(result.attempts.map(r=>r.attempt)).size,8);
  assert.ok(!result.attempts.some(r=>r.attempt===first.data.attempt));
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  result.attempts[0]!.outcome='failed'; assert.equal(reports.report().attempts[0]!.outcome,'active');
  now=900000; assert.deepEqual(reports.report(),{schema:1,retention_ms:900000,expired:8,attempts:[]});
});

class Process extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough(); progress = new PassThrough();
  stdio = [this.stdin,this.stdout,this.stderr,undefined,this.progress];
  kill() { queueMicrotask(()=>this.emit('close', null, 'SIGKILL')); return true; }
}
function fixture(fail = false, wait = false) {
  let launches = 0, downloads = 0, cancels = 0, child: Process | undefined;
  let connected = true;
  const media = new RecordingTranscoder('nvidia', () => {}, args => {
    launches++; child = new Process(); const active=child;
    writeFileSync(args.at(-1)!, 'mp4');
    queueMicrotask(()=>{
      active.progress.write('frame=10\n');
      if(wait)return;
      if(fail && launches===1){active.stderr.write('CUDA_ERROR_OUT_OF_MEMORY PRIVATE');active.emit('close',1);}
      else active.emit('close',0);
    });
    return child as any;
  });
  const client = {get connected(){return connected;},
    listRecordings:async()=>({complete:true,returned:1,recordings:[{id:'PRIVATE',deviceId:'CAM',stationId:'BASE',start:'2026-09-15T10:00:00Z',end:'2026-09-15T10:00:01Z'}]}),
    downloadRecording:async()=>{downloads++;return {video:Readable.from(['source']),audio:Readable.from(['audio']),metadata:{videoCodec:'h265',fps:15},completed:Promise.resolve({complete:true}),cancel:async()=>{cancels++;}};}};
  const recordings=new MegaRecordings(()=>client as any,()=>[{id:'CAM',kind:'camera',stationId:'BASE'}] as any,()=>false,undefined,media);
  return {recordings, counts:()=>({launches,downloads,cancels}), disconnect:()=>{connected=false;}};
}
for (const fallback of [false,true]) test(`full attempt correlates download, process, media and cleanup, fallback=${fallback}`,async()=>{
  const f=fixture(fallback);const signal=new AbortController().signal;
  const id=(await f.recordings.list('CAM','2026-09-15',signal)).recordings[0]!.id;
  let attempt=0,path='';
  await f.recordings.video('CAM',id,signal,async output=>{path=output.path;assert.ok(existsSync(path));},'auto',false,id=>{attempt=id;});
  const row=f.recordings.diagnostics.report().attempts[0]!;
  assert.equal(row.attempt,attempt);assert.equal(row.outcome,'completed');assert.equal(row.stage,'transfer');
  assert.equal(row.source_bytes,11);assert.equal(row.output_bytes,3);assert.equal(row.media?.fallback,fallback);
  assert.equal(row.progress?.process_closed,true);assert.equal(row.source_cancel_confirmed,true);assert.equal(row.files_removed,true);assert.ok(!existsSync(path));
  assert.equal(f.counts().downloads,1);assert.equal(f.counts().launches,fallback?2:1);
  if(fallback){const error=row.events.find(r=>r.event==='recording_hardware_failed')!.failure as any;assert.deepEqual(error.ffmpeg,['memory']);assert.equal(error.encoded_frames,10);}
  const before=f.counts();for(let i=0;i<10;i++)f.recordings.diagnostics.report();assert.deepEqual(f.counts(),before);
  assert.ok(!JSON.stringify(row).includes('PRIVATE'));
});

test('cancellation records confirmed process/source/file cleanup and never claims completion',async()=>{
  const f=fixture(false,true),cancel=new AbortController();
  const id=(await f.recordings.list('CAM','2026-09-15',cancel.signal)).recordings[0]!.id;
  const pending=f.recordings.video('CAM',id,cancel.signal,async()=>assert.fail('cancelled output'));
  const rejected=assert.rejects(pending);
  while(!f.counts().launches)await new Promise(r=>setTimeout(r,1));
  cancel.abort();await rejected;
  const row=f.recordings.diagnostics.report().attempts[0]!;
  assert.equal(row.outcome,'cancelled');assert.equal(row.progress?.process_closed,true);
  assert.equal(row.source_cancel_confirmed,true);assert.equal(row.files_removed,true);assert.equal(f.recordings.busy,false);
});

test('HTTP headers correlate success and admission failure without starting another download',async()=>{
  const f=fixture(),signal=new AbortController().signal;
  const id=(await f.recordings.list('CAM','2026-09-15',signal)).recordings[0]!.id;
  const hub=new StreamHub({start:async()=>{},stop:async()=>{},disposeMedia:()=>{}});
  const fake=Object.assign(new EventEmitter(),{recordings:f.recordings,hasCamera:(s:string)=>s==='CAM',hub});
  const server=createBridge(fake as any,'t'.repeat(32),'synthetic');
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert.ok(address && typeof address!=='string');
  const url=`http://127.0.0.1:${address.port}/v1/recordings/CAM/${id}/video`,headers={Authorization:'Bearer '+'t'.repeat(32)};
  try{
    assert.equal((await fetch(url)).status,401);assert.equal(f.recordings.diagnostics.report().attempts.length,0);
    const response=await fetch(url,{headers});assert.equal(response.status,200);await response.arrayBuffer();
    assert.equal(Number(response.headers.get('X-Eufy-Recording-Attempt')),f.recordings.diagnostics.report().attempts[0]!.attempt);
    while(f.recordings.busy)await new Promise(r=>setTimeout(r,1));
    f.disconnect();const failed=await fetch(url,{headers});assert.equal(failed.status,503);await failed.text();
    const row=f.recordings.diagnostics.report().attempts.at(-1)!;
    assert.equal(Number(failed.headers.get('X-Eufy-Recording-Attempt')),row.attempt);
    assert.equal(row.stage,'admission');assert.equal(row.error,'recording_unavailable');assert.equal(f.counts().downloads,1);
  }finally{server.emit('shutdown');server.closeAllConnections();server.close();await once(server,'close');}
});
