import { config } from "../config/env.js";
import type { AgentRegistry } from "../registry/agentRegistry.js";
import type { Store } from "../storage/database.js";
import type { TaskRepository } from "../tasks/repository.js";
import type { WorkspaceLocks } from "../tasks/locks.js";

export class Watchdog {
  constructor(private readonly store: Store, private readonly tasks: TaskRepository, private readonly agents: AgentRegistry,
    private readonly locks: WorkspaceLocks, private readonly alert: (message: string) => Promise<void>) {}
  async check(taskIds?: readonly string[]): Promise<string[]> {
    const cutoff = Date.now() - config.TASK_STUCK_MS;
    const scoped = taskIds?.length ? [...new Set(taskIds)] : undefined;
    const sql = `SELECT t.task_id,t.assigned_agent,t.lock_token,
      COALESCE((SELECT MAX(w.last_seen) FROM worker_processes w WHERE w.task_id=t.task_id AND w.status='RUNNING'),t.updated_at) AS heartbeat
      FROM tasks t WHERE t.status IN ('CLAIMED','RUNNING')${scoped ? ` AND t.task_id IN (${scoped.map(() => "?").join(",")})` : ""}`;
    const rows = this.store.db.prepare(sql).all(...(scoped ?? [])) as Array<{ task_id: string; assigned_agent: string | null; lock_token: string | null; heartbeat: string }>;
    const stuck: string[] = [];
    for (const row of rows) {
      if (Date.parse(row.heartbeat) >= cutoff) continue;
      const task = this.tasks.get(row.task_id); if (!task) continue;
      this.tasks.transition(task.taskId, "WAITING_MAIN", { result: `Watchdog detected no worker heartbeat for ${config.TASK_STUCK_MS}ms.` });
      if (row.lock_token) this.locks.release(row.lock_token);
      if (row.assigned_agent) this.agents.release(row.assigned_agent as never, true);
      stuck.push(row.task_id);
    }
    if (stuck.length) await this.alert(`Task stuck; moved to WAITING_MAIN: ${stuck.join(", ")}`);
    return stuck;
  }
}
