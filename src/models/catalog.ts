import type { AgentAdapter, ModelControlResult } from "../agents/adapter.js";
import type { AgentId, AgentModelPreference, ModelCatalogRecord, ModelVerificationLevel } from "../domain/types.js";
import type { Store } from "../storage/database.js";

const LEVEL_RANK: Record<ModelVerificationLevel, number> = {
  UNAVAILABLE: -1, DISCOVERED: 0, CLI_REPORTED: 1, CONFIGURED: 2, EXECUTION_VERIFIED: 3,
};

function parse<T>(value: unknown): T { return JSON.parse(String(value)) as T; }
function rowToModel(row: Record<string, unknown>): ModelCatalogRecord {
  return {
    modelId: String(row.model_id), agentId: row.agent_id as AgentId, provider: String(row.provider), modelName: String(row.model_name),
    ...(row.model_alias ? { modelAlias: String(row.model_alias) } : {}), displayName: String(row.display_name),
    available: Boolean(row.available), verified: Boolean(row.verified), verificationLevel: row.verification_level as ModelVerificationLevel,
    overrideSupported: Boolean(row.override_supported), overrideValue: String(row.override_value),
    resumeOverrideSupported: Boolean(row.resume_override_supported),
    ...(row.observed_actual_model ? { observedActualModel: String(row.observed_actual_model) } : {}),
    source: String(row.source), lastVerifiedAt: String(row.last_verified_at), metadata: parse<Record<string, unknown>>(row.metadata_json),
  };
}

export function modelCatalogId(agentId: AgentId, provider: string, modelName: string, alias?: string): string {
  return [agentId, provider, modelName, alias || ""].map((value) => value.trim().toLowerCase().replace(/[^a-z0-9._/-]+/g, "-")).join(":");
}

export class ModelCatalog {
  constructor(private readonly store: Store, private readonly adapters: Map<AgentId, AgentAdapter>) {}

  upsert(input: Omit<ModelCatalogRecord, "modelId" | "lastVerifiedAt"> & Partial<Pick<ModelCatalogRecord, "modelId" | "lastVerifiedAt">>): ModelCatalogRecord {
    const modelId = input.modelId || modelCatalogId(input.agentId, input.provider, input.modelName, input.modelAlias);
    const existing = this.get(modelId);
    const incomingWins = input.verificationLevel === "UNAVAILABLE" || !existing || LEVEL_RANK[input.verificationLevel] >= LEVEL_RANK[existing.verificationLevel];
    const observedActualModel = input.observedActualModel || existing?.observedActualModel;
    const record: ModelCatalogRecord = {
      ...(existing || {}), ...input, modelId,
      verificationLevel: incomingWins ? input.verificationLevel : existing!.verificationLevel,
      available: input.verificationLevel === "UNAVAILABLE" ? false : (existing?.available || input.available),
      verified: input.verificationLevel === "UNAVAILABLE" ? false : (existing?.verified || input.verified),
      ...(observedActualModel ? { observedActualModel } : {}),
      source: incomingWins ? input.source : existing!.source,
      lastVerifiedAt: input.lastVerifiedAt || this.store.now(),
      metadata: { ...(existing?.metadata || {}), ...input.metadata },
    };
    this.store.db.prepare(`INSERT INTO model_catalog(model_id,agent_id,provider,model_name,model_alias,display_name,available,verified,
      verification_level,override_supported,override_value,resume_override_supported,observed_actual_model,source,last_verified_at,metadata_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(model_id) DO UPDATE SET
      display_name=excluded.display_name,available=excluded.available,verified=excluded.verified,verification_level=excluded.verification_level,
      override_supported=excluded.override_supported,override_value=excluded.override_value,resume_override_supported=excluded.resume_override_supported,
      observed_actual_model=excluded.observed_actual_model,source=excluded.source,last_verified_at=excluded.last_verified_at,metadata_json=excluded.metadata_json`)
      .run(record.modelId, record.agentId, record.provider, record.modelName, record.modelAlias || null, record.displayName,
        record.available ? 1 : 0, record.verified ? 1 : 0, record.verificationLevel, record.overrideSupported ? 1 : 0,
        record.overrideValue, record.resumeOverrideSupported ? 1 : 0, record.observedActualModel || null, record.source,
        record.lastVerifiedAt, JSON.stringify(record.metadata));
    return record;
  }

  get(modelId: string): ModelCatalogRecord | undefined {
    const row = this.store.db.prepare("SELECT * FROM model_catalog WHERE model_id=?").get(modelId) as Record<string, unknown> | undefined;
    return row ? rowToModel(row) : undefined;
  }
  listAgentModels(agentId: AgentId): ModelCatalogRecord[] {
    return (this.store.db.prepare("SELECT * FROM model_catalog WHERE agent_id=? ORDER BY available DESC,verified DESC,display_name").all(agentId) as Record<string, unknown>[]).map(rowToModel);
  }
  getVerifiedModels(agentId: AgentId): ModelCatalogRecord[] { return this.listAgentModels(agentId).filter((model) => model.available && model.verified); }
  supportsModel(agentId: AgentId, value: string): ModelCatalogRecord | undefined {
    const normalized = value.trim().toLowerCase();
    return this.listAgentModels(agentId).find((model) => [model.modelName, model.modelAlias, model.overrideValue, `${model.provider}/${model.modelName}`]
      .filter(Boolean).some((candidate) => candidate!.toLowerCase() === normalized));
  }

