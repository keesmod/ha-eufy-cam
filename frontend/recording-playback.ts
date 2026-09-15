declare const EUFY_VIEWER_CARD_VERSION: string;
interface RecordingHA { fetchWithAuth(path: string, init?: RequestInit): Promise<Response> }

type RecordingMode = 'auto' | 'native' | 'h264';
interface RecordingMedia { source: 'h264' | 'hevc'; output: 'h264' | 'hevc'; processing: 'remux' | 'software' | 'nvidia'; fallback: boolean }
interface RecordingPosition { time: number; paused: boolean }
const recordingModeKey = 'eufy-viewer.recording-mode';
let recordingMemoryMode: RecordingMode = 'auto';
let recordingStorageWritable = true;
function recordingMode(): RecordingMode {
  if (!recordingStorageWritable) return recordingMemoryMode;
  try { const stored = localStorage.getItem(recordingModeKey); if (stored === 'auto' || stored === 'native' || stored === 'h264') recordingMemoryMode = stored; } catch { /* Storage is optional. */ }
  return recordingMemoryMode;
}
function recordingMedia(value: unknown): RecordingMedia | undefined {
  if (!value || typeof value !== 'object') return;
  const m = value as RecordingMedia;
  if (!['h264', 'hevc'].includes(m.source) || !['h264', 'hevc'].includes(m.output) || typeof m.fallback !== 'boolean') return;
  if (m.processing === 'remux' ? m.source !== m.output || m.fallback
    : !['software', 'nvidia'].includes(m.processing) || m.source !== 'hevc' || m.output !== 'h264' || (m.processing === 'nvidia' && m.fallback)) return;
  return { source: m.source, output: m.output, processing: m.processing, fallback: m.fallback };
}
const RECORDING_TEXT = {
  en: { mode: 'Playback format', unknown: 'Processing unknown', remux: 'Native remux', software: 'Software transcode', nvidia: 'NVIDIA transcode', fallback: 'Software transcode after NVIDIA failure', codec: 'This browser cannot play the original codec. Select H.264.', prepared: 'How this recording was prepared' },
  nl: { mode: 'Afspeelformaat', unknown: 'Verwerking onbekend', remux: 'Native remux', software: 'Softwareconversie', nvidia: 'NVIDIA-conversie', fallback: 'Softwareconversie na NVIDIA-fout', codec: 'Deze browser kan de oorspronkelijke codec niet afspelen. Kies H.264.', prepared: 'Zo is deze opname voorbereid' },
};

/** Shared, local-only preference and request-specific media status for both cards. */
class EufyRecordingControls {
  private select = document.createElement('select');
  private status = document.createElement('span');
  private label = document.createElement('span');
  private media?: RecordingMedia;
  private prepared = false;
  private refresh = () => this.update();
  constructor(host: HTMLElement, private language: () => string | undefined, changed: () => void) {
    const root = document.createElement('div'), label = document.createElement('label');
    root.className = 'recording-controls'; root.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:12px 16px;font-size:13px';
    label.style.cssText = 'display:flex;align-items:center;gap:8px';
    this.select.className = 'recording-mode'; this.select.style.cssText = 'font:inherit;color:inherit;min-height:42px;padding:8px;background:var(--card-background-color,#fff);border:1px solid var(--divider-color,#ccc);border-radius:8px';
    for (const [value, text] of [['auto','Auto'],['native','Native'],['h264','H.264']]) { const option = document.createElement('option'); option.value = value; option.textContent = text; this.select.append(option); }
    this.status.className = 'recording-media'; this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
    label.append(this.label, this.select); root.append(label, this.status); host.insertBefore(root, host.querySelector('video'));
    this.select.onchange = () => {
      recordingMemoryMode = this.select.value as RecordingMode;
      try { localStorage.setItem(recordingModeKey, recordingMemoryMode); } catch { recordingStorageWritable = false; }
      window.dispatchEvent(new Event('eufy-recording-mode')); changed();
    };
    this.update();
  }
  connect() { window.addEventListener('eufy-recording-mode', this.refresh); window.addEventListener('storage', this.refresh); this.update(); }
  disconnect() { window.removeEventListener('eufy-recording-mode', this.refresh); window.removeEventListener('storage', this.refresh); }
  update(media?: RecordingMedia, prepared?: boolean) {
    if (prepared !== undefined) { this.media = media; this.prepared = prepared; }
    const text = RECORDING_TEXT[this.language()?.startsWith('nl') ? 'nl' : 'en'];
    this.select.value = recordingMode(); this.label.textContent = text.mode;
    this.status.title = text.prepared;
    this.status.textContent = !this.prepared ? '' : !this.media ? text.unknown : this.media.fallback ? text.fallback : text[this.media.processing];
  }
  codecError() { return RECORDING_TEXT[this.language()?.startsWith('nl') ? 'nl' : 'en'].codec; }
}

