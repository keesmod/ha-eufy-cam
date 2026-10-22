// Runs as root in the built app image with --network none. Each case writes a
// synthetic /data/options.json and starts bootstrap.mjs as the app's CMD does.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const options = '/data/options.json';
const short = 'short-canary-token-0123456789ab';
const valid = 'valid-canary-token-0123456789abc';
assert.equal(short.length, 31);
assert.equal(valid.length, 32);

function start() {
  const child = spawn(process.execPath, ['bootstrap.mjs'], { cwd: '/app', stdio: ['ignore', 'pipe', 'pipe'] });
  const output = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8').on('data', text => { output.stdout += text; });
  child.stderr.setEncoding('utf8').on('data', text => { output.stderr += text; });
  return { child, output, exited: once(child, 'close') };
}

function tokenLine(received) {
  return `Configure a bridge token of at least 32 characters. This app received ${received}. Set token in this app's Configuration tab and save. Home Assistant replaces a !secret reference with its value from secrets.yaml before the app starts, so that value needs at least 32 characters as well.\n`;
}

const rejected = [
  ['an empty token', JSON.stringify({ token: '', diagnostics: false }), tokenLine('an empty token')],
  ['a short token', JSON.stringify({ token: short, diagnostics: false }), tokenLine('a token of 31 characters')],
  ['no token', JSON.stringify({ diagnostics: false }), tokenLine('no token')],
  ['a null token', JSON.stringify({ token: null }), tokenLine('no token')],
  ['a numeric token', JSON.stringify({ token: 12345678901234567890123456789012345 }), tokenLine('a token of type number')],
  ['null options', 'null', tokenLine('no token')],
  ['truncated JSON', `{\n  "token": "${short}"`, 'Cannot read the app options in /data/options.json (SyntaxError)\n'],
  ['no options file', null, 'Cannot read the app options in /data/options.json (ENOENT)\n'],
];

await mkdir('/data', { recursive: true });
for (const [name, content, expected] of rejected) {
  if (content === null) await rm(options, { force: true });
  else await writeFile(options, content);
  const { output, exited } = start();
  const [code] = await exited;
  assert.equal(code, 1, name);
  assert.equal(output.stdout, '', name);
  assert.equal(output.stderr, expected, name);
}
console.log('Rejected app options passed: one line, no token and no file content');

await writeFile(options, JSON.stringify({ token: valid, diagnostics: false }));
const { child, output, exited } = start();
try {
  let response;
  for (let attempt = 0; attempt < 100 && child.exitCode === null; attempt++) {
    try { response = await fetch('http://127.0.0.1:8063/v1/state', { headers: { Authorization: `Bearer ${valid}` } }); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.equal(response?.status, 200, output.stderr);
  const state = await response.json();
  assert.equal(state.protocol, 1);
  assert.equal(state.auth, 'unconfigured');
  assert.equal((await fetch('http://127.0.0.1:8063/v1/state')).status, 401);
  const directory = await stat('/data/eufy');
  assert.equal(directory.uid, 1000);
  assert.equal(directory.mode & 0o777, 0o700);
  // The bootstrap process itself becomes the bridge, so its ids show the privilege drop.
  const status = await readFile(`/proc/${child.pid}/status`, 'utf8');
  assert.match(status, /^Uid:\s+1000\s+1000\s+1000\s+1000$/m);
  assert.match(status, /^Gid:\s+1000\s+1000\s+1000\s+1000$/m);
  assert.match(status, /^Groups:\s*$/m);
  console.log('A 32-character token passed bootstrap, the privilege drop and authentication');
} finally {
  child.kill('SIGTERM');
  const [code] = await exited;
  assert.equal(code, 0, output.stderr);
  assert.ok(!`${output.stdout}${output.stderr}`.includes(valid));
  console.log('Graceful app shutdown passed without logging the token');
}
