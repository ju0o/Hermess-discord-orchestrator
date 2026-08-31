import { randomUUID, createHash } from "node:crypto";
import type { AgentId, CollaborationEventType, DiscussionEventRecord, DiscussionTopicRecord, ExpertMembershipRecord, ExpertRequestRecord, Role } from "../domain/types.js";
import type { Store } from "../storage/database.js";

export type DiscussionType = Exclude<CollaborationEventType, "EXPERT_REQUEST" | "EXPERT_INVITE" | "EXPERT_RESULT">;

export class CollaborationRepository {
  constructor(private readonly store: Store) {}

  topic(taskId: string, topic: string, createdBy: AgentId): DiscussionTopicRecord {
    const fingerprint = fingerprintText(topic); const existing = this.store.db.prepare("SELECT * FROM discussion_topics WHERE task_id=? AND fingerprint=?").get(taskId, fingerprint) as Record<string, unknown> | undefined;
    if (existing) return rowToTopic(existing);
    const now = this.store.now(); const topicId = randomUUID();
    this.store.db.prepare(`INSERT INTO discussion_topics(topic_id,task_id,topic,fingerprint,status,current_round,created_by,created_at,updated_at)
      VALUES(?,?,?,?,'ACTIVE',0,?,?,?)`).run(topicId, taskId, topic.trim(), fingerprint, createdBy, now, now);
    return this.getTopic(topicId)!;
  }

  getTopic(topicId: string): DiscussionTopicRecord | undefined {
    const row = this.store.db.prepare("SELECT * FROM discussion_topics WHERE topic_id=?").get(topicId) as Record<string, unknown> | undefined;
    return row ? rowToTopic(row) : undefined;
  }

  topics(taskId: string): DiscussionTopicRecord[] {
    return (this.store.db.prepare("SELECT * FROM discussion_topics WHERE task_id=? ORDER BY created_at").all(taskId) as Record<string, unknown>[]).map(rowToTopic);
  }