/** Native players need an HTTP source on macOS; blobs can stall indefinitely. */
class EufyRecordingPlayback {
  private release?: () => Promise<void>;
  private cancel?: () => void;
  private cleanup: Promise<void> = Promise.resolve();
  media?: RecordingMedia;

  private releaseMedia(): Promise<void> { const release = this.release; this.release = undefined; this.cleanup = this.cleanup.then(() => release?.()); return this.cleanup; }
  clear(): Promise<void> { this.media = undefined; this.cancel?.(); this.cancel = undefined; return this.releaseMedia(); }

  async play(ha: RecordingHA, entity: string, id: string, video: HTMLVideoElement, externalSignal: AbortSignal,
    changed: (state: 'preparing' | 'playing' | 'failed', error?: unknown) => void = () => {},
    restore?: RecordingPosition): Promise<void> {
    await this.clear(); externalSignal.throwIfAborted();
    const controller = new AbortController(), signal = controller.signal;
    const mode = recordingMode();
    const hevcSupported = Boolean(video.canPlayType('video/mp4; codecs="hvc1.1.6.L153.B0"'));
    let native = mode === 'auto' && hevcSupported;
    let recovering = false;
    const detach = () => video.removeEventListener('error', failed);
    const cancel = () => { controller.abort(); detach(); externalSignal.removeEventListener('abort', cancel); };
    this.cancel = cancel; externalSignal.addEventListener('abort', cancel, { once: true });
    const recover = async (error: unknown, preservePosition = false) => {
      if (!native || signal.aborted || !(error instanceof RecordingCodecError)) throw error;
      native = false; // One fallback for the whole clip, including errors after the first frame.
      const position = video.currentTime, paused = preservePosition && video.paused;
      video.pause(); video.removeAttribute('src'); video.load();
      await this.releaseMedia(); signal.throwIfAborted();
      const url = await this.prepare(ha, entity, id, signal, 'h264');
      await this.load(video, url, signal, !paused);
      signal.throwIfAborted();
      if (Number.isFinite(position) && position > 0) video.currentTime = position;
    };
    const failed = () => {
      if (signal.aborted || recovering) return;
      recovering = true; detach();
      const error = video.error?.code === 3 || video.error?.code === 4
        ? new RecordingCodecError('Recording codec unsupported') : new Error('Recording playback failed');
      if (native && error instanceof RecordingCodecError) changed('preparing');
      void recover(error, true).then(() => {
        if (!signal.aborted) { recovering = false; video.addEventListener('error', failed); changed('playing'); }
      }).catch(async error => {
        if (signal.aborted) return;
        await this.clear();
        if (!externalSignal.aborted) changed('failed', error);
      });
    };
    try {
      const url = await this.prepare(ha, entity, id, signal, mode, hevcSupported);
      if (this.media?.output === 'h264') native = false;
      try { await this.load(video, url, signal, !restore?.paused); } catch (error) { await recover(error); }
      // Fragmented MP4 duration can still describe only its first fragment here.
      // The saved position belongs to this same clip, so do not clamp to it.
      if (restore) {
        if (Number.isFinite(restore.time) && restore.time > 0) video.currentTime = restore.time;
        if (restore.paused) video.pause();
      }
      signal.throwIfAborted(); video.addEventListener('error', failed);
    } catch (error) { if (!signal.aborted) await this.clear(); throw error; }
  }

