import type { Role } from "../../domain/types.js";
import type { Store } from "../../storage/database.js";
import type { TrustedBotRegistry } from "./trustedBotRegistry.js";
import { createHash } from "node:crypto";
import { ackIdentityMatches, botTypeToAgent, type BotType, type InboundReasonCode, type NativeEnvelope } from "./types.js";
import { EnvelopeFragmentBuffer } from "./fragmentBuffer.js";

export interface InboundInput {
  messageId: string; authorId: string; authorBot: boolean; currentBotId: string; currentIdentity: BotType;
  mentionIds: string[]; content: string; channelId: string; threadId?: string; createdAt: string;
}
export interface InboundDecision { allowed: boolean; reason: InboundReasonCode; envelope?: NativeEnvelope; human?: boolean; }

export class InboundGuard {
  private readonly fragments = new EnvelopeFragmentBuffer();
  constructor(private readonly store: Store, private readonly bots: TrustedBotRegistry, private readonly maxRounds: number) {}

  evaluate(input: InboundInput): InboundDecision {
    if (!input.authorBot) return { allowed: true, reason: "HUMAN_MESSAGE", human: true };
    if (input.authorId === input.currentBotId) return { allowed: false, reason: "SELF_MESSAGE" };
    const sender = this.bots.byDiscordId(input.authorId); if (!sender) return { allowed: false, reason: "UNTRUSTED_BOT" };
    if (!input.mentionIds.includes(input.currentBotId)) return { allowed: false, reason: "MENTION_REQUIRED" };
    const ingested = this.fragments.ingest(input.content, input.authorId,
      { messageId: input.messageId, ...(input.threadId ? { threadId: input.threadId } : {}), createdAt: input.createdAt });
    if (ingested.status === "PENDING") return { allowed: false, reason: "FRAGMENT_PENDING" };
    if (ingested.status !== "COMPLETE") return { allowed: false, reason: "INVALID_EVENT" };
    const envelope = ingested.envelope;
    const recipient = this.bots.resolveRecipient(envelope.recipient, false);
    if (!recipient?.discordBotId || recipient.discordBotId !== input.currentBotId || envelope.sender !== sender.botType || envelope.recipient !== input.currentIdentity)
      return { allowed: false, reason: "UNKNOWN_RECIPIENT" };
    if (!this.store.db.prepare("SELECT 1 FROM tasks WHERE task_id=?").get(envelope.task_id)) return { allowed: false, reason: "UNKNOWN_TASK", envelope };
    const taskRow = this.store.db.prepare("SELECT thread_id FROM tasks WHERE task_id=?").get(envelope.task_id) as { thread_id: string | null };
    if (["ACK", "RESULT", "REVIEW", "QA_RESULT", "HANDOFF", "REVISION_REQUEST", "REVISION_RESULT"].includes(envelope.event_type)) {
      if (taskRow.thread_id && (!input.threadId || input.threadId !== taskRow.thread_id || envelope.thread_id !== taskRow.thread_id))
        return { allowed: false, reason: "TASK_THREAD_REQUIRED", envelope };
    }
    if (envelope.event_type === "ACK") {
      const claimedBy = envelope.payload.claimed_by || envelope.payload.agent_id;
      if (!ackIdentityMatches(sender.botType, claimedBy, envelope.role, envelope.status || envelope.payload.status))
        return { allowed: false, reason: "ACK_IDENTITY_MISMATCH", envelope };
    }
    if (isCollaboration(envelope.event_type)) {
      const task = taskRow;
      if (task.thread_id && (!input.threadId || input.threadId !== task.thread_id || envelope.thread_id !== task.thread_id))
        return { allowed: false, reason: "WRONG_WORKROOM", envelope };
      if (!collaborationMembersAllowed(this.store, envelope)) return { allowed: false, reason: "TEAM_MEMBERSHIP_REQUIRED", envelope };
      if (["QUESTION", "ANSWER", "PROPOSAL", "OBJECTION", "CLARIFICATION", "CONSENSUS"].includes(envelope.event_type) && envelope.round < 1)
        return { allowed: false, reason: "INVALID_EVENT", envelope };
    }
    if (isMeeting(envelope.event_type)) {
      if (taskRow.thread_id && (!input.threadId || input.threadId !== taskRow.thread_id || envelope.thread_id !== taskRow.thread_id))
        return { allowed: false, reason: "WRONG_WORKROOM", envelope };
      if (!meetingMembersAllowed(this.store, envelope)) return { allowed: false, reason: "TEAM_MEMBERSHIP_REQUIRED", envelope };
    }
    // Role revision rounds are durable execution lineage, not the bounded
    // human/agent discussion loop.  A recovered Task may legitimately be on
    // revision round 4+; WorkerContract still requires the exact Role round.
    // Keep the global loop guard for collaboration topics, where it is the
    // actual anti-loop authority.
    if (isCollaboration(envelope.event_type) && envelope.round > this.maxRounds) {
      this.store.upsertRuntimeState("discord:last_loop_guard", {
        message_id: input.messageId, task_id: envelope.task_id, branch: "ROUND_LIMIT",
        round: envelope.round, max_rounds: this.maxRounds, dispatch_id: envelope.payload.dispatch_id || null, at: this.store.now(),
      });
      return { allowed: false, reason: "LOOP_GUARD", envelope };
    }
    if (!roleAllowed(envelope.event_type, envelope.role)) return { allowed: false, reason: "ROLE_DENIED", envelope };
    if (this.store.db.prepare("SELECT 1 FROM inbound_messages WHERE discord_message_id=?").get(input.messageId)) return { allowed: false, reason: "DUPLICATE_MESSAGE", envelope };
    const logicalKey = logicalKeyFor(envelope);
    const duplicateLogical = this.store.db.prepare("SELECT discord_message_id,state FROM inbound_messages WHERE logical_key=? AND state IN ('RECEIVED','PROCESSED') LIMIT 1").get(logicalKey) as { discord_message_id: string; state: string } | undefined;
    if (duplicateLogical) {
      const taskState = this.store.db.prepare("SELECT status FROM tasks WHERE task_id=?").get(envelope.task_id) as { status: string } | undefined;
      const roles = this.store.db.prepare("SELECT status FROM task_roles WHERE task_id=?").all(envelope.task_id) as Array<{ status: string }>;
      const teamBlocked = roles.some((r) => r.status === "BLOCKED");
      const durableRecovery = taskState?.status === "WAITING_MAIN" || teamBlocked;
      if (durableRecovery) {
        this.store.db.prepare("UPDATE inbound_messages SET state='SUPERSEDED', reason_code='DURABLE_RECOVERY_SUPERSEDED', processed_at=? WHERE logical_key=? AND state IN ('RECEIVED','PROCESSED')").run(this.store.now(), logicalKey);
        this.store.upsertRuntimeState("recovery:logical_superseded", { taskId: envelope.task_id, logicalKey, prevMessageId: duplicateLogical.discord_message_id, newMessageId: input.messageId, at: this.store.now() });
      } else {
        this.store.upsertRuntimeState("discord:last_loop_guard", {
          message_id: input.messageId, task_id: envelope.task_id, branch: "LOGICAL_KEY_DUPLICATE",
          logical_key: logicalKey, existing_message_id: duplicateLogical.discord_message_id, existing_state: duplicateLogical.state,
          round: envelope.round, dispatch_id: envelope.payload.dispatch_id || null, at: this.store.now(),
        });
        return { allowed: false, reason: "LOOP_GUARD", envelope };
      }
    }
    return { allowed: true, reason: "ALLOW", envelope };
  }

