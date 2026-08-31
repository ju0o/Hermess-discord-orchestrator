import { randomUUID } from "node:crypto";
import type { AgentId, FailureCategory, ModelEscalationRecord, ModelRoutingDecision, Role } from "../domain/types.js";
import type { Store } from "../storage/database.js";
import type { ModelCatalog } from "./catalog.js";
import type { ModelRouter } from "./router.js";

export interface FailureEvidence { category?: FailureCategory; reason: string; evidence?: string[]; }

export class ModelEscalationService {
  constructor(private readonly store: Store, private readonly catalog: ModelCatalog, private readonly router: ModelRouter) {}

  evaluate(decision: ModelRoutingDecision, input: FailureEvidence): ModelEscalationRecord {
    if (!decision.selectedTier || !decision.modelCatalogId || !decision.requestedModel) throw new Error("MODEL_ROUTING_DECISION_NOT_SELECTED");
    const category = input.category || classifyFailure(input.reason); const evidence = input.evidence || [];
    const occurrence = Number((this.store.db.prepare(`SELECT count(*) n FROM model_failure_events WHERE task_id=? AND role=? AND model_catalog_id=? AND failure_category=?`)
      .get(decision.taskId, decision.role, decision.modelCatalogId, category) as { n: number }).n) + 1;
    this.store.db.prepare(`INSERT INTO model_failure_events(failure_id,task_id,role,agent_id,model_tier,model_catalog_id,failure_category,reason,evidence_json,occurrence,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), decision.taskId, decision.role, decision.agentId, decision.selectedTier, decision.modelCatalogId, category,
        input.reason, JSON.stringify(evidence), occurrence, this.store.now());
    if (category === "AGENT_CAPABILITY") return this.persist(decision, category, input.reason, evidence, occurrence, "AGENT_SWITCH_CANDIDATE");
    if (["TOOL", "ENVIRONMENT"].includes(category)) return this.persist(decision, category, input.reason, evidence, occurrence, "NO_ESCALATION");
    if (["PROJECT", "UNKNOWN"].includes(category)) return this.persist(decision, category, input.reason, evidence, occurrence, occurrence === 1 ? "RETRY_SAME_MODEL" : "NO_ESCALATION");
    if (occurrence === 1) return this.persist(decision, category, input.reason, evidence, occurrence, "RETRY_SAME_MODEL");
    const next = this.router.nextVerifiedTier(decision.agentId, decision.role, decision.selectedTier);
    if (!next) return this.persist(decision, category, input.reason, evidence, occurrence, "BLOCKED");
    const model = this.catalog.get(next.mapping.modelCatalogId)!;
    return this.persist(decision, category, input.reason, evidence, occurrence, "ESCALATED", next.tier, model.overrideValue);
  }

  private persist(decision: ModelRoutingDecision, category: FailureCategory, reason: string, evidence: string[], attempt: number,
    action: ModelEscalationRecord["action"], toTier?: ModelEscalationRecord["toTier"], toModel?: string): ModelEscalationRecord {
    const record: ModelEscalationRecord = { escalationId: randomUUID(), taskId: decision.taskId, role: decision.role, agentId: decision.agentId,
      fromTier: decision.selectedTier!, ...(toTier ? { toTier } : {}), fromModel: decision.requestedModel!, ...(toModel ? { toModel } : {}),
      failureCategory: category, reason, attempt, evidence, action, createdAt: this.store.now() };
    this.store.db.prepare(`INSERT INTO model_escalations(escalation_id,task_id,role,agent_id,from_tier,to_tier,from_model,to_model,failure_category,reason,attempt,evidence_json,action,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(record.escalationId, record.taskId, record.role, record.agentId, record.fromTier, record.toTier || null,
        record.fromModel, record.toModel || null, record.failureCategory, record.reason, record.attempt, JSON.stringify(record.evidence), record.action, record.createdAt); return record;
  }
}

export function classifyFailure(detail: string): FailureCategory {
  const text = detail.toLowerCase();
  if (/auth|credential|rate limit|network|timeout|connection|provider unavailable/.test(text)) return /auth|credential/.test(text) ? "ENVIRONMENT" : "TOOL";
  if (/tool failed|command not found|cli_not_found|process crash/.test(text)) return "TOOL";
  if (/syntax|lint|format|typo|type error/.test(text)) return "PROJECT";
  if (/agent capability|unsupported capability|wrong agent/.test(text)) return "AGENT_CAPABILITY";
  if (/reasoning deficiency|dependency reasoning|architecture ambiguity|cross-subsystem.*misunderstood|repeated reasoning/.test(text)) return "MODEL_CAPABILITY";
  return "UNKNOWN";
}
