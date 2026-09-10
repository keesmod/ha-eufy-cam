import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { EufySecurity, VideoCodec, AudioCodec } from 'eufy-security-client';
import { Recordings, muxRecording } from '../src/recordings.js';

function fixture() {
  const calls: unknown[] = [];
  const station = Object.assign(new EventEmitter(), {
    p2pSession: { sendCommandWithStringPayload: () => {} },
    getSerial: () => 'BASE', isConnected: () => true, close: () => calls.push('close'),
    databaseQueryByDate: (serials: string[], start: Date, end: Date) => {
      calls.push({ serials, start, end });
      queueMicrotask(() => station.emit('database query by date', station, 0, [
        { record_id: 1, device_sn: 'CAM', station_sn: 'BASE', storage_path: '/fixture/existing.zxvideo', folder_size: 50, start_time: new Date('2026-09-05T13:14:15'), end_time: new Date('2026-09-05T13:14:20') },
        { record_id: 2, device_sn: 'OTHER', station_sn: 'BASE', storage_path: '/fixture/private.zxvideo', start_time: new Date(), end_time: new Date() },
      ]));
    },
    startDownload: async () => { calls.push('download'); }, cancelDownload: () => calls.push('cancel'),
  });
  const device = { getStationSerial: () => 'BASE', getChannel: () => 1 };
  const client = { isConnected: () => true, getDevice: async () => device, getStation: async () => station };
  return { station, calls, manager: new Recordings(() => client as unknown as EufySecurity, () => false) };
}

test('calendar query uses the verified empty-filter day interval; paths stay private and handles are camera scoped', async () => {
  const { manager, calls } = fixture(); const signal = new AbortController().signal;
  await assert.rejects(manager.list('CAM', '2026-02-31', signal)); assert.equal(calls.length, 0);
  const result = await manager.list('CAM', '2026-09-05', signal);
  assert.equal(result.recordings.length, 1); assert.equal(result.returned, 2);
  assert.equal(JSON.stringify(result).includes('zxvideo'), false);
  const call = calls[0] as {serials: string[]; start: Date; end: Date};
  assert.deepEqual(call.serials, []); assert.equal(call.start.getDate(), 5); assert.equal(call.end.getDate(), 6);
  await assert.rejects(manager.video('OTHER', result.recordings[0]!.id, signal));
  assert.equal(calls.includes('download'), false);
});

test('leaving while downloading cancels the exact device and releases the operation; no retry', async () => {
  const { manager, calls, station } = fixture(); const controller = new AbortController();
  const result = await manager.list('CAM', '2026-09-05', controller.signal);
  const downloading = manager.video('CAM', result.recordings[0]!.id, controller.signal);
  await new Promise(resolve => setImmediate(resolve)); assert.ok(calls.includes('download'));
  await assert.rejects(manager.list('CAM', '2026-09-05', controller.signal));
  controller.abort(); await assert.rejects(downloading);
  assert.equal(calls.filter(c => c === 'cancel').length, 1); assert.ok(calls.includes('close')); assert.equal(manager.busy, false);
  assert.equal(station.listenerCount('download start'), 0); assert.equal(station.listenerCount('download finish'), 0);
});

test('SDK negative response is an error, not an empty recording day', async () => {
  const { manager, station } = fixture();
  station.databaseQueryByDate = () => { station.emit('database query by date', station, -6006, []); };
  await assert.rejects(manager.list('CAM', '2026-09-05', new AbortController().signal));
  assert.equal(manager.busy, false);
});

test('real stored H264 and AAC bytes become a fully decodable browser MP4', async () => {
  const video = execFileSync('ffmpeg', ['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=15','-t','1','-c:v','libx264','-threads','1','-bf','0','-f','h264','pipe:1']);
  const audio = execFileSync('ffmpeg', ['-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t','1','-c:a','aac','-f','adts','pipe:1']);
  const mp4 = await muxRecording({ videoCodec: VideoCodec.H264, audioCodec: AudioCodec.AAC, videoFPS:15,videoWidth:320,videoHeight:180 },video,audio,new AbortController().signal);
  assert.equal(mp4.subarray(4,8).toString(),'ftyp');
  const audioInfo = JSON.parse(execFileSync('ffprobe', ['-v','error','-select_streams','a:0','-show_entries','stream=profile,channels,extradata_size','-of','json','pipe:0'], {input:mp4}).toString()).streams[0];
  assert.equal(audioInfo.profile, 'LC', 'MP4 must identify AAC before an Apple player opens it');
  assert.equal(audioInfo.channels, 1, 'AAC configuration must retain the source channel count');
  assert.ok(audioInfo.extradata_size >= 2, 'MP4 must include the AAC AudioSpecificConfig');
  execFileSync('ffmpeg',['-v','error','-i','pipe:0','-f','null','-'],{input:mp4});
  const muted = await muxRecording({ videoCodec:VideoCodec.H264,audioCodec:AudioCodec.NONE,videoFPS:15,videoWidth:320,videoHeight:180 },video,Buffer.alloc(0),new AbortController().signal);
  execFileSync('ffmpeg',['-v','error','-i','pipe:0','-f','null','-'],{input:muted});
});

