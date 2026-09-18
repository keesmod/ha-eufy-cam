import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../custom_components/eufy_viewer/frontend/eufy-viewer-card.js', import.meta.url), 'utf8');

test.beforeEach(async ({ page }) => {
  await page.route('http://eufy-test.invalid/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
  await page.goto('http://eufy-test.invalid');
  await page.addScriptTag({ content: source.replace('export class EufyViewerCard', 'class EufyViewerCard'), type: 'module' });
  await page.evaluate(async () => {
    await customElements.whenDefined('eufy-viewer-card');
    window.calls = []; window.closeCount = 0; window.acks = []; window.delaySubscription = false;
    const connection = new EventTarget();
    connection.subscribeMessage = async (callback, message, options) => {
      calls.push({ message, options }); window.receive = callback;
      if (window.delaySubscription) await new Promise(resolve => { window.resolveSubscription = resolve; });
      return async () => { window.closeCount++; };
    };
    window.connection = connection;
    window.card = document.createElement('eufy-viewer-card');
    document.body.append(card);
    card.setConfig({ entity: 'camera.front' });
    card.hass = { language: 'en', connection, states: { 'camera.front': { state: 'idle', attributes: { friendly_name: '<img onerror=alert(1)>', viewer_card: true } } }, callWS: async msg => { window.acks.push(msg); return { accepted: true }; } };
  });
});

test('idle never opens stream; click opens exactly once; close releases', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Watch live' })).toBeEnabled();
  expect(await page.evaluate(() => calls.length)).toBe(0);
  await page.getByRole('button', { name: 'Watch live' }).click();
  await expect(page.locator('dialog:not(.record-dialog)')).toBeVisible();
  expect(await page.evaluate(() => calls)).toEqual([{ message: { type: 'eufy_viewer/watch', entity_id: 'camera.front', transport: 'jpeg' }, options: { resubscribe: false } }]);
  await page.getByRole('button', { name: 'Close live view' }).click();
  await expect.poll(() => page.evaluate(() => closeCount)).toBe(1);
});

test('escape, detach, hidden page, pagehide and disconnection all release', async ({ page }) => {
  for (const action of ['escape', 'hidden', 'pagehide', 'disconnect', 'detach']) {
    await page.getByRole('button', { name: 'Watch live' }).click();
    if (action === 'escape') await page.keyboard.press('Escape');
    else await page.evaluate(action => {
      if (action === 'hidden') { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); }
      if (action === 'pagehide') window.dispatchEvent(new Event('pagehide'));
      if (action === 'disconnect') connection.dispatchEvent(new Event('disconnected'));
      if (action === 'detach') card.remove();
    }, action);
    await expect.poll(() => page.evaluate(() => closeCount)).toBe(['escape', 'hidden', 'pagehide', 'disconnect', 'detach'].indexOf(action) + 1);
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); });
  }
});

for (const missing of ['RTCPeerConnection', 'requestVideoFrameCallback']) {
  test(`missing ${missing} falls back to JPEG, displays frames and releases on close`, async ({ page }) => {
    await page.evaluate(missing => {
      card._hass.states['camera.front'].attributes.viewer_webrtc = true;
      if (missing === 'RTCPeerConnection') Object.defineProperty(window, missing, { value: undefined, configurable: true });
      else Object.defineProperty(HTMLVideoElement.prototype, missing, { value: undefined, configurable: true });
    }, missing);
    expect(await page.evaluate(() => calls.length)).toBe(0);
    await page.getByRole('button', { name: 'Watch live' }).click();
    expect(await page.evaluate(() => calls.map(call => call.message.transport))).toEqual(['jpeg']);
    await expect(page.locator('video.video')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Enable sound' })).toBeHidden();
    await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16;
      window.jpeg = canvas.toDataURL('image/jpeg').split(',')[1];
      receive({ type: 'frame', subscription: 9, sequence: 1, jpeg });
    });
    await expect.poll(() => page.evaluate(() => acks.length)).toBe(1);
    await expect(page.locator('img.live')).toBeVisible();
    expect(await page.locator('img.live').evaluate(image => image.naturalWidth)).toBe(16);
    await page.getByRole('button', { name: 'Close live view' }).click();
    await expect.poll(() => page.evaluate(() => closeCount)).toBe(1);
    await expect(page.locator('dialog:not(.record-dialog)')).toBeHidden();
    await page.evaluate(() => receive({ type: 'frame', subscription: 9, sequence: 2, jpeg }));
    expect(await page.evaluate(() => acks.length)).toBe(1);
    expect(await page.evaluate(() => calls.length)).toBe(1);
  });
}

