// Reproducible public walkthrough: released UI, generated media, no live account.
// Run from frontend: node create-demo.mjs (Playwright Chromium and FFmpeg required).
import { chromium, expect } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const output = fileURLToPath(new URL('../docs/media/', import.meta.url));
const scratch = fileURLToPath(new URL('../artifacts/public-demo/', import.meta.url));
await mkdir(output, { recursive: true });
await mkdir(scratch, { recursive: true });
const source = await readFile(new URL('../custom_components/eufy_viewer/frontend/eufy-viewer-card.js', import.meta.url), 'utf8');
const browser = await chromium.launch();
try {
  const art = await browser.newPage();
  const cameras = ['Front door', 'Garden', 'Doorbell', 'Side gate'];
  const previews = [];
  for (let index = 0; index < cameras.length; index++) {
    const png = await art.evaluate(({ name, index }) => {
      const c = document.createElement('canvas'); c.width = 640; c.height = 360;
      const x = c.getContext('2d');
      x.fillStyle = ['#163949', '#21433a', '#303951', '#38433a'][index]; x.fillRect(0, 0, 640, 360);
      x.fillStyle = '#71978a'; x.fillRect(0, 245, 640, 115);
      x.fillStyle = '#b7d2c5'; x.fillRect(230, 118, 170, 150);
      x.fillStyle = '#729c97'; x.beginPath(); x.moveTo(210, 120); x.lineTo(315, 45); x.lineTo(420, 120); x.fill();
      x.fillStyle = '#234b53'; x.fillRect(294, 188, 44, 80); x.fillRect(249, 145, 32, 32); x.fillRect(349, 145, 32, 32);
      for (const px of [115, 520]) {
        x.fillStyle = '#bbbea0'; x.fillRect(px - 7, 160, 14, 115);
        x.fillStyle = '#548e79'; x.beginPath(); x.arc(px, 155, 49, 0, 2 * Math.PI); x.fill();
      }
      x.fillStyle = '#10242edb'; x.fillRect(0, 292, 640, 68);
      x.fillStyle = '#ffffff'; x.font = 'bold 23px sans-serif'; x.fillText(name, 22, 323);
      x.fillStyle = '#c2d4d8'; x.font = '14px sans-serif'; x.fillText('GENERATED EXAMPLE MEDIA', 22, 346);
      return c.toDataURL('image/jpeg', 0.9).split(',')[1];
    }, { name: cameras[index], index });
    previews.push(Buffer.from(png, 'base64'));
  }
  await art.close();
  await writeFile(`${scratch}example.jpg`, previews[1]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-loop', '1', '-i', `${scratch}example.jpg`, '-vf', 'zoompan=z=1+on*0.0007:d=60:s=640x360:fps=15', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${scratch}example.mp4`]);
  const mp4 = await readFile(`${scratch}example.mp4`);
  const context = await browser.newContext({ viewport: { width: 1280, height: 880 }, recordVideo: { dir: scratch, size: { width: 1280, height: 880 } }, locale: 'en-GB' });
  const page = await context.newPage();
  const rows = Array.from({ length: 24 }, (_, i) => ({ id: (i + 1).toString(16).padStart(32, '0'), entity_id: `camera.example_${i % 4}`, start: `2026-09-05T${String(18 - Math.floor(i / 4)).padStart(2, '0')}:${String(48 - i).padStart(2, '0')}:00`, end: `2026-09-05T${String(18 - Math.floor(i / 4)).padStart(2, '0')}:${String(48 - i).padStart(2, '0')}:04`, thumbnail: true }));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://eufy-demo.invalid') throw new Error(`Unexpected demo request: ${url.origin}`);
    if (url.pathname === '/api/eufy_viewer/events') return route.fulfill({ json: url.searchParams.has('month') ? { days: ['2026-09-01', '2026-09-03', '2026-09-05'], scope: 'homebase' } : { recordings: rows, complete: true } });
    if (url.pathname.endsWith('/thumbnail')) {
      const id = url.pathname.split('/').at(-2);
      return route.fulfill({ contentType: 'image/jpeg', body: previews[(parseInt(id, 16) - 1) % 4] });
    }
    if (url.pathname.startsWith('/api/eufy_viewer/recordings/')) return route.fulfill({ contentType: 'video/mp4', body: mp4 });
    if (url.pathname !== '/') throw new Error(`Unexpected demo route: ${url.pathname}`);
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><meta charset="utf-8"><style>body{margin:0;background:#10232d;color:#edf5f7;font:15px Arial,sans-serif}header{padding:22px 34px 18px}h1{font-size:26px;margin:0 0 7px}p{margin:0;color:#c4d8df}main{margin:0 30px}#step{margin:12px 30px;padding:13px 18px;border-left:4px solid #55c7bd;color:#e8f7f6;background:#193642}footer{margin:12px 32px;font-size:12px;color:#aac1ca}</style><header><h1>Eufy Security Viewer</h1><p>Existing HomeBase recordings, in your Home Assistant dashboard.</p></header><div id="step">Choose a date to browse recordings</div><main></main><footer>UI DEMONSTRATION · Generated example media &amp; simulated responses · Actual hardware evidence linked in README</footer></html>` });
  });
  await page.goto('http://eufy-demo.invalid');
  await page.addScriptTag({ content: source, type: 'module' });
  await page.evaluate(async names => {
    await customElements.whenDefined('eufy-events-card');
    const card = document.createElement('eufy-events-card');
    card.setConfig({ title: 'HomeBase events' }); document.querySelector('main').append(card);
    card.hass = { language: 'en-GB', connection: new EventTarget(), states: Object.fromEntries(names.map((name, i) => [`camera.example_${i}`, { state: 'idle', attributes: { viewer_card: true, friendly_name: name } }])), fetchWithAuth: (path, init) => fetch(path, init) };
  }, cameras);
  const step = async text => { await page.locator('#step').evaluate((node, value) => { node.textContent = value; }, text); };
  await page.waitForTimeout(1800);
  await page.locator('.date').fill('2026-09-05');
  await page.getByRole('button', { name: 'Show recordings', exact: true }).click();
  await expect(page.locator('.preview img')).toHaveCount(12);
  await step('1 / 4   Browse a day of stored events across your cameras');
  await page.screenshot({ path: `${output}events-timeline.png` });
  await page.waitForTimeout(2600);
  await page.locator('summary').click();
  await expect(page.locator('.marked')).toHaveCount(3);
  await step('Recording-day calendar · marks cover the whole HomeBase');
  await page.waitForTimeout(2200);
  await page.locator('summary').click();
  await page.locator('.camera').selectOption('camera.example_1');
  await expect(page.locator('.event')).toHaveCount(6);
  await step('2 / 4   Filter to a camera');
  await page.waitForTimeout(2300);
  await step('3 / 4   Select an event to play its recording');
  await page.locator('.event').first().click();
  await expect.poll(() => page.locator('video').evaluate(v => v.currentTime)).toBeGreaterThan(0.1);
  await page.screenshot({ path: `${scratch}playback-check.png` });
  await page.waitForTimeout(2700);
  await page.getByRole('button', { name: 'Next recording', exact: true }).click();
  await expect.poll(() => page.locator('video').evaluate(v => v.currentTime)).toBeGreaterThan(0.1);
  await page.waitForTimeout(2200);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('video')).not.toHaveAttribute('src');
  await step('4 / 4   Close to clear playback · install the bridge + HACS integration');
  await page.waitForTimeout(2600);
  const videoPath = await page.video().path();
  await context.close();
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', videoPath, '-c:v', 'libx264', '-crf', '24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${output}events-demo.mp4`]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', `${output}events-demo.mp4`, '-filter_complex', 'fps=5,scale=880:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer', '-loop', '0', `${output}events-demo.gif`]);
  console.log('Created public GIF, MP4 and screenshot from the released card with generated media.');
} finally {
  await browser.close();
}
