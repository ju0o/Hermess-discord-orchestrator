import { createHash, randomUUID } from "node:crypto";
import { redact } from "../security/redaction.js";
import type { Store } from "../storage/database.js";

export const OFFICE_EVENT_TYPES = [
  "QUESTION", "REVIEW_NOTE", "VARIABLE_DISCOVERED", "TEMP_PERMISSION_REQUEST",
  "UNRESOLVED_INCIDENT", "CAPACITY_EVENT",
] as const;
export type OfficeEventType = (typeof OFFICE_EVENT_TYPES)[number];
export type OfficeEventStatus = "OPEN" | "WAITING" | "RESOLVED" | "DISMISSED";
export type OfficeEventSeverity = "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface OfficeEventInput {
  eventType: OfficeEventType;
  source: string;
  summary: string;
  evidence: string[];
  suspectedOwner: string;
  severity: OfficeEventSeverity;
  recommendedNextStep: string;
  canContinueOtherWork: boolean;
  question?: string;
  taskId?: string;
  projectId?: string;
  sessionId?: string;
  fingerprint?: string;
  status?: OfficeEventStatus;
}

export interface OfficeEventRecord extends Omit<OfficeEventInput, "status" | "fingerprint" | "question" | "taskId" | "projectId" | "sessionId"> {
  eventId: string;
  status: OfficeEventStatus;
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  question?: string;
  taskId?: string;
  projectId?: string;
  sessionId?: string;
}

function bounded(value: string, max = 2_000): string {
  return redact(String(value || "")).trim().slice(0, max);
}

function cleanEvidence(values: string[]): string[] {
  return values.slice(0, 32).map((item) => bounded(item, 1_000)).filter(Boolean);
}

function fingerprint(input: OfficeEventInput): string {
  return input.fingerprint || createHash("sha256").update(JSON.stringify({
    type: input.eventType, source: input.source, task: input.taskId || "",
    summary: input.summary, evidence: input.evidence, owner: input.suspectedOwner,
  })).digest("hex");
}

function fromRow(row: Record<string, unknown>): OfficeEventRecord {
  const record: OfficeEventRecord = {
    eventId: String(row.event_id), eventType: row.event_type as OfficeEventType,
    source: String(row.source), status: row.status as OfficeEventStatus,
    summary: String(row.summary), evidence: JSON.parse(String(row.evidence_json || "[]")) as string[],
    suspectedOwner: String(row.suspected_owner || ""), severity: row.severity as OfficeEventSeverity,
    recommendedNextStep: String(row.recommended_next_step), canContinueOtherWork: Boolean(row.can_continue_other_work),
    fingerprint: String(row.fingerprint), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
  for (const [key, value] of [["question", row.question], ["taskId", row.task_id], ["projectId", row.project_id], ["sessionId", row.session_id]] as const) {
    if (value !== null && value !== undefined && String(value)) Object.assign(record, { [key]: String(value) });
  }
  if (row.resolved_at) record.resolvedAt = String(row.resolved_at);
  return record;
}

/** Durable Main-compatible overnight office queue. It never creates Tasks. */
export class OvernightOfficeQueue {
  constructor(private readonly store: Store) {}

  record(input: OfficeEventInput): OfficeEventRecord {
    const now = this.store.now();
    const clean = {
      eventType: input.eventType, source: bounded(input.source, 120), summary: bounded(input.summary),
      evidence: cleanEvidence(input.evidence), suspectedOwner: bounded(input.suspectedOwner, 120),
      severity: input.severity, recommendedNextStep: bounded(input.recommendedNextStep),
      canContinueOtherWork: input.canContinueOtherWork, question: input.question ? bounded(input.question) : null,
      taskId: input.taskId ? bounded(input.taskId, 160) : null, projectId: input.projectId ? bounded(input.projectId, 160) : null,
      sessionId: input.sessionId ? bounded(input.sessionId, 160) : null,
      fingerprint: fingerprint(input), status: input.status || "OPEN",
    };
    this.store.db.prepare(`INSERT OR IGNORE INTO office_events(
      event_id,event_type,source,status,task_id,project_id,session_id,summary,evidence_json,
      suspected_owner,severity,recommended_next_step,can_continue_other_work,question,
      fingerprint,created_at,updated_at,resolved_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`).run(
      randomUUID(), clean.eventType, clean.source, clean.status, clean.taskId, clean.projectId, clean.sessionId,
      clean.summary, JSON.stringify(clean.evidence), clean.suspectedOwner, clean.severity, clean.recommendedNextStep,
      clean.canContinueOtherWork ? 1 : 0, clean.question, clean.fingerprint, now, now,
    );
    const row = this.store.db.prepare("SELECT * FROM office_events WHERE fingerprint=? AND status IN ('OPEN','WAITING') ORDER BY created_at DESC LIMIT 1").get(clean.fingerprint) as Record<string, unknown> | undefined;
    if (!row) throw new Error("OFFICE_EVENT_RECORD_FAILED");
    return fromRow(row);
  }

  list(options: { status?: OfficeEventStatus; eventType?: OfficeEventType; limit?: number } = {}): OfficeEventRecord[] {
    const clauses: string[] = []; const params: Array<string | number> = [];
    if (options.status) { clauses.push("status=?"); params.push(options.status); }
    if (options.eventType) { clauses.push("event_type=?"); params.push(options.eventType); }
    const limit = Math.max(1, Math.min(200, options.limit || 50));
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.store.db.prepare(`SELECT * FROM office_events${where} ORDER BY created_at DESC LIMIT ?`).all(...params, limit) as Array<Record<string, unknown>>;
    return rows.map(fromRow);
  }

  updateStatus(eventId: string, status: OfficeEventStatus): OfficeEventRecord | undefined {
    const resolved = status === "RESOLVED" || status === "DISMISSED" ? this.store.now() : null;
    this.store.db.prepare("UPDATE office_events SET status=?,resolved_at=?,updated_at=? WHERE event_id=?").run(status, resolved, this.store.now(), eventId);
    const row = this.store.db.prepare("SELECT * FROM office_events WHERE event_id=?").get(eventId) as Record<string, unknown> | undefined;
    return row ? fromRow(row) : undefined;
  }
}
