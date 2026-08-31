import type { AgentAdapter } from "../agents/adapter.js";
import type { AgentId } from "../domain/types.js";
import type { AgentRegistry } from "../registry/agentRegistry.js";

export class HealthMonitor {
  constructor(private readonly agents: AgentRegistry, private readonly adapters: Map<AgentId, AgentAdapter>) {}
  async checkAll(): Promise<Record<AgentId, Awaited<ReturnType<AgentAdapter["healthCheck"]>>>> {
    const entries = await Promise.all([...this.adapters.entries()].map(async ([id, adapter]) => [id, await adapter.healthCheck()] as const));
    for (const [id, result] of entries) this.agents.setHealth(id, result);
    return Object.fromEntries(entries) as Record<AgentId, Awaited<ReturnType<AgentAdapter["healthCheck"]>>>;
  }
}
