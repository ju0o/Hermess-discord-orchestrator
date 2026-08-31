import { randomUUID } from "node:crypto";
import type { AgentId, Role, TaskRecord } from "../domain/types.js";
import { agentToBotType, botTypeToAgent, type BotType, type NativeEventType } from "../discord/control/types.js";
import type { WorkroomManager } from "../discord/workrooms/manager.js";
import type { Store } from "../storage/database.js";
import type { Protocol } from "../tasks/protocol.js";
import type { TaskRepository } from "../tasks/repository.js";

export const MEETING_EVENT_TYPES = [
  "MEETING_INVITE", "CAPABILITY_REPORT", "EXECUTION_PROPOSAL", "RESOURCE_REPORT", "MODEL_PROPOSAL",
  "PARALLEL_PLAN", "DEPENDENCY_REPORT", "BLOCKER", "COUNTER_PROPOSAL", "ROLE_ACCEPT",
] as const;
export type MeetingEventType = (typeof MEETING_EVENT_TYPES)[number];
export type MeetingMemberState = "INVITED" | "PROPOSING" | "ACTIVE" | "WAITING_DEPENDENCY" | "BLOCKED" | "REVIEWING" | "HANDOFF" | "DONE" | "FAILED";
export type MeetingDecisionType = "APPROVE" | "MODIFY" | "REASSIGN" | "DEFER" | "MERGE_SCOPE" | "REJECT_PROPOSAL";

export interface MeetingEventInput {
  taskId: string; eventType: MeetingEventType; sender: "ASUS" | AgentId; recipient: "ASUS" | AgentId;
  body: string; role?: Role; metadata?: Record<string, unknown>;
}

export class EngineeringMeetingService {
  constructor(private readonly store: Store, private readonly tasks: TaskRepository, private readonly workrooms: WorkroomManager, private readonly protocol: Protocol) {}

  async open(task: TaskRecord, recipients: AgentId[], body: string): Promise<{ sessionId: string; eventIds: string[] }> {
    if (!task.threadId || !this.workrooms.get(task.taskId)) throw new Error("MEETING_WORKROOM_REQUIRED");
    if (!body.trim()) throw new Error("MEETING_BODY_REQUIRED");
    const existing = this.session(task.taskId);
    const sessionId = existing?.sessionId || randomUUID();
    const now = this.store.now();
    this.store.db.prepare(`INSERT INTO meeting_sessions(session_id,task_id,thread_id,status,created_at,updated_at)
      VALUES(?,?,?,'OPEN',?,?) ON CONFLICT(task_id) DO UPDATE SET thread_id=excluded.thread_id,status='OPEN',updated_at=excluded.updated_at`).run(sessionId, task.taskId, task.threadId, now, now);
    const eventIds: string[] = [];
    for (const agentId of [...new Set(recipients)]) {
      this.upsertMember(sessionId, agentId, "INVITED", task.role);
      const event = await this.emit({ taskId: task.taskId, eventType: "MEETING_INVITE", sender: "ASUS", recipient: agentId, body, role: task.role,
        metadata: { session_id: sessionId, requested_state: "INVITED", meeting: true } });
      eventIds.push(event.eventId);
    }
    return { sessionId, eventIds };
  }

  async propose(input: MeetingEventInput): Promise<string> {
    if (input.sender === "ASUS") throw new Error("ASUS_PROPOSAL_NOT_AGENT_REPORT");
    const session = this.requireSession(input.taskId); const agentId = input.sender;
    this.upsertMember(session.sessionId, agentId, input.eventType === "BLOCKER" ? "BLOCKED" : "PROPOSING", input.role);
    const event = await this.emit(input, session.sessionId);
    return event.eventId;
  }

  async decide(taskId: string, decision: MeetingDecisionType, body: string, recipients: AgentId[]): Promise<string[]> {
    const session = this.requireSession(taskId); const task = this.tasks.get(taskId); if (!task) throw new Error("UNKNOWN_TASK");
    if (!body.trim()) throw new Error("MEETING_DECISION_BODY_REQUIRED");
    this.store.db.prepare("UPDATE meeting_sessions SET status=?,decision_type=?,decision_body=?,updated_at=? WHERE session_id=?")
      .run(decision === "DEFER" ? "WAITING_DEPENDENCY" : "ACTIVE", decision, body.trim(), this.store.now(), session.sessionId);
    const ids: string[] = [];
    for (const agentId of [...new Set(recipients)]) {
      this.upsertMember(session.sessionId, agentId, decision === "DEFER" ? "WAITING_DEPENDENCY" : "ACTIVE", task.role);
      const event = await this.emit({ taskId, eventType: "EXECUTION_PROPOSAL", sender: "ASUS", recipient: agentId, body,
        role: task.role, metadata: { session_id: session.sessionId, decision, requested_state: decision === "DEFER" ? "WAITING_DEPENDENCY" : "ACTIVE", meeting: true } }, session.sessionId);
      ids.push(event.eventId);
    }
    return ids;
  }

