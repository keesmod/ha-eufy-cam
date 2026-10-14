import { mkdir, readFile, rename, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export class Storage {
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly directory: string) {}
  async exists(name: string): Promise<boolean> {
    try { await stat(join(this.directory, name)); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  async writeOnce(name: string, value: string): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(join(this.directory, name), value, { mode: 0o600, flag: 'wx' });
  }
  async read(name: string): Promise<string | undefined> {
    try { return await readFile(join(this.directory, name), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  write(name: string, value: string): Promise<void> {
    const job = this.writes.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = join(this.directory, `.${randomUUID()}.tmp`);
      await writeFile(temporary, value, { mode: 0o600 });
      await rename(temporary, join(this.directory, name));
    });
    this.writes = job.catch(() => {});
    return job;
  }
  async flush(): Promise<void> { await this.writes; }
}
