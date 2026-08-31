import type { AgentId, Role } from "../domain/types.js";
import type { Store } from "../storage/database.js";

const ROLE_NAMESPACES: Record<Role, string[]> = {
  DEVELOPER: ["decisions", "development-preferences", "agent-memory"],
  REVIEWER: ["decisions", "review-policy", "agent-memory"],
  DEBUGGER: ["decisions", "debug-history", "agent-memory"],
  QA: ["decisions", "qa-policy"],
  REFACTORER: ["decisions", "development-preferences"],
  ARCHITECT: ["decisions", "architecture"],
  MCP_SPECIALIST: ["decisions", "mcp", "agent-memory"],
};

export class MemoryRouter {
  constructor(private readonly store: Store) {}
  resolve(projectId: string, agentId: AgentId | undefined, role: Role, includeMyMemory: boolean) {
    const namespaces = [...ROLE_NAMESPACES[role], ...(includeMyMemory ? ["my-memory"] : [])];
    const placeholders = namespaces.map(() => "?").join(",");
    const rows = this.store.db.prepare(`SELECT namespace,content FROM memory_entries
      WHERE namespace IN (${placeholders}) AND (project_id IS NULL OR project_id=?)
      AND (agent_id IS NULL OR agent_id=?) ORDER BY created_at DESC LIMIT 50`)
      .all(...namespaces, projectId, agentId ?? null) as Array<{ namespace: string; content: string }>;
    return rows.map((row) => ({ source: row.namespace, content: row.content }));
  }
}
