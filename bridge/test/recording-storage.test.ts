import { test } from 'node:test';
process.env.EUFY_DATA_DIR = tmpdir();
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { MegaRecordings } from '../src/mega-recordings.js';
import { RecordingTranscoder } from '../src/recording-media.js';
function tracks() {
  const make = (args: string[]) => {
    const r = spawnSync('ffmpeg', ['-v', 'error', ...args], { timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
    assert.equal(r.status, 0, r.stderr.toString()); return r.stdout;
  };
  return {
    video: make(['-f','lavfi','-i','testsrc2=size=320x180:rate=15','-t','3','-c:v','libx265','-preset','ultrafast','-threads','1','-x265-params','pools=none:frame-threads=1:bframes=0','-f','hevc','pipe:1']),
    audio: make(['-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','3','-c:a','aac','-f','adts','pipe:1']),
  };
}
function fixture(media: RecordingTranscoder, input: ReturnType<typeof tracks>) {
  let downloads = 0, cancelled = 0;
  const client = {
    connected: true,
    listRecordings: async () => ({ complete: true, returned: 1, recordings: [{ id: 'synthetic', deviceId: 'CAM', stationId: 'BASE', start: '2026-09-14T10:00:00Z', end: '2026-09-14T10:00:03Z', bytes: input.video.length + input.audio.length }] }),
    downloadRecording: async () => {
      downloads++;
      return { video: Readable.from([input.video]), audio: Readable.from([input.audio]), metadata: { videoCodec: 'h265', fps: 15 }, completed: Promise.resolve({ complete: true }), cancel: async () => { cancelled++; } };
    },
  };
  const recordings = new MegaRecordings(() => client as any, () => [{ id: 'CAM', stationId: 'BASE', kind: 'camera' }] as any, () => false, undefined, media);
  return { recordings, counts: () => ({ downloads, cancelled }) };
}
// A CPU encoder emits a high bitrate to reproduce expansion of a small HEVC
// source. This exercises real FFmpeg/files, not NVIDIA hardware support.
function expanded(args: string[]) {
  args = [...args];
  const hw = args.indexOf('-hwaccel'); if (hw >= 0) args.splice(hw, 2);
  args[args.indexOf('-c:v') + 1] = 'libx264';
  const preset = args.indexOf('-preset'), pixel = args.indexOf('-pix_fmt');
  args.splice(preset, pixel - preset, '-preset', 'ultrafast', '-b:v','160M','-minrate','160M','-maxrate','160M','-bufsize','160M','-x264-params','nal-hrd=cbr:filler=1');
  return spawn('ffmpeg', args, { stdio: ['pipe','pipe','pipe','pipe','pipe'] });
}
test('real expanded MP4 above 32 MiB retains audio, duration, seeks and one transfer owner', async () => {
  const input = tracks(), events: any[] = [];
  assert.ok(input.video.length + input.audio.length < 32 * 1024 * 1024);
  const f = fixture(new RecordingTranscoder('nvidia', e => events.push(e), expanded), input);
  const signal = AbortSignal.timeout(20000);
  const id = (await f.recordings.list('CAM', '2026-09-14', signal)).recordings[0]!.id;
  let output = '', outputBytes = 0;
  const before = process.memoryUsage().arrayBuffers;
  await f.recordings.video('CAM', id, signal, async result => {
    output = result.path; outputBytes = result.size;
    assert.ok(result.size > 33563861); assert.ok(result.size < 256 * 1024 * 1024);
    assert.deepEqual(result.media, { source:'hevc', output:'h264', processing:'nvidia', fallback:false });
    assert.ok(f.recordings.busy);
    await assert.rejects(f.recordings.video('CAM', id, signal, async () => {}), { code:'recording_busy' });
    assert.ok(process.memoryUsage().arrayBuffers - before < 8 * 1024 * 1024, 'Node does not hold the MP4 in buffers');
    const probe = spawnSync('ffprobe', ['-v','error','-show_entries','stream=codec_name,duration','-of','json',result.path], { timeout:5000 });
    assert.equal(probe.status, 0);
    const streams = JSON.parse(probe.stdout.toString()).streams;
    assert.deepEqual(streams.map((s:any) => s.codec_name).sort(), ['aac','h264']);
    assert.ok(streams.every((s:any) => Number(s.duration) >= 3 && Number(s.duration) < 3.2));
    for (const seek of ['2','0.2']) {
      const decode = spawnSync('ffmpeg', ['-v','error','-ss',seek,'-i',result.path,'-t','0.3','-f','null','-'], { timeout:5000 });
      assert.equal(decode.status,0); assert.equal(decode.stderr.length,0);
    }
  }, 'auto', true);
  assert.ok(!existsSync(output)); assert.ok(!existsSync(dirname(output)));
  assert.equal(f.recordings.busy, false); assert.deepEqual(f.counts(), {downloads:1,cancelled:1});
  assert.equal(events.length,1); assert.equal(events[0].event,'recording_active_nvidia');
  console.log(JSON.stringify({ evidence:'synthetic_expanded_recording', source_bytes:input.video.length+input.audio.length, output_bytes:outputBytes, gpu_hardware:false, cleanup:true }));
});
test('real FFmpeg disk cutoff rejects truncated success without disabling the next hardware attempt', async () => {
  const dir = mkdtempSync(join(tmpdir(),'recording-limit-')), input = tracks(), events:any[] = [];
  const files = {video:join(dir,'video'),audio:join(dir,'audio'),output:join(dir,'output')};
  writeFileSync(files.video,input.video); writeFileSync(files.audio,input.audio);
  let attempts = 0;
  const media = new RecordingTranscoder('nvidia', e=>events.push(e), args=>{attempts++;return expanded(args);}, {conversionMs:15000,remuxMs:15000,hardwareMs:5000,cleanupMs:1000,bytes:1024*1024});
  try {
    for (let n=0;n<2;n++) await assert.rejects(media.muxResult({videoCodec:'hevc',fps:15},files,AbortSignal.timeout(20000)), (error:any)=>error.details.reason==='output_limit');
    assert.equal(attempts,2); assert.ok(events.every(e=>e.event==='recording_failed'));
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('cancelled delivery keeps ownership until file cleanup, and releases it after consumer errors', async () => {
  const f = fixture(new RecordingTranscoder(), tracks());
  const signal = new AbortController();
  const id = (await f.recordings.list('CAM','2026-09-14',signal.signal)).recordings[0]!.id;
  let output='';
  await assert.rejects(f.recordings.video('CAM',id,signal.signal,async(result,abort)=>{
    output=result.path; assert.ok(existsSync(output)); signal.abort(); assert.ok(f.recordings.busy); abort.throwIfAborted();
  }));
  assert.ok(!existsSync(output)); assert.equal(f.recordings.busy,false);
  await assert.rejects(f.recordings.video('CAM',id,new AbortController().signal,async result=>{output=result.path;throw new Error('consumer disconnected');}));
  assert.ok(!existsSync(output)); assert.equal(f.recordings.busy,false);
});

test('authenticated HTTP streams a large recording and cancels delivery without orphaned ownership', async () => {
  const { createBridge } = await import('../src/server.js');
  const { StreamHub } = await import('../src/streams.js');
  const { EventEmitter, once } = await import('node:events');
  const { readdir } = await import('node:fs/promises');
  const f = fixture(new RecordingTranscoder('nvidia', () => {}, expanded), tracks());
  const id = (await f.recordings.list('CAM','2026-09-14',AbortSignal.timeout(20000))).recordings[0]!.id;
  const hub = new StreamHub({start:async()=>{},stop:async()=>{},disposeMedia:()=>{}});
  const fake = Object.assign(new EventEmitter(), { recordings:f.recordings, hasCamera:(s:string)=>s==='CAM', hub });
  const server = createBridge(fake as any, 't'.repeat(32), 'synthetic');
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const address=server.address(); assert.ok(address && typeof address!=='string');
  const url=`http://127.0.0.1:${address.port}/v1/recordings/CAM/${id}/video?format=auto`;
  const headers={Authorization:'Bearer '+'t'.repeat(32)};
  try {
    assert.equal((await fetch(url)).status,401); assert.equal(f.counts().downloads,0);
    const response=await fetch(url,{headers}); assert.equal(response.status,200);
    const reader=response.body!.getReader(); let bytes=0;
    while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.length;}
    assert.ok(bytes>33563861); assert.equal(bytes,Number(response.headers.get('Content-Length')));
    for(let n=0;n<100 && f.recordings.busy;n++)await new Promise(r=>setTimeout(r,10));
    assert.equal(f.recordings.busy,false); assert.equal(f.recordings.metrics.cancelled,0);
    const cancel=new AbortController();
    const interrupted=await fetch(url,{headers,signal:cancel.signal});
    assert.ok((await interrupted.body!.getReader().read()).value!.length>0);
    cancel.abort();
    for(let n=0;n<100 && f.recordings.busy;n++)await new Promise(r=>setTimeout(r,10));
    assert.equal(f.recordings.busy,false); assert.equal(f.recordings.metrics.cancelled,1);
    assert.deepEqual(await readdir(join(tmpdir(),`eufy-recording-${process.pid}`)),[]);
  } finally {server.emit('shutdown');server.closeAllConnections();server.close();await once(server,'close');}
});
