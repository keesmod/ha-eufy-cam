// Supervisor owns /data/options.json. Read it once, then drop root privileges.
import { writeSync } from 'node:fs';
import { readFile, mkdir, chown } from 'node:fs/promises';
// One log line without option values. A synchronous write survives process.exit.
function stop(message) {
  writeSync(2, `${message}\n`);
  process.exit(1);
}
let options;
// A JSON parse error quotes the file line, which can hold the token.
try { options = JSON.parse(await readFile('/data/options.json', 'utf8')); }
catch (error) { stop(`Cannot read the app options in /data/options.json (${error.code ?? error.name})`); }
const token = options?.token;
if (typeof token !== 'string' || token.length < 32) {
  const received = token == null ? 'no token' : typeof token !== 'string' ? `a token of type ${typeof token}` : token === '' ? 'an empty token' : `a token of ${token.length} characters`;
  // From Supervisor 2026.09.3 the UI and API show a !secret reference, while options.json gets its value.
  stop(`Configure a bridge token of at least 32 characters. This app received ${received}. Set token in this app's Configuration tab and save. Home Assistant replaces a !secret reference with its value from secrets.yaml before the app starts, so that value needs at least 32 characters as well.`);
}
const directory = '/data/eufy';
await mkdir(directory, { recursive: true, mode: 0o700 });
await chown(directory, 1000, 1000);
process.env.EUFY_BRIDGE_TOKEN = token;
process.env.EUFY_DATA_DIR = directory;
// Host networking is required for the verified Mega LAN discovery path.
// Only local HA and its managed media service need access to this API.
process.env.BIND_ADDRESS = '127.0.0.1';
process.env.PORT = '8063';
process.env.EUFY_DIAGNOSTICS = options.diagnostics === true ? 'true' : 'false';
// Optional live encoder cap such as 4M or 2500k; the bridge validates and defaults to 4M.
if (typeof options.live_max_bitrate === 'string' && options.live_max_bitrate.trim()) process.env.EUFY_LIVE_MAX_BITRATE = options.live_max_bitrate.trim();
// Optional concurrent live cameras per HomeBase, 1 to 4; the bridge validates and defaults to 1.
if (Number.isInteger(options.live_max_streams_per_station)) process.env.EUFY_LIVE_MAX_STREAMS_PER_STATION = String(options.live_max_streams_per_station);
// Optional session cap for cameras without a battery value, 120 to 3600 seconds; the bridge validates and defaults to 120.
if (Number.isInteger(options.live_max_seconds_mains)) process.env.EUFY_LIVE_MAX_SECONDS_MAINS = String(options.live_max_seconds_mains);
// Optional experimental standalone cameras, off unless explicitly true.
if (options.experimental_standalone === true) process.env.EUFY_EXPERIMENTAL_STANDALONE = 'true';
// Optional recording probe of experimental standalone cameras during the login discovery, off unless explicitly true.
if (options.standalone_recording_probe === true) process.env.EUFY_STANDALONE_RECORDING_PROBE = 'true';
// Old Supervisor options may still contain legacy. Only the Mega migration
// service starts, and its saved-inventory gate prevents importing old credentials.
process.env.EUFY_BACKEND = options.backend === 'legacy' ? 'mega' : (options.backend ?? 'mega');
process.setgroups([]);
process.setgid(1000);
process.setuid(1000);
await import('./dist/main.js');