  claim(input: InboundInput, decision: InboundDecision): InboundDecision {
    if (!decision.allowed || !decision.envelope) return decision;
    try {
      const envelope = decision.envelope; const now = this.store.now();
      this.store.db.prepare(`INSERT INTO inbound_messages(discord_message_id,task_id,event_type,sender,recipient,role,status,next_owner,
        discussion_round,thread_id,channel_id,logical_key,envelope_json,state,reason_code,received_at,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'RECEIVED','ALLOW',?,?)`)
        .run(input.messageId, envelope.task_id, envelope.event_type, envelope.sender, envelope.recipient, envelope.role ?? null,
          envelope.status ?? null, envelope.next_owner ?? null, envelope.round, input.threadId ?? null, input.channelId,
          logicalKeyFor(envelope), JSON.stringify(envelope), now, envelope.created_at);
      this.store.db.prepare("UPDATE delivery_records SET state='RECEIVED',received_at=?,inbound_message_id=? WHERE discord_message_id=?")
        .run(now, input.messageId, input.messageId);
      return decision;
    } catch { return { allowed: false, reason: "DUPLICATE_MESSAGE", envelope: decision.envelope }; }
  }

  processed(messageId: string): void {
    const now = this.store.now();
    this.store.db.prepare("UPDATE inbound_messages SET state='PROCESSED',processed_at=? WHERE discord_message_id=?").run(now, messageId);
    this.store.db.prepare("UPDATE delivery_records SET state='PROCESSED',processed_at=? WHERE discord_message_id=?").run(now, messageId);
  }
}