  async prepare(ha: RecordingHA, entity: string, id: string, signal: AbortSignal, format: RecordingMode = 'h264', hevcSupported = false): Promise<string> {
    this.media = undefined;
    const query = format === 'auto' ? `?format=auto&hevc_supported=${hevcSupported}` : format === 'native' ? '?format=native' : '';
    const response = await ha.fetchWithAuth(`/api/eufy_viewer/recordings/${entity}/${id}/playback${query}${query ? "&" : "?"}card_version=${encodeURIComponent(EUFY_VIEWER_CARD_VERSION)}`, { method: 'POST', signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    if (typeof data.path !== 'string' || !/^\/api\/eufy_viewer\/playback\/[a-f0-9]{32}$/.test(data.path)
      || typeof data.url !== 'string' || !data.url.startsWith(data.path + '?authSig=')) throw new Error('Invalid playback');
    const url = new URL(data.url, location.origin);
    if (url.origin !== location.origin || url.pathname !== data.path || url.hash
      || [...url.searchParams.keys()].some(key => key !== 'authSig')) throw new Error('Invalid playback');
    const release = async () => { await ha.fetchWithAuth(data.path, { method: 'DELETE', keepalive: true, signal: AbortSignal.timeout(5000) }).catch(() => {}); };
    if (signal.aborted) { await release(); signal.throwIfAborted(); }
    await this.releaseMedia();
    if (signal.aborted) { await release(); signal.throwIfAborted(); }
    this.release = release; this.media = recordingMedia(data.media);
    return data.url;
  }

  async load(video: HTMLVideoElement, url: string, signal: AbortSignal, autoplay = true): Promise<void> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
        clearTimeout(timer); video.removeEventListener('loadeddata', loaded);
        video.removeEventListener('error', failed); signal.removeEventListener('abort', aborted);
        if (error) reject(error); else resolve();
      };
      const loaded = () => finish();
      const failed = () => finish(video.error?.code === 3 || video.error?.code === 4
        ? new RecordingCodecError('Recording codec unsupported') : new Error('Recording playback failed'));
      const aborted = () => finish(new DOMException('Aborted', 'AbortError'));
      const timer = setTimeout(failed, 20000);
      video.addEventListener('loadeddata', loaded, { once: true });
      video.addEventListener('error', failed, { once: true });
      signal.addEventListener('abort', aborted, { once: true });
      video.autoplay = autoplay; video.src = url; video.hidden = false;
      if (!autoplay) { video.load(); return; }
      void video.play().catch(error => {
        // Native controls remain usable when automatic playback is denied.
        if (error.name !== 'NotAllowedError') finish(error.name === 'NotSupportedError'
          ? new RecordingCodecError('Recording codec unsupported') : error);
      });
    });
  }
}

class RecordingCodecError extends Error {}


interface DiagnosticHA {
  user?: { is_admin?: boolean };
  language?: string;
  callWS(message: Record<string, unknown>): Promise<unknown>;
  fetchWithAuth(path: string, init?: RequestInit): Promise<Response>;
}
/** Use HA's existing admin-only diagnostics download. Never starts camera work. */
class EufyDiagnosticControl {
  readonly button = document.createElement('button');
  private readonly status = document.createElement('span');
  private busy = false;
  constructor(host: HTMLElement, private readonly context: () => { ha?: DiagnosticHA; entity?: string }) {
    this.button.type = 'button'; this.button.className = 'close diagnostic-download';
    this.status.setAttribute('role', 'status'); this.status.className = 'diagnostic-status';
    const root = document.createElement('div'); root.className = 'diagnostic-controls';
    root.style.cssText = 'padding:0 16px 12px'; root.append(this.button, this.status); host.append(root);
    this.button.onclick = () => { void this.download(); }; this.update(false);
  }
  update(show = true) {
    const { ha } = this.context();
    this.button.hidden = !show || ha?.user?.is_admin !== true;
    this.button.textContent = ha?.language?.startsWith('nl') ? 'Diagnose downloaden' : 'Download diagnostics';
    this.button.title = ha?.language?.startsWith('nl') ? 'Download vóór het herstarten. Recente pogingen blijven vijftien minuten bewaard.' : 'Download before restarting. Recent attempts are retained for fifteen minutes.';
    if (!show) this.status.textContent = '';
  }
  private async download() {
    const { ha, entity } = this.context();
    if (this.busy || !ha || ha.user?.is_admin !== true || !entity) return;
    this.busy = true; this.button.disabled = true; this.status.textContent = '';
    const abort = new AbortController();
    let timer: number | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => { timer = window.setTimeout(() => { abort.abort(); reject(new Error('timeout')); }, 15000); });
      await Promise.race([timeout, (async () => {
        const raw = await ha.callWS({ type: 'config/entity_registry/get', entity_id: entity });
        if (abort.signal.aborted) return;
        const entry = (raw as { config_entry_id?: unknown })?.config_entry_id;
        if (typeof entry !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(entry)) throw new Error('entry');
        const response = await ha.fetchWithAuth(`/api/diagnostics/config_entry/${entry}`, { signal: abort.signal });
        if (!response.ok || !response.body) throw new Error('download');
        const reader = response.body.getReader(); const chunks: Uint8Array<ArrayBuffer>[] = []; let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read(); if (done) break;
            size += value.byteLength;
            if (size > 2 * 1024 * 1024 || abort.signal.aborted) throw new Error('limit');
            chunks.push(new Uint8Array(value));
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        if (abort.signal.aborted) return;
        const url = URL.createObjectURL(new Blob(chunks, { type: 'application/json' }));
        const link = document.createElement('a'); link.href = url; link.download = 'eufy-diagnostics.json';
        link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      })()]);
    } catch {
      this.status.textContent = ha.language?.startsWith('nl') ? ' Download mislukt. Probeer via Instellingen → Apparaten en diensten → Eufy Security Viewer.' : ' Download failed. Use Settings → Devices & services → Eufy Security Viewer.';
    } finally { abort.abort(); clearTimeout(timer); this.busy = false; this.button.disabled = false; }
  }
}