test('supported clients keep WebRTC and its sound control', async ({ page }) => {
  await page.evaluate(() => { card._hass.states['camera.front'].attributes.viewer_webrtc = true; });
  await page.getByRole('button', { name: 'Watch live' }).click();
  expect(await page.evaluate(() => calls.map(call => call.message.transport))).toEqual(['webrtc']);
  await expect(page.locator('img.live')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Enable sound' })).toBeVisible();
  await page.getByRole('button', { name: 'Close live view' }).click();
  await expect.poll(() => page.evaluate(() => closeCount)).toBe(1);
});

test('close before subscribe resolves still releases the late subscription', async ({ page }) => {
  await page.evaluate(() => { window.delaySubscription = true; });
  await page.getByRole('button', { name: 'Watch live' }).click();
  await page.keyboard.press('Escape');
  await page.evaluate(() => resolveSubscription());
  await expect.poll(() => page.evaluate(() => closeCount)).toBe(1);
  await expect(page.locator('dialog:not(.record-dialog)')).not.toBeVisible();
});

test('only a decoded visible frame is acknowledged; no ack after close', async ({ page }) => {
  await page.getByRole('button', { name: 'Watch live' }).click();
  await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16;
    window.jpeg = canvas.toDataURL('image/jpeg').split(',')[1];
    receive({ type: 'frame', subscription: 9, sequence: 1, jpeg });
  });
  await expect.poll(() => page.evaluate(() => acks.length)).toBe(1);
  await page.keyboard.press('Escape');
  await page.evaluate(() => receive({ type: 'frame', subscription: 9, sequence: 2, jpeg }));
  expect(await page.evaluate(() => acks.length)).toBe(1);
});

test('server termination closes dialog and never silently restarts', async ({ page }) => {
  await page.getByRole('button', { name: 'Watch live' }).click();
  await page.evaluate(() => receive({ type: 'ended' }));
  await expect(page.locator('dialog:not(.record-dialog)')).not.toBeVisible();
  await expect.poll(() => page.evaluate(() => closeCount)).toBe(1);
  expect(await page.evaluate(() => calls.length)).toBe(1);
});

test('invalid image fails closed and releases lease', async ({ page }) => {
  await page.getByRole('button', { name: 'Watch live' }).click();
  await page.evaluate(() => receive({ type: 'frame', subscription: 9, sequence: 1, jpeg: btoa('not a JPEG') }));
  await expect.poll(() => page.evaluate(() => closeCount)).toBe(1);
  expect(await page.evaluate(() => acks.length)).toBe(0);
});

test('remote names are text and never inserted as markup', async ({ page }) => {
  await expect(page.locator('.name')).toHaveText('<img onerror=alert(1)>');
  await expect(page.locator('.name img')).toHaveCount(0);
});


test('received snapshot displays without a watch subscription or placeholder overlap', async ({ page }) => {
  const data = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
    const context = canvas.getContext('2d');
    context.fillStyle = '#203747'; context.fillRect(0, 0, 640, 360);
    context.fillStyle = '#eef3e7'; context.font = '28px sans-serif'; context.fillText('Front door · snapshot', 40, 180);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.route('**/api/camera_proxy/**', route => route.fulfill({ contentType: 'image/png', body: Buffer.from(data, 'base64') }));
  await page.evaluate(() => {
    card.style.width = '480px';
    card.hass = { ...card._hass, states: { 'camera.front': { state: 'idle', attributes: { viewer_card: true, friendly_name: 'Front door', entity_picture: '/api/camera_proxy/camera.front?token=fixture', snapshot_received_at: '2026-09-05T10:00:00Z' } } } };
  });
  await expect(page.locator('.snapshot')).toBeVisible();
  await expect(page.locator('.empty')).not.toBeVisible();
  expect(await page.evaluate(() => calls.length)).toBe(0);
  await page.locator('eufy-viewer-card').screenshot({ path: '../artifacts/card-preview.png' });
});

test('camera recovery clears the stale unavailable message without starting a stream', async ({ page }) => {
  await page.evaluate(() => {
    card.hass = { ...card._hass, states: { 'camera.front': { state: 'unavailable', attributes: { viewer_card: true } } } };
  });
  await expect(page.locator('.status')).toHaveText('Camera unavailable');
  await expect(page.getByRole('button', { name: 'Watch live' })).toBeDisabled();
  await page.evaluate(() => {
    card.hass = { ...card._hass, states: { 'camera.front': { state: 'idle', attributes: { viewer_card: true } } } };
  });
  await expect(page.locator('.status')).toHaveText('');
  await expect(page.getByRole('button', { name: 'Watch live' })).toBeEnabled();
  expect(await page.evaluate(() => calls.length)).toBe(0);
  await page.getByRole('button', { name: 'Watch live' }).click();
  await page.evaluate(() => receive({ type: 'ended' }));
  await expect(page.locator('.status')).toHaveText('Live view ended. Tap again to watch.');
  await page.evaluate(() => { card.hass = { ...card._hass }; });
  await expect(page.locator('.status')).toHaveText('Live view ended. Tap again to watch.');
});

