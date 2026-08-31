import type { AgentAdapter } from "../agents/adapter.js";
import { config } from "../config/env.js";
import type { AgentId, AdapterTaskResult, Role, TaskRecord, TaskRoleRecord } from "../domain/types.js";
import type { ContextResolver } from "../context/resolver.js";
import { agentToBotType, normalizeBotType, type BotType } from "../discord/control/types.js";
import type { WorkroomManager } from "../discord/workrooms/manager.js";
import type { AgentRegistry } from "../registry/agentRegistry.js";
import { inspectGit } from "../projects/gitSafety.js";
import type { WorkspaceLocks } from "../tasks/locks.js";
import type { Protocol } from "../tasks/protocol.js";
import type { TaskRepository } from "../tasks/repository.js";
import type { TeamPlanner } from "./planner.js";
import type { TeamRepository } from "./repository.js";
import type { ModelRouter } from "../models/router.js";
import type { ModelEscalationService } from "../models/escalation.js";
import { canCompleteTeam, normalizeQaResult, normalizeReviewResult } from "../review/verdict.js";
import { TaskCompletionProjection } from "../tasks/completionProjection.js";
import { classifyAuthority } from "../authority/delegatedAuthority.js";
import { captureExecutionBinding } from "../runtime/correction.js";
import { continuationDispatchPayload, continuationIntentForDispatch } from "../runtime/continuationIntent.js";
import { dependencyPreflight, nextTypesPreflight } from "../projects/dependencyPreflight.js";
import type { ProcessRunner } from "../runtime/processRunner.js";
import { randomUUID } from "node:crypto";

const EXECUTION_ROLES: Role[] = ["DEVELOPER", "DEBUGGER", "REFACTORER", "MCP_SPECIALIST", "ARCHITECT"];

export class SequentialTeamScheduler {
  private readonly inFlight = new Set<string>();
  constructor(private readonly tasks: TaskRepository, private readonly teams: TeamRepository, private readonly planner: TeamPlanner,
    private readonly agents: AgentRegistry, private readonly adapters: Map<AgentId, AgentAdapter>, private readonly locks: WorkspaceLocks,
    private readonly context: ContextResolver, private readonly protocol: Protocol, private readonly workrooms: WorkroomManager,
    private readonly modelRouter: ModelRouter, private readonly modelEscalation: ModelEscalationService, private readonly store?: import("../storage/database.js").Store,
    private readonly runner?: ProcessRunner) {}

  isTeamTask(task: TaskRecord): boolean { return task.teamMode === "SEQUENTIAL" || Boolean(task.taskType) || Boolean(task.requiredRoles?.length) || Boolean(this.teams.get(task.taskId)); }

  async dispatch(taskInput: TaskRecord): Promise<void> {
    if (taskInput.executionHold) return;
    const planned = this.planner.plan(taskInput); const task = this.tasks.get(taskInput.taskId)!;
    if (planned.blocked) {
      if (task.status === "QUEUED") this.tasks.transition(task.taskId, "WAITING_MAIN", { result: "ROUTING_NO_ELIGIBLE_AGENT" }); return;
    }
    await this.workrooms.ensure(task); await this.workrooms.publishTeamComposition(task, planned.roles);
    const first = planned.roles[0]; if (!first?.assignedAgent) { this.tasks.transition(task.taskId, "WAITING_MAIN", { result: "ROUTING_NO_ELIGIBLE_AGENT" }); return; }
    if (this.runner) {
      const preflight = await dependencyPreflight(this.runner, task.workspace);
      if (!preflight.ready) { this.tasks.transition(task.taskId, "WAITING_MAIN", { result: preflight.reason, evidence: [...task.evidence, ...preflight.evidence] }); return; }
      const nextTypes = await nextTypesPreflight(this.runner, task.workspace);
      if (!nextTypes.ready) { this.tasks.transition(task.taskId, "WAITING_MAIN", { result: nextTypes.reason, evidence: [...task.evidence, ...nextTypes.evidence] }); return; }
    }
    const updated = this.tasks.transition(task.taskId, "DISPATCHED", { assignedAgent: first.assignedAgent });
    if (this.store) this.store.upsertRuntimeState(`task:execution_binding:${updated.taskId}`, captureExecutionBinding(updated));
    this.tasks.setCurrentTeamRole(task.taskId, first.sequence, first.role, first.assignedAgent);
    await this.emitAssignment(updated, first);
  }

  async redrive(taskId: string): Promise<boolean> {
    const current = this.tasks.get(taskId); if (!current || current.status !== "QUEUED" || current.executionHold) return false;
    const roles = this.teams.roles(taskId); const target = roles.find((item) => item.sequence === current.currentRoleSequence) || roles[0];
    if (!target) return false;
    const prior: Partial<Record<Role, AgentId>> = {};
    for (const role of roles) if (role.sequence !== target.sequence && role.assignedAgent) prior[role.role] = role.assignedAgent;
    const decision = this.planner.routeRole(current, target.role, prior); this.teams.recordDecision(taskId, target.sequence, decision);
    if (!decision.selectedAgent) return false;
    const assigned = this.teams.assign(taskId, target.sequence, decision.selectedAgent, `RUNTIME_DISPATCH_REDRIVE: ${decision.reasonCode}; ${decision.selectedReasons.join(", ")}`);
    const updated = this.tasks.transition(taskId, "DISPATCHED", { assignedAgent: decision.selectedAgent });
    this.tasks.setCurrentTeamRole(taskId, assigned.sequence, assigned.role, assigned.assignedAgent);
    await this.emitAssignment(updated, assigned); return true;
  }

  async execute(taskInput: TaskRecord): Promise<void> {
    // Kept as a compatibility no-op for callers that still tick the old
    // scheduler API. Coding Agent execution belongs exclusively to WorkerRuntime.
    void taskInput;
    return;
  }

  async completeProtocolRole(taskId: string, outcome: "PASS" | "FAIL" | "BLOCKED" | "REVISION_REQUIRED", result = "Protocol-only role result"): Promise<void> {
    this.assertSyntheticCompletionIsolated();
    let task = this.tasks.get(taskId); if (!task?.currentRoleSequence) throw new Error("No active team role");
    let role = this.teams.role(taskId, task.currentRoleSequence); if (!role?.assignedAgent) throw new Error("Role is not assigned");
    role = this.teams.activate(taskId, role.sequence); task = this.tasks.setCurrentTeamRole(taskId, role.sequence, role.role, role.assignedAgent);
    if (task.status === "DISPATCHED") { task = this.tasks.transition(taskId, "CLAIMED", { attempt: task.attempt + 1 }); task = this.tasks.transition(taskId, "RUNNING"); }
    this.agents.markBusy(role.assignedAgent!, task.taskId, task.projectId, role.role, task.workspace);
    await this.protocol.emit("ACK", task, role.assignedAgent!, task.owner, { status: "CLAIMED", role: role.role, sequence: role.sequence, protocolOnly: true, round: Math.max(1, task.attempt) });
    if (outcome === "REVISION_REQUIRED") {
      if (role.role !== "REVIEWER") throw new Error("REVISION_REQUIRED is only valid for REVIEWER");
      const revisionRound = Math.max(role.revisionRound + 1, task.attempt, 1);
      await this.protocol.emitReview(task, role.assignedAgent!, this.previousExecutionRecipient(taskId, role.sequence), { reviewer_agent: role.assignedAgent!,
        reviewer_role: "REVIEWER", verdict: "REVISION_REQUIRED", findings: [result], evidence: [], next_owner: this.previousExecutionRecipient(taskId, role.sequence) }, revisionRound);
      this.agents.release(role.assignedAgent!); await this.requestRevision(taskId, [result], revisionRound); return;
    }
    if (outcome === "BLOCKED") { await this.emitRoleResult(task, role, false, result); this.teams.finish(taskId, role.sequence, "BLOCKED", result); this.agents.release(role.assignedAgent!, true); this.moveToWaitingMain(task, `${role.role} blocked: ${result}`); return; }
    if (outcome === "FAIL") { await this.emitRoleResult(task, role, false, result); this.teams.finish(taskId, role.sequence, "FAIL", result); this.agents.release(role.assignedAgent!, true); this.moveToWaitingMain(task, `${role.role} failed: ${result}`); return; }
    await this.emitRoleResult(task, role, true, result); this.teams.finish(taskId, role.sequence, "PASS", result); this.agents.release(role.assignedAgent!); await this.advance(taskId, role.sequence);
  }

  async requestRevision(taskId: string, findings: string[], round: number): Promise<void> {
    this.assertSyntheticCompletionIsolated();
    if (round > config.MAX_DISCUSSION_ROUNDS) throw new Error("LOOP_GUARD"); const roles = this.teams.roles(taskId);
    const reviewer = roles.find((item) => item.role === "REVIEWER"); const implementation = [...roles].reverse().find((item) => item.sequence < (reviewer?.sequence || 0) && EXECUTION_ROLES.includes(item.role));
    if (!reviewer?.assignedAgent || !implementation?.assignedAgent) throw new Error("Revision roles unavailable");
    this.teams.reopen(taskId, reviewer.sequence, round); this.storeRoleStatus(taskId, reviewer.sequence, "ASSIGNED"); this.teams.reopen(taskId, implementation.sequence, round);
    const task = this.tasks.setCurrentTeamRole(taskId, implementation.sequence, implementation.role, implementation.assignedAgent);
    await this.protocol.emitRevisionRequest(task, reviewer.assignedAgent, agentToBotType(implementation.assignedAgent), { findings, requested_changes: findings }, round);
  }

  async completeRevision(taskId: string, changes: string[], validation: string[], round: number): Promise<void> {
    this.assertSyntheticCompletionIsolated();
    if (round > config.MAX_DISCUSSION_ROUNDS) throw new Error("LOOP_GUARD"); const task = this.tasks.get(taskId)!; const current = this.teams.role(taskId, task.currentRoleSequence!);
    const reviewer = this.teams.roles(taskId).find((item) => item.role === "REVIEWER"); if (!current?.assignedAgent || !reviewer?.assignedAgent) throw new Error("Revision roles unavailable");
    this.agents.markBusy(current.assignedAgent, task.taskId, task.projectId, current.role, task.workspace);
    await this.protocol.emitRevisionResult(task, current.assignedAgent, agentToBotType(reviewer.assignedAgent), { changes, validation, next_owner: agentToBotType(reviewer.assignedAgent) }, round);
    this.teams.finish(taskId, current.sequence, "PASS", changes.join("; "), validation); this.agents.release(current.assignedAgent);
    this.teams.reopen(taskId, reviewer.sequence, round); this.tasks.setCurrentTeamRole(taskId, reviewer.sequence, reviewer.role, reviewer.assignedAgent);
  }

  private async finishAdapterRole(task: TaskRecord, role: TaskRoleRecord, result: AdapterTaskResult, modelDecision: import("../domain/types.js").ModelRoutingDecision): Promise<void> {
    if (result.sessionId && role.assignedAgent) { this.agents.setSession(role.assignedAgent, result.sessionId); this.tasks.upsertSession(`${role.assignedAgent}:${task.projectId}`, role.assignedAgent, task.projectId, task.taskId, result.sessionId,
      { ...(result.requestedModel ? { requestedModel: result.requestedModel } : {}), ...(result.effectiveModel ? { effectiveModel: result.effectiveModel } : {}),
        ...(result.provider ? { provider: result.provider } : {}), ...(result.modelVerificationSource ? { source: result.modelVerificationSource } : {}) }); }
    if (role.role === "REVIEWER") {
      const review = normalizeReviewResult(result, task.validation);
      if (review.verdict !== "REVIEW_PASS") {
        const status = review.verdict === "REVIEW_FAIL" ? "FAIL" : "BLOCKED";
        await this.emitRoleResult(task, role, false, review.findings.join("; "), review.evidence);
        this.teams.finish(task.taskId, role.sequence, status, review.findings.join("; "), review.evidence);
        const authority = classifyAuthority({ operation: "reviewer revision cycle", detail: review.verdict, retryCount: task.attempt, retryLimit: config.MAX_AUTONOMOUS_RETRIES });
        this.tasks.setAuthority(task.taskId, authority); this.agents.release(role.assignedAgent!, true);
        if (authority.authorityClass === "AUTO_DELEGATED") {
          const revisionRound = Math.max(role.revisionRound + 1, task.attempt, 1);
          await this.requestRevision(task.taskId, review.findings, revisionRound); return;
        }
        this.moveToWaitingMain(task, `REVIEW_${review.verdict}`); return;
      }
    }
    if (role.role === "QA") {
      const qa = normalizeQaResult(result, task.validation);
      if (qa.verdict !== "QA_PASS") {
        const status = qa.verdict === "QA_FAIL" ? "FAIL" : qa.verdict === "QA_BLOCKED" ? "BLOCKED" : "FAIL";
        await this.emitRoleResult(task, role, false, qa.findings.join("; ") || result.output, result.evidence);
        this.teams.finish(task.taskId, role.sequence, status as never, qa.findings.join("; ") || result.output, result.evidence);
        this.agents.release(role.assignedAgent!, true);
        this.moveToWaitingMain(task, `QA_${qa.verdict}: ${qa.findings.join("; ") || result.output}`.slice(0, 500)); return;
      }
    }
    if (!result.ok) {
      const escalation = this.modelEscalation.evaluate(modelDecision, { reason: result.output, evidence: result.evidence });
      if (escalation.action === "RETRY_SAME_MODEL" || escalation.action === "ESCALATED") {
        await this.emitRoleResult(task, role, false, result.output, result.evidence);
        this.teams.reopen(task.taskId, role.sequence, role.revisionRound); this.agents.release(role.assignedAgent!);
        await this.protocol.emit("HANDOFF", task, "ORCHESTRATOR", role.assignedAgent!, { status: escalation.action === "ESCALATED" ? "MODEL_ESCALATION" : "MODEL_RETRY",
          fromTier: escalation.fromTier, toTier: escalation.toTier, fromModel: escalation.fromModel, toModel: escalation.toModel,
          reason: escalation.reason, failureCategory: escalation.failureCategory }); return;
      }
    }
    await this.emitRoleResult(task, role, result.ok, result.output, result.evidence);
    this.teams.finish(task.taskId, role.sequence, result.ok ? "PASS" : "FAIL", result.output, result.evidence); this.agents.release(role.assignedAgent!, !result.ok);
    if (!result.ok) {
      const authority = classifyAuthority({ operation: "validation retry", detail: result.output, retryCount: task.attempt, retryLimit: config.MAX_AUTONOMOUS_RETRIES });
      this.tasks.setAuthority(task.taskId, authority);
      if (authority.authorityClass === "AUTO_DELEGATED" && EXECUTION_ROLES.includes(role.role)) {
        this.teams.reopen(task.taskId, role.sequence, role.revisionRound + 1); this.tasks.setCurrentTeamRole(task.taskId, role.sequence, role.role, role.assignedAgent);
        return;
      }
      this.moveToWaitingMain(task, `${role.role} failed: ${result.output}`); return;
    } await this.advance(task.taskId, role.sequence);
  }

  private async emitRoleResult(task: TaskRecord, role: TaskRoleRecord, ok: boolean, result: string, evidence: string[] = []): Promise<void> {
    const recipient = this.nextRecipient(task.taskId, role.sequence, task.nextOwner || "ASUS");
    if (role.role === "REVIEWER") await this.protocol.emitReview(task, role.assignedAgent!, recipient, { reviewer_agent: role.assignedAgent!, reviewer_role: "REVIEWER",
      verdict: ok ? "REVIEW_PASS" : "BLOCKED", findings: ok ? [] : [result], evidence, next_owner: recipient }, Math.max(role.revisionRound, task.attempt, 1));
    else if (role.role === "QA") await this.protocol.emitQaResult(task, role.assignedAgent!, recipient, { qa_agent: role.assignedAgent!, status: ok ? "PASS" : "FAIL", checks: [result], evidence, next_owner: recipient }, Math.max(role.revisionRound, task.attempt, 1));
    else await this.protocol.emit("RESULT", task, role.assignedAgent!, recipient, { ok, result, evidence, role: role.role, sequence: role.sequence, status: ok ? "PASS_CANDIDATE" : "FAIL", round: Math.max(1, task.attempt) });
  }

  private async advance(taskId: string, completedSequence: number): Promise<void> {
    const roles = this.teams.roles(taskId); let next = roles.find((item) => item.sequence > completedSequence && ["ASSIGNED", "PENDING"].includes(item.status));
    if (next?.assignedAgent) {
      const current = this.tasks.get(taskId)!; const prior: Partial<Record<Role, AgentId>> = {};
      for (const item of roles) if (item.sequence < next.sequence && item.status === "PASS" && item.assignedAgent) prior[item.role] = item.assignedAgent;
      const decision = this.planner.routeRole(current, next.role, prior); this.teams.recordDecision(taskId, next.sequence, decision);
      if (!decision.selectedAgent) {
        this.teams.block(taskId, next.sequence, decision.reasonCode); this.moveToWaitingMain(current, decision.reasonCode); return;
      }
      if (decision.selectedAgent !== next.assignedAgent) next = this.teams.assign(taskId, next.sequence, decision.selectedAgent,
        `ROLE_ADVANCEMENT_REVALIDATED: ${decision.reasonCode}; ${decision.selectedReasons.join(", ")}`);
      const task = this.tasks.setCurrentTeamRole(taskId, next.sequence, next.role, next.assignedAgent); await this.emitAssignment(task, next); return;
    }
    const current = this.tasks.get(taskId)!;
    if (!this.teams.allPassed(taskId) || !canCompleteTeam(current, roles)) { this.moveToWaitingMain(current, "TEAM_COMPLETE_GATE_NOT_SATISFIED"); return; }
    this.teams.complete(taskId); let task = this.tasks.setCompletionCandidate(taskId, true);
    const finalResult = [...roles].reverse().find((item) => item.result)?.result || "TEAM_COMPLETE: all required Roles passed";
    await this.protocol.emit("VERDICT", task, "ORCHESTRATOR", task.nextOwner || "ASUS", { status: "PASS", reason: "TEAM_COMPLETE", result: finalResult, requiredRoles: roles.map((item) => item.role), round: Math.max(1, task.attempt) });
    if (this.store) { try { new TaskCompletionProjection(this.store, this.tasks, this.teams).reconcile(taskId); task = this.tasks.get(taskId)!; } catch { if (task.status === "RUNNING") task = this.tasks.transition(taskId, "WAITING_RESULT"); if (task.status === "WAITING_RESULT") task = this.tasks.transition(taskId, "PASS", { result: finalResult }); } } else { if (task.status === "RUNNING") task = this.tasks.transition(taskId, "WAITING_RESULT"); if (task.status === "WAITING_RESULT") task = this.tasks.transition(taskId, "PASS", { result: finalResult }); }
    await this.workrooms.syncTaskState(task);
  }

  private async emitAssignment(task: TaskRecord, role: TaskRoleRecord): Promise<void> {
    // Wire payload kept minimal on purpose (Live Company Dogfood Run 01: a full-field envelope
    // -- duplicate task_id/project_id/thread_id/workroom_id, scope, validation,
    // protected_invariants, expected_response -- deflate+base64+3x-zero-width-expands past
    // Discord's 2000-char message limit almost regardless of goal length, silently splitting
    // the message; the receiving InboundGuard/parseEnvelope never reassembles a split message,
    // so the Task hangs DISPATCHED forever with no visible error. Every dropped field here is
    // already redundant on the wire: task_id/thread_id/role/round are carried at the envelope's
    // top level by MultiBotGateway.publish(), and scope/validation/protected_invariants are read
    // by the receiving Worker straight off the durable Task record (context/resolver.ts), never
    // off envelope.payload -- see Improvement Backlog for the full analysis.
    const runId = this.store?.getRuntimeState<{ runId: string }>(`run_budget:${task.taskId}`)?.runId;
    const intent = this.store ? continuationIntentForDispatch(this.store, task.taskId, runId, role.role, role.revisionRound) : undefined;
    await this.protocol.emit("TASK", task, "ORCHESTRATOR", role.assignedAgent!, { title: task.title, ...continuationDispatchPayload(task.goal, intent), role: role.role, dispatch_id: randomUUID(),
      // The wire round IS the durable Role revision round -- verbatim. Clamping
      // it to MAX_DISCUSSION_ROUNDS produced envelopes no Worker could ever
      // claim (WorkerContract.claimRole compares strict equality against the
      // same Role's revision_round), silently stranding dispatched Tasks until
      // recovery re-routed them past the intended assignee (live
      // A prior bounded run round 4: OPENCODE was
      // handed an unclaimable round-3 envelope for its revision_round-4 Role,
      // never started, and the recovery path reassigned the Role elsewhere).
      // Loop protection belongs to the revision-cycle guards (LOOP_GUARD), not
      // to the dispatch wire format.
      round: role.revisionRound });
  }
  private nextRecipient(taskId: string, sequence: number, fallback: string): BotType {
    const next = this.teams.roles(taskId).find((item) => item.sequence > sequence && item.assignedAgent); if (next?.assignedAgent) return agentToBotType(next.assignedAgent);
    return normalizeBotType(fallback) || "ASUS";
  }
  private previousExecutionRecipient(taskId: string, reviewerSequence: number): BotType {
    const previous = [...this.teams.roles(taskId)].reverse().find((item) => item.sequence < reviewerSequence && EXECUTION_ROLES.includes(item.role));
    if (!previous?.assignedAgent) throw new Error("Implementation Agent unavailable"); return agentToBotType(previous.assignedAgent);
  }
  private moveToWaitingMain(task: TaskRecord, reason: string): void {
    const authority = classifyAuthority({ operation: reason, detail: reason, retryCount: task.attempt, retryLimit: config.MAX_AUTONOMOUS_RETRIES });
    this.tasks.setAuthority(task.taskId, authority);
    const current = this.tasks.get(task.taskId)!; if (["QUEUED", "DISPATCHED", "CLAIMED", "RUNNING", "WAITING_RESULT", "REVIEWING", "BLOCKED", "HUMAN_GATE"].includes(current.status))
      this.tasks.transition(task.taskId, "WAITING_MAIN", { result: reason });
  }
  private assertSyntheticCompletionIsolated(): void {
    if (!this.protocol.acceptsSyntheticEvidence) throw new Error("SYNTHETIC_WORKER_COMPLETION_FORBIDDEN_LIVE_SINK");
  }
  private storeRoleStatus(taskId: string, sequence: number, status: "ASSIGNED"): void {
    // Revision keeps the original Role row and sequence; only its lifecycle state is rewound.
    const role = this.teams.role(taskId, sequence); if (role?.assignedAgent) this.teams.assign(taskId, sequence, role.assignedAgent, role.routingReason || status);
  }
}
