import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../custom_components/eufy_viewer/frontend/eufy-viewer-card.js', import.meta.url), 'utf8');

test.beforeEach(async ({ page }) => {
  await page.route('http://eufy-test.invalid/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
  await page.goto('http://eufy-test.invalid');
  await page.addScriptTag({ content: source.replace('export class EufyViewerCard', 'class EufyViewerCard'), type: 'module' });
  await page.evaluate(async () => {
    await customElements.whenDefined('eufy-viewer-card');
    window.calls = []; window.closeCount = 0; window.acks = []; window.delaySubscription = false; window.receivers = {};
    const connection = new EventTarget();
    connection.subscribeMessage = async (callback, message, options) => {
      calls.push({ message, options }); window.receive = callback; receivers[message.entity_id] = callback;
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

// Inline live mode: the same live elements play inside the card instead of the modal dialog,
// so several cards can be live at once. Every start, lease, stop and message rule is shared.
const inlineFixture = page => page.evaluate(() => {
  card.setConfig({ entity: 'camera.front', live_mode: 'inline' });
  const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16;
  window.jpeg = canvas.toDataURL('image/jpeg').split(',')[1];
});

test('live_mode rejects unknown values and the default keeps the modal dialog', async ({ page }) => {
  expect(await page.evaluate(() => { try { card.setConfig({ entity: 'camera.front', live_mode: 'popup' }); return null; } catch (error) { return error.message; } })).toBe('live_mode must be "dialog" or "inline"');
  await page.getByRole('button', { name: 'Watch live' }).click();
  await expect(page.locator('dialog:not(.record-dialog)')).toBeVisible();
  expect(await page.evaluate(() => card._stage.parentElement === card._dialog)).toBe(true);
  await page.getByRole('button', { name: 'Close live view' }).click();
  await expect.poll(() => page.evaluate(() => closeCount)).toBe(1);
});

for (const transport of ['jpeg', 'webrtc']) test(`inline ${transport} live view plays inside the card, acknowledges frames and returns to the snapshot on close`, async ({ page }) => {
  await inlineFixture(page);
  if (transport === 'webrtc') await page.evaluate(() => { card._hass.states['camera.front'].attributes.viewer_webrtc = true; });
  expect(await page.evaluate(() => calls.length)).toBe(0);
  await page.getByRole('button', { name: 'Watch live' }).click();
  expect(await page.evaluate(() => calls.map(call => call.message.transport))).toEqual([transport]);
  await expect(page.locator('dialog:not(.record-dialog)')).toBeHidden();
  expect(await page.evaluate(() => ({ stage: card._stage.parentElement.tagName, dialogOpen: card._dialog.open, previewHidden: card._preview.hidden, focused: card.shadowRoot.activeElement?.className }))).toEqual({ stage: 'HA-CARD', dialogOpen: false, previewHidden: true, focused: 'close stop' });
  await expect(page.locator('ha-card .stage')).toBeVisible();
  await expect(page.locator('ha-card .stage .live-status')).toBeHidden();
  await expect(page.locator('.status')).toHaveText('Connecting…');
  if (transport === 'webrtc') {
    await expect(page.locator('ha-card video.video')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enable sound' })).toBeVisible();
  } else {
    await expect(page.getByRole('button', { name: 'Enable sound' })).toBeHidden();
    await page.evaluate(() => receive({ type: 'frame', subscription: 9, sequence: 1, jpeg }));
    await expect.poll(() => page.evaluate(() => acks.length)).toBe(1);
    await expect(page.locator('ha-card img.live')).toBeVisible();
    expect(await page.locator('ha-card img.live').evaluate(image => image.naturalWidth)).toBe(16);
    await expect(page.locator('.status')).toHaveText('Live video without sound');
  }
  await page.getByRole('button', { name: 'Close live view' }).click();
  await expect.poll(() => page.evaluate(() => closeCount)).toBe(1);
  await expect(page.locator('ha-card .stage')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Watch live' })).toBeVisible();
  expect(await page.evaluate(() => card.shadowRoot.activeElement === card._preview)).toBe(true);
  if (transport === 'jpeg') {
    await page.evaluate(() => receive({ type: 'frame', subscription: 9, sequence: 2, jpeg }));
    expect(await page.evaluate(() => acks.length)).toBe(1);
  }
  expect(await page.evaluate(() => calls.length)).toBe(1);
});

test('inline live view releases on escape, hidden page, pagehide, disconnection and removal', async ({ page }) => {
  await inlineFixture(page);
  const actions = ['escape', 'hidden', 'pagehide', 'disconnect', 'detach'];
  for (const action of actions) {
    await page.getByRole('button', { name: 'Watch live' }).click();
    await expect(page.locator('ha-card .stage')).toBeVisible();
    if (action === 'escape') await page.keyboard.press('Escape');
    else await page.evaluate(action => {
      if (action === 'hidden') { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); }
      if (action === 'pagehide') window.dispatchEvent(new Event('pagehide'));
      if (action === 'disconnect') connection.dispatchEvent(new Event('disconnected'));
      if (action === 'detach') card.remove();
    }, action);
    await expect.poll(() => page.evaluate(() => closeCount)).toBe(actions.indexOf(action) + 1);
    await expect(page.locator('ha-card .stage')).toBeHidden();
    expect(await page.evaluate(() => card._stage.hidden && !card._preview.hidden)).toBe(true);
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); });
  }
  expect(await page.evaluate(() => calls.length)).toBe(actions.length);
});

test('three inline cards: two play live at once and the third, refused by the HomeBase limit, returns to its snapshot', async ({ page }) => {
  await inlineFixture(page);
  const entities = ['camera.front', 'camera.back', 'camera.side'];
  await page.evaluate(entities => {
    // A dashboard grid: all three cards are in view at once.
    document.body.style.cssText = 'display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:0';
    const states = { ...card._hass.states };
    for (const entity of entities.slice(1)) states[entity] = { state: 'idle', attributes: { friendly_name: entity, viewer_card: true } };
    window.cards = [card];
    for (const entity of entities.slice(1)) {
      const other = document.createElement('eufy-viewer-card'); document.body.append(other);
      other.setConfig({ entity, live_mode: 'inline' }); cards.push(other);
    }
    for (const each of cards) each.hass = { ...card._hass, states };
  }, entities);
  await expect.poll(() => page.evaluate(() => cards.every(each => each._visible))).toBe(true);
  const cardOf = entity => page.locator('eufy-viewer-card').nth(entities.indexOf(entity));
  for (const entity of entities) await cardOf(entity).getByRole('button', { name: 'Watch live' }).click();
  expect(await page.evaluate(() => calls.map(call => call.message.entity_id))).toEqual(entities);
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  // The bridge admits the first two cameras and refuses the third at the limit.
  await page.evaluate(() => {
    receivers['camera.front']({ type: 'frame', subscription: 1, sequence: 1, jpeg });
    receivers['camera.back']({ type: 'frame', subscription: 2, sequence: 1, jpeg });
    receivers['camera.side']({ type: 'ended', reason: 'station_limit' });
  });
  await expect.poll(() => page.evaluate(() => acks.map(ack => ack.subscription).sort())).toEqual([1, 2]);
  await expect.poll(() => page.evaluate(() => closeCount)).toBe(1);
  await expect(cardOf('camera.side').locator('.status')).toHaveText('Another camera on this HomeBase is live. Close that live view first, then tap again.');
  await expect(cardOf('camera.side').locator('.stage')).toBeHidden();
  await expect(cardOf('camera.side').getByRole('button', { name: 'Watch live' })).toBeVisible();
  for (const entity of ['camera.front', 'camera.back']) {
    await expect(cardOf(entity).locator('img.live')).toBeVisible();
    expect(await cardOf(entity).locator('img.live').evaluate(image => image.naturalWidth)).toBe(16);
    await expect(cardOf(entity).getByRole('button', { name: 'Close live view' })).toBeVisible();
    await expect(cardOf(entity).locator('.status')).toHaveText('Live video without sound');
  }
  // Closing one card releases only its own lease. The other keeps acknowledging frames.
  await cardOf('camera.front').getByRole('button', { name: 'Close live view' }).click();
  await expect.poll(() => page.evaluate(() => closeCount)).toBe(2);
  await expect(cardOf('camera.front').locator('.stage')).toBeHidden();
  await page.evaluate(() => {
    receivers['camera.front']({ type: 'frame', subscription: 1, sequence: 2, jpeg });
    receivers['camera.back']({ type: 'frame', subscription: 2, sequence: 2, jpeg });
  });
  await expect.poll(() => page.evaluate(() => acks.filter(ack => ack.subscription === 2).length)).toBe(2);
  expect(await page.evaluate(() => acks.filter(ack => ack.subscription === 1).length)).toBe(1);
  await cardOf('camera.back').getByRole('button', { name: 'Close live view' }).click();
  await expect.poll(() => page.evaluate(() => closeCount)).toBe(3);
  await expect(page.locator('ha-card .stage:not([hidden])')).toHaveCount(0);
  expect(await page.evaluate(() => calls.length)).toBe(3);
});

test('changing live_mode while live stops the view and moves the live elements between card and dialog', async ({ page }) => {
  await inlineFixture(page);
  await page.getByRole('button', { name: 'Watch live' }).click();
  await expect(page.locator('ha-card .stage')).toBeVisible();
  await page.evaluate(() => card.setConfig({ entity: 'camera.front' }));
  await expect.poll(() => page.evaluate(() => closeCount)).toBe(1);
  expect(await page.evaluate(() => ({ inDialog: card._stage.parentElement === card._dialog, stageHidden: card._stage.hidden, previewHidden: card._preview.hidden }))).toEqual({ inDialog: true, stageHidden: false, previewHidden: false });
  await page.getByRole('button', { name: 'Watch live' }).click();
  await expect(page.locator('dialog:not(.record-dialog)')).toBeVisible();
  await page.evaluate(() => card.setConfig({ entity: 'camera.front', live_mode: 'inline' }));
  await expect.poll(() => page.evaluate(() => closeCount)).toBe(2);
  await expect(page.locator('dialog:not(.record-dialog)')).toBeHidden();
  expect(await page.evaluate(() => card._stage.parentElement.tagName)).toBe('HA-CARD');
  await expect(page.locator('ha-card .stage')).toBeHidden();
  expect(await page.evaluate(() => calls.length)).toBe(2);
});

test('card editor offers the live mode and stores the default as an absent key', async ({ page }) => {
  const result = await page.evaluate(async () => {
    await customElements.whenDefined('eufy-viewer-card-editor');
    const editor = document.createElement('eufy-viewer-card-editor');
    const events = [];
    editor.addEventListener('config-changed', event => events.push(event.detail.config));
    document.body.append(editor);
    editor.setConfig({ entity: 'camera.front' });
    editor.hass = card._hass;
    const form = editor.querySelector('ha-form'), picker = editor.querySelector('ha-entity-picker');
    const initial = { schema: form.schema, data: form.data, label: form.computeLabel(form.schema[0]), picker: picker.value, filtered: picker.entityFilter({ attributes: {} }) };
    const change = live_mode => form.dispatchEvent(new CustomEvent('value-changed', { detail: { value: { live_mode } } }));
    change('inline'); change('inline');
    picker.dispatchEvent(new CustomEvent('value-changed', { detail: { value: 'camera.back' } }));
    change('dialog');
    editor.hass = { ...card._hass, language: 'nl' };
    return { initial, events, dutch: { options: form.schema[0].selector.select.options.map(option => option.label), label: form.computeLabel(form.schema[0]), data: form.data } };
  });
  expect(result.initial).toEqual({
    schema: [{ name: 'live_mode', selector: { select: { mode: 'dropdown', options: [{ value: 'dialog', label: 'Popup dialog (default)' }, { value: 'inline', label: 'Inside the card, for several live cameras' }] } } }],
    data: { live_mode: 'dialog' }, label: 'Live view', picker: 'camera.front', filtered: false,
  });
  expect(result.events).toEqual([{ entity: 'camera.front', live_mode: 'inline' }, { entity: 'camera.back', live_mode: 'inline' }, { entity: 'camera.back' }]);
  expect(result.dutch).toEqual({ options: ['Pop-updialoog (standaard)', "In de kaart, voor meerdere livecamera's"], label: 'Livebeeld', data: { live_mode: 'dialog' } });
});

// Optional autostart: an inline card starts its live view without a tap when it comes into view after it
// is attached, or when the page becomes visible again. One trigger starts at most one session, the card
// keeps its session while it is scrolled out of view, and a session that ended never restarts by itself.
// Pause releases the lease and offers resume, stop also disables autostart until the card is attached again.
const attachAutostart = (page, config = { entity: 'camera.front', live_mode: 'inline', live_autostart: true }) => page.evaluate(config => {
  // Home Assistant's order: config and hass first, then the card is attached to the view.
  const hass = card._hass; card.remove();
  window.card = document.createElement('eufy-viewer-card');
  card.setConfig(config); card.hass = hass; document.body.append(card);
  const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16;
  window.jpeg = canvas.toDataURL('image/jpeg').split(',')[1];
  window.pageVisible = visible => { Object.defineProperty(document, 'visibilityState', { value: visible ? 'visible' : 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); };
  window.state = () => ({ open: card._open, stage: !card._stage.hidden, preview: !card._preview.hidden, paused: !card._pausedBar.hidden, pause: !card._pauseButton.hidden && !card._stage.hidden, stop: !card._haltButton.hidden && !card._stage.hidden, calls: calls.length, closes: closeCount });
}, config);

test('live_autostart starts an inline card without a tap when it is attached in view, and once more when the page comes back into view', async ({ page }) => {
  await attachAutostart(page);
  await expect.poll(() => page.evaluate(() => calls.length)).toBe(1);
  expect(await page.evaluate(() => calls[0])).toEqual({ message: { type: 'eufy_viewer/watch', entity_id: 'camera.front', transport: 'jpeg' }, options: { resubscribe: false } });
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(page.locator('ha-card .stage')).toBeVisible();
  expect(await page.evaluate(() => state())).toEqual({ open: true, stage: true, preview: false, paused: false, pause: true, stop: true, calls: 1, closes: 0 });
  for (const name of ['Pause', 'Stop', 'Close live view']) await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  await expect(page.locator('.status')).toHaveText('Connecting…');
  // The session keeps the frame acknowledgement loop.
  await page.evaluate(() => receive({ type: 'frame', subscription: 9, sequence: 1, jpeg }));
  await expect.poll(() => page.evaluate(() => acks.length)).toBe(1);
  // Hidden page: the lease is released and state updates start nothing. Visible again: one new session.
  await page.evaluate(() => pageVisible(false));
  await expect.poll(() => page.evaluate(() => closeCount)).toBe(1);
  await expect(page.locator('ha-card .stage')).toBeHidden();
  await page.evaluate(() => { card.hass = { ...card._hass }; });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => calls.length)).toBe(1);
  await page.evaluate(() => pageVisible(true));
  await expect.poll(() => page.evaluate(() => calls.length)).toBe(2);
  // Repeated state updates start nothing more.
  await page.evaluate(() => { card.hass = { ...card._hass }; card.hass = { ...card._hass }; });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => state())).toMatchObject({ open: true, calls: 2, closes: 1 });
  // The existing close still releases the lease and returns the card to its snapshot.
  await page.getByRole('button', { name: 'Close live view', exact: true }).click();
  await expect.poll(() => page.evaluate(() => closeCount)).toBe(2);
  expect(await page.evaluate(() => state())).toEqual({ open: false, stage: false, preview: true, paused: false, pause: false, stop: false, calls: 2, closes: 2 });
  expect(await page.evaluate(() => card.shadowRoot.activeElement === card._preview)).toBe(true);
});

test('live_autostart is rejected outside the inline mode, and without it an inline or dialog card still waits for a tap', async ({ page }) => {
  const rejected = config => page.evaluate(config => { try { card.setConfig(config); return null; } catch (error) { return error.message; } }, config);
  expect(await rejected({ entity: 'camera.front', live_autostart: true })).toBe('live_autostart requires live_mode "inline"');
  expect(await rejected({ entity: 'camera.front', live_mode: 'dialog', live_autostart: true })).toBe('live_autostart requires live_mode "inline"');
  expect(await rejected({ entity: 'camera.front', live_mode: 'inline', live_autostart: 'yes' })).toBe('live_autostart must be true or false');
  expect(await rejected({ entity: 'camera.front', live_autostart: false })).toBeNull();
  for (const config of [{ entity: 'camera.front', live_mode: 'inline' }, { entity: 'camera.front', live_mode: 'inline', live_autostart: false }, { entity: 'camera.front' }]) {
    await attachAutostart(page, config);
    await expect.poll(() => page.evaluate(() => card._visible)).toBe(true);
    await page.evaluate(() => { pageVisible(true); card.hass = { ...card._hass }; });
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => state())).toMatchObject({ open: false, paused: false, calls: 0 });
  }
  // Enabling the option on an attached card starts nothing by itself. The next view opening does.
  await page.evaluate(() => card.setConfig({ entity: 'camera.front', live_mode: 'inline', live_autostart: true }));
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => calls.length)).toBe(0);
  // A tap works as before. The pause and stop controls exist only with the option.
  await page.getByRole('button', { name: 'Watch live' }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close live view', exact: true }).click();
  await expect.poll(() => page.evaluate(() => closeCount)).toBe(1);
  await page.evaluate(() => card.setConfig({ entity: 'camera.front', live_mode: 'inline' }));
  await page.getByRole('button', { name: 'Watch live' }).click();
  await expect(page.locator('ha-card .stage')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeHidden();
  await page.evaluate(() => { card.remove(); document.body.append(card); });
  await expect.poll(() => page.evaluate(() => closeCount)).toBe(2);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => calls.length)).toBe(2);
});

