import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Store } from "../storage/database.js";

function overlaps(a: string[], b: string[]): boolean {
  const norm = (value: string) => path.resolve(value).toLowerCase();
  return a.some((left) => b.some((right) => {
    const l = norm(left), r = norm(right);
    return l === r || l.startsWith(`${r}${path.sep}`) || r.startsWith(`${l}${path.sep}`);
  }));
}

export class WorkspaceLocks {
  constructor(private readonly store: Store) {}

  acquire(taskId: string, workspace: string, fileScope: string[]): string | undefined {
    return this.store.transaction(() => {
      const locks = this.store.db.prepare("SELECT * FROM workspace_locks").all() as Record<string, unknown>[];
      const requested = fileScope.length ? fileScope.map((item) => path.join(workspace, item)) : [workspace];
      for (const lock of locks) {
        if (String(lock.task_id) === taskId) return String(lock.token);
        if (overlaps(requested, JSON.parse(String(lock.file_scope_json)))) return undefined;
      }
      const token = randomUUID(); const now = this.store.now();
      this.store.db.prepare("INSERT INTO workspace_locks(lock_key,task_id,token,file_scope_json,acquired_at,heartbeat_at) VALUES(?,?,?,?,?,?)")
        .run(`${path.resolve(workspace).toLowerCase()}|${token}`, taskId, token, JSON.stringify(requested), now, now);
      return token;
    });
  }

  canAcquire(taskId: string, workspace: string, fileScope: string[]): boolean {
    const locks = this.store.db.prepare("SELECT task_id,file_scope_json FROM workspace_locks").all() as Array<{ task_id: string; file_scope_json: string }>;
    const requested = fileScope.length ? fileScope.map((item) => path.join(workspace, item)) : [workspace];
    return locks.every((lock) => lock.task_id === taskId || !overlaps(requested, JSON.parse(lock.file_scope_json) as string[]));
  }

  heartbeat(token: string): void { this.store.db.prepare("UPDATE workspace_locks SET heartbeat_at=? WHERE token=?").run(this.store.now(), token); }
  release(token: string): void { this.store.db.prepare("DELETE FROM workspace_locks WHERE token=?").run(token); }
}
