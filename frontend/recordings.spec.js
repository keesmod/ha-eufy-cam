import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const source = await readFile(new URL('../custom_components/eufy_viewer/frontend/eufy-viewer-card.js', import.meta.url), 'utf8');
const mp4 = execFileSync('ffmpeg', ['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=15','-t','2','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-movflags','frag_keyframe+empty_moov','-f','mp4','pipe:1']);
const id = 'a'.repeat(32);
test.beforeEach(async ({ page }) => {
  await page.route('http://eufy-test.invalid/**', route => {
    const url = route.request().url();
    if (url.includes('/api/eufy_viewer/')) {
      if (new URL(url).pathname.endsWith('/playback')) return route.fulfill({json:{path:'/api/eufy_viewer/playback/'+id,url:'/api/eufy_viewer/playback/'+id+'?authSig=test'}});
      if (url.includes('/api/eufy_viewer/playback/')) return route.request().method()==='DELETE' ? route.fulfill({status:204}) : route.fulfill({contentType:'video/mp4',headers:{'Accept-Ranges':'bytes'},body:mp4});
      return route.fulfill({json:{recordings:[{id,start:'2026-09-05T12:06:33',end:'2026-09-05T12:06:40'}],returned:1}});
    }
    return route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'});
  });
  await page.goto('http://eufy-test.invalid');
  await page.addScriptTag({ content: source.replace('export class EufyViewerCard','class EufyViewerCard'), type:'module' });
  await page.evaluate(async () => {
    HTMLVideoElement.prototype.canPlayType=()=>'';
    await customElements.whenDefined('eufy-viewer-card'); window.starts = 0; window.urls = []; window.released=[]; URL.createObjectURL=()=>{throw new Error('Native recording playback must not use blobs');};
    const connection = new EventTarget(); connection.subscribeMessage = async () => { starts++; return async () => {}; };
    const card = window.card = document.createElement('eufy-viewer-card');document.body.append(card);card.setConfig({entity:'camera.front'});
    card.hass={language:'en',connection,states:{'camera.front':{state:'idle',attributes:{viewer_card:true,friendly_name:'Front'}}},fetchWithAuth:(path,init)=>{urls.push(path);if(init?.method==='DELETE')released.push(path);return fetch(path,init);}};
  });
});

test('date-scoped stored clip actually plays, then close clears media with no live camera start', async ({ page }) => {
  expect(await page.evaluate(()=>urls.length)).toBe(0);
  await page.getByRole('button',{name:'Recordings',exact:true}).click();
  await expect(page.locator('.record-row')).toHaveCount(1);
  await page.locator('input[type=date]').fill('2026-09-05');
  await page.getByRole('button',{name:'Show recordings',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>urls.at(-1))).toBe('/api/eufy_viewer/recordings/camera.front?date=2026-09-05');
  await page.locator('.record-row').click();
  await expect.poll(()=>page.locator('.record-video').evaluate(v=>v.videoWidth)).toBe(320);
  await expect.poll(()=>page.locator('.record-video').evaluate(v=>v.currentTime)).toBeGreaterThan(0);
  await page.getByRole('button',{name:'Close recordings',exact:true}).click();
  await expect(page.locator('.record-dialog')).not.toBeVisible();
  expect(await page.locator('.record-video').getAttribute('src')).toBeNull();
  await expect.poll(()=>page.evaluate(()=>released.length)).toBe(1);
  expect(await page.evaluate(()=>starts)).toBe(0);
});

test('leaving during media preparation aborts the request and cannot reopen a late player', async ({ page }) => {
  await page.getByRole('button',{name:'Recordings',exact:true}).click();await expect(page.locator('.record-row')).toHaveCount(1);
  await page.evaluate(()=>{
    window.aborts=0;
    card._hass.fetchWithAuth=(_path,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{aborts++;reject(new DOMException('Aborted','AbortError'));}));
  });
  await page.locator('.record-row').click();
  await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));
  await expect.poll(()=>page.evaluate(()=>aborts)).toBe(1);
  await expect(page.locator('.record-dialog')).not.toBeVisible();
  expect(await page.evaluate(()=>starts)).toBe(0);
});

