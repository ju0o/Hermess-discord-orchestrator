import type { AgentId, AgentRecord, Role, TaskRecord } from "../domain/types.js";
import type { AgentRegistry } from "../registry/agentRegistry.js";
import type { RoleRegistry } from "../registry/roleRegistry.js";
import type { WorkspaceLocks } from "../tasks/locks.js";

export interface RejectedAgent { agentId: AgentId; reasons: string[]; }
export interface AgentRoutingDecision {
  role: Role; selectedAgent?: AgentId; reasonCode: "ROLE_ASSIGNED" | "ROUTING_MANUAL_OVERRIDE" | "ROUTING_NO_ELIGIBLE_AGENT" | "INDEPENDENT_REVIEW_UNAVAILABLE";
  selectedReasons: string[]; rejected: RejectedAgent[];
}

// Roles that implement Product work and therefore must remain independent from the
// downstream Reviewer/QA identities that certify that work (mirrors EXECUTION_ROLES in
// teams/scheduler.ts). Recovery routing for any of these Roles must never select a Worker
// already reserved for REVIEWER or QA on the same Task -- otherwise a replacement Developer
// could collapse into "Reviewer reviews itself" or "QA verifies itself" (V1 recovery
// separation-of-duties correction from a prior bounded run).
const EXECUTION_ROLES = new Set<Role>(["DEVELOPER", "DEBUGGER", "REFACTORER", "MCP_SPECIALIST", "ARCHITECT"]);

export class AgentRouter {
  constructor(private readonly agents: AgentRegistry, private readonly roles: RoleRegistry, private readonly locks: WorkspaceLocks,
    private readonly connected: (agentId: AgentId) => boolean) {}

  route(task: TaskRecord, role: Role, priorAssignments: Partial<Record<Role, AgentId>>, override?: AgentId,
    excluded: ReadonlySet<AgentId> = new Set()): AgentRoutingDecision {
    const required = this.roles.requirements(role); const rejected: RejectedAgent[] = []; const eligible: AgentRecord[] = [];
    const qaContributors = role === "QA"
      ? new Set([priorAssignments.DEVELOPER, priorAssignments.DEBUGGER, priorAssignments.REFACTORER, priorAssignments.REVIEWER].filter(Boolean))
      : new Set<AgentId>();
    // Symmetric guard for the opposite direction: an execution Role recovering (e.g. a
    // replacement Developer after a Worker failure) must not be handed to a Worker already
    // reserved for the independent downstream Reviewer or QA Role, even though that
    // reservation is not yet a PASS. Callers that only know about already-passed upstream
    // Roles still get this protection as long as they also thread the reserved downstream
    // assignment into priorAssignments (see scopedContinuationWatchdog.recover()).
    const downstreamProtected = EXECUTION_ROLES.has(role)
      ? new Set([priorAssignments.REVIEWER, priorAssignments.QA].filter(Boolean))
      : new Set<AgentId>();
    for (const agent of this.agents.list()) {
      const reasons = [...(excluded.has(agent.agentId) ? ["RECOVERY_EXCLUDED_WORKER"] : []),
        ...(qaContributors.has(agent.agentId) ? ["SEPARATION_OF_DUTIES"] : []),
        ...(downstreamProtected.has(agent.agentId) ? ["SEPARATION_OF_DUTIES"] : []),
        ...this.ineligibleReasons(agent, task, required)];
      if (reasons.length) rejected.push({ agentId: agent.agentId, reasons }); else eligible.push(agent);
    }
    const implementers = role === "REVIEWER"
      ? new Set([priorAssignments.DEVELOPER, priorAssignments.DEBUGGER, priorAssignments.REFACTORER, priorAssignments.MCP_SPECIALIST].filter(Boolean))
      : new Set<AgentId>();
    if (override) {
      if (implementers.has(override)) {
        rejected.push({ agentId: override, reasons: ["IMPLEMENTATION_AGENT", "INDEPENDENT_REVIEW_REQUIRED"] });
        return { role, reasonCode: "INDEPENDENT_REVIEW_UNAVAILABLE", selectedReasons: ["INDEPENDENT_REVIEW_UNAVAILABLE", "MANUAL_OVERRIDE_REJECTED"], rejected };
      }
      const candidate = eligible.find((agent) => agent.agentId === override);
      if (!candidate) return { role, reasonCode: "ROUTING_NO_ELIGIBLE_AGENT", selectedReasons: ["Unsafe manual override was not applied"], rejected };
      return { role, selectedAgent: override, reasonCode: "ROUTING_MANUAL_OVERRIDE", selectedReasons: ["MANUAL_AGENT_OVERRIDE", "ONLINE", "AVAILABLE", "CAPABILITY_MATCH", "DISCORD_CONNECTED", "NO_WORKSPACE_CONFLICT"], rejected };
    }
    let pool = eligible; let fallback = false;
    if (role === "REVIEWER") {
      const independent = eligible.filter((agent) => !implementers.has(agent.agentId));
      if (independent.length) {
        for (const agent of eligible.filter((item) => implementers.has(item.agentId))) rejected.push({ agentId: agent.agentId, reasons: ["IMPLEMENTATION_AGENT"] });
        pool = independent;
      } else if (eligible.length) return { role, reasonCode: "INDEPENDENT_REVIEW_UNAVAILABLE", selectedReasons: ["INDEPENDENT_REVIEW_UNAVAILABLE"], rejected };
    }
    if (!pool.length) return { role, reasonCode: "ROUTING_NO_ELIGIBLE_AGENT", selectedReasons: [], rejected };
    const used = new Set(Object.values(priorAssignments));
    const scored = pool.map((agent) => ({ agent, score: required.length * 100 + 30
      + (agent.currentProject === task.projectId ? 15 : 0) + (agent.sessionId ? 5 : 0) + (used.has(agent.agentId) ? -20 : 10) }))
      .sort((a, b) => b.score - a.score || a.agent.agentId.localeCompare(b.agent.agentId));
    const winner = scored[0]!;
    for (const item of scored.slice(1)) rejected.push({ agentId: item.agent.agentId, reasons: [`LOWER_DETERMINISTIC_SCORE:${item.score}`] });
    return { role, selectedAgent: winner.agent.agentId, reasonCode: fallback ? "INDEPENDENT_REVIEW_UNAVAILABLE" : "ROLE_ASSIGNED",
      selectedReasons: ["ONLINE", "AVAILABLE", "CAPABILITY_MATCH", "DISCORD_CONNECTED", "NO_WORKSPACE_CONFLICT",
        ...(winner.agent.currentProject === task.projectId ? ["PROJECT_CONTEXT"] : []), ...(winner.agent.sessionId ? ["SESSION_CONTEXT"] : []),
        ...(fallback ? ["INDEPENDENT_REVIEW_UNAVAILABLE"] : role === "REVIEWER" ? ["INDEPENDENT_REVIEW"] : []), `SCORE:${winner.score}`], rejected };
  }

  private ineligibleReasons(agent: AgentRecord, task: TaskRecord, required: string[]): string[] {
    const reasons: string[] = [];
    if (agent.health !== "ONLINE") reasons.push("ROUTING_AGENT_OFFLINE");
    if (agent.status !== "AVAILABLE" && agent.currentTask !== task.taskId) reasons.push("ROUTING_AGENT_BUSY");
    if (!required.every((capability) => agent.capabilities.includes(capability as never))) reasons.push("ROUTING_CAPABILITY_MISMATCH");
    if (!agent.discordBotId || !this.connected(agent.agentId)) reasons.push("ROUTING_DISCORD_UNAVAILABLE");
    if (!this.locks.canAcquire(task.taskId, task.workspace, task.fileScope)) reasons.push("ROUTING_WORKSPACE_CONFLICT");
    return reasons;
  }
}
