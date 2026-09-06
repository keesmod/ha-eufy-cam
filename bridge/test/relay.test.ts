import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { MediaRelay } from '../src/media.js';

test('revoking one grant closes its existing readers while another viewer remains', () => {
  const relay = new MediaRelay(() => {});
  const response = () => Object.assign(new EventEmitter(), {
    destroyed: false,
    writeHead() {},
    destroy() { this.destroyed = true; this.emit('close'); },
  });
  const first = relay.grant('camera'); const second = relay.grant('camera');
  const a = response(); const b = response();
  assert.equal(relay.serve(first, a as unknown as ServerResponse), true);
  assert.equal(relay.serve(second, b as unknown as ServerResponse), true);
  relay.revoke(first);
  assert.equal(a.destroyed, true); assert.equal(b.destroyed, false);
  assert.equal(relay.serve(first, response() as unknown as ServerResponse), false);
  relay.stop('camera'); assert.equal(b.destroyed, true);
  assert.equal(relay.serve(second, response() as unknown as ServerResponse), false);
});