test('pause releases the lease and shows the snapshot with resume and stop, and resume starts a fresh session', async ({ page }) => {
  await attachAutostart(page);
  await expect.poll(() => page.evaluate(() => calls.length)).toBe(1);
  await page.evaluate(() => receive({ type: 'frame', subscription: 9, sequence: 1, jpeg }));
  await expect.poll(() => page.evaluate(() => acks.length)).toBe(1);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect.poll(() => page.evaluate(() => closeCount)).toBe(1);
  expect(await page.evaluate(() => state())).toEqual({ open: false, stage: false, preview: true, paused: true, pause: false, stop: false, calls: 1, closes: 1 });
  await expect(page.locator('.status')).toHaveText('Paused. Tap Resume to watch.');
  for (const name of ['Resume', 'Stop', 'Watch live']) await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  expect(await page.evaluate(() => card.shadowRoot.activeElement === card._resumeButton)).toBe(true);
  // A late frame of the released session is not acknowledged, and state updates start nothing while paused.
  await page.evaluate(() => { receive({ type: 'frame', subscription: 9, sequence: 2, jpeg }); card.hass = { ...card._hass }; });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => ({ acks: acks.length, calls: calls.length }))).toEqual({ acks: 1, calls: 1 });
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect.poll(() => page.evaluate(() => calls.length)).toBe(2);
  expect(await page.evaluate(() => state())).toEqual({ open: true, stage: true, preview: false, paused: false, pause: true, stop: true, calls: 2, closes: 1 });
  await expect(page.locator('.status')).toHaveText('Connecting…');
  await page.evaluate(() => receive({ type: 'frame', subscription: 10, sequence: 1, jpeg }));
  await expect.poll(() => page.evaluate(() => acks.filter(ack => ack.subscription === 10).length)).toBe(1);
  // Pause does not disable autostart: the next trigger starts again.
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect.poll(() => page.evaluate(() => closeCount)).toBe(2);
  await page.evaluate(() => { pageVisible(false); pageVisible(true); });
  await expect.poll(() => page.evaluate(() => calls.length)).toBe(3);
  expect(await page.evaluate(() => state())).toMatchObject({ open: true, paused: false });
  // The existing close returns the card to its plain snapshot without the paused bar.
  await page.getByRole('button', { name: 'Close live view', exact: true }).click();
  await expect.poll(() => page.evaluate(() => closeCount)).toBe(3);
  expect(await page.evaluate(() => state())).toMatchObject({ open: false, stage: false, preview: true, paused: false });
  // Dutch controls.
  await page.evaluate(() => { card.hass = { ...card._hass, language: 'nl' }; });
  await page.getByRole('button', { name: 'Live bekijken' }).click();
  await page.getByRole('button', { name: 'Pauze', exact: true }).click();
  await expect.poll(() => page.evaluate(() => closeCount)).toBe(4);
  await expect(page.locator('.status')).toHaveText('Gepauzeerd. Tik op Hervatten om te kijken.');
  await expect(page.getByRole('button', { name: 'Hervatten', exact: true })).toBeVisible();
  expect(await page.evaluate(() => calls.length)).toBe(4);
});

