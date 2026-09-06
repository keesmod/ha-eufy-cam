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
