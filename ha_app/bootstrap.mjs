// Supervisor owns /data/options.json. Read it once, then drop root privileges.
import { readFile, mkdir, chown } from 'node:fs/promises';
const options = JSON.parse(await readFile('/data/options.json', 'utf8'));
if (typeof options.token !== 'string' || options.token.length < 32) throw new Error('Configure a bridge token of at least 32 characters');
const directory = '/data/eufy';
await mkdir(directory, { recursive: true, mode: 0o700 });
await chown(directory, 1000, 1000);
process.env.EUFY_BRIDGE_TOKEN = options.token;
process.env.EUFY_DATA_DIR = directory;
process.setgroups([]);
process.setgid(1000);
process.setuid(1000);
await import('./dist/main.js');
