/** Viewer ownership is independent of HA and of the media encoder. */
export interface Peer {
  send(frame: Buffer): void;
  close(code: number, reason: string): void;
  readonly bufferedAmount: number;
}
export interface Control {
  start(serial: string): Promise<void>;
  stop(serial: string): Promise<void>;
  disposeMedia(serial: string): void;
}
interface Viewer { peer: Peer; deadline: number; outstanding: boolean }
interface CameraSession {
  viewers: Map<Peer, Viewer>;
  phase: "starting" | "playing" | "stopping";
  started: number;
  lastFrame: number;
  retries: number;
  nextStop: number;
}
export class StreamHub {
  private readonly cameras = new Map<string, CameraSession>();
  constructor(private readonly control: Control, private readonly now = () => performance.now()) {}

  attach(serial: string, peer: Peer): boolean {
    let camera = this.cameras.get(serial);
    if (camera?.phase === "stopping" || (camera?.viewers.size ?? 0) >= 4 || (!camera && this.cameras.size >= 8)) {
      peer.close(1013, "Camera busy or stopping");
      return false;
    }
    if (!camera) {
      const time = this.now();
      camera = { viewers: new Map(), phase: "starting", started: time, lastFrame: time, retries: 0, nextStop: 0 };
      this.cameras.set(serial, camera);
      // Insert owner BEFORE invoking start; even synchronous events see ownership.
      camera.viewers.set(peer, { peer, deadline: time + 20_000, outstanding: false });
      void this.control.start(serial).catch(() => this.end(serial, "Camera start failed"));
    } else {
      camera.viewers.set(peer, { peer, deadline: this.now() + 10_000, outstanding: false });
    }
    return true;
  }

  ack(serial: string, peer: Peer): void {
    const viewer = this.cameras.get(serial)?.viewers.get(peer);
    // A heartbeat without a delivered frame MUST NOT keep a camera awake.
    if (!viewer?.outstanding) return;
    if (viewer.deadline <= this.now()) { this.detach(serial, peer); return; }
    viewer.outstanding = false;
    viewer.deadline = this.now() + 10_000;
  }

  frame(serial: string, frame: Buffer): void {
    const camera = this.cameras.get(serial);
    if (!camera || camera.phase === "stopping") return;
    camera.phase = "playing";
    camera.lastFrame = this.now();
    for (const viewer of camera.viewers.values()) {
      if (viewer.deadline <= this.now()) { this.detach(serial, viewer.peer); continue; }
      if (!viewer.outstanding && viewer.peer.bufferedAmount < 256_000) {
        viewer.outstanding = true;
        try { viewer.peer.send(frame); } catch { this.detach(serial, viewer.peer); }
      }
    }
  }

  /** A late start after cancellation must be stopped again, never resurrected. */
  started(serial: string): boolean {
    const camera = this.cameras.get(serial);
    if (!camera || camera.phase === "stopping" || !camera.viewers.size) {
      void this.control.stop(serial).catch(() => {});
      this.control.disposeMedia(serial);
      return false;
    }
    return true;
  }

  detach(serial: string, peer: Peer): void {
    const camera = this.cameras.get(serial);
    if (!camera?.viewers.delete(peer)) return;
    peer.close(1000, "Viewer closed");
    if (!camera.viewers.size) this.end(serial, "No viewers");
  }

  end(serial: string, reason: string): void {
    const camera = this.cameras.get(serial);
    if (!camera || camera.phase === "stopping") return;
    camera.phase = "stopping";
    const viewers = [...camera.viewers.keys()];
    camera.viewers.clear();
    for (const peer of viewers) peer.close(1000, reason);
    this.control.disposeMedia(serial);
    this.requestStop(serial, camera);
  }

  private requestStop(serial: string, camera: CameraSession): void {
    camera.retries++;
    camera.nextStop = this.now() + 3_000;
    // Resolution only means issued, not physically stopped. Keep quarantined
    // until the SDK emits the stop event. Never let a new start race a stop.
    void this.control.stop(serial).catch(() => {});
  }

  stopped(serial: string): void {
    const camera = this.cameras.get(serial);
    this.cameras.delete(serial);
    this.control.disposeMedia(serial);
    if (camera) for (const peer of camera.viewers.keys()) peer.close(1000, "Camera stopped");
  }

  tick(): void {
    const time = this.now();
    for (const [serial, camera] of this.cameras) {
      if (camera.phase === "stopping") {
        if (camera.retries < 3 && time >= camera.nextStop) this.requestStop(serial, camera);
        continue;
      }
      for (const viewer of camera.viewers.values()) {
        if (time >= viewer.deadline) this.detach(serial, viewer.peer);
      }
      if (time - camera.started >= 120_000 || time - camera.lastFrame >= (camera.phase === "starting" ? 20_000 : 10_000)) {
        this.end(serial, "Viewing time limit or stalled camera");
      }
    }
  }

  close(): void { for (const serial of this.cameras.keys()) this.end(serial, "Bridge shutting down"); }
  get active(): number { return [...this.cameras.values()].filter(c => c.phase !== "stopping").length; }
  get quarantined(): number { return [...this.cameras.values()].filter(c => c.phase === "stopping").length; }
}
