import { createHash, randomUUID } from "node:crypto";
import type { Store } from "../storage/database.js";
import type { WorkerFrictionRecord, WorkerFrictionType } from "./workerFriction.js";
import type { OfficeEventRecord } from "./overnightQueue.js";

/**
 * Deterministic ranking over collected friction. This is a scoring formula, not an LLM
 * judgment call -- Improvement Backlog entries are candidates for Owner/Architecture triage,
 * not an instruction to implement anything automatically (see sprint rule: do not immediately
 * implement every finding).
 */
export type BacklogStatus = "OPEN" | "IN_PROGRESS" | "DONE" | "DISMISSED";

export interface BacklogEntry {
  backlogId: string; fingerprint: string; title: string; source: string;
  frequency: number; severityScore: number; ownerImpact: number; workerImpact: number; automationImpact: number;
  estimatedFixCost: "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN"; rankScore: number; status: BacklogStatus;
  evidence: string[]; createdAt: string; updatedAt: string;
}

const SEVERITY_SCORE: Record<string, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

// Type-driven impact weights. A Discord/UX-facing friction hits the Owner's experience directly;
// runtime/recovery friction mostly hits automation reliability; review/context friction mostly
// hits Worker throughput. Deliberately coarse -- refined by real triage, not by this formula.
const IMPACT_WEIGHTS: Record<WorkerFrictionType, { owner: number; worker: number; automation: number }> = {
  DISCORD_UX_FRICTION: { owner: 3, worker: 1, automation: 1 },
  RUNTIME_FRICTION: { owner: 1, worker: 1, automation: 3 },
  RECOVERY_FRICTION: { owner: 1, worker: 1, automation: 3 },
  CONTEXT_FRICTION: { owner: 1, worker: 3, automation: 1 },
  REVIEW_FRICTION: { owner: 1, worker: 3, automation: 1 },
  OTHER: { owner: 1, worker: 1, automation: 1 },
};

function fingerprint(type: string, problem: string): string {
  const normalized = problem.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 160);
  return createHash("sha256").update(`${type}|${normalized}`).digest("hex");
}

function fromRow(row: Record<string, unknown>): BacklogEntry {
  return {
    backlogId: String(row.backlog_id), fingerprint: String(row.fingerprint), title: String(row.title), source: String(row.source),
    frequency: Number(row.frequency), severityScore: Number(row.severity_score), ownerImpact: Number(row.owner_impact),
    workerImpact: Number(row.worker_impact), automationImpact: Number(row.automation_impact),
    estimatedFixCost: row.estimated_fix_cost as BacklogEntry["estimatedFixCost"], rankScore: Number(row.rank_score),
    status: row.status as BacklogStatus, evidence: JSON.parse(String(row.evidence_json || "[]")) as string[],
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

export class ImprovementBacklog {
  constructor(private readonly store: Store) {}

  /** Recomputes ranked entries from durable friction + office_events. Idempotent: same inputs -> same fingerprints, upserted. */
  recompute(friction: WorkerFrictionRecord[], officeEvents: OfficeEventRecord[] = []): BacklogEntry[] {
    const groups = new Map<string, { title: string; type: string; source: string; severity: number; count: number; evidence: string[] }>();
    for (const record of friction) {
      if (!record.hasFriction || !record.problem) continue;
      const fp = fingerprint(record.type || "OTHER", record.problem);
      const existing = groups.get(fp);
      const severity = SEVERITY_SCORE[record.severity || "LOW"] || 1;
      if (existing) { existing.count += 1; existing.severity = Math.max(existing.severity, severity); existing.evidence.push(record.frictionId); }
      else groups.set(fp, { title: record.problem, type: record.type || "OTHER", source: "WORKER_FRICTION", severity, count: 1, evidence: [record.frictionId] });
    }
    for (const event of officeEvents) {
      const fp = fingerprint(event.eventType, event.summary);
      const existing = groups.get(fp);
      const severity = SEVERITY_SCORE[event.severity] || 1;
      if (existing) { existing.count += 1; existing.severity = Math.max(existing.severity, severity); existing.evidence.push(event.eventId); }
      else groups.set(fp, { title: event.summary, type: event.eventType, source: "OFFICE_EVENT", severity, count: 1, evidence: [event.eventId] });
    }
    const now = this.store.now(); const results: BacklogEntry[] = [];
    for (const [fp, group] of groups) {
      const weights = IMPACT_WEIGHTS[group.type as WorkerFrictionType] || IMPACT_WEIGHTS.OTHER;
      const rankScore = group.count * 2 + group.severity * 3 + weights.owner + weights.worker + weights.automation;
      const estimatedFixCost: BacklogEntry["estimatedFixCost"] = "UNKNOWN"; // human/architecture triage assigns this, not this formula
      const existingRow = this.store.db.prepare("SELECT backlog_id,status,created_at FROM improvement_backlog WHERE fingerprint=?").get(fp) as { backlog_id: string; status: string; created_at: string } | undefined;
      const backlogId = existingRow?.backlog_id || randomUUID();
      const status: BacklogStatus = (existingRow?.status as BacklogStatus) || "OPEN";
      this.store.db.prepare(`INSERT INTO improvement_backlog(
        backlog_id,fingerprint,title,source,frequency,severity_score,owner_impact,worker_impact,automation_impact,
        estimated_fix_cost,rank_score,status,evidence_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(fingerprint) DO UPDATE SET frequency=excluded.frequency,severity_score=excluded.severity_score,
        rank_score=excluded.rank_score,evidence_json=excluded.evidence_json,updated_at=excluded.updated_at`).run(
        backlogId, fp, group.title.slice(0, 300), group.source, group.count, group.severity, weights.owner, weights.worker,
        weights.automation, estimatedFixCost, rankScore, status, JSON.stringify(group.evidence.slice(0, 50)),
        existingRow?.created_at || now, now,
      );
      results.push(fromRow(this.store.db.prepare("SELECT * FROM improvement_backlog WHERE backlog_id=?").get(backlogId) as Record<string, unknown>));
    }
    return results.sort((a, b) => b.rankScore - a.rankScore);
  }

  top(limit = 10): BacklogEntry[] {
    return (this.store.db.prepare("SELECT * FROM improvement_backlog WHERE status='OPEN' ORDER BY rank_score DESC LIMIT ?").all(limit) as Array<Record<string, unknown>>).map(fromRow);
  }

  setStatus(backlogId: string, status: BacklogStatus): void {
    this.store.db.prepare("UPDATE improvement_backlog SET status=?,updated_at=? WHERE backlog_id=?").run(status, this.store.now(), backlogId);
  }
}

export function renderBacklog(entries: BacklogEntry[]): string {
  if (!entries.length) return "현재 등록된 Improvement Backlog 항목이 없습니다.";
  return entries.map((entry, index) =>
    `${index + 1}. [${entry.source}] ${entry.title} (frequency=${entry.frequency}, severity=${entry.severityScore}, owner_impact=${entry.ownerImpact}, worker_impact=${entry.workerImpact}, automation_impact=${entry.automationImpact}, cost=${entry.estimatedFixCost}, score=${entry.rankScore.toFixed(1)})`,
  ).join("\n");
}
