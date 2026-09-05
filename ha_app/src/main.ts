import { randomUUID } from "node:crypto";
import { Eufy } from "./eufy.js";
import { createBridge } from "./server.js";
import { Storage } from "./storage.js";

const token = process.env.EUFY_BRIDGE_TOKEN;
if (!token || token.length < 32) throw new Error("EUFY_BRIDGE_TOKEN must contain at least 32 characters");
const storage = new Storage(process.env.EUFY_DATA_DIR ?? "/data");
let id = await storage.read("bridge-id");
if (!id) { id = randomUUID(); await storage.write("bridge-id", id); }
const eufy = new Eufy(storage);
eufy.on("storage_error", () => console.error("Unable to persist bridge session"));
const server = createBridge(eufy, token, id);
server.listen(Number(process.env.PORT ?? 8080), process.env.BIND_ADDRESS ?? "0.0.0.0");
void eufy.restore().catch(() => console.error("Eufy login needs attention in Home Assistant"));
let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return; closing = true;
  const deadline = setTimeout(() => process.exit(1), 8000); deadline.unref();
  server.emit("shutdown");
  await eufy.close(); server.close(); server.closeAllConnections();
}
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });
