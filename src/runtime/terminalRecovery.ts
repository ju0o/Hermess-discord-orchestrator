import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Role, TaskRecord } from "../domain/types.js";
import type { Store } from "../storage/database.js";
import type { TaskRepository } from "../tasks/repository.js";
import type { TeamRepository } from "../teams/repository.js";
import { captureExecutionBinding, deterministicGitPreflight, verifyExecutionBinding, type ExecutionBinding, type ValidationEvidence } from "./correction.js";

export type TerminalRecoveryRole = "DEVELOPER" | "REVIEWER" | "QA";
export interface ProductDiffFingerprint { status: string; diff_numstat: string; }
export interface TerminalRecoveryRequest {
  taskId: string;
  projectId: string;
  expectedBinding: ExecutionBinding;
  expectedDiff: ProductDiffFingerprint;
  validationEvidence: readonly ValidationEvidence[];
  targetRole: TerminalRecoveryRole;
  requestedBy: string;
  reason: string;
}
export interface TerminalRecoveryResult { task: TaskRecord; recoveryEventId: string; alreadyRecovered: boolean; targetRole: TerminalRecoveryRole; }

const TERMINAL_RECOVERABLE = /^SAFE_STOP:(NO_PROGRESS_CONTINUATION|ROUTING_NO_ELIGIBLE_AGENT):/;
const REQUIRED_VALIDATION = ["TYPECHECK", "TEST", "BUILD"] as const;
const roleSequence = (task: TaskRecord, role: TerminalRecoveryRole): number => {
  const roles = task.requiredRoles ?? [];
  const index = roles.indexOf(role as Role);
  if (index < 0) throw new Error(`RECOVERY_ROLE_NOT_REQUIRED:${role}`);
  return index + 1;
};

function latestProtocol(store: Store, taskId: string, type: "REVIEW" | "QA_RESULT" | "VERDICT"): Record<string, unknown> | undefined {
  const rows = store.db.prepare("SELECT payload_json FROM protocol_events WHERE task_id=? AND event_type=? ORDER BY created_at DESC").all(taskId, type) as Array<{ payload_json: string }>;
  return rows[0] ? JSON.parse(rows[0].payload_json) as Record<string, unknown> : undefined;
}

function assertPhaseIsNotSkipped(store: Store, task: TaskRecord, request: TerminalRecoveryRequest, sequence: number): void {
  const review = latestProtocol(store, task.taskId, "REVIEW");
  const developer = store.db.prepare("SELECT status FROM task_roles WHERE task_id=? AND sequence=?").get(task.taskId, sequence) as { status: string } | undefined;
  if (request.targetRole === "DEVELOPER") {
    if (String(review?.verdict).toUpperCase() !== "REVISION_REQUIRED") throw new Error("RECOVERY_REVIEW_BOUNDARY_NOT_PROVEN");
    return;
  }
  if (request.targetRole === "REVIEWER") {
    if (String(review?.verdict).toUpperCase() !== "REVISION_REQUIRED") throw new Error("RECOVERY_REVIEW_BOUNDARY_NOT_PROVEN");
    if (developer?.status !== "PASS") throw new Error("RECOVERY_REVIEW_REQUIRES_DEVELOPER_PASS");
    return;
  }
  if (String(review?.verdict).toUpperCase() !== "REVIEW_PASS") throw new Error("RECOVERY_QA_REQUIRES_REVIEW_PASS");
  const qa = latestProtocol(store, task.taskId, "QA_RESULT");
  if (String(qa?.status).toUpperCase() === "PASS" || String(latestProtocol(store, task.taskId, "VERDICT")?.status).toUpperCase() === "PASS")
    throw new Error("RECOVERY_QA_ALREADY_COMPLETED");
}

function assertEvidence(store: Store, task: TaskRecord, request: TerminalRecoveryRequest, actual: ExecutionBinding): void {
  const binding = verifyExecutionBinding(request.expectedBinding, actual);
  if (!binding.ok) throw new Error(binding.reason);
  if (request.expectedBinding.task_id !== task.taskId || request.projectId !== task.projectId) throw new Error("RECOVERY_TASK_PROJECT_MISMATCH");
  const preflight = deterministicGitPreflight(task.workspace);
  if (!preflight.status || !preflight.diff_numstat) throw new Error("RECOVERY_PRODUCT_DIFF_MISSING");
  if (preflight.status !== request.expectedDiff.status || preflight.diff_numstat !== request.expectedDiff.diff_numstat)
    throw new Error("RECOVERY_PRODUCT_DIFF_DRIFT");
  if (!fs.existsSync(path.resolve(task.workspace))) throw new Error("RECOVERY_WORKTREE_MISSING");
  const active = store.db.prepare("SELECT process_id FROM worker_processes WHERE task_id=? AND status IN ('RUNNING','STARTED','BUSY') LIMIT 1").get(task.taskId);
  if (active) throw new Error("RECOVERY_ACTIVE_WORKER_CONFLICT");
  for (const type of REQUIRED_VALIDATION) {
    const matching = request.validationEvidence.filter((e) => e.type === type && e.status === "PASS" && e.task_id === task.taskId);
    if (!matching.some((e) => e.worktree && path.resolve(e.worktree) === path.resolve(task.workspace) && e.branch === actual.branch && (!e.base_sha || e.base_sha === actual.base_sha) && e.source === "REUSED"))
      throw new Error(`RECOVERY_VALIDATION_EVIDENCE_MISSING:${type}`);
  }
}