  async accept(taskId: string, agentId: AgentId, body: string, role?: Role): Promise<string> {
    const session = this.requireSession(taskId); this.upsertMember(session.sessionId, agentId, "ACTIVE", role);
    return (await this.emit({ taskId, eventType: "ROLE_ACCEPT", sender: agentId, recipient: "ASUS", body,
      ...(role ? { role } : {}), metadata: { session_id: session.sessionId, state: "ACTIVE", meeting: true } }, session.sessionId)).eventId;
  }

  session(taskId: string): { sessionId: string; taskId: string; threadId: string; status: string; decisionType?: string; decisionBody?: string } | undefined {
    const row = this.store.db.prepare("SELECT session_id,task_id,thread_id,status,decision_type,decision_body FROM meeting_sessions WHERE task_id=?").get(taskId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return { sessionId: String(row.session_id), taskId: String(row.task_id), threadId: String(row.thread_id), status: String(row.status), ...(row.decision_type ? { decisionType: String(row.decision_type) } : {}), ...(row.decision_body ? { decisionBody: String(row.decision_body) } : {}) };
  }

  members(taskId: string): Array<{ agentId: AgentId; state: MeetingMemberState; role?: Role }> {
    const session = this.session(taskId); if (!session) return [];
    return (this.store.db.prepare("SELECT agent_id,state,role FROM meeting_memberships WHERE session_id=? ORDER BY joined_at").all(session.sessionId) as Array<Record<string, unknown>>)
      .map((row) => ({ agentId: String(row.agent_id) as AgentId, state: String(row.state) as MeetingMemberState, ...(row.role ? { role: String(row.role) as Role } : {}) }));
  }

  async processInbound(taskId: string, sender: BotType, eventType: MeetingEventType, body: string, metadata: Record<string, unknown>): Promise<void> {
    const agentId = botTypeToAgent(sender); if (!agentId) return;
    const sessionId = String(metadata.session_id || this.session(taskId)?.sessionId || ""); if (!sessionId) return;
    const state = eventType === "BLOCKER" ? "BLOCKED" : eventType === "ROLE_ACCEPT" ? "ACTIVE" : "PROPOSING";
    this.upsertMember(sessionId, agentId, state, metadata.role as Role | undefined);
  }

  private async emit(input: MeetingEventInput, sessionId = this.requireSession(input.taskId).sessionId) {
    const task = this.tasks.get(input.taskId); if (!task) throw new Error("UNKNOWN_TASK");
    const recipient = input.recipient === "ASUS" ? "ASUS" : agentToBotType(input.recipient);
    const sender = input.sender === "ASUS" ? "ASUS" : agentToBotType(input.sender);
    const event = await this.protocol.emit(input.eventType as NativeEventType, task, sender, recipient, {
      content: input.body.trim(), body: input.body.trim(), role: input.role || task.role, round: task.attempt,
      session_id: sessionId, meeting: true, ...(input.metadata || {}), next_owner: recipient,
    });
    this.store.db.prepare(`INSERT INTO meeting_events(event_id,session_id,task_id,event_type,sender,recipient,body,metadata_json,discord_message_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(event.eventId, sessionId, input.taskId, input.eventType, sender, recipient, input.body.trim(), JSON.stringify(input.metadata || {}), this.store.db.prepare("SELECT discord_message_id FROM protocol_events WHERE event_id=?").get(event.eventId)?.discord_message_id || null, event.createdAt);
    return event;
  }

  private requireSession(taskId: string) { const session = this.session(taskId); if (!session) throw new Error("MEETING_SESSION_REQUIRED"); return session; }
  private upsertMember(sessionId: string, agentId: AgentId, state: MeetingMemberState, role?: Role): void {
    const now = this.store.now(); this.store.db.prepare(`INSERT INTO meeting_memberships(session_id,agent_id,role,state,capability_json,joined_at,updated_at)
      VALUES(?,?,?,?,'{}',?,?) ON CONFLICT(session_id,agent_id) DO UPDATE SET role=COALESCE(excluded.role,meeting_memberships.role),state=excluded.state,updated_at=excluded.updated_at`)
      .run(sessionId, agentId, role || null, state, now, now);
  }
}