test('stop ends the session and disables autostart until the card is attached again, a tap still works', async ({ page }) => {
  await attachAutostart(page);
  await expect.poll(() => page.evaluate(() => calls.length)).toBe(1);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect.poll(() => page.evaluate(() => closeCount)).toBe(1);
  expect(await page.evaluate(() => state())).toEqual({ open: false, stage: false, preview: true, paused: false, pause: false, stop: false, calls: 1, closes: 1 });
  await expect(page.locator('.status')).toHaveText('Stopped until you open this view again. Tap to watch.');
  expect(await page.evaluate(() => card.shadowRoot.activeElement === card._preview)).toBe(true);
  // No trigger restarts a stopped card: page visibility, scrolling back into view or state updates.
  await page.evaluate(() => { pageVisible(false); pageVisible(true); card.style.marginTop = '4000px'; });
  await expect.poll(() => page.evaluate(() => card._visible)).toBe(false);
  await page.evaluate(() => { card.style.marginTop = ''; });
  await expect.poll(() => page.evaluate(() => card._visible)).toBe(true);
  await page.evaluate(() => { card.hass = { ...card._hass }; });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => calls.length)).toBe(1);
  // A tap starts a manual session with the same controls. Its end does not restart it either.
  await page.getByRole('button', { name: 'Watch live' }).click();
  await expect.poll(() => page.evaluate(() => calls.length)).toBe(2);
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await page.evaluate(() => receive({ type: 'ended' }));
  await expect.poll(() => page.evaluate(() => closeCount)).toBe(2);
  await expect(page.locator('.status')).toHaveText('Live view ended. Tap again to watch.');
  await page.evaluate(() => { pageVisible(false); pageVisible(true); card.hass = { ...card._hass }; });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => calls.length)).toBe(2);
  // Attaching the card again, as navigation back to the view does, applies autostart again.
  await page.evaluate(() => { card.remove(); document.body.append(card); });
  await expect.poll(() => page.evaluate(() => calls.length)).toBe(3);
  // Stop from the paused bar blocks autostart as well and moves focus back to the preview.
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect.poll(() => page.evaluate(() => closeCount)).toBe(3);
  expect(await page.evaluate(() => state())).toEqual({ open: false, stage: false, preview: true, paused: false, pause: false, stop: false, calls: 3, closes: 3 });
  await expect(page.locator('.status')).toHaveText('Stopped until you open this view again. Tap to watch.');
  expect(await page.evaluate(() => card.shadowRoot.activeElement === card._preview)).toBe(true);
  await page.evaluate(() => { pageVisible(false); pageVisible(true); card.hass = { ...card._hass }; });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => calls.length)).toBe(3);
  await page.evaluate(() => { card.remove(); document.body.append(card); });
  await expect.poll(() => page.evaluate(() => calls.length)).toBe(4);
  await page.evaluate(() => { card.hass = { ...card._hass, language: 'nl' }; });
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.locator('.status')).toHaveText('Gestopt tot je deze weergave opnieuw opent. Tik om te kijken.');
  await expect.poll(() => page.evaluate(() => closeCount)).toBe(4);
});

