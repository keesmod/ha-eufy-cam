// Runs with --network none: no Eufy/HA/physical network is reachable.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
const child = spawn(process.execPath, ['dist/main.js'], { stdio: 'inherit' });
try {
  let response;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { response = await fetch('http://127.0.0.1:8080/v1/state', { headers: { Authorization: `Bearer ${process.env.EUFY_BRIDGE_TOKEN}` } }); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.equal(response?.status, 200);
  const state = await response.json();
  assert.equal(state.protocol, 1);
  assert.equal(state.auth, 'unconfigured');
  assert.deepEqual(state.cameras, []);
  assert.equal((await fetch('http://127.0.0.1:8080/v1/state')).status, 401);
  console.log('Container startup, authentication and empty-account state passed');
} finally {
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const [code] = await exited;
  assert.equal(code, 0);
  console.log('Graceful container shutdown passed');
}
