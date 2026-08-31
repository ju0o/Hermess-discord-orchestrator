import type { Store } from "../storage/database.js";
import type { TaskAdmission } from "../tasks/taskAdmission.js";
import type { TaskRecord } from "../domain/types.js";

const ALLOWED_DECISION = "RECOVERY_JUDGMENT";
const REQUIRED_ROLE = "ASUS";
const RUNTIME_CONTINUATION_OWNERS = new Set(["RUNTIME", "WORKER"]);

/** A Manager proposal can request this action, but only Runtime performs it. */
export type AsusProposalRuntimeAction = "CONTINUE_RUNTIME_ROUTING";

export interface AsusProposalConsumption {
  observationId: string;
  task: TaskRecord;
  continued: boolean;
  action: AsusProposalRuntimeAction;
}

/**
 * Runtime authority for the one bounded ASUS recovery proposal. The Manager
 * observation is advisory evidence; this class validates it and claims it in
 * SQLite before delegating to the existing watchdog continuation path.
 */
export class AsusProposalConsumer {
  constructor(private readonly store: Store, private readonly admission: TaskAdmission) {}

  async consume(taskId: string, acceptanceId: string): Promise<AsusProposalConsumption> {
    const candidate = this.findObservation(taskId, acceptanceId);
    if (this.store.db.prepare("SELECT 1 FROM manager_proposal_consumptions WHERE observation_id=?").get(candidate.observationId))
      throw new Error("ASUS_PROPOSAL_ALREADY_CONSUMED");
    const task = this.admission.status(taskId);
    if (!task) throw new Error("ASUS_PROPOSAL_TASK_NOT_FOUND");
    const taskRow = this.store.db.prepare("SELECT * FROM tasks WHERE task_id=?").get(taskId) as Record<string, unknown> | undefined;
    if (!taskRow) throw new Error("ASUS_PROPOSAL_TASK_NOT_FOUND");
    if (task.status !== "WAITING_MAIN") throw new Error("ASUS_PROPOSAL_ILLEGAL_TASK_STATE");
    if (Number(taskRow.execution_hold || 0) !== 0) throw new Error("ASUS_PROPOSAL_EXECUTION_HOLD_ACTIVE");
    if (!/^Watchdog detected no worker heartbeat for \d+ms\.$/.test(String(taskRow.result || ""))) throw new Error("ASUS_PROPOSAL_REQUIRES_WATCHDOG_STATE");
    if (this.store.db.prepare("SELECT 1 FROM worker_processes WHERE task_id=? AND status IN ('RUNNING','STARTED','BUSY') LIMIT 1").get(taskId))
      throw new Error("ASUS_PROPOSAL_ACTIVE_WORKER");

    try {
      this.store.transaction(() => {
        this.store.db.prepare(`INSERT INTO manager_proposal_consumptions
          (observation_id,task_id,acceptance_id,consumer,status,claimed_at) VALUES(?,?,?,?,?,?)`)
          .run(candidate.observationId, taskId, acceptanceId, "RUNTIME_ASUS_PROPOSAL_CONSUMER", "CLAIMED", this.store.now());
      });
    } catch { throw new Error("ASUS_PROPOSAL_ALREADY_CONSUMED"); }

    const result = await this.admission.continueTask(taskId);
    this.store.db.prepare("UPDATE manager_proposal_consumptions SET status=? WHERE observation_id=? AND status='CLAIMED'")
      .run(result.continued ? "COMPLETED" : "FAILED", candidate.observationId);
    if (!result.continued) throw new Error("ASUS_PROPOSAL_CONTINUATION_NOT_APPLIED");
    return { observationId: candidate.observationId, task: result.task, continued: true, action: candidate.action };
  }

  private findObservation(taskId: string, acceptanceId: string): {
    observationId: string;
    action: AsusProposalRuntimeAction;
  } {
    const rows = this.store.db.prepare(`SELECT metrics_json FROM performance_events
      WHERE task_id=? AND metric_type='MANAGER_INFERENCE' ORDER BY occurred_at ASC`).all(taskId) as Array<{ metrics_json: string }>;
    const matches = rows.flatMap((row) => {
      try {
        const value = JSON.parse(row.metrics_json) as Record<string, unknown>;
        if (value.acceptance_id !== acceptanceId || value.manager_role !== REQUIRED_ROLE || value.result_status !== "SUCCEEDED") return [];
        if (value.decision !== undefined && value.decision !== ALLOWED_DECISION) throw new Error("ASUS_PROPOSAL_OUTSIDE_AUTHORITY");
        // WORKER is a proposal for the same Runtime continuation, not an
        // assignment. TaskAdmission activates Dispatcher, which alone applies
        // normal capability/health/availability/SoD routing.
        if (typeof value.next_owner !== "string" || !RUNTIME_CONTINUATION_OWNERS.has(value.next_owner)) throw new Error("ASUS_PROPOSAL_OUTSIDE_AUTHORITY");
        if (value.decision === undefined) return [];
        if (value.task_id !== taskId) throw new Error("ASUS_PROPOSAL_TASK_MISMATCH");
        if (typeof value.observation_id !== "string" || !value.observation_id) throw new Error("ASUS_PROPOSAL_OBSERVATION_ID_MISSING");
        return [{ observationId: value.observation_id, action: "CONTINUE_RUNTIME_ROUTING" as AsusProposalRuntimeAction }];
      } catch (error) { if (error instanceof Error && error.message.startsWith("ASUS_PROPOSAL_")) throw error; return []; }
    });
    if (matches.length === 0) throw new Error("ASUS_PROPOSAL_NOT_DURABLY_AVAILABLE");
    if (matches.length !== 1) throw new Error("ASUS_PROPOSAL_AMBIGUOUS");
    return matches[0]!;
  }
}
