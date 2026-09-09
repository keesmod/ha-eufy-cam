import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type { Credentials, Eufy } from "./eufy.js";
import { RecordingError } from "./recordings.js";
import { StationError } from "./stations.js";
import type { Notification } from "./notifications.js";
import type { Peer } from "./streams.js";

function authorized(request: IncomingMessage, token: string): boolean {
  const supplied = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  let length = 0; const parts: Buffer[] = [];
  for await (const part of request) { length += part.length; if (length > 8192) throw new Error("Body too large"); parts.push(part); }
  const result: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid body");
  return result as Record<string, unknown>;
}
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(JSON.stringify(value));
}
export function createBridge(eufy: Eufy, token: string, bridgeId: string) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  const state = () => ({ protocol: 1, transports: ["jpeg", "webrtc"], bridge_id: bridgeId, auth: eufy.auth.state, notification_metrics: eufy.notifications?.metrics, cameras: eufy.inventory(), stations: eufy.stations?.inventory() ?? [], alarm_metrics: eufy.stations?.metrics, recording_metrics: eufy.recordings ? { ...eufy.recordings.metrics, active: eufy.recordings.busy } : undefined, stream_metrics: { ...eufy.metrics, ...eufy.hub.recoveryMetrics, active_cameras: eufy.hub.active, quarantined: eufy.hub.quarantined } });
  const server = createServer((request, response) => {
    const media = /^\/v1\/media\/([a-f0-9]{64})$/.exec(new URL(request.url ?? "/", "http://bridge").pathname);
    if (request.method === "GET" && media) {
      if (!eufy.media.serve(media[1]!, response)) json(response, 404, { error: "not_found" });
      return;
    }
    if (!authorized(request, token)) { json(response, 401, { error: "unauthorized" }); return; }
    void (async () => {
      const url = new URL(request.url ?? "/", "http://bridge");
      if (request.method === "GET" && url.pathname === "/v1/state") { json(response, 200, state()); return; }
      const station = /^\/v1\/stations\/([A-Za-z0-9_-]{1,64})\/mode$/.exec(url.pathname);
      if (request.method === "POST" && station) {
        const input = await body(request);
        if (!eufy.stations) throw new StationError("station_unavailable");
        await eufy.stations.setMode(station[1]!, input.mode);
        json(response, 200, { accepted: true }); return;
      }
      if (request.method === "POST" && url.pathname === "/v1/login") {
        const input = await body(request);
        let credentials: Credentials | undefined;
        if (typeof input.username === "string" && typeof input.password === "string" && typeof input.country === "string" && /^[A-Za-z]{2}$/.test(input.country)) {
          credentials = { username: input.username, password: input.password, country: input.country.toUpperCase() };
        } else if (input.username !== undefined || input.password !== undefined) throw new Error("Invalid credentials");
        const options = typeof input.verifyCode === "string" ? { force: false, verifyCode: input.verifyCode } : typeof input.captcha === "string" && typeof input.captchaId === "string" ? { force: false, captcha: { captchaCode: input.captcha, captchaId: input.captchaId } } : undefined;
        json(response, 200, await eufy.login(credentials, options)); return;
      }
      if (request.method === "GET" && ["/v1/recordings", "/v1/recording-days"].includes(url.pathname)) {
        const serials = [...new Set((url.searchParams.get("cameras") ?? "").split(","))];
        if (!serials.length || serials.length > 100 || serials.some(s => !/^[A-Za-z0-9_-]{1,64}$/.test(s) || !eufy.hasCamera(s))) throw new Error("Invalid cameras");
        const cancel = new AbortController(); const abort = () => cancel.abort(); response.once("close", abort);
        try {
          const data = url.pathname === "/v1/recording-days"
            ? await eufy.recordings.calendar(serials, url.searchParams.get("month") ?? "", cancel.signal)
            : await eufy.recordings.timeline(serials, url.searchParams.get("date") ?? "", cancel.signal);
          if (!response.destroyed) json(response, 200, data);
        } finally { response.off("close", abort); }
        return;
      }
      const recording = /^\/v1\/recordings\/([A-Za-z0-9_-]{1,64})(?:\/([a-f0-9]{32})\/(video|thumbnail))?$/.exec(url.pathname);
      if (request.method === "GET" && recording && eufy.hasCamera(recording[1]!)) {
        const cancel = new AbortController();
        const abort = () => cancel.abort(); response.once("close", abort);
        try {
          if (recording[2]) {
            const format = url.searchParams.get("format") ?? "h264";
            if (format !== "h264" && format !== "native") throw new Error("Invalid recording format");
            const data = recording[3] === "thumbnail"
              ? await eufy.recordings.thumbnail(recording[1]!, recording[2], cancel.signal)
              : await eufy.recordings.video(recording[1]!, recording[2], cancel.signal, format);
            if (!response.destroyed) { response.writeHead(200, { "Content-Type": recording[3] === "thumbnail" ? "image/jpeg" : "video/mp4", "Content-Length": data.length, "Cache-Control": "no-store" }); response.end(data); }
          } else {
            const data = await eufy.recordings.list(recording[1]!, url.searchParams.get("date") ?? "", cancel.signal);
            if (!response.destroyed) json(response, 200, data);
          }
        } finally { response.off("close", abort); }
        return;
      }
      const match = /^\/v1\/snapshot\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname);
      if (request.method === "GET" && match?.[1]) {
        const picture = eufy.pictures.get(match[1]);
        if (!picture) { json(response, 404, { error: "no_snapshot" }); return; }
        response.writeHead(200, { "Content-Type": picture.mime, "Content-Length": picture.data.length, "Cache-Control": "no-store" }); response.end(picture.data); return;
      }
      json(response, 404, { error: "not_found" });
    })().catch(error => { if (!response.headersSent) json(response, (error instanceof RecordingError || error instanceof StationError) ? error.status : 400, { error: (error instanceof RecordingError || error instanceof StationError) ? error.code : "request_failed" }); else response.destroy(); });
  });
  server.requestTimeout = 60_000; server.headersTimeout = 10_000;
  server.on("upgrade", (request, socket, head) => {
    if (!authorized(request, token) || request.headers.origin || sockets.clients.size >= 40) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); socket.destroy(); return;
    }
    const path = new URL(request.url ?? "/", "http://bridge").pathname;
    const live = /^\/v1\/live\/([A-Za-z0-9_-]{1,64})$/.exec(path);
    if (path !== "/v1/events" && (!live?.[1] || !eufy.hasCamera(live[1]) || eufy.auth.state !== "connected")) { socket.destroy(); return; }
    sockets.handleUpgrade(request, socket, head, ws => {
      ws.on("error", () => ws.terminate());
      if (path === "/v1/events") {
        const changed = () => { if (ws.readyState === WebSocket.OPEN) { if (ws.bufferedAmount > 1_000_000) ws.terminate(); else ws.send(JSON.stringify(state())); } };
        const notification = (event: Notification) => {
          if (ws.readyState === WebSocket.OPEN) {
            if (ws.bufferedAmount > 1_000_000) ws.terminate();
            else ws.send(JSON.stringify({ type: "notification", bridge_id: bridgeId, ...event }));
          }
        };
        // Opt in so older integrations continue receiving only state frames.
        if (new URL(request.url ?? "/", "http://bridge").searchParams.get("notifications") === "1") eufy.on("notification", notification);
        eufy.on("change", changed);
        ws.on("close", () => { eufy.off("change", changed); eufy.off("notification", notification); });
        changed(); return;
      }
      const serial = live![1]!;
      const webrtc = new URL(request.url ?? "/", "http://bridge").searchParams.get("transport") === "webrtc";
      const grant = webrtc ? eufy.media.grant(serial) : null;
      const peer: Peer = {
        send: frame => { if (webrtc) ws.send(JSON.stringify({ type: "tick" })); else ws.send(frame, { binary: true }); },
        close: (code, reason) => { ws.close(code, reason); setTimeout(() => ws.terminate(), 500).unref(); },
        get bufferedAmount() { return ws.bufferedAmount; },
      };
      ws.on("close", () => { if (grant) eufy.media.revoke(grant); eufy.hub.detach(serial, peer); });
      ws.on("message", (data, binary) => { if (!binary && data.toString() === "ack") eufy.hub.ack(serial, peer); else ws.close(1008, "Invalid acknowledgement"); });
      if (eufy.hub.attach(serial, peer) && grant) ws.send(JSON.stringify({ type: "ready", path: `/v1/media/${grant}` }));
    });
  });
  const watchdog = setInterval(() => eufy.hub.tick(), 250);
  const heartbeat = setInterval(() => { for (const ws of sockets.clients) ws.ping(); }, 20_000);
  const cleanup = () => { clearInterval(watchdog); clearInterval(heartbeat); for (const ws of sockets.clients) ws.terminate(); sockets.close(); };
  server.once("shutdown", cleanup);
  server.once("close", cleanup);
  return server;
}
