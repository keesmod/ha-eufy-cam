interface RecordingHA { fetchWithAuth(path: string, init?: RequestInit): Promise<Response> }

/** Native players need an HTTP source on macOS; blobs can stall indefinitely. */
class EufyRecordingPlayback {
  private release?: () => Promise<void>;
  private cancel?: () => void;

  private releaseMedia(): Promise<void> { const release = this.release; this.release = undefined; return release?.() ?? Promise.resolve(); }
  clear(): Promise<void> { this.cancel?.(); this.cancel = undefined; return this.releaseMedia(); }

  async play(ha: RecordingHA, entity: string, id: string, video: HTMLVideoElement, externalSignal: AbortSignal,
    changed: (state: 'preparing' | 'playing' | 'failed', error?: unknown) => void = () => {}): Promise<void> {
    await this.clear(); externalSignal.throwIfAborted();
    const controller = new AbortController(), signal = controller.signal;
    let native = Boolean(video.canPlayType('video/mp4; codecs="hvc1.1.6.L153.B0"'));
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
      const url = await this.prepare(ha, entity, id, signal);
      await this.load(video, url, signal, !paused);
      signal.throwIfAborted();
      if (Number.isFinite(position) && position > 0) video.currentTime = Math.min(position, Number.isFinite(video.duration) ? video.duration : position);
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
      const url = await this.prepare(ha, entity, id, signal, native);
      try { await this.load(video, url, signal); } catch (error) { await recover(error); }
      signal.throwIfAborted(); video.addEventListener('error', failed);
    } catch (error) { if (!signal.aborted) await this.clear(); throw error; }
  }

  async prepare(ha: RecordingHA, entity: string, id: string, signal: AbortSignal, native = false): Promise<string> {
    const response = await ha.fetchWithAuth(`/api/eufy_viewer/recordings/${entity}/${id}/playback${native ? "?format=native" : ""}`, { method: 'POST', signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    if (typeof data.path !== 'string' || !/^\/api\/eufy_viewer\/playback\/[a-f0-9]{32}$/.test(data.path)
      || typeof data.url !== 'string' || !data.url.startsWith(data.path + '?authSig=')) throw new Error('Invalid playback');
    const url = new URL(data.url, location.origin);
    if (url.origin !== location.origin || url.pathname !== data.path || url.hash
      || [...url.searchParams.keys()].some(key => key !== 'authSig')) throw new Error('Invalid playback');
    const release = async () => { await ha.fetchWithAuth(data.path, { method: 'DELETE', keepalive: true, signal: AbortSignal.timeout(5000) }).catch(() => {}); };
    if (signal.aborted) { await release(); signal.throwIfAborted(); }
    void this.releaseMedia(); this.release = release;
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
