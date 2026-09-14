import { test, expect } from '@playwright/test';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
const source = await readFile(new URL('../custom_components/eufy_viewer/frontend/eufy-viewer-card.js', import.meta.url), 'utf8');
const id = 'a'.repeat(32);
let directory, mp4;
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'eufy-large-browser-'));
  const path = join(directory, 'clip.mp4');
  execFileSync('ffmpeg', ['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=15','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','3','-c:v','libx264','-preset','ultrafast','-threads','1','-b:v','160M','-minrate','160M','-maxrate','160M','-bufsize','160M','-x264-params','nal-hrd=cbr:filler=1','-c:a','aac','-movflags','+faststart',path], { timeout:15000 });
  expect((await stat(path)).size).toBeGreaterThan(33563861);
  mp4 = await readFile(path);
});
test.afterAll(async () => { mp4 = undefined; if (directory) await rm(directory, { recursive:true, force:true }); });
for (const kind of ['viewer', 'events']) {
  test(`${kind} card plays and seeks a valid MP4 larger than the reported cutoff`, async ({page}) => {
    let releases = 0;
    await page.route('http://recording-test.invalid/**', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname === '/api/eufy_viewer/events' || url.pathname === '/api/eufy_viewer/recordings/camera.front') return route.fulfill({json:{recordings:[{id,entity_id:'camera.front',start:'2026-09-14T12:00:00',end:'2026-09-14T12:00:03',thumbnail:false}],returned:1,complete:true}});
      if (url.pathname.endsWith('/playback')) return route.fulfill({json:{path:'/api/eufy_viewer/playback/'+id,url:'/api/eufy_viewer/playback/'+id+'?authSig=test',media:{source:'hevc',output:'h264',processing:'software',fallback:false}}});
      if (url.pathname.startsWith('/api/eufy_viewer/playback/')) {
        if (request.method() === 'DELETE') { releases++; return route.fulfill({status:204}); }
        const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers().range ?? '');
        const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2])+1,mp4.length) : mp4.length;
        return route.fulfill({status:range?206:200,contentType:'video/mp4',headers:{'Accept-Ranges':'bytes','Cache-Control':'no-store',...(range?{'Content-Range':`bytes ${start}-${end-1}/${mp4.length}`}:{})},body:mp4.subarray(start,end)});
      }
      return route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'});
    });
    await page.goto('http://recording-test.invalid');
    await page.addScriptTag({content:source,type:'module'});
    await page.evaluate(async kind => {
      const name = kind === 'viewer' ? 'eufy-viewer-card' : 'eufy-events-card';
      await customElements.whenDefined(name);
      URL.createObjectURL = () => { throw new Error('Recording must use its signed URL'); };
      const card = window.card = document.createElement(name);
      card.setConfig(kind === 'viewer' ? {entity:'camera.front'} : {});
      document.body.append(card);
      const connection = new EventTarget(); connection.subscribeMessage = async () => async () => {};
      card.hass = {language:'en',connection,states:{'camera.front':{state:'idle',attributes:{viewer_card:true,friendly_name:'Front'}}},fetchWithAuth:(path,init)=>fetch(path,init)};
    }, kind);
    await page.getByRole('button',{name:kind==='viewer'?'Recordings':'Show recordings',exact:true}).click();
    await page.locator(kind==='viewer'?'.record-row':'.event').first().click();
    const video = page.locator(kind==='viewer'?'.record-video':'video');
    await expect.poll(()=>video.evaluate(v=>v.videoWidth)).toBe(320);
    await expect.poll(()=>video.evaluate(v=>v.currentTime)).toBeGreaterThan(0);
    await expect(page.locator('.recording-media')).toHaveText('Software transcode');
    expect(await video.evaluate(v=>v.duration)).toBeGreaterThanOrEqual(3);
    for (const time of [2,0.5]) {
      await video.evaluate((v,time)=>{v.pause();v.currentTime=time;},time);
      await expect.poll(()=>video.evaluate(v=>v.currentTime)).toBeCloseTo(time,1);
      expect(await video.evaluate(v=>v.paused)).toBe(true);
    }
    await page.getByRole('button',{name:kind==='viewer'?'Close recordings':'Close',exact:true}).click();
    await expect.poll(()=>releases).toBe(1);
    expect(await video.getAttribute('src')).toBeNull();
  });
  test(`${kind} card reports storage exhaustion without a codec recovery retry`, async ({page}) => {
    let preparations=0;
    await page.route('http://storage-test.invalid/**',route=>{
      const url=new URL(route.request().url());
      if(url.pathname.endsWith('/playback')){preparations++;return route.fulfill({status:503,json:{error:'recording_storage_unavailable'}});}
      if(url.pathname.startsWith('/api/'))return route.fulfill({json:{recordings:[{id,entity_id:'camera.front',start:'2026-09-14T12:00:00',end:'2026-09-14T12:00:03',thumbnail:false}],returned:1,complete:true}});
      return route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'});
    });
    await page.goto('http://storage-test.invalid');await page.addScriptTag({content:source,type:'module'});
    await page.evaluate(async kind=>{
      const name=kind==='viewer'?'eufy-viewer-card':'eufy-events-card';await customElements.whenDefined(name);
      const card=document.createElement(name);card.setConfig(kind==='viewer'?{entity:'camera.front'}:{});document.body.append(card);
      card.hass={language:'en',connection:new EventTarget(),states:{'camera.front':{state:'idle',attributes:{viewer_card:true}}},fetchWithAuth:(path,init)=>fetch(path,init)};
    },kind);
    await page.getByRole('button',{name:kind==='viewer'?'Recordings':'Show recordings',exact:true}).click();
    await page.locator(kind==='viewer'?'.record-row':'.event').first().click();
    await expect(page.locator(kind==='viewer'?'.record-status':'.player-status')).toHaveText('Not enough recording storage. Close other recordings or try Native.');
    expect(preparations).toBe(1);
  });
}