test('three autostart cards start without a tap, the card refused by the HomeBase limit returns to its snapshot without a retry, and leaving the view stops every session', async ({ page }) => {
  const entities = ['camera.front', 'camera.back', 'camera.side'];
  await page.evaluate(entities => {
    // A dashboard grid: all three cards are in view at once.
    document.body.style.cssText = 'display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:0';
    const states = { ...card._hass.states };
    for (const entity of entities.slice(1)) states[entity] = { state: 'idle', attributes: { friendly_name: entity, viewer_card: true } };
    const hass = { ...card._hass, states }; card.remove();
    const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16;
    window.jpeg = canvas.toDataURL('image/jpeg').split(',')[1];
    window.pageVisible = visible => { Object.defineProperty(document, 'visibilityState', { value: visible ? 'visible' : 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); };
    window.cards = entities.map(entity => { const each = document.createElement('eufy-viewer-card'); each.setConfig({ entity, live_mode: 'inline', live_autostart: true }); each.hass = hass; document.body.append(each); return each; });
    window.card = cards[0];
  }, entities);
  await expect.poll(() => page.evaluate(() => calls.map(call => call.message.entity_id).sort())).toEqual([...entities].sort());
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(page.locator('ha-card .stage:not([hidden])')).toHaveCount(3);
  const cardOf = entity => page.locator('eufy-viewer-card').nth(entities.indexOf(entity));
  // The bridge admits the first two cameras and refuses the third at the limit.
  await page.evaluate(() => {
    receivers['camera.front']({ type: 'frame', subscription: 1, sequence: 1, jpeg });
    receivers['camera.back']({ type: 'frame', subscription: 2, sequence: 1, jpeg });
    receivers['camera.side']({ type: 'ended', reason: 'station_limit' });
  });
  await expect.poll(() => page.evaluate(() => acks.map(ack => ack.subscription).sort())).toEqual([1, 2]);
  await expect.poll(() => page.evaluate(() => closeCount)).toBe(1);
  await expect(cardOf('camera.side').locator('.status')).toHaveText('Another camera on this HomeBase is live. Close that live view first, then tap again.');
  await expect(cardOf('camera.side').locator('.stage')).toBeHidden();
  await expect(cardOf('camera.side').getByRole('button', { name: 'Watch live' })).toBeVisible();
  await expect(cardOf('camera.side').getByRole('button', { name: 'Resume', exact: true })).toBeHidden();
  // The refused card does not retry on state updates or time. The others keep acknowledging.
  await page.evaluate(() => { for (const each of cards) each.hass = { ...each._hass }; });
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => calls.length)).toBe(3);
  await page.evaluate(() => { receivers['camera.front']({ type: 'frame', subscription: 1, sequence: 2, jpeg }); receivers['camera.back']({ type: 'frame', subscription: 2, sequence: 2, jpeg }); });
  await expect.poll(() => page.evaluate(() => acks.length)).toBe(4);
  // Pause one card: only its lease is released.
  await cardOf('camera.back').getByRole('button', { name: 'Pause', exact: true }).click();
  await expect.poll(() => page.evaluate(() => closeCount)).toBe(2);
  await expect(cardOf('camera.back').getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await expect(cardOf('camera.front').locator('img.live')).toBeVisible();
  // Leaving the view: a hidden page releases every session. Returning applies autostart to all three, the refused and the paused one included.
  await page.evaluate(() => pageVisible(false));
  await expect.poll(() => page.evaluate(() => closeCount)).toBe(3);
  await expect(page.locator('ha-card .stage:not([hidden])')).toHaveCount(0);
  await page.evaluate(() => pageVisible(true));
  await expect.poll(() => page.evaluate(() => calls.length)).toBe(6);
  await expect(page.locator('ha-card .stage:not([hidden])')).toHaveCount(3);
  // Navigation removes the cards: every session stops and nothing starts while they are detached.
  await page.evaluate(() => { for (const each of cards) each.remove(); });
  await expect.poll(() => page.evaluate(() => closeCount)).toBe(6);
  await page.evaluate(() => { for (const each of cards) each.hass = { ...each._hass }; pageVisible(false); pageVisible(true); });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => calls.length)).toBe(6);
});

