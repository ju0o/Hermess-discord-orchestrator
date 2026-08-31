import type { AgentAdapter } from "../agents/adapter.js";
import type { CollaborationContextResolver } from "../context/collaboration.js";
import { COLLABORATION_EVENT_TYPES, type AgentId, type Capability, type DiscussionEventRecord, type ExpertRequestRecord, type Role, type TaskRecord } from "../domain/types.js";
import { agentToBotType, botTypeToAgent, type NativeEnvelope } from "../discord/control/types.js";
import type { WorkroomManager } from "../discord/workrooms/manager.js";
import type { ModelRouter } from "../models/router.js";
import type { AgentRegistry } from "../registry/agentRegistry.js";
import { ROLE_CAPABILITIES } from "../registry/roleRegistry.js";
import type { AgentRouter } from "../routing/agentRouter.js";
import { requiresHumanGate } from "../security/humanGate.js";
import type { Store } from "../storage/database.js";
import type { WorkspaceLocks } from "../tasks/locks.js";
import type { Protocol } from "../tasks/protocol.js";
import type { TaskRepository } from "../tasks/repository.js";
import { canTransition } from "../tasks/stateMachine.js";
import type { TeamRepository } from "../teams/repository.js";
import { CollaborationRepository, type DiscussionType } from "./repository.js";

const ACTIVE_TASKS = new Set(["DISPATCHED", "CLAIMED", "RUNNING", "WAITING_RESULT", "REVIEWING", "BLOCKED", "WAITING_MAIN"]);
const DISCUSSION_TYPES = new Set<DiscussionType>(["QUESTION", "ANSWER", "PROPOSAL", "OBJECTION", "CLARIFICATION", "CONSENSUS"]);

export interface DiscussionInput {
  taskId: string; type: DiscussionType; senderAgent: AgentId; recipientAgent?: AgentId; recipientRole?: Role;
  topic: string; content: string; parentEventId?: string;
}
export interface ExpertRequestInput {
  taskId: string; requestingAgent: AgentId; requestedRole: Role; requestedCapabilities?: Capability[];
  reason: string; evidence?: string[]; urgency?: "LOW" | "NORMAL" | "HIGH"; scope?: string[];
}

export class CollaborationService {
  readonly repository: CollaborationRepository;
  constructor(private readonly store: Store, private readonly tasks: TaskRepository, private readonly teams: TeamRepository,
    private readonly agents: AgentRegistry, private readonly agentRouter: AgentRouter, private readonly modelRouter: ModelRouter,
    private readonly protocol: Protocol, private readonly workrooms: WorkroomManager, private readonly context: CollaborationContextResolver,
    private readonly locks: WorkspaceLocks, private readonly adapters: Map<AgentId, AgentAdapter>, private readonly maxRounds: number) {
    this.repository = new CollaborationRepository(store);
  }

