import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HTTPApi } from 'eufy-security-client';
import { normalizeSuccess } from '../src/sdk-compat.js';

test('new Eufy success code permits SDK profile loading without changing its payload', async () => {
  const profile = { user_id: 'fixture', nick_name: 'Fixture', email: 'fixture@example.invalid' };
  const original = { status: 200, data: { code: 200, data: 'encrypted-fixture' } };
  const client = { request: async () => normalizeSuccess(original), decryptAPIData: (value: string) => { assert.equal(value, 'encrypted-fixture'); return profile; }, persistentData: {} };
  const loaded = await HTTPApi.prototype.getPassportProfile.call(client as unknown as HTTPApi);
  assert.deepEqual(loaded, profile);
  assert.deepEqual(client.persistentData, profile);
  assert.equal(original.data.code, 200);
});

test('legacy success, authentication errors and HTTP failures remain unchanged', () => {
  for (const response of [
    { status: 200, data: { code: 0, data: {} } },
    { status: 200, data: { code: 26052 } },
    { status: 401, data: { code: 200 } },
    { status: 200, data: null },
    { status: 200, data: { code: '200' } },
  ]) assert.equal(normalizeSuccess(response), response);
});

test('country discovery preserves the endpoint and validates successful replies', async () => {
  const { resolveApiBase } = await import('../src/sdk-compat.js');
  for (const code of [0, 200]) {
    const request = (async (url: string, options: RequestInit) => {
      assert.equal(url, 'https://extend.eufylife.com/domain/NL');
      assert.ok(options.signal instanceof AbortSignal);
      return new Response(JSON.stringify({ code, data: { domain: 'security-app-eu.eufylife.com' } }));
    }) as typeof fetch;
    assert.equal(await resolveApiBase('NL', request), 'https://security-app-eu.eufylife.com');
  }
  for (const data of [{ code: 401 }, { code: 0, data: { domain: 'evil.invalid/path' } }, null]) {
    await assert.rejects(resolveApiBase('NL', (async () => new Response(JSON.stringify(data))) as typeof fetch));
  }
  await assert.rejects(resolveApiBase('../NL'));
  await assert.rejects(resolveApiBase('NL', (async () => new Response('', { status: 503 })) as typeof fetch));
});

test('country lookup cancels its pending request on timeout', async () => {
  const { resolveApiBase } = await import('../src/sdk-compat.js');
  let cancelled = false;
  // Keep the test alive while AbortSignal.timeout uses its unref'ed timer.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(resolveApiBase('NL', ((_url: unknown, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => { cancelled = true; reject(options.signal!.reason); }, { once: true });
    })) as typeof fetch, 10));
    assert.equal(cancelled, true);
  } finally { clearInterval(keepAlive); }
});
