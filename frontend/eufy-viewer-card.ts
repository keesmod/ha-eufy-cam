interface CameraState { state: string; attributes: { friendly_name?: string; viewer_card?: boolean; viewer_webrtc?: boolean; snapshot_received_at?: string; entity_picture?: string } }
interface CardConfig { entity: string; name?: string }
interface FrameEvent { type: "frame"; subscription: number; sequence: number; jpeg: string }
interface EndEvent { type: "ended" }
type Unsubscribe = () => Promise<void>;
type RTCEvent = { type: "ready"; subscription: number } | { type: "answer"; sdp: string } | { type: "candidate"; candidate: string } | { type: "tick"; subscription: number; sequence: number };
type ViewerEvent = FrameEvent | EndEvent | RTCEvent;
interface HAConnection extends EventTarget {
  subscribeMessage(callback: (event: ViewerEvent) => void, message: Record<string, unknown>, options: { resubscribe: boolean }): Promise<Unsubscribe>;
}
interface HA { fetchWithAuth(path: string, init?: RequestInit): Promise<Response>; language: string; connection: HAConnection; states: Record<string, CameraState>; callWS(message: Record<string, unknown>): Promise<{ accepted: boolean }> }
interface CardDefinition { type: string; name: string; description: string; preview: boolean }
interface EntityPicker extends HTMLElement { label: string; includeDomains: string[]; hass: HA; value: string; entityFilter: (entity: CameraState) => boolean }
declare global { interface Window { customCards: CardDefinition[] } }

/** Eufy Viewer: snapshots at rest, a single explicit user gesture per live session. */
const TEXT = {
  en: { live: "Watch live", close: "Close live view", connecting: "Connecting…", ended: "Live view ended. Tap again to watch.", unavailable: "Camera unavailable", noSnapshot: "No snapshot received yet", title: "Camera", error: "Live view failed. Tap again to retry.", sound: "Enable sound", mute: "Mute sound", recordings: "Recordings", date: "Date", load: "Show recordings", loading: "Loading HomeBase recordings…", preparing: "Preparing recording…", empty: "No recordings returned for this camera and date.", recordingError: "HomeBase recording unavailable. Load the date again.", live_busy: "A live viewer is still open. Close it and load the date again.", live_stopping: "The previous live session is still stopping. Wait a moment and load the date again.", recording_busy: "Another recording is being prepared. Wait a moment and try again.", recording_expired: "This recording link has expired. Load the date again.", recording_unavailable: "The HomeBase connection is unavailable. Try again shortly.", closeRecordings: "Close recordings", results: "recordings returned", homebaseTime: "HomeBase time" },
  nl: { live: "Live bekijken", close: "Livebeeld sluiten", connecting: "Verbinden…", ended: "Livebeeld gestopt. Tik opnieuw om te kijken.", unavailable: "Camera niet beschikbaar", noSnapshot: "Nog geen snapshot ontvangen", title: "Camera", error: "Livebeeld mislukt. Tik opnieuw om te proberen.", sound: "Geluid aan", mute: "Geluid uit", recordings: "Opnames", date: "Datum", load: "Opnames tonen", loading: "HomeBase-opnames laden…", preparing: "Opname voorbereiden…", empty: "Geen opnames teruggegeven voor deze camera en datum.", recordingError: "HomeBase-opname niet beschikbaar. Laad de datum opnieuw.", live_busy: "Er staat nog een livebeeld open. Sluit dit en laad de datum opnieuw.", live_stopping: "De vorige live-sessie wordt nog afgesloten. Wacht even en laad de datum opnieuw.", recording_busy: "Er wordt al een opname voorbereid. Wacht even en probeer opnieuw.", recording_expired: "Deze opnamelink is verlopen. Laad de datum opnieuw.", recording_unavailable: "De HomeBase-verbinding is niet beschikbaar. Probeer het zo opnieuw.", closeRecordings: "Opnames sluiten", results: "opnames teruggegeven", homebaseTime: "HomeBase-tijd" },
};

export class EufyViewerCard extends HTMLElement {
  private _config?: CardConfig;
  private _hass?: HA;
  private _generation: number;
  private _visible: boolean;
  private _open: boolean;
  private _unsubscribe: Unsubscribe | null;
  private _frameUrl: string | null;
  private _snapshotKey: string | null;
  private _unavailable = false;
  private _startup?: number;
  private _observer?: IntersectionObserver;
  private _preview: HTMLButtonElement;
  private _snapshot: HTMLImageElement;
  private _live: HTMLImageElement;
  private _video: HTMLVideoElement;
  private _sound: HTMLButtonElement;
  private _recordDialog: HTMLDialogElement;
  private _recordVideo: HTMLVideoElement;
  private _recordDate: HTMLInputElement;
  private _recordAbort?: AbortController;
  private _recordUrl?: string;
  private _recordGeneration = 0;
  private _rtc?: RTCPeerConnection;
  private _rtcCandidates: RTCIceCandidateInit[] = [];
  private _tick?: { subscription: number; sequence: number };
  private _videoCallback?: number;
  private _dialog: HTMLDialogElement;
  private _visibility: () => void;
  private _pagehide: () => void;
  private _disconnected: () => void;
  static getConfigElement() { return document.createElement("eufy-viewer-card-editor"); }
  static getStubConfig(hass: HA) {
    return { entity: Object.keys(hass.states).find(id => id.startsWith("camera.") && hass.states[id].attributes.viewer_card) ?? "" };
  }
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._generation = 0;
    this._visible = true;
    this._open = false;
    this._unsubscribe = null;
    this._frameUrl = null;
    this._snapshotKey = null;
    this._visibility = () => { if (document.visibilityState !== "visible") { this._stop(); this._closeRecordings(); } };
    this._pagehide = () => { this._stop(); this._closeRecordings(); };
    this._disconnected = () => { this._stop("ended"); this._closeRecordings(); };
    // Static markup only. Entity names and all remote strings use textContent.
    this.shadowRoot!.innerHTML = `
      <style>
        :host{display:block;min-width:0}*{box-sizing:border-box}ha-card{display:block;overflow:hidden;border-radius:16px}button{font:inherit;cursor:pointer}
        .preview{display:block;width:100%;border:0;padding:0;position:relative;color:var(--primary-text-color);background:var(--card-background-color,#18212b)}
        .preview:focus-visible,.close:focus-visible{outline:3px solid var(--primary-color,#03a9f4);outline-offset:-3px}
        .snapshot,.live{display:block;width:100%;aspect-ratio:16/9;object-fit:contain;background:#10161e}
        .snapshot[hidden],.empty[hidden],.live[hidden],.sound[hidden],.record-video[hidden]{display:none}.empty{display:grid;place-items:center;aspect-ratio:16/9;padding:24px;color:var(--secondary-text-color);font-size:13px;background:var(--secondary-background-color,#18212b)}
        .play{position:absolute;right:16px;bottom:16px;display:grid;place-items:center;width:44px;height:44px;border-radius:50%;background:#0008;font-size:20px;color:white;pointer-events:none}.preview:disabled{cursor:default}.preview:disabled .play{display:none}
        .meta{padding:16px}.name{font-weight:600;font-size:16px;line-height:24px}.status:empty{display:none}.status{font-size:13px;color:var(--secondary-text-color);margin-top:5px}
        dialog{border:0;border-radius:16px;padding:0;width:min(960px,94vw);max-width:94vw;background:var(--card-background-color,#fff);color:var(--primary-text-color,#111)}
        dialog::backdrop{background:#000b}.bar{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;gap:16px}
        .close{border:0;border-radius:8px;padding:10px 14px;color:inherit;background:var(--secondary-background-color,#eee)}
        .record-open{margin-top:12px}.record-filters{display:flex;gap:12px;align-items:end;flex-wrap:wrap;padding:0 16px 12px}.record-filters label{display:grid;gap:5px;font-size:13px}input{font:inherit;padding:8px;border:1px solid var(--divider-color,#aaa);border-radius:8px;background:transparent;color:inherit}
        .record-status{padding:0 16px 12px;font-size:14px}.record-list{max-height:40vh;overflow:auto;padding:0 16px 16px;display:grid;gap:8px}.record-row{text-align:left;min-height:44px}.record-video{width:100%;max-height:45vh;background:#10161e;display:block}.record-dialog{max-height:90vh;overflow:auto}
      </style>
      <ha-card>
        <button class="preview" type="button"><img class="snapshot" alt="" hidden><span class="empty"></span><span class="play" aria-hidden="true">▶</span></button>
        <div class="meta"><div class="name"></div><div class="status" role="status" aria-live="polite"></div><button class="close record-open" type="button"></button></div>
      </ha-card>
      <dialog aria-labelledby="live-title"><div class="bar"><span id="live-title"></span><button class="sound close" type="button" hidden></button><button class="close stop" type="button"></button></div><img class="live" alt=""><video class="live video" playsinline autoplay muted hidden></video></dialog>
      <dialog class="record-dialog" aria-labelledby="record-title"><div class="bar"><span id="record-title"></span><button class="close record-close" type="button"></button></div><div class="record-filters"><label><span class="date-label"></span><input type="date" class="record-date"></label><button class="close record-load" type="button"></button></div><div class="record-status" role="status" aria-live="polite"></div><video class="record-video" playsinline controls hidden></video><div class="record-list"></div></dialog>`;
    this._recordDialog = this.shadowRoot!.querySelector<HTMLDialogElement>(".record-dialog")!;
    this._recordVideo = this.shadowRoot!.querySelector<HTMLVideoElement>(".record-video")!;
    this._recordDate = this.shadowRoot!.querySelector<HTMLInputElement>(".record-date")!;
    const today = new Date(); this._recordDate.value = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,"0")}-${String(today.getDate()).padStart(2,"0")}`;
    this.shadowRoot!.querySelector(".record-open")!.addEventListener("click", () => { this._stop(); this._recordDialog.showModal(); void this._loadRecordings(); });
    this.shadowRoot!.querySelector(".record-close")!.addEventListener("click", () => this._closeRecordings());
    this.shadowRoot!.querySelector(".record-load")!.addEventListener("click", () => { void this._loadRecordings(); });
    this._recordDialog.addEventListener("cancel", e => { e.preventDefault(); this._closeRecordings(); });
    this._recordDialog.addEventListener("close", () => this._closeRecordings());
    this._preview = this.shadowRoot!.querySelector<HTMLButtonElement>(".preview")!;
    this._snapshot = this.shadowRoot!.querySelector<HTMLImageElement>(".snapshot")!;
    this._live = this.shadowRoot!.querySelector<HTMLImageElement>(".live")!;
    this._video = this.shadowRoot!.querySelector<HTMLVideoElement>(".video")!;
    this._sound = this.shadowRoot!.querySelector<HTMLButtonElement>(".sound")!;
    this._sound.addEventListener("click", () => {
      this._video.muted = !this._video.muted;
      this._sound.textContent = this._video.muted ? this._text().sound : this._text().mute;
      if (this._open) void this._video.play().catch(() => this._stop("error"));
    });
    this._dialog = this.shadowRoot!.querySelector<HTMLDialogElement>("dialog")!;
    this._preview.addEventListener("click", () => { void this._start(); });
    this.shadowRoot!.querySelector<HTMLElement>(".stop")!.addEventListener("click", () => this._stop());
    this._dialog.addEventListener("cancel", event => { event.preventDefault(); this._stop(); });
    this._dialog.addEventListener("close", () => { if (this._open) this._stop(); });
    this._dialog.addEventListener("click", event => { if (event.target === this._dialog) { const r = this._dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) this._stop(); } });
    this._snapshot.addEventListener("error", () => { this._snapshot.hidden = true; this.shadowRoot!.querySelector<HTMLElement>(".empty")!.hidden = false; });
    this._snapshot.addEventListener("load", () => { this._snapshot.hidden = false; this.shadowRoot!.querySelector<HTMLElement>(".empty")!.hidden = true; });
  }
  setConfig(config: CardConfig) {
    if (!config.entity?.startsWith("camera.")) throw new Error("Select a Eufy Viewer camera entity");
    if (this._config?.entity !== config.entity) { this._stop(); this._closeRecordings(); }
    this._config = { ...config };
    this._render();
  }
  set hass(hass: HA) {
    if (this._hass?.connection !== hass.connection) {
      this._stop();
      this._hass?.connection?.removeEventListener("disconnected", this._disconnected);
      if (this.isConnected) hass.connection?.addEventListener("disconnected", this._disconnected);
    }
    this._hass = hass;
    this._render();
  }
  getCardSize() { return 4; }
  getGridOptions() { return { columns: 12, rows: "auto", min_columns: 6 }; }
  connectedCallback() {
    document.addEventListener("visibilitychange", this._visibility);
    window.addEventListener("pagehide", this._pagehide);
    this._hass?.connection?.addEventListener("disconnected", this._disconnected);
    this._observer = new IntersectionObserver(entries => {
      this._visible = entries[0]?.isIntersecting ?? false;
      if (!this._visible) { this._stop(); this._closeRecordings(); }
    });
    this._observer.observe(this);
    this._render();
  }
  disconnectedCallback() {
    this._stop(); this._closeRecordings(); this._observer?.disconnect();
    document.removeEventListener("visibilitychange", this._visibility);
    window.removeEventListener("pagehide", this._pagehide);
    this._hass?.connection?.removeEventListener("disconnected", this._disconnected);
  }
  _text() { return TEXT[this._hass?.language?.startsWith("nl") ? "nl" : "en"]; }
  _render() {
    if (!this._config || !this._hass) return;
    const state = this._hass.states[this._config.entity];
    const text = this._text();
    const available = state && !["unavailable", "unknown"].includes(state.state) && state.attributes.viewer_card;
    this._preview.disabled = !available;
    this.shadowRoot!.querySelector<HTMLButtonElement>(".record-open")!.disabled = !available;
    for (const [selector, value] of [[".record-open",text.recordings],["#record-title",text.recordings],[".record-close",text.closeRecordings],[".record-load",text.load],[".date-label",text.date]]) this.shadowRoot!.querySelector<HTMLElement>(selector!)!.textContent = value!;
    this._preview.setAttribute("aria-label", text.live);
    this.shadowRoot!.querySelector<HTMLElement>(".stop")!.textContent = text.close;
    const title = this._config.name || state?.attributes.friendly_name || text.title;
    this.shadowRoot!.querySelector<HTMLElement>(".name")!.textContent = title;
    this.shadowRoot!.querySelector<HTMLElement>("#live-title")!.textContent = title;
    this.shadowRoot!.querySelector<HTMLElement>("#record-title")!.textContent = `${title} · ${text.recordings}`;
    this._live.alt = title;
    this.shadowRoot!.querySelector<HTMLElement>(".empty")!.textContent = text.noSnapshot;
    const received = state?.attributes.snapshot_received_at;
    // A HA state update is not a reason to poll a snapshot URL.
    const url = state?.attributes.entity_picture;
    const key = `${url}|${received}`;
    if (key !== this._snapshotKey) {
      this._snapshotKey = key;
      if (url && received && url.startsWith("/api/camera_proxy/")) this._snapshot.src = `${url}${url.includes("?") ? "&" : "?"}v=${encodeURIComponent(received)}`;
      else { this._snapshot.removeAttribute("src"); this._snapshot.hidden = true; this.shadowRoot!.querySelector<HTMLElement>(".empty")!.hidden = false; }
    }
    if (!available) { this._closeRecordings(); this._stop(); this._status(text.unavailable); }
    else if (this._unavailable) this._status("");
    this._unavailable = !available;
  }
  _recordStatus(text: string) { this.shadowRoot!.querySelector<HTMLElement>(".record-status")!.textContent = text; }
  _clearRecording() {
    this._recordGeneration++; this._recordAbort?.abort(); this._recordAbort = undefined;
    this._recordVideo.pause(); this._recordVideo.removeAttribute("src"); this._recordVideo.load(); this._recordVideo.hidden = true;
    if (this._recordUrl) URL.revokeObjectURL(this._recordUrl); this._recordUrl = undefined;
  }
  _closeRecordings() { this._clearRecording(); if (this._recordDialog?.open) this._recordDialog.close(); }
  async _recordingResponse(response: Response) {
    if (response.ok) return;
    const data = await response.json().catch(() => ({}));
    const allowed = ["live_busy", "live_stopping", "recording_busy", "recording_expired", "recording_unavailable"];
    throw new Error(allowed.includes(data.error) ? data.error : "recordingError");
  }
  _recordingFailure(error: unknown) {
    const code = error instanceof Error ? error.message : "recordingError";
    const text = this._text();
    return ["live_busy", "live_stopping", "recording_busy", "recording_expired", "recording_unavailable"].includes(code) ? text[code as keyof typeof text] : text.recordingError;
  }
  async _loadRecordings() {
    this._clearRecording(); const generation = this._recordGeneration;
    const list = this.shadowRoot!.querySelector<HTMLElement>(".record-list")!; list.replaceChildren();
    if (!this._recordDialog.open || !this._hass || !this._config) return;
    const controller = this._recordAbort = new AbortController(); this._recordStatus(this._text().loading);
    try {
      const response = await this._hass.fetchWithAuth(`/api/eufy_viewer/recordings/${this._config.entity}?date=${encodeURIComponent(this._recordDate.value)}`, { signal: controller.signal });
      await this._recordingResponse(response);
      const data = await response.json();
      if (generation !== this._recordGeneration || !this._recordDialog.open) return;
      if (!Array.isArray(data.recordings) || data.recordings.length > 10000) throw new Error("Invalid history");
      this._recordStatus(data.recordings.length ? `${data.recordings.length} ${this._text().results} · ${this._text().homebaseTime}` : this._text().empty);
      for (const record of data.recordings) {
        if (!/^[a-f0-9]{32}$/.test(record.id) || typeof record.start !== "string" || typeof record.end !== "string") throw new Error("Invalid recording");
        const button = document.createElement("button"); button.type = "button"; button.className = "close record-row";
        button.textContent = `▶ ${record.start.replace("T"," ")} – ${record.end.split("T")[1] ?? ""}`;
        button.addEventListener("click", () => { void this._playRecording(record.id); }); list.append(button);
      }
    } catch (error) { if (generation === this._recordGeneration && this._recordDialog.open) this._recordStatus(this._recordingFailure(error)); }
  }
  async _playRecording(id: string) {
    this._clearRecording(); const generation = this._recordGeneration;
    if (!this._hass || !this._config || !this._recordDialog.open) return;
    const controller = this._recordAbort = new AbortController(); this._recordStatus(this._text().preparing);
    try {
      const response = await this._hass.fetchWithAuth(`/api/eufy_viewer/recordings/${this._config.entity}/${id}`, { signal: controller.signal });
      await this._recordingResponse(response);
      if (!response.headers.get("content-type")?.startsWith("video/mp4")) throw new Error("Recording failed");
      const blob = await response.blob();
      if (generation !== this._recordGeneration || !this._recordDialog.open) return;
      if (!blob.size || blob.size > 32 * 1024 * 1024) throw new Error("Recording too large");
      this._recordUrl = URL.createObjectURL(blob); this._recordVideo.src = this._recordUrl; this._recordVideo.hidden = false;
      this._recordStatus(""); await this._recordVideo.play().catch(() => {});
    } catch (error) { if (generation === this._recordGeneration && this._recordDialog.open) this._recordStatus(this._recordingFailure(error)); }
  }
  _status(message: string) { this.shadowRoot!.querySelector<HTMLElement>(".status")!.textContent = message; }
  _watching(generation: number) { return this._open && generation === this._generation && this.isConnected && this._visible && document.visibilityState === "visible" && this._dialog.open; }
  async _start() {
    if (this._open || this._preview.disabled || !this._hass || !this._config || !this._visible || document.visibilityState !== "visible") return;
    const generation = ++this._generation;
    const webrtc = Boolean(this._hass.states[this._config.entity]?.attributes.viewer_webrtc);
    this._live.hidden = webrtc; this._video.hidden = !webrtc; this._sound.hidden = !webrtc;
    this._video.muted = true; this._sound.textContent = this._text().sound;
    this._open = true;
    this._dialog.showModal();
    this._status(this._text().connecting);
    this._startup = setTimeout(() => { if (this._watching(generation)) this._stop("error"); }, 25_000);
    try {
      const unsubscribe = await this._hass.connection.subscribeMessage(event => { void this._event(event, generation); }, { type: "eufy_viewer/watch", entity_id: this._config.entity, transport: webrtc ? "webrtc" : "jpeg" }, { resubscribe: false });
      if (!this._watching(generation)) { await unsubscribe(); return; }
      this._unsubscribe = unsubscribe;

    } catch { if (generation === this._generation) this._stop("error"); }
  }
  async _event(event: ViewerEvent, generation: number) {
    if (!this._watching(generation)) return;
    if (event.type === "ended") { this._stop("ended"); return; }
    if (event.type !== "frame") {
      try { await this._rtcEvent(event, generation); }
      catch { if (generation === this._generation) this._stop("error"); }
      return;
    }
    let url;
    try {
      if (typeof event.jpeg !== "string" || event.jpeg.length > 342_000) throw new Error("Invalid frame");
      const bytes = Uint8Array.from(atob(event.jpeg), char => char.charCodeAt(0));
      url = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
      const image = new Image(); image.src = url;
      await image.decode();
      if (!this._watching(generation)) { URL.revokeObjectURL(url); return; }
      clearTimeout(this._startup);
      const old = this._frameUrl;
      this._frameUrl = url; this._live.src = url;
      if (old) URL.revokeObjectURL(old);
      this._status("");
      // A hidden/suspended page does not paint or acknowledge frames.
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (!this._watching(generation) || !this._hass) return;
      const result = await this._hass.callWS({ type: "eufy_viewer/ack", subscription: event.subscription, sequence: event.sequence });
      if (!result.accepted && this._watching(generation)) this._stop("ended");
    } catch { if (url && url !== this._frameUrl) URL.revokeObjectURL(url); if (generation === this._generation) this._stop("error"); }
  }
  async _rtcEvent(event: RTCEvent, generation: number) {
    if (event.type === "ready") {
      if (this._rtc || !this._video.requestVideoFrameCallback) throw new Error("WebRTC unavailable");
      const pc = this._rtc = new RTCPeerConnection({ iceServers: [] });
      pc.addTransceiver("video", { direction: "recvonly" });
      pc.addTransceiver("audio", { direction: "recvonly" });
      const stream = new MediaStream(); this._video.srcObject = stream;
      pc.ontrack = event => {
        if (!this._watching(generation)) return;
        stream.addTrack(event.track);
        void this._video.play().catch(() => { if (this._watching(generation)) this._stop("error"); });
      };
      pc.onconnectionstatechange = () => {
        if (this._watching(generation) && ["disconnected", "failed", "closed"].includes(pc.connectionState)) this._stop("ended");
      };
      const offer = await pc.createOffer();
      if (!this._watching(generation)) return;
      // Gather local candidates before forwarding; HA supplies server candidates.
      await pc.setLocalDescription(offer);
      await new Promise<void>((resolve, reject) => {
        if (pc.iceGatheringState === "complete") { resolve(); return; }
        const timer = setTimeout(() => { pc.removeEventListener("icegatheringstatechange", changed); reject(new Error("ICE timeout")); }, 5000);
        const changed = () => { if (pc.iceGatheringState === "complete") { clearTimeout(timer); pc.removeEventListener("icegatheringstatechange", changed); resolve(); } };
        pc.addEventListener("icegatheringstatechange", changed);
      });
      if (!this._watching(generation)) return;
      const result = await this._hass!.callWS({ type: "eufy_viewer/signal", subscription: event.subscription, offer: pc.localDescription!.sdp });
      if (!result.accepted) throw new Error("Offer rejected");
      if (this._watching(generation)) this._painted(generation);
    } else if (event.type === "answer") {
      const pc = this._rtc;
      if (!pc || pc.remoteDescription) throw new Error("Unexpected answer");
      await pc.setRemoteDescription({ type: "answer", sdp: event.sdp });
      if (!this._watching(generation)) return;
      for (const candidate of this._rtcCandidates.splice(0)) await pc.addIceCandidate(candidate);
    } else if (event.type === "candidate") {
      if (!this._rtc || event.candidate.length > 2048 || this._rtcCandidates.length >= 64) throw new Error("Invalid candidate");
      const candidate = { candidate: event.candidate, sdpMid: "0", sdpMLineIndex: 0 };
      if (this._rtc.remoteDescription) await this._rtc.addIceCandidate(candidate);
      else this._rtcCandidates.push(candidate);
    } else {
      if (this._tick) throw new Error("Unacknowledged tick");
      this._tick = { subscription: event.subscription, sequence: event.sequence };
    }
  }
  _painted(generation: number) {
    this._videoCallback = this._video.requestVideoFrameCallback(() => {
      if (!this._watching(generation)) return;
      clearTimeout(this._startup); this._status("");
      const tick = this._tick; this._tick = undefined;
      if (tick) void this._hass!.callWS({ type: "eufy_viewer/ack", ...tick }).then(result => {
        if (!result.accepted && this._watching(generation)) this._stop("ended");
      }).catch(() => { if (this._watching(generation)) this._stop("error"); });
      this._painted(generation);
    });
  }
  _stop(reason?: "ended" | "error") {
    this._generation++; this._open = false;
    clearTimeout(this._startup);
    if (this._videoCallback !== undefined) this._video.cancelVideoFrameCallback(this._videoCallback);
    this._videoCallback = undefined; this._tick = undefined;
    this._rtc?.close(); this._rtc = undefined; this._rtcCandidates = [];
    this._video.pause();
    const media = this._video.srcObject as MediaStream | null;
    media?.getTracks().forEach(track => track.stop()); this._video.srcObject = null;
    const unsubscribe = this._unsubscribe; this._unsubscribe = null;
    if (unsubscribe) Promise.resolve().then(unsubscribe).catch(() => {});
    if (this._dialog.open) this._dialog.close();
    this._live.removeAttribute("src");
    if (this._frameUrl) URL.revokeObjectURL(this._frameUrl);
    this._frameUrl = null;
    if (reason) this._status(this._text()[reason]);
  }
}

class EufyViewerCardEditor extends HTMLElement {
  private _config?: CardConfig;
  private _hass?: HA;
  private _picker?: EntityPicker;
  setConfig(config: CardConfig) { this._config = config; this._render(); }
  set hass(hass: HA) { this._hass = hass; this._render(); }
  _render() {
    if (!this._hass || !this._config) return;
    if (!this._picker) {
      this._picker = document.createElement("ha-entity-picker") as EntityPicker;
      this._picker.label = "Camera";
      this._picker.includeDomains = ["camera"];
      this._picker.addEventListener("value-changed", event => {
        const value = (event as CustomEvent<{ value: string }>).detail.value;
        if (!this._config || value === this._config.entity) return;
        this._config = { ...this._config, entity: value };
        this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this._config }, bubbles: true, composed: true }));
      });
      this.append(this._picker);
    }
    this._picker.hass = this._hass; this._picker.value = this._config.entity;
    this._picker.entityFilter = entity => Boolean(entity.attributes.viewer_card);
  }
}
if (!customElements.get("eufy-viewer-card")) customElements.define("eufy-viewer-card", EufyViewerCard);
if (!customElements.get("eufy-viewer-card-editor")) customElements.define("eufy-viewer-card-editor", EufyViewerCardEditor);
window.customCards = window.customCards || [];
if (!window.customCards.some(card => card.type === "eufy-viewer-card")) window.customCards.push({ type: "eufy-viewer-card", name: "Eufy Security Viewer", description: "Snapshot first. Tap to watch. Close to stop.", preview: true });
