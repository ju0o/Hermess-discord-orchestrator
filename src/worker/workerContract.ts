import type { AgentId, Role, TaskRecord, TaskRoleRecord } from "../domain/types.js";
import { agentToBotType, type BotType, type InboundReasonCode, type NativeEnvelope } from "../discord/control/types.js";
import type { InboundGuard, InboundInput } from "../discord/control/inboundGuard.js";
import type { HandoffDecision } from "./handoff.js";
import type { ValidationEvidence } from "../runtime/correction.js";

/**
 * Shared Worker-side lifecycle for every Coding Agent Discord Bot (CLAUDE_CODE, CODEX,
 * OPENCODE, COMMANDCODE). Router/Dispatcher assignment is out of scope here -- this module
 * only formalizes what a Worker does with a Task envelope once Discord has delivered it.
 *
 *   MENTION_RECEIVED -> TASK_ENVELOPE_PARSE -> ROLE_CLAIM -> ACK -> EXECUTION -> RESULT -> HANDOFF
 */
export const WORKER_LIFECYCLE_STAGES = [
  "MENTION_RECEIVED", "TASK_ENVELOPE_PARSE", "ROLE_CLAIM", "ACK", "EXECUTION", "RESULT", "HANDOFF",
] as const;
export type WorkerLifecycleStage = (typeof WORKER_LIFECYCLE_STAGES)[number];

export type WorkerRejectionCode = InboundReasonCode | "IDENTITY_MISMATCH" | "NOT_ASSIGNED_TO_SELF" | "ROLE_MISMATCH" | "ROUND_MISMATCH";

export interface WorkerIdentity { readonly agentId: AgentId; readonly botType: BotType; }
export function workerIdentity(agentId: AgentId): WorkerIdentity { return { agentId, botType: agentToBotType(agentId) }; }

export interface WorkerLifecycleResult {
  stage: WorkerLifecycleStage;
  accepted: boolean;
  reason?: WorkerRejectionCode;
  detail?: string;
  envelope?: NativeEnvelope;
}

export interface ContinuitySnapshot { taskId: string; threadId?: string; sessionId?: string; attempt: number; }

export interface WorkerOutcome { ok: boolean; output: string; evidence: string[]; validationEvidence?: ValidationEvidence[]; findings?: string[]; checks?: string[]; }

function accept(stage: WorkerLifecycleStage, extra: Partial<WorkerLifecycleResult> = {}): WorkerLifecycleResult { return { stage, accepted: true, ...extra }; }
function reject(stage: WorkerLifecycleStage, reason: WorkerRejectionCode, detail: string, envelope?: NativeEnvelope): WorkerLifecycleResult {
  return { stage, accepted: false, reason, detail, ...(envelope ? { envelope } : {}) };
}

export class WorkerContract {
  constructor(readonly identity: WorkerIdentity, private readonly guard: InboundGuard) {}

  /**
   * MENTION_RECEIVED -> TASK_ENVELOPE_PARSE.
   * A Coding Agent may only claim traffic addressed to its own Discord identity, and only a
   * SYMPHONY_EVENT envelope naming it as recipient. Everything else (wrong bot, untrusted
   * sender, wrong thread, duplicate dispatch, round overrun) is delegated to InboundGuard,
   * whose reason codes are surfaced unchanged so callers get one vocabulary end to end.
   */
  receive(input: InboundInput): WorkerLifecycleResult {
    if (input.authorBot && input.currentIdentity !== this.identity.botType) {
      return reject("MENTION_RECEIVED", "IDENTITY_MISMATCH", `Worker ${this.identity.botType} cannot claim traffic routed to ${input.currentIdentity}`);
    }
    const decision = this.guard.evaluate(input);
    if (!decision.allowed) {
      return reject(decision.envelope ? "TASK_ENVELOPE_PARSE" : "MENTION_RECEIVED", decision.reason, `InboundGuard rejected: ${decision.reason}`, decision.envelope);
    }
    if (!decision.envelope) return accept("MENTION_RECEIVED", { detail: "Human message; no Task envelope to parse" });
    if (decision.envelope.recipient !== this.identity.botType) {
      return reject("TASK_ENVELOPE_PARSE", "IDENTITY_MISMATCH", `Envelope addressed to ${decision.envelope.recipient}, not ${this.identity.botType}`, decision.envelope);
    }
    const claimed = this.guard.claim(input, decision);
    if (!claimed.allowed || !claimed.envelope) {
      return reject("TASK_ENVELOPE_PARSE", claimed.reason, "Duplicate dispatch rejected before Task envelope could be claimed", claimed.envelope);
    }
    return accept("TASK_ENVELOPE_PARSE", { envelope: claimed.envelope });
  }

  /** Marks the inbound Discord message processed once the full lifecycle has run. */
  complete(input: InboundInput): void { this.guard.processed(input.messageId); }

