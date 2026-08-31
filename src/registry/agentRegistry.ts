import type { AgentId, AgentRecord, AgentStatus, HealthResult, Role } from "../domain/types.js";
import type { Store } from "../storage/database.js";

function fromRow(row: Record<string, unknown>): AgentRecord {
  return {
    agentId: row.agent_id as AgentId,
    displayName: row.display_name as string,
    backendType: row.backend_type as string,
    ...(row.agent_type ? { agentType: row.agent_type as string } : {}),
    ...(row.discord_bot_id ? { discordBotId: row.discord_bot_id as string } : {}),
    ...(row.discord_mention ? { discordMention: row.discord_mention as string } : row.discord_bot_id ? { discordMention: `<@${row.discord_bot_id}>` } : {}),
    ...(row.runtime_adapter ? { runtimeAdapter: row.runtime_adapter as string } : {}),
    ...(row.available_models_json ? { availableModels: JSON.parse(row.available_models_json as string) as string[] } : {}),
    status: row.status as AgentStatus,
    capabilities: JSON.parse(row.capabilities_json as string),
    ...(row.current_role ? { currentRole: row.current_role as Role } : {}),
    ...(row.current_project ? { currentProject: row.current_project as string } : {}),
    ...(row.current_task ? { currentTask: row.current_task as string } : {}),
    ...(row.working_directory ? { workingDirectory: row.working_directory as string } : {}),
    ...(row.session_id ? { sessionId: row.session_id as string } : {}),
    ...(row.last_seen ? { lastSeen: row.last_seen as string } : {}),
    health: row.health as AgentRecord["health"],
    ...(row.health_detail ? { healthDetail: row.health_detail as string } : {}),
  };
}

export class AgentRegistry {
  constructor(private readonly store: Store) {}

  upsert(agent: AgentRecord): void {
    const now = this.store.now();
    this.store.db.prepare(`INSERT INTO agents(
      agent_id,display_name,backend_type,agent_type,discord_bot_id,discord_mention,runtime_adapter,available_models_json,status,capabilities_json,current_role,current_project,
      current_task,working_directory,session_id,last_seen,health,health_detail,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET
      display_name=excluded.display_name,backend_type=excluded.backend_type,
      agent_type=COALESCE(excluded.agent_type,agents.agent_type),discord_bot_id=COALESCE(excluded.discord_bot_id,agents.discord_bot_id),
      discord_mention=COALESCE(excluded.discord_mention,agents.discord_mention),runtime_adapter=COALESCE(excluded.runtime_adapter,agents.runtime_adapter),
      available_models_json=COALESCE(excluded.available_models_json,agents.available_models_json),status=excluded.status,
      capabilities_json=excluded.capabilities_json,current_role=excluded.current_role,current_project=excluded.current_project,
      current_task=excluded.current_task,working_directory=excluded.working_directory,session_id=excluded.session_id,
      last_seen=excluded.last_seen,health=excluded.health,health_detail=excluded.health_detail,updated_at=excluded.updated_at`)
      .run(agent.agentId, agent.displayName, agent.backendType, agent.agentType ?? agent.agentId, agent.discordBotId ?? null,
        agent.discordMention ?? (agent.discordBotId ? `<@${agent.discordBotId}>` : null), agent.runtimeAdapter ?? agent.backendType,
        JSON.stringify(agent.availableModels ?? []), agent.status,
        JSON.stringify(agent.capabilities), agent.currentRole ?? null, agent.currentProject ?? null,
        agent.currentTask ?? null, agent.workingDirectory ?? null, agent.sessionId ?? null,
        agent.lastSeen ?? null, agent.health, agent.healthDetail ?? null, now);
  }

  get(agentId: AgentId): AgentRecord | undefined {
    const row = this.store.db.prepare("SELECT * FROM agents WHERE agent_id=?").get(agentId) as Record<string, unknown> | undefined;
    return row ? fromRow(row) : undefined;
  }

  list(): AgentRecord[] {
    return (this.store.db.prepare("SELECT * FROM agents ORDER BY agent_id").all() as Record<string, unknown>[]).map(fromRow);
  }

  setHealth(agentId: AgentId, health: HealthResult): void {
    const status: AgentStatus = health.status === "ONLINE" ? "AVAILABLE" : health.status === "ERROR" ? "ERROR" : "OFFLINE";
    this.store.db.prepare(`UPDATE agents SET health=?,health_detail=?,status=CASE
      WHEN current_task IS NOT NULL AND status='BUSY' AND ?='AVAILABLE' THEN status ELSE ? END,
      last_seen=?,updated_at=? WHERE agent_id=?`)
      .run(health.status, health.detail, status, status, this.store.now(), this.store.now(), agentId);
  }

  bindDiscord(agentId: AgentId, discordBotId: string): void {
    this.store.db.prepare("UPDATE agents SET discord_bot_id=?,discord_mention=?,updated_at=? WHERE agent_id=?")
      .run(discordBotId, `<@${discordBotId}>`, this.store.now(), agentId);
  }

  discordIdentity(agentId: AgentId): { agentId: AgentId; discordBotId: string; discordMention: string } | undefined {
    const agent = this.get(agentId);
    return agent?.discordBotId ? { agentId, discordBotId: agent.discordBotId, discordMention: agent.discordMention || `<@${agent.discordBotId}>` } : undefined;
  }

  markBusy(agentId: AgentId, taskId: string, projectId: string, role: Role, workspace: string): void {
    this.store.db.prepare(`UPDATE agents SET status='BUSY',current_task=?,current_project=?,current_role=?,
      working_directory=?,last_seen=?,updated_at=? WHERE agent_id=?`)
      .run(taskId, projectId, role, workspace, this.store.now(), this.store.now(), agentId);
  }

  release(agentId: AgentId, error = false): void {
    this.store.db.prepare(`UPDATE agents SET status=?,current_task=NULL,current_role=NULL,
      working_directory=NULL,last_seen=?,updated_at=? WHERE agent_id=?`)
      .run(error ? "ERROR" : "AVAILABLE", this.store.now(), this.store.now(), agentId);
  }

  setSession(agentId: AgentId, sessionId: string): void {
    this.store.db.prepare("UPDATE agents SET session_id=?,updated_at=? WHERE agent_id=?").run(sessionId, this.store.now(), agentId);
  }

  choose(role: Role, required: string[]): AgentRecord | undefined {
    return this.list()
      .filter((agent) => agent.status === "AVAILABLE" && agent.health === "ONLINE")
      .filter((agent) => required.every((capability) => agent.capabilities.includes(capability as never)))
      .sort((a, b) => Number(b.currentRole === role) - Number(a.currentRole === role))[0];
  }
}
