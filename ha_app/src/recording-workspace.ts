import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

let root: Promise<string> | undefined;
/** Private per-process workspace, including recovery after a bridge crash. */
export function recordingWorkspace(): Promise<string> {
  root ??= (async () => {
    const parent = process.env.EUFY_DATA_DIR ?? '/data', own = `eufy-recording-${process.pid}`;
    for (const name of await readdir(parent)) {
      const match = /^eufy-recording-([1-9][0-9]*)$/.exec(name);
      if (!match) continue;
      if (name !== own) {
        try { process.kill(Number(match[1]), 0); continue; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue; }
      }
      await rm(join(parent, name), { recursive: true, force: true });
    }
    const path = join(parent, own);
    await mkdir(path, { mode: 0o700 });
    return path;
  })();
  return root.then(path => mkdtemp(join(path, 'clip-')));
}
