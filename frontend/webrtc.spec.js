import { test, expect } from '@playwright/test';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { WebSocket } from '../bridge/node_modules/ws/wrapper.mjs';
import { MediaRelay } from '../bridge/src/media.ts';
import { StreamHub } from '../bridge/src/streams.ts';
import { createBridge } from '../bridge/src/server.ts';

// Real FFmpeg, go2rtc, encrypted WebRTC and decoded audio/video in Chromium.
// Only Eufy hardware and Home Assistant dispatch are simulated.
const cases = [
  ...['close', 'navigation', 'frozen', 'blocked', 'media-loss', 'answer-loss', 'paint-loss', 'tick-loss'].map(ending=>({ending,profile:'normal'})),
  ...['silent', 'low-rate', 'delayed-audio', 'batched-audio', 'video-only'].map(profile=>({ending:'close',profile})),
];
for (const {ending,profile} of cases) test(`real WebRTC ${profile} stops after ${ending}`, async ({ page }, testInfo) => {
  test.setTimeout(60000);
  const binary = process.env.GO2RTC_BINARY;
  test.skip(!binary, 'Set GO2RTC_BINARY for the media acceptance test');
  const { stdout: jpeg } = await promisify(execFile)('ffmpeg', ['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=green:s=16x16','-frames:v','1','-f','image2pipe','-vcodec','mjpeg','pipe:1'], { encoding: 'buffer' });
  const directory = await mkdtemp(join(tmpdir(), 'eufy-rtc-'));
  const config = join(directory, 'go2rtc.yaml');
  const address = Object.values(networkInterfaces()).flat().find(a => a?.family === 'IPv4' && !a.internal)?.address;
  if (!address) throw new Error('A local network interface is required for the WebRTC fixture');
  await writeFile(config, 'api:\n  listen: "127.0.0.1:21984"\nrtsp:\n  listen: "127.0.0.1:21554"\nwebrtc:\n  listen: "'+address+':21555"\n  candidates: ["'+address+':21555"]\n  ice_servers: []\n');
  const rtc = spawn(binary, ['-c', config], { stdio: ['ignore','pipe','pipe'] });
  let logs=''; rtc.stdout.on('data', c=>logs+=c); rtc.stderr.on('data', c=>logs+=c);
  const timers=[], reports=[]; let timeOffset=0;
  let starts=0, stops=0, acks=0, video, audio, ticks, cameraWs, signaling;
  const media = new MediaRelay(()=>hub.end('CAM123','Media failed'));
  const hub = new StreamHub({
    start: async () => {
      starts++;
      video=spawn('ffmpeg',['-hide_banner','-loglevel','error','-re','-f','lavfi','-i',profile==='low-rate'?'color=c=blue:size=1280x720:rate=10':'testsrc=size=1280x720:rate=15','-pix_fmt','yuv420p','-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-g','15','-f','h264','pipe:1']);
      audio=spawn('ffmpeg',['-hide_banner','-loglevel','error','-re','-f','lavfi','-i',profile==='silent'?'anullsrc=r=16000:cl=mono':'sine=frequency=440:sample_rate=16000','-c:a','aac','-f','adts','pipe:1']);
      video.stderr.resume(); audio.stderr.resume();
      const sound = new PassThrough();
      audio.stdout.on('data',chunk=> {
        const delay=profile==='delayed-audio'?3000:profile==='batched-audio'?Math.ceil(performance.now()/3000)*3000-performance.now():0;
        if(delay) timers.push(setTimeout(()=>sound.write(chunk),delay)); else sound.write(chunk);
      });
      media.start('CAM123','h264',video.stdout,sound,profile!=='video-only',profile==='low-rate'?10:15); hub.started('CAM123');

      ticks=setInterval(()=>hub.frame('CAM123',jpeg),125);
    },
    stop: async()=>{stops++;hub.stopped('CAM123');},
    disposeMedia:()=>{clearInterval(ticks);media.stop('CAM123');video?.kill();audio?.kill();},
  }, () => performance.now() + timeOffset);
  const fake=Object.assign(new EventEmitter(),{auth:{state:'connected'},inventory:()=>[],hasCamera:s=>s==='CAM123',pictures:new Map(),hub,media,metrics:{}});
  const server=createBridge(fake,'x'.repeat(32),'test-bridge');
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const bridgeUrl=`http://127.0.0.1:${server.address().port}`, goUrl='http://127.0.0.1:21984';
  const deliver=event=>page.evaluate(event=>window.receive?.(event),event).catch(()=>{});
  try {
    await expect.poll(async()=>{try{return(await fetch(goUrl+'/api')).status;}catch{return 0;}}).toBe(200);
    await page.route(bridgeUrl+'/fixture',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><body></body>'}));
    await page.goto(bridgeUrl+'/fixture');
    const source=await readFile(new URL('../custom_components/eufy_viewer/frontend/eufy-viewer-card.js',import.meta.url),'utf8');
    await page.addScriptTag({content:source,type:'module'});
    let sequence=0, jpegMode=false;
    await page.exposeFunction('backendWatch',async()=>{
      cameraWs=new WebSocket(bridgeUrl+'/v1/live/CAM123?transport=webrtc',{headers:{Authorization:'Bearer '+'x'.repeat(32)}});
      cameraWs.on('message',async (raw,binary)=>{
        if(binary) { await deliver({type:'frame',subscription:1,sequence:++sequence,jpeg:raw.toString('base64')}); return; }
        const message=JSON.parse(raw.toString());
        if(message.type==='ready') {
          const query=new URLSearchParams({name:'acceptance'});
          query.append('src',bridgeUrl+message.path);if(profile!=='video-only')query.append('src','ffmpeg:acceptance#audio=opus');
          await fetch(goUrl+'/api/streams?'+query,{method:'PUT'});
          signaling=new WebSocket(goUrl+'/api/ws?src=acceptance');
          signaling.on('message',raw=>{
            const message=JSON.parse(raw.toString());
            if(message.type==='webrtc'&&message.value.type==='answer'&&ending!=='answer-loss')void deliver({type:'answer',sdp:ending==='blocked'?message.value.sdp.replaceAll(address,'192.0.2.1'):message.value.sdp});
            else if(message.type==='webrtc/candidate')void deliver({type:'candidate',candidate:ending==='blocked'?message.value.replaceAll(address,'192.0.2.1'):message.value});
            else if(message.type==='error'){console.error('go2rtc fixture:',message.value);void deliver({type:'ended'});}
          });
          await once(signaling,'open');await deliver({type:'ready',subscription:1,fallback:message.fallback,diagnostics:true});
        } else if(message.type==='fallback') {
          jpegMode=true;
          signaling?.close();
          void fetch(goUrl+'/api/streams?src=acceptance',{method:'DELETE'}).catch(()=>{});
          await deliver({type:'fallback'});
        } else if(message.type==='tick')await deliver({type:'tick',subscription:1,sequence:++sequence});
      });
      await once(cameraWs,'open');
    });
    await page.exposeFunction('backendCall',async message=>{
      if(message.type==='eufy_viewer/live_diagnostics'){reports.push(message.report);}
      else if(message.type==='eufy_viewer/ack'){acks++;cameraWs.send(jpegMode?'ack:jpeg':'ack');}
      else if(message.type==='eufy_viewer/fallback')cameraWs.send('fallback:'+message.reason);
      else if(message.offer){
        // Model a remote browser whose advertised media address is unreachable.
        // Both directions are replaced, so peer-reflexive ICE cannot bridge the fixture.
        const offer=ending==='blocked'?message.offer.replace(/(a=candidate:[^\r\n]*? )(?:[0-9.]+|[a-zA-Z0-9-]+\.local)( \d+ typ)/g,'$1192.0.2.2$2'):message.offer;
        signaling.send(JSON.stringify({type:'webrtc',value:{type:'offer',sdp:offer,ice_servers:[]}}));
      }
      return{accepted:true};
    });
    await page.exposeFunction('backendClose',()=>{signaling?.close();cameraWs?.close();});
    await page.evaluate(async()=>{
      await customElements.whenDefined('eufy-viewer-card');const connection=new EventTarget();
      connection.subscribeMessage=async callback=>{window.receive=callback;await backendWatch();return()=>backendClose();};
      const card=window.card=document.createElement('eufy-viewer-card');document.body.append(card);card.setConfig({entity:'camera.test'});
      card.hass={language:'en',connection,states:{'camera.test':{state:'idle',attributes:{friendly_name:'Test camera',viewer_card:true,viewer_webrtc:true}}},callWS:backendCall};

    });
    expect(starts).toBe(0);
    await page.getByRole('button',{name:'Watch live',exact:true}).click();
    if(!['blocked','answer-loss'].includes(ending)) {
    await expect.poll(()=>page.locator('video.video').evaluate(v=>v.videoWidth),{timeout:20000}).toBe(1280);
    await page.getByRole('button',{name:'Enable sound',exact:true}).click();
    expect(await page.locator('video.video').evaluate(v=>v.muted)).toBe(false);
    if(profile!=='video-only') await expect.poll(()=>page.evaluate(async silent=>[...(await card._rtc?.getStats())?.values()??[]].some(s=>s.type==='inbound-rtp'&&s.kind==='audio'&&s.packetsReceived>0&&(silent||s.totalAudioEnergy>0)),profile==='silent'),{timeout:10000}).toBe(true);
    await expect.poll(()=>acks).toBeGreaterThan(2);
    await expect.poll(()=>reports.some(r=>r.trigger==='playing'&&r.painted>0&&r.acks_accepted>0&&r.video_decoded>0)).toBe(true);
    if(profile!=='normal') {
      const before=acks; await new Promise(resolve=>setTimeout(resolve,8000));
      expect(jpegMode).toBe(false);expect(acks).toBeGreaterThan(before+2);
    }
    }
    if(['blocked','answer-loss','media-loss','paint-loss','tick-loss'].includes(ending)) {
      const beforeFallbackAcks=acks;
      if(ending==='media-loss')rtc.kill();
      if(ending==='paint-loss')await page.evaluate(()=>card._video.cancelVideoFrameCallback(card._videoCallback));
      if(ending==='tick-loss')clearInterval(ticks);
      await expect(page.locator('dialog .live-status')).toHaveText('Live video without sound',{timeout:20000});
      await expect.poll(()=>reports.some(r=>r.trigger==='fallback')).toBe(true);
      const report=reports.find(r=>r.trigger==='fallback');
      if(ending==='blocked') {expect(report.answer).toBe(true);expect(report.painted).toBe(0);expect(report.acks_accepted).toBe(0);}
      if(ending==='answer-loss') {expect(report.offer).toBe(true);expect(report.answer).toBe(false);expect(report.painted).toBe(0);}
      if(ending==='paint-loss') {expect(report.last_frame_ms).toBeGreaterThan(5000);expect(report.video_decoded).toBeGreaterThan(report.painted);}
      if(ending==='tick-loss') {expect(report.last_frame_ms).toBeLessThan(1000);expect(report.painted).toBeGreaterThan(report.acks_accepted+20);ticks=setInterval(()=>hub.frame('CAM123',jpeg),125);}
      await expect(page.locator('img.live')).toBeVisible();
      await expect.poll(()=>page.locator('img.live').evaluate(v=>v.naturalWidth)).toBe(16);
      await expect(page.getByRole('button',{name:'Enable sound',exact:true})).toBeHidden();
      await expect.poll(()=>acks).toBeGreaterThan(beforeFallbackAcks+3);
      expect(starts).toBe(1); expect(stops).toBe(0);
      await page.screenshot({path:testInfo.outputPath('jpeg-fallback.png')});
      await page.getByRole('button',{name:'Close live view',exact:true}).click();
    } else if (ending === 'close') await page.getByRole('button',{name:'Close live view',exact:true}).click();
    else if (ending === 'navigation') await page.goto('about:blank');
    else {
      await page.evaluate(() => card._video.cancelVideoFrameCallback(card._videoCallback));
      const before = acks;
      await expect.poll(() => [...hub.cameras.values()][0]?.viewers.values().next().value?.outstanding).toBe(true);
      expect(acks).toBe(before);
      timeOffset += 11000; hub.tick();
    }
    await expect.poll(()=>stops,{timeout:12000}).toBe(1);
    expect(reports.length).toBeLessThanOrEqual(3);expect(new Set(reports.map(r=>r.trigger)).size).toBe(reports.length);
    expect(JSON.stringify(reports)).not.toMatch(/candidate:|CAM123|192\.168|v1\/media|sdp/);
    expect(starts).toBe(1);expect(hub.active).toBe(0);expect(hub.quarantined).toBe(0);
    if (ending === 'close') expect(await page.locator('video.video').evaluate(v=>v.srcObject)).toBeNull();
  }catch(error){console.error(logs.replace(/https?:\/\/[^\s"]+/g,'[fixture-url]'));throw error;}
  finally{timers.forEach(clearTimeout);cameraWs?.terminate();signaling?.terminate();hub.close();media.stop('CAM123');server.emit('shutdown');server.closeAllConnections();server.close();rtc.kill();video?.kill();audio?.kill();clearInterval(ticks);await rm(directory,{recursive:true,force:true});}
});
