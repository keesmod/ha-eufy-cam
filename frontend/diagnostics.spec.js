import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../custom_components/eufy_viewer/frontend/eufy-viewer-card.js', import.meta.url), 'utf8');

async function setup(page, admin = true) {
  await page.route('http://eufy-test.invalid/**', route => route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'}));
  await page.goto('http://eufy-test.invalid');
  await page.addScriptTag({content:source.replace('export class EufyViewerCard','class EufyViewerCard'),type:'module'});
  await page.evaluate(async admin => {
    await customElements.whenDefined('eufy-viewer-card');
    window.calls=[]; window.downloads=[]; window.blobs=[];window.revoked=[];window.started=0;
    const create=URL.createObjectURL, revoke=URL.revokeObjectURL;
    URL.createObjectURL=blob=>{blobs.push(blob);return create(blob);};URL.revokeObjectURL=url=>{revoked.push(url);return revoke(url);};
    const connection=new EventTarget();connection.subscribeMessage=async()=>{started++;throw new Error('expected startup failure');};
    const card=window.card=document.createElement('eufy-viewer-card');card.setConfig({entity:'camera.front'});document.body.append(card);
    card.hass={user:{is_admin:admin},language:'nl',connection,states:{'camera.front':{state:'idle',attributes:{viewer_card:true,friendly_name:'Front'}}},
      callWS:async msg=>{calls.push(msg);return {config_entry_id:'test-entry'};},
      fetchWithAuth:async (path,init)=>{downloads.push({path,method:init?.method});return new Response(JSON.stringify({data:{report_schema:1,recording_playback:{schema:1,attempts:[]}}}),{headers:{'content-type':'application/json'}});}};
  }, admin);
  await page.getByRole('button',{name:'Live bekijken',exact:true}).click();
}

test('live failure offers one authenticated standard HA download and revokes its blob',async({page})=>{
  await setup(page);
  const button=page.getByRole('button',{name:'Diagnose downloaden',exact:true});
  await expect(button).toBeVisible();
  expect(await button.getAttribute('title')).toContain('vijftien minuten');
  const ready=page.waitForEvent('download');await button.click();
  const download=await ready;expect(download.suggestedFilename()).toBe('eufy-diagnostics.json');
  expect(await page.evaluate(()=>calls)).toEqual([{type:'config/entity_registry/get',entity_id:'camera.front'}]);
  expect(await page.evaluate(()=>downloads)).toEqual([{path:'/api/diagnostics/config_entry/test-entry',method:undefined}]);
  expect(await page.evaluate(async()=>JSON.parse(await blobs[0].text()))).toEqual({data:{report_schema:1,recording_playback:{schema:1,attempts:[]}}});
  await expect.poll(()=>page.evaluate(()=>revoked.length)).toBe(1);
  expect(await page.evaluate(()=>started)).toBe(1);
});

test('non-admin playback failure cannot start a diagnostic download',async({page})=>{
  await setup(page,false);
  await expect(page.getByRole('button',{name:'Diagnose downloaden',exact:true})).toHaveCount(0);
  expect(await page.evaluate(()=>calls.length+downloads.length)).toBe(0);
});

for(const failure of ['entry','denied','oversized','timeout'])test(`collection ${failure} is bounded and gives the standard settings route`,async({page})=>{
  await setup(page);
  await page.evaluate(failure=>{
    const timer=window.setTimeout;window.setTimeout=(fn,delay,...args)=>timer(fn,delay===15000?50:delay,...args);
    window.cancelled=0;
    if(failure==='entry')card._hass.callWS=async()=>({config_entry_id:'https://PRIVATE/entry'});
    if(failure==='timeout')card._hass.callWS=()=>new Promise(()=>{});
    if(failure==='denied')card._hass.fetchWithAuth=async()=>new Response('',{status:403});
    if(failure==='oversized')card._hass.fetchWithAuth=async()=>new Response(new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(2*1024*1024+1));},cancel(){cancelled++;}}));
  },failure);
  const button=page.getByRole('button',{name:'Diagnose downloaden',exact:true});await button.click();
  await expect(page.locator('.diagnostic-status').filter({hasText:'Download mislukt'})).toBeVisible();
  await expect(button).toBeEnabled();
  expect(await page.evaluate(()=>blobs.length)).toBe(0);
  if(failure==='oversized')expect(await page.evaluate(()=>cancelled)).toBe(1);
  expect(await page.evaluate(()=>started)).toBe(1);
});

test('recording error exposes collection and includes the loaded card version during preparation',async({page})=>{
  await setup(page);
  await page.evaluate(()=>{
    card._hass.fetchWithAuth=async(path,init)=>{
      downloads.push({path,method:init?.method});
      return init?.method==='POST'?new Response(JSON.stringify({error:'recording_storage_unavailable'}),{status:503}):new Response(JSON.stringify({recordings:[{id:'a'.repeat(32),start:'2026-09-15T10:00:00',end:'2026-09-15T10:00:01'}]}));
    };
  });
  await page.getByRole('button',{name:'Opnames',exact:true}).click();
  await page.locator('.record-row').click();
  await expect(page.locator('.record-dialog .diagnostic-download')).toBeVisible();
  const request=await page.evaluate(()=>downloads.find(r=>r.method==='POST').path);
  const version=JSON.parse(await readFile(new URL('../custom_components/eufy_viewer/manifest.json',import.meta.url),'utf8')).version;
  expect(new URL(request,'http://eufy-test.invalid').searchParams.get('card_version')).toBe(version);
});
