"use strict";
/** Native players need an HTTP source on macOS; blobs can stall indefinitely. */
class EufyRecordingPlayback {
    release;
    cancel;
    releaseMedia() { const release = this.release; this.release = undefined; return release?.() ?? Promise.resolve(); }
    clear() { this.cancel?.(); this.cancel = undefined; return this.releaseMedia(); }
    async play(ha, entity, id, video, externalSignal, changed = () => { }) {
        await this.clear();
        externalSignal.throwIfAborted();
        const controller = new AbortController(), signal = controller.signal;
        let native = Boolean(video.canPlayType('video/mp4; codecs="hvc1.1.6.L153.B0"'));
        let recovering = false;
        const detach = () => video.removeEventListener('error', failed);
        const cancel = () => { controller.abort(); detach(); externalSignal.removeEventListener('abort', cancel); };
        this.cancel = cancel;
        externalSignal.addEventListener('abort', cancel, { once: true });
        const recover = async (error, preservePosition = false) => {
            if (!native || signal.aborted || !(error instanceof RecordingCodecError))
                throw error;
            native = false; // One fallback for the whole clip, including errors after the first frame.
            const position = video.currentTime, paused = preservePosition && video.paused;
            video.pause();
            video.removeAttribute('src');
            video.load();
            await this.releaseMedia();
            signal.throwIfAborted();
            const url = await this.prepare(ha, entity, id, signal);
            await this.load(video, url, signal, !paused);
            signal.throwIfAborted();
            if (Number.isFinite(position) && position > 0)
                video.currentTime = Math.min(position, Number.isFinite(video.duration) ? video.duration : position);
        };
        const failed = () => {
            if (signal.aborted || recovering)
                return;
            recovering = true;
            detach();
            const error = video.error?.code === 3 || video.error?.code === 4
                ? new RecordingCodecError('Recording codec unsupported') : new Error('Recording playback failed');
            if (native && error instanceof RecordingCodecError)
                changed('preparing');
            void recover(error, true).then(() => {
                if (!signal.aborted) {
                    recovering = false;
                    video.addEventListener('error', failed);
                    changed('playing');
                }
            }).catch(async (error) => {
                if (signal.aborted)
                    return;
                await this.clear();
                if (!externalSignal.aborted)
                    changed('failed', error);
            });
        };
        try {
            const url = await this.prepare(ha, entity, id, signal, native);
            try {
                await this.load(video, url, signal);
            }
            catch (error) {
                await recover(error);
            }
            signal.throwIfAborted();
            video.addEventListener('error', failed);
        }
        catch (error) {
            if (!signal.aborted)
                await this.clear();
            throw error;
        }
    }
    async prepare(ha, entity, id, signal, native = false) {
        const response = await ha.fetchWithAuth(`/api/eufy_viewer/recordings/${entity}/${id}/playback${native ? "?format=native" : ""}`, { method: 'POST', signal });
        const data = await response.json();
        if (!response.ok)
            throw new Error(data.error);
        if (typeof data.path !== 'string' || !/^\/api\/eufy_viewer\/playback\/[a-f0-9]{32}$/.test(data.path)
            || typeof data.url !== 'string' || !data.url.startsWith(data.path + '?authSig='))
            throw new Error('Invalid playback');
        const url = new URL(data.url, location.origin);
        if (url.origin !== location.origin || url.pathname !== data.path || url.hash
            || [...url.searchParams.keys()].some(key => key !== 'authSig'))
            throw new Error('Invalid playback');
        const release = async () => { await ha.fetchWithAuth(data.path, { method: 'DELETE', keepalive: true, signal: AbortSignal.timeout(5000) }).catch(() => { }); };
        if (signal.aborted) {
            await release();
            signal.throwIfAborted();
        }
        void this.releaseMedia();
        this.release = release;
        return data.url;
    }
    async load(video, url, signal, autoplay = true) {
        signal.throwIfAborted();
        await new Promise((resolve, reject) => {
            const finish = (error) => {
                clearTimeout(timer);
                video.removeEventListener('loadeddata', loaded);
                video.removeEventListener('error', failed);
                signal.removeEventListener('abort', aborted);
                if (error)
                    reject(error);
                else
                    resolve();
            };
            const loaded = () => finish();
            const failed = () => finish(video.error?.code === 3 || video.error?.code === 4
                ? new RecordingCodecError('Recording codec unsupported') : new Error('Recording playback failed'));
            const aborted = () => finish(new DOMException('Aborted', 'AbortError'));
            const timer = setTimeout(failed, 20000);
            video.addEventListener('loadeddata', loaded, { once: true });
            video.addEventListener('error', failed, { once: true });
            signal.addEventListener('abort', aborted, { once: true });
            video.autoplay = autoplay;
            video.src = url;
            video.hidden = false;
            if (!autoplay) {
                video.load();
                return;
            }
            void video.play().catch(error => {
                // Native controls remain usable when automatic playback is denied.
                if (error.name !== 'NotAllowedError')
                    finish(error.name === 'NotSupportedError'
                        ? new RecordingCodecError('Recording codec unsupported') : error);
            });
        });
    }
}
class RecordingCodecError extends Error {
}

