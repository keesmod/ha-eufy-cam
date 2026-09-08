interface RecordingHA { fetchWithAuth(path: string, init?: RequestInit): Promise<Response> }

/** Native players need an HTTP source on macOS; blobs can stall indefinitely. */
class EufyRecordingPlayback {
  private release?: () => void;

  clear() { this.release?.(); this.release = undefined; }

  async prepare(ha: RecordingHA, entity: string, id: string, signal: AbortSignal): Promise<string> {
    const response = await ha.fetchWithAuth(`/api/eufy_viewer/recordings/${entity}/${id}/playback`, { method: 'POST', signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    if (typeof data.path !== 'string' || !/^\/api\/eufy_viewer\/playback\/[a-f0-9]{32}$/.test(data.path)
      || typeof data.url !== 'string' || !data.url.startsWith(data.path + '?authSig=')) throw new Error('Invalid playback');
    const url = new URL(data.url, location.origin);
    if (url.origin !== location.origin || url.pathname !== data.path || url.hash
      || [...url.searchParams.keys()].some(key => key !== 'authSig')) throw new Error('Invalid playback');
    const release = () => { void ha.fetchWithAuth(data.path, { method: 'DELETE', keepalive: true }).catch(() => {}); };
    if (signal.aborted) { release(); signal.throwIfAborted(); }
    this.clear(); this.release = release;
    return data.url;
  }

  async load(video: HTMLVideoElement, url: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
        clearTimeout(timer); video.removeEventListener('loadeddata', loaded);
        video.removeEventListener('error', failed); signal.removeEventListener('abort', aborted);
        if (error) reject(error); else resolve();
      };
      const loaded = () => finish();
      const failed = () => finish(new Error('Recording playback failed'));
      const aborted = () => finish(new DOMException('Aborted', 'AbortError'));
      const timer = setTimeout(failed, 20000);
      video.addEventListener('loadeddata', loaded, { once: true });
      video.addEventListener('error', failed, { once: true });
      signal.addEventListener('abort', aborted, { once: true });
      video.src = url; video.hidden = false;
      void video.play().catch(error => {
        // Native controls remain usable when automatic playback is denied.
        if (error.name !== 'NotAllowedError') finish(error);
      });
    });
  }
}
