import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamHub, type Peer } from "../src/streams.js";
import { JpegFramer } from "../src/jpeg.js";

function fixture() {
  let now = 0;
  const starts: string[] = [], stops: string[] = [], disposed: string[] = [];
  const hub = new StreamHub({ start: async s => { starts.push(s); }, stop: async s => { stops.push(s); }, disposeMedia: s => { disposed.push(s); } }, () => now);
  const peer = () => { const frames: Buffer[] = [], closed: string[] = []; return { frames, closed, bufferedAmount: 0, send: (f: Buffer) => frames.push(f), close: (_code: number, reason: string) => closed.push(reason) }; };
  return { hub, starts, stops, disposed, peer, time: (t: number) => { now = t; } };
}

test("idle has no starts; shared viewers start once and final close stops", () => {
  const { hub, starts, stops, peer } = fixture(); const a = peer(), b = peer();
  hub.tick(); assert.equal(starts.length, 0);
  hub.attach("a", a); hub.attach("a", b); assert.deepEqual(starts, ["a"]);
  hub.detach("a", a); assert.equal(stops.length, 0);
  hub.detach("a", b); assert.deepEqual(stops, ["a"]);
});
test("frozen viewer expires even while video and synthetic heartbeat continue", () => {
  const { hub, time, peer, stops } = fixture(); const p = peer(); hub.attach("a", p);
  time(19_000); hub.ack("a", p); // Nothing delivered: no renewal.
  time(20_000); hub.tick(); assert.deepEqual(stops, ["a"]);
});
test("one outstanding frame, duplicate acknowledgements do not extend lease", () => {
  const { hub, time, peer, stops } = fixture(); const p = peer(); hub.attach("a", p);
  hub.frame("a", Buffer.from("one")); hub.frame("a", Buffer.from("two")); assert.equal(p.frames.length, 1);
  time(5000); hub.ack("a", p); time(14000); hub.ack("a", p);
  time(15000); hub.tick(); assert.deepEqual(stops, ["a"]);
});
test("late start after close is stopped; quarantined camera cannot be restarted", () => {
  const { hub, peer, starts, stops } = fixture(); const p = peer(); hub.attach("a", p); hub.detach("a", p);
  assert.equal(hub.started("a"), false); assert.equal(stops.length, 2);
  assert.equal(hub.attach("a", peer()), false); assert.equal(starts.length, 1);
  hub.stopped("a"); assert.equal(hub.attach("a", peer()), true); assert.equal(starts.length, 2);
});
test("absolute cap wins over active acknowledgements", () => {
  const { hub, time, peer, stops } = fixture(); const p = peer(); hub.attach("a", p);
  for (let t = 0; t <= 120_000; t += 1000) { time(t); hub.frame("a", Buffer.from("frame")); hub.ack("a", p); hub.tick(); }
  assert.deepEqual(stops, ["a"]);
});
test("stop retries bounded and quarantine retained until physical stop event", () => {
  const { hub, time, peer, stops } = fixture(); const p = peer(); hub.attach("a", p); hub.detach("a", p);
  for (let t = 0; t < 30_000; t += 1000) { time(t); hub.tick(); }
  assert.equal(stops.length, 3); assert.equal(hub.quarantined, 1);
  hub.stopped("a"); assert.equal(hub.quarantined, 0);
});
test("slow or disconnected viewer does not affect other viewer", () => {
  const { hub, peer, time, stops } = fixture(); const a = peer(), b = peer(); hub.attach("a", a); hub.attach("a", b);
  for (let t = 0; t <= 20_000; t += 1000) { time(t); hub.frame("a", Buffer.from("frame")); hub.ack("a", b); hub.tick(); }
  assert.equal(a.frames.length, 1); assert.ok(b.frames.length > 10); assert.equal(stops.length, 0);
  hub.detach("a", b); assert.equal(stops.length, 1);
});
test("rejected start stops owned camera and closes viewer", async () => {
  const stops: string[] = []; const p: Peer = { bufferedAmount: 0, send: () => {}, close: () => {} };
  const hub = new StreamHub({ start: async () => { throw new Error("failure"); }, stop: async s => { stops.push(s); }, disposeMedia: () => {} });
  hub.attach("a", p); await Promise.resolve(); await Promise.resolve(); assert.deepEqual(stops, ["a"]);
});
test("JPEG parser handles split markers, concatenated frames and oversized data", () => {
  const frames: Buffer[] = []; const parser = new JpegFramer(f => frames.push(f));
  const jpeg = Buffer.from([255, 216, 1, 2, 255, 217]);
  for (const byte of Buffer.concat([jpeg, jpeg])) parser.push(Buffer.from([byte]));
  assert.equal(frames.length, 2); assert.deepEqual(frames[0], jpeg);
  assert.throws(() => parser.push(Buffer.alloc(1_048_577)));
});