test('a session the bridge ends at the cap or for any other reason stays on the snapshot until the next trigger or a tap', async ({ page }) => {
  await attachAutostart(page);
  await expect.poll(() => page.evaluate(() => calls.length)).toBe(1);
  await page.evaluate(() => receive({ type: 'frame', subscription: 9, sequence: 1, jpeg }));
  await expect.poll(() => page.evaluate(() => acks.length)).toBe(1);
  await page.evaluate(() => receive({ type: 'ended' }));
  await expect.poll(() => page.evaluate(() => closeCount)).toBe(1);
  await expect(page.locator('.status')).toHaveText('Live view ended. Tap again to watch.');
  expect(await page.evaluate(() => state())).toMatchObject({ open: false, stage: false, preview: true, paused: false });
  await page.evaluate(() => { for (let i = 0; i < 3; i++) card.hass = { ...card._hass }; });
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => calls.length)).toBe(1);
  // A failed session behaves the same after a tap.
  await page.getByRole('button', { name: 'Watch live' }).click();
  await expect.poll(() => page.evaluate(() => calls.length)).toBe(2);
  await page.evaluate(() => receive({ type: 'frame', subscription: 10, sequence: 1, jpeg: btoa('not a JPEG') }));
  await expect.poll(() => page.evaluate(() => closeCount)).toBe(2);
  await expect(page.locator('.status')).toHaveText('Live view failed. Tap again to retry.');
  await page.evaluate(() => { card.hass = { ...card._hass }; });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => calls.length)).toBe(2);
  // Returning to the view starts again.
  await page.evaluate(() => { pageVisible(false); pageVisible(true); });
  await expect.poll(() => page.evaluate(() => calls.length)).toBe(3);
});

test('an autostart card releases on hidden page, pagehide, disconnection and removal, and starts nothing while away', async ({ page }) => {
  await attachAutostart(page);
  await expect.poll(() => page.evaluate(() => calls.length)).toBe(1);
  const actions = ['hidden', 'pagehide', 'disconnect', 'detach'];
  for (const action of actions) {
    await page.evaluate(action => {
      if (action === 'hidden') pageVisible(false);
      if (action === 'pagehide') window.dispatchEvent(new Event('pagehide'));
      if (action === 'disconnect') connection.dispatchEvent(new Event('disconnected'));
      if (action === 'detach') card.remove();
    }, action);
    await expect.poll(() => page.evaluate(() => closeCount)).toBe(actions.indexOf(action) + 1);
    expect(await page.evaluate(() => card._stage.hidden && !card._open)).toBe(true);
    await page.evaluate(() => { card.hass = { ...card._hass }; });
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => calls.length)).toBe(actions.indexOf(action) + 1);
    // Returning to the view: the page becomes visible again, or the card is attached again after navigation.
    await page.evaluate(action => { if (action === 'detach') document.body.append(card); else pageVisible(true); }, action);
    await expect.poll(() => page.evaluate(() => calls.length)).toBe(actions.indexOf(action) + 2);
  }
  expect(await page.evaluate(() => closeCount)).toBe(4);
});

// Scrolling: an autostart card keeps its session while it is out of view, so a long dashboard does not
// stop and restart its cameras. Every other card still stops on intersection loss.
test('an autostart card scrolled out of view keeps its session and keeps acknowledging frames, and scrolling back starts no second session', async ({ page }) => {
  await attachAutostart(page);
  await expect.poll(() => page.evaluate(() => calls.length)).toBe(1);
  await page.evaluate(() => receive({ type: 'frame', subscription: 9, sequence: 1, jpeg }));
  await expect.poll(() => page.evaluate(() => acks.length)).toBe(1);
  await page.evaluate(() => { card.style.marginTop = '4000px'; });
  await expect.poll(() => page.evaluate(() => card._visible)).toBe(false);
  expect(await page.evaluate(() => state())).toMatchObject({ open: true, stage: true, preview: false, calls: 1, closes: 0 });
  // Frames delivered while the card is out of view are still decoded, painted and acknowledged, so the bridge keeps the lease.
  for (const sequence of [2, 3, 4]) {
    await page.evaluate(sequence => receive({ type: 'frame', subscription: 9, sequence, jpeg }), sequence);
    await expect.poll(() => page.evaluate(() => acks.length)).toBe(sequence);
  }
  expect(await page.evaluate(() => acks.map(ack => ack.sequence))).toEqual([1, 2, 3, 4]);
  // State updates and time start nothing while the card is out of view.
  await page.evaluate(() => { card.hass = { ...card._hass }; card.hass = { ...card._hass }; });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => state())).toMatchObject({ open: true, calls: 1, closes: 0 });
  // Back in view: the same session is still live and nothing new starts.
  await page.evaluate(() => { card.style.marginTop = ''; });
  await expect.poll(() => page.evaluate(() => card._visible)).toBe(true);
  await page.evaluate(() => { card.hass = { ...card._hass }; });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => state())).toMatchObject({ open: true, stage: true, calls: 1, closes: 0 });
  await page.evaluate(() => receive({ type: 'frame', subscription: 9, sequence: 5, jpeg }));
  await expect.poll(() => page.evaluate(() => acks.length)).toBe(5);
  await expect(page.locator('ha-card img.live')).toBeVisible();
  // The cap still ends the session while the card is out of view, and scrolling back does not restart it. The page becoming visible again does.
  await page.evaluate(() => { card.style.marginTop = '4000px'; });
  await expect.poll(() => page.evaluate(() => card._visible)).toBe(false);
  await page.evaluate(() => receive({ type: 'ended' }));
  await expect.poll(() => page.evaluate(() => closeCount)).toBe(1);
  // The stop returns focus to the snapshot without scrolling the page to the card.
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => ({ visible: card._visible, scrollY: window.scrollY, focused: card.shadowRoot.activeElement === card._preview }))).toEqual({ visible: false, scrollY: 0, focused: true });
  await page.evaluate(() => { card.style.marginTop = ''; });
  await expect.poll(() => page.evaluate(() => card._visible)).toBe(true);
  await page.evaluate(() => { card.hass = { ...card._hass }; });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => state())).toMatchObject({ open: false, stage: false, preview: true, paused: false, calls: 1, closes: 1 });
  await expect(page.locator('.status')).toHaveText('Live view ended. Tap again to watch.');
  await page.evaluate(() => { pageVisible(false); pageVisible(true); });
  await expect.poll(() => page.evaluate(() => calls.length)).toBe(2);
});