test('a viewer refused by the HomeBase live limit names the reason instead of "ended"', async ({ page }) => {
  await page.getByRole('button', { name: 'Watch live' }).click();
  await expect(page.locator('dialog:not(.record-dialog)')).toBeVisible();
  await page.evaluate(() => receive({ type: 'ended', reason: 'station_limit' }));
  await expect(page.locator('.status')).toHaveText('Another camera on this HomeBase is live. Close that live view first, then tap again.');
  await expect(page.locator('dialog:not(.record-dialog)')).toBeHidden();
  expect(await page.evaluate(() => closeCount)).toBe(1);
  // An unknown reason keeps the generic message; older integrations send none.
  await page.getByRole('button', { name: 'Watch live' }).click();
  await page.evaluate(() => receive({ type: 'ended', reason: 'other' }));
  await expect(page.locator('.status')).toHaveText('Live view ended. Tap again to watch.');
  await page.evaluate(() => { card.hass = { ...card._hass, language: 'nl' }; });
  await page.getByRole('button', { name: 'Live bekijken' }).click();
  await page.evaluate(() => receive({ type: 'ended', reason: 'station_limit' }));
  await expect(page.locator('.status')).toHaveText('Een andere camera op deze HomeBase is live. Sluit eerst dat livebeeld en tik dan opnieuw.');
  expect(await page.evaluate(() => closeCount)).toBe(3);
});

