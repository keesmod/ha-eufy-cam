import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const source=await readFile(new URL('../custom_components/eufy_viewer/frontend/eufy-viewer-card.js',import.meta.url),'utf8');
const mp4=execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=15','-t','2','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-movflags','frag_keyframe+empty_moov','-f','mp4','pipe:1']);
const jpeg=execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=teal:s=320x180','-frames:v','1','-f','image2pipe','pipe:1']);
const rows=Array.from({length:105},(_,i)=>({id:(i+1).toString(16).padStart(32,'0'),entity_id:i%2?'camera.garden':'camera.front',start:`2026-09-05T12:${String(Math.floor(i/60)).padStart(2,'0')}:${String(i%60).padStart(2,'0')}`,end:'2026-09-05T12:03:00',thumbnail:true}));
test.beforeEach(async({page})=>{
 await page.route('http://events-test.invalid/**',route=>{const url=new URL(route.request().url());if(url.pathname==='/api/eufy_viewer/events')return route.fulfill({json:url.searchParams.has('month')?{days:['2026-09-01','2026-09-05'],scope:'homebase'}:{recordings:rows,complete:true}});if(url.pathname.endsWith('/thumbnail'))return route.fulfill({contentType:'image/jpeg',body:jpeg});if(url.pathname.endsWith('/playback')){const id=url.pathname.split('/').at(-2);return route.fulfill({json:{path:'/api/eufy_viewer/playback/'+id,url:'/api/eufy_viewer/playback/'+id+'?authSig=test'}});}if(url.pathname.startsWith('/api/eufy_viewer/playback/'))return route.request().method()==='DELETE'?route.fulfill({status:204}):route.fulfill({contentType:'video/mp4',body:mp4});return route.fulfill({contentType:'text/html',body:'<!doctype html><html><body style="margin:0;max-width:900px"></body></html>'});});
 await page.goto('http://events-test.invalid');await page.addScriptTag({content:source,type:'module'});
 await page.evaluate(async()=>{await customElements.whenDefined('eufy-events-card');window.urls=[];window.released=[];const create=URL.createObjectURL;URL.createObjectURL=blob=>{if(blob.type==='video/mp4')throw new Error('Video blobs unsupported');return create(blob);};window.card=document.createElement('eufy-events-card');card.setConfig({});document.body.append(card);card.hass={language:'en',connection:new EventTarget(),states:{'camera.front':{state:'idle',attributes:{viewer_card:true,friendly_name:'Front'}},'camera.garden':{state:'idle',attributes:{viewer_card:true,friendly_name:'Garden'}}},fetchWithAuth:(path,init)=>{urls.push(path);if(init?.method==='DELETE')released.push(path);return fetch(path,init);}};});
});
test('105 events, camera filter, bounded previews, marked calendar and adjacent real playback',async({page})=>{
 expect(await page.evaluate(()=>urls)).toEqual([]);
 await page.getByRole('button',{name:'Show recordings',exact:true}).click();
 await expect(page.locator('.status')).toContainText('105 recordings');await expect(page.locator('.event')).toHaveCount(12);await expect(page.locator('.preview img')).toHaveCount(12);expect(await page.locator('.preview').first().evaluate(e=>Math.abs(e.getBoundingClientRect().width/e.getBoundingClientRect().height-16/9))).toBeLessThan(.03);
 expect((await page.evaluate(()=>urls)).filter(u=>u.includes('thumbnail')).length).toBe(12);
 await page.locator('.camera').selectOption('camera.garden');await expect(page.locator('.status')).toContainText('52 recordings');await expect(page.locator('.camera-name').first()).toHaveText('Garden');
 await page.getByRole('button',{name:'Next page',exact:true}).click();await expect(page.locator('.page-info')).toHaveText('2 / 5');
 await page.locator('summary').click();await page.locator('.month').fill('2026-09');await expect(page.locator('.marked')).toHaveCount(2);
 await page.locator('.event').first().click();await expect.poll(()=>page.locator('video').evaluate(v=>v.videoWidth)).toBe(320);await expect.poll(()=>page.locator('video').evaluate(v=>v.currentTime)).toBeGreaterThan(0);
 const title=await page.locator('.player-title').textContent();await page.getByRole('button',{name:'Next recording',exact:true}).click();await expect(page.locator('.player-title')).not.toHaveText(title);await expect.poll(()=>page.locator('video').evaluate(v=>v.videoWidth)).toBe(320);
 await page.getByRole('button',{name:'Close',exact:true}).click();expect(await page.locator('video').getAttribute('src')).toBeNull();await expect.poll(()=>page.evaluate(()=>released.length)).toBe(2);expect((await page.evaluate(()=>urls)).some(u=>u.includes('/live')||u.includes('/snapshot'))).toBe(false);
});
test('leaving cancels a thumbnail and no hidden requests or media can resume',async({page})=>{
 await page.evaluate(()=>{window.aborts=0;const original=card.ha.fetchWithAuth;card.ha.fetchWithAuth=(path,init)=>path.endsWith('/thumbnail')?new Promise((_resolve,reject)=>{window.pending=true;init.signal.addEventListener('abort',()=>{aborts++;reject(new DOMException('Aborted','AbortError'));});}):original(path,init);});
 await page.getByRole('button',{name:'Show recordings',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.pending)).toBe(true);await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));await expect.poll(()=>page.evaluate(()=>aborts)).toBe(1);await expect(page.locator('dialog')).not.toBeVisible();
 const count=await page.evaluate(()=>urls.length);await page.waitForTimeout(900);expect(await page.evaluate(()=>urls.length)).toBe(count);
});
test('incomplete history is not displayed as a successful empty day',async({page})=>{
 await page.route('**/api/eufy_viewer/events?**',r=>r.fulfill({status:503,json:{error:'history_incomplete'}}));await page.getByRole('button',{name:'Show recordings',exact:true}).click();await expect(page.locator('.status')).toContainText('complete day could not be confirmed');await expect(page.locator('.event')).toHaveCount(0);
});
test('mobile layout stays within the screen',async({page})=>{
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Show recordings',exact:true}).click();await expect(page.locator('.event')).toHaveCount(12);expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(390);
});

