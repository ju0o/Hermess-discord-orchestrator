import { randomUUID } from "node:crypto";
import type { AgentAdapter } from "../agents/adapter.js";
import type { AgentId, TaskRecord } from "../domain/types.js";
import type { AgentRegistry } from "../registry/agentRegistry.js";
import type { ContextResolver } from "../context/resolver.js";
import { requiresHumanGate } from "../security/humanGate.js";
import { inspectGit } from "../projects/gitSafety.js";
import type { TaskRepository } from "./repository.js";
import type { WorkspaceLocks } from "./locks.js";
import type { Protocol } from "./protocol.js";
import type { WorkroomManager } from "../discord/workrooms/manager.js";
import type { SequentialTeamScheduler } from "../teams/scheduler.js";
import type { ModelRouter } from "../models/router.js";
import type { RunBudgetController } from "../runtime/runBudget.js";
import { continuationDispatchPayload } from "../runtime/continuationIntent.js";
import { dependencyPreflight, nextTypesPreflight } from "../projects/dependencyPreflight.js";
import type { ProcessRunner } from "../runtime/processRunner.js";

export class Dispatcher {
  private ticking = false;
  constructor(
    private readonly tasks: TaskRepository, private readonly agents: AgentRegistry,
    private readonly adapters: Map<AgentId, AgentAdapter>, private readonly locks: WorkspaceLocks,
    private readonly context: ContextResolver, private readonly protocol: Protocol, private readonly workrooms: WorkroomManager,
    private readonly teams: SequentialTeamScheduler,
    private readonly modelRouter: ModelRouter,
    private readonly ownerPaused: () => boolean = () => false, private readonly runBudget?: RunBudgetController,
    private readonly runner?: ProcessRunner,
  ) {}

  async tick(): Promise<void> {
    if (this.ownerPaused()) return;
    if (this.ticking) return; this.ticking = true;
    try {
      for (const task of this.tasks.listByStatus("QUEUED")) {
        if (task.executionHold) continue;
        if (this.runBudget && !this.runBudget.canContinue(task.taskId)) continue;
        if (this.teams.isTeamTask(task)) await this.teams.dispatch(task); else await this.dispatch(task);
      }
      // DISPATCHED/RUNNING Tasks are passive from the scheduler's perspective.
      // The addressed Discord WorkerRuntime owns ACK, adapter execution, and
      // result publication for every Coding Agent.
    } finally { this.ticking = false; }
  }

  /**
   * Project/Task-scoped dispatch primitive (Live Company Dogfood Run 01, Phase 3): dispatches
   * exactly the one named Task and nothing else. Unlike tick(), it never sweeps
   * listByStatus("QUEUED") -- it cannot pick up any unrelated persistent Task, however many are
   * sitting QUEUED/WAITING_MAIN elsewhere in this Runtime's durable state. A caller that wants
   * to drive one project's Task set without a global sweep should call this once per Task instead
   * of tick(). Returns false (no-op) if the Task is missing, not QUEUED, or execution-held.
   */
  async dispatchTask(taskId: string): Promise<boolean> {
    if (this.ownerPaused()) return false;
    if (this.runBudget && !this.runBudget.canContinue(taskId)) return false;
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "QUEUED" || task.executionHold) return false;
    if (this.teams.isTeamTask(task)) await this.teams.dispatch(task); else await this.dispatch(task);
    return true;
  }

  async redriveTask(taskId: string): Promise<boolean> {
    if (this.ownerPaused()) return false;
    const task = this.tasks.get(taskId); if (!task || task.status !== "DISPATCHED" || task.executionHold) return false;
    this.tasks.transition(taskId, "QUEUED");
    if (this.teams.isTeamTask(task)) return this.teams.redrive(taskId);
    return this.dispatchTask(taskId);
  }

  private async dispatch(task: TaskRecord): Promise<void> {
    if (this.ownerPaused() || task.executionHold) return;
    if (this.runBudget && !this.runBudget.canContinue(task.taskId)) return;
    const gate = requiresHumanGate(task.goal);
    if (gate.required) { const reason = gate.reason || "Protected operation requires approval"; this.tasks.transition(task.taskId, "HUMAN_GATE", { result: reason }); await this.protocol.emit("HANDOFF", task, "RUNTIME", "MAIN", { status: "HUMAN_GATE", reason }); return; }
    const assigned = task.assignedAgent ? this.agents.get(task.assignedAgent) : this.agents.choose(task.role, task.requiredCapabilities);
    if (!assigned) return;
    if (this.runner) {
      const preflight = await dependencyPreflight(this.runner, task.workspace);
      if (!preflight.ready) { this.tasks.transition(task.taskId, "WAITING_MAIN", { result: preflight.reason, evidence: [...task.evidence, ...preflight.evidence] }); return; }
      const nextTypes = await nextTypesPreflight(this.runner, task.workspace);
      if (!nextTypes.ready) { this.tasks.transition(task.taskId, "WAITING_MAIN", { result: nextTypes.reason, evidence: [...task.evidence, ...nextTypes.evidence] }); return; }
    }
    const updated = this.tasks.transition(task.taskId, "DISPATCHED", { assignedAgent: assigned.agentId });
    const intent = this.runBudget?.continuation(task.taskId, task.role, 0);
    // A legal continuation is a new delivery generation.  The Worker-side
    // logical-key guard must distinguish it from an earlier delivery of the
    // same Task/role/round without changing Worker assignment authority.
    const dispatchId = randomUUID();
    try { await this.protocol.emit("TASK", updated, "ORCHESTRATOR", assigned.agentId, { title: task.title, ...continuationDispatchPayload(task.goal, intent), role: task.role, fileScope: task.fileScope, dispatch_id: dispatchId }); }
    catch (error) { this.tasks.transition(task.taskId, "WAITING_MAIN", { result: `Discord TASK delivery failed: ${error instanceof Error ? error.message : String(error)}` }); }
  }

}
