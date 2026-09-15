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
import { StreamDiagnostics } from '../bridge/src/diagnostics.ts';
import { StreamHub } from '../bridge/src/streams.ts';
import { createBridge } from '../bridge/src/server.ts';

// Real FFmpeg, go2rtc, encrypted WebRTC and decoded audio/video in Chromium.
// Only Eufy hardware and Home Assistant dispatch are simulated.
const cases = [
  ...['close', 'navigation', 'frozen', 'blocked', 'media-loss', 'answer-loss', 'paint-loss', 'tick-loss'].map(ending=>({ending,profile:'normal'})),
  ...['silent', 'low-rate', 'delayed-audio', 'batched-audio', 'video-only', 'late-admission'].map(profile=>({ending:'close',profile})),
  {ending:'audio-answer-loss',profile:'late-admission'},
  ...['normal','late-admission'].map(profile=>({ending:'close',profile,iceMode:'relay'})),
  ...['relay-missing','relay-bad-auth'].map(iceMode=>({ending:'blocked',profile:'normal',iceMode})),
  {ending:'close',profile:'normal',iceMode:'unreachable'},
  {ending:'blocked',profile:'normal',reopen:true},
  {ending:'before-audio',profile:'late-admission',reopen:true},
];
for (const {ending:initialEnding,profile,iceMode='direct',reopen=false} of cases) test(`real WebRTC ${profile} stops after ${initialEnding} (${iceMode})${reopen?' and reopens':''}`, async ({ page }, testInfo) => {
  test.setTimeout(reopen ? 90000 : 60000);
  let ending = initialEnding;
  const binary = process.env.GO2RTC_BINARY;
  test.skip(!binary, 'Set GO2RTC_BINARY for the media acceptance test');
  const { stdout: jpeg } = await promisify(execFile)('ffmpeg', ['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=green:s=16x16','-frames:v','1','-f','image2pipe','-vcodec','mjpeg','pipe:1'], { encoding: 'buffer' });
  const directory = await mkdtemp(join(tmpdir(), 'eufy-rtc-'));
  const config = join(directory, 'go2rtc.yaml');
  const address = Object.values(networkInterfaces()).flat().find(a => a?.family === 'IPv4' && !a.internal)?.address;
  if (!address) throw new Error('A local network interface is required for the WebRTC fixture');
  await writeFile(config, 'api:\n  listen: "127.0.0.1:21984"\nrtsp:\n  listen: "127.0.0.1:21554"\nwebrtc:\n  listen: "'+address+':21555/tcp"\n  candidates: ["'+address+':21555"]\n  ice_servers: []\n');
  const relayOnly = iceMode.startsWith('relay');
  // Hosts can advertise several interfaces. Rewrite every candidate in both
  // directions so another interface cannot make the blocked-route test pass.
  const blockCandidates = value => value.replace(/(candidate:\S+ \d+ (?:udp|tcp) \d+ )\S+( \d+ typ)/gi, '$1192.0.2.1$2');
  const iceServers = iceMode==='unreachable' ? [{urls:['stun:192.0.2.1:3478']}] : relayOnly && iceMode!=='relay-missing' ? [{urls:[`turn:${address}:23478?transport=udp`],username:'fixture',credential:iceMode==='relay-bad-auth'?'wrong':'fixture-secret'}] : [];
  // This fixture removes all direct candidates and requires browser relay ICE.
  // Successful decoded media therefore requires the temporary TURN server.
  const relaySdp = sdp => relayOnly ? sdp.split('\r\n').filter(line=>!line.startsWith('a=candidate:')||line.includes(' typ relay')).join('\r\n') : sdp;
  const turn = relayOnly && iceMode!=='relay-missing' ? spawn(process.env.TURN_SERVER_BINARY ?? 'turnserver', ['-n','--no-cli','--no-tls','--no-tcp','--lt-cred-mech','--fingerprint','--realm=eufy-fixture',`--listening-ip=${address}`,`--relay-ip=${address}`,'--listening-port=23478','--min-port=23500','--max-port=23550','--user=fixture:fixture-secret',`--userdb=${directory}/turn.sqlite`,'--no-multicast-peers','--relay-threads=1',`--pidfile=${directory}/turn.pid`,'--log-file=stdout'], {stdio:['ignore','pipe','pipe']}) : undefined;
  let turnFailure;turn?.on('error',error=>{turnFailure=error;});
  turn?.stdout.resume();turn?.stderr.resume();
  const rtc = spawn(binary, ['-c', config], { stdio: ['ignore','pipe','pipe'] });
  let logs=''; rtc.stdout.on('data', c=>logs+=c); rtc.stderr.on('data', c=>logs+=c);
  const timers=[], reports=[], sources=[]; let timeOffset=0;
  let starts=0, stops=0, acks=0, video, audio, ticks, cameraWs, signaling, audioSignaling;
  const encoderDiagnostics = new class extends StreamDiagnostics {
    encoder(serial, kind, child) {sources.push(child);super.encoder(serial,kind,child);}
  }();
  const media = new MediaRelay(()=>hub.end('CAM123','Media failed'), encoderDiagnostics, serial => fake.emit('audio-ready',serial));
  const hub = new StreamHub({
    start: async () => {
      starts++;
      video=spawn('ffmpeg',['-hide_banner','-loglevel','error','-re','-f','lavfi','-i',profile==='low-rate'?'color=c=blue:size=1280x720:rate=10':'testsrc=size=1280x720:rate=15','-pix_fmt','yuv420p','-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-g','15','-f','h264','pipe:1']);
      sources.push(video);
      const sound = new PassThrough();
      const startAudio = () => { audio=spawn('ffmpeg',['-hide_banner','-loglevel','error','-re','-f','lavfi','-i',profile==='silent'?'anullsrc=r=16000:cl=mono':'sine=frequency=440:sample_rate=16000','-c:a','aac','-f','adts','pipe:1']);
      sources.push(audio);audio.stderr.resume();
      audio.stdout.on('data',chunk=> {
        const delay=profile==='delayed-audio'?3000:profile==='batched-audio'?Math.ceil(performance.now()/3000)*3000-performance.now():0;
        if(delay) timers.push(setTimeout(()=>sound.write(chunk),delay)); else sound.write(chunk);
      });
      };
      video.stderr.resume();
      if(profile==='late-admission') timers.push(setTimeout(startAudio,6000)); else if(profile!=='video-only') startAudio();
      media.start('CAM123','h264',video.stdout,sound,!['video-only','late-admission'].includes(profile),profile==='low-rate'?10:15); hub.started('CAM123');

      ticks=setInterval(()=>hub.frame('CAM123',jpeg),125);
    },
    stop: async()=>{stops++;hub.stopped('CAM123');},
    // A killed process can still flush stdout. Stop scheduling audio before
    // clearing its timers, otherwise a closed fixture can feed the next cycle.
    disposeMedia:()=>{audio?.stdout.removeAllListeners('data');timers.splice(0).forEach(clearTimeout);clearInterval(ticks);media.stop('CAM123');video?.kill();audio?.kill();},
  }, () => performance.now() + timeOffset);
  const fake=Object.assign(new EventEmitter(),{auth:{state:'connected'},inventory:()=>[],hasCamera:s=>s==='CAM123',pictures:new Map(),hub,media,metrics:{}});
  const server=createBridge(fake,'x'.repeat(32),'test-bridge');
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const bridgeUrl=`http://127.0.0.1:${server.address().port}`, goUrl='http://127.0.0.1:21984';
  // Match HA's ordered stream cleanup. Concurrent fixture writes can crash
  // go2rtc's stream map before the close/reopen assertions run.
  let streamChanges=Promise.resolve();
  const changeStream=(query,method)=>{
    streamChanges=streamChanges.catch(()=>{}).then(async()=>{
      const response=await fetch(goUrl+'/api/streams?'+query,{method});
      await response.arrayBuffer();
      if(!response.ok)throw new Error(`go2rtc stream ${method} failed: ${response.status}`);
    });
    return streamChanges;
  };
  const deliver=event=>page.evaluate(event=>window.receive?.(event),event).catch(()=>{});
  try {
    await expect.poll(async()=>{try{return(await fetch(goUrl+'/api')).status;}catch{return 0;}}).toBe(200);
    if(turn && (turnFailure || turn.exitCode!==null)) throw new Error('TURN fixture did not start');
    await page.route(bridgeUrl+'/fixture',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><body></body>'}));
    await page.goto(bridgeUrl+'/fixture');
    if (relayOnly) await page.evaluate(()=>{const Peer=window.RTCPeerConnection;window.RTCPeerConnection=class extends Peer {constructor(config){super({...config,iceTransportPolicy:'relay'});}};});
    const source=await readFile(new URL('../custom_components/eufy_viewer/frontend/eufy-viewer-card.js',import.meta.url),'utf8');
    await page.addScriptTag({content:source,type:'module'});
    let sequence=0, jpegMode=false;
    await page.exposeFunction('backendWatch',async()=>{
      jpegMode=false;
      cameraWs=new WebSocket(bridgeUrl+'/v1/live/CAM123?transport=webrtc&late_audio=1',{headers:{Authorization:'Bearer '+'x'.repeat(32)}});
      cameraWs.on('message',async (raw,binary)=>{
        if(binary) { await deliver({type:'frame',subscription:1,sequence:++sequence,jpeg:raw.toString('base64')}); return; }
        const message=JSON.parse(raw.toString());
        if(message.type==='ready') {
          const query=new URLSearchParams({name:'acceptance'});
          query.append('src',bridgeUrl+message.path);if(message.audio)query.append('src','ffmpeg:acceptance#audio=opus');
          await changeStream(query,'PUT');
          signaling=new WebSocket(goUrl+'/api/ws?src=acceptance');
          signaling.on('message',raw=>{
            const message=JSON.parse(raw.toString());
            if(message.type==='webrtc'&&message.value.type==='answer'&&ending!=='answer-loss')void deliver({type:'answer',sdp:relayOnly?relaySdp(message.value.sdp):ending==='blocked'?blockCandidates(message.value.sdp):message.value.sdp});
            else if(message.type==='webrtc/candidate'&&(!relayOnly||message.value.includes(' typ relay')))void deliver({type:'candidate',candidate:!relayOnly&&ending==='blocked'?blockCandidates(message.value):message.value});
            else if(message.type==='error'){console.error('go2rtc fixture:',message.value);void deliver({type:'ended'});}
          });
          await once(signaling,'open');await deliver({type:'ready',subscription:1,fallback:message.fallback,diagnostics:true,ice_servers:iceServers,ice_configuration:'home_assistant'});
        } else if(message.type==='audio_ready') {
          const query=new URLSearchParams({name:'acceptance_audio'});
          query.append('src',bridgeUrl+message.path);query.append('src','ffmpeg:acceptance_audio#audio=opus');
          await changeStream(query,'PUT');
          audioSignaling=new WebSocket(goUrl+'/api/ws?src=acceptance_audio');
          audioSignaling.on('message',raw=>{
            const message=JSON.parse(raw.toString());
            if(message.type==='webrtc'&&message.value.type==='answer'&&ending!=='audio-answer-loss')void deliver({type:'audio_answer',sdp:relaySdp(message.value.sdp)});
            else if(message.type==='webrtc/candidate'&&(!relayOnly||message.value.includes(' typ relay')))void deliver({type:'audio_candidate',candidate:message.value});
            else if(message.type==='error')void deliver({type:'audio_ended'});
          });
          await once(audioSignaling,'open');await deliver({type:'audio_ready',ice_servers:iceServers,ice_configuration:'home_assistant'});
        } else if(message.type==='fallback') {
          jpegMode=true;
          signaling?.close();
          void changeStream('src=acceptance','DELETE').catch(()=>{});
          await deliver({type:'fallback'});
        } else if(message.type==='tick')await deliver({type:'tick',subscription:1,sequence:++sequence});
      });
      await once(cameraWs,'open');
    });
    await page.exposeFunction('backendCall',async message=>{
      if(message.type==='eufy_viewer/live_diagnostics'){reports.push(message.report);}
      else if(message.type==='eufy_viewer/ack'){acks++;cameraWs.send(jpegMode?'ack:jpeg':'ack');}
      else if(message.type==='eufy_viewer/fallback')cameraWs.send('fallback:'+message.reason);
      else if(message.audio){
        if(message.stop){audioSignaling?.close();await changeStream('src=acceptance_audio','DELETE');}
        else if(message.candidate)audioSignaling.send(JSON.stringify({type:'webrtc/candidate',value:message.candidate}));
        else if(message.offer)audioSignaling.send(JSON.stringify({type:'webrtc',value:{type:'offer',sdp:message.offer,ice_servers:iceServers}}));
      }
      else if(message.candidate){
        const candidate=!relayOnly&&ending==='blocked'?blockCandidates(message.candidate):message.candidate;
        signaling.send(JSON.stringify({type:'webrtc/candidate',value:candidate}));
      }
      else if(message.offer){
        // Model a remote browser whose advertised media address is unreachable.
        // Both directions are replaced, so peer-reflexive ICE cannot bridge the fixture.
        const offer=!relayOnly&&ending==='blocked'?blockCandidates(message.offer):message.offer;
        signaling.send(JSON.stringify({type:'webrtc',value:{type:'offer',sdp:offer,ice_servers:iceServers}}));
      }
      return{accepted:true};
    });
    await page.exposeFunction('backendClose',async()=>{
      audioSignaling?.close();signaling?.close();cameraWs?.close();
      await changeStream('src=acceptance_audio','DELETE');
      await changeStream('src=acceptance','DELETE');
    });
    await page.evaluate(async()=>{
      await customElements.whenDefined('eufy-viewer-card');const connection=new EventTarget();
      connection.subscribeMessage=async callback=>{window.receive=callback;await backendWatch();return()=>backendClose();};
      const card=window.card=document.createElement('eufy-viewer-card');document.body.append(card);card.setConfig({entity:'camera.test'});
      card.hass={language:'en',connection,states:{'camera.test':{state:'idle',attributes:{friendly_name:'Test camera',viewer_card:true,viewer_webrtc:true,viewer_late_audio:true}}},callWS:backendCall};

    });
    expect(starts).toBe(0);
    for (let cycle=0;cycle<(reopen?2:1);cycle++) {
    ending=cycle?'close':initialEnding;reports.length=0;
    const expectedStarts=cycle+1, previousAcks=acks;
    await page.getByRole('button',{name:'Watch live',exact:true}).click();
    if(!['blocked','answer-loss'].includes(ending)) {
    await expect.poll(()=>page.locator('video.video').evaluate(v=>v.videoWidth),{timeout:20000}).toBe(1280);
    if(ending!=='before-audio') {
    await page.getByRole('button',{name:'Enable sound',exact:true}).click();
    expect(await page.locator('video.video').evaluate(v=>v.muted)).toBe(false);
    if(profile!=='video-only'&&ending!=='audio-answer-loss') await expect.poll(()=>page.evaluate(async silent=>[...(await (card._audioRtc??card._rtc)?.getStats())?.values()??[]].some(s=>s.type==='inbound-rtp'&&s.kind==='audio'&&s.packetsReceived>0&&(silent||s.totalAudioEnergy>0)),profile==='silent'),{timeout:10000}).toBe(true);
    } else {
      expect(media.lateAudioSupported('CAM123')).toBe(false);
      expect(await page.evaluate(()=>Boolean(card._audioRtc))).toBe(false);
    }
    await expect.poll(()=>acks).toBeGreaterThan(previousAcks+2);
    await expect.poll(()=>reports.some(r=>r.trigger==='playing'&&r.painted>0&&r.acks_accepted>0&&r.video_decoded>0)).toBe(true);
    if (iceMode==='relay') {
      const peers=await page.evaluate(async()=>Promise.all([card._rtc,...(card._audioRtc?[card._audioRtc]:[])].map(async pc=>{const stats=await pc.getStats();const pair=[...stats.values()].find(s=>s.type==='candidate-pair'&&s.state==='succeeded'&&s.nominated);return {local:stats.get(pair?.localCandidateId)?.candidateType,remote:stats.get(pair?.remoteCandidateId)?.candidateType,serverRelay: [...stats.values()].some(s=>s.type==='remote-candidate'&&s.candidateType==='relay')};})));
      expect(peers).toHaveLength(profile==='late-admission'?2:1);
      // go2rtc may nominate a peer-reflexive response through the browser's
      // relay. The browser still has no direct route and both servers gather relay.
      for(const peer of peers){expect(peer.local).toBe('relay');expect(['relay','prflx']).toContain(peer.remote);expect(peer.serverRelay).toBe(true);}
    }
    if(profile!=='normal'&&ending!=='before-audio') {
      const before=acks; await new Promise(resolve=>setTimeout(resolve,8000));
      expect(jpegMode).toBe(false);expect(acks).toBeGreaterThan(before+2);
      expect(reports.some(r=>r.trigger==='unmuted'&&r.muted===false)).toBe(true);
      // The one-second unmute report can precede a three-second audio batch.
      // Require decoded energy above and in the later audio report instead.
      if(!['silent','video-only','late-admission','batched-audio'].includes(profile))expect(reports.find(r=>r.trigger==='unmuted').audio_energy).toBe(true);
      if(['late-admission','batched-audio'].includes(profile)&&ending!=='audio-answer-loss'){await expect.poll(()=>reports.some(r=>r.trigger==='audio_check'&&r.audio_energy&&r.audio_negotiated),{timeout:10000}).toBe(true);expect(starts).toBe(expectedStarts);}
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
      if(ending==='blocked') {if(relayOnly)expect(report.relay_configured).toBe(iceMode!=='relay-missing');expect(report.answer).toBe(true);expect(report.painted).toBe(0);expect(report.acks_accepted).toBe(0);}
      if(ending==='answer-loss') {expect(report.offer).toBe(true);expect(report.answer).toBe(false);expect(report.painted).toBe(0);}
      if(ending==='paint-loss') {expect(report.last_frame_ms).toBeGreaterThan(5000);expect(report.video_decoded).toBeGreaterThan(report.painted);}
      if(ending==='tick-loss') {expect(report.last_frame_ms).toBeLessThan(1000);expect(report.painted).toBeGreaterThan(report.acks_accepted+20);ticks=setInterval(()=>hub.frame('CAM123',jpeg),125);}
      await expect(page.locator('img.live')).toBeVisible();
      await expect.poll(()=>page.locator('img.live').evaluate(v=>v.naturalWidth)).toBe(16);
      await expect(page.getByRole('button',{name:'Enable sound',exact:true})).toBeHidden();
      await expect.poll(()=>acks).toBeGreaterThan(beforeFallbackAcks+3);
      expect(starts).toBe(expectedStarts); expect(stops).toBe(cycle);
      await page.screenshot({path:testInfo.outputPath('jpeg-fallback.png')});
      await page.getByRole('button',{name:'Close live view',exact:true}).click();
    } else if (ending === 'audio-answer-loss') {
      const before=acks;
      await expect.poll(()=>page.evaluate(()=>Boolean(card._audioRtc)),{timeout:10000}).toBe(true);
      await expect.poll(()=>page.evaluate(()=>Boolean(card._audioRtc)),{timeout:20000}).toBe(false);
      expect(jpegMode).toBe(false);expect(acks).toBeGreaterThan(before+5);
      expect(starts).toBe(expectedStarts);expect(stops).toBe(cycle);
      await expect(page.locator('video.video')).toBeVisible();
      await page.getByRole('button',{name:'Close live view',exact:true}).click();
    } else if (['close','before-audio'].includes(ending)) await page.getByRole('button',{name:'Close live view',exact:true}).click();
    else if (ending === 'navigation') await page.goto('about:blank');
    else {
      await page.evaluate(() => card._video.cancelVideoFrameCallback(card._videoCallback));
      const before = acks;
      await expect.poll(() => [...hub.cameras.values()][0]?.viewers.values().next().value?.outstanding).toBe(true);
      expect(acks).toBe(before);
      timeOffset += 11000; hub.tick();
    }
    await expect.poll(()=>stops,{timeout:12000}).toBe(expectedStarts);
    await expect.poll(()=>sources.every(child=>child.exitCode!==null||child.signalCode!==null)).toBe(true);
    expect(timers).toHaveLength(0);
    if(reopen) await expect.poll(async()=>{
      await streamChanges;
      return Object.keys(await(await fetch(goUrl+'/api/streams')).json());
    }).toEqual([]);
    expect(reports.length).toBeLessThanOrEqual(5);expect(new Set(reports.map(r=>r.trigger)).size).toBe(reports.length);
    expect(JSON.stringify(reports)).not.toMatch(/candidate:|CAM123|192\.168|v1\/media|sdp/);
    expect(starts).toBe(expectedStarts);expect(hub.active).toBe(0);expect(hub.quarantined).toBe(0);
    await testInfo.attach(`playback-evidence-${cycle+1}`,{body:JSON.stringify({iceMode,starts,stops,active:hub.active,quarantined:hub.quarantined,reports},null,2),contentType:'application/json'});
    if (['close','before-audio'].includes(ending)) expect(await page.locator('video.video').evaluate(v=>v.srcObject)).toBeNull();
    }
  }catch(error){console.error('TURN fixture status:',{exitCode:turn?.exitCode,startFailed:Boolean(turnFailure)});console.error('ICE fixture reports:',JSON.stringify(reports));console.error(logs.replace(/https?:\/\/[^\s"]+/g,'[fixture-url]'));throw error;}
  finally{turn?.kill();timers.forEach(clearTimeout);cameraWs?.terminate();audioSignaling?.terminate();signaling?.terminate();hub.close();media.stop('CAM123');server.emit('shutdown');server.closeAllConnections();server.close();rtc.kill();video?.kill();audio?.kill();clearInterval(ticks);await rm(directory,{recursive:true,force:true});}
});
