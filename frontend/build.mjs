import { readFile, appendFile, unlink } from 'node:fs/promises';
const root = new URL('../custom_components/eufy_viewer/frontend/', import.meta.url);
// Ship both custom elements through the existing single HACS resource.
const events = new URL('eufy-events-card.js', root);
await appendFile(new URL('eufy-viewer-card.js', root), '\n' + await readFile(events, 'utf8'));
await unlink(events);
