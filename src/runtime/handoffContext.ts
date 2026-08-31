import type { Role, TaskRecord } from "../domain/types.js";
import type { Store } from "../storage/database.js";
import type { ProtocolEvent } from "../tasks/protocol.js";
import type { ValidationEvidence } from "./correction.js";

export interface DurableHandoffContext {
  taskId: string; targetRole: Role; revisionRound: number; originalGoal: string;
  currentAction: string; previousRole: Role; previousResult: string; previousEventId: string;
  validationEvidence: ValidationEvidence[]; evidenceProvenance: string[];
  productDiffReference?: string; findings: string[]; createdAt: string;
}

const key = (taskId: string, role: Role, round: number) => `role_handoff:${taskId}:${role}:${round}`;
const comparable = (e: ValidationEvidence) => JSON.stringify({ task_id: e.task_id, type: e.type, command: e.command,
  exit_code: e.exit_code, status: e.status, timestamp: e.timestamp, worktree: e.worktree, branch: e.branch,
  head_sha: e.head_sha, base_sha: e.base_sha });

/** Resolve references only through existing, same-Task durable protocol evidence. */
export function bindReusedEvidence(store: Store, taskId: string, references: readonly ValidationEvidence[]): ValidationEvidence[] {
  return references.map((reference) => {
    if (reference.source !== "REUSED" || reference.task_id !== taskId) throw new Error("REUSED_EVIDENCE_TASK_PROVENANCE_INVALID");
    const rows = reference.source_event_id
      ? store.db.prepare("SELECT event_id,task_id,payload_json FROM protocol_events WHERE event_id=? AND task_id=?").all(reference.source_event_id, taskId)
      : store.db.prepare("SELECT event_id,task_id,payload_json FROM protocol_events WHERE task_id=? ORDER BY created_at DESC").all(taskId);
    for (const row of rows as Array<{ event_id: string; task_id: string; payload_json: string }>) {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      const evidence = Array.isArray(payload.validation_evidence) ? payload.validation_evidence as ValidationEvidence[] : [];
      const match = evidence.find((item) => comparable(item) === comparable(reference) && item.status === "PASS");
      const processRef = reference.source_process || match?.source_process;
      const logRef = reference.source_log || match?.source_log;
      const durableProcess = processRef
        ? store.db.prepare("SELECT process_id FROM worker_processes WHERE task_id=? AND (process_id=? OR CAST(pid AS TEXT)=?) AND (? IS NULL OR log_path=?)")
          .get(taskId, processRef, processRef, logRef ?? null, logRef ?? null)
        : logRef ? store.db.prepare("SELECT process_id FROM worker_processes WHERE task_id=? AND log_path=?").get(taskId, logRef) : undefined;
      if (match && (match.source !== "REUSED" || Boolean(match.source_event_id || payload.worker_execution_id || durableProcess)))
        return { ...reference, source: "REUSED", source_event_id: row.event_id,
          ...(String(payload.worker_execution_id || match.source_execution_id || "") ? { source_execution_id: String(payload.worker_execution_id || match.source_execution_id) } : {}),
          ...(processRef ? { source_process: processRef } : {}), ...(logRef ? { source_log: logRef } : {}) };
    }
    throw new Error("REUSED_EVIDENCE_PROVENANCE_UNRESOLVED");
  });
}

export function recordHandoffContext(store: Store, context: DurableHandoffContext): DurableHandoffContext {
  const event = store.db.prepare("SELECT task_id FROM protocol_events WHERE event_id=?").get(context.previousEventId) as { task_id: string } | undefined;
  if (!event || event.task_id !== context.taskId || context.validationEvidence.some((e) => e.task_id !== context.taskId))
    throw new Error("HANDOFF_CONTEXT_PROVENANCE_MISMATCH");
  const existing = store.getRuntimeState<DurableHandoffContext>(key(context.taskId, context.targetRole, context.revisionRound));
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(context)) throw new Error("HANDOFF_CONTEXT_IMMUTABLE_CONFLICT");
    return existing;
  }
  store.upsertRuntimeState(key(context.taskId, context.targetRole, context.revisionRound), context);
  return context;
}

export function handoffContextForDispatch(store: Store, taskId: string, role: Role, round: number): DurableHandoffContext | undefined {
  const value = store.getRuntimeState<DurableHandoffContext>(key(taskId, role, round));
  if (!value || value.taskId !== taskId || value.targetRole !== role || value.revisionRound !== round) return undefined;
  return value;
}

export function actionFor(target: Role, previous: Role, revision = false): string {
  if (revision) return `Address the attached ${previous} findings using the preserved prior result and evidence.`;
  if (target === "REVIEWER") return "Review the Developer result and Product against the Task contract using the attached/resolvable evidence.";
  if (target === "QA") return "Perform the QA contract against the reviewed result using the attached/resolvable evidence; run independent checks only where the QA contract requires them.";
  return `Continue the ${target} boundary using the attached prior result and evidence.`;
}

export function contextFromResult(task: TaskRecord, event: ProtocolEvent, previousRole: Role, targetRole: Role, targetRound: number,
  result: string, validationEvidence: ValidationEvidence[], findings: string[] = [], revision = false): DurableHandoffContext {
  return { taskId: task.taskId, targetRole, revisionRound: targetRound, originalGoal: task.goal,
    currentAction: actionFor(targetRole, previousRole, revision), previousRole, previousResult: result,
    previousEventId: event.eventId, validationEvidence: validationEvidence.map((e) => ({ ...e })),
    evidenceProvenance: validationEvidence.map((e) => e.source_event_id || event.eventId), findings: [...findings], createdAt: event.createdAt };
}
