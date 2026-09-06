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