test('all-camera timeline queries a shared HomeBase once and never exports raw paths', async()=>{
  const {manager,calls}=fixture();const result=await manager.timeline(['CAM','OTHER'],'2026-09-05',new AbortController().signal);
  assert.equal(calls.length,1);assert.equal(result.complete,true);assert.equal(result.recordings[0]?.serial,'CAM');assert.ok(!JSON.stringify(result).includes('storage_path'));
});
test('stored thumbnail accepts only the referenced file, validates JPEG and cleans up on abort', async()=>{
  const {manager,station}=fixture();
  const original=station.databaseQueryByDate;
  station.databaseQueryByDate=(serials,start,end)=>{station.once('database query by date',(_s,_c,rows)=>{rows[0].thumb_path='/fixture/stored.jpg';});original(serials,start,end);};
  const raw=station as typeof station & {downloadImage:(file:string)=>void};
  raw.downloadImage=file=>{assert.equal(file,'/fixture/stored.jpg');queueMicrotask(()=>{station.emit('image download',station,'/unrelated/latest.jpg',Buffer.from([255,216,255,1]));station.emit('image download',station,file,Buffer.from([255,216,255,2]));});};
  const controller=new AbortController();const result=await manager.list('CAM','2026-09-05',controller.signal);const id=result.recordings[0]!.id;
  assert.equal(result.recordings[0]!.thumbnail,true);assert.deepEqual(await manager.thumbnail('CAM',id,controller.signal),Buffer.from([255,216,255,2]));
  assert.equal(station.listenerCount('image download'),0);
  await assert.rejects(manager.thumbnail('OTHER',id,controller.signal));
  raw.downloadImage=()=>{};const pending=manager.thumbnail('CAM',id,controller.signal);await new Promise(r=>setImmediate(r));controller.abort();await assert.rejects(pending);assert.equal(station.listenerCount('image download'),0);assert.equal(manager.busy,false);
});
test('calendar validates the month and de-duplicates HomeBase-wide presence days',async()=>{
  const {manager,station}=fixture();let calls=0;
  Object.assign(station,{databaseCountByDate:()=>{calls++;queueMicrotask(()=>station.emit('database count by date',station,0,[{day:new Date('2026-09-05T00:00:00'),count:1},{day:new Date('2026-10-01T00:00:00'),count:1}]));}});
  await assert.rejects(manager.calendar(['CAM'],'2026-13',new AbortController().signal));
  assert.deepEqual(await manager.calendar(['CAM','OTHER'],'2026-09',new AbortController().signal),{days:['2026-09-05']});assert.equal(calls,1);
});


test('a malformed known-camera record cannot silently disappear from a complete day',async()=>{
  const {manager,station}=fixture();
  station.databaseQueryByDate=()=>{queueMicrotask(()=>station.emit('database query by date',station,0,[{record_id:1,device_sn:'CAM',station_sn:'BASE',storage_path:'',start_time:new Date(),end_time:new Date()}]));};
  await assert.rejects(manager.timeline(['CAM'],'2026-09-05',new AbortController().signal),/history_incomplete/);
});

test('native HEVC is losslessly remuxed as hvc1, while compatibility output is H264', async () => {
  const video = execFileSync('ffmpeg', ['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=15','-t','1','-c:v','libx265','-x265-params','pools=1:frame-threads=1:keyint=5:min-keyint=5:scenecut=0:log-level=error','-f','hevc','pipe:1']);
  const audio = execFileSync('ffmpeg', ['-v','error','-f','lavfi','-i','sine=sample_rate=16000','-t','1','-c:a','aac','-f','adts','pipe:1']);
  const metadata = { videoCodec: VideoCodec.H265, audioCodec: AudioCodec.AAC, videoFPS:15,videoWidth:320,videoHeight:180 };
  const originalFrames = execFileSync('ffmpeg',['-v','error','-r','15','-f','hevc','-i','pipe:0','-fps_mode','passthrough','-f','framemd5','-'],{input:video}).toString();
  for (const format of ['native','h264'] as const) {
    const mp4 = await muxRecording(metadata,video,audio,new AbortController().signal,format);
    const boxes: string[] = [];
    for (let at=0; at<mp4.length;) { const size=mp4.readUInt32BE(at); assert.ok(size>=8 && at+size<=mp4.length); boxes.push(mp4.toString('ascii',at+4,at+8)); at+=size; }
    assert.equal(boxes.filter(type=>type==='moof').length,1,'one complete fragment, even across multiple keyframes');
    const streams = JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-of','json','pipe:0'],{input:mp4}).toString()).streams;
    assert.equal(streams[0].codec_name, format === 'native' ? 'hevc' : 'h264');
    assert.equal(streams[0].codec_tag_string, format === 'native' ? 'hvc1' : 'avc1');
    assert.equal(streams[1].codec_name,'aac');
    assert.equal(streams[1].profile,'LC');
    assert.equal(streams[1].channels,1);
    assert.ok(streams[1].extradata_size >= 2, 'native and compatibility MP4s need AAC configuration');
    execFileSync('ffmpeg',['-v','error','-i','pipe:0','-f','null','-'],{input:mp4});
    if (format === 'native') {
      const frames = execFileSync('ffmpeg',['-v','error','-i','pipe:0','-map','0:v','-fps_mode','passthrough','-f','framemd5','-'],{input:mp4}).toString();
      const hashes = (text: string) => text.split('\n').filter(line=>line && !line.startsWith('#')).map(line=>line.split(',').at(-1)?.trim());
      assert.deepEqual(hashes(frames),hashes(originalFrames));
    }
  }
});

test('oversized remux output is rejected instead of returning a truncated playable clip', async () => {
  const sample = execFileSync('ffmpeg', ['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=15','-t','1','-c:v','libx264','-threads','1','-bf','0','-crf','0','-f','h264','pipe:1']);
  const video = Buffer.concat(Array.from({length:Math.ceil(33*1024*1024/sample.length)},()=>sample));
  await assert.rejects(muxRecording({videoCodec:VideoCodec.H264,audioCodec:AudioCodec.NONE,videoFPS:15,videoWidth:320,videoHeight:180},video,Buffer.alloc(0),new AbortController().signal,'native'),/Recording conversion failed/);
});
