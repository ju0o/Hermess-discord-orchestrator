import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config/env.js";

type LockRecord = { pid: number; startedAt: string; entry: string };

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export class RuntimeSingleton {
  private readonly lockPath = path.join(config.dataDir, "runtime", "orchestrator.pid.lock");
  private descriptor: number | undefined;

  acquire(): void {
    mkdirSync(path.dirname(this.lockPath), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        this.descriptor = openSync(this.lockPath, "wx");
        const record: LockRecord = { pid: process.pid, startedAt: new Date().toISOString(), entry: process.argv[1] || "unknown" };
        writeFileSync(this.descriptor, JSON.stringify(record), "utf8");
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let owner: Partial<LockRecord> = {};
        try { owner = JSON.parse(readFileSync(this.lockPath, "utf8")) as Partial<LockRecord>; } catch { /* stale or interrupted write */ }
        if (typeof owner.pid === "number" && pidAlive(owner.pid)) throw new Error(`RUNTIME_SINGLETON_HELD:${owner.pid}`);
        unlinkSync(this.lockPath);
      }
    }
    throw new Error("RUNTIME_SINGLETON_ACQUIRE_FAILED");
  }

  release(): void {
    if (this.descriptor === undefined) return;
    closeSync(this.descriptor); this.descriptor = undefined;
    try { unlinkSync(this.lockPath); } catch { /* already recovered or removed */ }
  }
}
