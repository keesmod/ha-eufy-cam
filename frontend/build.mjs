import { readFile, writeFile, unlink } from 'node:fs/promises';
const root = new URL('../custom_components/eufy_viewer/frontend/', import.meta.url);
// Ship the shared playback helper and both cards as one HACS resource.
const files = ['recording-playback.js', 'eufy-viewer-card.js', 'eufy-events-card.js'];
const source = await Promise.all(files.map(file => readFile(new URL(file, root), 'utf8')));
await writeFile(new URL('eufy-viewer-card.js', root), source.join('\n'));
for (const file of ['recording-playback.js', 'eufy-events-card.js']) await unlink(new URL(file, root));
