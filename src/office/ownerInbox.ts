import { randomUUID } from "node:crypto";
import { redact } from "../security/redaction.js";
import type { Store } from "../storage/database.js";

export const OWNER_DECISION_TYPES = [
  "QUESTION", "OWNER_DECISION_REQUIRED", "TEMP_PERMISSION_REQUEST", "POLICY_CONFLICT", "VARIABLE", "HUMAN_REQUIRED",
] as const;
export type OwnerDecisionType = (typeof OWNER_DECISION_TYPES)[number];
export const OWNER_DECISION_STATUSES = ["OPEN", "ANSWERED", "NEEDS_CLARIFICATION", "RESOLVED", "SUPERSEDED"] as const;
export type OwnerDecisionStatus = (typeof OWNER_DECISION_STATUSES)[number];
export type OwnerDecisionUrgency = "LOW" | "NORMAL" | "HIGH" | "CRITICAL";

export interface OwnerDecisionInput {
  type: OwnerDecisionType;
  sourceAgent: string;
  taskId?: string;
  incidentId?: string;
  question: string;
  context: string;
  evidence: string[];
  recommendation: string;
  alternatives: string[];
  defaultSafeAction: string;
  blocks: string[];
  continues: string[];
  urgency: OwnerDecisionUrgency;
}

export interface OwnerDecisionRecord extends Omit<OwnerDecisionInput, "taskId" | "incidentId"> {
  decisionId: string;
  status: OwnerDecisionStatus;
  taskId?: string;
  incidentId?: string;
  answer?: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

function text(value: unknown, max = 4_000): string { return redact(String(value ?? "")).trim().slice(0, max); }
function list(values: readonly string[], maxItems = 32, maxItem = 1_000): string[] {
  return values.slice(0, maxItems).map((value) => text(value, maxItem)).filter(Boolean);
}
function parseList(value: unknown): string[] {
  try { return JSON.parse(String(value || "[]")) as string[]; } catch { return []; }
}
function fromRow(row: Record<string, unknown>): OwnerDecisionRecord {
  const record: OwnerDecisionRecord = {
    decisionId: String(row.decision_id), type: row.type as OwnerDecisionType, status: row.status as OwnerDecisionStatus,
    sourceAgent: String(row.source_agent), question: String(row.question), context: String(row.context),
    evidence: parseList(row.evidence_json), recommendation: String(row.recommendation), alternatives: parseList(row.alternatives_json),
    defaultSafeAction: String(row.default_safe_action), blocks: parseList(row.blocks_json), continues: parseList(row.continues_json),
    urgency: row.urgency as OwnerDecisionUrgency, createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
  for (const [key, value] of [["taskId", row.task_id], ["incidentId", row.incident_id], ["answer", row.answer]] as const) {
    if (value !== null && value !== undefined && String(value)) Object.assign(record, { [key]: String(value) });
  }
  if (row.resolved_at) record.resolvedAt = String(row.resolved_at);
  return record;
}

/** Durable engineering-side owner inbox. It parks only the affected branch. */
export class OwnerInbox {
  constructor(private readonly store: Store) {}

  create(input: OwnerDecisionInput): OwnerDecisionRecord {
    const now = this.store.now();
    const clean = {
      type: input.type, sourceAgent: text(input.sourceAgent, 160), taskId: input.taskId ? text(input.taskId, 160) : null,
      incidentId: input.incidentId ? text(input.incidentId, 160) : null, question: text(input.question), context: text(input.context),
      evidence: list(input.evidence), recommendation: text(input.recommendation), alternatives: list(input.alternatives),
      defaultSafeAction: text(input.defaultSafeAction), blocks: list(input.blocks), continues: list(input.continues), urgency: input.urgency,
    };
    const decisionId = randomUUID();
    this.store.db.prepare(`INSERT INTO owner_decisions(
      decision_id,type,status,source_agent,task_id,incident_id,question,context,evidence_json,
      recommendation,alternatives_json,default_safe_action,blocks_json,continues_json,urgency,answer,created_at,updated_at,resolved_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`).run(
      decisionId, clean.type, "OPEN", clean.sourceAgent, clean.taskId, clean.incidentId, clean.question, clean.context,
      JSON.stringify(clean.evidence), clean.recommendation, JSON.stringify(clean.alternatives), clean.defaultSafeAction,
      JSON.stringify(clean.blocks), JSON.stringify(clean.continues), clean.urgency, null, now, now,
    );
    return this.get(decisionId)!;
  }

  get(decisionId: string): OwnerDecisionRecord | undefined {
    const row = this.store.db.prepare("SELECT * FROM owner_decisions WHERE decision_id=?").get(decisionId) as Record<string, unknown> | undefined;
    return row ? fromRow(row) : undefined;
  }

  list(options: { status?: OwnerDecisionStatus; type?: OwnerDecisionType; limit?: number } = {}): OwnerDecisionRecord[] {
    const clauses: string[] = []; const params: Array<string | number> = [];
    if (options.status) { clauses.push("status=?"); params.push(options.status); }
    if (options.type) { clauses.push("type=?"); params.push(options.type); }
    const limit = Math.max(1, Math.min(200, options.limit || 50));
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return (this.store.db.prepare(`SELECT * FROM owner_decisions${where} ORDER BY created_at DESC LIMIT ?`).all(...params, limit) as Array<Record<string, unknown>>).map(fromRow);
  }

  update(decisionId: string, status: OwnerDecisionStatus, answer?: string): OwnerDecisionRecord | undefined {
    const resolved = status === "RESOLVED" || status === "SUPERSEDED" ? this.store.now() : null;
    this.store.db.prepare("UPDATE owner_decisions SET status=?,answer=?,resolved_at=?,updated_at=? WHERE decision_id=?")
      .run(status, answer ? text(answer) : null, resolved, this.store.now(), decisionId);
    return this.get(decisionId);
  }
}
