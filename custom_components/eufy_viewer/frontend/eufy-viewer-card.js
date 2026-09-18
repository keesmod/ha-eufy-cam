const EUFY_VIEWER_CARD_VERSION = "0.8.22";
"use strict";
const recordingModeKey = 'eufy-viewer.recording-mode';
let recordingMemoryMode = 'auto';
let recordingStorageWritable = true;
function recordingMode() {
    if (!recordingStorageWritable)
        return recordingMemoryMode;
    try {
        const stored = localStorage.getItem(recordingModeKey);
        if (stored === 'auto' || stored === 'native' || stored === 'h264')
            recordingMemoryMode = stored;
    }
    catch { /* Storage is optional. */ }
    return recordingMemoryMode;
}
function recordingMedia(value) {
    if (!value || typeof value !== 'object')
        return;
    const m = value;
    if (!['h264', 'hevc'].includes(m.source) || !['h264', 'hevc'].includes(m.output) || typeof m.fallback !== 'boolean')
        return;
    if (m.processing === 'remux' ? m.source !== m.output || m.fallback
        : !['software', 'nvidia'].includes(m.processing) || m.source !== 'hevc' || m.output !== 'h264' || (m.processing === 'nvidia' && m.fallback))
        return;
    return { source: m.source, output: m.output, processing: m.processing, fallback: m.fallback };
}
const RECORDING_TEXT = {
    en: { mode: 'Playback format', unknown: 'Processing unknown', remux: 'Native remux', software: 'Software transcode', nvidia: 'NVIDIA transcode', fallback: 'Software transcode after NVIDIA failure', codec: 'This browser cannot play the original codec. Select H.264.', prepared: 'How this recording was prepared' },
    nl: { mode: 'Afspeelformaat', unknown: 'Verwerking onbekend', remux: 'Native remux', software: 'Softwareconversie', nvidia: 'NVIDIA-conversie', fallback: 'Softwareconversie na NVIDIA-fout', codec: 'Deze browser kan de oorspronkelijke codec niet afspelen. Kies H.264.', prepared: 'Zo is deze opname voorbereid' },
};
/** Shared, local-only preference and request-specific media status for both cards. */
class EufyRecordingControls {
    language;
    select = document.createElement('select');
    status = document.createElement('span');
    label = document.createElement('span');
    media;
    prepared = false;
    refresh = () => this.update();
    constructor(host, language, changed) {
        this.language = language;
        const root = document.createElement('div'), label = document.createElement('label');
        root.className = 'recording-controls';
        root.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:12px 16px;font-size:13px';
        label.style.cssText = 'display:flex;align-items:center;gap:8px';
        this.select.className = 'recording-mode';
        this.select.style.cssText = 'font:inherit;color:inherit;min-height:42px;padding:8px;background:var(--card-background-color,#fff);border:1px solid var(--divider-color,#ccc);border-radius:8px';
        for (const [value, text] of [['auto', 'Auto'], ['native', 'Native'], ['h264', 'H.264']]) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = text;
            this.select.append(option);
        }
        this.status.className = 'recording-media';
        this.status.setAttribute('role', 'status');
        this.status.setAttribute('aria-live', 'polite');
        label.append(this.label, this.select);
        root.append(label, this.status);
        host.insertBefore(root, host.querySelector('video'));
        this.select.onchange = () => {
            recordingMemoryMode = this.select.value;
            try {
                localStorage.setItem(recordingModeKey, recordingMemoryMode);
            }
            catch {
                recordingStorageWritable = false;
            }
            window.dispatchEvent(new Event('eufy-recording-mode'));
            changed();
        };
        this.update();
    }
    connect() { window.addEventListener('eufy-recording-mode', this.refresh); window.addEventListener('storage', this.refresh); this.update(); }
    disconnect() { window.removeEventListener('eufy-recording-mode', this.refresh); window.removeEventListener('storage', this.refresh); }
    update(media, prepared) {
        if (prepared !== undefined) {
            this.media = media;
            this.prepared = prepared;
        }
        const text = RECORDING_TEXT[this.language()?.startsWith('nl') ? 'nl' : 'en'];
        this.select.value = recordingMode();
        this.label.textContent = text.mode;
        this.status.title = text.prepared;
        this.status.textContent = !this.prepared ? '' : !this.media ? text.unknown : this.media.fallback ? text.fallback : text[this.media.processing];
    }
    codecError() { return RECORDING_TEXT[this.language()?.startsWith('nl') ? 'nl' : 'en'].codec; }
}
/** Native players need an HTTP source on macOS; blobs can stall indefinitely. */
class EufyRecordingPlayback {
    release;
    cancel;
    cleanup = Promise.resolve();
    media;
    releaseMedia() { const release = this.release; this.release = undefined; this.cleanup = this.cleanup.then(() => release?.()); return this.cleanup; }
    clear() { this.media = undefined; this.cancel?.(); this.cancel = undefined; return this.releaseMedia(); }
    async play(ha, entity, id, video, externalSignal, changed = () => { }, restore) {
        await this.clear();
        externalSignal.throwIfAborted();
        const controller = new AbortController(), signal = controller.signal;
        const mode = recordingMode();
        const hevcSupported = Boolean(video.canPlayType('video/mp4; codecs="hvc1.1.6.L153.B0"'));
        let native = mode === 'auto' && hevcSupported;
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
            const url = await this.prepare(ha, entity, id, signal, 'h264');
            await this.load(video, url, signal, !paused);
            signal.throwIfAborted();
            if (Number.isFinite(position) && position > 0)
                video.currentTime = position;
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
            const url = await this.prepare(ha, entity, id, signal, mode, hevcSupported);
            if (this.media?.output === 'h264')
                native = false;
            try {
                await this.load(video, url, signal, !restore?.paused);
            }
            catch (error) {
                await recover(error);
            }
            // Fragmented MP4 duration can still describe only its first fragment here.
            // The saved position belongs to this same clip, so do not clamp to it.
            if (restore) {
                if (Number.isFinite(restore.time) && restore.time > 0)
                    video.currentTime = restore.time;
                if (restore.paused)
                    video.pause();
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
    async prepare(ha, entity, id, signal, format = 'h264', hevcSupported = false) {
        this.media = undefined;
        const query = format === 'auto' ? `?format=auto&hevc_supported=${hevcSupported}` : format === 'native' ? '?format=native' : '';
        const response = await ha.fetchWithAuth(`/api/eufy_viewer/recordings/${entity}/${id}/playback${query}${query ? "&" : "?"}card_version=${encodeURIComponent(EUFY_VIEWER_CARD_VERSION)}`, { method: 'POST', signal });
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
        await this.releaseMedia();
        if (signal.aborted) {
            await release();
            signal.throwIfAborted();
        }
        this.release = release;
        this.media = recordingMedia(data.media);
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
/** Use HA's existing admin-only diagnostics download. Never starts camera work. */
class EufyDiagnosticControl {
    context;
    button = document.createElement('button');
    status = document.createElement('span');
    busy = false;
    constructor(host, context) {
        this.context = context;
        this.button.type = 'button';
        this.button.className = 'close diagnostic-download';
        this.status.setAttribute('role', 'status');
        this.status.className = 'diagnostic-status';
        const root = document.createElement('div');
        root.className = 'diagnostic-controls';
        root.style.cssText = 'padding:0 16px 12px';
        root.append(this.button, this.status);
        host.append(root);
        this.button.onclick = () => { void this.download(); };
        this.update(false);
    }
    update(show = true) {
        const { ha } = this.context();
        this.button.hidden = !show || ha?.user?.is_admin !== true;
        this.button.textContent = ha?.language?.startsWith('nl') ? 'Diagnose downloaden' : 'Download diagnostics';
        this.button.title = ha?.language?.startsWith('nl') ? 'Download vóór het herstarten. Recente pogingen blijven vijftien minuten bewaard.' : 'Download before restarting. Recent attempts are retained for fifteen minutes.';
        if (!show)
            this.status.textContent = '';
    }
    async download() {
        const { ha, entity } = this.context();
        if (this.busy || !ha || ha.user?.is_admin !== true || !entity)
            return;
        this.busy = true;
        this.button.disabled = true;
        this.status.textContent = '';
        const abort = new AbortController();
        let timer;
        try {
            const timeout = new Promise((_, reject) => { timer = window.setTimeout(() => { abort.abort(); reject(new Error('timeout')); }, 15000); });
            await Promise.race([timeout, (async () => {
                    const raw = await ha.callWS({ type: 'config/entity_registry/get', entity_id: entity });
                    if (abort.signal.aborted)
                        return;
                    const entry = raw?.config_entry_id;
                    if (typeof entry !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(entry))
                        throw new Error('entry');
                    const response = await ha.fetchWithAuth(`/api/diagnostics/config_entry/${entry}`, { signal: abort.signal });
                    if (!response.ok || !response.body)
                        throw new Error('download');
                    const reader = response.body.getReader();
                    const chunks = [];
                    let size = 0;
                    try {
                        for (;;) {
                            const { done, value } = await reader.read();
                            if (done)
                                break;
                            size += value.byteLength;
                            if (size > 2 * 1024 * 1024 || abort.signal.aborted)
                                throw new Error('limit');
                            chunks.push(new Uint8Array(value));
                        }
                    }
                    finally {
                        await reader.cancel().catch(() => { });
                        reader.releaseLock();
                    }
                    if (abort.signal.aborted)
                        return;
                    const url = URL.createObjectURL(new Blob(chunks, { type: 'application/json' }));
                    const link = document.createElement('a');
                    link.href = url;
                    link.download = 'eufy-diagnostics.json';
                    link.click();
                    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
                })()]);
        }
        catch {
            this.status.textContent = ha.language?.startsWith('nl') ? ' Download mislukt. Probeer via Instellingen → Apparaten en diensten → Eufy Security Viewer.' : ' Download failed. Use Settings → Devices & services → Eufy Security Viewer.';
        }
        finally {
            abort.abort();
            clearTimeout(timer);
            this.busy = false;
            this.button.disabled = false;
        }
    }
}

/** Eufy Viewer: snapshots at rest, a single explicit user gesture per live session. */
const TEXT = {
    en: { recording_storage_unavailable: "Not enough recording storage. Close other recordings or try Native.", capability_unavailable: "This media operation is unavailable for the camera connection.", videoOnly: "Live video without sound", switching: "Switching to live video without sound…", live: "Watch live", close: "Close live view", connecting: "Connecting…", ended: "Live view ended. Tap again to watch.", station_limit: "Another camera on this HomeBase is live. Close that live view first, then tap again.", unavailable: "Camera unavailable", noSnapshot: "No snapshot received yet", title: "Camera", error: "Live view failed. Tap again to retry.", sound: "Enable sound", mute: "Mute sound", recordings: "Recordings", date: "Date", load: "Show recordings", loading: "Loading HomeBase recordings…", preparing: "Preparing recording…", empty: "No recordings returned for this camera and date.", recordingError: "HomeBase recording unavailable. Load the date again.", live_busy: "A live viewer is still open. Close it and load the date again.", live_stopping: "The previous live session is still stopping. Wait a moment and load the date again.", recording_busy: "Another recording is being prepared. Wait a moment and try again.", recording_expired: "This recording link has expired. Load the date again.", recording_unavailable: "The HomeBase connection is unavailable. Try again shortly.", closeRecordings: "Close recordings", results: "recordings returned", homebaseTime: "HomeBase time", liveMode: "Live view", liveModeDialog: "Popup dialog (default)", liveModeInline: "Inside the card, for several live cameras" },
    nl: { recording_storage_unavailable: "Onvoldoende opslag voor deze opname. Sluit andere opnames of probeer Native.", capability_unavailable: "Deze mediafunctie is niet beschikbaar voor de cameraverbinding.", videoOnly: "Livebeeld zonder geluid", switching: "Omschakelen naar livebeeld zonder geluid…", live: "Live bekijken", close: "Livebeeld sluiten", connecting: "Verbinden…", ended: "Livebeeld gestopt. Tik opnieuw om te kijken.", station_limit: "Een andere camera op deze HomeBase is live. Sluit eerst dat livebeeld en tik dan opnieuw.", unavailable: "Camera niet beschikbaar", noSnapshot: "Nog geen snapshot ontvangen", title: "Camera", error: "Livebeeld mislukt. Tik opnieuw om te proberen.", sound: "Geluid aan", mute: "Geluid uit", recordings: "Opnames", date: "Datum", load: "Opnames tonen", loading: "HomeBase-opnames laden…", preparing: "Opname voorbereiden…", empty: "Geen opnames teruggegeven voor deze camera en datum.", recordingError: "HomeBase-opname niet beschikbaar. Laad de datum opnieuw.", live_busy: "Er staat nog een livebeeld open. Sluit dit en laad de datum opnieuw.", live_stopping: "De vorige live-sessie wordt nog afgesloten. Wacht even en laad de datum opnieuw.", recording_busy: "Er wordt al een opname voorbereid. Wacht even en probeer opnieuw.", recording_expired: "Deze opnamelink is verlopen. Laad de datum opnieuw.", recording_unavailable: "De HomeBase-verbinding is niet beschikbaar. Probeer het zo opnieuw.", closeRecordings: "Opnames sluiten", results: "opnames teruggegeven", homebaseTime: "HomeBase-tijd", liveMode: "Livebeeld", liveModeDialog: "Pop-updialoog (standaard)", liveModeInline: "In de kaart, voor meerdere livecamera's" },
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
    _jpegFallback = false;
    _fallbackPending = false;
    _fallbackSupported = false;
    _rtcSubscription;
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
    _recordId;
    _recordControls;
    _liveDiagnostics;
    _recordDiagnostics;
    _rtc;
    _rtcCandidates = [];
    _iceEvidence = new WeakMap();
    _audioRtc;
    _audioCandidates = [];
    _audioTimeout;
    _audioAttempted = false;
    /** Late audio peer state for playback reports. The bridge announces audio once per session. */
    _audioState = "none";
    _tick;
    _videoCallback;
    _diagnosticTimer;
    _audioDiagnosticTimer;
    _soundDiagnosticTimer;
    _playback;
    _dialog;
    /** The live view elements. Inline mode moves them from the modal dialog into the card. */
    _stage;
    _stopButton;
    _inline = false;
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
        .capability{padding:10px 16px;color:var(--secondary-text-color);font-size:12px;line-height:1.5}.capability:empty{display:none}
        .snapshot,.live{display:block;width:100%;aspect-ratio:16/9;object-fit:contain;background:#10161e}
        .snapshot[hidden],.empty[hidden],.live[hidden],.sound[hidden],.record-video[hidden]{display:none}.empty{display:grid;place-items:center;aspect-ratio:16/9;padding:24px;color:var(--secondary-text-color);font-size:13px;background:var(--secondary-background-color,#18212b)}
        .play{position:absolute;right:16px;bottom:16px;display:grid;place-items:center;width:44px;height:44px;border-radius:50%;background:#0008;font-size:20px;color:white;pointer-events:none}.preview:disabled{cursor:default}.preview:disabled .play{display:none}
        .preview[hidden],.stage[hidden]{display:none}.stage.inline{position:relative;background:#10161e}.stage.inline img.live:not([src]){visibility:hidden}.stage.inline .bar{position:absolute;top:0;left:0;right:0;z-index:1;justify-content:flex-end;padding:8px;background:linear-gradient(#000a,#0000)}
        .stage.inline #live-title,.stage.inline .live-status{display:none}.stage.inline .close{background:#000a;color:#fff}
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
        <div class="capability" role="note"></div><div class="meta"><div class="name"></div><div class="status" role="status" aria-live="polite"></div><button class="close record-open" type="button"></button></div>
      </ha-card>
      <dialog aria-labelledby="live-title"><div class="stage"><div class="bar"><span id="live-title"></span><button class="sound close" type="button" hidden></button><button class="close stop" type="button"></button></div><div class="live-status" role="status" aria-live="polite"></div><img class="live" alt=""><video class="live video" playsinline autoplay muted hidden></video></div></dialog>
      <dialog class="record-dialog" aria-labelledby="record-title"><div class="bar"><span id="record-title"></span><button class="close record-close" type="button"></button></div><div class="record-filters"><label><span class="date-label"></span><input type="date" class="record-date"></label><button class="close record-load" type="button"></button></div><div class="record-status" role="status" aria-live="polite"></div><video class="record-video" playsinline controls hidden></video><div class="record-list"></div></dialog>`;
        this._recordDialog = this.shadowRoot.querySelector(".record-dialog");
        this._recordVideo = this.shadowRoot.querySelector(".record-video");
        this._recordDate = this.shadowRoot.querySelector(".record-date");
        this._recordControls = new EufyRecordingControls(this._recordDialog, () => this._hass?.language, () => {
            if (this._recordDialog.open && this._recordId)
                void this._playRecording(this._recordId, { time: this._recordVideo.currentTime, paused: !this._recordVideo.hidden && this._recordVideo.paused });
        });
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
            this._scheduleSoundReport();
            this._sound.textContent = this._video.muted ? this._text().sound : this._text().mute;
            if (this._open)
                void this._video.play().catch(() => this._stop("error"));
        });
        this._dialog = this.shadowRoot.querySelector("dialog");
        this._stage = this.shadowRoot.querySelector(".stage");
        this._stopButton = this.shadowRoot.querySelector(".stop");
        // Escape closes the modal dialog through its cancel event. An inline live view closes on Escape while it has focus.
        this._stage.addEventListener("keydown", event => { if (event.key === "Escape" && this._inline && this._open) {
            event.preventDefault();
            this._stop();
        } });
        this._liveDiagnostics = new EufyDiagnosticControl(this.shadowRoot.querySelector(".meta"), () => ({ ha: this._hass, entity: this._config?.entity }));
        this._recordDiagnostics = new EufyDiagnosticControl(this._recordDialog, () => ({ ha: this._hass, entity: this._config?.entity }));
        this._preview.addEventListener("click", () => { void this._start(); });
        this._stopButton.addEventListener("click", () => this._stop());
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
        if (config.live_mode !== undefined && !["dialog", "inline"].includes(config.live_mode))
            throw new Error('live_mode must be "dialog" or "inline"');
        const inline = config.live_mode === "inline";
        if (this._config?.entity !== config.entity) {
            this._stop();
            this._closeRecordings();
        }
        if (inline !== this._inline) {
            // A mode change stops the current view first, then moves the live elements.
            this._stop();
            this._inline = inline;
            this._stage.classList.toggle("inline", inline);
            if (inline)
                this._preview.after(this._stage);
            else
                this._dialog.append(this._stage);
            this._stage.hidden = inline;
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
        this._recordControls.disconnect();
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
        const capabilities = state?.attributes.capabilities;
        this._preview.disabled = !available || capabilities?.live?.available === false;
        this.shadowRoot.querySelector(".record-open").disabled = !available || capabilities?.recordings?.available === false;
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
        const notes = Object.entries(capabilities ?? {}).filter(([feature]) => ["snapshot", "live", "recordings"].includes(feature)).map(([feature, capability]) => {
            const label = feature === "live" ? text.live : feature === "recordings" ? text.recordings : "Snapshot";
            if (capability.available === false)
                return `${label}: ${this._capabilityReason(capability.reason)}`;
            return "";
        }).filter(Boolean);
        this.shadowRoot.querySelector(".capability").textContent = notes.join(". ");
        const received = capabilities?.snapshot?.available === false ? undefined : state?.attributes.snapshot_received_at;
        if (capabilities?.live?.available === false && this._open)
            this._stop();
        if (capabilities?.recordings?.available === false && this._recordDialog.open)
            this._closeRecordings();
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
    _permits(feature) { return this._hass?.states[this._config?.entity ?? ""]?.attributes.capabilities?.[feature]?.available !== false; }
    _capabilityReason(reason) {
        const nl = this._hass?.language?.startsWith("nl");
        if (reason === "standalone_transport_unverified")
            return nl ? "standalone cameraverbinding nog niet ondersteund" : "standalone camera transport is not implemented";
        if (reason === "camera_media_unverified")
            return nl ? "media onbewezen voor deze camera en HomeBase-firmware" : "media unverified for this camera and owner firmware";
        if (reason === "invalid_connection_credentials")
            return nl ? "bruikbare lokale verbindingsgegevens ontbreken" : "usable local connection credentials are missing";
        return nl ? "niet beschikbaar voor deze cameraverbinding" : "unavailable for this camera connection";
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
        this._recordControls.update(undefined, false);
    }
    _closeRecordings() { this._recordId = undefined; this._clearRecording(); if (this._recordDialog?.open)
        this._recordDialog.close(); }
    async _recordingResponse(response) {
        if (response.ok)
            return;
        const data = await response.json().catch(() => ({}));
        const allowed = ["recording_storage_unavailable", "live_busy", "live_stopping", "recording_busy", "recording_expired", "recording_unavailable", "capability_unavailable"];
        throw new Error(allowed.includes(data.error) ? data.error : "recordingError");
    }
    _recordingFailure(error) {
        this._recordDiagnostics.update(true);
        if (error instanceof RecordingCodecError && recordingMode() === "native")
            return this._recordControls.codecError();
        const code = error instanceof Error ? error.message : "recordingError";
        const text = this._text();
        return ["recording_storage_unavailable", "live_busy", "live_stopping", "recording_busy", "recording_expired", "recording_unavailable", "capability_unavailable"].includes(code) ? text[code] : text.recordingError;
    }
    async _loadRecordings() {
        this._recordId = undefined;
        this._recordControls.update();
        if (!this._permits("recordings"))
            return;
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
    async _playRecording(id, restore) {
        if (!this._permits("recordings"))
            return;
        this._clearRecording();
        const generation = this._recordGeneration;
        if (!this._hass || !this._config || !this._recordDialog.open)
            return;
        this._recordId = id;
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
                else {
                    this._recordStatus(state === 'preparing' ? this._text().preparing : '');
                    this._recordControls.update(this._recordPlayback.media, state === 'playing');
                }
            }, restore);
            if (generation !== this._recordGeneration || controller.signal.aborted)
                return;
            this._recordStatus("");
            this._recordControls.update(this._recordPlayback.media, true);
        }
        catch (error) {
            if (generation === this._recordGeneration && this._recordDialog.open) {
                this._clearRecording();
                this._recordStatus(this._recordingFailure(error));
            }
        }
    }
    _status(message) {
        this.shadowRoot.querySelector(".status").textContent = message;
        this.shadowRoot.querySelector(".live-status").textContent = message;
    }
    _watching(generation) { return this._open && generation === this._generation && this.isConnected && this._visible && document.visibilityState === "visible" && (this._inline ? !this._stage.hidden : this._dialog.open); }
    async _start() {
        this._liveDiagnostics.update(false);
        if (this._open || this._preview.disabled || !this._hass || !this._config || !this._visible || document.visibilityState !== "visible")
            return;
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
        this._audioAttempted = false;
        this._audioState = "none";
        this._live.hidden = webrtc;
        this._video.hidden = !webrtc;
        this._sound.hidden = !webrtc;
        this._video.muted = true;
        this._sound.textContent = this._text().sound;
        this._open = true;
        if (this._inline) {
            this._preview.hidden = true;
            this._stage.hidden = false;
            this._stopButton.focus();
        }
        else
            this._dialog.showModal();
        this._status(this._text().connecting);
        this._startup = setTimeout(() => { if (this._watching(generation))
            this._stop("error"); }, 25_000);
        try {
            const unsubscribe = await this._hass.connection.subscribeMessage(event => { void this._event(event, generation); }, { type: "eufy_viewer/watch", entity_id: this._config.entity, transport: webrtc ? "webrtc" : "jpeg", ...(webrtc && this._hass.states[this._config.entity]?.attributes.viewer_late_audio ? { late_audio: true } : {}) }, { resubscribe: false });
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
            this._stop(event.reason === "station_limit" ? "station_limit" : "ended");
            return;
        }
        if (event.type === "fallback") {
            void this._reportLive("fallback");
            this._fallbackPending = false;
            this._jpegFallback = true;
            this._closeRTC();
            this._live.hidden = false;
            this._video.hidden = true;
            this._sound.hidden = true;
            this._status(this._text().videoOnly);
            return;
        }
        if (event.type === "audio_ready" || event.type === "audio_answer" || event.type === "audio_candidate" || event.type === "audio_ended") {
            if (this._jpegFallback || this._fallbackPending)
                return;
            try {
                await this._audioEvent(event, generation);
            }
            catch {
                if (this._watching(generation))
                    this._closeAudio(true);
            }
            return;
        }
        if (event.type !== "frame") {
            if (this._jpegFallback || this._fallbackPending)
                return;
            try {
                await this._rtcEvent(event, generation);
            }
            catch {
                if (generation === this._generation)
                    await this._fallback("signaling_error", generation);
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
            this._status(this._jpegFallback ? this._text().videoOnly : "");
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
    _closeAudio(notify = false) {
        clearTimeout(this._audioTimeout);
        const pc = this._audioRtc;
        this._audioRtc = undefined;
        this._audioCandidates = [];
        if (pc) {
            this._audioState = "ended";
            pc.onconnectionstatechange = null;
            pc.ontrack = null;
            pc.onicecandidate = null;
            pc.onicecandidateerror = null;
            for (const { track } of pc.getReceivers()) {
                track.onunmute = null;
                this._video.srcObject?.removeTrack(track);
                track.stop();
            }
            pc.close();
            if (notify && this._rtcSubscription !== undefined)
                void this._hass?.callWS({
                    type: "eufy_viewer/signal", subscription: this._rtcSubscription, audio: true, stop: true,
                }).catch(() => { });
        }
    }
    async _audioEvent(event, generation) {
        if (event.type === "audio_ended") {
            this._closeAudio();
            return;
        }
        if (event.type === "audio_ready") {
            // One audio peer per session. The bridge announces its AAC once, either
            // right after video (warm camera) or seconds into playback (cold camera),
            // possibly after the viewer already enabled sound on the video element.
            if (this._audioAttempted || !this._rtc || this._rtcSubscription === undefined)
                return;
            this._audioAttempted = true;
            this._audioState = "connecting";
            const pc = this._audioRtc = this._createPeer(event);
            const active = () => this._watching(generation) && this._audioRtc === pc;
            this._audioTimeout = window.setTimeout(() => { if (active())
                this._closeAudio(true); }, 15000);
            pc.addTransceiver("audio", { direction: "recvonly" });
            pc.ontrack = event => {
                if (!active() || event.track.kind !== "audio")
                    return;
                const stream = this._video.srcObject;
                if (!stream || stream.getAudioTracks().length) {
                    this._closeAudio(true);
                    return;
                }
                // Adding the track to the element's live stream keeps its current
                // mute and volume settings: sound enabled earlier stays enabled.
                stream.addTrack(event.track);
                this._audioState = "attached";
                event.track.onunmute = () => { if (active())
                    clearTimeout(this._audioTimeout); };
                if (!event.track.muted)
                    clearTimeout(this._audioTimeout);
                void this._video.play().catch(() => { if (active())
                    this._closeAudio(true); });
            };
            pc.onconnectionstatechange = () => {
                if (active() && ["disconnected", "failed", "closed"].includes(pc.connectionState))
                    this._closeAudio(true);
            };
            await this._offer(pc, active, true);
        }
        else if (event.type === "audio_answer") {
            const pc = this._audioRtc;
            if (!pc || pc.remoteDescription)
                return;
            await pc.setRemoteDescription({ type: "answer", sdp: event.sdp });
            if (!this._watching(generation) || this._audioRtc !== pc)
                return;
            for (const candidate of this._audioCandidates.splice(0))
                await pc.addIceCandidate(candidate);
        }
        else {
            const pc = this._audioRtc;
            if (!pc)
                return;
            if (event.candidate.length > 2048 || this._audioCandidates.length >= 64)
                throw new Error("Invalid candidate");
            const candidate = { candidate: event.candidate, sdpMid: "0", sdpMLineIndex: 0 };
            if (pc.remoteDescription)
                await pc.addIceCandidate(candidate);
            else
                this._audioCandidates.push(candidate);
        }
    }
    _createPeer(config) {
        const servers = config.ice_servers ?? [];
        const pc = new RTCPeerConnection({ iceServers: servers });
        const evidence = {
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
    async _offer(pc, active, audio) {
        const subscription = this._rtcSubscription, generation = this._generation;
        const fail = () => { if (active()) {
            if (audio)
                this._closeAudio(true);
            else
                void this._fallback("signaling_error", generation);
        } };
        let offered = false, count = 0;
        const pending = [];
        const send = (candidate) => {
            if (!active())
                return;
            void this._hass.callWS({ type: "eufy_viewer/signal", subscription, ...(audio ? { audio: true } : {}), candidate }).then(result => { if (!result.accepted)
                fail(); }).catch(fail);
        };
        // Trickle after the offer is accepted. Slow or unreachable STUN/TURN must
        // not hold up host candidates or discard a relay found later in startup.
        pc.onicecandidate = event => {
            if (!active() || !event.candidate)
                return;
            const candidate = event.candidate.candidate;
            if (++count > 64 || candidate.length > 2048) {
                fail();
                return;
            }
            if (offered)
                send(candidate);
            else
                pending.push(candidate);
        };
        const offer = await pc.createOffer();
        if (!active())
            return;
        await pc.setLocalDescription(offer);
        if (!active())
            return;
        const result = await this._hass.callWS({ type: "eufy_viewer/signal", subscription, ...(audio ? { audio: true } : {}), offer: offer.sdp });
        if (!active())
            return;
        if (!result.accepted)
            throw new Error("Offer rejected");
        offered = true;
        pending.splice(0).forEach(send);
    }
    _closeRTC() {
        this._closeAudio();
        clearTimeout(this._diagnosticTimer);
        clearTimeout(this._audioDiagnosticTimer);
        clearTimeout(this._soundDiagnosticTimer);
        this._soundDiagnosticTimer = undefined;
        if (this._videoCallback !== undefined)
            this._video.cancelVideoFrameCallback(this._videoCallback);
        this._videoCallback = undefined;
        this._tick = undefined;
        if (this._rtc) {
            this._rtc.onconnectionstatechange = null;
            this._rtc.ontrack = null;
            this._rtc.onicecandidate = null;
            this._rtc.onicecandidateerror = null;
            this._rtc.close();
        }
        this._rtc = undefined;
        this._rtcCandidates = [];
        this._video.pause();
        this._video.srcObject?.getTracks().forEach(track => track.stop());
        this._video.srcObject = null;
    }
    async _fallback(reason, generation) {
        if (!this._watching(generation) || this._jpegFallback || this._fallbackPending)
            return;
        if (!this._fallbackSupported || this._rtcSubscription === undefined) {
            this._stop("error");
            return;
        }
        void this._reportLive("fallback");
        this._fallbackPending = true;
        this._closeRTC();
        this._status(this._text().switching);
        try {
            const result = await this._hass.callWS({ type: "eufy_viewer/fallback", subscription: this._rtcSubscription, reason });
            if (!result.accepted && this._watching(generation) && !this._jpegFallback)
                this._stop("error");
        }
        catch {
            if (this._watching(generation) && !this._jpegFallback)
                this._stop("error");
        }
    }
    async _rtcEvent(event, generation) {
        if (event.type === "ready") {
            this._fallbackSupported = event.fallback === true;
            this._rtcSubscription = event.subscription;
            this._playback.enabled = event.diagnostics === true;
            this._diagnosticTimer = window.setTimeout(() => { void this._reportLive("startup"); }, 5000);
            this._audioDiagnosticTimer = window.setTimeout(() => { void this._reportLive("audio_check"); }, 15000);
            if (this._rtc || !this._video.requestVideoFrameCallback)
                throw new Error("WebRTC unavailable");
            const pc = this._rtc = this._createPeer(event);
            pc.addTransceiver("video", { direction: "recvonly" });
            pc.addTransceiver("audio", { direction: "recvonly" });
            const stream = new MediaStream();
            this._video.srcObject = stream;
            pc.ontrack = event => {
                if (!this._watching(generation) || this._rtc !== pc)
                    return;
                stream.addTrack(event.track);
                void this._video.play().catch(() => { if (this._rtc === pc)
                    void this._fallback("playback_error", generation); });
            };
            pc.onconnectionstatechange = () => {
                if (this._rtc === pc && ["disconnected", "failed", "closed"].includes(pc.connectionState))
                    void this._fallback("connection_failed", generation);
            };
            await this._offer(pc, () => this._watching(generation) && this._rtc === pc, false);
            if (this._watching(generation) && this._rtc === pc)
                this._painted(generation);
        }
        else if (event.type === "answer") {
            const pc = this._rtc;
            if (!pc || pc.remoteDescription)
                throw new Error("Unexpected answer");
            await pc.setRemoteDescription({ type: "answer", sdp: event.sdp });
            if (!this._watching(generation) || this._rtc !== pc)
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
            if (this._playback)
                this._playback.ticks++;
            this._tick = { subscription: event.subscription, sequence: event.sequence };
        }
    }
    _painted(generation) {
        this._videoCallback = this._video.requestVideoFrameCallback(() => {
            if (!this._watching(generation) || !this._rtc || this._fallbackPending || this._jpegFallback)
                return;
            const playback = this._playback;
            playback.painted++;
            playback.lastFrame = performance.now();
            this._scheduleSoundReport();
            clearTimeout(this._startup);
            this._status("");
            const tick = this._tick;
            this._tick = undefined;
            if (tick)
                playback.sent++;
            if (tick)
                void this._hass.callWS({ type: "eufy_viewer/ack", ...tick }).then(result => {
                    if (result.accepted && this._watching(generation) && this._playback === playback) {
                        playback.accepted++;
                        void this._reportLive("playing");
                    }
                    if (!result.accepted && this._watching(generation) && !this._jpegFallback && !this._fallbackPending)
                        this._stop("ended");
                }).catch(() => { if (this._watching(generation) && !this._jpegFallback && !this._fallbackPending)
                    this._stop("error"); });
            this._painted(generation);
        });
    }
    _scheduleSoundReport() {
        if (this._video.muted) {
            clearTimeout(this._soundDiagnosticTimer);
            this._soundDiagnosticTimer = undefined;
            return;
        }
        if (!this._rtc || !this._playback?.enabled || this._playback.reports.has("unmuted") || this._soundDiagnosticTimer !== undefined)
            return;
        this._soundDiagnosticTimer = window.setTimeout(() => { this._soundDiagnosticTimer = undefined; void this._reportLive("unmuted"); }, 1000);
    }
    async _reportLive(trigger) {
        const playback = this._playback, pc = this._rtc, hass = this._hass;
        const subscription = this._rtcSubscription, generation = this._generation;
        if (!playback?.enabled || !pc || !hass || subscription === undefined || playback.reports.has(trigger))
            return;
        playback.reports.add(trigger);
        const report = {
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
            for (const [key, value] of Object.entries(this._iceEvidence.get(this._audioRtc) ?? {}))
                report[`audio_${key}`] = value;
        }
        const audioTracks = this._video.srcObject?.getAudioTracks?.() ?? [];
        report.audio_tracks = audioTracks.length;
        report.audio_tracks_muted = audioTracks.filter(track => track.muted).length;
        report.audio_tracks_enabled = audioTracks.filter(track => track.enabled).length;
        report.audio_tracks_ended = audioTracks.filter(track => track.readyState === "ended").length;
        if (playback.lastFrame !== undefined)
            report.last_frame_ms = Math.round(performance.now() - playback.lastFrame);
        let timer;
        try {
            const peers = [pc, ...(this._audioRtc ? [this._audioRtc] : [])];
            if (typeof pc.getTransceivers === "function")
                report.audio_negotiated = peers.some(peer => peer.getTransceivers().some(t => t.receiver.track.kind === "audio" && ["recvonly", "sendrecv"].includes(t.currentDirection ?? "")));
            const reports = await Promise.race([Promise.all(peers.map(peer => peer.getStats().catch(() => undefined))), new Promise(resolve => { timer = window.setTimeout(resolve, 1000); })]);
            for (const stats of reports ?? []) {
                if (!stats)
                    continue;
                report.stats_available = true;
                const count = (key, value) => {
                    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
                        report[key] = Number(report[key] ?? 0) + value;
                };
                stats.forEach(stat => {
                    if (stat.type === "inbound-rtp" && ["video", "audio"].includes(stat.kind)) {
                        count(`${stat.kind}_packets`, stat.packetsReceived);
                        count(`${stat.kind}_bytes`, stat.bytesReceived);
                        if (typeof stat.packetsLost === "number" && Number.isSafeInteger(stat.packetsLost))
                            report[`${stat.kind}_lost`] = Number(report[`${stat.kind}_lost`] ?? 0) + stat.packetsLost;
                        for (const [key, value] of Object.entries({ jitter: stat.jitter, buffer_delay: stat.jitterBufferDelay, buffer_target_delay: stat.jitterBufferTargetDelay, buffer_min_delay: stat.jitterBufferMinimumDelay })) {
                            if (typeof value === "number" && Number.isFinite(value) && value >= 0)
                                count(`${stat.kind}_${key}_ms`, Math.round(value * 1000));
                        }
                        count(`${stat.kind}_buffer_emitted`, stat.jitterBufferEmittedCount);
                        if (stat.kind === "video") {
                            count("video_decoded", stat.framesDecoded);
                            count("video_dropped", stat.framesDropped);
                            count("video_received", stat.framesReceived);
                            count("video_keyframes", stat.keyFramesDecoded);
                            count("video_nack", stat.nackCount);
                            count("video_pli", stat.pliCount);
                            count("video_fir", stat.firCount);
                        }
                        else {
                            const codec = stats.get(stat.codecId);
                            const mime = typeof codec?.mimeType === "string" ? codec.mimeType.toLowerCase() : "";
                            if (["audio/opus", "audio/pcma", "audio/pcmu", "audio/g722", "audio/mp4a-latm"].includes(mime))
                                report.audio_codec = mime;
                            if (Number.isInteger(codec?.clockRate) && codec.clockRate > 0 && codec.clockRate <= 192000)
                                report.audio_clock_rate = codec.clockRate;
                            if (Number.isInteger(codec?.channels) && codec.channels > 0 && codec.channels <= 8)
                                report.audio_channels = codec.channels;
                            count("audio_samples", stat.totalSamplesReceived);
                            count("concealed_samples", stat.concealedSamples);
                            if (typeof stat.totalAudioEnergy === "number")
                                report.audio_energy = Boolean(report.audio_energy) || stat.totalAudioEnergy > 0;
                        }
                    }
                    const prefix = stats === reports?.[0] ? "" : "audio_";
                    if (["local-candidate", "remote-candidate"].includes(stat.type) && ["host", "srflx", "prflx", "relay"].includes(stat.candidateType)) {
                        count(`${prefix}${stat.type === "local-candidate" ? "local" : "remote"}_${stat.candidateType}`, 1);
                    }
                    if (stat.type === "candidate-pair" && ["frozen", "waiting", "in-progress", "failed", "succeeded"].includes(stat.state))
                        count(`${prefix}pairs_${stat.state.replace("-", "_")}`, 1);
                    // Selected transport type only. Never copy candidate addresses or IDs.
                    if (stats === reports?.[0] && stat.type === "transport" && stat.selectedCandidatePairId) {
                        const pair = stats.get(stat.selectedCandidatePairId);
                        const local = pair && stats.get(pair.localCandidateId), remote = pair && stats.get(pair.remoteCandidateId);
                        if (local) {
                            report.local_candidate = local.candidateType;
                            report.protocol = local.protocol;
                        }
                        if (remote)
                            report.remote_candidate = remote.candidateType;
                    }
                });
            }
            if (generation === this._generation && this._open)
                await hass.callWS({ type: "eufy_viewer/live_diagnostics", subscription, report });
        }
        catch { /* Diagnostics cannot interrupt playback or renew a lease. */ }
        finally {
            clearTimeout(timer);
        }
    }
    _stop(reason) {
        this._liveDiagnostics.update(reason !== undefined);
        this._generation++;
        this._open = false;
        clearTimeout(this._startup);
        this._closeRTC();
        const unsubscribe = this._unsubscribe;
        this._unsubscribe = null;
        if (unsubscribe)
            Promise.resolve().then(unsubscribe).catch(() => { });
        if (this._dialog.open)
            this._dialog.close();
        if (this._inline) {
            const focused = this.shadowRoot.activeElement !== null && this._stage.contains(this.shadowRoot.activeElement);
            this._stage.hidden = true;
            this._preview.hidden = false;
            if (focused)
                this._preview.focus();
        }
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
    _form;
    setConfig(config) { this._config = config; this._render(); }
    set hass(hass) { this._hass = hass; this._render(); }
    _text() { return TEXT[this._hass?.language?.startsWith("nl") ? "nl" : "en"]; }
    _emit(config) {
        this._config = config;
        this.dispatchEvent(new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }));
    }
    _render() {
        if (!this._hass || !this._config)
            return;
        if (!this._picker || !this._form) {
            this._picker = document.createElement("ha-entity-picker");
            this._picker.label = "Camera";
            this._picker.includeDomains = ["camera"];
            this._picker.addEventListener("value-changed", event => {
                const value = event.detail.value;
                if (!this._config || value === this._config.entity)
                    return;
                this._emit({ ...this._config, entity: value });
            });
            this._form = document.createElement("ha-form");
            this._form.computeLabel = () => this._text().liveMode;
            this._form.addEventListener("value-changed", event => {
                const value = event.detail.value?.live_mode;
                if (!this._config)
                    return;
                // The default mode is stored as an absent key, so a saved card config stays minimal.
                const { live_mode, ...rest } = this._config;
                const next = value === "inline" ? { ...rest, live_mode: "inline" } : rest;
                if (next.live_mode !== live_mode)
                    this._emit(next);
            });
            this.append(this._picker, this._form);
        }
        this._picker.hass = this._hass;
        this._picker.value = this._config.entity;
        this._picker.entityFilter = entity => Boolean(entity.attributes.viewer_card);
        const text = this._text();
        this._form.hass = this._hass;
        this._form.schema = [{ name: "live_mode", selector: { select: { mode: "dropdown", options: [{ value: "dialog", label: text.liveModeDialog }, { value: "inline", label: text.liveModeInline }] } } }];
        this._form.data = { live_mode: this._config.live_mode ?? "dialog" };
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
    nl: { storage: 'Onvoldoende opslag voor deze opname. Sluit andere opnames of probeer Native.', title: 'Gebeurtenissen', all: 'Alle camera’s', camera: 'Camera', date: 'Datum', show: 'Opnames tonen', hint: 'Kies een dag en toon de bestaande HomeBase-opnames.', loading: 'Opnames laden…', preparing: 'Opname voorbereiden…', calendar: 'Kalender', month: 'Maand', calendarHint: '• Opnames op deze HomeBase (alle camera’s)', calendarError: 'Opnamedagen niet beschikbaar voor deze gebruiker of HomeBase.', prev: 'Vorige opname', next: 'Volgende opname', close: 'Sluiten', pagePrev: 'Vorige pagina', pageNext: 'Volgende pagina', none: 'Geen opnames op deze dag voor deze camera.', results: 'opnames', time: 'HomeBase-tijd', noThumb: 'Geen voorbeeldbeeld', expired: 'Opnamelink verlopen. Laad de datum opnieuw.', error: 'Opnames niet beschikbaar. Probeer de datum opnieuw.', incomplete: 'De volledige dag kon niet worden bevestigd. Probeer opnieuw.', live: 'Sluit de livebeelden voordat je opnames laadt.', stopping: 'De vorige live-sessie wordt nog afgesloten. Probeer het zo opnieuw.', busy: 'Een andere opname wordt voorbereid. Probeer het zo opnieuw.', stopped: 'Gestopt. Tik op Opnames tonen om verder te kijken.' },
    en: { storage: 'Not enough recording storage. Close other recordings or try Native.', title: 'Events', all: 'All cameras', camera: 'Camera', date: 'Date', show: 'Show recordings', hint: 'Choose a day to view existing HomeBase recordings.', loading: 'Loading recordings…', preparing: 'Preparing recording…', calendar: 'Calendar', month: 'Month', calendarHint: '• Recordings on this HomeBase (all cameras)', calendarError: 'Recording days unavailable for this user or HomeBase.', prev: 'Previous recording', next: 'Next recording', close: 'Close', pagePrev: 'Previous page', pageNext: 'Next page', none: 'No recordings for this camera and day.', results: 'recordings', time: 'HomeBase time', noThumb: 'No preview available', expired: 'Recording link expired. Load the date again.', error: 'Recordings unavailable. Load the date again.', incomplete: 'The complete day could not be confirmed. Try again.', live: 'Close live viewers before loading recordings.', stopping: 'The previous live session is still stopping. Try again shortly.', busy: 'Another recording is being prepared. Try again shortly.', stopped: 'Stopped. Tap Show recordings to continue.' }
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
    controls;
    diagnostics;
    observer;
    cameraKey = '';
    loadedDate = '';
    visibilityChanged = () => { if (document.visibilityState !== 'visible')
        this.stop(); };
    leave = () => this.stop();
    q(selector) { return this.shadowRoot.querySelector(selector); }
    get text() { return EVENTS_TEXT[this.ha?.language?.startsWith('nl') ? 'nl' : 'en']; }
    cameras() { return Object.keys(this.ha?.states ?? {}).filter(id => id.startsWith('camera.') && this.ha.states[id].attributes.viewer_card && this.ha.states[id].attributes.capabilities?.recordings?.available !== false && (!this.config.entities || this.config.entities.includes(id))).sort(); }
    name(id) { return this.ha?.states[id]?.attributes.friendly_name ?? id; }
    filtered() { const camera = this.q('.camera').value; return this.records.filter(r => this.cameras().includes(r.entity_id) && (!camera || r.entity_id === camera)); }
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
        this.diagnostics = new EufyDiagnosticControl(this.q('dialog'), () => ({ ha: this.ha, entity: this.filtered()[this.selected]?.entity_id }));
        this.controls = new EufyRecordingControls(this.q('dialog'), () => this.ha?.language, () => {
            if (this.q('dialog').open) {
                const v = this.q('video');
                this.play(this.selected, { time: v.currentTime, paused: !v.hidden && v.paused });
            }
        });
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
        const previous = this.cameras();
        this.ha = value;
        if (previous.some(id => !this.cameras().includes(id)))
            this.stop();
        this.labels();
    }
    connectedCallback() {
        this.controls.connect();
        document.addEventListener('visibilitychange', this.visibilityChanged);
        window.addEventListener('pagehide', this.leave);
        this.ha?.connection.addEventListener('disconnected', this.leave);
        this.observer = new IntersectionObserver(entries => { if (!entries[0]?.isIntersecting)
            this.stop(); });
        this.observer.observe(this);
    }
    disconnectedCallback() { this.controls.disconnect(); this.stop(); this.observer?.disconnect(); document.removeEventListener('visibilitychange', this.visibilityChanged); window.removeEventListener('pagehide', this.leave); this.ha?.connection.removeEventListener('disconnected', this.leave); }
    labels() {
        this.controls.update();
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
        if (!cameras.length) {
            this.stop();
            this.q('.status').textContent = this.ha?.language?.startsWith('nl') ? 'Geen camera met beschikbare opnames. Bekijk de camerakaart voor de reden.' : 'No camera with available recordings. See the camera card for the reason.';
        }
    }
    clearVideo() { const v = this.q('video'); v.pause(); v.removeAttribute('src'); v.load(); v.hidden = true; this.playback.clear(); this.controls.update(undefined, false); }
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
    failure(error) { this.diagnostics.update(); if (error instanceof RecordingCodecError && recordingMode() === "native")
        return this.controls.codecError(); const code = error instanceof Error ? error.message : ''; return code === 'recording_storage_unavailable' ? this.text.storage : code === 'live_busy' ? this.text.live : code === 'live_stopping' ? this.text.stopping : code === 'recording_busy' ? this.text.busy : code === 'recording_expired' ? this.text.expired : code === 'history_incomplete' ? this.text.incomplete : this.text.error; }
    async fetch(path, signal) { signal.throwIfAborted(); const response = await this.ha.fetchWithAuth(path, { signal }); if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error);
    } return response; }
    query() { return `/api/eufy_viewer/events?entities=${encodeURIComponent(this.cameras().join(','))}`; }
    load() {
        if (!this.cameras().length)
            return;
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
        if (!this.cameras().length)
            return;
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
    play(index, restore) {
        const records = this.filtered(), record = records[index];
        if (!record || !this.cameras().includes(record.entity_id))
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
                    else {
                        this.q('.player-status').textContent = state === 'preparing' ? this.text.preparing : '';
                        this.controls.update(this.playback.media, state === 'playing');
                    }
                }, restore);
                if (signal.aborted)
                    return;
                this.q('.player-status').textContent = '';
                this.controls.update(this.playback.media, true);
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
