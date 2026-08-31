import type { AgentId, ContextPackage, ExpertRequestRecord, Role, TaskRecord } from "../domain/types.js";
import type { Store } from "../storage/database.js";
import type { ContextResolver } from "./resolver.js";

export class CollaborationContextResolver {
  constructor(private readonly store: Store, private readonly base: ContextResolver) {}

  async discussion(task: TaskRecord, topicId: string, prompt: string, agentId: AgentId, role: Role): Promise<ContextPackage> {
    const context = await this.base.resolve({ ...task, assignedAgent: agentId, role });
    const topic = this.store.db.prepare("SELECT topic FROM discussion_topics WHERE topic_id=? AND task_id=?").get(topicId, task.taskId) as { topic: string } | undefined;
    return { ...context, discord: context.discord.slice(-30), collaboration: { mode: "DISCUSSION", topic: topic?.topic || topicId, prompt,
      history: this.history(task.taskId, topicId) } };
  }

  async expert(task: TaskRecord, request: ExpertRequestRecord): Promise<ContextPackage> {
    if (!request.selectedAgent) throw new Error("EXPERT_NOT_ASSIGNED");
    const scoped = scopeFor(task.fileScope, request.scope); const context = await this.base.resolve({ ...task, assignedAgent: request.selectedAgent, role: request.requestedRole, fileScope: scoped });
    const recent = this.store.db.prepare("SELECT topic_id FROM discussion_topics WHERE task_id=? ORDER BY updated_at DESC LIMIT 3").all(task.taskId) as Array<{ topic_id: string }>;
    return { ...context, discord: context.discord.slice(-30), collaboration: { mode: "EXPERT", history: recent.flatMap((item) => this.history(task.taskId, item.topic_id)).slice(-20),
      expertRequest: { role: request.requestedRole, reason: request.reason, evidence: request.evidence, scope: scoped, requestedBy: request.requestingAgent } } };
  }

  private history(taskId: string, topicId: string) {
    return (this.store.db.prepare(`SELECT event_type,sender_agent,recipient_agent,discussion_round,content FROM discussion_events
      WHERE task_id=? AND topic_id=? ORDER BY discussion_round,created_at`).all(taskId, topicId) as Array<Record<string, unknown>>)
      .map((row) => ({ eventType: String(row.event_type), sender: String(row.sender_agent), recipient: String(row.recipient_agent), round: Number(row.discussion_round), content: String(row.content) }));
  }
}

function scopeFor(taskScope: string[], requested: string[]): string[] {
  if (!requested.length) return [];
  if (!taskScope.length) return [...requested];
  const allowed = requested.filter((item) => taskScope.some((root) => item === root || item.startsWith(`${root}/`) || root.startsWith(`${item}/`)));
  if (allowed.length !== requested.length) throw new Error("EXPERT_SCOPE_OUTSIDE_TASK"); return allowed;
}
