import { randomUUID } from "node:crypto";
import type { AgentAdapter } from "../agents/adapter.js";
import type { AgentId, AdapterTaskResult, Role } from "../domain/types.js";
import type { Store } from "../storage/database.js";
import type { ModelCatalog } from "./catalog.js";

export const COMMANDCODE_FREE_FALLBACK_MODEL = "poolside/laguna-s-2.1-free";
export const MAX_SAME_AGENT_FALLBACK_ATTEMPTS = 1;
export const FAILURE_CLASSES = ["CLI_NOT_FOUND", "AUTH_FAILURE", "MODEL_UNAVAILABLE", "QUOTA_EXHAUSTED", "PROVIDER_NETWORK_ERROR", "MODEL_CAPABILITY_FAILURE", "GENERIC_TOOL_ERROR"] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

export function classifyAvailabilityFailure(result: AdapterTaskResult): FailureClass {
  if (result.spawnErrorCode === "ENOENT") return "CLI_NOT_FOUND";
  const text = `${result.output}\n${result.provider || ""}`.toLowerCase();
  if (/\b(auth|authentication|credential|login required|unauthorized|forbidden)\b/.test(text)) return "AUTH_FAILURE";
  if (/\b(quota|billing|credit balance|usage limit|insufficient credits)\b/.test(text)) return "QUOTA_EXHAUSTED";
  if (/\b(model not found|model unavailable|unsupported model|requested model)\b/.test(text)) return "MODEL_UNAVAILABLE";
  if (/\b(network|connection|econnreset|enotfound|timeout|temporarily unavailable|service unavailable)\b/.test(text)) return "PROVIDER_NETWORK_ERROR";
  if (/\b(reasoning deficiency|model capability|insufficient reasoning)\b/.test(text)) return "MODEL_CAPABILITY_FAILURE";
  return "GENERIC_TOOL_ERROR";
}

export interface AvailabilityFallbackInput {
  taskId: string; role: Role; agentId: AgentId; requestedModel?: string; provider?: string;
  adapter: AgentAdapter;
  run: (model?: string) => Promise<AdapterTaskResult>;
}
export interface AvailabilityFallbackResult {
  result: AdapterTaskResult; failureClass?: FailureClass; fallbackAttempted: boolean;
  fallbackModel?: string; shouldFallbackWorker: boolean;
}

/** Small deterministic boundary: only CommandCode, only its execution-verified free model, once. */
export class ModelAvailabilityFallback {
  constructor(private readonly store: Store, private readonly catalog: ModelCatalog, private readonly cooldownMs = 15 * 60_000) {}

  async execute(input: AvailabilityFallbackInput): Promise<AvailabilityFallbackResult> {
    const initialModel = input.requestedModel || "CLI_DEFAULT";
    if (this.isUnavailable(input.agentId, input.provider || "command-code", initialModel)) {
      return this.tryFreeFallback(input, initialModel, input.provider || "command-code", "MODEL_UNAVAILABLE", "PRIMARY_MODEL_COOLDOWN");
    }
    const primary = await input.run(input.requestedModel);
    if (primary.ok) return { result: primary, fallbackAttempted: false, shouldFallbackWorker: false };
    const failureClass = classifyAvailabilityFailure(primary);
    const actualModel = primary.effectiveModel || primary.requestedModel || initialModel;
    const provider = primary.provider || input.provider || "command-code";
    this.recordHealth(input.agentId, provider, actualModel, failureClass);
    if (!eligibleAvailabilityFailure(failureClass)) {
      this.record(input, actualModel, provider, failureClass, undefined, undefined, false, "NOT_ATTEMPTED", "FALLBACK_CLASS_INELIGIBLE");
      return { result: primary, failureClass, fallbackAttempted: false, shouldFallbackWorker: true };
    }
    return this.tryFreeFallback(input, actualModel, provider, failureClass, "EXPLICIT_COMMANDCODE_FREE_MODEL");
  }