/** Eufy Viewer: snapshots at rest, a single explicit user gesture per live session. */
const TEXT = {
    en: { live: "Watch live", close: "Close live view", connecting: "Connecting…", ended: "Live view ended. Tap again to watch.", unavailable: "Camera unavailable", noSnapshot: "No snapshot received yet", title: "Camera", error: "Live view failed. Tap again to retry.", sound: "Enable sound", mute: "Mute sound", recordings: "Recordings", date: "Date", load: "Show recordings", loading: "Loading HomeBase recordings…", preparing: "Preparing recording…", empty: "No recordings returned for this camera and date.", recordingError: "HomeBase recording unavailable. Load the date again.", live_busy: "A live viewer is still open. Close it and load the date again.", live_stopping: "The previous live session is still stopping. Wait a moment and load the date again.", recording_busy: "Another recording is being prepared. Wait a moment and try again.", recording_expired: "This recording link has expired. Load the date again.", recording_unavailable: "The HomeBase connection is unavailable. Try again shortly.", closeRecordings: "Close recordings", results: "recordings returned", homebaseTime: "HomeBase time" },
    nl: { live: "Live bekijken", close: "Livebeeld sluiten", connecting: "Verbinden…", ended: "Livebeeld gestopt. Tik opnieuw om te kijken.", unavailable: "Camera niet beschikbaar", noSnapshot: "Nog geen snapshot ontvangen", title: "Camera", error: "Livebeeld mislukt. Tik opnieuw om te proberen.", sound: "Geluid aan", mute: "Geluid uit", recordings: "Opnames", date: "Datum", load: "Opnames tonen", loading: "HomeBase-opnames laden…", preparing: "Opname voorbereiden…", empty: "Geen opnames teruggegeven voor deze camera en datum.", recordingError: "HomeBase-opname niet beschikbaar. Laad de datum opnieuw.", live_busy: "Er staat nog een livebeeld open. Sluit dit en laad de datum opnieuw.", live_stopping: "De vorige live-sessie wordt nog afgesloten. Wacht even en laad de datum opnieuw.", recording_busy: "Er wordt al een opname voorbereid. Wacht even en probeer opnieuw.", recording_expired: "Deze opnamelink is verlopen. Laad de datum opnieuw.", recording_unavailable: "De HomeBase-verbinding is niet beschikbaar. Probeer het zo opnieuw.", closeRecordings: "Opnames sluiten", results: "opnames teruggegeven", homebaseTime: "HomeBase-tijd" },
};
export class EufyViewerCard extends HTMLElement {
    _config;
    _hass;
    _generation;
    _visible;
    _open;
    _unsubscribe;
    _frameUrl;
    _snapshotKey;
    _unavailable = false;
    _startup;
    _observer;
    _preview;
    _snapshot;
    _live;
    _video;
    _sound;
    _recordDialog;
    _recordVideo;
    _recordDate;
    _recordAbort;
    _recordPlayback = new EufyRecordingPlayback();
    _recordGeneration = 0;
    _rtc;
    _rtcCandidates = [];
    _tick;
    _videoCallback;
    _dialog;
    _visibility;
    _pagehide;
    _disconnected;
    static getConfigElement() { return document.createElement("eufy-viewer-card-editor"); }
    static getStubConfig(hass) {
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
        this._visibility = () => { if (document.visibilityState !== "visible") {
            this._stop();
            this._closeRecordings();
        } };
        this._pagehide = () => { this._stop(); this._closeRecordings(); };
        this._disconnected = () => { this._stop("ended"); this._closeRecordings(); };
        // Static markup only. Entity names and all remote strings use textContent.
        this.shadowRoot.innerHTML = `
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
        this._recordDialog = this.shadowRoot.querySelector(".record-dialog");
        this._recordVideo = this.shadowRoot.querySelector(".record-video");
        this._recordDate = this.shadowRoot.querySelector(".record-date");
        const today = new Date();
        this._recordDate.value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
        this.shadowRoot.querySelector(".record-open").addEventListener("click", () => { this._stop(); this._recordDialog.showModal(); void this._loadRecordings(); });
        this.shadowRoot.querySelector(".record-close").addEventListener("click", () => this._closeRecordings());
        this.shadowRoot.querySelector(".record-load").addEventListener("click", () => { void this._loadRecordings(); });
        this._recordDialog.addEventListener("cancel", e => { e.preventDefault(); this._closeRecordings(); });
        this._recordDialog.addEventListener("close", () => this._closeRecordings());
        this._preview = this.shadowRoot.querySelector(".preview");
        this._snapshot = this.shadowRoot.querySelector(".snapshot");
        this._live = this.shadowRoot.querySelector(".live");
        this._video = this.shadowRoot.querySelector(".video");
        this._sound = this.shadowRoot.querySelector(".sound");
        this._sound.addEventListener("click", () => {
            this._video.muted = !this._video.muted;
            this._sound.textContent = this._video.muted ? this._text().sound : this._text().mute;
            if (this._open)
                void this._video.play().catch(() => this._stop("error"));
        });
        this._dialog = this.shadowRoot.querySelector("dialog");
        this._preview.addEventListener("click", () => { void this._start(); });
        this.shadowRoot.querySelector(".stop").addEventListener("click", () => this._stop());
        this._dialog.addEventListener("cancel", event => { event.preventDefault(); this._stop(); });
        this._dialog.addEventListener("close", () => { if (this._open)
            this._stop(); });
        this._dialog.addEventListener("click", event => { if (event.target === this._dialog) {
            const r = this._dialog.getBoundingClientRect();
            if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom)
                this._stop();
        } });
        this._snapshot.addEventListener("error", () => { this._snapshot.hidden = true; this.shadowRoot.querySelector(".empty").hidden = false; });
        this._snapshot.addEventListener("load", () => { this._snapshot.hidden = false; this.shadowRoot.querySelector(".empty").hidden = true; });
    }
    setConfig(config) {
        if (!config.entity?.startsWith("camera."))
            throw new Error("Select a Eufy Viewer camera entity");
        if (this._config?.entity !== config.entity) {
            this._stop();
            this._closeRecordings();
        }
        this._config = { ...config };
        this._render();
    }
    set hass(hass) {
        if (this._hass?.connection !== hass.connection) {
            this._stop();
            this._hass?.connection?.removeEventListener("disconnected", this._disconnected);
            if (this.isConnected)
                hass.connection?.addEventListener("disconnected", this._disconnected);
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
            if (!this._visible) {
                this._stop();
                this._closeRecordings();
            }
        });
        this._observer.observe(this);
        this._render();
    }
    disconnectedCallback() {
        this._stop();
        this._closeRecordings();
        this._observer?.disconnect();
        document.removeEventListener("visibilitychange", this._visibility);
        window.removeEventListener("pagehide", this._pagehide);
        this._hass?.connection?.removeEventListener("disconnected", this._disconnected);
    }
    _text() { return TEXT[this._hass?.language?.startsWith("nl") ? "nl" : "en"]; }
    _render() {
        if (!this._config || !this._hass)
            return;
        const state = this._hass.states[this._config.entity];
        const text = this._text();
        const available = state && !["unavailable", "unknown"].includes(state.state) && state.attributes.viewer_card;
        this._preview.disabled = !available;
        this.shadowRoot.querySelector(".record-open").disabled = !available;
        for (const [selector, value] of [[".record-open", text.recordings], ["#record-title", text.recordings], [".record-close", text.closeRecordings], [".record-load", text.load], [".date-label", text.date]])
            this.shadowRoot.querySelector(selector).textContent = value;
        this._preview.setAttribute("aria-label", text.live);
        this.shadowRoot.querySelector(".stop").textContent = text.close;
        const title = this._config.name || state?.attributes.friendly_name || text.title;
        this.shadowRoot.querySelector(".name").textContent = title;
        this.shadowRoot.querySelector("#live-title").textContent = title;
        this.shadowRoot.querySelector("#record-title").textContent = `${title} · ${text.recordings}`;
        this._live.alt = title;
        this.shadowRoot.querySelector(".empty").textContent = text.noSnapshot;
        const received = state?.attributes.snapshot_received_at;
        // A HA state update is not a reason to poll a snapshot URL.
        const url = state?.attributes.entity_picture;
        const key = `${url}|${received}`;
        if (key !== this._snapshotKey) {
            this._snapshotKey = key;
            if (url && received && url.startsWith("/api/camera_proxy/"))
                this._snapshot.src = `${url}${url.includes("?") ? "&" : "?"}v=${encodeURIComponent(received)}`;
            else {
                this._snapshot.removeAttribute("src");
                this._snapshot.hidden = true;
                this.shadowRoot.querySelector(".empty").hidden = false;
            }
        }
        if (!available) {
            this._closeRecordings();
            this._stop();
            this._status(text.unavailable);
        }
        else if (this._unavailable)
            this._status("");
        this._unavailable = !available;
    }
    _recordStatus(text) { this.shadowRoot.querySelector(".record-status").textContent = text; }
    _clearRecording() {
        this._recordGeneration++;
        this._recordAbort?.abort();
        this._recordAbort = undefined;
        this._recordVideo.pause();
        this._recordVideo.removeAttribute("src");
        this._recordVideo.load();
        this._recordVideo.hidden = true;
        this._recordPlayback.clear();
    }
    _closeRecordings() { this._clearRecording(); if (this._recordDialog?.open)
        this._recordDialog.close(); }
    async _recordingResponse(response) {
        if (response.ok)
            return;
        const data = await response.json().catch(() => ({}));
        const allowed = ["live_busy", "live_stopping", "recording_busy", "recording_expired", "recording_unavailable"];
        throw new Error(allowed.includes(data.error) ? data.error : "recordingError");
    }
    _recordingFailure(error) {
        const code = error instanceof Error ? error.message : "recordingError";
        const text = this._text();
        return ["live_busy", "live_stopping", "recording_busy", "recording_expired", "recording_unavailable"].includes(code) ? text[code] : text.recordingError;
    }
    async _loadRecordings() {
        this._clearRecording();
        const generation = this._recordGeneration;
        const list = this.shadowRoot.querySelector(".record-list");
        list.replaceChildren();
        if (!this._recordDialog.open || !this._hass || !this._config)
            return;
        const controller = this._recordAbort = new AbortController();
        this._recordStatus(this._text().loading);
        try {
            const response = await this._hass.fetchWithAuth(`/api/eufy_viewer/recordings/${this._config.entity}?date=${encodeURIComponent(this._recordDate.value)}`, { signal: controller.signal });
            await this._recordingResponse(response);
            const data = await response.json();
            if (generation !== this._recordGeneration || !this._recordDialog.open)
                return;
            if (!Array.isArray(data.recordings) || data.recordings.length > 10000)
                throw new Error("Invalid history");
            this._recordStatus(data.recordings.length ? `${data.recordings.length} ${this._text().results} · ${this._text().homebaseTime}` : this._text().empty);
            for (const record of data.recordings) {
                if (!/^[a-f0-9]{32}$/.test(record.id) || typeof record.start !== "string" || typeof record.end !== "string")
                    throw new Error("Invalid recording");
                const button = document.createElement("button");
                button.type = "button";
                button.className = "close record-row";
                button.textContent = `▶ ${record.start.replace("T", " ")} – ${record.end.split("T")[1] ?? ""}`;
                button.addEventListener("click", () => { void this._playRecording(record.id); });
                list.append(button);
            }
        }
        catch (error) {
            if (generation === this._recordGeneration && this._recordDialog.open)
                this._recordStatus(this._recordingFailure(error));
        }
    }
    async _playRecording(id) {
        this._clearRecording();
        const generation = this._recordGeneration;
        if (!this._hass || !this._config || !this._recordDialog.open)
            return;
        const controller = this._recordAbort = new AbortController();
        this._recordStatus(this._text().preparing);
        try {
            await this._recordPlayback.play(this._hass, this._config.entity, id, this._recordVideo, controller.signal, (state, error) => {
                if (generation !== this._recordGeneration || !this._recordDialog.open || controller.signal.aborted)
                    return;
                if (state === 'failed') {
                    this._clearRecording();
                    this._recordStatus(this._recordingFailure(error));
                }
                else
                    this._recordStatus(state === 'preparing' ? this._text().preparing : '');
            });
            this._recordStatus("");
        }
        catch (error) {
            if (generation === this._recordGeneration && this._recordDialog.open) {
                this._clearRecording();
                this._recordStatus(this._recordingFailure(error));
            }
        }
    }
    _status(message) { this.shadowRoot.querySelector(".status").textContent = message; }
    _watching(generation) { return this._open && generation === this._generation && this.isConnected && this._visible && document.visibilityState === "visible" && this._dialog.open; }
    async _start() {
        if (this._open || this._preview.disabled || !this._hass || !this._config || !this._visible || document.visibilityState !== "visible")
            return;
        const generation = ++this._generation;
        // Some embedded clients, including the macOS app, lack WebRTC support.
        const webrtc = Boolean(this._hass.states[this._config.entity]?.attributes.viewer_webrtc)
            && typeof RTCPeerConnection === "function"
            && typeof this._video.requestVideoFrameCallback === "function";
        this._live.hidden = webrtc;
        this._video.hidden = !webrtc;
        this._sound.hidden = !webrtc;
        this._video.muted = true;
        this._sound.textContent = this._text().sound;
        this._open = true;
        this._dialog.showModal();
        this._status(this._text().connecting);
        this._startup = setTimeout(() => { if (this._watching(generation))
            this._stop("error"); }, 25_000);
        try {
            const unsubscribe = await this._hass.connection.subscribeMessage(event => { void this._event(event, generation); }, { type: "eufy_viewer/watch", entity_id: this._config.entity, transport: webrtc ? "webrtc" : "jpeg" }, { resubscribe: false });
            if (!this._watching(generation)) {
                await unsubscribe();
                return;
            }
            this._unsubscribe = unsubscribe;
        }
        catch {
            if (generation === this._generation)
                this._stop("error");
        }
    }
    async _event(event, generation) {
        if (!this._watching(generation))
            return;
        if (event.type === "ended") {
            this._stop("ended");
            return;
        }
        if (event.type !== "frame") {
            try {
                await this._rtcEvent(event, generation);
            }
            catch {
                if (generation === this._generation)
                    this._stop("error");
            }
            return;
        }
        let url;
        try {
            if (typeof event.jpeg !== "string" || event.jpeg.length > 342_000)
                throw new Error("Invalid frame");
            const bytes = Uint8Array.from(atob(event.jpeg), char => char.charCodeAt(0));
            url = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
            const image = new Image();
            image.src = url;
            await image.decode();
            if (!this._watching(generation)) {
                URL.revokeObjectURL(url);
                return;
            }
            clearTimeout(this._startup);
            const old = this._frameUrl;
            this._frameUrl = url;
            this._live.src = url;
            if (old)
                URL.revokeObjectURL(old);
            this._status("");
            // A hidden/suspended page does not paint or acknowledge frames.
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
            if (!this._watching(generation) || !this._hass)
                return;
            const result = await this._hass.callWS({ type: "eufy_viewer/ack", subscription: event.subscription, sequence: event.sequence });
            if (!result.accepted && this._watching(generation))
                this._stop("ended");
        }
        catch {
            if (url && url !== this._frameUrl)
                URL.revokeObjectURL(url);
            if (generation === this._generation)
                this._stop("error");
        }
    }
    async _rtcEvent(event, generation) {
        if (event.type === "ready") {
            if (this._rtc || !this._video.requestVideoFrameCallback)
                throw new Error("WebRTC unavailable");
            const pc = this._rtc = new RTCPeerConnection({ iceServers: [] });
            pc.addTransceiver("video", { direction: "recvonly" });
            pc.addTransceiver("audio", { direction: "recvonly" });
            const stream = new MediaStream();
            this._video.srcObject = stream;
            pc.ontrack = event => {
                if (!this._watching(generation))
                    return;
                stream.addTrack(event.track);
                void this._video.play().catch(() => { if (this._watching(generation))
                    this._stop("error"); });
            };
            pc.onconnectionstatechange = () => {
                if (this._watching(generation) && ["disconnected", "failed", "closed"].includes(pc.connectionState))
                    this._stop("ended");
            };
            const offer = await pc.createOffer();
            if (!this._watching(generation))
                return;
            // Gather local candidates before forwarding; HA supplies server candidates.
            await pc.setLocalDescription(offer);
            await new Promise((resolve, reject) => {
                if (pc.iceGatheringState === "complete") {
                    resolve();
                    return;
                }
                const timer = setTimeout(() => { pc.removeEventListener("icegatheringstatechange", changed); reject(new Error("ICE timeout")); }, 5000);
                const changed = () => { if (pc.iceGatheringState === "complete") {
                    clearTimeout(timer);
                    pc.removeEventListener("icegatheringstatechange", changed);
                    resolve();
                } };
                pc.addEventListener("icegatheringstatechange", changed);
            });
            if (!this._watching(generation))
                return;
            const result = await this._hass.callWS({ type: "eufy_viewer/signal", subscription: event.subscription, offer: pc.localDescription.sdp });
            if (!result.accepted)
                throw new Error("Offer rejected");
            if (this._watching(generation))
                this._painted(generation);
        }
        else if (event.type === "answer") {
            const pc = this._rtc;
            if (!pc || pc.remoteDescription)
                throw new Error("Unexpected answer");
            await pc.setRemoteDescription({ type: "answer", sdp: event.sdp });
            if (!this._watching(generation))
                return;
            for (const candidate of this._rtcCandidates.splice(0))
                await pc.addIceCandidate(candidate);
        }
        else if (event.type === "candidate") {
            if (!this._rtc || event.candidate.length > 2048 || this._rtcCandidates.length >= 64)
                throw new Error("Invalid candidate");
            const candidate = { candidate: event.candidate, sdpMid: "0", sdpMLineIndex: 0 };
            if (this._rtc.remoteDescription)
                await this._rtc.addIceCandidate(candidate);
            else
                this._rtcCandidates.push(candidate);
        }
        else {
            if (this._tick)
                throw new Error("Unacknowledged tick");
            this._tick = { subscription: event.subscription, sequence: event.sequence };
        }
    }
    _painted(generation) {
        this._videoCallback = this._video.requestVideoFrameCallback(() => {
            if (!this._watching(generation))
                return;
            clearTimeout(this._startup);
            this._status("");
            const tick = this._tick;
            this._tick = undefined;
            if (tick)
                void this._hass.callWS({ type: "eufy_viewer/ack", ...tick }).then(result => {
                    if (!result.accepted && this._watching(generation))
                        this._stop("ended");
                }).catch(() => { if (this._watching(generation))
                    this._stop("error"); });
            this._painted(generation);
        });
    }
    _stop(reason) {
        this._generation++;
        this._open = false;
        clearTimeout(this._startup);
        if (this._videoCallback !== undefined)
            this._video.cancelVideoFrameCallback(this._videoCallback);
        this._videoCallback = undefined;
        this._tick = undefined;
        this._rtc?.close();
        this._rtc = undefined;
        this._rtcCandidates = [];
        this._video.pause();
        const media = this._video.srcObject;
        media?.getTracks().forEach(track => track.stop());
        this._video.srcObject = null;
        const unsubscribe = this._unsubscribe;
        this._unsubscribe = null;
        if (unsubscribe)
            Promise.resolve().then(unsubscribe).catch(() => { });
        if (this._dialog.open)
            this._dialog.close();
        this._live.removeAttribute("src");
        if (this._frameUrl)
            URL.revokeObjectURL(this._frameUrl);
        this._frameUrl = null;
        if (reason)
            this._status(this._text()[reason]);
    }
}
class EufyViewerCardEditor extends HTMLElement {
    _config;
    _hass;
    _picker;
    setConfig(config) { this._config = config; this._render(); }
    set hass(hass) { this._hass = hass; this._render(); }
    _render() {
        if (!this._hass || !this._config)
            return;
        if (!this._picker) {
            this._picker = document.createElement("ha-entity-picker");
            this._picker.label = "Camera";
            this._picker.includeDomains = ["camera"];
            this._picker.addEventListener("value-changed", event => {
                const value = event.detail.value;
                if (!this._config || value === this._config.entity)
                    return;
                this._config = { ...this._config, entity: value };
                this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this._config }, bubbles: true, composed: true }));
            });
            this.append(this._picker);
        }
        this._picker.hass = this._hass;
        this._picker.value = this._config.entity;
        this._picker.entityFilter = entity => Boolean(entity.attributes.viewer_card);
    }
}
if (!customElements.get("eufy-viewer-card"))
    customElements.define("eufy-viewer-card", EufyViewerCard);
if (!customElements.get("eufy-viewer-card-editor"))
    customElements.define("eufy-viewer-card-editor", EufyViewerCardEditor);
window.customCards = window.customCards || [];
if (!window.customCards.some(card => card.type === "eufy-viewer-card"))
    window.customCards.push({ type: "eufy-viewer-card", name: "Eufy Security Viewer", description: "Snapshot first. Tap to watch. Close to stop.", preview: true });

const EVENTS_TEXT = {
    nl: { title: 'Gebeurtenissen', all: 'Alle camera’s', camera: 'Camera', date: 'Datum', show: 'Opnames tonen', hint: 'Kies een dag en toon de bestaande HomeBase-opnames.', loading: 'Opnames laden…', preparing: 'Opname voorbereiden…', calendar: 'Kalender', month: 'Maand', calendarHint: '• Opnames op deze HomeBase (alle camera’s)', calendarError: 'Opnamedagen niet beschikbaar voor deze gebruiker of HomeBase.', prev: 'Vorige opname', next: 'Volgende opname', close: 'Sluiten', pagePrev: 'Vorige pagina', pageNext: 'Volgende pagina', none: 'Geen opnames op deze dag voor deze camera.', results: 'opnames', time: 'HomeBase-tijd', noThumb: 'Geen voorbeeldbeeld', expired: 'Opnamelink verlopen. Laad de datum opnieuw.', error: 'Opnames niet beschikbaar. Probeer de datum opnieuw.', incomplete: 'De volledige dag kon niet worden bevestigd. Probeer opnieuw.', live: 'Sluit de livebeelden voordat je opnames laadt.', stopping: 'De vorige live-sessie wordt nog afgesloten. Probeer het zo opnieuw.', busy: 'Een andere opname wordt voorbereid. Probeer het zo opnieuw.', stopped: 'Gestopt. Tik op Opnames tonen om verder te kijken.' },
    en: { title: 'Events', all: 'All cameras', camera: 'Camera', date: 'Date', show: 'Show recordings', hint: 'Choose a day to view existing HomeBase recordings.', loading: 'Loading recordings…', preparing: 'Preparing recording…', calendar: 'Calendar', month: 'Month', calendarHint: '• Recordings on this HomeBase (all cameras)', calendarError: 'Recording days unavailable for this user or HomeBase.', prev: 'Previous recording', next: 'Next recording', close: 'Close', pagePrev: 'Previous page', pageNext: 'Next page', none: 'No recordings for this camera and day.', results: 'recordings', time: 'HomeBase time', noThumb: 'No preview available', expired: 'Recording link expired. Load the date again.', error: 'Recordings unavailable. Load the date again.', incomplete: 'The complete day could not be confirmed. Try again.', live: 'Close live viewers before loading recordings.', stopping: 'The previous live session is still stopping. Try again shortly.', busy: 'Another recording is being prepared. Try again shortly.', stopped: 'Stopped. Tap Show recordings to continue.' }
};
/** Finite, user-initiated HomeBase browsing. No live sessions or polling. */
export class EufyEventsCard extends HTMLElement {
    config = {};
    ha;
    records = [];
    days = new Set();
    page = 0;
    selected = -1;
    controller;
    job = Promise.resolve();
    active = false;
    urls = new Map();
    playback = new EufyRecordingPlayback();
    observer;
    cameraKey = '';
    loadedDate = '';
    visibilityChanged = () => { if (document.visibilityState !== 'visible')
        this.stop(); };
    leave = () => this.stop();
    q(selector) { return this.shadowRoot.querySelector(selector); }
    get text() { return EVENTS_TEXT[this.ha?.language?.startsWith('nl') ? 'nl' : 'en']; }
    cameras() { return Object.keys(this.ha?.states ?? {}).filter(id => id.startsWith('camera.') && this.ha.states[id].attributes.viewer_card && (!this.config.entities || this.config.entities.includes(id))).sort(); }
    name(id) { return this.ha?.states[id]?.attributes.friendly_name ?? id; }
    filtered() { const camera = this.q('.camera').value; return this.records.filter(r => !camera || r.entity_id === camera); }
    static getStubConfig() { return {}; }
    getCardSize() { return 8; }
    getGridOptions() { return { columns: 12, rows: 'auto', min_columns: 6 }; }
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        // Only static markup enters innerHTML; remote labels use textContent.
        this.shadowRoot.innerHTML = `<style>
      :host{display:block}*{box-sizing:border-box}[hidden]{display:none!important}ha-card{display:block;padding:20px;border-radius:16px;color:var(--primary-text-color,#152028);background:var(--card-background-color,#fff)}
      h2{font-size:21px;margin:0 0 16px}button,input,select{font:inherit;color:inherit}button{cursor:pointer;min-height:42px;padding:8px 13px;border:1px solid var(--divider-color,#d4dadd);border-radius:9px;background:var(--secondary-background-color,#f2f5f6)}button:disabled{opacity:.45;cursor:default}button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid var(--primary-color,#008c96);outline-offset:2px}
      .filters{display:flex;flex-wrap:wrap;align-items:end;gap:12px}.filters label{display:grid;gap:5px;font-size:13px}.filters select,.filters input,.month{min-height:42px;max-width:100%;padding:8px;border:1px solid var(--divider-color,#d4dadd);border-radius:8px;background:var(--card-background-color,#fff)}.show{background:var(--primary-color,#008c96);color:var(--text-primary-color,#fff);border-color:transparent}summary{cursor:pointer;padding:14px 0;width:max-content}.calendar{max-width:360px}.days{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;margin-top:10px}.day{padding:6px;position:relative}.day.marked:after{content:'•';position:absolute;bottom:0;left:0;right:0;color:var(--primary-color,#008c96)}.day.chosen{outline:2px solid var(--primary-color,#008c96)}.weekday{text-align:center;font-size:12px;opacity:.65}.legend,.status,.page-info{font-size:13px;color:var(--secondary-text-color,#56656b)}.status{margin:16px 0;min-height:18px}.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(180px,100%),1fr));gap:12px}.event{padding:0;overflow:hidden;text-align:left;background:transparent}.preview{display:grid;place-items:center;position:relative;overflow:hidden;width:100%;aspect-ratio:16/9;background:var(--secondary-background-color,#e9eff0);font-size:12px;color:var(--secondary-text-color,#56656b)}.preview img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#10161e}.meta{padding:10px;display:grid;gap:5px}.camera-name{font-weight:600;font-size:14px}.event-time{font-size:13px;opacity:.8}.pagination{display:flex;gap:10px;justify-content:center;align-items:center;margin-top:18px}
      dialog{width:min(1000px,95vw);max-width:95vw;padding:0;border:0;border-radius:16px;background:var(--card-background-color,#fff);color:var(--primary-text-color,#152028)}dialog::backdrop{background:#000b}.player-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 16px;flex-wrap:wrap}.player-title{font-weight:600}.player-status{padding:0 16px 12px}video{display:block;width:100%;max-height:65vh;background:#10161e}.player-nav{display:flex;gap:10px;justify-content:center;padding:14px}
      @media(max-width:450px){ha-card{padding:14px}.tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.filters label:first-child{flex:1;min-width:130px}.event-time{font-size:11px}}
    </style><ha-card><h2></h2><div class="filters"><label><span data-text="camera"></span><select class="camera"></select></label><label><span data-text="date"></span><input class="date" type="date"></label><button class="show" data-text="show"></button></div><details><summary data-text="calendar"></summary><div class="calendar"><input class="month" type="month"><div class="days"></div><p class="legend"></p></div></details><div class="status" role="status" aria-live="polite"></div><div class="tiles"></div><div class="pagination" hidden><button class="page-prev" data-text="pagePrev"></button><span class="page-info"></span><button class="page-next" data-text="pageNext"></button></div></ha-card><dialog aria-labelledby="events-player-title"><div class="player-bar"><span class="player-title" id="events-player-title"></span><button class="close" data-text="close"></button></div><div class="player-status" role="status" aria-live="polite"></div><video playsinline controls hidden></video><div class="player-nav"><button class="previous" data-text="prev"></button><button class="next" data-text="next"></button></div></dialog>`;
        const today = new Date();
        const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        this.q('.date').value = date;
        this.q('.month').value = date.slice(0, 7);
        this.q('.show').onclick = () => this.load();
        this.q('.camera').onchange = () => { this.page = 0; this.run(signal => this.renderEvents(signal)); };
        this.q('.date').onchange = () => { this.q('.month').value = this.q('.date').value.slice(0, 7); this.load(); };
        this.q('details').ontoggle = () => { if (this.q('details').open)
            this.loadCalendar(); };
        this.q('.month').onchange = () => this.loadCalendar();
        this.q('.page-prev').onclick = () => { this.page--; this.run(signal => this.renderEvents(signal)); };
        this.q('.page-next').onclick = () => { this.page++; this.run(signal => this.renderEvents(signal)); };
        this.q('.previous').onclick = () => this.play(this.selected - 1);
        this.q('.next').onclick = () => this.play(this.selected + 1);
        this.q('.close').onclick = () => this.closePlayer();
        this.q('dialog').addEventListener('cancel', e => { e.preventDefault(); this.closePlayer(); });
        this.labels();
        this.q('.status').textContent = this.text.hint;
    }
    setConfig(config) {
        if (config.entities && (!Array.isArray(config.entities) || config.entities.length > 100 || config.entities.some(id => !/^camera\.[a-z0-9_]+$/.test(id))))
            throw new Error('Select Eufy Viewer camera entities');
        this.stop();
        this.config = { ...config };
        this.cameraKey = '';
        this.labels();
    }
    set hass(value) {
        if (this.ha?.connection !== value.connection) {
            this.stop();
            this.ha?.connection.removeEventListener('disconnected', this.leave);
            if (this.isConnected)
                value.connection.addEventListener('disconnected', this.leave);
        }
        this.ha = value;
        this.labels();
    }
    connectedCallback() {
        document.addEventListener('visibilitychange', this.visibilityChanged);
        window.addEventListener('pagehide', this.leave);
        this.ha?.connection.addEventListener('disconnected', this.leave);
        this.observer = new IntersectionObserver(entries => { if (!entries[0]?.isIntersecting)
            this.stop(); });
        this.observer.observe(this);
    }
    disconnectedCallback() { this.stop(); this.observer?.disconnect(); document.removeEventListener('visibilitychange', this.visibilityChanged); window.removeEventListener('pagehide', this.leave); this.ha?.connection.removeEventListener('disconnected', this.leave); }
    labels() {
        for (const element of Array.from(this.shadowRoot.querySelectorAll('[data-text]')))
            element.textContent = this.text[element.dataset.text];
        this.q('h2').textContent = this.config.title || this.text.title;
        this.q('.month').setAttribute('aria-label', this.text.month);
        const cameras = this.cameras(), key = JSON.stringify(cameras.map(id => [id, this.name(id)])) + this.text.all;
        if (key !== this.cameraKey) {
            this.cameraKey = key;
            const select = this.q('.camera'), selected = select.value;
            select.replaceChildren();
            for (const id of ['', ...cameras]) {
                const option = document.createElement('option');
                option.value = id;
                option.textContent = id ? this.name(id) : this.text.all;
                select.append(option);
            }
            select.value = cameras.includes(selected) ? selected : '';
        }
        this.q('.show').disabled = !cameras.length;
    }
    clearVideo() { const v = this.q('video'); v.pause(); v.removeAttribute('src'); v.load(); v.hidden = true; this.playback.clear(); }
    closePlayer() { this.controller?.abort(); this.clearVideo(); const dialog = this.q('dialog'); if (dialog.open)
        dialog.close(); }
    stop() { this.closePlayer(); for (const url of this.urls.values())
        URL.revokeObjectURL(url); this.urls.clear(); if (this.active)
        this.q('.status').textContent = this.text.stopped; }
    run(action) {
        const settling = this.active;
        this.controller?.abort();
        this.clearVideo();
        const controller = this.controller = new AbortController();
        this.active = true;
        this.job = this.job.catch(() => { }).then(async () => {
            // Let HA observe our cancelled socket before starting another P2P operation.
            if (settling)
                await new Promise(resolve => setTimeout(resolve, 750));
            if (controller.signal.aborted || !this.isConnected || document.visibilityState !== 'visible')
                return;
            try {
                await action(controller.signal);
            }
            catch (error) {
                if (!controller.signal.aborted) {
                    const message = this.failure(error);
                    this.q('.status').textContent = message;
                    this.q('.player-status').textContent = message;
                }
            }
            finally {
                if (this.controller === controller)
                    this.active = false;
            }
        });
    }
    failure(error) { const code = error instanceof Error ? error.message : ''; return code === 'live_busy' ? this.text.live : code === 'live_stopping' ? this.text.stopping : code === 'recording_busy' ? this.text.busy : code === 'recording_expired' ? this.text.expired : code === 'history_incomplete' ? this.text.incomplete : this.text.error; }
    async fetch(path, signal) { signal.throwIfAborted(); const response = await this.ha.fetchWithAuth(path, { signal }); if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error);
    } return response; }
    query() { return `/api/eufy_viewer/events?entities=${encodeURIComponent(this.cameras().join(','))}`; }
    load() {
        this.closePlayer();
        this.records = [];
        this.page = 0;
        this.q('.tiles').replaceChildren();
        this.q('.pagination').hidden = true;
        for (const url of this.urls.values())
            URL.revokeObjectURL(url);
        this.urls.clear();
        this.loadedDate = this.q('.date').value;
        const date = this.loadedDate;
        this.run(async (signal) => {
            this.q('.status').textContent = this.text.loading;
            const data = await (await this.fetch(`${this.query()}&date=${date}`, signal)).json();
            signal.throwIfAborted();
            if (data.complete !== true || !Array.isArray(data.recordings) || data.recordings.length > 10000 || data.recordings.some((r) => !this.cameras().includes(r.entity_id) || !/^[a-f0-9]{32}$/.test(r.id) || typeof r.start !== 'string' || typeof r.end !== 'string'))
                throw new Error('history_incomplete');
            this.records = data.recordings;
            await this.renderEvents(signal);
        });
    }
    loadCalendar() {
        const month = this.q('.month').value;
        this.run(async (signal) => {
            this.days.clear();
            this.renderCalendar();
            this.q('.legend').textContent = this.text.loading;
            try {
                const data = await (await this.fetch(`${this.query()}&month=${month}`, signal)).json();
                signal.throwIfAborted();
                if (!Array.isArray(data.days) || data.days.length > 31)
                    throw new Error();
                this.days = new Set(data.days);
                this.renderCalendar();
                this.q('.legend').textContent = this.text.calendarHint;
            }
            catch (error) {
                if (!signal.aborted)
                    this.q('.legend').textContent = this.text.calendarError;
            }
        });
    }
    renderCalendar() {
        const month = this.q('.month').value, start = new Date(`${month}-01T12:00:00`), root = this.q('.days');
        root.replaceChildren();
        if (!Number.isFinite(start.valueOf()))
            return;
        for (let i = 0; i < 7; i++) {
            const label = document.createElement('span');
            label.className = 'weekday';
            label.textContent = new Date(2026, 8, 7 + i).toLocaleDateString(this.ha?.language, { weekday: 'narrow' });
            root.append(label);
        }
        for (let i = 0; i < (start.getDay() + 6) % 7; i++)
            root.append(document.createElement('span'));
        const count = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
        for (let n = 1; n <= count; n++) {
            const day = `${month}-${String(n).padStart(2, '0')}`, button = document.createElement('button');
            button.className = 'day' + (this.days.has(day) ? ' marked' : '') + (this.q('.date').value === day ? ' chosen' : '');
            button.textContent = String(n);
            button.setAttribute('aria-label', day + (this.days.has(day) ? ` · ${this.text.results}` : ''));
            button.onclick = () => { this.q('.date').value = day; this.renderCalendar(); this.load(); };
            root.append(button);
        }
    }
    async renderEvents(signal) {
        const records = this.filtered(), root = this.q('.tiles');
        root.replaceChildren();
        this.page = Math.max(0, Math.min(this.page, Math.ceil(records.length / 12) - 1));
        this.q('.status').textContent = records.length ? `${records.length} ${this.text.results} · ${this.loadedDate} · ${this.text.time}` : this.text.none;
        this.q('.pagination').hidden = records.length <= 12;
        this.q('.page-info').textContent = `${this.page + 1} / ${Math.max(1, Math.ceil(records.length / 12))}`;
        this.q('.page-prev').disabled = this.page === 0;
        this.q('.page-next').disabled = (this.page + 1) * 12 >= records.length;
        const pending = [];
        for (const [offset, record] of records.slice(this.page * 12, (this.page + 1) * 12).entries()) {
            const button = document.createElement('button');
            button.className = 'event';
            const preview = document.createElement('span');
            preview.className = 'preview';
            preview.textContent = this.text.noThumb;
            const meta = document.createElement('span');
            meta.className = 'meta';
            const name = document.createElement('span');
            name.className = 'camera-name';
            name.textContent = this.name(record.entity_id);
            const time = document.createElement('span');
            time.className = 'event-time';
            time.textContent = `▶ ${record.start.slice(11)} – ${record.end.slice(11)}`;
            meta.append(name, time);
            button.append(preview, meta);
            button.onclick = () => this.play(this.page * 12 + offset);
            root.append(button);
            pending.push({ record, preview });
        }
        for (const { record, preview } of pending) {
            signal.throwIfAborted();
            if (!record.thumbnail)
                continue;
            try {
                let url = this.urls.get(record.id);
                if (!url) {
                    const response = await this.fetch(`/api/eufy_viewer/recordings/${record.entity_id}/${record.id}/thumbnail`, signal);
                    if (!response.headers.get('content-type')?.startsWith('image/jpeg'))
                        continue;
                    const blob = await response.blob();
                    signal.throwIfAborted();
                    if (!blob.size || blob.size > 2 * 1024 * 1024)
                        continue;
                    url = URL.createObjectURL(blob);
                    this.urls.set(record.id, url);
                    while (this.urls.size > 24) {
                        const first = this.urls.keys().next().value;
                        URL.revokeObjectURL(this.urls.get(first));
                        this.urls.delete(first);
                    }
                }
                const image = document.createElement('img');
                image.alt = '';
                image.src = url;
                preview.replaceChildren(image);
            }
            catch (error) {
                if (signal.aborted)
                    throw error;
            }
        }
    }
    play(index) {
        const records = this.filtered(), record = records[index];
        if (!record)
            return;
        this.selected = index;
        const dialog = this.q('dialog');
        if (!dialog.open)
            dialog.showModal();
        this.q('.player-title').textContent = `${this.name(record.entity_id)} · ${record.start.replace('T', ' ')}`;
        this.q('.previous').disabled = index <= 0;
        this.q('.next').disabled = index >= records.length - 1;
        this.run(async (signal) => {
            this.q('.player-status').textContent = this.text.preparing;
            try {
                await this.playback.play(this.ha, record.entity_id, record.id, this.q('video'), signal, (state, error) => {
                    if (signal.aborted)
                        return;
                    this.active = state === 'preparing';
                    if (state === 'failed') {
                        this.clearVideo();
                        this.q('.player-status').textContent = this.failure(error);
                    }
                    else
                        this.q('.player-status').textContent = state === 'preparing' ? this.text.preparing : '';
                });
                this.q('.player-status').textContent = '';
            }
            catch (error) {
                if (!signal.aborted)
                    this.clearVideo();
                throw error;
            }
        });
    }
}
customElements.define('eufy-events-card', EufyEventsCard);
window.customCards = window.customCards || [];
window.customCards.push({ type: 'eufy-events-card', name: 'Eufy Events', description: 'Existing HomeBase recordings in one timeline.', preview: true });