for (const failure of ['offer', 'connection']) test(`WebRTC ${failure} failure downgrades the existing subscription with a visible no-audio notice`, async ({ page }) => {
  await page.evaluate(failure => {
    card._hass.states['camera.front'].attributes.viewer_webrtc = true;
    window.RTCPeerConnection = class extends EventTarget {
      iceGatheringState = 'complete'; connectionState = 'new'; localDescription = null;
      addTransceiver() {}
      async createOffer() { if (failure === 'offer') throw new Error('private upstream details'); return { type: 'offer', sdp: 'test' }; }
      async setLocalDescription(offer) { this.localDescription = offer; }
      close() { this.connectionState = 'closed'; this.onconnectionstatechange?.(); }
    };
  }, failure);
  await page.getByRole('button', { name: 'Watch live', exact: true }).click();
  await page.evaluate(() => receive({ type: 'ready', subscription: 9, fallback: true }));
  if (failure === 'connection') {
    await expect.poll(() => page.evaluate(() => acks.some(m => m.offer))).toBe(true);
    await page.evaluate(() => { card._rtc.connectionState = 'failed'; card._rtc.onconnectionstatechange(); });
  }
  await expect.poll(() => page.evaluate(() => acks.filter(m => m.type === 'eufy_viewer/fallback').length)).toBe(1);
  expect(await page.evaluate(() => calls.length)).toBe(1);
  expect(await page.evaluate(() => closeCount)).toBe(0);
  await page.evaluate(() => {
    receive({ type: 'fallback' });
    receive({ type: 'answer', sdp: 'late-answer-must-be-ignored' });
    const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16;
    receive({ type: 'frame', subscription: 9, sequence: 2, jpeg: canvas.toDataURL('image/jpeg').split(',')[1] });
  });
  await expect(page.locator('dialog .live-status')).toHaveText('Live video without sound');
  await expect(page.locator('dialog .live-status')).toBeVisible();
  await expect(page.locator('img.live')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enable sound' })).toBeHidden();
  await expect.poll(() => page.evaluate(() => acks.some(m => m.type === 'eufy_viewer/ack' && m.sequence === 2))).toBe(true);
  expect(await page.evaluate(() => calls.length)).toBe(1);
  await page.getByRole('button', { name: 'Close live view', exact: true }).click();
  await expect.poll(() => page.evaluate(() => closeCount)).toBe(1);
});

test('capability status disables media controls and never fetches unsupported snapshots', async ({ page }) => {
  await page.evaluate(() => {
    const denied = { available: false, status: 'unsupported', reason: 'standalone_transport_unverified' };
    card._hass.states['camera.front'].attributes.capabilities = { snapshot: denied, live: denied, recordings: denied, future: { anything: true } };
    card._hass.states['camera.front'].attributes.entity_picture = '/api/camera_proxy/camera.front';
    card._hass.states['camera.front'].attributes.snapshot_received_at = '2026-09-11T08:00:00Z';
    card.hass = card._hass;
  });
  await expect(page.getByRole('button', { name: 'Watch live' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Recordings', exact: true })).toBeDisabled();
  await expect(page.locator('.capability')).toContainText('standalone camera transport');
  expect(await page.locator('img.snapshot').getAttribute('src')).toBeNull();
  await page.evaluate(async () => { await card._start(); await card._loadRecordings(); await card._playRecording('a'.repeat(32)); });
  expect(await page.evaluate(() => calls.length)).toBe(0);
});

test('experimental software does not claim missing hardware verification or start live', async ({ page }) => {
  await page.evaluate(() => {
    card._hass.states['camera.front'].attributes.capabilities = Object.fromEntries(['snapshot', 'live', 'recordings'].map(feature => [feature, { available: true, status: 'experimental', reason: null }]));
    card.hass = card._hass;
  });
  await expect(page.locator('.capability')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Recordings', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Watch live' })).toBeEnabled();
  expect(await page.evaluate(() => calls.length)).toBe(0);
});

for (const outcome of ['rejected', 'stalled', 'closed']) test(`live diagnostics survive ${outcome} statistics without acknowledging a frame`, async ({ page }) => {
  await page.evaluate(outcome => {
    card._hass.states['camera.front'].attributes.viewer_webrtc = true;
    window.RTCPeerConnection = class extends EventTarget {
      iceGatheringState='complete'; connectionState='new'; iceConnectionState='new'; localDescription=null;
      addTransceiver() {}
      async createOffer() { return {type:'offer',sdp:'PRIVATE'}; }
      async setLocalDescription(offer) { this.localDescription=offer; }
      getStats() { return outcome==='rejected'?Promise.reject(new Error('PRIVATE')):new Promise(()=>{}); }
      close() { this.connectionState='closed'; }
    };
  }, outcome);
  await page.getByRole('button',{name:'Watch live',exact:true}).click();
  await page.evaluate(()=>receive({type:'ready',subscription:9,fallback:true,diagnostics:true}));
  await expect.poll(()=>page.evaluate(()=>acks.some(m=>m.offer))).toBe(true);
  await page.evaluate(()=>{void card._reportLive('startup');});
  if(outcome==='closed')await page.getByRole('button',{name:'Close live view',exact:true}).click();
  if(outcome!=='closed') {
    await expect.poll(()=>page.evaluate(()=>acks.filter(m=>m.type==='eufy_viewer/live_diagnostics').length)).toBe(1);
    const report=await page.evaluate(()=>acks.find(m=>m.type==='eufy_viewer/live_diagnostics').report);
    expect(report.stats_available).toBe(false);expect(report.painted).toBe(0);expect(report.acks_sent).toBe(0);
    expect(JSON.stringify(report)).not.toContain('PRIVATE');
    await page.evaluate(()=>card._reportLive('startup'));
    expect(await page.evaluate(()=>acks.filter(m=>m.type==='eufy_viewer/live_diagnostics').length)).toBe(1);
    await page.getByRole('button',{name:'Close live view',exact:true}).click();
  } else {
    await page.waitForTimeout(1100);
    expect(await page.evaluate(()=>acks.filter(m=>m.type==='eufy_viewer/live_diagnostics').length)).toBe(0);
  }
  expect(await page.evaluate(()=>acks.some(m=>m.type==='eufy_viewer/ack'))).toBe(false);
  await expect.poll(()=>page.evaluate(()=>closeCount)).toBe(1);
});

test('playback report distinguishes frame loss, decode progress and negotiated audio using bounded scalars', async ({ page }) => {
  const report = await page.evaluate(async () => {
    card._open = true; card._rtcSubscription = 9;
    card._playback = {enabled:true,reports:new Set(),start:performance.now(),ticks:0,sent:0,accepted:0,painted:0};
    card._rtc = {
      connectionState:'connected', iceConnectionState:'connected', localDescription:{sdp:'PRIVATE'},remoteDescription:{sdp:'PRIVATE'},
      getTransceivers:()=>[{receiver:{track:{kind:'audio',id:'PRIVATE'}},currentDirection:'inactive'}],
      getStats:async()=>new Map([['video',{type:'inbound-rtp',kind:'video',packetsReceived:500,packetsLost:-2,framesReceived:8,framesDecoded:2,nackCount:7,pliCount:4,jitter:0.012,jitterBufferDelay:0.125,jitterBufferTargetDelay:0.075,jitterBufferMinimumDelay:0.025,jitterBufferEmittedCount:2,address:'PRIVATE'}]]),
      close(){},
    };
    await card._reportLive('startup');
    return acks.find(m=>m.type==='eufy_viewer/live_diagnostics').report;
  });
  expect(report).toMatchObject({video_packets:500,video_lost:-2,video_received:8,video_decoded:2,video_nack:7,video_pli:4,video_jitter_ms:12,video_buffer_delay_ms:125,video_buffer_target_delay_ms:75,video_buffer_min_delay_ms:25,video_buffer_emitted:2,audio_negotiated:false});
  expect(report.audio_packets).toBeUndefined();
  expect(JSON.stringify(report)).not.toContain('PRIVATE');
  expect(await page.evaluate(()=>acks.some(m=>m.type==='eufy_viewer/ack'))).toBe(false);
});

test('audio diagnostics retain negotiated format and track state without codec IDs or SDP', async ({ page }) => {
  const report = await page.evaluate(async () => {
    card._open = true; card._rtcSubscription = 9;
    card._playback = {enabled:true,reports:new Set(),start:performance.now(),ticks:0,sent:0,accepted:0,painted:0};
    const context = new AudioContext(), destination = context.createMediaStreamDestination();
    card._video.srcObject = destination.stream; card._video.volume = 0.5;
    card._rtc = {
      connectionState:'connected', iceConnectionState:'connected', localDescription:{sdp:'PRIVATE'},remoteDescription:{sdp:'PRIVATE'},
      getTransceivers:()=>[{receiver:{track:{kind:'audio',id:'PRIVATE'}},currentDirection:'recvonly'}],
      getStats:async()=>new Map([
        ['audio',{type:'inbound-rtp',kind:'audio',codecId:'PRIVATE',packetsReceived:50,totalSamplesReceived:4800,totalAudioEnergy:0.02}],
        ['PRIVATE',{type:'codec',mimeType:'audio/opus',clockRate:48000,channels:2,sdpFmtpLine:'PRIVATE'}],
      ]), close(){},
    };
    await card._reportLive('audio_check'); await card._reportLive('audio_check');
    await context.close();
    return acks.filter(m=>m.type==='eufy_viewer/live_diagnostics').map(m=>m.report);
  });
  expect(report).toHaveLength(1);
  expect(report[0]).toMatchObject({trigger:'audio_check',audio_codec:'audio/opus',audio_clock_rate:48000,audio_channels:2,audio_volume_percent:50,audio_tracks:1,audio_tracks_enabled:1,audio_tracks_ended:0,audio_negotiated:true,audio_packets:50,audio_samples:4800,audio_energy:true});
  expect(JSON.stringify(report)).not.toContain('PRIVATE');
  expect(await page.evaluate(()=>acks.some(m=>m.type==='eufy_viewer/ack'))).toBe(false);
});

test('late audio check runs once at fifteen seconds and is cancelled on close', async ({ page }) => {
  await page.clock.install();
  await page.evaluate(() => {
    card._hass.states['camera.front'].attributes.viewer_webrtc = true;
    window.RTCPeerConnection = class extends EventTarget {
      iceGatheringState='complete'; connectionState='new'; iceConnectionState='new'; localDescription=null;
      addTransceiver() {} async createOffer() { return {type:'offer',sdp:'PRIVATE'}; }
      async setLocalDescription(offer) { this.localDescription=offer; }
      async getStats() { return new Map(); } close() {}
    };
  });
  await page.getByRole('button',{name:'Watch live',exact:true}).click();
  await page.evaluate(()=>receive({type:'ready',subscription:9,fallback:true,diagnostics:true}));
  await expect.poll(()=>page.evaluate(()=>acks.some(m=>m.offer))).toBe(true);
  // Keep the test session alive without fabricating frame acknowledgements.
  await page.evaluate(()=>clearTimeout(card._startup));
  await page.clock.runFor(14900);
  expect(await page.evaluate(()=>acks.filter(m=>m.report?.trigger==='audio_check').length)).toBe(0);
  await page.clock.runFor(200);
  await expect.poll(()=>page.evaluate(()=>acks.filter(m=>m.report?.trigger==='audio_check').length)).toBe(1);
  await page.getByRole('button',{name:'Close live view',exact:true}).click();
  await page.getByRole('button',{name:'Watch live',exact:true}).click();
  await page.evaluate(()=>receive({type:'ready',subscription:10,fallback:true,diagnostics:true}));
  await page.getByRole('button',{name:'Close live view',exact:true}).click();
  await page.clock.runFor(16000);
  expect(await page.evaluate(()=>acks.filter(m=>m.report?.trigger==='audio_check').length)).toBe(1);
});


// Late audio: the bridge announces AAC once per session, right after video for a
// warm camera or seconds later for a cold one, possibly after sound was enabled.
const installLateAudioFixture = page => page.evaluate(() => {
  card._hass.states['camera.front'].attributes.viewer_webrtc = true;
  card._hass.states['camera.front'].attributes.viewer_late_audio = true;
  window.peers = [];
  window.RTCPeerConnection = class extends EventTarget {
    iceGatheringState = 'complete'; connectionState = 'connected'; iceConnectionState = 'connected'; localDescription = null; remoteDescription = null;
    constructor(config) { super(); this.config = config; this.transceivers = []; this.receivers = []; peers.push(this); }
    addTransceiver(kind) { this.transceivers.push({ kind, receiver: { track: { kind } }, currentDirection: 'recvonly' }); }
    getTransceivers() { return this.transceivers; } getReceivers() { return this.receivers; }
    async createOffer() { return { type: 'offer', sdp: 'PRIVATE offer' }; }
    async setLocalDescription(offer) { this.localDescription = offer; }
    async setRemoteDescription(answer) { this.remoteDescription = answer; }
    async addIceCandidate() {} async getStats() { return new Map(); }
    close() { this.connectionState = 'closed'; }
    deliver(track) { this.receivers.push({ track }); this.ontrack?.({ track, streams: [] }); }
  };
  const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16;
  window.videoTrack = canvas.captureStream(5).getVideoTracks()[0];
  window.audioContext = new AudioContext();
  window.audioTrack = audioContext.createMediaStreamDestination().stream.getAudioTracks()[0];
  window.signals = () => acks.filter(m => m.type === 'eufy_viewer/signal').map(m => ({ audio: Boolean(m.audio), offer: Boolean(m.offer), stop: Boolean(m.stop) }));
  window.element = () => { const stream = card._video.srcObject; return { muted: card._video.muted, paused: card._video.paused, audio: stream?.getAudioTracks().length ?? null, video: stream?.getVideoTracks().length ?? null, state: card._audioState, peer: Boolean(card._audioRtc) }; };
});

for (const order of ['warm', 'cold']) test(`late audio track joins the playing video element when announced ${order}, after or before sound is enabled`, async ({ page }) => {
  await installLateAudioFixture(page);
  await page.getByRole('button', { name: 'Watch live', exact: true }).click();
  expect(await page.evaluate(() => calls.map(call => call.message))).toEqual([{ type: 'eufy_viewer/watch', entity_id: 'camera.front', transport: 'webrtc', late_audio: true }]);
  await page.evaluate(() => receive({ type: 'ready', subscription: 9, fallback: true, diagnostics: true }));
  await expect.poll(() => page.evaluate(() => signals())).toEqual([{ audio: false, offer: true, stop: false }]);
  if (order === 'warm') {
    // A warm camera's audio_ready follows ready by milliseconds, before any track exists.
    await page.evaluate(() => receive({ type: 'audio_ready' }));
    await expect.poll(() => page.evaluate(() => peers.length)).toBe(2);
    await page.evaluate(() => { receive({ type: 'answer', sdp: 'PRIVATE' }); receive({ type: 'audio_answer', sdp: 'PRIVATE' }); });
    await expect.poll(() => page.evaluate(() => Boolean(peers[0].remoteDescription && peers[1].remoteDescription))).toBe(true);
    await page.evaluate(() => { peers[1].deliver(audioTrack); peers[0].deliver(videoTrack); });
    await expect.poll(() => page.evaluate(() => element())).toEqual({ muted: true, paused: false, audio: 1, video: 1, state: 'attached', peer: true });
    await page.getByRole('button', { name: 'Enable sound', exact: true }).click();
  } else {
    // A cold camera delivers video first; the viewer enables sound while the bridge still waits for AAC.
    await page.evaluate(() => { receive({ type: 'answer', sdp: 'PRIVATE' }); peers[0].deliver(videoTrack); });
    await expect.poll(() => page.evaluate(() => element())).toEqual({ muted: true, paused: false, audio: 0, video: 1, state: 'none', peer: false });
    await page.getByRole('button', { name: 'Enable sound', exact: true }).click();
    await expect.poll(() => page.evaluate(() => element().muted)).toBe(false);
    await page.evaluate(() => receive({ type: 'audio_ready' }));
    await expect.poll(() => page.evaluate(() => signals())).toEqual([{ audio: false, offer: true, stop: false }, { audio: true, offer: true, stop: false }]);
    await page.evaluate(() => receive({ type: 'audio_answer', sdp: 'PRIVATE' }));
    await expect.poll(() => page.evaluate(() => Boolean(peers[1].remoteDescription))).toBe(true);
    await page.evaluate(() => peers[1].deliver(audioTrack));
  }
  // Sound enabled before or after the track arrived: the element stays unmuted and playing with both tracks.
  await expect.poll(() => page.evaluate(() => element())).toEqual({ muted: false, paused: false, audio: 1, video: 1, state: 'attached', peer: true });
  expect(await page.evaluate(() => peers[1].transceivers.map(t => t.kind))).toEqual(['audio']);
  expect(await page.evaluate(() => peers[1].config.iceServers)).toEqual([]);
  // A repeated announcement cannot replace the connected peer or its track.
  await page.evaluate(() => receive({ type: 'audio_ready' }));
  await page.waitForTimeout(50);
  expect(await page.evaluate(() => peers.length)).toBe(2);
  expect(await page.evaluate(() => signals().filter(s => s.audio && s.offer).length)).toBe(1);
  const report = await page.evaluate(async () => { await card._reportLive('audio_check'); return acks.find(m => m.type === 'eufy_viewer/live_diagnostics').report; });
  expect(report).toMatchObject({ trigger: 'audio_check', audio_late: 'attached', audio_tracks: 1, audio_tracks_enabled: 1, audio_negotiated: true, muted: false, audio_ice: 'connected' });
  expect(JSON.stringify(report)).not.toContain('PRIVATE');
  // The bridge ending audio removes only the audio track; video and its lease continue.
  await page.evaluate(() => receive({ type: 'audio_ended' }));
  await expect.poll(() => page.evaluate(() => element())).toEqual({ muted: false, paused: false, audio: 0, video: 1, state: 'ended', peer: false });
  expect(await page.evaluate(() => peers[1].connectionState)).toBe('closed');
  expect(await page.evaluate(() => signals().some(s => s.stop))).toBe(false);
  expect(await page.evaluate(() => acks.some(m => m.type === 'eufy_viewer/fallback'))).toBe(false);
  expect(await page.evaluate(() => Boolean(card._rtc) && closeCount)).toBe(0);
  await page.getByRole('button', { name: 'Close live view', exact: true }).click();
  await expect.poll(() => page.evaluate(() => closeCount)).toBe(1);
  expect(await page.evaluate(() => card._video.srcObject)).toBeNull();
});

test('late audio without media within fifteen seconds is released with a stop signal while video continues', async ({ page }) => {
  await page.clock.install();
  await installLateAudioFixture(page);
  await page.getByRole('button', { name: 'Watch live', exact: true }).click();
  await page.evaluate(() => receive({ type: 'ready', subscription: 9, fallback: true, diagnostics: true }));
  await expect.poll(() => page.evaluate(() => signals().length)).toBe(1);
  await page.evaluate(() => { clearTimeout(card._startup); receive({ type: 'answer', sdp: 'PRIVATE' }); peers[0].deliver(videoTrack); receive({ type: 'audio_ready' }); });
  await expect.poll(() => page.evaluate(() => signals().length)).toBe(2);
  await page.evaluate(() => receive({ type: 'audio_answer', sdp: 'PRIVATE' }));
  await page.clock.runFor(14900);
  expect(await page.evaluate(() => element())).toMatchObject({ audio: 0, video: 1, state: 'connecting', peer: true });
  await page.clock.runFor(200);
  await expect.poll(() => page.evaluate(() => element())).toMatchObject({ audio: 0, video: 1, state: 'ended', peer: false });
  expect(await page.evaluate(() => signals())).toEqual([{ audio: false, offer: true, stop: false }, { audio: true, offer: true, stop: false }, { audio: true, offer: false, stop: true }]);
  // A track arriving for the abandoned peer is not attached; the bridge announces once, so no retry follows.
  await page.evaluate(() => peers[1].deliver(audioTrack));
  expect(await page.evaluate(() => element())).toMatchObject({ audio: 0, state: 'ended', peer: false });
  expect(await page.evaluate(() => acks.some(m => m.type === 'eufy_viewer/fallback'))).toBe(false);
  expect(await page.evaluate(() => Boolean(card._rtc))).toBe(true);
  await page.getByRole('button', { name: 'Close live view', exact: true }).click();
  await expect.poll(() => page.evaluate(() => closeCount)).toBe(1);
});

for (const audio of [false,true]) test(`HA ICE configuration and trickle ordering survive incomplete gathering, audio=${audio}`, async ({page})=>{
  await page.evaluate(()=>{
    card._hass.states['camera.front'].attributes.viewer_webrtc=true;
    window.peers=[];
    window.RTCPeerConnection=class extends EventTarget {
      iceGatheringState='gathering';connectionState='new';iceConnectionState='checking';localDescription=null;
      constructor(config){super();this.config=config;peers.push(this);}
      addTransceiver(){} getReceivers(){return [];} getTransceivers(){return [];}
      async createOffer(){return {type:'offer',sdp:'fixture-offer'};}
      async setLocalDescription(offer){this.localDescription=offer;this.onicecandidate?.({candidate:{candidate:'candidate:PRIVATE'}});}
      async getStats(){return new Map([
        ['private-local',{type:'local-candidate',candidateType:'relay',address:'PRIVATE',url:'turn:PRIVATE',username:'PRIVATE'}],
        ['private-remote',{type:'remote-candidate',candidateType:'host',address:'PRIVATE'}],
        ['private-pair',{type:'candidate-pair',state:'in-progress',localCandidateId:'private-local',remoteCandidateId:'private-remote'}],
      ]);}
      close(){this.connectionState='closed';}
    };
  });
  await page.getByRole('button',{name:'Watch live',exact:true}).click();
  await page.evaluate(()=>receive({type:'ready',subscription:9,fallback:true,diagnostics:true,ice_servers:[{urls:['turn:PRIVATE'],username:'PRIVATE',credential:'PRIVATE'}],ice_configuration:'home_assistant'}));
  await expect.poll(()=>page.evaluate(()=>acks.filter(m=>m.candidate).length)).toBe(1);
  if(audio) {
    await page.evaluate(()=>receive({type:'audio_ready',ice_servers:[{urls:'turns:PRIVATE',username:'PRIVATE_NEXT',credential:'PRIVATE_NEXT'}],ice_configuration:'home_assistant'}));
    await expect.poll(()=>page.evaluate(()=>acks.filter(m=>m.candidate).length)).toBe(2);
  }
  const result=await page.evaluate(async audio=>{
    const pc=peers[audio?1:0];
    for(let i=0;i<80;i++)pc.onicecandidateerror({errorCode:701,errorText:'PRIVATE',url:'turn:PRIVATE',address:'PRIVATE'});
    pc.onicecandidateerror({errorCode:441});pc.onicecandidateerror({errorCode:500});
    await card._reportLive('startup');
    return {config:pc.config,signals:acks.filter(m=>m.type==='eufy_viewer/signal').map(m=>({audio:Boolean(m.audio),offer:Boolean(m.offer),candidate:Boolean(m.candidate)})),report:acks.find(m=>m.report).report};
  },audio);
  expect(result.config.iceServers).toEqual(audio?[{urls:'turns:PRIVATE',username:'PRIVATE_NEXT',credential:'PRIVATE_NEXT'}]:[{urls:['turn:PRIVATE'],username:'PRIVATE',credential:'PRIVATE'}]);
  expect(result.signals.filter(s=>s.audio===audio).map(s=>s.offer)).toEqual([true,false]);
  const prefix=audio?'audio_':'';
  expect(result.report[prefix+'ice_gathering']).toBe('gathering');
  expect(result.report[prefix+'relay_configured']).toBe(true);
  expect(result.report[prefix+'local_relay']).toBe(1);
  expect(result.report[prefix+'pairs_in_progress']).toBe(1);
  expect(result.report[prefix+'ice_errors_unreachable']).toBe(64);
  expect(result.report[prefix+'ice_errors_auth']).toBe(1);
  expect(result.report[prefix+'ice_errors_other']).toBe(1);
  expect(JSON.stringify(result.report)).not.toMatch(/PRIVATE|private-|candidate:|turn:/);
  await page.evaluate(()=>{window.lateCandidate=peers[0].onicecandidate;});
  await page.getByRole('button',{name:'Close live view',exact:true}).click();
  const count=await page.evaluate(()=>acks.length);
  await page.evaluate(()=>lateCandidate({candidate:{candidate:'candidate:late'}}));
  expect(await page.evaluate(()=>acks.length)).toBe(count);
  expect(await page.evaluate(()=>peers.every(p=>p.connectionState==='closed'&&p.onicecandidate===null&&p.onicecandidateerror===null))).toBe(true);
});