test('an autostart card scrolled out of view keeps acknowledging WebRTC ticks from painted frames', async ({ page }) => {
  await installLateAudioFixture(page);
  await page.evaluate(() => {
    // A changing canvas keeps the captured track producing frames, as a camera does. A static canvas produces none.
    const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16;
    const context = canvas.getContext('2d');
    setInterval(() => { context.fillStyle = `hsl(${Date.now() % 360} 50% 50%)`; context.fillRect(0, 0, 16, 16); }, 40);
    window.videoTrack = canvas.captureStream(5).getVideoTracks()[0];
  });
  await attachAutostart(page);
  await expect.poll(() => page.evaluate(() => calls.map(call => call.message.transport))).toEqual(['webrtc']);
  await page.evaluate(() => receive({ type: 'ready', subscription: 9, fallback: true }));
  await expect.poll(() => page.evaluate(() => signals())).toEqual([{ audio: false, offer: true, stop: false }]);
  await page.evaluate(() => { receive({ type: 'answer', sdp: 'PRIVATE' }); peers[0].deliver(videoTrack); });
  await expect.poll(() => page.evaluate(() => element().paused)).toBe(false);
  const ticks = () => page.evaluate(() => acks.filter(m => m.type === 'eufy_viewer/ack').map(m => m.sequence));
  await page.evaluate(() => receive({ type: 'tick', subscription: 9, sequence: 1 }));
  await expect.poll(ticks).toEqual([1]);
  await page.evaluate(() => { card.style.marginTop = '4000px'; });
  await expect.poll(() => page.evaluate(() => card._visible)).toBe(false);
  // Each tick is acknowledged from a fresh painted frame while the video element is out of view.
  for (const sequence of [2, 3, 4]) {
    await page.evaluate(sequence => receive({ type: 'tick', subscription: 9, sequence }), sequence);
    await expect.poll(ticks).toEqual([1, 2, 3, 4].slice(0, sequence));
  }
  expect(await page.evaluate(() => state())).toMatchObject({ open: true, stage: true, calls: 1, closes: 0 });
  await page.evaluate(() => { card.style.marginTop = ''; });
  await expect.poll(() => page.evaluate(() => card._visible)).toBe(true);
  await page.evaluate(() => receive({ type: 'tick', subscription: 9, sequence: 5 }));
  await expect.poll(ticks).toEqual([1, 2, 3, 4, 5]);
  expect(await page.evaluate(() => ({ calls: calls.length, fallback: acks.some(m => m.type === 'eufy_viewer/fallback') }))).toEqual({ calls: 1, fallback: false });
  await page.getByRole('button', { name: 'Close live view', exact: true }).click();
  await expect.poll(() => page.evaluate(() => closeCount)).toBe(1);
  expect(await page.evaluate(() => card._video.srcObject)).toBeNull();
});

test('an inline card without autostart and the popup still stop when the card scrolls out of view, and scrolling back starts nothing', async ({ page }) => {
  const configs = [{ entity: 'camera.front', live_mode: 'inline' }, { entity: 'camera.front' }];
  for (const config of configs) {
    const round = configs.indexOf(config) + 1;
    await attachAutostart(page, config);
    await expect.poll(() => page.evaluate(() => card._visible)).toBe(true);
    await page.getByRole('button', { name: 'Watch live' }).click();
    await expect.poll(() => page.evaluate(() => calls.length)).toBe(round);
    await page.evaluate(() => receive({ type: 'frame', subscription: 9, sequence: 1, jpeg }));
    await expect.poll(() => page.evaluate(() => acks.length)).toBe(round);
    await page.evaluate(() => { card.style.marginTop = '4000px'; });
    await expect.poll(() => page.evaluate(() => closeCount)).toBe(round);
    expect(await page.evaluate(() => ({ open: card._open, dialog: card._dialog.open, stage: card._inline && !card._stage.hidden }))).toEqual({ open: false, dialog: false, stage: false });
    // A late frame of the released session is not acknowledged, and scrolling back into view starts nothing.
    await page.evaluate(() => { receive({ type: 'frame', subscription: 9, sequence: 2, jpeg }); card.style.marginTop = ''; });
    await expect.poll(() => page.evaluate(() => card._visible)).toBe(true);
    await page.evaluate(() => { card.hass = { ...card._hass }; });
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => ({ calls: calls.length, acks: acks.length, closes: closeCount }))).toEqual({ calls: round, acks: round, closes: round });
  }
});

test('an autostart card scrolled out of view still releases on hidden page, pagehide, disconnection and removal, and the next trigger waits until it is in view again', async ({ page }) => {
  await attachAutostart(page);
  await expect.poll(() => page.evaluate(() => calls.length)).toBe(1);
  const actions = ['hidden', 'pagehide', 'disconnect', 'detach'];
  for (const action of actions) {
    const round = actions.indexOf(action) + 1;
    await page.evaluate(() => { card.style.marginTop = '4000px'; });
    await expect.poll(() => page.evaluate(() => card._visible)).toBe(false);
    await page.evaluate(round => receive({ type: 'frame', subscription: round, sequence: 1, jpeg }), round);
    await expect.poll(() => page.evaluate(() => acks.length)).toBe(round);
    expect(await page.evaluate(() => state())).toMatchObject({ open: true, calls: round, closes: round - 1 });
    await page.evaluate(action => {
      if (action === 'hidden') pageVisible(false);
      if (action === 'pagehide') window.dispatchEvent(new Event('pagehide'));
      if (action === 'disconnect') connection.dispatchEvent(new Event('disconnected'));
      if (action === 'detach') card.remove();
    }, action);
    await expect.poll(() => page.evaluate(() => closeCount)).toBe(round);
    expect(await page.evaluate(() => card._stage.hidden && !card._open)).toBe(true);
    // A late frame of the released session is not acknowledged.
    await page.evaluate(round => receive({ type: 'frame', subscription: round, sequence: 2, jpeg }), round);
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => acks.length)).toBe(round);
    // Returning to the view while the card is still out of view: the trigger waits until the card scrolls into view.
    await page.evaluate(action => { if (action === 'detach') document.body.append(card); else pageVisible(true); }, action);
    await page.evaluate(() => { card.hass = { ...card._hass }; });
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => calls.length)).toBe(round);
    await page.evaluate(() => { card.style.marginTop = ''; });
    await expect.poll(() => page.evaluate(() => calls.length)).toBe(round + 1);
  }
  expect(await page.evaluate(() => closeCount)).toBe(4);
});