  private async tryFreeFallback(input: AvailabilityFallbackInput, originalModel: string, originalProvider: string, failureClass: FailureClass, reason: string): Promise<AvailabilityFallbackResult> {
    const fallback = this.eligibleFreeModel(input.agentId, originalModel, originalProvider, input.taskId, input.role);
    if (!fallback) {
      this.record(input, originalModel, originalProvider, failureClass, undefined, undefined, false, "NOT_ATTEMPTED", reason === "PRIMARY_MODEL_COOLDOWN" ? reason : "NO_ELIGIBLE_FREE_MODEL");
      return { result: { ok: false, output: `MODEL_AVAILABILITY_${failureClass}`, evidence: [], exitCode: null, requestedModel: originalModel, provider: originalProvider }, failureClass, fallbackAttempted: false, shouldFallbackWorker: true };
    }
    const fallbackResult = await input.run(fallback);
    const outcome = fallbackResult.ok ? "SUCCESS" : "FAIL";
    this.record(input, originalModel, originalProvider, failureClass, fallback, "command-code", true, outcome, reason);
    if (!fallbackResult.ok) this.recordHealth(input.agentId, fallbackResult.provider || "command-code", fallbackResult.effectiveModel || fallback, classifyAvailabilityFailure(fallbackResult));
    return { result: fallbackResult, failureClass, fallbackAttempted: true, fallbackModel: fallback, shouldFallbackWorker: !fallbackResult.ok };
  }

  private eligibleFreeModel(agentId: AgentId, originalModel: string, originalProvider: string, taskId: string, role: Role): string | undefined {
    if (agentId !== "COMMAND_CODE" || originalModel === COMMANDCODE_FREE_FALLBACK_MODEL) return undefined;
    if (this.isUnavailable(agentId, "command-code", COMMANDCODE_FREE_FALLBACK_MODEL)) return undefined;
    const verified = this.catalog.supportsModel(agentId, COMMANDCODE_FREE_FALLBACK_MODEL);
    if (!verified?.available || !verified.verified || verified.verificationLevel !== "EXECUTION_VERIFIED") return undefined;
    const prior = this.store.db.prepare(`SELECT 1 FROM model_fallback_attempts WHERE task_id=? AND role=? AND agent_id=?
      AND original_model=? AND original_provider=? AND fallback_model=? AND fallback_attempted=1 LIMIT 1`)
      .get(taskId, role, agentId, originalModel, originalProvider, COMMANDCODE_FREE_FALLBACK_MODEL);
    return prior ? undefined : COMMANDCODE_FREE_FALLBACK_MODEL;
  }

  private isUnavailable(agentId: AgentId, provider: string, model: string): boolean {
    const row = this.store.db.prepare("SELECT cooldown_until FROM model_availability_health WHERE agent_id=? AND provider=? AND model=?")
      .get(agentId, provider, model) as { cooldown_until: string | null } | undefined;
    return Boolean(row?.cooldown_until && Date.parse(row.cooldown_until) > Date.now());
  }
  private recordHealth(agentId: AgentId, provider: string, model: string, failureClass: FailureClass): void {
    if (!eligibleAvailabilityFailure(failureClass)) return;
    const now = this.store.now(); const cooldown = new Date(Date.now() + this.cooldownMs).toISOString();
    this.store.db.prepare(`INSERT INTO model_availability_health(agent_id,provider,model,availability_state,last_failure_class,last_failure_at,cooldown_until,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(agent_id,provider,model) DO UPDATE SET availability_state=excluded.availability_state,
      last_failure_class=excluded.last_failure_class,last_failure_at=excluded.last_failure_at,cooldown_until=excluded.cooldown_until,updated_at=excluded.updated_at`)
      .run(agentId, provider, model, "UNAVAILABLE", failureClass, now, cooldown, now);
  }
  private record(input: AvailabilityFallbackInput, originalModel: string, originalProvider: string, failureClass: FailureClass, fallbackModel: string | undefined,
    fallbackProvider: string | undefined, fallbackAttempted: boolean, fallbackResult: string, reason: string): void {
    this.store.db.prepare(`INSERT INTO model_fallback_attempts(fallback_id,task_id,role,agent_id,original_model,original_provider,failure_class,
      fallback_model,fallback_provider,fallback_attempted,fallback_result,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), input.taskId, input.role, input.agentId, originalModel, originalProvider, failureClass, fallbackModel || null,
        fallbackProvider || null, fallbackAttempted ? 1 : 0, fallbackResult, reason, this.store.now());
  }
}

function eligibleAvailabilityFailure(value: FailureClass): boolean {
  return value === "QUOTA_EXHAUSTED" || value === "MODEL_UNAVAILABLE" || value === "PROVIDER_NETWORK_ERROR";
}
