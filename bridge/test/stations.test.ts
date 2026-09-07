import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { EufySecurity } from "eufy-security-client";
import { Stations } from "../src/stations.js";
import { createBridge } from "../src/server.js";
import type { Eufy } from "../src/eufy.js";
import { StreamHub } from "../src/streams.js";

function fixture(timeout = 1000) {
  const calls: unknown[] = [];
  const props: Record<string, unknown> = { guardMode: 1, currentMode: 1, alarm: false };
  let connected = true;
  const station = {
    getSerial: () => "HB3", getName: () => "HomeBase 3", getModel: () => "T8030",
    getHardwareVersion: () => "1", getSoftwareVersion: () => "2",
    isConnected: () => connected, hasProperty: (p: string) => p in props,
    getPropertyValue: (p: string) => props[p],
    getPropertyMetadata: () => ({ states: {0: "Away", 1: "Home", 63: "Disarmed"} }),
  };
  const sdk = Object.assign(new EventEmitter(), {
    isConnected: () => true,
    setStationProperty: async (...args: unknown[]) => { calls.push(args); },
  });
  let changes = 0;
  const stations = new Stations(sdk as unknown as EufySecurity, () => { changes++; }, timeout);
  sdk.emit("station added", station);
  const ack = (mode: number, code = 0) => sdk.emit("station command result", station,
    {return_code: code, customData: {property: {name: "guardMode", value: mode}}});
  return { stations, sdk, station, calls, props, ack, changes: () => changes,
    disconnect: () => { connected = false; sdk.emit("station close", station); } };
}

test("mode commands require correlated station ACK; state changes only with telemetry", async () => {
  const f = fixture();
  try {
    let done = false;
    const task = f.stations.setMode("HB3", 0).then(() => { done = true; });
    await assert.rejects(f.stations.setMode("HB3", 1), /station_busy/);
    f.ack(1); await Promise.resolve(); assert.equal(done, false);
    assert.equal(f.stations.inventory()[0]!.current_mode, 1);
    f.ack(0); await task;
    assert.equal(f.stations.inventory()[0]!.current_mode, 1);
    f.props.currentMode = 0; f.sdk.emit("station property changed", f.station, "currentMode", 0);
    assert.equal(f.stations.inventory()[0]!.current_mode, 0);
    assert.ok(f.changes() > 1);
    assert.deepEqual(f.calls, [["HB3", "guardMode", 0]]);
    const rejected = f.stations.setMode("HB3", 1); f.ack(1, -1);
    await assert.rejects(rejected, /station_rejected/);
    for (const invalid of [true, "1", 4, 999]) await assert.rejects(f.stations.setMode("HB3", invalid), /invalid_mode/);
    const disconnected = f.stations.setMode("HB3", 1); f.disconnect();
    await assert.rejects(disconnected, /station_unavailable/);
    assert.equal(f.stations.inventory()[0]!.connected, false);
    await assert.rejects(f.stations.setMode("HB3", 1), /station_unavailable/);
  } finally { f.stations.close(); }
  assert.equal(f.sdk.listenerCount("station command result"), 0);
});

test("a timeout blocks ambiguous retries until a new station connection", async () => {
  const f = fixture(20);
  try {
    await assert.rejects(f.stations.setMode("HB3", 0), /station_unconfirmed/);
    await assert.rejects(f.stations.setMode("HB3", 0), /station_unconfirmed/);
    f.sdk.emit("station connect", f.station);
    const task = f.stations.setMode("HB3", 1); f.ack(1); await task;
    assert.equal(f.calls.length, 2);
  } finally { f.stations.close(); }
});

test("station HTTP control requires authentication and never exposes SDK errors", async () => {
  const f = fixture();
  const fake = Object.assign(new EventEmitter(), {
    stations: f.stations, auth: {state: "connected"}, inventory: () => [],
    hub: new StreamHub({start: async () => {}, stop: async () => {}, disposeMedia: () => {}}),
  });
  const server = createBridge(fake as unknown as Eufy, "x".repeat(32), "fixture");
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/v1/stations/HB3/mode`;
  try {
    assert.equal((await fetch(url, {method: "POST", body: '{"mode":0}'})).status, 401);
    const headers = {Authorization: `Bearer ${"x".repeat(32)}`};
    assert.equal((await fetch(url, {method: "POST", headers, body: '{"mode":99}'})).status, 400);
    assert.equal(f.calls.length, 0);
    f.disconnect();
    const response = await fetch(url, {method: "POST", headers, body: '{"mode":0}'});
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {error: "station_unavailable"});
  } finally { f.stations.close(); server.emit("shutdown"); server.close(); await once(server, "close"); }
});