test('stop recovery message distinguishes closed viewers from active viewers', async ({ page }) => {
  await page.route('**/api/eufy_viewer/**', route => route.fulfill({status:409,json:{error:'live_stopping'}}));
  await page.getByRole('button',{name:'Recordings',exact:true}).click();
  await expect(page.locator('.record-status')).toHaveText('The previous live session is still stopping. Wait a moment and load the date again.');
  await page.route('**/api/eufy_viewer/**', route => route.fulfill({status:409,json:{error:'secret token'}}));
  await page.getByRole('button',{name:'Show recordings',exact:true}).click();
  await expect(page.locator('.record-status')).toHaveText('HomeBase recording unavailable. Load the date again.');
});

 test('failed native video reports an error and releases the prepared recording', async ({page})=>{
  await page.route('**/api/eufy_viewer/playback/*?authSig=*',r=>r.fulfill({status:404}));
  await page.getByRole('button',{name:'Recordings',exact:true}).click();
  await page.locator('.record-row').click();
  await expect(page.locator('.record-status')).toHaveText('HomeBase recording unavailable. Load the date again.');
  await expect.poll(()=>page.evaluate(()=>released.length)).toBe(1);
  expect(await page.locator('.record-video').getAttribute('src')).toBeNull();
 });
 test('a late prepared response after closing is released and cannot attach media',async({page})=>{
  await page.getByRole('button',{name:'Recordings',exact:true}).click();
  await page.evaluate(()=>{
   const original=card._hass.fetchWithAuth;
   card._hass.fetchWithAuth=(path,init)=>init?.method==='POST'?new Promise(resolve=>{window.complete=()=>resolve(new Response(JSON.stringify({path:'/api/eufy_viewer/playback/'+'a'.repeat(32),url:'/api/eufy_viewer/playback/'+'a'.repeat(32)+'?authSig=test'})));}):original(path,init);
  });
  await page.locator('.record-row').click();await expect.poll(()=>page.evaluate(()=>!!window.complete)).toBe(true);
  await page.getByRole('button',{name:'Close recordings',exact:true}).click();
  await page.evaluate(()=>complete());await expect.poll(()=>page.evaluate(()=>released.length)).toBe(1);
  expect(await page.locator('.record-video').getAttribute('src')).toBeNull();
 });

 test('a stalled native load times out and releases its media',async({page})=>{
  await page.route('**/api/eufy_viewer/playback/*?authSig=*',()=>{});
  await page.evaluate(()=>{const timer=window.setTimeout;window.setTimeout=(fn,delay,...args)=>timer(fn,delay===20000?50:delay,...args);});
  await page.getByRole('button',{name:'Recordings',exact:true}).click();
  await page.locator('.record-row').click();
  await expect(page.locator('.record-status')).toHaveText('HomeBase recording unavailable. Load the date again.');
  await expect.poll(()=>page.evaluate(()=>released.length)).toBe(1);
  expect(await page.locator('.record-video').getAttribute('src')).toBeNull();
 });

test('a capable native player requests the original codec and releases it on close',async({page})=>{
  await page.evaluate(()=>{HTMLVideoElement.prototype.canPlayType=()=>'probably';});
  await page.getByRole('button',{name:'Recordings',exact:true}).click();
  await page.locator('.record-row').click();
  await expect.poll(()=>page.locator('.record-video').evaluate(v=>v.currentTime)).toBeGreaterThan(0);
  expect(await page.evaluate(()=>urls.filter(p=>p.includes('/playback?format=native')).length)).toBe(1);
  await page.getByRole('button',{name:'Close recordings',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>released.length)).toBe(1);
});

for(const code of [2,3,4]) test(`native media error ${code}: retry only decoding or unsupported codec`,async({page})=>{
  await page.evaluate(code=>{
    HTMLVideoElement.prototype.canPlayType=()=>'probably';
    const original=card._recordPlayback.load.bind(card._recordPlayback);
    let count=0;
    card._recordPlayback.load=(video,url,signal)=>{
      if(count++>0)return original(video,url,signal);
      Object.defineProperty(video,'error',{configurable:true,value:{code}});
      const promise=original(video,url,signal);
      video.dispatchEvent(new Event('error'));
      delete video.error;
      return promise;
    };
  },code);
  await page.getByRole('button',{name:'Recordings',exact:true}).click();
  await page.locator('.record-row').click();
  if(code===2) await expect(page.locator('.record-status')).toHaveText('HomeBase recording unavailable. Load the date again.');
  else await expect.poll(()=>page.locator('.record-video').evaluate(v=>v.currentTime)).toBeGreaterThan(0);
  const requests=await page.evaluate(()=>urls.filter(p=>p.includes('/playback')&&!p.includes('/api/eufy_viewer/playback/')));
  expect(requests.length).toBe(code===2?1:2);
  expect(requests[0]).toContain('?format=native');
  if(code!==2)expect(requests[1]).not.toContain('?format=');
  expect(await page.evaluate(()=>released.length)).toBe(1);
  expect(await page.evaluate(()=>starts)).toBe(0);
});

