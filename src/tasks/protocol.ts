import { randomUUID } from "node:crypto";
import type { ProtocolEventType, TaskRecord } from "../domain/types.js";
import type { Store } from "../storage/database.js";
import type { BotType, QaResultPayload, ReviewPayload, RevisionRequestPayload, RevisionResultPayload } from "../discord/control/types.js";
import type { PerformanceObserver } from "../performance/types.js";
import type { AgentId } from "../domain/types.js";

export interface ProtocolEvent { eventId: string; taskId: string; type: ProtocolEventType; sender: string; recipient: string; payload: Record<string, unknown>; createdAt: string; }
export interface WorkerExecutionProvenance { executionId: string; taskId: string; agentId: AgentId; completedAt: string; }
export interface ProtocolSink {
  publish(event: ProtocolEvent, task: TaskRecord): Promise<string | undefined>;
  /** Live sinks must never accept scheduler-authored synthetic Worker evidence. */
  readonly liveEvidenceSink?: boolean;
}
export class NullProtocolSink implements ProtocolSink { async publish(): Promise<string | undefined> { return undefined; } }

export class Protocol {
  private observer?: PerformanceObserver;
  constructor(private readonly store: Store, private readonly sink: ProtocolSink) {}
  get acceptsSyntheticEvidence(): boolean { return this.sink.liveEvidenceSink !== true; }
  attachObserver(observer: PerformanceObserver): void { this.observer = observer; }
  async emit(type: ProtocolEventType, task: TaskRecord, sender: string, recipient: string, payload: Record<string, unknown>): Promise<ProtocolEvent> {
    this.assertEvidenceEmissionAllowed(type, task, sender, payload);
    return this.persistAndPublish(type, task, sender, recipient, payload);
  }

  async emitWorkerEvidence(type: ProtocolEventType, task: TaskRecord, sender: AgentId, recipient: string,
    payload: Record<string, unknown>, provenance: WorkerExecutionProvenance): Promise<ProtocolEvent> {
    if (provenance.taskId !== task.taskId || provenance.agentId !== sender || !provenance.executionId)
      throw new Error("WORKER_EXECUTION_PROVENANCE_MISMATCH");
    return this.persistAndPublish(type, task, sender, recipient, { ...payload, worker_execution_id: provenance.executionId });
  }

  private assertEvidenceEmissionAllowed(type: ProtocolEventType, task: TaskRecord, sender: string, payload: Record<string, unknown>): void {
    const evidenceEvents: ProtocolEventType[] = ["ACK", "RESULT", "REVIEW", "QA_RESULT", "EXPERT_RESULT", "VERDICT", "REVISION_RESULT"];
    const workerSender = ["CODEX", "CLAUDE_CODE", "OPENCODE", "COMMAND_CODE"].includes(sender);
    if (!this.acceptsSyntheticEvidence && evidenceEvents.includes(type) && (task.dataClass === "CANARY" || payload.control_plane === true || payload.synthetic === true))
      throw new Error("SYNTHETIC_WORKER_EVIDENCE_FORBIDDEN_LIVE_SINK");
    if (!this.acceptsSyntheticEvidence && evidenceEvents.includes(type) && workerSender)
      throw new Error("WORKER_EVIDENCE_REQUIRES_EXECUTION_PROVENANCE");
  }

  private async persistAndPublish(type: ProtocolEventType, task: TaskRecord, sender: string, recipient: string, payload: Record<string, unknown>): Promise<ProtocolEvent> {
    const event: ProtocolEvent = { eventId: randomUUID(), taskId: task.taskId, type, sender, recipient, payload, createdAt: this.store.now() };
    this.store.db.prepare(`INSERT INTO protocol_events(event_id,task_id,event_type,sender,recipient,payload_json,created_at)
      VALUES(?,?,?,?,?,?,?)`).run(event.eventId, event.taskId, event.type, sender, recipient, JSON.stringify(payload), event.createdAt);
    const messageId = await this.sink.publish(event, task);
    // The durable event is already committed before publish. A Runtime may be
    // stopped while the transport promise is resolving; losing only the
    // optional Discord message-id projection must not turn a successful
    // authoritative Completion into an unhandled rejection.
    if (messageId) {
      try { this.store.db.prepare("UPDATE protocol_events SET discord_message_id=? WHERE event_id=?").run(messageId, event.eventId); } catch { /* restart/recovery can observe the durable event */ }
    }
    try { await this.observer?.observeTask(task.taskId); } catch { /* Observability cannot fail a Task delivery. */ }
    return event;
  }

  emitReview(task: TaskRecord, sender: AgentId, recipient: BotType, payload: ReviewPayload, round = 0): Promise<ProtocolEvent> {
    return this.emit("REVIEW", task, sender, recipient, { ...payload, role: payload.reviewer_role, round });
  }
  emitQaResult(task: TaskRecord, sender: AgentId, recipient: BotType, payload: QaResultPayload, round = 0): Promise<ProtocolEvent> {
    return this.emit("QA_RESULT", task, sender, recipient, { ...payload, role: "QA", round });
  }
  emitRevisionRequest(task: TaskRecord, sender: AgentId, recipient: BotType, payload: RevisionRequestPayload, round: number): Promise<ProtocolEvent> {
    return this.emit("REVISION_REQUEST", task, sender, recipient, { ...payload, role: "REVIEWER", round });
  }
  emitRevisionResult(task: TaskRecord, sender: AgentId, recipient: BotType, payload: RevisionResultPayload, round: number): Promise<ProtocolEvent> {
    return this.emit("REVISION_RESULT", task, sender, recipient, { ...payload, role: "DEVELOPER", round });
  }
}