  async discuss(input: DiscussionInput): Promise<DiscussionEventRecord> {
    const task = this.activeTask(input.taskId); this.requireWorkroom(task); this.guardAuthority(task, input.content);
    const senderRole = this.memberRole(task.taskId, input.senderAgent); if (!senderRole) throw new Error("TEAM_MEMBERSHIP_REQUIRED");
    const recipient = this.resolveRecipient(task, input.recipientAgent, input.recipientRole); if (!recipient) throw new Error("DISCUSSION_RECIPIENT_UNAVAILABLE");
    if (recipient.agentId === input.senderAgent) throw new Error("SELF_MESSAGE");
    const topic = this.repository.topic(task.taskId, input.topic, input.senderAgent);
    if (topic.status === "CONSENSUS") throw new Error("DISCUSSION_CLOSED");
    if (this.repository.hasEventFingerprint(topic.topicId, input.type, input.senderAgent, recipient.agentId, input.content)) throw new Error("DISCUSSION_DUPLICATE");
    const round = topic.currentRound + 1;
    if (round > this.maxRounds) { await this.escalateDisagreement(task, topic.topicId); throw new Error("DISCUSSION_LIMIT_REACHED"); }
    const event = this.repository.addEvent({ taskId: task.taskId, topicId: topic.topicId, eventType: input.type, senderAgent: input.senderAgent,
      recipientAgent: recipient.agentId, senderRole, recipientRole: recipient.role, round, ...(input.parentEventId ? { parentEventId: input.parentEventId } : {}),
      content: input.content.trim(), nextOwner: agentToBotType(recipient.agentId) });
    const emitted = await this.protocol.emit(input.type, task, input.senderAgent, agentToBotType(recipient.agentId), {
      discussion_event_id: event.eventId, topic_id: topic.topicId, discussion_topic: topic.topic, sender_role: senderRole,
      recipient_role: recipient.role, content: event.content, next_owner: agentToBotType(recipient.agentId), round,
      ...(input.parentEventId ? { parent_event_id: input.parentEventId } : {}), status: input.type === "CONSENSUS" ? "CONSENSUS" : "ACTIVE",
    });
    const message = this.store.db.prepare("SELECT discord_message_id FROM protocol_events WHERE event_id=?").get(emitted.eventId) as { discord_message_id?: string } | undefined;
    this.repository.markEvent(event.eventId, "SENT", message?.discord_message_id);
    if (input.type === "CONSENSUS") this.repository.closeTopic(topic.topicId, "CONSENSUS", input.content);
    return this.repository.event(event.eventId)!;
  }

  async requestExpert(input: ExpertRequestInput, options: { announceRequest?: boolean } = {}): Promise<ExpertRequestRecord> {
    const task = this.activeTask(input.taskId); this.requireWorkroom(task); this.guardAuthority(task, `${input.reason} ${(input.scope || []).join(" ")}`);
    if (!this.memberRole(task.taskId, input.requestingAgent)) throw new Error("TEAM_MEMBERSHIP_REQUIRED");
    const capabilities = input.requestedCapabilities?.length ? input.requestedCapabilities : ROLE_CAPABILITIES[input.requestedRole];
    const request = this.repository.createExpertRequest({ taskId: task.taskId, requestedRole: input.requestedRole, requestedCapabilities: capabilities,
      reason: input.reason, evidence: input.evidence || [], requestingAgent: input.requestingAgent, urgency: input.urgency || "NORMAL", scope: input.scope || [],
      ...(task.currentRoleSequence ? { returnRoleSequence: task.currentRoleSequence } : {}) });
    const existingRole = this.findRoleMember(task.taskId, input.requestedRole);
    const existingCapability = this.teamMembers(task.taskId).find((member) => capabilities.every((cap) => this.agents.get(member.agentId)?.capabilities.includes(cap)));
    if (existingRole || existingCapability) return this.repository.updateExpertRequest(request.requestId, { status: "NOT_NEEDED", selectedAgent: (existingRole || existingCapability)!.agentId });
    if (this.repository.membership(task.taskId, input.requestedRole)) return this.repository.updateExpertRequest(request.requestId, { status: "NOT_NEEDED" });
    const prior = Object.fromEntries(this.teamMembers(task.taskId).map((item) => [item.role, item.agentId])) as Partial<Record<Role, AgentId>>;
    const decision = this.agentRouter.route(task, input.requestedRole, prior);
    if (!decision.selectedAgent) {
      const unavailable = this.repository.updateExpertRequest(request.requestId, { status: "UNAVAILABLE" });
      if (canTransition(task.status, "WAITING_MAIN")) this.tasks.transition(task.taskId, "WAITING_MAIN", { result: "EXPERT_UNAVAILABLE" });
      await this.protocol.emit("HANDOFF", this.tasks.get(task.taskId)!, "ORCHESTRATOR", "ASUS", { status: "EXPERT_UNAVAILABLE", requested_role: input.requestedRole, reason: input.reason });
      return unavailable;
    }
    const model = this.modelRouter.route(task, input.requestedRole, decision.selectedAgent);
    if (model.status !== "SELECTED" || !model.requestedModel) {
      const blocked = this.repository.updateExpertRequest(request.requestId, { status: "BLOCKED", selectedAgent: decision.selectedAgent });
      if (canTransition(task.status, "WAITING_MAIN")) this.tasks.transition(task.taskId, "WAITING_MAIN", { result: "MODEL_ROUTING_BLOCKED" }); return blocked;
    }
    const selected = this.repository.updateExpertRequest(request.requestId, { status: "INVITED", selectedAgent: decision.selectedAgent,
      ...(model.selectedTier ? { selectedTier: model.selectedTier } : {}), selectedModel: model.requestedModel, ...(model.provider ? { provider: model.provider } : {}) });
    this.repository.addMembership(selected, decision.selectedAgent);
    if (options.announceRequest !== false) await this.protocol.emit("EXPERT_REQUEST", task, input.requestingAgent, "ASUS", { request_id: selected.requestId, requested_role: input.requestedRole,
      requested_capabilities: capabilities, reason: input.reason, evidence: input.evidence || [], urgency: input.urgency || "NORMAL", scope: input.scope || [],
      requesting_agent: input.requestingAgent, status: "ROUTED", round: 0 });
    await this.workrooms.publishExpertJoin(task, selected);
    await this.protocol.emit("EXPERT_INVITE", task, "ORCHESTRATOR", agentToBotType(decision.selectedAgent), { request_id: selected.requestId,
      requested_role: input.requestedRole, role: input.requestedRole, reason: input.reason, scope: input.scope || [], requested_by: input.requestingAgent,
      model_tier: model.selectedTier, model: model.requestedModel, status: "INVITED", round: 0 });
    return selected;
  }