test('events player recovers a late codec error once and reports a repeated failure',async({page})=>{
 await page.evaluate(()=>{HTMLVideoElement.prototype.canPlayType=()=>'probably';});
 await page.getByRole('button',{name:'Show recordings',exact:true}).click();
 await page.locator('.event').first().click();
 await expect.poll(()=>page.locator('video').evaluate(v=>v.currentTime)).toBeGreaterThan(0);
 const fail=()=>page.locator('video').evaluate(v=>{Object.defineProperty(v,'error',{configurable:true,value:{code:3}});v.dispatchEvent(new Event('error'));delete v.error;});
 await fail();
 await expect.poll(()=>page.evaluate(()=>urls.filter(p=>p.includes('/recordings/')&&p.includes('/playback')).length)).toBe(2);
 await expect(page.locator('.player-status')).toHaveText('');
 await expect.poll(()=>page.locator('video').evaluate(v=>v.currentTime)).toBeGreaterThan(0);
 await fail();
 await expect(page.locator('.player-status')).toContainText('unavailable');
 await expect.poll(()=>page.evaluate(()=>released.length)).toBe(2);
 expect(await page.locator('video').getAttribute('src')).toBeNull();
 expect(await page.evaluate(()=>urls.filter(p=>p.includes('/recordings/')&&p.includes('/playback')).length)).toBe(2);
});

test('unavailable recording cameras cannot trigger history or calendar requests',async({page})=>{
 await page.evaluate(()=>{for(const state of Object.values(card.ha.states))state.attributes.capabilities={recordings:{available:false,status:'unsupported',reason:'standalone_transport_unverified'}};card.hass=card.ha;});
 await expect(page.getByRole('button',{name:'Show recordings',exact:true})).toBeDisabled();
 await expect(page.locator('.status')).toContainText('No camera with available recordings');
 await page.evaluate(()=>{card.load();card.loadCalendar();});
 expect(await page.evaluate(()=>urls)).toEqual([]);
});


test('playback mode persists and shows actual processing while retaining position', async ({page}) => {
  await page.route('**/api/eufy_viewer/playback/*?authSig=*', route => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? '');
    const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2])+1,mp4.length) : mp4.length;
    return route.fulfill({status:range?206:200,contentType:'video/mp4',headers:{'Accept-Ranges':'bytes',...(range?{'Content-Range':`bytes ${start}-${end-1}/${mp4.length}`}:{})},body:mp4.subarray(start,end)});
  });
  await page.route('**/recordings/**/playback?**', route => {
    const native = new URL(route.request().url()).searchParams.get('format') === 'native';
    const media = native ? {source:'hevc',output:'hevc',processing:'remux',fallback:false} : {source:'hevc',output:'h264',processing:'nvidia',fallback:false};
    const path='/api/eufy_viewer/playback/'+'a'.repeat(32);
    return route.fulfill({json:{path,url:path+'?authSig=test',media}});
  });
  await page.getByRole('button',{name:'Show recordings',exact:true}).click(); await page.locator('.event').first().click();
  await expect(page.locator('.recording-media')).toHaveText('NVIDIA transcode');
  await page.screenshot({path:'/private/tmp/issue57-events.png'});
  await page.locator('video').evaluate(v=>{v.pause();v.currentTime=0.5;});
  await expect.poll(()=>page.locator('video').evaluate(v=>v.currentTime)).toBeCloseTo(0.5,1);
  await page.locator('.recording-mode').selectOption('native');
  await expect(page.locator('.recording-media')).toHaveText('Native remux');
  await expect.poll(()=>page.locator('video').evaluate(v=>v.currentTime)).toBeCloseTo(0.5,1);
  expect(await page.locator('video').evaluate(v=>v.paused)).toBe(true);
  expect(await page.evaluate(()=>localStorage.getItem('eufy-viewer.recording-mode'))).toBe('native');
  await page.evaluate(()=>{const other=document.createElement('eufy-events-card');document.body.append(other);window.other=other;});
  await expect(page.locator('eufy-events-card').last().locator('.recording-mode')).toHaveValue('native');
  await page.evaluate(()=>other.remove());
  await page.reload();
  expect(await page.evaluate(()=>localStorage.getItem('eufy-viewer.recording-mode'))).toBe('native');
});

