import { randomUUID } from "node:crypto";
import { redact } from "../security/redaction.js";
import type { Store } from "../storage/database.js";

/** Bounded structured friction a Worker may attach to its RESULT/REVIEW/QA_RESULT. */
export const WORKER_FRICTION_TYPES = ["RUNTIME_FRICTION", "CONTEXT_FRICTION", "DISCORD_UX_FRICTION", "REVIEW_FRICTION", "RECOVERY_FRICTION", "OTHER"] as const;
export type WorkerFrictionType = (typeof WORKER_FRICTION_TYPES)[number];
export type WorkerFrictionSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/** "No friction" is a first-class, valid outcome -- it is not the absence of a record. */
export type WorkerFrictionInput =
  | { hasFriction: false }
  | { hasFriction: true; type: WorkerFrictionType; severity: WorkerFrictionSeverity; problem: string; impact: string; suggestion: string };

export interface WorkerFrictionRecord {
  frictionId: string;
  taskId: string;
  agentId: string;
  hasFriction: boolean;
  type?: WorkerFrictionType;
  severity?: WorkerFrictionSeverity;
  problem?: string;
  impact?: string;
  suggestion?: string;
  createdAt: string;
}

function bounded(value: string, max = 1_500): string { return redact(String(value || "")).trim().slice(0, max); }

function fromRow(row: Record<string, unknown>): WorkerFrictionRecord {
  const record: WorkerFrictionRecord = {
    frictionId: String(row.friction_id), taskId: String(row.task_id), agentId: String(row.agent_id),
    hasFriction: Boolean(row.has_friction), createdAt: String(row.created_at),
  };
  for (const [key, value] of [["type", row.type], ["severity", row.severity], ["problem", row.problem], ["impact", row.impact], ["suggestion", row.suggestion]] as const) {
    if (value !== null && value !== undefined && String(value)) Object.assign(record, { [key]: String(value) });
  }
  return record;
}

export class WorkerFriction {
  constructor(private readonly store: Store) {}

  record(taskId: string, agentId: string, input: WorkerFrictionInput): WorkerFrictionRecord {
    const frictionId = randomUUID(); const now = this.store.now();
    if (!input.hasFriction) {
      this.store.db.prepare(`INSERT INTO worker_friction(friction_id,task_id,agent_id,has_friction,type,severity,problem,impact,suggestion,created_at)
        VALUES(?,?,?,0,NULL,NULL,NULL,NULL,NULL,?)`).run(frictionId, taskId, agentId, now);
    } else {
      this.store.db.prepare(`INSERT INTO worker_friction(friction_id,task_id,agent_id,has_friction,type,severity,problem,impact,suggestion,created_at)
        VALUES(?,?,?,1,?,?,?,?,?,?)`).run(frictionId, taskId, agentId, input.type, input.severity,
        bounded(input.problem), bounded(input.impact), bounded(input.suggestion), now);
    }
    return this.get(frictionId)!;
  }

  get(frictionId: string): WorkerFrictionRecord | undefined {
    const row = this.store.db.prepare("SELECT * FROM worker_friction WHERE friction_id=?").get(frictionId) as Record<string, unknown> | undefined;
    return row ? fromRow(row) : undefined;
  }

  forTask(taskId: string): WorkerFrictionRecord[] {
    return (this.store.db.prepare("SELECT * FROM worker_friction WHERE task_id=? ORDER BY created_at").all(taskId) as Array<Record<string, unknown>>).map(fromRow);
  }

  recent(options: { hasFrictionOnly?: boolean; limit?: number } = {}): WorkerFrictionRecord[] {
    const where = options.hasFrictionOnly ? " WHERE has_friction=1" : "";
    const limit = Math.max(1, Math.min(500, options.limit || 100));
    return (this.store.db.prepare(`SELECT * FROM worker_friction${where} ORDER BY created_at DESC LIMIT ?`).all(limit) as Array<Record<string, unknown>>).map(fromRow);
  }
}

/** Korean rendering for the "Worker가 불편했던 점" section of a Final Human Summary. */
export function renderFriction(records: WorkerFrictionRecord[]): string {
  const withFriction = records.filter((record) => record.hasFriction);
  if (!withFriction.length) return "없음";
  return withFriction.map((record) => `- [${record.severity}] ${record.problem}${record.suggestion ? ` (제안: ${record.suggestion})` : ""}`).join("\n");
}
