interface CameraState { state: string; attributes: { friendly_name?: string; viewer_card?: boolean; snapshot_received_at?: string; entity_picture?: string } }
interface CardConfig { entity: string; name?: string }
interface FrameEvent { type: "frame"; subscription: number; sequence: number; jpeg: string }
interface EndEvent { type: "ended" }
type Unsubscribe = () => Promise<void>;
interface HAConnection extends EventTarget {
  subscribeMessage(callback: (event: FrameEvent | EndEvent) => void, message: Record<string, unknown>, options: { resubscribe: boolean }): Promise<Unsubscribe>;
}
interface HA { language: string; connection: HAConnection; states: Record<string, CameraState>; callWS(message: Record<string, unknown>): Promise<{ accepted: boolean }> }
interface CardDefinition { type: string; name: string; description: string; preview: boolean }
interface EntityPicker extends HTMLElement { label: string; includeDomains: string[]; hass: HA; value: string; entityFilter: (entity: CameraState) => boolean }
declare global { interface Window { customCards: CardDefinition[] } }

/** Eufy Viewer: snapshots at rest, a single explicit user gesture per live session. */
const TEXT = {
  en: { live: "Watch live", close: "Close live view", connecting: "Connecting…", ended: "Live view ended. Tap again to watch.", unavailable: "Camera unavailable", noSnapshot: "No snapshot received yet", received: "Snapshot received", unknown: "Capture time unknown", title: "Camera", error: "Live view failed. Tap again to retry." },
  nl: { live: "Live bekijken", close: "Livebeeld sluiten", connecting: "Verbinden…", ended: "Livebeeld gestopt. Tik opnieuw om te kijken.", unavailable: "Camera niet beschikbaar", noSnapshot: "Nog geen snapshot ontvangen", received: "Snapshot ontvangen", unknown: "Opnametijd onbekend", title: "Camera", error: "Livebeeld mislukt. Tik opnieuw om te proberen." },
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
  private _startup?: number;
  private _observer?: IntersectionObserver;
  private _preview: HTMLButtonElement;
  private _snapshot: HTMLImageElement;
  private _live: HTMLImageElement;
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
    this._visibility = () => { if (document.visibilityState !== "visible") this._stop(); };
    this._pagehide = () => this._stop();
    this._disconnected = () => this._stop("ended");
    // Static markup only. Entity names and all remote strings use textContent.
    this.shadowRoot!.innerHTML = `
      <style>
        :host{display:block}ha-card{overflow:hidden}button{font:inherit;cursor:pointer}
        .preview{display:block;width:100%;border:0;padding:0;position:relative;color:var(--primary-text-color);background:var(--card-background-color,#18212b)}
        .preview:focus-visible,.close:focus-visible{outline:3px solid var(--primary-color,#03a9f4);outline-offset:-3px}
        .snapshot,.live{display:block;width:100%;aspect-ratio:16/9;object-fit:contain;background:#10161e}
        .snapshot[hidden],.empty[hidden]{display:none}.empty{display:grid;place-items:center;aspect-ratio:16/9;padding:0 24px}
        .play{position:absolute;inset:0;display:grid;place-items:center;font-size:48px;text-shadow:0 1px 8px #000;color:white;pointer-events:none}
        .meta{padding:14px 16px}.name{font-weight:600}.age,.status{font-size:13px;color:var(--secondary-text-color);margin-top:5px}
        dialog{border:0;border-radius:16px;padding:0;width:min(960px,94vw);max-width:94vw;background:var(--card-background-color,#fff);color:var(--primary-text-color,#111)}
        dialog::backdrop{background:#000b}.bar{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;gap:16px}
        .close{border:0;border-radius:8px;padding:10px 14px;color:inherit;background:var(--secondary-background-color,#eee)}
      </style>
      <ha-card>
        <button class="preview" type="button"><img class="snapshot" alt="" hidden><span class="empty"></span><span class="play" aria-hidden="true">▶</span></button>
        <div class="meta"><div class="name"></div><div class="age"></div><div class="status" role="status" aria-live="polite"></div></div>
      </ha-card>
      <dialog aria-labelledby="live-title"><div class="bar"><span id="live-title"></span><button class="close" type="button"></button></div><img class="live" alt=""></dialog>`;
    this._preview = this.shadowRoot!.querySelector<HTMLButtonElement>(".preview")!;
    this._snapshot = this.shadowRoot!.querySelector<HTMLImageElement>(".snapshot")!;
    this._live = this.shadowRoot!.querySelector<HTMLImageElement>(".live")!;
    this._dialog = this.shadowRoot!.querySelector<HTMLDialogElement>("dialog")!;
    this._preview.addEventListener("click", () => { void this._start(); });
    this.shadowRoot!.querySelector<HTMLElement>(".close")!.addEventListener("click", () => this._stop());
    this._dialog.addEventListener("cancel", event => { event.preventDefault(); this._stop(); });
    this._dialog.addEventListener("close", () => { if (this._open) this._stop(); });
    this._dialog.addEventListener("click", event => { if (event.target === this._dialog) { const r = this._dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) this._stop(); } });
    this._snapshot.addEventListener("error", () => { this._snapshot.hidden = true; this.shadowRoot!.querySelector<HTMLElement>(".empty")!.hidden = false; });
    this._snapshot.addEventListener("load", () => { this._snapshot.hidden = false; this.shadowRoot!.querySelector<HTMLElement>(".empty")!.hidden = true; });
  }
  setConfig(config: CardConfig) {
    if (!config.entity?.startsWith("camera.")) throw new Error("Select a Eufy Viewer camera entity");
    if (this._config?.entity !== config.entity) this._stop();
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
  getGridOptions() { return { columns: 12, rows: 4, min_columns: 6, min_rows: 3 }; }
  connectedCallback() {
    document.addEventListener("visibilitychange", this._visibility);
    window.addEventListener("pagehide", this._pagehide);
    this._hass?.connection?.addEventListener("disconnected", this._disconnected);
    this._observer = new IntersectionObserver(entries => {
      this._visible = entries[0]?.isIntersecting ?? false;
      if (!this._visible) this._stop();
    });
    this._observer.observe(this);
    this._render();
  }
  disconnectedCallback() {
    this._stop(); this._observer?.disconnect();
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
    this._preview.setAttribute("aria-label", text.live);
    this.shadowRoot!.querySelector<HTMLElement>(".close")!.textContent = text.close;
    const title = this._config.name || state?.attributes.friendly_name || text.title;
    this.shadowRoot!.querySelector<HTMLElement>(".name")!.textContent = title;
    this.shadowRoot!.querySelector<HTMLElement>("#live-title")!.textContent = title;
    this._live.alt = title;
    this.shadowRoot!.querySelector<HTMLElement>(".empty")!.textContent = text.noSnapshot;
    const received = state?.attributes.snapshot_received_at;
    const date = received ? new Date(received) : null;
    this.shadowRoot!.querySelector<HTMLElement>(".age")!.textContent = date && !Number.isNaN(date.valueOf()) ? `${text.received}: ${date.toLocaleString(this._hass.language)} · ${text.unknown}` : text.noSnapshot;
    // A HA state update is not a reason to poll a snapshot URL.
    const url = state?.attributes.entity_picture;
    const key = `${url}|${received}`;
    if (key !== this._snapshotKey) {
      this._snapshotKey = key;
      if (url && received && url.startsWith("/api/camera_proxy/")) this._snapshot.src = `${url}${url.includes("?") ? "&" : "?"}v=${encodeURIComponent(received)}`;
      else { this._snapshot.removeAttribute("src"); this._snapshot.hidden = true; this.shadowRoot!.querySelector<HTMLElement>(".empty")!.hidden = false; }
    }
    if (!available) { this._stop(); this._status(text.unavailable); }
  }
  _status(message: string) { this.shadowRoot!.querySelector<HTMLElement>(".status")!.textContent = message; }
  _watching(generation: number) { return this._open && generation === this._generation && this.isConnected && this._visible && document.visibilityState === "visible" && this._dialog.open; }
  async _start() {
    if (this._open || this._preview.disabled || !this._hass || !this._config || !this._visible || document.visibilityState !== "visible") return;
    const generation = ++this._generation;
    this._open = true;
    this._dialog.showModal();
    this._status(this._text().connecting);
    this._startup = setTimeout(() => { if (this._watching(generation)) this._stop("error"); }, 25_000);
    try {
      const unsubscribe = await this._hass.connection.subscribeMessage(event => { void this._event(event, generation); }, { type: "eufy_viewer/watch", entity_id: this._config.entity }, { resubscribe: false });
      if (!this._watching(generation)) { await unsubscribe(); return; }
      this._unsubscribe = unsubscribe;

    } catch { if (generation === this._generation) this._stop("error"); }
  }
  async _event(event: FrameEvent | EndEvent, generation: number) {
    if (!this._watching(generation)) return;
    if (event.type !== "frame") { this._stop("ended"); return; }
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
  _stop(reason?: "ended" | "error") {
    this._generation++; this._open = false;
    clearTimeout(this._startup);
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
