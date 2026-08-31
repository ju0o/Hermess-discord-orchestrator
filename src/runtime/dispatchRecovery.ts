import type { Store } from "../storage/database.js";
import type { TaskRepository } from "../tasks/repository.js";

export interface DispatchRecoveryResult { recoveryId: string; taskId: string; priorAssignment: string; status: string; }

export class RuntimeDispatchRecovery {
  constructor(private readonly store: Store, private readonly tasks: TaskRepository,
    private readonly redrive: (taskId: string) => Promise<boolean>) {}

  async recover(taskId: string, recoveryId: string, reason: string): Promise<DispatchRecoveryResult> {
    const task = this.tasks.get(taskId);
    if (!task) throw classified("DISPATCH_RECOVERY_TASK_NOT_FOUND");
    if (task.status !== "DISPATCHED") throw classified("DISPATCH_RECOVERY_STATE_REJECTED");
    if (task.executionHold) throw classified("DISPATCH_RECOVERY_EXECUTION_HOLD");
    if (!task.assignedAgent) throw classified("DISPATCH_RECOVERY_ASSIGNMENT_MISSING");
    if (this.store.db.prepare("SELECT 1 FROM worker_processes WHERE task_id=? AND status IN ('RUNNING','STARTED','BUSY') LIMIT 1").get(taskId)) throw classified("DISPATCH_RECOVERY_ACTIVE_WORKER");
    if (task.lockToken || this.store.db.prepare("SELECT 1 FROM workspace_locks WHERE task_id=? LIMIT 1").get(taskId)) throw classified("DISPATCH_RECOVERY_LIVE_LOCK");
    const delivery = this.store.db.prepare("SELECT created_at FROM protocol_events WHERE task_id=? AND event_type='TASK' ORDER BY created_at DESC LIMIT 1").get(taskId) as { created_at: string } | undefined;
    if (!delivery) throw classified("DISPATCH_RECOVERY_DELIVERY_MISSING");
    if (this.store.db.prepare("SELECT 1 FROM protocol_events WHERE task_id=? AND event_type IN ('ACK','RESULT') AND created_at>=? LIMIT 1").get(taskId, delivery.created_at)) throw classified("DISPATCH_RECOVERY_RESPONSE_EXISTS");
    try {
      this.store.db.prepare("INSERT INTO runtime_dispatch_recoveries(recovery_id,task_id,prior_assignment,reason,status,created_at) VALUES(?,?,?,?,?,?)")
        .run(recoveryId, taskId, task.assignedAgent, reason, "CLAIMED", this.store.now());
    } catch { throw classified("DISPATCH_RECOVERY_DUPLICATE"); }
    try {
      const dispatched = await this.redrive(taskId);
      if (!dispatched) throw classified("DISPATCH_RECOVERY_DISPATCH_REJECTED");
      this.store.db.prepare("UPDATE runtime_dispatch_recoveries SET status='SUCCEEDED',result='REDRIVEN',completed_at=? WHERE recovery_id=?").run(this.store.now(), recoveryId);
      return { recoveryId, taskId, priorAssignment: task.assignedAgent, status: "SUCCEEDED" };
    } catch (error) {
      this.store.db.prepare("UPDATE runtime_dispatch_recoveries SET status='FAILED',result=?,completed_at=? WHERE recovery_id=?").run(error instanceof Error ? error.message : String(error), this.store.now(), recoveryId);
      throw error;
    }
  }
}

function classified(classification: string): Error & { classification: string } { return Object.assign(new Error(classification), { classification }); }
