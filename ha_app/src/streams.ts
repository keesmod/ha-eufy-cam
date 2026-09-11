/** Viewer ownership is independent of HA and of the media encoder. */
export interface Peer {
  send(frame: Buffer): void;
  close(code: number, reason: string): void;
  readonly bufferedAmount: number;
}
export interface Control {
  diagnostic?(serial: string, event: "frame_ack" | "viewer_timeout" | "camera_timeout" | "stream_failure" | "no_viewers"): void;
  admit?(serial: string): boolean;
  start(serial: string): Promise<void>;
  recover?(serial: string): Promise<string[]>;
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
  startPending: boolean;
  recoveryAttempted: boolean;
}
export class StreamHub {
  private recovering = false;
  readonly recoveryMetrics = { recovery_attempts: 0, recovery_completed: 0, recovery_failed: 0 };
  private readonly cameras = new Map<string, CameraSession>();
  constructor(private readonly control: Control, private readonly now = () => performance.now()) {}

  attach(serial: string, peer: Peer): boolean {
    let camera = this.cameras.get(serial);
    if (this.recovering || (!camera && this.control.admit?.(serial) === false) || camera?.phase === "stopping" || (camera?.viewers.size ?? 0) >= 4 || (!camera && this.cameras.size >= 8)) {
      peer.close(1013, "Camera busy or stopping");
      return false;
    }
    if (!camera) {
      const time = this.now();
      camera = { viewers: new Map(), phase: "starting", started: time, lastFrame: time, retries: 0, nextStop: 0, startPending: true, recoveryAttempted: false };
      this.cameras.set(serial, camera);
      // Insert owner BEFORE invoking start; even synchronous events see ownership.
      camera.viewers.set(peer, { peer, deadline: time + 20_000, outstanding: false });
      const owned = camera;
      void this.control.start(serial).catch(() => { if (this.cameras.get(serial) === owned) this.end(serial, "Camera start failed"); }).finally(() => { owned.startPending = false; });
    } else {
      camera.viewers.set(peer, { peer, deadline: this.now() + 10_000, outstanding: false });
    }
    return true;
  }

  remaining(serial: string, peer: Peer): number {
    const camera = this.cameras.get(serial);
    const viewer = camera?.viewers.get(peer);
    return camera?.phase !== 'stopping' && viewer ? Math.max(0, viewer.deadline - this.now()) : 0;
  }

  ack(serial: string, peer: Peer): boolean {
    const viewer = this.cameras.get(serial)?.viewers.get(peer);
    // A heartbeat without a delivered frame MUST NOT keep a camera awake.
    if (!viewer?.outstanding) return false;
    if (viewer.deadline <= this.now()) { this.control.diagnostic?.(serial, "viewer_timeout"); this.detach(serial, peer); return false; }
    this.control.diagnostic?.(serial, "frame_ack");
    viewer.outstanding = false;
    viewer.deadline = this.now() + 10_000;
    return true;
  }

  frame(serial: string, frame: Buffer): void {
    const camera = this.cameras.get(serial);
    if (!camera || camera.phase === "stopping") return;
    camera.phase = "playing";
    camera.lastFrame = this.now();
    for (const viewer of camera.viewers.values()) {
      if (viewer.deadline <= this.now()) { this.control.diagnostic?.(serial, "viewer_timeout"); this.detach(serial, viewer.peer); continue; }
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
    this.control.diagnostic?.(serial, reason === "No viewers" ? "no_viewers" : "stream_failure");
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
        // Stop can be a no-op for a start that never delivered video. Reset the
        // shared transport once, only after all owners and pending starts leave.
        if (camera.retries >= 3 && time >= camera.nextStop && !camera.recoveryAttempted && !this.recovering && this.active === 0 && ![...this.cameras.values()].some(c => c.startPending) && this.control.recover) {
          camera.recoveryAttempted = true; this.recovering = true; this.recoveryMetrics.recovery_attempts++;
          void this.control.recover(serial).then(serials => {
            for (const recovered of serials) if (this.cameras.get(recovered)?.phase === "stopping") this.stopped(recovered);
            this.recoveryMetrics.recovery_completed++;
          }).catch(() => { this.recoveryMetrics.recovery_failed++; }).finally(() => { this.recovering = false; });
        }
        continue;
      }
      for (const viewer of camera.viewers.values()) {
        if (time >= viewer.deadline) { this.control.diagnostic?.(serial, "viewer_timeout"); this.detach(serial, viewer.peer); }
      }
      if (!camera.viewers.size) continue;
      if (time - camera.started >= 120_000 || time - camera.lastFrame >= (camera.phase === "starting" ? 20_000 : 10_000)) {
        this.control.diagnostic?.(serial, "camera_timeout");
        this.end(serial, "Viewing time limit or stalled camera");
      }
    }
  }

  close(): void { for (const serial of this.cameras.keys()) this.end(serial, "Bridge shutting down"); }
  get active(): number { return [...this.cameras.values()].filter(c => c.phase !== "stopping").length; }
  get quarantined(): number { return Math.max(Number(this.recovering), [...this.cameras.values()].filter(c => c.phase === "stopping").length); }
}
