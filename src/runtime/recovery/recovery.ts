import type { Store } from "../../storage/database.js";
import type { TaskRepository } from "../../tasks/repository.js";
import type { AgentRegistry } from "../../registry/agentRegistry.js";
import type { WorkspaceLocks } from "../../tasks/locks.js";

function pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

export interface RecoveryReport {
  processesChecked: number; lostProcesses: number; tasksMovedToWaitingMain: string[]; ambiguousDeliveries: number;
  agentsReleased: string[]; locksReleased: string[];
}

export interface RecoveryScope { taskIds: readonly string[]; }

export class Recovery {
  constructor(
    private readonly store: Store,
    private readonly tasks: TaskRepository,
    private readonly agents?: AgentRegistry,
    private readonly locks?: WorkspaceLocks,
  ) {}
  reconcile(scope?: RecoveryScope): RecoveryReport {
    const report: RecoveryReport = {
      processesChecked: 0, lostProcesses: 0, tasksMovedToWaitingMain: [], ambiguousDeliveries: 0,
      agentsReleased: [], locksReleased: [],
    };
    const scoped = scope?.taskIds.length ? [...new Set(scope.taskIds)] : undefined;
    const processSql = scoped
      ? `SELECT * FROM worker_processes WHERE status='RUNNING' AND task_id IN (${scoped.map(() => "?").join(",")})`
      : "SELECT * FROM worker_processes WHERE status='RUNNING'";
    const processes = this.store.db.prepare(processSql).all(...(scoped ?? [])) as Array<{ process_id: string; task_id: string; pid: number }>;
    for (const worker of processes) {
      report.processesChecked++;
      if (pidAlive(worker.pid)) continue;
      report.lostProcesses++;
      this.store.db.prepare("UPDATE worker_processes SET status='LOST',last_seen=? WHERE process_id=?").run(this.store.now(), worker.process_id);
      const task = this.tasks.get(worker.task_id);
      if (task && ["CLAIMED", "RUNNING"].includes(task.status)) {
        this.tasks.transition(task.taskId, "WAITING_MAIN", { result: "Worker process disappeared during runtime outage; task was not replayed automatically." });
        report.tasksMovedToWaitingMain.push(task.taskId);
        // Mirror Watchdog's stuck-task cleanup invariant (see watchdog.ts): fencing a dead
        // Worker off a Task must also release the workspace lock and the Agent's BUSY claim,
        // or the Agent/workspace stay wedged even though the Task itself moved to WAITING_MAIN.
        if (task.lockToken && this.locks) { this.locks.release(task.lockToken); report.locksReleased.push(task.lockToken); }
        if (task.assignedAgent && this.agents) {
          // Guard against releasing an Agent that was already reassigned to a different Task
          // in the interim (e.g. a later dispatch claimed it before this reconcile ran).
          const agent = this.agents.get(task.assignedAgent);
          if (agent && agent.currentTask === task.taskId) {
            this.agents.release(task.assignedAgent, true);
            report.agentsReleased.push(task.assignedAgent);
          }
        }
      }
    }
    const deliverySql = scoped
      ? `SELECT delivery_id FROM delivery_records WHERE state='attempting' AND task_id IN (${scoped.map(() => "?").join(",")})`
      : "SELECT delivery_id FROM delivery_records WHERE state='attempting'";
    const attempting = this.store.db.prepare(deliverySql).all(...(scoped ?? [])) as Array<{ delivery_id: string }>;
    report.ambiguousDeliveries = attempting.length;
    for (const delivery of attempting) this.store.db.prepare("UPDATE delivery_records SET state='ambiguous',last_error=?,updated_at=? WHERE delivery_id=?")
      .run("Runtime restarted during Discord send; requires reconciliation to avoid duplicate delivery", this.store.now(), delivery.delivery_id);
    this.store.upsertRuntimeState("runtime:last_recovery", report); return report;
  }
}
