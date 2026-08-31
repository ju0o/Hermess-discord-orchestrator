import { randomUUID } from "node:crypto";
import { MODEL_TIERS, type AgentId, type ModelRoutingDecision, type ModelTier, type ModelTierMapping, type ReasoningComplexity, type Role, type TaskRecord } from "../domain/types.js";
import { classifyComplexity } from "../routing/complexityClassifier.js";
import type { Store } from "../storage/database.js";
import type { TaskRepository } from "../tasks/repository.js";
import type { ModelCatalog } from "./catalog.js";

const COMPLEXITY_TIER: Record<ReasoningComplexity, ModelTier> = { T0: "CHEAP", T1: "CHEAP", T2: "STANDARD", T3: "STANDARD", T4: "STRONG" };

export class ModelTierRepository {
  constructor(private readonly store: Store, private readonly catalog: ModelCatalog) {}

  setMapping(input: Omit<ModelTierMapping, "provider" | "verificationLevel" | "lastVerifiedAt">): ModelTierMapping {
    const model = this.catalog.get(input.modelCatalogId);
    if (!model?.available || !model.verified || model.verificationLevel !== "EXECUTION_VERIFIED") throw new Error("MODEL_TIER_REQUIRES_EXECUTION_VERIFIED");
    const record: ModelTierMapping = { ...input, provider: model.provider, verificationLevel: model.verificationLevel, lastVerifiedAt: this.store.now() };
    this.store.db.prepare(`INSERT INTO model_tier_mappings(agent_id,role_scope,model_tier,model_catalog_id,provider,verification_level,enabled,source,reason,last_verified_at)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(agent_id,role_scope,model_tier) DO UPDATE SET model_catalog_id=excluded.model_catalog_id,
      provider=excluded.provider,verification_level=excluded.verification_level,enabled=excluded.enabled,source=excluded.source,reason=excluded.reason,last_verified_at=excluded.last_verified_at`)
      .run(record.agentId, record.roleScope, record.modelTier, record.modelCatalogId, record.provider, record.verificationLevel,
        record.enabled ? 1 : 0, record.source, record.reason, record.lastVerifiedAt); return record;
  }
  get(agentId: AgentId, tier: ModelTier, role?: Role): ModelTierMapping | undefined {
    const row = role ? this.store.db.prepare(`SELECT * FROM model_tier_mappings WHERE agent_id=? AND model_tier=? AND enabled=1 AND role_scope IN (?, '*') ORDER BY CASE WHEN role_scope=? THEN 0 ELSE 1 END LIMIT 1`).get(agentId, tier, role, role)
      : this.store.db.prepare("SELECT * FROM model_tier_mappings WHERE agent_id=? AND model_tier=? AND enabled=1 AND role_scope='*'").get(agentId, tier);
    return row ? rowToMapping(row as Record<string, unknown>) : undefined;
  }
  list(agentId?: AgentId): ModelTierMapping[] {
    const rows = agentId ? this.store.db.prepare("SELECT * FROM model_tier_mappings WHERE agent_id=? ORDER BY role_scope,model_tier").all(agentId)
      : this.store.db.prepare("SELECT * FROM model_tier_mappings ORDER BY agent_id,role_scope,model_tier").all();
    return (rows as Record<string, unknown>[]).map(rowToMapping);
  }
}

export class ModelRouter {
  readonly tiers: ModelTierRepository;
  constructor(private readonly store: Store, private readonly tasks: TaskRepository, private readonly catalog: ModelCatalog) { this.tiers = new ModelTierRepository(store, catalog); }

