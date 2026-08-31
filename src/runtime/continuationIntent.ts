import { randomUUID } from "node:crypto";
import type { AuthorityDecision } from "../authority/delegatedAuthority.js";
import type { Role } from "../domain/types.js";
import type { Store } from "../storage/database.js";
import type { ValidationEvidence } from "./correction.js";

export interface ContinuationIntentInput {
  role: Role;
  revisionRound: number;
  instruction: string;
  evidenceReferences?: readonly ValidationEvidence[];
}

export interface DurableContinuationIntent {
  intentId: string;
  taskId: string;
  runId?: string;
  role: Role;
  revisionRound: number;
  instruction: string;
  evidenceReferences: ValidationEvidence[];
  authoritySource: string;
  authority: AuthorityDecision;
  createdAt: string;
}

interface IntentRow {
  intent_id: string; task_id: string; run_id: string | null; role: Role; revision_round: number;
  instruction: string; evidence_references_json: string; authority_source: string; authority_json: string; created_at: string;
}

function fromRow(row: IntentRow): DurableContinuationIntent {
  return { intentId: row.intent_id, taskId: row.task_id, ...(row.run_id ? { runId: row.run_id } : {}), role: row.role,
    revisionRound: row.revision_round, instruction: row.instruction,
    evidenceReferences: JSON.parse(row.evidence_references_json) as ValidationEvidence[], authoritySource: row.authority_source,
    authority: JSON.parse(row.authority_json) as AuthorityDecision, createdAt: row.created_at };
}

/** Runtime-authority-only append. Workers receive this record but have no mutation API. */
export function recordContinuationIntent(store: Store, input: { taskId: string; runId?: string; intent: ContinuationIntentInput;
  authoritySource: string; authority: AuthorityDecision; createdAt?: string }): DurableContinuationIntent {
  if (!['OWNER', 'OPERATOR', 'RUNTIME'].includes(input.authoritySource) ||
      (input.authoritySource !== 'RUNTIME' && input.authority.authorityClass !== 'HUMAN_REQUIRED'))
    throw new Error("CONTINUATION_INTENT_AUTHORITY_REQUIRED");
  if (!input.intent.instruction.trim() || !Number.isInteger(input.intent.revisionRound) || input.intent.revisionRound < 0)
    throw new Error("CONTINUATION_INTENT_INVALID");
  const existing = store.db.prepare(`SELECT * FROM continuation_intents WHERE task_id=? AND run_id IS ? AND role=? AND revision_round=?`)
    .get(input.taskId, input.runId ?? null, input.intent.role, input.intent.revisionRound) as unknown as IntentRow | undefined;
  if (existing) {
    const durable = fromRow(existing);
    if (durable.instruction !== input.intent.instruction || JSON.stringify(durable.evidenceReferences) !== JSON.stringify(input.intent.evidenceReferences ?? []))
      throw new Error("CONTINUATION_INTENT_IMMUTABLE_CONFLICT");
    return durable;
  }
  const createdAt = input.createdAt ?? store.now();
  const durable: DurableContinuationIntent = { intentId: randomUUID(), taskId: input.taskId, ...(input.runId ? { runId: input.runId } : {}),
    role: input.intent.role, revisionRound: input.intent.revisionRound, instruction: input.intent.instruction,
    evidenceReferences: [...(input.intent.evidenceReferences ?? [])], authoritySource: input.authoritySource, authority: input.authority, createdAt };
  store.db.prepare(`INSERT INTO continuation_intents(intent_id,task_id,run_id,role,revision_round,instruction,evidence_references_json,authority_source,authority_json,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(durable.intentId, durable.taskId, durable.runId ?? null, durable.role, durable.revisionRound,
      durable.instruction, JSON.stringify(durable.evidenceReferences), durable.authoritySource, JSON.stringify(durable.authority), durable.createdAt);
  return durable;
}

/** Exact task/run/role/round binding makes older boundaries and cross-task rows ineligible. */
export function continuationIntentForDispatch(store: Store, taskId: string, runId: string | undefined, role: Role, revisionRound: number): DurableContinuationIntent | undefined {
  const row = store.db.prepare(`SELECT * FROM continuation_intents WHERE task_id=? AND run_id IS ? AND role=? AND revision_round=? ORDER BY created_at DESC LIMIT 1`)
    .get(taskId, runId ?? null, role, revisionRound) as unknown as IntentRow | undefined;
  return row ? fromRow(row) : undefined;
}

export function continuationDispatchPayload(originalGoal: string, intent?: DurableContinuationIntent): Record<string, unknown> {
  if (!intent) return { goal: originalGoal, original_goal: originalGoal, current_action: originalGoal };
  return { goal: intent.instruction, original_goal: originalGoal, current_action: intent.instruction, current_action_authoritative: true,
    continuation_intent: { intent_id: intent.intentId, run_id: intent.runId, role: intent.role, revision_round: intent.revisionRound,
      instruction: intent.instruction, evidence_references: intent.evidenceReferences, authority_source: intent.authoritySource,
      authority: intent.authority, created_at: intent.createdAt } };
}