for (const code of [2,3,4]) test(`late media error ${code} handles recovery once and preserves pause and position`,async({page})=>{
  await page.evaluate(()=>{HTMLVideoElement.prototype.canPlayType=()=>'probably';});
  await page.getByRole('button',{name:'Recordings',exact:true}).click();
  await page.locator('.record-row').click();
  await expect.poll(()=>page.locator('.record-video').evaluate(v=>v.currentTime)).toBeGreaterThan(0);
  await expect.poll(()=>page.locator('.record-video').evaluate(v=>v.currentTime)).toBeGreaterThan(0.7);
  await page.locator('.record-video').evaluate((v,code)=>{
    v.pause();window.resumePosition=v.currentTime;
    Object.defineProperty(v,'error',{configurable:true,value:{code}});
    v.dispatchEvent(new Event('error'));v.dispatchEvent(new Event('error'));delete v.error;
  },code);
  if(code===2) {
    await expect(page.locator('.record-status')).toContainText('unavailable');
    expect(await page.evaluate(()=>urls.filter(p=>p.includes('/recordings/')&&p.includes('/playback')).length)).toBe(1);
  } else {
    await expect.poll(()=>page.evaluate(()=>urls.filter(p=>p.includes('/recordings/')&&p.includes('/playback')).length)).toBe(2);
    await expect(page.locator('.record-status')).toHaveText('');
    await expect.poll(()=>page.locator('.record-video').evaluate(v=>v.paused&&Math.abs(v.currentTime-window.resumePosition)<0.1)).toBe(true);
    await page.locator('.record-video').evaluate(v=>{
      Object.defineProperty(v,'error',{configurable:true,value:{code:3}});
      v.dispatchEvent(new Event('error'));delete v.error;
    });
    await expect(page.locator('.record-status')).toContainText('unavailable');
    expect(await page.evaluate(()=>urls.filter(p=>p.includes('/recordings/')&&p.includes('/playback')).length)).toBe(2);
  }
  await expect.poll(()=>page.evaluate(()=>released.length)).toBe(code===2?1:2);
  expect(await page.locator('.record-video').getAttribute('src')).toBeNull();
});

test('closing during late recovery releases a late response without reopening playback',async({page})=>{
  await page.evaluate(()=>{HTMLVideoElement.prototype.canPlayType=()=>'probably';});
  await page.getByRole('button',{name:'Recordings',exact:true}).click();
  await page.locator('.record-row').click();
  await expect.poll(()=>page.locator('.record-video').evaluate(v=>v.currentTime)).toBeGreaterThan(0);
  await page.evaluate(()=>{
    const original=card._hass.fetchWithAuth;
    card._hass.fetchWithAuth=(path,init)=>init?.method==='POST'?new Promise(resolve=>{window.complete=()=>resolve(new Response(JSON.stringify({path:'/api/eufy_viewer/playback/'+'a'.repeat(32),url:'/api/eufy_viewer/playback/'+'a'.repeat(32)+'?authSig=test'})));}):original(path,init);
    const v=card._recordVideo;Object.defineProperty(v,'error',{configurable:true,value:{code:3}});
    v.dispatchEvent(new Event('error'));delete v.error;
  });
  await expect.poll(()=>page.evaluate(()=>!!window.complete)).toBe(true);
  await expect(page.locator('.record-status')).toContainText('Preparing');
  await page.getByRole('button',{name:'Close recordings',exact:true}).click();
  await page.evaluate(()=>complete());
  await expect.poll(()=>page.evaluate(()=>released.length)).toBe(2);
  expect(await page.locator('.record-video').getAttribute('src')).toBeNull();
  await expect(page.locator('.record-dialog')).not.toBeVisible();
});

test('a new recording survives an old recovery response arriving late',async({page})=>{
  await page.evaluate(()=>{HTMLVideoElement.prototype.canPlayType=()=>'probably';});
  await page.getByRole('button',{name:'Recordings',exact:true}).click();
  await page.locator('.record-row').click();
  await expect.poll(()=>page.locator('.record-video').evaluate(v=>v.currentTime)).toBeGreaterThan(0);
  await page.evaluate(()=>{
    const original=card._hass.fetchWithAuth;let delayed=false;
    card._hass.fetchWithAuth=(path,init)=>init?.method==='POST'&&!delayed?(delayed=true,new Promise(resolve=>{window.complete=()=>resolve(new Response(JSON.stringify({path:'/api/eufy_viewer/playback/'+'b'.repeat(32),url:'/api/eufy_viewer/playback/'+'b'.repeat(32)+'?authSig=test'})));})):original(path,init);
    const v=card._recordVideo;Object.defineProperty(v,'error',{configurable:true,value:{code:3}});v.dispatchEvent(new Event('error'));delete v.error;
  });
  await expect.poll(()=>page.evaluate(()=>!!window.complete)).toBe(true);
  await page.locator('.record-row').click();
  await expect.poll(()=>page.locator('.record-video').evaluate(v=>v.currentTime)).toBeGreaterThan(0);
  await page.evaluate(()=>complete());
  await expect.poll(()=>page.evaluate(()=>released.some(p=>p.endsWith('b'.repeat(32))))).toBe(true);
  await expect(page.locator('.record-status')).toHaveText('');
  expect(await page.locator('.record-video').getAttribute('src')).toContain('a'.repeat(32));
  await page.getByRole('button',{name:'Close recordings',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>released.length)).toBe(3);
});