test('three autostart cards in one narrow column stay live while the page scrolls between them, and a hidden page or navigation stops every session', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 700 });
  const entities = ['camera.front', 'camera.back', 'camera.side'];
  await page.evaluate(entities => {
    // A mobile dashboard: one card per row, each taller than the viewport, so one card is in view at a time.
    document.body.style.cssText = 'display:grid;grid-template-columns:1fr;gap:200px;margin:0';
    const states = { ...card._hass.states };
    for (const entity of entities.slice(1)) states[entity] = { state: 'idle', attributes: { friendly_name: entity, viewer_card: true } };
    const hass = { ...card._hass, states }; card.remove();
    const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16;
    window.jpeg = canvas.toDataURL('image/jpeg').split(',')[1];
    window.pageVisible = visible => { Object.defineProperty(document, 'visibilityState', { value: visible ? 'visible' : 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); };
    window.cards = entities.map(entity => { const each = document.createElement('eufy-viewer-card'); each.style.minHeight = '900px'; each.setConfig({ entity, live_mode: 'inline', live_autostart: true }); each.hass = hass; document.body.append(each); return each; });
    window.card = cards[0];
    window.inView = () => cards.map(each => each._visible);
    window.live = () => cards.map(each => each._open);
    window.started = () => calls.map(call => call.message.entity_id);
    window.frame = (index, sequence) => receivers[entities[index]]({ type: 'frame', subscription: index + 1, sequence, jpeg });
    window.ackCounts = () => [1, 2, 3].map(subscription => acks.filter(ack => ack.subscription === subscription).length);
  }, entities);
  // Only the first card is in view when the view opens, so only it starts. The others hold their trigger.
  await expect.poll(() => page.evaluate(() => inView())).toEqual([true, false, false]);
  await expect.poll(() => page.evaluate(() => started())).toEqual(['camera.front']);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => started())).toEqual(['camera.front']);
  await page.evaluate(() => frame(0, 1));
  await expect.poll(() => page.evaluate(() => ackCounts())).toEqual([1, 0, 0]);
  // Scrolling to the second card starts it. The first stays live and keeps acknowledging out of view.
  await page.evaluate(() => cards[1].scrollIntoView());
  await expect.poll(() => page.evaluate(() => inView())).toEqual([false, true, false]);
  await expect.poll(() => page.evaluate(() => started())).toEqual(['camera.front', 'camera.back']);
  await page.evaluate(() => { frame(0, 2); frame(1, 1); });
  await expect.poll(() => page.evaluate(() => ackCounts())).toEqual([2, 1, 0]);
  expect(await page.evaluate(() => ({ live: live(), closes: closeCount }))).toEqual({ live: [true, true, false], closes: 0 });
  // Scrolling to the third card starts it. All three stay live and acknowledge while two are out of view.
  await page.evaluate(() => cards[2].scrollIntoView());
  await expect.poll(() => page.evaluate(() => inView())).toEqual([false, false, true]);
  await expect.poll(() => page.evaluate(() => started())).toEqual(entities);
  await page.evaluate(() => { frame(0, 3); frame(1, 2); frame(2, 1); });
  await expect.poll(() => page.evaluate(() => ackCounts())).toEqual([3, 2, 1]);
  // Scrolling back to the top starts nothing: every card is still on its first session.
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(() => page.evaluate(() => inView())).toEqual([true, false, false]);
  await page.evaluate(() => { for (const each of cards) each.hass = { ...each._hass }; });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => ({ started: started(), live: live(), closes: closeCount }))).toEqual({ started: entities, live: [true, true, true], closes: 0 });
  await page.evaluate(() => { frame(0, 4); frame(1, 3); frame(2, 2); });
  await expect.poll(() => page.evaluate(() => ackCounts())).toEqual([4, 3, 2]);
  // A hidden page releases every session, the out-of-view ones included. Visible again: the card in view starts, the others wait for their scroll.
  await page.evaluate(() => pageVisible(false));
  await expect.poll(() => page.evaluate(() => closeCount)).toBe(3);
  expect(await page.evaluate(() => live())).toEqual([false, false, false]);
  await page.evaluate(() => pageVisible(true));
  await expect.poll(() => page.evaluate(() => started())).toEqual([...entities, 'camera.front']);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => calls.length)).toBe(4);
  await page.evaluate(() => cards[2].scrollIntoView());
  await expect.poll(() => page.evaluate(() => started())).toEqual([...entities, 'camera.front', 'camera.side']);
  await page.evaluate(() => cards[1].scrollIntoView());
  await expect.poll(() => page.evaluate(() => started())).toEqual([...entities, 'camera.front', 'camera.side', 'camera.back']);
  expect(await page.evaluate(() => live())).toEqual([true, true, true]);
  // Navigation removes the cards: every session stops and nothing starts while they are detached.
  await page.evaluate(() => { for (const each of cards) each.remove(); });
  await expect.poll(() => page.evaluate(() => closeCount)).toBe(6);
  await page.evaluate(() => { for (const each of cards) each.hass = { ...each._hass }; pageVisible(false); pageVisible(true); });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => calls.length)).toBe(6);
});

test('card editor offers automatic start only for the inline mode and stores false as an absent key', async ({ page }) => {
  const result = await page.evaluate(async () => {
    await customElements.whenDefined('eufy-viewer-card-editor');
    const editor = document.createElement('eufy-viewer-card-editor');
    const events = [];
    editor.addEventListener('config-changed', event => events.push(event.detail.config));
    document.body.append(editor);
    editor.setConfig({ entity: 'camera.front', live_mode: 'inline' });
    editor.hass = card._hass;
    const form = editor.querySelector('ha-form');
    const snapshot = () => ({ names: form.schema.map(field => field.name), selectors: form.schema.map(field => Object.keys(field.selector)[0]), data: form.data, labels: form.schema.map(field => form.computeLabel(field)), helpers: form.schema.map(field => form.computeHelper(field) ?? null) });
    const initial = snapshot();
    const change = value => form.dispatchEvent(new CustomEvent('value-changed', { detail: { value } }));
    change({ live_mode: 'inline', live_autostart: true });
    const enabled = snapshot();
    change({ live_mode: 'inline', live_autostart: true });
    change({ live_mode: 'inline', live_autostart: false });
    change({ live_mode: 'inline', live_autostart: true });
    change({ live_mode: 'dialog', live_autostart: true });
    const dialog = snapshot();
    change({ live_mode: 'inline' });
    editor.hass = { ...card._hass, language: 'nl' };
    return { initial, enabled, dialog, events, dutch: snapshot() };
  });
  const helper = 'Inline only. Starts the live view without a tap when the view opens, up to the HomeBase limit. Each card can be paused, resumed and stopped.';
  expect(result.initial).toEqual({ names: ['live_mode', 'live_autostart'], selectors: ['select', 'boolean'], data: { live_mode: 'inline', live_autostart: false }, labels: ['Live view', 'Start live automatically'], helpers: [null, helper] });
  expect(result.enabled.data).toEqual({ live_mode: 'inline', live_autostart: true });
  expect(result.dialog).toEqual({ names: ['live_mode'], selectors: ['select'], data: { live_mode: 'dialog' }, labels: ['Live view'], helpers: [null] });
  expect(result.events).toEqual([
    { entity: 'camera.front', live_mode: 'inline', live_autostart: true },
    { entity: 'camera.front', live_mode: 'inline' },
    { entity: 'camera.front', live_mode: 'inline', live_autostart: true },
    { entity: 'camera.front' },
    { entity: 'camera.front', live_mode: 'inline' },
  ]);
  expect(result.dutch).toEqual({ names: ['live_mode', 'live_autostart'], selectors: ['select', 'boolean'], data: { live_mode: 'inline', live_autostart: false }, labels: ['Livebeeld', 'Automatisch live starten'], helpers: [null, 'Alleen in de kaart. Start het livebeeld zonder tik zodra de weergave opent, tot de HomeBase-limiet. Elke kaart kan pauzeren, hervatten en stoppen.'] });
  expect(await page.evaluate(() => calls.length)).toBe(0);
});

// Narrow cards, about a phone in portrait: below 500 px of card width the inline live controls sit in a compact
// toolbar below the video and the paused bar below the snapshot, decided by the card's own width through a CSS
// container query. Wider cards keep the overlay on the video. Layout only: sessions, focus and messages are unchanged.
const layout = page => page.evaluate(() => {
  const rect = element => { const r = element.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) }; };
  const root = card.shadowRoot, stage = card._stage, paused = card._pausedBar, preview = card._preview;
  const media = card._video.hidden ? card._live : card._video;
  const bar = root.querySelector('.stage .bar');
  return { card: rect(root.querySelector('ha-card')), stage: stage.hidden ? null : rect(stage), media: stage.hidden ? null : rect(media), bar: stage.hidden ? null : rect(bar), buttons: stage.hidden ? [] : [...bar.querySelectorAll('button')].filter(button => !button.hidden).map(rect), paused: paused.hidden ? null : rect(paused), preview: preview.hidden ? null : rect(preview) };
});