  /**
   * ROLE_CLAIM. Rejects any Task/Role this Worker was not explicitly assigned, and any
   * envelope whose round does not match the Role's expected revision round (or the Task's
   * attempt, for single-role Tasks) -- protecting against stale or replayed dispatch rounds.
   */
  claimRole(envelope: NativeEnvelope, task: TaskRecord, role?: TaskRoleRecord): WorkerLifecycleResult {
    if (task.assignedAgent && task.assignedAgent !== this.identity.agentId && !role?.assignedAgent) {
      return reject("ROLE_CLAIM", "NOT_ASSIGNED_TO_SELF", `Task ${task.taskId} is assigned to ${task.assignedAgent}, not ${this.identity.agentId}`, envelope);
    }
    if (role?.assignedAgent && role.assignedAgent !== this.identity.agentId) {
      return reject("ROLE_CLAIM", "NOT_ASSIGNED_TO_SELF", `Role ${role.role} on Task ${task.taskId} is assigned to ${role.assignedAgent}, not ${this.identity.agentId}`, envelope);
    }
    if (role && envelope.role && envelope.role !== role.role) {
      return reject("ROLE_CLAIM", "ROLE_MISMATCH", `Envelope role ${envelope.role} does not match the claimed Role ${role.role}`, envelope);
    }
    const expectedRound = role ? role.revisionRound : task.attempt;
    if (envelope.round !== expectedRound) {
      return reject("ROLE_CLAIM", "ROUND_MISMATCH", `Expected round ${expectedRound} for Task ${task.taskId}, envelope carries round ${envelope.round}`, envelope);
    }
    return accept("ROLE_CLAIM", { envelope });
  }

  /** ACK. Always posted under this Worker's own identity -- no Worker can ACK on another's behalf. */
  buildAck(task: TaskRecord, role: Role, round: number, recipient: BotType): NativeEnvelope {
    return {
      event_type: "ACK", task_id: task.taskId, sender: this.identity.botType, recipient, role, round,
      message_id: "PENDING", ...(task.threadId ? { thread_id: task.threadId } : {}), created_at: new Date().toISOString(),
      payload: { status: "ACK", claimed_by: this.identity.agentId, agent_id: this.identity.agentId },
    };
  }

  /**
   * RESULT / REVIEW / QA_RESULT. The wire shape a Worker reports back with depends on the
   * Role it executed under: Developer/Debugger/Refactorer/Architect/MCP_SPECIALIST report a
   * RESULT, Reviewer reports a REVIEW verdict, QA reports a QA_RESULT -- reusing the native
   * event vocabulary the Router/Dispatcher side already understands.
   */
  buildOutcome(task: TaskRecord, role: Role, round: number, recipient: BotType, outcome: WorkerOutcome, nextOwner?: BotType): NativeEnvelope {
    const base = {
      task_id: task.taskId, sender: this.identity.botType, recipient, role, round, message_id: "PENDING",
      ...(task.threadId ? { thread_id: task.threadId } : {}), created_at: new Date().toISOString(),
      ...(nextOwner ? { next_owner: nextOwner } : {}),
    };
    if (role === "REVIEWER" || role === "ARCHITECT") {
      return { ...base, event_type: "REVIEW", payload: {
        reviewer_agent: this.identity.agentId, reviewer_role: role,
        verdict: outcome.ok ? "REVIEW_PASS" : "REVISION_REQUIRED", findings: outcome.findings ?? [], evidence: outcome.evidence, validation_evidence: outcome.validationEvidence ?? [],
      } };
    }
    if (role === "QA") {
      return { ...base, event_type: "QA_RESULT", payload: { qa_agent: this.identity.agentId, status: outcome.ok ? "PASS" : "FAIL", checks: outcome.checks ?? [], evidence: outcome.evidence, validation_evidence: outcome.validationEvidence ?? [] } };
    }
    return { ...base, event_type: "RESULT", payload: { ok: outcome.ok, result: outcome.output, evidence: outcome.evidence, validation_evidence: outcome.validationEvidence ?? [] } };
  }

  /** HANDOFF. Turns a pure hand-off decision (see handoff.ts) into the matching wire envelope. */
  buildHandoffEnvelope(task: TaskRecord, decision: HandoffDecision, recipient: BotType, detail: {
    findings?: string[]; requestedChanges?: string[]; requestedRole?: Role; targetRole?: Role; reason?: string;
  } = {}): NativeEnvelope {
    const base = {
      task_id: task.taskId, sender: this.identity.botType, recipient, round: decision.round, message_id: "PENDING",
      ...(task.threadId ? { thread_id: task.threadId } : {}), created_at: new Date().toISOString(),
      ...(decision.nextRole ? { next_owner: recipient } : {}),
    };
    if (decision.kind === "REVIEWER_TO_DEVELOPER_REVISION") {
      return { ...base, event_type: "REVISION_REQUEST", role: "REVIEWER", payload: { findings: detail.findings ?? [], requested_changes: detail.requestedChanges ?? [] } };
    }
    if (decision.kind === "AGENT_TO_EXPERT") {
      return { ...base, event_type: "EXPERT_REQUEST", role: task.role, payload: { requested_role: detail.requestedRole ?? "MCP_SPECIALIST", reason: detail.reason ?? decision.reason, scope: task.fileScope } };
    }
    return { ...base, event_type: "HANDOFF", role: detail.targetRole || task.role, payload: { status: decision.kind, reason: decision.reason, ...(decision.nextRole ? { next_role: decision.nextRole } : {}) } };
  }

  /** Continuity snapshot used to prove a context rollover (retry/revision) kept the same Thread/Session. */
  snapshot(task: TaskRecord, sessionId?: string): ContinuitySnapshot {
    return { taskId: task.taskId, ...(task.threadId ? { threadId: task.threadId } : {}), ...(sessionId ? { sessionId } : {}), attempt: task.attempt };
  }
}

export function continuityPreserved(before: ContinuitySnapshot, after: ContinuitySnapshot): boolean {
  return before.taskId === after.taskId && before.threadId === after.threadId && before.sessionId === after.sessionId && after.attempt >= before.attempt;
}
