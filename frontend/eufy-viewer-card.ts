interface ViewerCapability { available: boolean; status?: string; reason?: string | null }
interface CameraState { state: string; attributes: { friendly_name?: string; capabilities?: Record<string, ViewerCapability>; viewer_card?: boolean; viewer_webrtc?: boolean; viewer_late_audio?: boolean; snapshot_received_at?: string; entity_picture?: string } }
interface CardConfig { entity: string; name?: string; live_mode?: "dialog" | "inline"; live_autostart?: boolean }
interface CardForm extends HTMLElement { hass: HA; data: Record<string, unknown>; schema: { name: string; selector: unknown }[]; computeLabel: (schema: { name: string }) => string; computeHelper: (schema: { name: string }) => string | undefined }
interface FrameEvent { type: "frame"; subscription: number; sequence: number; jpeg: string }
interface EndEvent { type: "ended"; reason?: string }
interface FallbackEvent { type: "fallback" }
type Unsubscribe = () => Promise<void>;
interface IceConfiguration { ice_servers?: RTCIceServer[]; ice_configuration?: "home_assistant" | "unavailable" }
type RTCEvent = ({ type: "ready"; subscription: number; fallback?: boolean; diagnostics?: boolean } & IceConfiguration) | { type: "answer"; sdp: string } | { type: "candidate"; candidate: string } | { type: "tick"; subscription: number; sequence: number };
type AudioEvent = ({ type: "audio_ready" } & IceConfiguration) | { type: "audio_answer"; sdp: string } | { type: "audio_candidate"; candidate: string } | { type: "audio_ended" };
type ViewerEvent = FrameEvent | EndEvent | FallbackEvent | RTCEvent | AudioEvent;
interface HAConnection extends EventTarget {
  subscribeMessage(callback: (event: ViewerEvent) => void, message: Record<string, unknown>, options: { resubscribe: boolean }): Promise<Unsubscribe>;
}
interface HA { user?: { is_admin?: boolean }; fetchWithAuth(path: string, init?: RequestInit): Promise<Response>; language: string; connection: HAConnection; states: Record<string, CameraState>; callWS(message: Record<string, unknown>): Promise<{ accepted: boolean }> }
interface CardDefinition { type: string; name: string; description: string; preview: boolean }
interface EntityPicker extends HTMLElement { label: string; includeDomains: string[]; hass: HA; value: string; entityFilter: (entity: CameraState) => boolean }
declare global { interface Window { customCards: CardDefinition[] } }

