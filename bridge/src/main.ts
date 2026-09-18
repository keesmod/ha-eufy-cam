import { RecordingTranscoder, recordingAcceleration, logRecordingDiagnostic } from './recording-media.js';
import { MegaBackend, liveStreamsPerStation } from './mega-backend.js';
import { liveAcceleration, liveRateControl } from './live-transcoder.js';
import { randomUUID } from "node:crypto";
import {backendName} from "./backend.js";
import { Eufy } from "./eufy.js";
import { createBridge } from "./server.js";
import { Storage } from "./storage.js";
import { logBackendFault, logDiscoveryDiagnostic } from "./backend-log.js";

const token = process.env.EUFY_BRIDGE_TOKEN;
if (!token || token.length < 32) throw new Error("EUFY_BRIDGE_TOKEN must contain at least 32 characters");
const acceleration = liveAcceleration(process.env.EUFY_LIVE_ACCELERATION);
const rateControl = liveRateControl(process.env.EUFY_LIVE_MAX_BITRATE);
const stationLimit = liveStreamsPerStation(process.env.EUFY_LIVE_MAX_STREAMS_PER_STATION);
const recordingMode = recordingAcceleration(process.env.EUFY_RECORDING_ACCELERATION);
const recordingMedia = new RecordingTranscoder(recordingMode, event => {
  logRecordingDiagnostic(event, process.env.EUFY_DIAGNOSTICS === "true");
}, undefined, undefined, process.env.EUFY_DIAGNOSTICS === "true");
const selectedBackend = backendName(process.env.EUFY_BACKEND);
const storage = new Storage(process.env.EUFY_DATA_DIR ?? "/data");
let id = await storage.read("bridge-id");
if (!id) { id = randomUUID(); await storage.write("bridge-id", id); }
const eufy = new Eufy(storage,selectedBackend, process.env.EUFY_DIAGNOSTICS === "true",
  (storage, busy) => new MegaBackend(storage, busy, undefined, recordingMedia, stationLimit));
eufy.media.acceleration = acceleration;
eufy.media.rateControl = rateControl;
eufy.liveStreamsPerStation = stationLimit;
if (stationLimit > 1) console.info(`Eufy live limit: up to ${stationLimit} concurrent live cameras per HomeBase (verified with 2)`);
if (eufy.diagnostics.enabled) console.info("Eufy media diagnostics enabled. Disable after troubleshooting.");
eufy.on("backend_fault", logBackendFault);
eufy.on("discovery_diagnostic", logDiscoveryDiagnostic);
eufy.on("storage_error", () => console.error("Unable to persist bridge session"));
eufy.on("restore_retry", () => console.error("Eufy session restore failed; retrying when the network is ready"));
const server = createBridge(eufy, token, id);
server.listen(Number(process.env.PORT ?? 8080), process.env.BIND_ADDRESS ?? "0.0.0.0");
void eufy.restore().catch(() => console.error("Eufy login needs attention in Home Assistant"));
let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return; closing = true;
  const deadline = setTimeout(() => process.exit(1), 15000); deadline.unref();
  server.emit("shutdown");
  await eufy.close(); server.close(); server.closeAllConnections();
}
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });
