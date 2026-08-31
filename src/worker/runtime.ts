import { randomUUID } from "node:crypto";
import type { AgentAdapter } from "../agents/adapter.js";
import type { AgentId, Role, TaskRecord } from "../domain/types.js";
import type { ContextResolver } from "../context/resolver.js";
import type { InboundInput } from "../discord/control/inboundGuard.js";
import { agentToBotType, botTypeToAgent, type NativeEnvelope } from "../discord/control/types.js";
import { config } from "../config/env.js";
import type { Protocol, WorkerExecutionProvenance } from "../tasks/protocol.js";
import type { TaskRepository } from "../tasks/repository.js";
import type { TeamRepository } from "../teams/repository.js";
import type { Store } from "../storage/database.js";
import { decideHandoff } from "./handoff.js";
import { WorkerContract } from "./workerContract.js";
import type { WorkerIdentity, WorkerOutcome } from "./workerContract.js";
import { normalizeDeveloperResult, normalizeQaResult, normalizeReviewResult } from "../review/verdict.js";
import { TaskCompletionProjection } from "../tasks/completionProjection.js";
import type { AgentRegistry } from "../registry/agentRegistry.js";
import { captureExecutionBinding, captureProductDigest, evidenceMatchesExecution, recordHeartbeat, verifyExecutionBinding, type ExecutionBinding, type ValidationEvidence } from "../runtime/correction.js";
import type { RunBudgetController } from "../runtime/runBudget.js";
import { continuationDispatchPayload } from "../runtime/continuationIntent.js";
import { bindReusedEvidence, contextFromResult, handoffContextForDispatch, recordHandoffContext } from "../runtime/handoffContext.js";
import type { ModelCatalog } from "../models/catalog.js";
import type { ModelAvailabilityFallback } from "../models/availabilityFallback.js";

/** Runtime-owned bridge from Discord worker messages to the existing CLI adapters. */
export class WorkerRuntime {
  private readonly contracts = new Map<AgentId, WorkerContract>();
  private readonly inFlight = new Set<string>();
  constructor(private readonly store: Store, private readonly tasks: TaskRepository, private readonly teams: TeamRepository, private readonly adapters: Map<AgentId, AgentAdapter>,
    private readonly context: ContextResolver, private readonly protocol: Protocol, private readonly identities: Map<AgentId, WorkerIdentity>, private readonly guardFactory: (identity: WorkerIdentity) => WorkerContract,
    private readonly ownerPaused: () => boolean = () => false, private readonly agents?: AgentRegistry, private readonly runBudget?: RunBudgetController,
    private readonly models?: ModelCatalog, private readonly availabilityFallback?: ModelAvailabilityFallback) {
    for (const [agentId, identity] of identities) this.contracts.set(agentId, guardFactory(identity));
  }

  async receive(input: InboundInput, envelope: NativeEnvelope): Promise<void> {
    const agentId = botTypeToAgent(input.currentIdentity); if (!agentId) return;
    if (!["TASK", "HANDOFF", "REVISION_REQUEST", "EXPERT_INVITE"].includes(envelope.event_type)) return;
    this.store.upsertRuntimeState("worker:last_event", { taskId: envelope.task_id, eventType: envelope.event_type, agentId, stage: "RECEIVED", at: this.store.now() });
    if (this.ownerPaused()) {
      this.store.upsertRuntimeState("worker:owner_pause_drop", { taskId: envelope.task_id, eventType: envelope.event_type, agentId, stage: "PAUSED_BY_OWNER", at: this.store.now() });
      return;
    }
    const contract = this.contracts.get(agentId); if (!contract) return;
    const received = contract.receive(input); if (!received.accepted || !received.envelope) return;
    // The parsed, guard-approved envelope is authoritative. Never execute a
    // caller-supplied object that differs from the Discord message payload.
    envelope = received.envelope;
    if (!["TASK", "HANDOFF", "REVISION_REQUEST", "EXPERT_INVITE"].includes(envelope.event_type)) return;
    const task = this.tasks.get(envelope.task_id); if (!task || task.executionHold) return;
    if (this.runBudget && !this.runBudget.canContinue(task.taskId)) return;
    recordHeartbeat(this.store, { runStartedAt: this.store.now(), wallLimitSeconds: 3600, task, phase: envelope.event_type, activeWorker: agentId, workerRole: envelope.role || task.role, latestProgress: `WORKER_${envelope.event_type}_RECEIVED`, ownerActionRequired: false, nextTransition: "ROLE_CLAIM", nextTimeoutSeconds: 300, jutellMode: "NOT_RUNNING" });
    const flightKey = `${agentId}:${task.taskId}`; if (this.inFlight.has(flightKey)) return; this.inFlight.add(flightKey);
    try {
      const role = this.teams.roles(task.taskId).find((item) => item.assignedAgent === agentId && item.role === envelope.role)
        || this.teams.roles(task.taskId).find((item) => item.assignedAgent === agentId);
      const claim = contract.claimRole(envelope, task, role); if (!claim.accepted) return;
      if (role && ["PASS", "SKIPPED"].includes(role.status)) {
        this.store.db.prepare("UPDATE inbound_messages SET state='SUPERSEDED',reason_code='STALE_ROLE_ALREADY_COMPLETE',processed_at=? WHERE discord_message_id=?")
          .run(this.store.now(), input.messageId);
        return;
      }
      this.store.upsertRuntimeState("worker:last_event", { taskId: envelope.task_id, eventType: envelope.event_type, agentId, stage: "ROLE_CLAIM", at: this.store.now() });
      let executionTask = this.tasks.get(task.taskId)!;
      if (role) {
        this.teams.activate(task.taskId, role.sequence);
        executionTask = this.tasks.setCurrentTeamRole(task.taskId, role.sequence, role.role, agentId);
      }
      if (executionTask.status === "DISPATCHED") executionTask = this.tasks.transition(task.taskId, "CLAIMED", { attempt: executionTask.attempt + 1, assignedAgent: agentId });
      else if (executionTask.status === "RUNNING") executionTask = this.tasks.transition(task.taskId, "RUNNING", { attempt: executionTask.attempt + 1, assignedAgent: agentId });
      if (executionTask.status === "CLAIMED") executionTask = this.tasks.transition(task.taskId, "RUNNING");
      this.agents?.markBusy(agentId, executionTask.taskId, executionTask.projectId, role?.role || executionTask.role, executionTask.workspace);
      const claimAttempt = executionTask.attempt;
      const claimSequence = role?.sequence ?? executionTask.currentRoleSequence;
      const claimRound = role?.revisionRound ?? envelope.round;
      const provenance: WorkerExecutionProvenance = { executionId: randomUUID(), taskId: task.taskId, agentId, completedAt: this.store.now() };
      const effectiveRole = envelope.role || role?.role || executionTask.role;
      const ack = contract.buildAck(executionTask, effectiveRole, envelope.round, "ASUS");
      await this.protocol.emitWorkerEvidence("ACK", executionTask, agentId, "ASUS", { ...ack.payload, role: ack.role, round: ack.round, thread_id: executionTask.threadId }, provenance);
      // ACK publication can legitimately update durable Task metadata through
      // the live gateway/inbound path. Capture the callback fence only after
      // that owned side effect; later attempt/Role/round/version changes remain stale.
      const claimVersion = (this.store.db.prepare("SELECT updated_at FROM tasks WHERE task_id=?").get(task.taskId) as { updated_at: string }).updated_at;
      this.store.upsertRuntimeState("worker:last_event", { taskId: envelope.task_id, eventType: envelope.event_type, agentId, stage: "ACK", attempt: claimAttempt, at: this.store.now() });
      if (process.env.HERMESS_ACK_ONLY_TASK_ID === task.taskId) {
        this.store.upsertRuntimeState("worker:ack_only_pause", { taskId: task.taskId, agentId, at: this.store.now(), stage: "ACK_SENT_EXECUTION_PAUSED" });
        contract.complete(input);
        return;
      }
      const adapter = this.adapters.get(agentId); if (!adapter) return;
      const actualBinding = captureExecutionBinding(executionTask);
      const bindingRow = this.store.db.prepare("SELECT value_json FROM runtime_state WHERE key=?").get(`task:execution_binding:${executionTask.taskId}`) as { value_json: string } | undefined;
      const expectedBinding: ExecutionBinding = bindingRow ? JSON.parse(bindingRow.value_json) as ExecutionBinding : actualBinding;
      if (!bindingRow) this.store.upsertRuntimeState(`task:execution_binding:${executionTask.taskId}`, actualBinding);
      const binding = verifyExecutionBinding(expectedBinding, { ...actualBinding, task_id: executionTask.taskId });
      if (!binding.ok) {
        this.store.upsertRuntimeState(`worker:binding_rejected:${executionTask.taskId}`, { taskId: executionTask.taskId, expected: expectedBinding, actual: actualBinding, reason: binding.reason, at: this.store.now() });
        this.tasks.transition(executionTask.taskId, "WAITING_MAIN", { result: binding.reason });
        contract.complete(input);
        return;
      }
      const executionForbidden = task.doNot.some((item) => /\bCLI execution\b|\bProduct mutation\b|\bAVM execution\b/i.test(item));
      const result = executionForbidden
        ? { ok: true, output: "회의 전용 bounded 확인을 완료했습니다. CLI와 파일 변경은 작업 계약에 따라 수행하지 않았습니다.", evidence: ["TASK_CONTRACT_READ_ONLY", "PRODUCT_EXECUTION_0"], exitCode: 0 }
        : await (async () => {
          const pkg = await this.context.resolve(executionTask);
          const continuation = this.runBudget?.continuation(executionTask.taskId, effectiveRole, claimRound);
          const handoff = handoffContextForDispatch(this.store, executionTask.taskId, effectiveRole, claimRound);
          const executionContext = { ...pkg, ...(handoff ? { handoff } : {}), ...(continuation ? { continuation: {
            intentId: continuation.intentId, ...(continuation.runId ? { runId: continuation.runId } : {}), role: continuation.role,
            revisionRound: continuation.revisionRound, instruction: continuation.instruction,
            evidenceReferences: continuation.evidenceReferences, authoritySource: continuation.authoritySource, createdAt: continuation.createdAt,
          } } : {}) };
          const currentModel = executionTask.modelOverride || this.models?.getCurrentModel(agentId).preference?.selectedModel;
          if (!this.availabilityFallback) return adapter.startTask(executionContext, currentModel ? { model: currentModel } : {});
          const fallback = await this.availabilityFallback.execute({ taskId: executionTask.taskId, role: effectiveRole, agentId,
            ...(currentModel ? { requestedModel: currentModel } : {}), adapter,
            run: (model) => adapter.startTask(executionContext, model ? { model } : {}) });
          this.store.upsertRuntimeState(`model:fallback:${executionTask.taskId}:${effectiveRole}`, {
            taskId: executionTask.taskId, agentId, ...(currentModel ? { originalModel: currentModel } : {}),
            ...(fallback.failureClass ? { failureClass: fallback.failureClass } : {}), fallbackAttempted: fallback.fallbackAttempted,
            ...(fallback.fallbackModel ? { fallbackModel: fallback.fallbackModel } : {}), fallbackResult: fallback.result.ok ? "SUCCESS" : "FAIL",
            shouldFallbackWorker: fallback.shouldFallbackWorker, at: this.store.now(),
          });
          return fallback.result;
        })();
      if (executionForbidden) result.output = "읽기 전용 범위의 확인을 완료했습니다. 작업 계약에 따라 CLI 실행과 파일 변경은 하지 않았습니다.";
      const freshTask = this.tasks.get(task.taskId);
      const freshRole = claimSequence ? this.teams.role(task.taskId, claimSequence) : undefined;
      const freshVersion = (this.store.db.prepare("SELECT updated_at FROM tasks WHERE task_id=?").get(task.taskId) as { updated_at: string } | undefined)?.updated_at;
      const attemptCurrent = Boolean(freshTask && !["PASS", "FAIL", "CANCELLED"].includes(freshTask.status)
        && freshTask.attempt === claimAttempt && freshTask.assignedAgent === agentId && freshVersion === claimVersion
        && (!claimSequence || (freshRole?.sequence === claimSequence && freshRole.revisionRound === claimRound && freshRole.assignedAgent === agentId)));
      if (!attemptCurrent) {
        this.store.db.prepare("UPDATE inbound_messages SET state='SUPERSEDED',reason_code='STALE_ATTEMPT_CALLBACK_SUPPRESSED',processed_at=? WHERE discord_message_id=?")
          .run(this.store.now(), input.messageId);
        this.store.upsertRuntimeState(`continuation:stale_worker_callback:${task.taskId}:${claimAttempt}`, { taskId: task.taskId, agentId, claimAttempt, claimSequence, claimRound, at: this.store.now() });
        if (this.agents?.get(agentId)?.currentTask === task.taskId) this.agents.release(agentId, true);
        return;
      }
      if (result.validationEvidence) result.validationEvidence = result.validationEvidence.filter((item) =>
        evidenceMatchesExecution(item, { taskId: task.taskId, attempt: claimAttempt, workerId: agentId, role: effectiveRole, worktree: executionTask.workspace }));
      const outcome: WorkerOutcome = (() => {
        if (effectiveRole === "REVIEWER" || effectiveRole === "ARCHITECT") {
          // The accepted Developer RESULT's structured evidence lives in this
          // Role's durable handoff context, not in the Reviewer's own adapter
          // result (the Reviewer does not re-run validation). Without
          // re-threading it here, normalizeReviewResult sees an empty
          // validationEvidence array and reports missing evidence even when
          // the Developer produced lawful, accepted evidence moments earlier.
          const inherited = this.inheritedHandoffEvidence(task.taskId, effectiveRole, claimRound);
          const merged = [...(result.validationEvidence ?? [])];
          for (const item of inherited) if (!merged.some((existing) => existing.type === item.type && existing.command === item.command)) merged.push(item);
          // Only evidence whose Product digest still matches the current
          // worktree is lawfully current -- a stale record (Product changed
          // after validation) must not be handed onward as if it were still
          // valid, even though it remains visible to normalizeReviewResult's
          // own (identical) freshness check for the pass/fail decision.
          const fresh = merged.filter((item) => !item.product_digest || item.product_digest === captureProductDigest(item.worktree));
          const reviewInput = merged.length ? { ...result, validationEvidence: merged } : result;
          const review = normalizeReviewResult(reviewInput, task.validation);
          const pass = review.verdict === "REVIEW_PASS";
          return { ok: pass, output: result.output, evidence: result.evidence, ...(fresh.length ? { validationEvidence: fresh } : {}), findings: pass ? [] : (review.findings.length ? review.findings : [result.output]) };
        }
        if (effectiveRole === "QA") {
          const qa = normalizeQaResult(result, task.validation);
          const pass = qa.verdict === "QA_PASS";
          return { ok: pass, output: result.output, evidence: result.evidence, ...(result.validationEvidence ? { validationEvidence: result.validationEvidence } : {}), findings: pass ? [] : (qa.findings.length ? qa.findings : [result.output]) };
        }
        const continuation = this.runBudget?.continuation(task.taskId, effectiveRole, claimRound);
        const acceptedReuse = continuation?.evidenceReferences.length && /\b(?:DEVELOPER_PASS|PASS)\b/i.test(result.output) && /\bREUSED\b/i.test(result.output)
          ? bindReusedEvidence(this.store, task.taskId, continuation.evidenceReferences) : undefined;
        const structuredEvidence = result.validationEvidence ?? acceptedReuse;
        // Fail closed: an explicit BLOCKED, a runner/transport failure, or an
        // empty "successful"-looking result must never be normalized into a
        // Developer PASS -- see normalizeDeveloperResult.
        const developer = normalizeDeveloperResult(result);
        const requiredEvidencePresent = task.validation.every((command) => result.validationEvidence?.some((item) => item.type === (/build/i.test(command) ? "BUILD" : /test/i.test(command) ? "TEST" : "TYPECHECK")));
        const developerOk = developer.ok && requiredEvidencePresent;
        return { ok: developerOk, output: result.output, evidence: result.evidence,
          ...(structuredEvidence ? { validationEvidence: structuredEvidence } : {}),
          ...(developerOk ? {} : { findings: developer.ok ? ["Required structured validation evidence is missing or failed"] : developer.findings }) };
      })();
      provenance.completedAt = this.store.now();
      await this.emitOutcome(executionTask, contract, agentId, effectiveRole, envelope.round, outcome, provenance);
      contract.complete(input);
      if (this.agents?.get(agentId)?.currentTask === task.taskId) this.agents.release(agentId);
      this.store.upsertRuntimeState("worker:last_event", { taskId: envelope.task_id, eventType: envelope.event_type, agentId, stage: "RESULT", at: this.store.now() });
    } catch (error) {
      this.store.upsertRuntimeState("worker:last_error", { taskId: envelope.task_id, eventType: envelope.event_type, agentId, error: error instanceof Error ? error.message : String(error), at: this.store.now() });
      if (this.agents?.get(agentId)?.currentTask === envelope.task_id) this.agents.release(agentId, true);
      throw error;
    } finally { this.inFlight.delete(flightKey); }
  }

  async receiveMeeting(input: InboundInput, envelope: NativeEnvelope): Promise<void> {
    if (this.ownerPaused()) return;
    if (!["MEETING_INVITE", "EXECUTION_PROPOSAL", "ROLE_ACCEPT", "DEPENDENCY_REPORT", "CAPABILITY_REPORT"].includes(envelope.event_type)) return;
    const agentId = botTypeToAgent(input.currentIdentity); if (!agentId) return;
    const contract = this.contracts.get(agentId); if (!contract) return;
    const received = contract.receive(input); if (!received.accepted || !received.envelope) return;
    envelope = received.envelope;
    if (!["MEETING_INVITE", "EXECUTION_PROPOSAL", "ROLE_ACCEPT", "DEPENDENCY_REPORT", "CAPABILITY_REPORT"].includes(envelope.event_type)) return;
    const task = this.tasks.get(envelope.task_id); if (!task) return;
    const flightKey = `meeting:${agentId}:${task.taskId}:${envelope.event_type}`; if (this.inFlight.has(flightKey)) return; this.inFlight.add(flightKey);
    this.store.upsertRuntimeState(`meeting:worker:receipt:${agentId}:${task.taskId}:${envelope.event_type}`, { taskId: task.taskId, agentId, eventType: envelope.event_type, at: this.store.now() });
    try {
      const adapter = this.adapters.get(agentId); if (!adapter) return;
      const result = ["EXECUTION_PROPOSAL", "ROLE_ACCEPT"].includes(envelope.event_type)
        ? { ok: true, output: `${agentId === "CLAUDE_CODE" ? "ClaudeCode" : agentId === "OPENCODE" ? "OpenCode" : agentId}가 계획을 확인했고 맡은 역할을 수락합니다. 파일 변경 없이 bounded meeting 범위에서 진행하겠습니다.`, evidence: ["MEETING_ROLE_ACCEPT"], exitCode: 0 }
        : await (async () => {
          const pkg = await this.context.resolve(task);
          const context = { ...pkg, collaboration: { mode: "DISCUSSION" as const, prompt: String(envelope.payload.body || envelope.payload.content || "Propose a bounded role and strategy for this meeting.") +
            " Respond in natural language. Do not modify files. If another worker is named in the dependency, address them directly.", history: [] } };
          return this.adapters.get(agentId)!.startTask(context);
        })();
      const directHandoff = envelope.event_type === "MEETING_INVITE" && agentId === "CLAUDE_CODE";
      const recipient = directHandoff ? "OPENCODE" : "ASUS";
      const eventType = ["EXECUTION_PROPOSAL", "ROLE_ACCEPT"].includes(envelope.event_type) ? "ROLE_ACCEPT" : directHandoff ? "DEPENDENCY_REPORT" : "CAPABILITY_REPORT";
      const body = safeMeetingBody(result.output, agentId, envelope.event_type);
      await this.protocol.emit(eventType, task, agentToBotType(agentId), recipient, {
        body, content: body,
        role: task.role, round: envelope.round, session_id: envelope.payload.session_id, meeting: true, state: "PROPOSING", next_owner: recipient,
      });
      this.store.upsertRuntimeState(`meeting:worker:${agentId}:${task.taskId}`, { taskId: task.taskId, agentId, state: "PROPOSING", at: this.store.now() });
       contract.complete(input);
    } finally { this.inFlight.delete(flightKey); }
  }

  private inboundComplete(input: InboundInput): void { this.contracts.get(botTypeToAgent(input.currentIdentity)!)?.complete(input); }

  /**
   * Re-thread the accepted Developer RESULT's structured validation evidence
   * into a downstream Reviewer/Architect execution. The evidence is taken
   * only from this exact Task/Role/round's durable handoff context (never
   * from prose, never across Tasks), and every item must still resolve
   * through bindReusedEvidence's durable protocol_events/worker_processes
   * check -- foreign, fabricated, or otherwise unresolvable evidence is
   * rejected and simply not inherited (fail closed), same as the existing
   * Developer continuation-reuse path.
   */
  private inheritedHandoffEvidence(taskId: string, role: Role, round: number): ValidationEvidence[] {
    const handoff = handoffContextForDispatch(this.store, taskId, role, round);
    if (!handoff?.validationEvidence.length) return [];
    try {
      return bindReusedEvidence(this.store, taskId, handoff.validationEvidence.map((item) => ({ ...item, source: "REUSED" as const })));
    } catch {
      return [];
    }
  }

  private async emitOutcome(task: TaskRecord, contract: WorkerContract, agentId: AgentId, role: Role, round: number, outcome: WorkerOutcome, provenance: WorkerExecutionProvenance): Promise<void> {
    const roles = this.teams.roles(task.taskId); const current = roles.find((item) => item.assignedAgent === agentId && item.role === role);
    const upstreamHandoff = handoffContextForDispatch(this.store, task.taskId, role, round);
    const downstreamEvidence = [...(upstreamHandoff?.validationEvidence ?? [])];
    for (const item of outcome.validationEvidence ?? []) {
      if (!downstreamEvidence.some((prior) => prior.type === item.type && prior.command === item.command)) downstreamEvidence.push(item);
    }
    let next = current ? roles.find((item) => item.sequence > current.sequence && item.assignedAgent) : undefined;
    const recipient = role === "REVIEWER" || !next?.assignedAgent ? (task.nextOwner || "ASUS") : agentToBotType(next.assignedAgent);
    const wire = contract.buildOutcome(task, role, round, recipient as never, outcome, recipient as never);
    // Mark the completed Role durably so the QA continuation and
    // completion gate (task_roles.status) reflect reality even when the
    // Task's own status projection is the known P2 stale-DISPATCHED.
    // REVIEWER uses REVIEW_PASS (outcome.ok) as the pass signal; other
    // roles use the raw adapter ok. Never re-activate after finish -- PASS
    // must stay PASS.
    if (current && current.status !== "PASS") {
      if (outcome.ok) {
        try {
          this.teams.finish(task.taskId, current.sequence, "PASS", (wire.payload.result as string) || (wire.payload.verdict as string) || outcome.output, outcome.evidence);
        } catch { /* already PASS or concurrent finish -- idempotent */ }
      } else {
        try {
          this.teams.finish(task.taskId, current.sequence, "FAIL" as never, outcome.output, outcome.evidence);
        } catch { /* best-effort */ }
      }
    }
    const resultEvent = await this.protocol.emitWorkerEvidence(wire.event_type === "REVIEW" ? "REVIEW" : wire.event_type === "QA_RESULT" ? "QA_RESULT" : "RESULT", task, agentId, recipient,
      { ...wire.payload, role, round, thread_id: task.threadId, next_owner: recipient }, provenance);
    // TEAM_CHAIN_COMPLETE is a lifecycle transition, not merely a message.
    // Finish the durable team before the budget gate so an accepted QA result
    // cannot be stranded by an idle-budget expiry immediately afterwards.
    if (role === "QA" && outcome.ok) {
      this.teams.complete(task.taskId);
      await this.protocol.emitWorkerEvidence("VERDICT", task, agentId, "ASUS", {
        status: "PASS", result: "TEAM_CHAIN_COMPLETE", role: "QA", round,
        thread_id: task.threadId, chain_complete: true,
      }, provenance);
      try { new TaskCompletionProjection(this.store, this.tasks, this.teams, this.protocol).reconcile(task.taskId); } catch { /* recovery backfill remains authoritative */ }
    } else {
      try { new TaskCompletionProjection(this.store, this.tasks, this.teams, this.protocol).reconcile(task.taskId); } catch { /* projection is best-effort */ }
    }
    // The just-finished Result remains durable evidence, but an exhausted run
    // must not start a new Review, Revision, Expert, or QA attempt.
    if (this.runBudget && !this.runBudget.canContinue(task.taskId)) {
      // A failing Result is not new work -- it is the authoritative outcome of
      // the attempt that was already executing when the budget expired. No
      // other path marks a failed Role's Task FAIL (TaskCompletionProjection
      // only ever projects to PASS, and the continuation watchdog that would
      // normally observe WORKER_FAILED_WITH_RESULT is disabled the instant the
      // budget exhausts). Without this, a Result that loses its race against
      // expiry by mere milliseconds strands the Task in a non-terminal status
      // forever, requiring an Owner to notice and manually close it out.
      if (!outcome.ok) {
        const current = this.tasks.get(task.taskId);
        if (current && !["PASS", "FAIL", "CANCELLED"].includes(current.status)) {
          const terminal = ["RUNNING", "WAITING_RESULT", "REVIEWING"].includes(current.status) ? "FAIL" : "CANCELLED";
          try { this.tasks.transition(current.taskId, terminal as never, { result: `RUN_BUDGET_EXHAUSTED_WITH_TERMINAL_RESULT:${role}:${outcome.output}`.slice(0, 2000) }); }
          catch { /* best-effort terminal close-out; durable Result evidence already recorded */ }
        }
      }
      return;
    }

    // Project-scoped REVIEW_PASS continuation (Review -> QA). The live
    // WorkerRuntime path returns REVIEWER_TO_COMPLETE (terminal) for
    // REVIEW_PASS by design, so when the durable acceptance contract
    // actually requires QA the Task would stall forever awaiting an Owner
    // "next". If this REVIEW_PASS is for a Task whose durable team
    // composition says the next required Role is QA, deterministically
    // advance exactly that Task to its QA assignee via a scoped Protocol
    // TASK dispatch -- never a global Dispatcher.tick() sweep.
    if (role === "REVIEWER" && outcome.ok) {
      // Stale version guard: the envelope round must match the Reviewer
      // Role's expected round. claimRole already enforces this for the
      // inbound dispatch, but a retried/duplicate REVIEW outcome must not
      // advance a newer revision either.
      const fresh = this.teams.roles(task.taskId);
      const freshCurrent = fresh.find((item) => item.sequence === current?.sequence);
      if (freshCurrent && round !== freshCurrent.revisionRound) {
        this.store.upsertRuntimeState(`continuation:stale_suppressed:${task.taskId}:${round}`, { taskId: task.taskId, round, expectedRound: freshCurrent.revisionRound, at: this.store.now() });
        return;
      }
      next = freshCurrent ? fresh.find((item) => item.sequence > freshCurrent.sequence && item.assignedAgent) : next;
      const needsQa = Boolean(next && next.role === "QA" && ["ASSIGNED", "PENDING"].includes(next.status as string));
      if (needsQa && next!.assignedAgent) {
        // The QA TASK's round must equal the QA Role's durable revisionRound
        // verbatim: WorkerContract.claimRole enforces strict equality, so any
        // clamped wire round (MAX_DISCUSSION_ROUNDS) produced a QA dispatch
        // the assigned Worker could never claim (live
        // a prior bounded run). A downstream Role owns
        // its own revision lineage; copying the durable round keeps envelope
        // and Role identical by construction.
        const qaRound = next!.revisionRound;
        // Duplicate suppression is per revision lineage: only a QA TASK for
        // this SAME round was already delivered. Matching any historical QA
        // envelope (e.g. a pre-retry round-0 dispatch that still lives in the
        // append-only event log) permanently suppressed every future retry's
        // QA dispatch -- a prior bounded run round 5
        // (2026-08-26): DEVELOPER and REVIEWER both passed, then the QA hop
        // was silently swallowed and recovery SAFE_STOPped the Task FAIL.
        const qaAlreadyDispatched = this.store.db.prepare(`SELECT 1 FROM protocol_events
          WHERE task_id=? AND event_type='TASK' AND recipient=? AND payload_json LIKE ? AND payload_json LIKE ?`)
          .get(task.taskId, agentToBotType(next!.assignedAgent), `%"role":"QA"%`, `%"round":${qaRound}%`) as unknown;
        const qaAlreadyActive = this.store.db.prepare("SELECT 1 FROM task_roles WHERE task_id=? AND role='QA' AND status IN ('ACTIVE','PASS')").get(task.taskId) as unknown;
        if (!qaAlreadyDispatched && !qaAlreadyActive) {
          const contributors = new Set(fresh.filter((r) => ["DEVELOPER", "DEBUGGER", "REFACTORER", "REVIEWER"].includes(r.role) && r.assignedAgent).map((r) => r.assignedAgent!));
          const introducesSoD = contributors.has(next!.assignedAgent!);
          if (introducesSoD) {
            this.store.upsertRuntimeState(`continuation:sod_block:${task.taskId}`, { taskId: task.taskId, qaAgent: next!.assignedAgent, reason: "QA assignee overlaps a prior contributor", at: this.store.now() });
          } else {
            recordHandoffContext(this.store, contextFromResult(task, resultEvent, role, "QA", qaRound, outcome.output, downstreamEvidence, outcome.findings ?? []));
            const qaTask = this.tasks.setCurrentTeamRole(task.taskId, next!.sequence, next!.role, next!.assignedAgent!);
            this.teams.activate(task.taskId, next!.sequence);
            const qaBot = agentToBotType(next!.assignedAgent!);
            const qaIntent = this.runBudget?.continuation(qaTask.taskId, next!.role, qaRound);
            await this.protocol.emit("TASK", qaTask, "ORCHESTRATOR", qaBot, { title: qaTask.title,
              ...continuationDispatchPayload(qaTask.goal, qaIntent), role: next!.role, round: qaRound });
            this.store.upsertRuntimeState(`continuation:qa:${task.taskId}`, { taskId: task.taskId, qaAgent: next!.assignedAgent, round: qaRound, upstreamReviewRound: round, at: this.store.now(), handoff: "REVIEW_PASS->QA" });
            return;
          }
        } else {
          this.store.upsertRuntimeState(`continuation:qa:duplicate_suppressed:${task.taskId}:${qaRound}`, { taskId: task.taskId, round: qaRound, at: this.store.now() });
          return;
        }
      } else if (next && next.role !== "QA") {
        this.store.upsertRuntimeState(`continuation:review_terminal:${task.taskId}`, { taskId: task.taskId, nextRole: next.role, reason: "REVIEW_PASS terminal; durable contract does not require QA", at: this.store.now() });
      } else if (!next) {
        // No further Role in the durable composition -- REVIEW_PASS is
        // terminal for this Task (e.g. UNKNOWN default [DEVELOPER,REVIEWER]).
        this.store.upsertRuntimeState(`continuation:review_terminal:${task.taskId}`, { taskId: task.taskId, nextRole: null, reason: "REVIEW_PASS terminal; no further Role in durable composition", at: this.store.now() });
      }
    }

    // A failed implementation execution is worker-failure evidence only: the
    // durable RESULT records it and recovery reassigns the Role. It must never
    // route into independent review as if the boundary had converged --
    // "Implementation complete" would be false on its face (DDF-002 round-13
    // live finding). Reviewer failures keep their revision routing below.
    if (!outcome.ok && !["REVIEWER", "ARCHITECT"].includes(role)) {
      this.store.upsertRuntimeState(`worker:failed_no_handoff:${task.taskId}:${current?.sequence ?? role}`, { taskId: task.taskId, agentId, role, round, at: this.store.now() });
      return;
    }

    const handoff = decideHandoff({ fromRole: role, ...(role === "REVIEWER" ? { verdict: outcome.ok ? "REVIEW_PASS" : "REVIEW_FAIL" } : {}), currentRound: round });
    // Revision routes back to the previous implementation Role. Normal progress
    // routes to the next assigned Role. Every route is a native Discord event with
    // the target Role, so the receiving WorkerContract performs the same claim.
    const previous = current ? [...roles].reverse().find((item) => item.sequence < current.sequence && item.assignedAgent && ["DEVELOPER", "DEBUGGER", "REFACTORER"].includes(item.role)) : undefined;
    const target = handoff.kind === "REVIEWER_TO_DEVELOPER_REVISION" ? previous : next;
    const reviewPassToExpert = role === "REVIEWER" && outcome.ok && target?.role === "MCP_SPECIALIST";
    if (target?.assignedAgent && (handoff.kind !== "REVIEWER_TO_COMPLETE" || reviewPassToExpert)) {
      const targetBot = agentToBotType(target.assignedAgent);
      if (handoff.kind === "AGENT_TO_EXPERT" || (role === "REVIEWER" && target.role === "MCP_SPECIALIST" && outcome.ok)) {
        await this.protocol.emit("EXPERT_INVITE", task, agentId, targetBot, {
          role: target.role, round: handoff.round, thread_id: task.threadId, status: "INVITED", request_id: randomUUID(),
          requested_role: target.role, reason: "Bounded expert validation required by the current Task pipeline", next_owner: targetBot,
        });
      } else {
        // A prior bounded run: a REVIEWER_TO_DEVELOPER_REVISION
        // handoff sent a REVISION_REQUEST carrying round=handoff.round, but never advanced the target
        // Role's own durable task_roles.revision_round (that only happened on the separate
        // teams/scheduler.ts synthetic completion path via TeamRepository.reopen()). WorkerContract's
        // claimRole() compares the inbound envelope's round against role.revisionRound and silently
        // rejects on any mismatch (ROUND_MISMATCH) -- so the receiving Worker's own live session could
        // never claim the round it was just sent. This is not specific to the Reviewer->Developer
        // direction: once round > 0, the SAME live run hit the identical stall one hop later on the
        // very next DEVELOPER_TO_REVIEWER handoff (round 1 back to the Reviewer) too, because the
        // Reviewer Role's own revision_round was equally stale. Reopen the target Role's round here,
        // for every real handoff, the same way the synthetic completion path already does.
        this.teams.reopen(task.taskId, target.sequence, handoff.round);
        recordHandoffContext(this.store, contextFromResult(task, resultEvent, role, target.role, handoff.round, outcome.output,
          downstreamEvidence, outcome.findings ?? [], handoff.kind === "REVIEWER_TO_DEVELOPER_REVISION"));
        const handoffWire = contract.buildHandoffEnvelope(task, handoff, targetBot, {
          ...(outcome.findings ? { findings: outcome.findings, requestedChanges: outcome.findings } : {}), targetRole: target.role,
        });
        await this.protocol.emit(handoffWire.event_type, task, agentId, targetBot, {
          ...handoffWire.payload, role: target.role, round: handoffWire.round, thread_id: task.threadId, next_owner: targetBot,
          status: handoff.kind === "DEVELOPER_TO_REVIEWER" ? "REVIEW_REQUEST" : undefined,
        });
      }
    }
  }
}

function renderMeetingBody(output: string, agentId: AgentId, eventType: NativeEnvelope["event_type"]): string {
  const name = agentId === "CLAUDE_CODE" ? "ClaudeCode" : agentId === "OPENCODE" ? "OpenCode" : agentId === "CODEX" ? "Codex" : "CommandCode";
  if (["EXECUTION_PROPOSAL", "ROLE_ACCEPT"].includes(eventType)) return `${name}가 계획을 확인했습니다. 파일 변경 없이 bounded meeting 범위에서 진행하겠습니다.`;
  if (output.includes("step_start") || output.includes("tool_use") || output.trimStart().startsWith("{")) return `${name}가 bounded meeting에서 제안할 범위를 확인했습니다. 파일 변경 없이 자연어 결과를 공유하겠습니다.`;
  return output || `${name}가 bounded meeting에 참여했고 파일을 변경하지 않았습니다.`;
}

function meetingBody(output: string, agentId: AgentId, eventType: NativeEnvelope["event_type"]): string {
  if (["EXECUTION_PROPOSAL", "ROLE_ACCEPT"].includes(eventType)) return `${agentId === "CLAUDE_CODE" ? "ClaudeCode" : "OpenCode"}가 계획을 확인했고 맡은 역할을 수락합니다. 파일 변경 없이 bounded meeting 범위에서 진행하겠습니다.`;
  if (output.includes("step_start") || output.includes("tool_use") || output.trimStart().startsWith("{")) return `${agentId === "CLAUDE_CODE" ? "ClaudeCode" : "OpenCode"}는 이 bounded meeting에서 제안한 역할을 수행할 수 있습니다. 파일 변경 없이 자연어 검토 결과를 공유하겠습니다.`;
  return output || `${agentId === "CLAUDE_CODE" ? "ClaudeCode" : "OpenCode"}는 이 bounded meeting에 참여하고 파일을 변경하지 않겠습니다.`;
}

function safeMeetingBody(output: string, agentId: AgentId, eventType: NativeEnvelope["event_type"]): string {
  const name = agentId === "CLAUDE_CODE" ? "ClaudeCode" : agentId === "OPENCODE" ? "OpenCode" : agentId === "CODEX" ? "Codex" : "CommandCode";
  if (["EXECUTION_PROPOSAL", "ROLE_ACCEPT"].includes(eventType)) return `${name}가 계획을 확인했습니다. 파일 변경 없이 bounded meeting 범위에서 진행하겠습니다.`;
  if (output.includes("step_start") || output.includes("tool_use") || output.trimStart().startsWith("{")) return `${name}가 회의 범위와 제안 내용을 확인했습니다. 실행 스트림은 내부 evidence에만 보관합니다.`;
  return output || `${name}가 bounded meeting에 참여했고 파일은 변경하지 않았습니다.`;
}