/** Eufy Viewer: snapshots at rest, a single explicit user gesture per live session. */
const TEXT = {
  en: { recording_storage_unavailable: "Not enough recording storage. Close other recordings or try Native.", capability_unavailable: "This media operation is unavailable for the camera connection.", videoOnly: "Live video without sound", switching: "Switching to live video without sound…", live: "Watch live", close: "Close live view", connecting: "Connecting…", ended: "Live view ended. Tap again to watch.", station_limit: "Another camera on this HomeBase is live. Close that live view first, then tap again.", unavailable: "Camera unavailable", noSnapshot: "No snapshot received yet", title: "Camera", error: "Live view failed. Tap again to retry.", sound: "Enable sound", mute: "Mute sound", recordings: "Recordings", date: "Date", load: "Show recordings", loading: "Loading HomeBase recordings…", preparing: "Preparing recording…", empty: "No recordings returned for this camera and date.", recordingError: "HomeBase recording unavailable. Load the date again.", live_busy: "A live viewer is still open. Close it and load the date again.", live_stopping: "The previous live session is still stopping. Wait a moment and load the date again.", recording_busy: "Another recording is being prepared. Wait a moment and try again.", recording_expired: "This recording link has expired. Load the date again.", recording_unavailable: "The HomeBase connection is unavailable. Try again shortly.", closeRecordings: "Close recordings", results: "recordings returned", homebaseTime: "HomeBase time", liveMode: "Live view", liveModeDialog: "Popup dialog (default)", liveModeInline: "Inside the card, for several live cameras", pause: "Pause", resume: "Resume", stopLive: "Stop", paused: "Paused. Tap Resume to watch.", stopped: "Stopped until you open this view again. Tap to watch.", liveAutostart: "Start live automatically", liveAutostartHelper: "Inline only. Starts the live view without a tap when the view opens, up to the HomeBase limit. Each card can be paused, resumed and stopped." },
  nl: { recording_storage_unavailable: "Onvoldoende opslag voor deze opname. Sluit andere opnames of probeer Native.", capability_unavailable: "Deze mediafunctie is niet beschikbaar voor de cameraverbinding.", videoOnly: "Livebeeld zonder geluid", switching: "Omschakelen naar livebeeld zonder geluid…", live: "Live bekijken", close: "Livebeeld sluiten", connecting: "Verbinden…", ended: "Livebeeld gestopt. Tik opnieuw om te kijken.", station_limit: "Een andere camera op deze HomeBase is live. Sluit eerst dat livebeeld en tik dan opnieuw.", unavailable: "Camera niet beschikbaar", noSnapshot: "Nog geen snapshot ontvangen", title: "Camera", error: "Livebeeld mislukt. Tik opnieuw om te proberen.", sound: "Geluid aan", mute: "Geluid uit", recordings: "Opnames", date: "Datum", load: "Opnames tonen", loading: "HomeBase-opnames laden…", preparing: "Opname voorbereiden…", empty: "Geen opnames teruggegeven voor deze camera en datum.", recordingError: "HomeBase-opname niet beschikbaar. Laad de datum opnieuw.", live_busy: "Er staat nog een livebeeld open. Sluit dit en laad de datum opnieuw.", live_stopping: "De vorige live-sessie wordt nog afgesloten. Wacht even en laad de datum opnieuw.", recording_busy: "Er wordt al een opname voorbereid. Wacht even en probeer opnieuw.", recording_expired: "Deze opnamelink is verlopen. Laad de datum opnieuw.", recording_unavailable: "De HomeBase-verbinding is niet beschikbaar. Probeer het zo opnieuw.", closeRecordings: "Opnames sluiten", results: "opnames teruggegeven", homebaseTime: "HomeBase-tijd", liveMode: "Livebeeld", liveModeDialog: "Pop-updialoog (standaard)", liveModeInline: "In de kaart, voor meerdere livecamera's", pause: "Pauze", resume: "Hervatten", stopLive: "Stop", paused: "Gepauzeerd. Tik op Hervatten om te kijken.", stopped: "Gestopt tot je deze weergave opnieuw opent. Tik om te kijken.", liveAutostart: "Automatisch live starten", liveAutostartHelper: "Alleen in de kaart. Start het livebeeld zonder tik zodra de weergave opent, tot de HomeBase-limiet. Elke kaart kan pauzeren, hervatten en stoppen." },
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
  private _jpegFallback = false;
  private _fallbackPending = false;
  private _fallbackSupported = false;
  private _rtcSubscription?: number;
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
  private _recordPlayback = new EufyRecordingPlayback();
  private _recordGeneration = 0;
  private _recordId?: string;
  private _recordControls: EufyRecordingControls;
  private _liveDiagnostics: EufyDiagnosticControl;
  private _recordDiagnostics: EufyDiagnosticControl;
  private _rtc?: RTCPeerConnection;
  private _rtcCandidates: RTCIceCandidateInit[] = [];
  private _iceEvidence = new WeakMap<RTCPeerConnection, Record<string, string | number | boolean>>();
  private _audioRtc?: RTCPeerConnection;
  private _audioCandidates: RTCIceCandidateInit[] = [];
  private _audioTimeout?: number;
  private _audioAttempted = false;
  /** Late audio peer state for playback reports. The bridge announces audio once per session. */
  private _audioState: "none" | "connecting" | "attached" | "ended" = "none";
  private _tick?: { subscription: number; sequence: number };
  private _videoCallback?: number;
  private _diagnosticTimer?: number;
  private _audioDiagnosticTimer?: number;
  private _soundDiagnosticTimer?: number;
  private _playback?: { start: number; lastFrame?: number; ticks: number; sent: number; accepted: number; painted: number; enabled: boolean; reports: Set<string> };
  private _dialog: HTMLDialogElement;
  /** The live view elements. Inline mode moves them from the modal dialog into the card. */
  private _stage: HTMLElement;
  private _stopButton: HTMLButtonElement;
  private _pauseButton: HTMLButtonElement;
  private _haltButton: HTMLButtonElement;
  private _resumeButton: HTMLButtonElement;
  private _pausedBar: HTMLElement;
  /** Autostart: an attach (the view opens) or page visibility trigger that has not started a session yet. One trigger starts at most one session, once the card is in view. */
  private _autostartPending = false;
  /** The stop control disables autostart until the card is attached again. */
  private _autostartBlocked = false;
  private _paused = false;
  private _inline = false;
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
    this._visibility = () => { if (document.visibilityState !== "visible") { this._stop(); this._closeRecordings(); } else { this._autostartPending = true; this._autostart(); } };
    this._pagehide = () => { this._stop(); this._closeRecordings(); };
    this._disconnected = () => { this._stop("ended"); this._closeRecordings(); };
    // Static markup only. Entity names and all remote strings use textContent.
    // The card is a size container: below 500 px of card width, a phone in portrait, the inline live controls leave the
    // video for a compact toolbar below it and the paused bar sits below the snapshot. Wider cards keep the overlay.
    this.shadowRoot!.innerHTML = `
      <style>
        :host{display:block;min-width:0}*{box-sizing:border-box}ha-card{display:block;position:relative;overflow:hidden;border-radius:16px;container-type:inline-size}button{font:inherit;cursor:pointer}
        .preview{display:block;width:100%;border:0;padding:0;position:relative;color:var(--primary-text-color);background:var(--card-background-color,#18212b)}
        .preview:focus-visible,.close:focus-visible{outline:3px solid var(--primary-color,#03a9f4);outline-offset:-3px}
        .capability{padding:10px 16px;color:var(--secondary-text-color);font-size:12px;line-height:1.5}.capability:empty{display:none}
        .snapshot,.live{display:block;width:100%;aspect-ratio:16/9;object-fit:contain;background:#10161e}
        .snapshot[hidden],.empty[hidden],.live[hidden],.sound[hidden],.pause[hidden],.halt[hidden],.record-video[hidden]{display:none}.empty{display:grid;place-items:center;aspect-ratio:16/9;padding:24px;color:var(--secondary-text-color);font-size:13px;background:var(--secondary-background-color,#18212b)}
        .play{position:absolute;right:16px;bottom:16px;display:grid;place-items:center;width:44px;height:44px;border-radius:50%;background:#0008;font-size:20px;color:white;pointer-events:none}.preview:disabled{cursor:default}.preview:disabled .play{display:none}
        .preview[hidden],.stage[hidden],.paused[hidden]{display:none}.stage.inline{position:relative;background:#10161e}.stage.inline img.live:not([src]){visibility:hidden}.stage.inline .bar,.paused{position:absolute;top:0;left:0;right:0;z-index:1;justify-content:flex-end;flex-wrap:wrap;gap:8px;padding:8px;background:linear-gradient(#000a,#0000)}
        .stage.inline #live-title,.stage.inline .live-status{display:none}.stage.inline .close,.paused .close{background:#000a;color:#fff}
        @container (max-width:499px){.stage.inline:not([hidden]){display:flex;flex-direction:column}.stage.inline .bar{order:1}.stage.inline .bar,.paused{position:static;gap:4px;padding:6px 8px;background:var(--ha-card-background,var(--card-background-color,#fff))}.stage.inline .close,.paused .close{flex:1 1 auto;padding:10px 4px;color:inherit;background:var(--secondary-background-color,#eee)}}
        .meta{padding:16px}.name{font-weight:600;font-size:16px;line-height:24px}.status:empty{display:none}.status{font-size:13px;color:var(--secondary-text-color);margin-top:5px}
        dialog{border:0;border-radius:16px;padding:0;width:min(960px,94vw);max-width:94vw;background:var(--card-background-color,#fff);color:var(--primary-text-color,#111)}
        dialog::backdrop{background:#000b}.bar{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;gap:16px}
        .close{border:0;border-radius:8px;padding:10px 14px;color:inherit;background:var(--secondary-background-color,#eee)}
        .live-status:not(:empty){padding:0 16px 12px;font-size:14px}
        .record-open{margin-top:12px}.record-filters{display:flex;gap:12px;align-items:end;flex-wrap:wrap;padding:0 16px 12px}.record-filters label{display:grid;gap:5px;font-size:13px}input{font:inherit;padding:8px;border:1px solid var(--divider-color,#aaa);border-radius:8px;background:transparent;color:inherit}
        .record-status{padding:0 16px 12px;font-size:14px}.record-list{max-height:40vh;overflow:auto;padding:0 16px 16px;display:grid;gap:8px}.record-row{text-align:left;min-height:44px}.record-video{width:100%;max-height:45vh;background:#10161e;display:block}.record-dialog{max-height:90vh;overflow:auto}
      </style>
      <ha-card>
        <button class="preview" type="button"><img class="snapshot" alt="" hidden><span class="empty"></span><span class="play" aria-hidden="true">▶</span></button>
        <div class="bar paused" hidden><button class="close resume" type="button"></button><button class="close halt" type="button"></button></div>
        <div class="capability" role="note"></div><div class="meta"><div class="name"></div><div class="status" role="status" aria-live="polite"></div><button class="close record-open" type="button"></button></div>
      </ha-card>
      <dialog aria-labelledby="live-title"><div class="stage"><div class="bar"><span id="live-title"></span><button class="close pause" type="button" hidden></button><button class="close halt" type="button" hidden></button><button class="sound close" type="button" hidden></button><button class="close stop" type="button"></button></div><div class="live-status" role="status" aria-live="polite"></div><img class="live" alt=""><video class="live video" playsinline autoplay muted hidden></video></div></dialog>
      <dialog class="record-dialog" aria-labelledby="record-title"><div class="bar"><span id="record-title"></span><button class="close record-close" type="button"></button></div><div class="record-filters"><label><span class="date-label"></span><input type="date" class="record-date"></label><button class="close record-load" type="button"></button></div><div class="record-status" role="status" aria-live="polite"></div><video class="record-video" playsinline controls hidden></video><div class="record-list"></div></dialog>`;
    this._recordDialog = this.shadowRoot!.querySelector<HTMLDialogElement>(".record-dialog")!;
    this._recordVideo = this.shadowRoot!.querySelector<HTMLVideoElement>(".record-video")!;
    this._recordDate = this.shadowRoot!.querySelector<HTMLInputElement>(".record-date")!;
    this._recordControls = new EufyRecordingControls(this._recordDialog, () => this._hass?.language, () => {
      if (this._recordDialog.open && this._recordId) void this._playRecording(this._recordId, { time: this._recordVideo.currentTime, paused: !this._recordVideo.hidden && this._recordVideo.paused });
    });
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
      this._scheduleSoundReport();
      this._sound.textContent = this._video.muted ? this._text().sound : this._text().mute;
      if (this._open) void this._video.play().catch(() => this._stop("error"));
    });
    this._dialog = this.shadowRoot!.querySelector<HTMLDialogElement>("dialog")!;
    this._stage = this.shadowRoot!.querySelector<HTMLElement>(".stage")!;
    this._stopButton = this.shadowRoot!.querySelector<HTMLButtonElement>(".stop")!;
    this._pauseButton = this.shadowRoot!.querySelector<HTMLButtonElement>(".stage .pause")!;
    this._haltButton = this.shadowRoot!.querySelector<HTMLButtonElement>(".stage .halt")!;
    this._pausedBar = this.shadowRoot!.querySelector<HTMLElement>(".paused")!;
    this._resumeButton = this.shadowRoot!.querySelector<HTMLButtonElement>(".resume")!;
    this._pauseButton.addEventListener("click", () => this._pause());
    this._resumeButton.addEventListener("click", () => { void this._start(); });
    for (const halt of this.shadowRoot!.querySelectorAll<HTMLButtonElement>(".halt")) halt.addEventListener("click", () => this._halt());
    // Escape closes the modal dialog through its cancel event. An inline live view closes on Escape while it has focus.
    this._stage.addEventListener("keydown", event => { if (event.key === "Escape" && this._inline && this._open) { event.preventDefault(); this._stop(); } });
    this._liveDiagnostics = new EufyDiagnosticControl(this.shadowRoot!.querySelector(".meta")!, () => ({ ha: this._hass, entity: this._config?.entity }));
    this._recordDiagnostics = new EufyDiagnosticControl(this._recordDialog, () => ({ ha: this._hass, entity: this._config?.entity }));
    this._preview.addEventListener("click", () => { void this._start(); });
    this._stopButton.addEventListener("click", () => this._stop());
    this._dialog.addEventListener("cancel", event => { event.preventDefault(); this._stop(); });
    this._dialog.addEventListener("close", () => { if (this._open) this._stop(); });
    this._dialog.addEventListener("click", event => { if (event.target === this._dialog) { const r = this._dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) this._stop(); } });
    this._snapshot.addEventListener("error", () => { this._snapshot.hidden = true; this.shadowRoot!.querySelector<HTMLElement>(".empty")!.hidden = false; });
    this._snapshot.addEventListener("load", () => { this._snapshot.hidden = false; this.shadowRoot!.querySelector<HTMLElement>(".empty")!.hidden = true; });
  }
  setConfig(config: CardConfig) {
    if (!config.entity?.startsWith("camera.")) throw new Error("Select a Eufy Viewer camera entity");
    if (config.live_mode !== undefined && !["dialog", "inline"].includes(config.live_mode)) throw new Error('live_mode must be "dialog" or "inline"');
    const inline = config.live_mode === "inline";
    if (config.live_autostart !== undefined && typeof config.live_autostart !== "boolean") throw new Error("live_autostart must be true or false");
    if (config.live_autostart && !inline) throw new Error('live_autostart requires live_mode "inline"');
    if (this._config?.entity !== config.entity) { this._stop(); this._closeRecordings(); }
    if (inline !== this._inline) {
      // A mode change stops the current view first, then moves the live elements.
      this._stop();
      this._inline = inline;
      this._stage.classList.toggle("inline", inline);
      if (inline) this._preview.after(this._stage); else this._dialog.append(this._stage);
      this._stage.hidden = inline;
    }
    this._config = { ...config };
    // The intersection rule follows the configuration: a live card that may no longer stay out of view stops now.
    if (this._open && !this._visible && !this._keepsOutOfView()) this._stop();
    this._render();
  }
  set hass(hass: HA) {
    if (this._hass?.connection !== hass.connection) {
      this._stop();
      this._hass?.connection?.removeEventListener("disconnected", this._disconnected);
      if (this.isConnected) hass.connection?.addEventListener("disconnected", this._disconnected);
    }
    this._hass = hass;
    this._recordControls.update();
    this._render();
  }
  getCardSize() { return 4; }
  getGridOptions() { return { columns: 12, rows: "auto", min_columns: 6 }; }
  connectedCallback() {
    this._recordControls.connect();
    document.addEventListener("visibilitychange", this._visibility);
    window.addEventListener("pagehide", this._pagehide);
    this._hass?.connection?.addEventListener("disconnected", this._disconnected);
    // Attaching the card again, for example when the view opens, clears a stop and a pause. The observer's first report arms autostart, which fires once the card is in view.
    this._autostartBlocked = false; this._paused = false; this._autostartPending = false;
    let first = true;
    this._observer = new IntersectionObserver(entries => {
      this._visible = entries[entries.length - 1]?.isIntersecting ?? false;
      if (first) { first = false; this._autostartPending = true; }
      // Scrolling out of view stops the live view unless autostart keeps it, and closes open recordings. Scrolling back into view is not a trigger of its own.
      if (this._visible) this._autostart();
      else { if (!this._keepsOutOfView()) this._stop(); this._closeRecordings(); }
    });
    this._observer.observe(this);
    this._render();
  }
  disconnectedCallback() {
    this._recordControls.disconnect();
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
    const capabilities = state?.attributes.capabilities;
    this._preview.disabled = !available || capabilities?.live?.available === false;
    this.shadowRoot!.querySelector<HTMLButtonElement>(".record-open")!.disabled = !available || capabilities?.recordings?.available === false;
    for (const [selector, value] of [[".record-open",text.recordings],["#record-title",text.recordings],[".record-close",text.closeRecordings],[".record-load",text.load],[".date-label",text.date]]) this.shadowRoot!.querySelector<HTMLElement>(selector!)!.textContent = value!;
    this._preview.setAttribute("aria-label", text.live);
    this.shadowRoot!.querySelector<HTMLElement>(".stop")!.textContent = text.close;
    this._pauseButton.textContent = text.pause; this._resumeButton.textContent = text.resume;
    for (const halt of this.shadowRoot!.querySelectorAll<HTMLElement>(".halt")) halt.textContent = text.stopLive;
    const title = this._config.name || state?.attributes.friendly_name || text.title;
    this.shadowRoot!.querySelector<HTMLElement>(".name")!.textContent = title;
    this.shadowRoot!.querySelector<HTMLElement>("#live-title")!.textContent = title;
    this.shadowRoot!.querySelector<HTMLElement>("#record-title")!.textContent = `${title} · ${text.recordings}`;
    this._live.alt = title;
    this.shadowRoot!.querySelector<HTMLElement>(".empty")!.textContent = text.noSnapshot;
    const notes = Object.entries(capabilities ?? {}).filter(([feature]) => ["snapshot", "live", "recordings"].includes(feature)).map(([feature, capability]) => {
      const label = feature === "live" ? text.live : feature === "recordings" ? text.recordings : "Snapshot";
      if (capability.available === false) return `${label}: ${this._capabilityReason(capability.reason)}`;
      return "";
    }).filter(Boolean);
    this.shadowRoot!.querySelector<HTMLElement>(".capability")!.textContent = notes.join(". ");
    const received = capabilities?.snapshot?.available === false ? undefined : state?.attributes.snapshot_received_at;
    if (capabilities?.live?.available === false && this._open) this._stop();
    if (capabilities?.recordings?.available === false && this._recordDialog.open) this._closeRecordings();
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
    this._controls();
    this._autostart();
  }
  _permits(feature: string) { return this._hass?.states[this._config?.entity ?? ""]?.attributes.capabilities?.[feature]?.available !== false; }
  _capabilityReason(reason?: string | null) {
    const nl = this._hass?.language?.startsWith("nl");
    if (reason === "standalone_transport_unverified") return nl ? "standalone cameraverbinding nog niet ondersteund" : "standalone camera transport is not implemented";
    if (reason === "camera_media_unverified") return nl ? "media onbewezen voor deze camera en HomeBase-firmware" : "media unverified for this camera and owner firmware";
    if (reason === "invalid_connection_credentials") return nl ? "bruikbare lokale verbindingsgegevens ontbreken" : "usable local connection credentials are missing";
    return nl ? "niet beschikbaar voor deze cameraverbinding" : "unavailable for this camera connection";
  }
  _recordStatus(text: string) { this.shadowRoot!.querySelector<HTMLElement>(".record-status")!.textContent = text; }
  _clearRecording() {
    this._recordGeneration++; this._recordAbort?.abort(); this._recordAbort = undefined;
    this._recordVideo.pause(); this._recordVideo.removeAttribute("src"); this._recordVideo.load(); this._recordVideo.hidden = true;
    this._recordPlayback.clear(); this._recordControls.update(undefined, false);
  }
  _closeRecordings() { this._recordId = undefined; this._clearRecording(); if (this._recordDialog?.open) { this._recordDialog.close(); this._autostart(); } }
  async _recordingResponse(response: Response) {
    if (response.ok) return;
    const data = await response.json().catch(() => ({}));
    const allowed = ["recording_storage_unavailable", "live_busy", "live_stopping", "recording_busy", "recording_expired", "recording_unavailable", "capability_unavailable"];
    throw new Error(allowed.includes(data.error) ? data.error : "recordingError");
  }
  _recordingFailure(error: unknown) {
    this._recordDiagnostics.update(true);
    if (error instanceof RecordingCodecError && recordingMode() === "native") return this._recordControls.codecError();
    const code = error instanceof Error ? error.message : "recordingError";
    const text = this._text();
    return ["recording_storage_unavailable", "live_busy", "live_stopping", "recording_busy", "recording_expired", "recording_unavailable", "capability_unavailable"].includes(code) ? text[code as keyof typeof text] : text.recordingError;
  }
  async _loadRecordings() {
    this._recordId = undefined; this._recordControls.update();
    if (!this._permits("recordings")) return;
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
  async _playRecording(id: string, restore?: RecordingPosition) {
    if (!this._permits("recordings")) return;
    this._clearRecording(); const generation = this._recordGeneration;
    if (!this._hass || !this._config || !this._recordDialog.open) return;
    this._recordId = id;
    const controller = this._recordAbort = new AbortController(); this._recordStatus(this._text().preparing);
    try {
      await this._recordPlayback.play(this._hass, this._config.entity, id, this._recordVideo, controller.signal, (state, error) => {
        if (generation !== this._recordGeneration || !this._recordDialog.open || controller.signal.aborted) return;
        if (state === 'failed') { this._clearRecording(); this._recordStatus(this._recordingFailure(error)); }
        else { this._recordStatus(state === 'preparing' ? this._text().preparing : ''); this._recordControls.update(this._recordPlayback.media, state === 'playing'); }
      }, restore);
      if (generation !== this._recordGeneration || controller.signal.aborted) return;
      this._recordStatus(""); this._recordControls.update(this._recordPlayback.media, true);
    } catch (error) { if (generation === this._recordGeneration && this._recordDialog.open) { this._clearRecording(); this._recordStatus(this._recordingFailure(error)); } }
  }
  _status(message: string) {
    this.shadowRoot!.querySelector<HTMLElement>(".status")!.textContent = message;
    this.shadowRoot!.querySelector<HTMLElement>(".live-status")!.textContent = message;
  }
  /** An inline card with autostart keeps its session and its acknowledgement loop while it is scrolled out of view. Every other card stops on intersection loss. */
  _keepsOutOfView() { return this._inline && this._config?.live_autostart === true; }
  _watching(generation: number) { return this._open && generation === this._generation && this.isConnected && (this._visible || this._keepsOutOfView()) && document.visibilityState === "visible" && (this._inline ? !this._stage.hidden : this._dialog.open); }
  async _start() {
    this._liveDiagnostics.update(false);
    if (this._open || this._preview.disabled || !this._hass || !this._config || !this._visible || document.visibilityState !== "visible") return;
    const generation = ++this._generation;
    this._playback = { start: performance.now(), ticks: 0, sent: 0, accepted: 0, painted: 0, enabled: false, reports: new Set() };
    // Some embedded clients, including the macOS app, lack WebRTC support.
    const webrtc = Boolean(this._hass.states[this._config.entity]?.attributes.viewer_webrtc)
      && typeof RTCPeerConnection === "function"
      && typeof this._video.requestVideoFrameCallback === "function";
    this._jpegFallback = !webrtc;
    this._fallbackPending = false;
    this._fallbackSupported = false;
    this._rtcSubscription = undefined;
    this._audioAttempted = false; this._audioState = "none";
    this._live.hidden = webrtc; this._video.hidden = !webrtc; this._sound.hidden = !webrtc;
    this._video.muted = true; this._sound.textContent = this._text().sound;
    this._open = true; this._autostartPending = false; this._paused = false;
    if (this._inline) { this._preview.hidden = true; this._stage.hidden = false; this._stopButton.focus(); }
    else this._dialog.showModal();
    this._controls();
    this._status(this._text().connecting);
    this._startup = setTimeout(() => { if (this._watching(generation)) this._stop("error"); }, 25_000);
    try {
      const unsubscribe = await this._hass.connection.subscribeMessage(event => { void this._event(event, generation); }, { type: "eufy_viewer/watch", entity_id: this._config.entity, transport: webrtc ? "webrtc" : "jpeg", ...(webrtc && this._hass.states[this._config.entity]?.attributes.viewer_late_audio ? { late_audio: true } : {}) }, { resubscribe: false });
      if (!this._watching(generation)) { await unsubscribe(); return; }
      this._unsubscribe = unsubscribe;

    } catch { if (generation === this._generation) this._stop("error"); }
  }
  async _event(event: ViewerEvent, generation: number) {
    if (!this._watching(generation)) return;
    if (event.type === "ended") { this._stop(event.reason === "station_limit" ? "station_limit" : "ended"); return; }
    if (event.type === "fallback") {
      void this._reportLive("fallback");
      this._fallbackPending = false;
      this._jpegFallback = true;
      this._closeRTC();
      this._live.hidden = false; this._video.hidden = true; this._sound.hidden = true;
      this._status(this._text().videoOnly);
      return;
    }
    if (event.type === "audio_ready" || event.type === "audio_answer" || event.type === "audio_candidate" || event.type === "audio_ended") {
      if (this._jpegFallback || this._fallbackPending) return;
      try { await this._audioEvent(event, generation); }
      catch { if (this._watching(generation)) this._closeAudio(true); }
      return;
    }
    if (event.type !== "frame") {
      if (this._jpegFallback || this._fallbackPending) return;
      try { await this._rtcEvent(event, generation); }
      catch { if (generation === this._generation) await this._fallback("signaling_error", generation); }
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
      this._status(this._jpegFallback ? this._text().videoOnly : "");
      // A hidden/suspended page does not paint or acknowledge frames.
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (!this._watching(generation) || !this._hass) return;
      const result = await this._hass.callWS({ type: "eufy_viewer/ack", subscription: event.subscription, sequence: event.sequence });
      if (!result.accepted && this._watching(generation)) this._stop("ended");
    } catch { if (url && url !== this._frameUrl) URL.revokeObjectURL(url); if (generation === this._generation) this._stop("error"); }
  }
  private _closeAudio(notify = false) {
    clearTimeout(this._audioTimeout);
    const pc = this._audioRtc;
    this._audioRtc = undefined; this._audioCandidates = [];
    if (pc) {
      this._audioState = "ended";
      pc.onconnectionstatechange = null; pc.ontrack = null; pc.onicecandidate = null; pc.onicecandidateerror = null;
      for (const { track } of pc.getReceivers()) {
        track.onunmute = null;
        (this._video.srcObject as MediaStream | null)?.removeTrack(track);
        track.stop();
      }
      pc.close();
      if (notify && this._rtcSubscription !== undefined) void this._hass?.callWS({
        type: "eufy_viewer/signal", subscription: this._rtcSubscription, audio: true, stop: true,
      }).catch(() => {});
    }
  }
  private async _audioEvent(event: AudioEvent, generation: number) {
    if (event.type === "audio_ended") { this._closeAudio(); return; }
    if (event.type === "audio_ready") {
      // One audio peer per session. The bridge announces its AAC once, either
      // right after video (warm camera) or seconds into playback (cold camera),
      // possibly after the viewer already enabled sound on the video element.
      if (this._audioAttempted || !this._rtc || this._rtcSubscription === undefined) return;
      this._audioAttempted = true; this._audioState = "connecting";
      const pc = this._audioRtc = this._createPeer(event);
      const active = () => this._watching(generation) && this._audioRtc === pc;
      this._audioTimeout = window.setTimeout(() => { if (active()) this._closeAudio(true); }, 15000);
      pc.addTransceiver("audio", { direction: "recvonly" });
      pc.ontrack = event => {
        if (!active() || event.track.kind !== "audio") return;
        const stream = this._video.srcObject as MediaStream | null;
        if (!stream || stream.getAudioTracks().length) { this._closeAudio(true); return; }
        // Adding the track to the element's live stream keeps its current
        // mute and volume settings: sound enabled earlier stays enabled.
        stream.addTrack(event.track);
        this._audioState = "attached";
        event.track.onunmute = () => { if (active()) clearTimeout(this._audioTimeout); };
        if (!event.track.muted) clearTimeout(this._audioTimeout);
        void this._video.play().catch(() => { if (active()) this._closeAudio(true); });
      };
      pc.onconnectionstatechange = () => {
        if (active() && ["disconnected", "failed", "closed"].includes(pc.connectionState)) this._closeAudio(true);
      };
      await this._offer(pc, active, true);
    } else if (event.type === "audio_answer") {
      const pc = this._audioRtc;
      if (!pc || pc.remoteDescription) return;
      await pc.setRemoteDescription({ type: "answer", sdp: event.sdp });
      if (!this._watching(generation) || this._audioRtc !== pc) return;
      for (const candidate of this._audioCandidates.splice(0)) await pc.addIceCandidate(candidate);
    } else {
      const pc = this._audioRtc;
      if (!pc) return;
      if (event.candidate.length > 2048 || this._audioCandidates.length >= 64) throw new Error("Invalid candidate");
      const candidate = { candidate: event.candidate, sdpMid: "0", sdpMLineIndex: 0 };
      if (pc.remoteDescription) await pc.addIceCandidate(candidate);
      else this._audioCandidates.push(candidate);
    }
  }
  private _createPeer(config: IceConfiguration) {
    const servers = config.ice_servers ?? [];
    const pc = new RTCPeerConnection({ iceServers: servers });
    const evidence: Record<string, string | number | boolean> = {
      ice_configuration: config.ice_configuration ?? "legacy",
      relay_configured: servers.some(server => (Array.isArray(server.urls) ? server.urls : [server.urls]).some(url => /^turns?:/i.test(url))),
      ice_errors_unreachable: 0, ice_errors_auth: 0, ice_errors_other: 0,
    };
    this._iceEvidence.set(pc, evidence);
    pc.onicecandidateerror = event => {
      const key = event.errorCode === 701 ? "ice_errors_unreachable" : [401, 438, 441].includes(event.errorCode) ? "ice_errors_auth" : "ice_errors_other";
      evidence[key] = Math.min(64, Number(evidence[key]) + 1);
    };
    return pc;
  }
  private async _offer(pc: RTCPeerConnection, active: () => boolean, audio: boolean) {
    const subscription = this._rtcSubscription!, generation = this._generation;
    const fail = () => { if (active()) { if (audio) this._closeAudio(true); else void this._fallback("signaling_error", generation); } };
    let offered = false, count = 0;
    const pending: string[] = [];
    const send = (candidate: string) => {
      if (!active()) return;
      void this._hass!.callWS({ type: "eufy_viewer/signal", subscription, ...(audio ? { audio: true } : {}), candidate }).then(result => { if (!result.accepted) fail(); }).catch(fail);
    };
    // Trickle after the offer is accepted. Slow or unreachable STUN/TURN must
    // not hold up host candidates or discard a relay found later in startup.
    pc.onicecandidate = event => {
      if (!active() || !event.candidate) return;
      const candidate = event.candidate.candidate;
      if (++count > 64 || candidate.length > 2048) { fail(); return; }
      if (offered) send(candidate); else pending.push(candidate);
    };
    const offer = await pc.createOffer();
    if (!active()) return;
    await pc.setLocalDescription(offer);
    if (!active()) return;
    const result = await this._hass!.callWS({ type: "eufy_viewer/signal", subscription, ...(audio ? { audio: true } : {}), offer: offer.sdp });
    if (!active()) return;
    if (!result.accepted) throw new Error("Offer rejected");
    offered = true;
    pending.splice(0).forEach(send);
  }
  private _closeRTC() {
    this._closeAudio();
    clearTimeout(this._diagnosticTimer);
    clearTimeout(this._audioDiagnosticTimer);
    clearTimeout(this._soundDiagnosticTimer); this._soundDiagnosticTimer = undefined;
    if (this._videoCallback !== undefined) this._video.cancelVideoFrameCallback(this._videoCallback);
    this._videoCallback = undefined;
    this._tick = undefined;
    if (this._rtc) { this._rtc.onconnectionstatechange = null; this._rtc.ontrack = null; this._rtc.onicecandidate = null; this._rtc.onicecandidateerror = null; this._rtc.close(); }
    this._rtc = undefined; this._rtcCandidates = [];
    this._video.pause();
    (this._video.srcObject as MediaStream | null)?.getTracks().forEach(track => track.stop());
    this._video.srcObject = null;
  }
  private async _fallback(reason: "connection_failed" | "signaling_error" | "playback_error", generation: number) {
    if (!this._watching(generation) || this._jpegFallback || this._fallbackPending) return;
    if (!this._fallbackSupported || this._rtcSubscription === undefined) { this._stop("error"); return; }
    void this._reportLive("fallback");
    this._fallbackPending = true;
    this._closeRTC();
    this._status(this._text().switching);
    try {
      const result = await this._hass!.callWS({ type: "eufy_viewer/fallback", subscription: this._rtcSubscription, reason });
      if (!result.accepted && this._watching(generation) && !this._jpegFallback) this._stop("error");
    } catch { if (this._watching(generation) && !this._jpegFallback) this._stop("error"); }
  }
  async _rtcEvent(event: RTCEvent, generation: number) {
    if (event.type === "ready") {
      this._fallbackSupported = event.fallback === true;
      this._rtcSubscription = event.subscription;
      this._playback!.enabled = event.diagnostics === true;
      this._diagnosticTimer = window.setTimeout(() => { void this._reportLive("startup"); }, 5000);
      this._audioDiagnosticTimer = window.setTimeout(() => { void this._reportLive("audio_check"); }, 15000);
      if (this._rtc || !this._video.requestVideoFrameCallback) throw new Error("WebRTC unavailable");
      const pc = this._rtc = this._createPeer(event);
      pc.addTransceiver("video", { direction: "recvonly" });
      pc.addTransceiver("audio", { direction: "recvonly" });
      const stream = new MediaStream(); this._video.srcObject = stream;
      pc.ontrack = event => {
        if (!this._watching(generation) || this._rtc !== pc) return;
        stream.addTrack(event.track);
        void this._video.play().catch(() => { if (this._rtc === pc) void this._fallback("playback_error", generation); });
      };
      pc.onconnectionstatechange = () => {
        if (this._rtc === pc && ["disconnected", "failed", "closed"].includes(pc.connectionState)) void this._fallback("connection_failed", generation);
      };
      await this._offer(pc, () => this._watching(generation) && this._rtc === pc, false);
      if (this._watching(generation) && this._rtc === pc) this._painted(generation);
    } else if (event.type === "answer") {
      const pc = this._rtc;
      if (!pc || pc.remoteDescription) throw new Error("Unexpected answer");
      await pc.setRemoteDescription({ type: "answer", sdp: event.sdp });
      if (!this._watching(generation) || this._rtc !== pc) return;
      for (const candidate of this._rtcCandidates.splice(0)) await pc.addIceCandidate(candidate);
    } else if (event.type === "candidate") {
      if (!this._rtc || event.candidate.length > 2048 || this._rtcCandidates.length >= 64) throw new Error("Invalid candidate");
      const candidate = { candidate: event.candidate, sdpMid: "0", sdpMLineIndex: 0 };
      if (this._rtc.remoteDescription) await this._rtc.addIceCandidate(candidate);
      else this._rtcCandidates.push(candidate);
    } else {
      if (this._tick) throw new Error("Unacknowledged tick");
      if (this._playback) this._playback.ticks++;
      this._tick = { subscription: event.subscription, sequence: event.sequence };
    }
  }
  _painted(generation: number) {
    this._videoCallback = this._video.requestVideoFrameCallback(() => {
      if (!this._watching(generation) || !this._rtc || this._fallbackPending || this._jpegFallback) return;
      const playback = this._playback!;
      playback.painted++; playback.lastFrame = performance.now();
      this._scheduleSoundReport();
      clearTimeout(this._startup); this._status("");
      const tick = this._tick; this._tick = undefined;
      if (tick) playback.sent++;
      if (tick) void this._hass!.callWS({ type: "eufy_viewer/ack", ...tick }).then(result => {
        if (result.accepted && this._watching(generation) && this._playback === playback) {
          playback.accepted++; void this._reportLive("playing");
        }
        if (!result.accepted && this._watching(generation) && !this._jpegFallback && !this._fallbackPending) this._stop("ended");
      }).catch(() => { if (this._watching(generation) && !this._jpegFallback && !this._fallbackPending) this._stop("error"); });
      this._painted(generation);
    });
  }
  private _scheduleSoundReport() {
    if (this._video.muted) { clearTimeout(this._soundDiagnosticTimer); this._soundDiagnosticTimer = undefined; return; }
    if (!this._rtc || !this._playback?.enabled || this._playback.reports.has("unmuted") || this._soundDiagnosticTimer !== undefined) return;
    this._soundDiagnosticTimer = window.setTimeout(() => { this._soundDiagnosticTimer = undefined; void this._reportLive("unmuted"); }, 1000);
  }
  async _reportLive(trigger: "startup" | "playing" | "unmuted" | "fallback" | "audio_check") {
    const playback = this._playback, pc = this._rtc, hass = this._hass;
    const subscription = this._rtcSubscription, generation = this._generation;
    if (!playback?.enabled || !pc || !hass || subscription === undefined || playback.reports.has(trigger)) return;
    playback.reports.add(trigger);
    const report: Record<string, string | number | boolean> = {
      card_version: EUFY_VIEWER_CARD_VERSION,
      trigger, elapsed_ms: Math.round(performance.now() - playback.start),
      connection: pc.connectionState, ice: pc.iceConnectionState,
      ice_gathering: pc.iceGatheringState, ...this._iceEvidence.get(pc),
      offer: Boolean(pc.localDescription), answer: Boolean(pc.remoteDescription),
      ready_state: this._video.readyState, paused: this._video.paused, muted: this._video.muted,
      ticks: playback.ticks, acks_sent: playback.sent, acks_accepted: playback.accepted, painted: playback.painted,
      stats_available: false, audio_volume_percent: Math.round(this._video.volume * 100),
      audio_late: this._audioState,
    };
    if (this._audioRtc) {
      report.audio_ice = this._audioRtc.iceConnectionState;
      report.audio_ice_gathering = this._audioRtc.iceGatheringState;
      for (const [key, value] of Object.entries(this._iceEvidence.get(this._audioRtc) ?? {})) report[`audio_${key}`] = value;
    }
    const audioTracks = (this._video.srcObject as MediaStream | null)?.getAudioTracks?.() ?? [];
    report.audio_tracks = audioTracks.length;
    report.audio_tracks_muted = audioTracks.filter(track => track.muted).length;
    report.audio_tracks_enabled = audioTracks.filter(track => track.enabled).length;
    report.audio_tracks_ended = audioTracks.filter(track => track.readyState === "ended").length;
    if (playback.lastFrame !== undefined) report.last_frame_ms = Math.round(performance.now() - playback.lastFrame);
    let timer: number | undefined;
    try {
      const peers = [pc, ...(this._audioRtc ? [this._audioRtc] : [])];
      if (typeof pc.getTransceivers === "function") report.audio_negotiated = peers.some(peer => peer.getTransceivers().some(t => t.receiver.track.kind === "audio" && ["recvonly", "sendrecv"].includes(t.currentDirection ?? "")));
      const reports = await Promise.race([Promise.all(peers.map(peer => peer.getStats().catch(() => undefined))), new Promise<undefined>(resolve => { timer = window.setTimeout(resolve, 1000); })]);
      for (const stats of reports ?? []) {
        if (!stats) continue;
        report.stats_available = true;
        const count = (key: string, value: unknown) => {
          if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) report[key] = Number(report[key] ?? 0) + value;
        };
        stats.forEach(stat => {
          if (stat.type === "inbound-rtp" && ["video", "audio"].includes(stat.kind)) {
            count(`${stat.kind}_packets`, stat.packetsReceived); count(`${stat.kind}_bytes`, stat.bytesReceived);
            if (typeof stat.packetsLost === "number" && Number.isSafeInteger(stat.packetsLost)) report[`${stat.kind}_lost`] = Number(report[`${stat.kind}_lost`] ?? 0) + stat.packetsLost;
            for (const [key, value] of Object.entries({ jitter: stat.jitter, buffer_delay: stat.jitterBufferDelay, buffer_target_delay: stat.jitterBufferTargetDelay, buffer_min_delay: stat.jitterBufferMinimumDelay })) {
              if (typeof value === "number" && Number.isFinite(value) && value >= 0) count(`${stat.kind}_${key}_ms`, Math.round(value * 1000));
            }
            count(`${stat.kind}_buffer_emitted`, stat.jitterBufferEmittedCount);
            if (stat.kind === "video") {
              count("video_decoded", stat.framesDecoded); count("video_dropped", stat.framesDropped);
              count("video_received", stat.framesReceived); count("video_keyframes", stat.keyFramesDecoded);
              count("video_nack", stat.nackCount); count("video_pli", stat.pliCount); count("video_fir", stat.firCount);
            }
            else {
              const codec = stats.get(stat.codecId);
              const mime = typeof codec?.mimeType === "string" ? codec.mimeType.toLowerCase() : "";
              if (["audio/opus", "audio/pcma", "audio/pcmu", "audio/g722", "audio/mp4a-latm"].includes(mime)) report.audio_codec = mime;
              if (Number.isInteger(codec?.clockRate) && codec.clockRate > 0 && codec.clockRate <= 192000) report.audio_clock_rate = codec.clockRate;
              if (Number.isInteger(codec?.channels) && codec.channels > 0 && codec.channels <= 8) report.audio_channels = codec.channels;
              count("audio_samples", stat.totalSamplesReceived); count("concealed_samples", stat.concealedSamples);
              if (typeof stat.totalAudioEnergy === "number") report.audio_energy = Boolean(report.audio_energy) || stat.totalAudioEnergy > 0;
            }
          }
          const prefix = stats === reports?.[0] ? "" : "audio_";
          if (["local-candidate", "remote-candidate"].includes(stat.type) && ["host", "srflx", "prflx", "relay"].includes(stat.candidateType)) {
            count(`${prefix}${stat.type === "local-candidate" ? "local" : "remote"}_${stat.candidateType}`, 1);
          }
          if (stat.type === "candidate-pair" && ["frozen", "waiting", "in-progress", "failed", "succeeded"].includes(stat.state)) count(`${prefix}pairs_${stat.state.replace("-", "_")}`, 1);
          // Selected transport type only. Never copy candidate addresses or IDs.
          if (stats === reports?.[0] && stat.type === "transport" && stat.selectedCandidatePairId) {
            const pair = stats.get(stat.selectedCandidatePairId);
            const local = pair && stats.get(pair.localCandidateId), remote = pair && stats.get(pair.remoteCandidateId);
            if (local) { report.local_candidate = local.candidateType; report.protocol = local.protocol; }
            if (remote) report.remote_candidate = remote.candidateType;
          }
        });
      }
      if (generation === this._generation && this._open) await hass.callWS({ type: "eufy_viewer/live_diagnostics", subscription, report });
    } catch { /* Diagnostics cannot interrupt playback or renew a lease. */ }
    finally { clearTimeout(timer); }
  }
  /** Autostart starts one session per trigger: the card is attached (the view opens) or the page becomes visible again. The trigger fires once the card is in view. A session that ended never restarts by itself. */
  _autostart() {
    if (!this._autostartPending) return;
    if (!this._config?.live_autostart || !this._inline || this._autostartBlocked || this._open || !this.isConnected || document.visibilityState !== "visible") { this._autostartPending = false; return; }
    // A card that is out of view, a camera that is unavailable at the trigger or open recordings keep it until a later intersection report, state update or close.
    if (!this._visible || !this._hass || this._preview.disabled || this._recordDialog.open) return;
    this._autostartPending = false;
    void this._start();
  }
  /** Pause and stop exist only on an inline card with autostart. The paused bar offers resume and stop over the snapshot. */
  _controls() {
    const autostart = this._inline && this._config?.live_autostart === true;
    this._pauseButton.hidden = this._haltButton.hidden = !autostart;
    this._pausedBar.hidden = !(autostart && this._paused && !this._open);
  }
  /** Pause releases the lease and shows the snapshot. Resume starts a new session, and so does the next autostart trigger. */
  _pause() {
    if (!this._open) return;
    this._stop();
    this._paused = true;
    this._status(this._text().paused);
    this._controls();
    this._resumeButton.focus();
  }
  /** The stop control ends the session and disables autostart until the card is attached again. */
  _halt() {
    const focused = this.shadowRoot!.activeElement;
    this._stop();
    this._autostartBlocked = true; this._autostartPending = false; this._paused = false;
    this._status(this._text().stopped);
    this._controls();
    if (focused && this._pausedBar.contains(focused)) this._preview.focus();
  }
  _stop(reason?: "ended" | "error" | "station_limit") {
    this._liveDiagnostics.update(reason !== undefined);
    this._generation++; this._open = false;
    clearTimeout(this._startup);
    this._closeRTC();
    const unsubscribe = this._unsubscribe; this._unsubscribe = null;
    if (unsubscribe) Promise.resolve().then(unsubscribe).catch(() => {});
    if (this._dialog.open) this._dialog.close();
    if (this._inline) {
      const focused = this.shadowRoot!.activeElement !== null && this._stage.contains(this.shadowRoot!.activeElement);
      this._stage.hidden = true; this._preview.hidden = false;
      // A session can end while the card is out of view, at the cap for example. Returning focus must not scroll the page to it.
      if (focused) this._preview.focus({ preventScroll: true });
    }
    this._live.removeAttribute("src");
    if (this._frameUrl) URL.revokeObjectURL(this._frameUrl);
    this._frameUrl = null;
    if (reason) this._status(this._text()[reason]);
    this._controls();
  }
}