  route(taskInput: TaskRecord, role: Role, agentId: AgentId, requestedTierOverride?: ModelTier): ModelRoutingDecision {
    let task = this.tasks.get(taskInput.taskId) || taskInput;
    const reasoningFailures = Number((this.store.db.prepare("SELECT count(*) n FROM model_failure_events WHERE task_id=? AND failure_category='MODEL_CAPABILITY'").get(task.taskId) as { n: number } | undefined)?.n || 0);
    const classification = classifyComplexity(task, { reasoningFailureCount: reasoningFailures });
    if (!task.complexity) task = this.tasks.setComplexity(task.taskId, classification.complexity, classification.reasons, classification.source);
    const latestEscalation = this.store.db.prepare(`SELECT to_tier FROM model_escalations WHERE task_id=? AND role=? AND agent_id=? AND action='ESCALATED' ORDER BY created_at DESC LIMIT 1`)
      .get(task.taskId, role, agentId) as { to_tier: ModelTier } | undefined;
    const requestedTier = requestedTierOverride || task.modelTierOverride || latestEscalation?.to_tier || COMPLEXITY_TIER[classification.complexity];
    if (task.modelOverride && !requestedTierOverride) return this.explicitModel(task, role, agentId, classification.complexity, requestedTier);
    const selected = this.select(agentId, role, requestedTier, classification.complexity);
    const decision = this.decision(task, role, agentId, classification.complexity, requestedTier, selected?.tier, selected?.mapping.modelCatalogId,
      selected ? this.catalog.get(selected.mapping.modelCatalogId)?.overrideValue : undefined, selected?.mapping.provider,
      selected ? selected.reason : "MODEL_ROUTING_BLOCKED: no verified suitable tier", Boolean(selected?.fallback), selected ? "SELECTED" : "BLOCKED");
    this.persist(decision); return decision;
  }

  recordOutcome(decision: ModelRoutingDecision, effectiveModel?: string): void {
    if (!effectiveModel) return;
    const model = decision.modelCatalogId ? this.catalog.get(decision.modelCatalogId) : undefined;
    const expected = model?.observedActualModel || model?.modelName || decision.requestedModel;
    const mismatch = Boolean(expected && normalize(expected) !== normalize(effectiveModel));
    this.store.db.prepare("UPDATE model_routing_decisions SET effective_model=?,mismatch=? WHERE decision_id=?").run(effectiveModel, mismatch ? 1 : 0, decision.decisionId);
    if (mismatch) this.store.upsertRuntimeState(`model:mismatch:${decision.taskId}:${decision.role}`, { reason: "MODEL_EFFECTIVE_MISMATCH", requested: decision.requestedModel, effective: effectiveModel, at: this.store.now() });
  }

  latest(taskId: string, role: Role): ModelRoutingDecision | undefined {
    const row = this.store.db.prepare("SELECT * FROM model_routing_decisions WHERE task_id=? AND role=? ORDER BY created_at DESC LIMIT 1").get(taskId, role) as Record<string, unknown> | undefined;
    return row ? rowToDecision(row) : undefined;
  }

  nextVerifiedTier(agentId: AgentId, role: Role, current: ModelTier): { tier: ModelTier; mapping: ModelTierMapping } | undefined {
    for (const tier of MODEL_TIERS.slice(MODEL_TIERS.indexOf(current) + 1)) { const mapping = this.validMapping(agentId, tier, role); if (mapping) return { tier, mapping }; }
    return undefined;
  }

  private explicitModel(task: TaskRecord, role: Role, agentId: AgentId, complexity: ReasoningComplexity, requestedTier: ModelTier): ModelRoutingDecision {
    const model = this.catalog.supportsModel(agentId, task.modelOverride!);
    if (!model?.available || !model.verified || model.verificationLevel !== "EXECUTION_VERIFIED") {
      const blocked = this.decision(task, role, agentId, complexity, requestedTier, undefined, undefined, undefined, undefined,
        "MODEL_NOT_AVAILABLE: explicit model is not execution-verified", false, "BLOCKED"); this.persist(blocked); return blocked;
    }
    const mapped = this.tiers.list(agentId).find((item) => item.enabled && item.modelCatalogId === model.modelId && (item.roleScope === "*" || item.roleScope === role));
    const selectedTier = mapped?.modelTier || requestedTier;
    const decision = this.decision(task, role, agentId, complexity, requestedTier, selectedTier, model.modelId, model.overrideValue, model.provider,
      "MANUAL_MODEL_OVERRIDE", selectedTier !== requestedTier, "SELECTED"); this.persist(decision); return decision;
  }