export function recoverCancelledTask(store: Store, tasks: TaskRepository, teams: TeamRepository, request: TerminalRecoveryRequest): TerminalRecoveryResult {
  const task = tasks.get(request.taskId); if (!task) throw new Error("RECOVERY_TASK_NOT_FOUND");
  const priorEvent = store.db.prepare("SELECT event_id,payload_json FROM protocol_events WHERE task_id=? AND event_type='TASK_RECOVERY' ORDER BY created_at DESC LIMIT 1").get(request.taskId) as { event_id: string; payload_json: string } | undefined;
  if (priorEvent) {
    const payload = JSON.parse(priorEvent.payload_json) as Record<string, unknown>;
    if (payload.target_role !== request.targetRole)
      throw new Error("RECOVERY_DUPLICATE_CONFLICT");
    // A prior recovery is idempotent while its reopened Task is active.  If
    // that bounded attempt later reaches a recoverable terminal safe-stop,
    // retain the old event as history and allow a new append-only recovery
    // event after re-running all evidence checks below.
    if (["QUEUED", "DISPATCHED", "CLAIMED", "RUNNING", "WAITING_RESULT", "REVIEWING", "WAITING_MAIN", "HUMAN_GATE"].includes(task.status))
      return { task: tasks.get(request.taskId)!, recoveryEventId: priorEvent.event_id, alreadyRecovered: true, targetRole: request.targetRole };
  }
  if (!(task.status === "CANCELLED" || (task.status === "FAIL" && TERMINAL_RECOVERABLE.test(String(task.result || "")))))
    throw new Error("TERMINAL_RECOVERY_REQUIRES_CANCELLED");
  if (!task.result || !TERMINAL_RECOVERABLE.test(task.result)) throw new Error("RECOVERY_TERMINAL_REASON_NOT_RECOVERABLE");
  const actual = captureExecutionBinding(task);
  assertEvidence(store, task, request, actual);
  const sequence = roleSequence(task, request.targetRole);
  assertPhaseIsNotSkipped(store, task, request, sequence);
  const target = teams.role(task.taskId, sequence); if (!target?.assignedAgent) throw new Error("RECOVERY_TARGET_AGENT_MISSING");
  const eventId = randomUUID(); const now = store.now();
  const payload = { recovery_event: "TERMINAL_TASK_REOPEN", request_fingerprint: JSON.stringify(request), requested_by: request.requestedBy,
    reason: request.reason, target_role: request.targetRole, target_sequence: sequence, prior_status: task.status, prior_result: task.result,
    prior_completed_at: task.completedAt ?? null, prior_roles: teams.roles(task.taskId), binding: actual, product_diff: request.expectedDiff,
    validation_evidence: request.validationEvidence };
  store.transaction(() => {
    store.db.prepare(`INSERT INTO protocol_events(event_id,task_id,event_type,sender,recipient,payload_json,created_at) VALUES(?,?,?, ?,?,?,?)`)
      .run(eventId, task.taskId, "TASK_RECOVERY", "RUNTIME", "MAIN", JSON.stringify(payload), now);
    tasks.reopenCancelledForRecovery(task.taskId, request.targetRole, sequence, target.assignedAgent!, `RECOVERY_REOPENED_FROM_CANCELLED:${eventId}`);
    store.db.prepare("UPDATE task_teams SET status='PLANNED',current_sequence=NULL,updated_at=? WHERE task_id=?").run(now, task.taskId);
    store.db.prepare("UPDATE task_roles SET status='ASSIGNED',revision_round=revision_round+1,completed_at=NULL,result=NULL,routing_reason=? WHERE task_id=? AND sequence=?")
      .run(`TERMINAL_RECOVERY:${eventId}`, task.taskId, sequence);
  });
  return { task: tasks.get(task.taskId)!, recoveryEventId: eventId, alreadyRecovered: false, targetRole: request.targetRole };
}