  preference(agentId: AgentId): AgentModelPreference | undefined {
    const row = this.store.db.prepare("SELECT * FROM agent_model_preferences WHERE agent_id=?").get(agentId) as Record<string, unknown> | undefined;
    return row ? { agentId, modelId: String(row.model_id), selectedModel: String(row.selected_model), provider: String(row.provider),
      selectedAt: String(row.selected_at), source: String(row.source), verificationState: row.verification_state as AgentModelPreference["verificationState"] } : undefined;
  }

  getCurrentModel(agentId: AgentId): { preference?: AgentModelPreference; catalog?: ModelCatalogRecord } {
    const preference = this.preference(agentId); if (preference) { const catalog = this.get(preference.modelId); return { preference, ...(catalog ? { catalog } : {}) }; }
    const catalog = this.listAgentModels(agentId).find((item) => item.metadata.default === true && item.available)
      || this.listAgentModels(agentId).find((item) => ["EXECUTION_VERIFIED", "CONFIGURED"].includes(item.verificationLevel) && item.available);
    return catalog ? { catalog } : {};
  }

  async setAgentModel(agentId: AgentId, value: string, source = "RUNTIME_COMMAND"): Promise<ModelControlResult> {
    const model = this.supportsModel(agentId, value);
    if (!model) {
      if (agentId === "OPENCODE" && value.includes("/")) {
        const provider = value.split("/")[0]!.toLowerCase();
        const providers = new Set(this.listAgentModels(agentId).map((item) => item.provider.toLowerCase()));
        if (!providers.has(provider)) return { supported: false, code: "MODEL_PROVIDER_MISMATCH", detail: "MODEL_PROVIDER_MISMATCH" };
      }
      return { supported: false, code: "MODEL_NOT_AVAILABLE", detail: "MODEL_NOT_AVAILABLE" };
    }
    if (!model.available || !model.verified || model.verificationLevel === "UNAVAILABLE") return { supported: false, code: "MODEL_NOT_AVAILABLE", detail: "MODEL_NOT_AVAILABLE" };
    if (!model.overrideSupported) return { supported: false, code: "MODEL_OVERRIDE_UNSUPPORTED", detail: "MODEL_OVERRIDE_UNSUPPORTED" };
    const adapter = this.adapters.get(agentId); if (!adapter) return { supported: false, code: "MODEL_OVERRIDE_UNSUPPORTED", detail: "MODEL_OVERRIDE_UNSUPPORTED" };
    const applied = await adapter.modelSet(model.overrideValue); if (!applied.supported) return applied;
    const now = this.store.now();
    this.store.db.prepare(`INSERT INTO agent_model_preferences(agent_id,model_id,selected_model,provider,selected_at,source,verification_state)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET model_id=excluded.model_id,selected_model=excluded.selected_model,
      provider=excluded.provider,selected_at=excluded.selected_at,source=excluded.source,verification_state=excluded.verification_state`)
      .run(agentId, model.modelId, model.overrideValue, model.provider, now, source, model.verificationLevel);
    return { supported: true, model: model.overrideValue, provider: model.provider, ...(model.observedActualModel ? { effectiveModel: model.observedActualModel } : {}),
      detail: `${agentId}: requested=${model.overrideValue}; effective=${model.observedActualModel || "UNKNOWN"}; provider=${model.provider}` };
  }

  async clearAgentModel(agentId: AgentId): Promise<ModelControlResult> {
    this.store.db.prepare("DELETE FROM agent_model_preferences WHERE agent_id=?").run(agentId);
    return this.adapters.get(agentId)?.modelClear() || { supported: false, detail: "UNSUPPORTED" };
  }

  async restorePreferences(): Promise<Record<AgentId, string>> {
    const result = {} as Record<AgentId, string>;
    for (const agentId of ["CODEX", "CLAUDE_CODE", "OPENCODE", "COMMAND_CODE"] as AgentId[]) {
      const preference = this.preference(agentId); if (!preference) { result[agentId] = "CLI_DEFAULT"; continue; }
      const model = this.get(preference.modelId);
      if (!model?.available || !model.verified || model.verificationLevel === "UNAVAILABLE") {
        this.store.db.prepare("UPDATE agent_model_preferences SET verification_state='MODEL_REVALIDATION_REQUIRED' WHERE agent_id=?").run(agentId);
        result[agentId] = "MODEL_REVALIDATION_REQUIRED"; continue;
      }
      await this.adapters.get(agentId)?.modelSet(preference.selectedModel); result[agentId] = preference.selectedModel;
    }
    return result;
  }

  recordExecution(agentId: AgentId, requestedModel: string, provider: string, effectiveModel: string | undefined, source: string): ModelCatalogRecord {
    const existing = this.supportsModel(agentId, requestedModel);
    return this.upsert({
      ...(existing || {}), agentId, provider: existing?.provider || provider, modelName: existing?.modelName || requestedModel,
      ...(existing?.modelAlias ? { modelAlias: existing.modelAlias } : {}), displayName: existing?.displayName || requestedModel,
      available: true, verified: true, verificationLevel: "EXECUTION_VERIFIED", overrideSupported: existing?.overrideSupported ?? true,
      overrideValue: existing?.overrideValue || requestedModel, resumeOverrideSupported: existing?.resumeOverrideSupported ?? true,
      ...(effectiveModel ? { observedActualModel: effectiveModel } : {}), source, metadata: { ...(existing?.metadata || {}), executionVerified: true },
      lastVerifiedAt: this.store.now(),
    });
  }
}