  addEvent(input: Omit<DiscussionEventRecord, "eventId" | "status" | "fingerprint" | "createdAt"> & { eventId?: string; status?: DiscussionEventRecord["status"]; discordMessageId?: string }): DiscussionEventRecord {
    const eventId = input.eventId || randomUUID(); const fingerprint = fingerprintText(input.content); const createdAt = this.store.now();
    try {
      this.store.db.prepare(`INSERT INTO discussion_events(event_id,task_id,topic_id,event_type,sender_agent,recipient_agent,sender_role,recipient_role,
        discussion_round,parent_event_id,content,next_owner,status,fingerprint,discord_message_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(eventId, input.taskId, input.topicId, input.eventType, input.senderAgent, input.recipientAgent, input.senderRole, input.recipientRole,
          input.round, input.parentEventId || null, input.content, input.nextOwner, input.status || "CREATED", fingerprint, input.discordMessageId || null, createdAt);
    } catch (error) { if (String(error).includes("UNIQUE")) throw new Error("DISCUSSION_DUPLICATE"); throw error; }
    this.store.db.prepare("UPDATE discussion_topics SET current_round=MAX(current_round,?),updated_at=? WHERE topic_id=?").run(input.round, createdAt, input.topicId);
    return this.event(eventId)!;
  }

  event(eventId: string): DiscussionEventRecord | undefined {
    const row = this.store.db.prepare("SELECT * FROM discussion_events WHERE event_id=?").get(eventId) as Record<string, unknown> | undefined;
    return row ? rowToEvent(row) : undefined;
  }

  events(topicId: string): DiscussionEventRecord[] {
    return (this.store.db.prepare("SELECT * FROM discussion_events WHERE topic_id=? ORDER BY discussion_round,created_at").all(topicId) as Record<string, unknown>[]).map(rowToEvent);
  }

  hasEventFingerprint(topicId: string, type: DiscussionType, sender: AgentId, recipient: AgentId, content: string): boolean {
    return Boolean(this.store.db.prepare(`SELECT 1 FROM discussion_events WHERE topic_id=? AND event_type=? AND sender_agent=? AND recipient_agent=? AND fingerprint=?`)
      .get(topicId, type, sender, recipient, fingerprintText(content)));
  }

  markEvent(eventId: string, status: DiscussionEventRecord["status"], discordMessageId?: string): void {
    this.store.db.prepare("UPDATE discussion_events SET status=?,discord_message_id=COALESCE(?,discord_message_id) WHERE event_id=?")
      .run(status, discordMessageId || null, eventId);
  }

  closeTopic(topicId: string, status: Extract<DiscussionTopicRecord["status"], "CONSENSUS" | "LIMIT_REACHED" | "ESCALATED">, consensus?: string): void {
    this.store.db.prepare("UPDATE discussion_topics SET status=?,consensus=?,updated_at=? WHERE topic_id=?").run(status, consensus || null, this.store.now(), topicId);
  }

  createExpertRequest(input: Omit<ExpertRequestRecord, "requestId" | "status" | "createdAt" | "updatedAt">): ExpertRequestRecord {
    const requestId = randomUUID(); const now = this.store.now();
    this.store.db.prepare(`INSERT INTO expert_requests(request_id,task_id,requested_role,requested_capabilities_json,reason,evidence_json,requesting_agent,
      urgency,scope_json,status,selected_agent,selected_tier,selected_model,provider,return_role_sequence,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,'REQUESTED',?,?,?,?,?,?,?)`).run(requestId, input.taskId, input.requestedRole, JSON.stringify(input.requestedCapabilities),
        input.reason, JSON.stringify(input.evidence), input.requestingAgent, input.urgency, JSON.stringify(input.scope), input.selectedAgent || null,
        input.selectedTier || null, input.selectedModel || null, input.provider || null, input.returnRoleSequence ?? null, now, now);
    return this.expertRequest(requestId)!;
  }

  expertRequest(requestId: string): ExpertRequestRecord | undefined {
    const row = this.store.db.prepare("SELECT * FROM expert_requests WHERE request_id=?").get(requestId) as Record<string, unknown> | undefined;
    return row ? rowToExpertRequest(row) : undefined;
  }

  updateExpertRequest(requestId: string, patch: Partial<Pick<ExpertRequestRecord, "status" | "selectedAgent" | "selectedTier" | "selectedModel" | "provider">>): ExpertRequestRecord {
    const current = this.expertRequest(requestId); if (!current) throw new Error("EXPERT_REQUEST_NOT_FOUND");
    this.store.db.prepare(`UPDATE expert_requests SET status=?,selected_agent=?,selected_tier=?,selected_model=?,provider=?,updated_at=? WHERE request_id=?`)
      .run(patch.status || current.status, patch.selectedAgent || current.selectedAgent || null, patch.selectedTier || current.selectedTier || null,
        patch.selectedModel || current.selectedModel || null, patch.provider || current.provider || null, this.store.now(), requestId);
    return this.expertRequest(requestId)!;
  }

  addMembership(request: ExpertRequestRecord, agentId: AgentId): ExpertMembershipRecord {
    const now = this.store.now();
    try { this.store.db.prepare(`INSERT INTO expert_memberships(task_id,role,agent_id,request_id,status,joined_at,join_reason,requested_by,scope_json)
      VALUES(?,?,?,?,'INVITED',?,?,?,?)`).run(request.taskId, request.requestedRole, agentId, request.requestId, now, request.reason, request.requestingAgent, JSON.stringify(request.scope)); }
    catch (error) { if (String(error).includes("UNIQUE")) throw new Error("EXPERT_DUPLICATE"); throw error; }
    return this.membership(request.taskId, request.requestedRole)!;
  }

  membership(taskId: string, role: Role): ExpertMembershipRecord | undefined {
    const row = this.store.db.prepare("SELECT * FROM expert_memberships WHERE task_id=? AND role=?").get(taskId, role) as Record<string, unknown> | undefined;
    return row ? rowToMembership(row) : undefined;
  }

  memberships(taskId: string): ExpertMembershipRecord[] {
    return (this.store.db.prepare("SELECT * FROM expert_memberships WHERE task_id=? ORDER BY joined_at").all(taskId) as Record<string, unknown>[]).map(rowToMembership);
  }

  updateMembership(taskId: string, role: Role, status: ExpertMembershipRecord["status"]): ExpertMembershipRecord {
    this.store.db.prepare("UPDATE expert_memberships SET status=?,completed_at=CASE WHEN ? IN ('PASS','FAIL','BLOCKED') THEN ? ELSE completed_at END WHERE task_id=? AND role=?")
      .run(status, status, this.store.now(), taskId, role); return this.membership(taskId, role)!;
  }
}

export function fingerprintText(value: string): string {
  const normalized = value.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
  return createHash("sha256").update(normalized).digest("hex");
}
function rowToTopic(row: Record<string, unknown>): DiscussionTopicRecord { return { topicId: String(row.topic_id), taskId: String(row.task_id), topic: String(row.topic), fingerprint: String(row.fingerprint), status: row.status as DiscussionTopicRecord["status"], currentRound: Number(row.current_round), createdBy: row.created_by as AgentId, ...(row.consensus ? { consensus: String(row.consensus) } : {}), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }; }
function rowToEvent(row: Record<string, unknown>): DiscussionEventRecord { return { eventId: String(row.event_id), taskId: String(row.task_id), topicId: String(row.topic_id), eventType: row.event_type as DiscussionEventRecord["eventType"], senderAgent: row.sender_agent as AgentId, recipientAgent: row.recipient_agent as AgentId, senderRole: row.sender_role as Role, recipientRole: row.recipient_role as Role, round: Number(row.discussion_round), ...(row.parent_event_id ? { parentEventId: String(row.parent_event_id) } : {}), content: String(row.content), nextOwner: String(row.next_owner), status: row.status as DiscussionEventRecord["status"], fingerprint: String(row.fingerprint), ...(row.discord_message_id ? { discordMessageId: String(row.discord_message_id) } : {}), createdAt: String(row.created_at) }; }
function rowToExpertRequest(row: Record<string, unknown>): ExpertRequestRecord { return { requestId: String(row.request_id), taskId: String(row.task_id), requestedRole: row.requested_role as Role, requestedCapabilities: JSON.parse(String(row.requested_capabilities_json)), reason: String(row.reason), evidence: JSON.parse(String(row.evidence_json)), requestingAgent: row.requesting_agent as AgentId, urgency: row.urgency as ExpertRequestRecord["urgency"], scope: JSON.parse(String(row.scope_json)), status: row.status as ExpertRequestRecord["status"], ...(row.selected_agent ? { selectedAgent: row.selected_agent as AgentId } : {}), ...(row.selected_tier ? { selectedTier: row.selected_tier as NonNullable<ExpertRequestRecord["selectedTier"]> } : {}), ...(row.selected_model ? { selectedModel: String(row.selected_model) } : {}), ...(row.provider ? { provider: String(row.provider) } : {}), ...(row.return_role_sequence !== null ? { returnRoleSequence: Number(row.return_role_sequence) } : {}), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }; }
function rowToMembership(row: Record<string, unknown>): ExpertMembershipRecord { return { taskId: String(row.task_id), role: row.role as Role, agentId: row.agent_id as AgentId, requestId: String(row.request_id), status: row.status as ExpertMembershipRecord["status"], joinedAt: String(row.joined_at), joinReason: String(row.join_reason), requestedBy: row.requested_by as AgentId, scope: JSON.parse(String(row.scope_json)), ...(row.completed_at ? { completedAt: String(row.completed_at) } : {}) }; }
