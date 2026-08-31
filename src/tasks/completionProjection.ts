import type { Store } from "../storage/database.js";
import type { TaskRepository } from "./repository.js";
import type { TeamRepository } from "../teams/repository.js";
import { canCompleteTeam } from "../review/verdict.js";
import { canTransition } from "./stateMachine.js";
import type { Protocol } from "./protocol.js";

export class TaskCompletionProjection {
  constructor(private readonly store: Store, private readonly tasks: TaskRepository, private readonly teams: TeamRepository, private readonly protocol?: Protocol) {}

  reconcile(taskId: string): { projected: boolean; reason: string } {
    const task = this.tasks.get(taskId);
    if (!task) return { projected: false, reason: "TASK_NOT_FOUND" };
    const team = this.teams.get(taskId);
    if (!team) return { projected: false, reason: "NO_TEAM" };
    if (["FAIL", "BLOCKED", "HUMAN_GATE"].includes(task.status)) return { projected: false, reason: `STATUS_NOT_PROJECTABLE:${task.status}` };
    if (task.status === "WAITING_MAIN") {
      const chain = this.store.db.prepare("SELECT 1 AS present FROM protocol_events WHERE task_id=? AND event_type='VERDICT' AND payload_json LIKE '%chain_complete%' LIMIT 1").get(taskId);
      if (!chain) return { projected: false, reason: "STATUS_NOT_PROJECTABLE:WAITING_MAIN" };
    }
    if (!this.teams.allPassed(taskId)) return { projected: false, reason: "NOT_ALL_PASSED" };
    const roles = this.teams.roles(taskId);
    if (!canCompleteTeam(task, roles)) return { projected: false, reason: "GATE_NOT_SATISFIED" };
    if (team.status !== "COMPLETE") {
      const chain = this.store.db.prepare("SELECT payload_json FROM protocol_events WHERE task_id=? AND event_type='VERDICT' ORDER BY created_at DESC LIMIT 1").get(taskId) as { payload_json: string } | undefined;
      let chainComplete = false;
      try { chainComplete = Boolean(chain && (JSON.parse(chain.payload_json) as Record<string, unknown>).chain_complete === true); } catch { /* malformed evidence fails closed */ }
      if (!chainComplete) return { projected: false, reason: `TEAM_NOT_COMPLETE:${team.status}` };
      this.teams.complete(taskId);
    }
    if (task.completionCandidate !== true) this.tasks.setCompletionCandidate(taskId, true);
    if (task.status === "COMPLETED") return { projected: false, reason: "ALREADY_COMPLETED" };
    if (task.status === "PASS") return this.authoritativeCompletion(taskId);
    const allowedFrom = new Set(["DISPATCHED", "CLAIMED", "RUNNING", "WAITING_RESULT", "REVIEWING", "WAITING_MAIN"]);
    if (!allowedFrom.has(task.status)) return { projected: false, reason: `STATUS_NOT_PROJECTABLE:${task.status}` };
    const finalResult = [...roles].reverse().find((item) => item.result)?.result || "TEAM_COMPLETE: all required Roles passed";
    this.projectToPass(taskId, finalResult);
    if (!this.protocol) return { projected: true, reason: "PROJECTED_TO_PASS" };
    return this.authoritativeCompletion(taskId);
  }

  backfill(limit = 200): { checked: number; projected: string[] } {
    const rows = this.store.db.prepare(
      "SELECT DISTINCT t.task_id FROM tasks t JOIN task_teams tt ON tt.task_id=t.task_id WHERE t.status NOT IN ('COMPLETED','FAIL','CANCELLED') AND (tt.status='COMPLETE' OR EXISTS (SELECT 1 FROM protocol_events p WHERE p.task_id=t.task_id AND p.event_type='VERDICT' AND p.payload_json LIKE '%chain_complete%')) LIMIT ?",
    ).all(limit) as Array<{ task_id: string }>;
    const projected: string[] = [];
    for (const row of rows) {
      const result = this.reconcile(String(row.task_id));
      if (result.projected) projected.push(String(row.task_id));
    }
    return { checked: rows.length, projected };
  }

  private authoritativeCompletion(taskId: string): { projected: boolean; reason: string } {
    const task = this.tasks.get(taskId)!;
    // Isolated legacy callers without a Protocol retain the PASS projection;
    // live Runtime callers provide the authoritative Protocol sink.
    if (!this.protocol) return { projected: false, reason: "ALREADY_PASS" };
    const existing = this.store.db.prepare("SELECT event_id FROM protocol_events WHERE task_id=? AND event_type='COMPLETION' LIMIT 1").get(taskId) as { event_id: string } | undefined;
    if (!existing) {
      void this.protocol.emit("COMPLETION", task, "ORCHESTRATOR", "MAIN", {
          status: "COMPLETED", chain_complete: true, completion_authority: "TASK_COMPLETION_PROJECTION",
      }).catch(() => { /* durable event admission remains recoverable on restart */ });
    }
    const current = this.tasks.get(taskId)!;
    if (current.status === "PASS") {
      this.tasks.transition(taskId, "COMPLETED", { result: current.result || "TEAM_COMPLETE: all required Roles passed" });
      return { projected: true, reason: "AUTHORITATIVE_COMPLETION" };
    }
    return { projected: false, reason: current.status === "COMPLETED" ? "ALREADY_COMPLETED" : `STATUS_NOT_COMPLETABLE:${current.status}` };
  }

  private projectToPass(taskId: string, finalResult: string): void {
    let task = this.tasks.get(taskId)!;
    const walk = (from: string, to: string): boolean => {
      if (task.status !== from) return false;
      if (!canTransition(task.status as never, to as never)) return false;
      task = this.tasks.transition(taskId, to as never, to === "PASS" ? { result: finalResult } : {});
      return true;
    };
    if (task.status === "DISPATCHED") { walk("DISPATCHED", "CLAIMED"); }
    if (task.status === "CLAIMED") walk("CLAIMED", "RUNNING");
    if (task.status === "RUNNING") walk("RUNNING", "WAITING_RESULT");
    if (task.status === "WAITING_RESULT") walk("WAITING_RESULT", "PASS");
    if (task.status === "REVIEWING") walk("REVIEWING", "PASS");
    if (task.status === "WAITING_MAIN") walk("WAITING_MAIN", "PASS");
  }
}