  private select(agentId: AgentId, role: Role, requested: ModelTier, complexity: ReasoningComplexity): { tier: ModelTier; mapping: ModelTierMapping; fallback: boolean; reason: string } | undefined {
    const order = safeFallbackOrder(requested, complexity);
    for (const tier of order) { const mapping = this.validMapping(agentId, tier, role); if (mapping) return { tier, mapping, fallback: tier !== requested,
      reason: tier === requested ? "VERIFIED_REQUESTED_TIER" : `VERIFIED_UPWARD_FALLBACK:${requested}->${tier}` }; }
    return undefined;
  }
  private validMapping(agentId: AgentId, tier: ModelTier, role: Role): ModelTierMapping | undefined {
    const mapping = this.tiers.get(agentId, tier, role); if (!mapping) return undefined; const model = this.catalog.get(mapping.modelCatalogId);
    return model?.available && model.verified && model.verificationLevel === "EXECUTION_VERIFIED" ? mapping : undefined;
  }
  private decision(task: TaskRecord, role: Role, agentId: AgentId, complexity: ReasoningComplexity, requestedTier: ModelTier,
    selectedTier: ModelTier | undefined, modelCatalogId: string | undefined, requestedModel: string | undefined, provider: string | undefined,
    reason: string, fallback: boolean, status: "SELECTED" | "BLOCKED"): ModelRoutingDecision {
    return { decisionId: randomUUID(), taskId: task.taskId, role, agentId, complexity, requestedTier, ...(selectedTier ? { selectedTier } : {}),
      ...(modelCatalogId ? { modelCatalogId } : {}), ...(requestedModel ? { requestedModel } : {}), ...(provider ? { provider } : {}),
      reason, fallback, status, createdAt: this.store.now() };
  }
  private persist(value: ModelRoutingDecision): void {
    this.store.db.prepare(`INSERT INTO model_routing_decisions(decision_id,task_id,role,agent_id,complexity,requested_tier,selected_tier,model_catalog_id,requested_model,provider,reason,fallback,status,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(value.decisionId, value.taskId, value.role, value.agentId, value.complexity, value.requestedTier,
        value.selectedTier || null, value.modelCatalogId || null, value.requestedModel || null, value.provider || null, value.reason, value.fallback ? 1 : 0, value.status, value.createdAt);
  }
}

export function safeFallbackOrder(requested: ModelTier, complexity: ReasoningComplexity): ModelTier[] {
  if (requested === "CHEAP") return ["CHEAP", "STANDARD", "STRONG", "FRONTIER"];
  if (requested === "STANDARD") return ["STANDARD", "STRONG", "FRONTIER"];
  if (requested === "STRONG") return ["STRONG", "FRONTIER"];
  return ["FRONTIER"];
}
function normalize(value: string): string { return value.toLowerCase().replace(/^.*\//, ""); }
function rowToMapping(row: Record<string, unknown>): ModelTierMapping { return { agentId: row.agent_id as AgentId, roleScope: row.role_scope as Role | "*", modelTier: row.model_tier as ModelTier,
  modelCatalogId: String(row.model_catalog_id), provider: String(row.provider), verificationLevel: row.verification_level as ModelTierMapping["verificationLevel"], enabled: Boolean(row.enabled),
  source: String(row.source), reason: String(row.reason), lastVerifiedAt: String(row.last_verified_at) }; }
function rowToDecision(row: Record<string, unknown>): ModelRoutingDecision { return { decisionId: String(row.decision_id), taskId: String(row.task_id), role: row.role as Role, agentId: row.agent_id as AgentId,
  complexity: row.complexity as ReasoningComplexity, requestedTier: row.requested_tier as ModelTier, ...(row.selected_tier ? { selectedTier: row.selected_tier as ModelTier } : {}),
  ...(row.model_catalog_id ? { modelCatalogId: String(row.model_catalog_id) } : {}), ...(row.requested_model ? { requestedModel: String(row.requested_model) } : {}),
  ...(row.provider ? { provider: String(row.provider) } : {}), reason: String(row.reason), fallback: Boolean(row.fallback), status: row.status as "SELECTED" | "BLOCKED", createdAt: String(row.created_at) }; }