  async acknowledgeExpert(requestId: string): Promise<ExpertRequestRecord> {
    const request = this.requireRequest(requestId); if (!request.selectedAgent) throw new Error("EXPERT_NOT_ASSIGNED");
    const task = this.activeTask(request.taskId); this.repository.updateMembership(task.taskId, request.requestedRole, "ACTIVE");
    // Expert ACK is an internal membership transition. WorkerRuntime emits the
    // certifiable ACK only after the real Worker execution contract runs.
    return this.repository.updateExpertRequest(requestId, { status: "ACTIVE" });
  }

  async completeExpert(requestId: string, status: "PASS" | "FAIL" | "BLOCKED", result: { findings?: string[]; changes?: string[]; evidence?: string[]; recommendation?: string } = {}): Promise<ExpertRequestRecord> {
    const request = this.requireRequest(requestId); if (!request.selectedAgent) throw new Error("EXPERT_NOT_ASSIGNED"); const task = this.activeTask(request.taskId);
    void result;
    // Caller-supplied expert findings are not Worker evidence. The inbound
    // WorkerRuntime path owns EXPERT_RESULT publication and provenance.
    this.repository.updateMembership(task.taskId, request.requestedRole, status);
    const completed = this.repository.updateExpertRequest(requestId, { status });
    this.agents.release(request.selectedAgent, status !== "PASS"); return completed;
  }

  async executeExpert(requestId: string): Promise<ExpertRequestRecord> {
    const request = this.requireRequest(requestId); if (!request.selectedAgent || !request.selectedModel) throw new Error("EXPERT_NOT_ASSIGNED");
    if (request.scope.some((item) => !this.activeTask(request.taskId).fileScope.some((allowed) => item === allowed || item.startsWith(`${allowed}/`) || allowed.endsWith("/**"))))
      throw new Error("EXPERT_SCOPE_OUTSIDE_TASK");
    throw new Error("WORKER_RUNTIME_OWNS_EXECUTION");
  }

