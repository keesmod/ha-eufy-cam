import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type { Credentials, Eufy } from "./eufy.js";
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
  const state = () => ({ protocol: 1, bridge_id: bridgeId, auth: eufy.auth.state, cameras: eufy.inventory(), stream_metrics: { ...eufy.metrics, active_cameras: eufy.hub.active, quarantined: eufy.hub.quarantined } });
  const server = createServer((request, response) => {
    if (!authorized(request, token)) { json(response, 401, { error: "unauthorized" }); return; }
    void (async () => {
      const url = new URL(request.url ?? "/", "http://bridge");
      if (request.method === "GET" && url.pathname === "/v1/state") { json(response, 200, state()); return; }
      if (request.method === "POST" && url.pathname === "/v1/login") {
        const input = await body(request);
        let credentials: Credentials | undefined;
        if (typeof input.username === "string" && typeof input.password === "string" && typeof input.country === "string" && /^[A-Za-z]{2}$/.test(input.country)) {
          credentials = { username: input.username, password: input.password, country: input.country.toUpperCase() };
        } else if (input.username !== undefined || input.password !== undefined) throw new Error("Invalid credentials");
        const options = typeof input.verifyCode === "string" ? { force: false, verifyCode: input.verifyCode } : typeof input.captcha === "string" && typeof input.captchaId === "string" ? { force: false, captcha: { captchaCode: input.captcha, captchaId: input.captchaId } } : undefined;
        json(response, 200, await eufy.login(credentials, options)); return;
      }
      const match = /^\/v1\/snapshot\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname);
      if (request.method === "GET" && match?.[1]) {
        const picture = eufy.pictures.get(match[1]);
        if (!picture) { json(response, 404, { error: "no_snapshot" }); return; }
        response.writeHead(200, { "Content-Type": picture.mime, "Content-Length": picture.data.length, "Cache-Control": "no-store" }); response.end(picture.data); return;
      }
      json(response, 404, { error: "not_found" });
    })().catch(() => { if (!response.headersSent) json(response, 400, { error: "request_failed" }); else response.destroy(); });
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
        eufy.on("change", changed); ws.on("close", () => eufy.off("change", changed)); changed(); return;
      }
      const serial = live![1]!;
      const peer: Peer = {
        send: frame => ws.send(frame, { binary: true }),
        close: (code, reason) => { ws.close(code, reason); setTimeout(() => ws.terminate(), 500).unref(); },
        get bufferedAmount() { return ws.bufferedAmount; },
      };
      ws.on("close", () => eufy.hub.detach(serial, peer));
      ws.on("message", (data, binary) => { if (!binary && data.toString() === "ack") eufy.hub.ack(serial, peer); else ws.close(1008, "Invalid acknowledgement"); });
      eufy.hub.attach(serial, peer);
    });
  });
  const watchdog = setInterval(() => eufy.hub.tick(), 250);
  const heartbeat = setInterval(() => { for (const ws of sockets.clients) ws.ping(); }, 20_000);
  const cleanup = () => { clearInterval(watchdog); clearInterval(heartbeat); for (const ws of sockets.clients) ws.terminate(); sockets.close(); };
  server.once("shutdown", cleanup);
  server.once("close", cleanup);
  return server;
}