test('explicit Native never retries codec errors and offers H264', async ({page}) => {
  await page.evaluate(()=>localStorage.setItem('eufy-viewer.recording-mode','native'));
  await page.getByRole('button',{name:'Show recordings',exact:true}).click(); await page.locator('.event').first().click();
  await expect.poll(()=>page.locator('video').evaluate(v=>v.currentTime)).toBeGreaterThan(0);
  const before=await page.evaluate(()=>urls.filter(p=>p.includes('/recordings/')&&p.includes('/playback')).length);
  await page.locator('video').evaluate(v=>{Object.defineProperty(v,'error',{configurable:true,value:{code:3}});v.dispatchEvent(new Event('error'));delete v.error;});
  await expect(page.locator('dialog')).toContainText('Select H.264');
  expect(await page.evaluate(()=>urls.filter(p=>p.includes('/recordings/')&&p.includes('/playback')).length)).toBe(before);
  await expect(page.locator('.recording-media')).toHaveText('');
  await page.locator('.recording-mode').selectOption('h264');
  await expect.poll(()=>page.locator('video').evaluate(v=>v.currentTime)).toBeGreaterThan(0);
  await expect(page.locator('.recording-media')).toHaveText('Processing unknown');
});

test('switching during preparation discards late metadata and retains the latest mode', async ({page}) => {
  await page.evaluate(()=>{
    const ha=card.ha,original=ha.fetchWithAuth;let first=true;
    ha.fetchWithAuth=(path,init)=>{
      if(init?.method==='POST'&&first){first=false;return new Promise(resolve=>{window.finishOld=()=>{const p='/api/eufy_viewer/playback/'+'b'.repeat(32);resolve(new Response(JSON.stringify({path:p,url:p+'?authSig=test',media:{source:'hevc',output:'h264',processing:'nvidia',fallback:false}})));};});}
      return original(path,init);
    };
  });
  await page.getByRole('button',{name:'Show recordings',exact:true}).click(); await page.locator('.event').first().click();
  await expect.poll(()=>page.evaluate(()=>typeof window.finishOld)).toBe('function');
  await expect(page.locator('.recording-media')).toHaveText('');
  await page.locator('.recording-mode').selectOption('h264');
  // Complete the cancelled response so its signed session can be released.
  await page.evaluate(()=>finishOld());
  await expect.poll(()=>page.locator('video').evaluate(v=>v.currentTime)).toBeGreaterThan(0);
  await expect(page.locator('.recording-mode')).toHaveValue('h264');
  await expect(page.locator('.recording-media')).toHaveText('Processing unknown');
  await expect.poll(()=>page.evaluate(()=>released.some(p=>p.endsWith('b'.repeat(32))))).toBe(true);
});

test('GPU fallback metadata is truthful and storage denial leaves playback usable', async ({page}) => {
  await page.evaluate(()=>{Storage.prototype.setItem=()=>{throw new Error('Storage denied');};Storage.prototype.getItem=()=>{throw new Error('Storage denied');};});
  await page.route('**/recordings/**/playback**', route => {
    const path='/api/eufy_viewer/playback/'+'a'.repeat(32);
    return route.fulfill({json:{path,url:path+'?authSig=test',media:{source:'hevc',output:'h264',processing:'software',fallback:true}}});
  });
  await page.getByRole('button',{name:'Show recordings',exact:true}).click(); await page.locator('.event').first().click();
  await expect(page.locator('.recording-media')).toHaveText('Software transcode after NVIDIA failure');
  await page.locator('.recording-mode').selectOption('h264');
  await expect(page.locator('.recording-mode')).toHaveValue('h264');
  await expect(page.locator('.recording-media')).toHaveText('Software transcode after NVIDIA failure');
  await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));
  await expect(page.locator('.recording-media')).toHaveText('');
});