  async processInbound(envelope: NativeEnvelope): Promise<void> {
    if (envelope.event_type === "ACK" && envelope.payload.expert === true && envelope.payload.request_id) {
      const request = this.repository.expertRequest(String(envelope.payload.request_id)); const sender = botTypeToAgent(envelope.sender);
      if (request?.selectedAgent && sender === request.selectedAgent) { this.repository.updateMembership(request.taskId, request.requestedRole, "ACTIVE"); this.repository.updateExpertRequest(request.requestId, { status: "ACTIVE" }); } return;
    }
    if (!COLLABORATION_EVENT_TYPES.includes(envelope.event_type as never)) return;
    const sender = botTypeToAgent(envelope.sender); const recipient = botTypeToAgent(envelope.recipient);
    if (envelope.event_type === "EXPERT_REQUEST") {
      if (!sender) throw new Error("TEAM_MEMBERSHIP_REQUIRED"); const role = String(envelope.payload.requested_role || envelope.role || "").toUpperCase() as Role;
      if (!ROLE_CAPABILITIES[role]) throw new Error("INVALID_EXPERT_ROLE");
      await this.requestExpert({ taskId: envelope.task_id, requestingAgent: sender, requestedRole: role,
        requestedCapabilities: Array.isArray(envelope.payload.requested_capabilities) ? envelope.payload.requested_capabilities as Capability[] : ROLE_CAPABILITIES[role],
        reason: String(envelope.payload.reason || "Expertise requested by Team Agent"), evidence: Array.isArray(envelope.payload.evidence) ? envelope.payload.evidence.map(String) : [],
        urgency: ["LOW", "NORMAL", "HIGH"].includes(String(envelope.payload.urgency)) ? String(envelope.payload.urgency) as NonNullable<ExpertRequestInput["urgency"]> : "NORMAL",
        scope: Array.isArray(envelope.payload.scope) ? envelope.payload.scope.map(String) : [] }, { announceRequest: false }); return;
    }
    if (envelope.event_type === "EXPERT_RESULT") {
      const request = this.repository.expertRequest(String(envelope.payload.request_id || ""));
      if (!request || !sender || request.selectedAgent !== sender) throw new Error("EXPERT_RESULT_SENDER_MISMATCH");
      const status = String(envelope.payload.status || "BLOCKED") as "PASS" | "FAIL" | "BLOCKED";
      if (!["PASS", "FAIL", "BLOCKED"].includes(status)) throw new Error("INVALID_EXPERT_RESULT");
      this.repository.updateMembership(request.taskId, request.requestedRole, status); this.repository.updateExpertRequest(request.requestId, { status }); this.agents.release(sender, status !== "PASS"); return;
    }
    if (DISCUSSION_TYPES.has(envelope.event_type as DiscussionType)) {
      if (!sender || !recipient) throw new Error("TEAM_MEMBERSHIP_REQUIRED"); const task = this.activeTask(envelope.task_id); this.requireWorkroom(task);
      this.guardAuthority(task, String(envelope.payload.content || "")); const topicId = String(envelope.topic_id || envelope.payload.topic_id || "");
      const eventId = String(envelope.payload.discussion_event_id || `inbound:${envelope.message_id}`); const existing = this.repository.event(eventId);
      if (existing) { this.repository.markEvent(eventId, "PROCESSED", envelope.message_id); if (envelope.event_type === "CONSENSUS") this.repository.closeTopic(topicId, "CONSENSUS", String(envelope.payload.content || "")); return; }
      const senderRole = this.memberRole(task.taskId, sender); const recipientRole = this.memberRole(task.taskId, recipient);
      if (!senderRole || !recipientRole) throw new Error("TEAM_MEMBERSHIP_REQUIRED"); const topic = this.repository.getTopic(topicId) || this.repository.topic(task.taskId, String(envelope.discussion_topic || envelope.payload.discussion_topic || topicId), sender);
      this.repository.addEvent({ eventId, taskId: task.taskId, topicId: topic.topicId, eventType: envelope.event_type as DiscussionType, senderAgent: sender,
        recipientAgent: recipient, senderRole, recipientRole, round: envelope.round, content: String(envelope.payload.content || ""), nextOwner: envelope.recipient,
        status: "PROCESSED", discordMessageId: envelope.message_id });
      if (envelope.event_type === "CONSENSUS") this.repository.closeTopic(topic.topicId, "CONSENSUS", String(envelope.payload.content || ""));
    }
  }

