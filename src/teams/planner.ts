import type { AgentId, Role, TaskRecord } from "../domain/types.js";
import { classifyTask } from "../routing/taskClassifier.js";
import type { AgentRouter, AgentRoutingDecision } from "../routing/agentRouter.js";
import type { TaskRepository } from "../tasks/repository.js";
import type { TeamRepository } from "./repository.js";

export class TeamPlanner {
  constructor(private readonly tasks: TaskRepository, private readonly teams: TeamRepository, private readonly router: AgentRouter) {}
  routeRole(task: TaskRecord, role: Role, priorAssignments: Partial<Record<Role, AgentId>>,
    excluded: ReadonlySet<AgentId> = new Set()): AgentRoutingDecision {
    return this.router.route(task, role, priorAssignments, undefined, excluded);
  }
  plan(taskInput: TaskRecord) {
    const existing = this.teams.get(taskInput.taskId); if (existing) return { team: existing, roles: this.teams.roles(taskInput.taskId), blocked: existing.status === "BLOCKED" };
    const classification = classifyTask(taskInput); const task = this.tasks.setTeamMetadata(taskInput.taskId, classification.taskType, classification.requiredRoles, taskInput.agentOverrides);
    const team = this.teams.create(task.taskId, classification.taskType, classification.requiredRoles); const assignments: Partial<Record<Role, AgentId>> = {}; let blocked = false;
    for (const roleRecord of this.teams.roles(task.taskId)) {
      const decision = this.router.route(task, roleRecord.role, assignments, task.agentOverrides?.[roleRecord.role]); this.teams.recordDecision(task.taskId, roleRecord.sequence, decision);
      if (!decision.selectedAgent) { this.teams.block(task.taskId, roleRecord.sequence, "ROUTING_NO_ELIGIBLE_AGENT"); blocked = true; break; }
      assignments[roleRecord.role] = decision.selectedAgent;
      this.teams.assign(task.taskId, roleRecord.sequence, decision.selectedAgent, `${decision.reasonCode}: ${decision.selectedReasons.join(", ")}`);
    }
    return { team: this.teams.get(task.taskId)!, roles: this.teams.roles(task.taskId), blocked, source: classification.source };
  }
}
