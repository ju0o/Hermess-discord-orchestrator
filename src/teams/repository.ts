import { randomUUID } from "node:crypto";
import type { AgentId, Role, RoleStatus, TaskRoleRecord, TaskType } from "../domain/types.js";
import type { Store } from "../storage/database.js";
import type { AgentRoutingDecision } from "../routing/agentRouter.js";

export interface TaskTeamRecord { taskId: string; taskType: TaskType; mode: "SEQUENTIAL"; status: "PLANNED" | "ACTIVE" | "BLOCKED" | "COMPLETE"; currentSequence?: number; compositionMessageId?: string; }

export class TeamRepository {
  constructor(private readonly store: Store) {}
  create(taskId: string, taskType: TaskType, roles: Role[]): TaskTeamRecord {
    const existing = this.get(taskId); if (existing) return existing; const now = this.store.now();
    this.store.transaction(() => {
      this.store.db.prepare("INSERT INTO task_teams(task_id,task_type,mode,status,created_at,updated_at) VALUES(?,?,'SEQUENTIAL','PLANNED',?,?)").run(taskId, taskType, now, now);
      const insert = this.store.db.prepare(`INSERT INTO task_roles(task_id,role,sequence,status,revision_round,created_at,evidence_json) VALUES(?,?,?,'PENDING',0,?,?)`);
      roles.forEach((role, index) => insert.run(taskId, role, index + 1, now, "[]"));
    }); return this.get(taskId)!;
  }
  get(taskId: string): TaskTeamRecord | undefined {
    const row = this.store.db.prepare("SELECT * FROM task_teams WHERE task_id=?").get(taskId) as Record<string, unknown> | undefined;
    return row ? { taskId: String(row.task_id), taskType: row.task_type as TaskType, mode: "SEQUENTIAL", status: row.status as TaskTeamRecord["status"],
      ...(row.current_sequence !== null ? { currentSequence: Number(row.current_sequence) } : {}), ...(row.composition_message_id ? { compositionMessageId: String(row.composition_message_id) } : {}) } : undefined;
  }
  roles(taskId: string): TaskRoleRecord[] {
    return (this.store.db.prepare("SELECT * FROM task_roles WHERE task_id=? ORDER BY sequence").all(taskId) as Record<string, unknown>[]).map(rowToRole);
  }
  role(taskId: string, sequence: number): TaskRoleRecord | undefined { const row = this.store.db.prepare("SELECT * FROM task_roles WHERE task_id=? AND sequence=?").get(taskId, sequence) as Record<string, unknown> | undefined; return row ? rowToRole(row) : undefined; }
  assign(taskId: string, sequence: number, agentId: AgentId, reason: string): TaskRoleRecord {
    this.store.db.prepare("UPDATE task_roles SET assigned_agent=?,status='ASSIGNED',routing_reason=?,completed_at=NULL WHERE task_id=? AND sequence=?").run(agentId, reason, taskId, sequence); return this.role(taskId, sequence)!;
  }
  block(taskId: string, sequence: number, reason: string): void {
    this.store.db.prepare("UPDATE task_roles SET status='BLOCKED',routing_reason=?,completed_at=? WHERE task_id=? AND sequence=?").run(reason, this.store.now(), taskId, sequence);
    this.store.db.prepare("UPDATE task_teams SET status='BLOCKED',updated_at=? WHERE task_id=?").run(this.store.now(), taskId);
  }
  activate(taskId: string, sequence: number): TaskRoleRecord {
    const now = this.store.now(); this.store.db.prepare("UPDATE task_roles SET status='ACTIVE',started_at=COALESCE(started_at,?) WHERE task_id=? AND sequence=?").run(now, taskId, sequence);
    this.store.db.prepare("UPDATE task_teams SET status='ACTIVE',current_sequence=?,updated_at=? WHERE task_id=?").run(sequence, now, taskId); return this.role(taskId, sequence)!;
  }
  finish(taskId: string, sequence: number, status: Extract<RoleStatus, "PASS" | "FAIL" | "BLOCKED">, result = "", evidence: string[] = []): TaskRoleRecord {
    this.store.db.prepare("UPDATE task_roles SET status=?,result=?,evidence_json=?,completed_at=? WHERE task_id=? AND sequence=?")
      .run(status, result, JSON.stringify(evidence), this.store.now(), taskId, sequence); return this.role(taskId, sequence)!;
  }
  reopen(taskId: string, sequence: number, round: number): TaskRoleRecord {
    this.store.db.prepare("UPDATE task_roles SET status='ACTIVE',revision_round=?,completed_at=NULL WHERE task_id=? AND sequence=?").run(round, taskId, sequence);
    this.store.db.prepare("UPDATE task_teams SET status='ACTIVE',current_sequence=?,updated_at=? WHERE task_id=?").run(sequence, this.store.now(), taskId); return this.role(taskId, sequence)!;
  }
  complete(taskId: string): void { this.store.db.prepare("UPDATE task_teams SET status='COMPLETE',current_sequence=NULL,updated_at=? WHERE task_id=?").run(this.store.now(), taskId); }
  allPassed(taskId: string): boolean { const row = this.store.db.prepare("SELECT count(*) total,sum(CASE WHEN status='PASS' THEN 1 ELSE 0 END) passed FROM task_roles WHERE task_id=?").get(taskId) as { total: number; passed: number }; return Number(row.total) > 0 && Number(row.total) === Number(row.passed); }
  setCompositionMessage(taskId: string, messageId: string): void { this.store.db.prepare("UPDATE task_teams SET composition_message_id=?,updated_at=? WHERE task_id=?").run(messageId, this.store.now(), taskId); }
  resetForRetry(taskId: string): void {
    const now = this.store.now(); this.store.transaction(() => {
      this.store.db.prepare("UPDATE task_teams SET status='PLANNED',current_sequence=NULL,updated_at=? WHERE task_id=?").run(now, taskId);
      this.store.db.prepare("UPDATE task_roles SET status=CASE WHEN assigned_agent IS NULL THEN 'PENDING' ELSE 'ASSIGNED' END,revision_round=0,started_at=NULL,completed_at=NULL,result=NULL,evidence_json='[]' WHERE task_id=?").run(taskId);
    });
  }
  recordDecision(taskId: string, sequence: number, decision: AgentRoutingDecision): void {
    this.store.db.prepare(`INSERT INTO routing_decisions(decision_id,task_id,role,sequence,selected_agent,reason_code,selected_reasons_json,rejected_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), taskId, decision.role, sequence, decision.selectedAgent ?? null, decision.reasonCode, JSON.stringify(decision.selectedReasons), JSON.stringify(decision.rejected), this.store.now());
  }
}
function rowToRole(row: Record<string, unknown>): TaskRoleRecord { return { taskId: String(row.task_id), role: row.role as Role, sequence: Number(row.sequence),
  ...(row.assigned_agent ? { assignedAgent: row.assigned_agent as AgentId } : {}), status: row.status as RoleStatus,
  ...(row.routing_reason ? { routingReason: String(row.routing_reason) } : {}), revisionRound: Number(row.revision_round), createdAt: String(row.created_at),
  ...(row.started_at ? { startedAt: String(row.started_at) } : {}), ...(row.completed_at ? { completedAt: String(row.completed_at) } : {}),
  ...(row.result ? { result: String(row.result) } : {}), evidence: JSON.parse(String(row.evidence_json)) as string[] }; }