test('a card narrower than 500 px shows its live controls in one toolbar row below the video and the paused bar below the snapshot', async ({ page }) => {
  await page.evaluate(() => { document.body.style.cssText = 'margin:0;width:360px;font:14px sans-serif'; card._hass.states['camera.front'].attributes.viewer_webrtc = true; });
  await attachAutostart(page);
  await expect.poll(() => page.evaluate(() => calls.length)).toBe(1);
  await expect(page.locator('ha-card video.video')).toBeVisible();
  let seen = await layout(page);
  expect(seen.card.width).toBe(360);
  // The video fills the card width at 16:9 and the toolbar starts where the video ends, inside the stage.
  expect(seen.media).toMatchObject({ top: seen.stage.top, width: 360 });
  expect(seen.media.height).toBeGreaterThanOrEqual(202);
  expect(seen.bar.top).toBeGreaterThanOrEqual(seen.media.bottom);
  expect(seen.bar.bottom).toBeLessThanOrEqual(seen.stage.bottom);
  // Pause, stop, sound and close share one compact row.
  expect(seen.buttons).toHaveLength(4);
  expect(new Set(seen.buttons.map(button => button.top)).size).toBe(1);
  expect(seen.bar.height).toBeLessThanOrEqual(56);
  for (const name of ['Pause', 'Stop', 'Enable sound', 'Close live view']) await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  expect(await page.evaluate(() => card.shadowRoot.activeElement === card._stopButton)).toBe(true);
  await expect(page.locator('.status')).toHaveText('Connecting…');
  // Pause: the toolbar goes with the stage and the paused bar sits below the snapshot, which keeps its size.
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect.poll(() => page.evaluate(() => closeCount)).toBe(1);
  seen = await layout(page);
  expect(seen).toMatchObject({ stage: null, bar: null, buttons: [] });
  expect(seen.paused.top).toBeGreaterThanOrEqual(seen.preview.bottom);
  expect(seen.paused.height).toBeLessThanOrEqual(64);
  expect(seen.preview.width).toBe(360);
  expect(seen.preview.height).toBeGreaterThanOrEqual(202);
  await expect(page.locator('ha-card .stage .bar')).toBeHidden();
  expect(await page.evaluate(() => card.shadowRoot.activeElement === card._resumeButton)).toBe(true);
  await expect(page.locator('.status')).toHaveText('Paused. Tap Resume to watch.');
  // Resume: a fresh session with the toolbar below the video again.
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect.poll(() => page.evaluate(() => calls.length)).toBe(2);
  seen = await layout(page);
  expect(seen.paused).toBeNull();
  expect(seen.bar.top).toBeGreaterThanOrEqual(seen.media.bottom);
  // Close: the plain snapshot without any bar.
  await page.getByRole('button', { name: 'Close live view', exact: true }).click();
  await expect.poll(() => page.evaluate(() => closeCount)).toBe(2);
  seen = await layout(page);
  expect(seen).toMatchObject({ stage: null, bar: null, paused: null });
  expect(seen.preview.height).toBeGreaterThanOrEqual(202);
  // The Dutch labels share the row as well.
  await page.evaluate(() => { card.hass = { ...card._hass, language: 'nl' }; });
  await page.getByRole('button', { name: 'Live bekijken' }).click();
  await expect.poll(() => page.evaluate(() => calls.length)).toBe(3);
  seen = await layout(page);
  expect(seen.bar.top).toBeGreaterThanOrEqual(seen.media.bottom);
  expect(seen.buttons).toHaveLength(4);
  expect(new Set(seen.buttons.map(button => button.top)).size).toBe(1);
});

test('a card of 500 px or wider keeps the controls on the video, and crossing the threshold while live only moves them', async ({ page }) => {
  await page.evaluate(() => { document.body.style.cssText = 'margin:0;width:700px;font:14px sans-serif'; card._hass.states['camera.front'].attributes.viewer_webrtc = true; });
  await attachAutostart(page);
  await expect.poll(() => page.evaluate(() => calls.length)).toBe(1);
  await expect(page.locator('ha-card video.video')).toBeVisible();
  let seen = await layout(page);
  expect(seen.card.width).toBe(700);
  // The overlay lies on the top of the video and the stage is exactly as tall as the video.
  expect(seen.bar.top).toBe(seen.media.top);
  expect(seen.bar.bottom).toBeLessThan(seen.media.bottom);
  expect(seen.stage.height).toBe(seen.media.height);
  expect(seen.buttons).toHaveLength(4);
  // The card's own width decides: 500 keeps the overlay, 499 moves the controls below the video, with no new session and no focus change.
  for (const [width, below] of [[500, false], [499, true], [360, true], [520, false]]) {
    await page.evaluate(width => { document.body.style.width = `${width}px`; }, width);
    seen = await layout(page);
    expect(seen.card.width, `${width}px`).toBe(width);
    expect(seen.bar.top >= seen.media.bottom, `${width}px`).toBe(below);
    expect(seen.bar.top === seen.media.top, `${width}px`).toBe(!below);
  }
  expect(await page.evaluate(() => ({ calls: calls.length, closes: closeCount, open: card._open, focused: card.shadowRoot.activeElement === card._stopButton }))).toEqual({ calls: 1, closes: 0, open: true, focused: true });
  // The paused bar overlays the snapshot on a wide card and moves below it on a narrow one.
  await page.evaluate(() => { document.body.style.width = '700px'; });
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect.poll(() => page.evaluate(() => closeCount)).toBe(1);
  seen = await layout(page);
  expect(seen.paused.top).toBe(seen.preview.top);
  expect(seen.paused.bottom).toBeLessThan(seen.preview.bottom);
  await page.evaluate(() => { document.body.style.width = '360px'; });
  seen = await layout(page);
  expect(seen.paused.top).toBeGreaterThanOrEqual(seen.preview.bottom);
  expect(await page.evaluate(() => card.shadowRoot.activeElement === card._resumeButton)).toBe(true);
});

test('the popup dialog keeps its own bar above the video whatever the card width', async ({ page }) => {
  await page.evaluate(() => { document.body.style.cssText = 'margin:0;width:360px;font:14px sans-serif'; });
  await page.getByRole('button', { name: 'Watch live' }).click();
  await expect(page.locator('dialog:not(.record-dialog)')).toBeVisible();
  const seen = await page.evaluate(() => {
    const top = element => Math.round(element.getBoundingClientRect().top);
    const bar = card.shadowRoot.querySelector('dialog .bar');
    return { stage: getComputedStyle(card._stage).display, position: getComputedStyle(bar).position, bar: top(bar), media: top(card._live) };
  });
  expect(seen).toMatchObject({ stage: 'block', position: 'static' });
  expect(seen.bar).toBeLessThan(seen.media);
  await page.getByRole('button', { name: 'Close live view' }).click();
  await expect.poll(() => page.evaluate(() => closeCount)).toBe(1);
});