  recover(): { activeTopics: number; activeExperts: number } {
    const activeTopics = Number((this.store.db.prepare("SELECT count(*) n FROM discussion_topics WHERE status='ACTIVE'").get() as { n: number }).n);
    const activeExperts = Number((this.store.db.prepare("SELECT count(*) n FROM expert_memberships WHERE status IN ('INVITED','ACTIVE')").get() as { n: number }).n);
    this.store.upsertRuntimeState("collaboration:last_recovery", { activeTopics, activeExperts, at: this.store.now() }); return { activeTopics, activeExperts };
  }

  private async escalateDisagreement(task: TaskRecord, topicId: string): Promise<void> {
    const topic = this.repository.getTopic(topicId)!; const events = this.repository.events(topicId); this.repository.closeTopic(topicId, "LIMIT_REACHED");
    const positions = events.slice(-2).map((event) => ({ agent: event.senderAgent, position: event.content.slice(0, 300) }));
    await this.protocol.emit("HANDOFF", task, "ORCHESTRATOR", "ASUS", { status: "AGENT_DISAGREEMENT", issue: topic.topic,
      positions, evidence: events.flatMap((event) => [event.content]).slice(-3), unresolved_decision: "Discussion limit reached", round: this.maxRounds });
    this.repository.closeTopic(topicId, "ESCALATED");
  }

  private activeTask(taskId: string): TaskRecord { const task = this.tasks.get(taskId); if (!task || !ACTIVE_TASKS.has(task.status)) throw new Error("UNKNOWN_OR_INACTIVE_TASK"); return task; }
  private requireWorkroom(task: TaskRecord): void { const workroom = this.workrooms.get(task.taskId); if (!task.threadId || !workroom || workroom.threadId !== task.threadId || workroom.state !== "ACTIVE") throw new Error("WORKROOM_REQUIRED"); }
  private teamMembers(taskId: string): Array<{ role: Role; agentId: AgentId }> { return [...this.teams.roles(taskId).filter((item) => item.assignedAgent).map((item) => ({ role: item.role, agentId: item.assignedAgent! })),
    ...this.repository.memberships(taskId).filter((item) => ["INVITED", "ACTIVE"].includes(item.status)).map((item) => ({ role: item.role, agentId: item.agentId }))]; }
  private memberRole(taskId: string, agentId: AgentId): Role | undefined { return this.teamMembers(taskId).find((item) => item.agentId === agentId)?.role; }
  private findRoleMember(taskId: string, role: Role) { return this.teamMembers(taskId).find((item) => item.role === role); }
  private resolveRecipient(task: TaskRecord, agentId?: AgentId, role?: Role): { role: Role; agentId: AgentId } | undefined {
    if (agentId) return this.teamMembers(task.taskId).find((item) => item.agentId === agentId && (!role || item.role === role));
    if (role) return this.findRoleMember(task.taskId, role); return undefined;
  }
  private guardAuthority(task: TaskRecord, text: string): void { const gate = requiresHumanGate(text); if (!gate.required) return;
    if (canTransition(task.status, "HUMAN_GATE")) this.tasks.transition(task.taskId, "HUMAN_GATE", { ...(gate.reason ? { result: gate.reason } : {}) }); throw new Error("HUMAN_GATE_REQUIRED"); }
  private requireRequest(requestId: string): ExpertRequestRecord { const request = this.repository.expertRequest(requestId); if (!request) throw new Error("EXPERT_REQUEST_NOT_FOUND"); return request; }
}