class EufyViewerCardEditor extends HTMLElement {
  private _config?: CardConfig;
  private _hass?: HA;
  private _picker?: EntityPicker;
  private _form?: CardForm;
  setConfig(config: CardConfig) { this._config = config; this._render(); }
  set hass(hass: HA) { this._hass = hass; this._render(); }
  _text() { return TEXT[this._hass?.language?.startsWith("nl") ? "nl" : "en"]; }
  _emit(config: CardConfig) {
    this._config = config;
    this._render();
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }));
  }
  _render() {
    if (!this._hass || !this._config) return;
    if (!this._picker || !this._form) {
      this._picker = document.createElement("ha-entity-picker") as EntityPicker;
      this._picker.label = "Camera";
      this._picker.includeDomains = ["camera"];
      this._picker.addEventListener("value-changed", event => {
        const value = (event as CustomEvent<{ value: string }>).detail.value;
        if (!this._config || value === this._config.entity) return;
        this._emit({ ...this._config, entity: value });
      });
      this._form = document.createElement("ha-form") as CardForm;
      this._form.computeLabel = schema => schema.name === "live_autostart" ? this._text().liveAutostart : this._text().liveMode;
      this._form.computeHelper = schema => schema.name === "live_autostart" ? this._text().liveAutostartHelper : undefined;
      this._form.addEventListener("value-changed", event => {
        const value = (event as CustomEvent<{ value?: { live_mode?: string; live_autostart?: boolean } }>).detail.value ?? {};
        if (!this._config) return;
        // Defaults are stored as absent keys, so a saved card config stays minimal. Autostart is only valid inline.
        const { live_mode, live_autostart, ...rest } = this._config;
        const inline = value.live_mode === "inline";
        const autostart = inline && ("live_autostart" in value ? value.live_autostart === true : live_autostart === true);
        const next: CardConfig = { ...rest, ...(inline ? { live_mode: "inline" as const } : {}), ...(autostart ? { live_autostart: true } : {}) };
        if (next.live_mode !== live_mode || next.live_autostart !== live_autostart) this._emit(next);
      });
      this.append(this._picker, this._form);
    }
    this._picker.hass = this._hass; this._picker.value = this._config.entity;
    this._picker.entityFilter = entity => Boolean(entity.attributes.viewer_card);
    const text = this._text();
    this._form.hass = this._hass;
    const inline = this._config.live_mode === "inline";
    this._form.schema = [{ name: "live_mode", selector: { select: { mode: "dropdown", options: [{ value: "dialog", label: text.liveModeDialog }, { value: "inline", label: text.liveModeInline }] } } }, ...(inline ? [{ name: "live_autostart", selector: { boolean: {} } }] : [])];
    this._form.data = inline ? { live_mode: "inline", live_autostart: this._config.live_autostart === true } : { live_mode: "dialog" };
  }
}
if (!customElements.get("eufy-viewer-card")) customElements.define("eufy-viewer-card", EufyViewerCard);
if (!customElements.get("eufy-viewer-card-editor")) customElements.define("eufy-viewer-card-editor", EufyViewerCardEditor);
window.customCards = window.customCards || [];
if (!window.customCards.some(card => card.type === "eufy-viewer-card")) window.customCards.push({ type: "eufy-viewer-card", name: "Eufy Security Viewer", description: "Snapshot first. Tap to watch. Close to stop.", preview: true });