test("recording admission rejection creates no camera or quarantine", () => {
  const hub = new StreamHub({ admit: () => false, start: async () => { assert.fail("must not start"); }, stop: async () => { assert.fail("must not stop"); }, disposeMedia: () => {} });
  assert.equal(hub.attach("a", fixture().peer()), false);
  assert.equal(hub.active, 0); assert.equal(hub.quarantined, 0);
});

test("missing stop event resets idle transport once; admission remains blocked until confirmed", async () => {
  let now = 0; let recoveries = 0;
  let confirm!: (serials: string[]) => void;
  const hub = new StreamHub({ start: async () => {}, stop: async () => {}, disposeMedia: () => {}, recover: async () => { recoveries++; return new Promise(resolve => { confirm = resolve; }); } }, () => now);
  const a = fixture().peer(); hub.attach("a", a); hub.detach("a", a);
  await new Promise(resolve => setImmediate(resolve));
  for (now = 3000; now <= 9000; now += 3000) hub.tick();
  assert.equal(recoveries, 1); assert.equal(hub.quarantined, 1);
  assert.equal(hub.attach("b", fixture().peer()), false);
  hub.stopped("a"); assert.equal(hub.quarantined, 1); // SDK may emit this during transport close.
  confirm(["a"]); await new Promise(resolve => setImmediate(resolve));
  assert.equal(hub.quarantined, 0); assert.equal(hub.recoveryMetrics.recovery_completed, 1);
  assert.equal(hub.attach("b", fixture().peer()), true);
});

test("recovery waits for other viewers and pending starts; failed reset retains quarantine without a retry loop", async () => {
  let now = 0; let resolveStart!: () => void; let recoveries = 0;
  const hub = new StreamHub({ start: async s => { if (s === "a") await new Promise<void>(resolve => { resolveStart = resolve; }); }, stop: async () => {}, disposeMedia: () => {}, recover: async () => { recoveries++; throw new Error("unconfirmed"); } }, () => now);
  const a = fixture().peer(), b = fixture().peer(); hub.attach("a", a); hub.detach("a", a); hub.attach("b", b);
  for (now = 3000; now <= 9000; now += 3000) hub.tick();
  assert.equal(recoveries, 0);
  hub.stopped("b"); hub.tick(); assert.equal(recoveries, 0);
  resolveStart(); await new Promise(resolve => setImmediate(resolve)); hub.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(recoveries, 1); assert.equal(hub.quarantined, 1);
  for (now = 15000; now < 60000; now += 3000) hub.tick();
  assert.equal(recoveries, 1); assert.equal(hub.recoveryMetrics.recovery_failed, 1);
});

test("Eufy recovery requires transport close and returns only cameras on that HomeBase", async () => {
  const { EventEmitter } = await import("node:events");
  const { Eufy } = await import("../src/eufy.js");
  const { Storage } = await import("../src/storage.js");
  const eufy = new Eufy(new Storage("/unused-test-storage"));
  const station = Object.assign(new EventEmitter(), { isConnected: () => true, getSerial: () => "BASE", close: () => {} });
  const a = { getStationSerial: () => "BASE", getSerial: () => "a" };
  const { LegacyBackend } = await import("../src/legacy-backend.js");
  const backend = new LegacyBackend(new Storage("/unused-test-storage"), () => false);
  (eufy as unknown as { backend: unknown }).backend = backend;
  const internal = backend as unknown as { client: unknown; devices: Map<string, unknown>; recoverStation(serial: string): Promise<string[]> };
  internal.client = { getDevice: async () => a, getStation: async () => station };
  internal.devices.set("a", a); internal.devices.set("b", { getStationSerial: () => "OTHER", getSerial: () => "b" });
  let finished = false;
  const reset = internal.recoverStation("a").then(serials => { finished = true; return serials; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false);
  station.emit("close", station); assert.deepEqual(await reset, ["a"]);
  assert.equal(station.listenerCount("close"), 0);
  station.isConnected = () => false;
  await assert.rejects(internal.recoverStation("a"), /not confirmed/);
});
