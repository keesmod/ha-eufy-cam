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

test('experimental software is visible while live remains explicitly user started', async ({ page }) => {
  await page.evaluate(() => {
    card._hass.states['camera.front'].attributes.capabilities = { live: { available: true, status: 'experimental', reason: null } };
    card.hass = card._hass;
  });
  await expect(page.locator('.capability')).toContainText('experimental, hardware not confirmed');
  await expect(page.getByRole('button', { name: 'Watch live' })).toBeEnabled();
  expect(await page.evaluate(() => calls.length)).toBe(0);
});