function roleAllowed(event: NativeEnvelope["event_type"], role?: Role): boolean {
  if (event === "REVIEW") return role === "REVIEWER" || role === "ARCHITECT";
  if (event === "QA_RESULT") return role === "QA";
  // REVISION_REQUEST is addressed TO the implementer being asked to redo work (worker/runtime.ts's
  // emitOutcome() sets its role to the *recipient's* role, e.g. DEVELOPER), not to a Reviewer -- the
  // opposite of REVIEW. A prior bounded run showed every live
  // REVISION_REQUEST was silently ROLE_DENIED here (grouped with REVIEW, requiring REVIEWER/ARCHITECT),
  // so the round-1 Developer retry never started -- this had never been exercised end-to-end before.
  if (event === "REVISION_REQUEST" || event === "REVISION_RESULT") return role === "DEVELOPER" || role === "DEBUGGER" || role === "REFACTORER";
  if (["QUESTION", "ANSWER", "PROPOSAL", "OBJECTION", "CLARIFICATION", "CONSENSUS"].includes(event)) return Boolean(role);
  if (["EXPERT_REQUEST", "EXPERT_INVITE", "EXPERT_RESULT"].includes(event)) return Boolean(role || event === "EXPERT_REQUEST");
  return true;
}
function logicalKeyFor(envelope: NativeEnvelope): string {
  if (isCollaboration(envelope.event_type)) { const content = String(envelope.payload.content || envelope.payload.reason || "").toLowerCase().replace(/\s+/g, " ").trim();
    const digest = createHash("sha256").update(content).digest("hex"); return [envelope.task_id, envelope.event_type, envelope.sender, envelope.recipient,
      envelope.topic_id || envelope.payload.topic_id || envelope.payload.request_id || "", digest].join("|"); }
  // A bounded retry is a new delivery attempt, not an unbounded loop.  Only
  // an explicit dispatch id may distinguish it from the original logical
  // event; ordinary duplicate messages remain guarded by the stable key.
  const dispatchId = String(envelope.payload.dispatch_id || envelope.payload.retry_attempt || "");
  return [envelope.task_id, envelope.event_type, envelope.sender, envelope.recipient, envelope.role || "", envelope.round, dispatchId].join("|");
}
function isCollaboration(event: NativeEnvelope["event_type"]): boolean { return ["QUESTION", "ANSWER", "PROPOSAL", "OBJECTION", "CLARIFICATION", "CONSENSUS", "EXPERT_REQUEST", "EXPERT_INVITE", "EXPERT_RESULT"].includes(event); }
function isMeeting(event: NativeEnvelope["event_type"]): boolean { return ["MEETING_INVITE", "CAPABILITY_REPORT", "EXECUTION_PROPOSAL", "RESOURCE_REPORT", "MODEL_PROPOSAL", "PARALLEL_PLAN", "DEPENDENCY_REPORT", "BLOCKER", "COUNTER_PROPOSAL", "ROLE_ACCEPT"].includes(event); }
function meetingMembersAllowed(store: Store, envelope: NativeEnvelope): boolean {
  const sender = botTypeToAgent(envelope.sender); const recipient = botTypeToAgent(envelope.recipient);
  const session = String(envelope.payload.session_id || ""); if (!session) return false;
  const member = (agent?: string) => Boolean(agent && store.db.prepare("SELECT 1 FROM meeting_memberships WHERE session_id=? AND agent_id=?").get(session, agent));
  const senderAllowed = ["ASUS", "MAIN", "ORCHESTRATOR"].includes(envelope.sender) || member(sender);
  const recipientAllowed = ["ASUS", "MAIN", "ORCHESTRATOR"].includes(envelope.recipient) || member(recipient);
  return senderAllowed && recipientAllowed;
}
function collaborationMembersAllowed(store: Store, envelope: NativeEnvelope): boolean {
  const sender = botTypeToAgent(envelope.sender); const recipient = botTypeToAgent(envelope.recipient);
  const member = (agent?: string) => Boolean(agent && (store.db.prepare("SELECT 1 FROM task_roles WHERE task_id=? AND assigned_agent=?").get(envelope.task_id, agent)
    || store.db.prepare("SELECT 1 FROM expert_memberships WHERE task_id=? AND agent_id=? AND status IN ('INVITED','ACTIVE','PASS')").get(envelope.task_id, agent)));
  if (envelope.event_type === "EXPERT_REQUEST") return member(sender) && ["ASUS", "MAIN", "ORCHESTRATOR"].includes(envelope.recipient);
  // A bounded expert may be invited by ASUS/Main or by the assigned worker that
  // discovered the missing capability. The Discord author is still verified by
  // InboundGuard before this membership check.
  if (envelope.event_type === "EXPERT_INVITE") return ( ["ASUS", "MAIN", "ORCHESTRATOR"].includes(envelope.sender) || member(sender)) && member(recipient);
  return member(sender) && member(recipient);
}
