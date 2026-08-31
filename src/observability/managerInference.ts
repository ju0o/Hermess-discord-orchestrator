import { randomUUID } from "node:crypto";
import { config } from "../config/env.js";
import type { Store } from "../storage/database.js";

export const MANAGER_INFERENCE_METRIC = "MANAGER_INFERENCE";

export type ManagerInferenceResultStatus = "STARTED" | "SUCCEEDED" | "FAILED" | "BLOCKED" | "UNKNOWN";

export interface ProviderTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
}

export interface ManagerInferenceObservationInput {
  taskId: string;
  runId?: string;
  projectId?: string;
  acceptanceId?: string;
  caller: string;
  managerRole: string;
  triggerType: string;
  triggerId?: string;
  provider?: string;
  model?: string;
  providerUsage?: ProviderTokenUsage;
  contextChars?: number;
  contextBytes?: number;
  messageCount?: number;
  resultStatus: ManagerInferenceResultStatus;
  latencyMs: number;
  retryOf?: string;
  fallbackFrom?: string;
  nextOwner?: string;
  nextState?: string;
  decision?: string;
  finding?: string;
  rationale?: string;
  correlationKey?: string;
}

export interface ManagerInferenceObservation extends ManagerInferenceObservationInput {
  observationId: string;
  eventType: typeof MANAGER_INFERENCE_METRIC;
  timestamp: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  tokenUsageSource: "PROVIDER" | "UNKNOWN";
  correlationKey: string;
}

export interface ManagerInferenceSummary {
  total: number;
  observations: ManagerInferenceObservation[];
  byRole: Record<string, number>;
  byModel: Record<string, number>;
  byTask: Record<string, number>;
  byTrigger: Record<string, number>;
  suspiciousSignals: string[];
}

export class ManagerInferenceObservability {
  constructor(private readonly store: Store) {}

  record(input: ManagerInferenceObservationInput): ManagerInferenceObservation {
    const timestamp = this.store.now();
    const observationId = randomUUID();
    const correlationKey = input.correlationKey || [input.taskId, input.runId || "", input.managerRole, input.triggerType, input.triggerId || ""].join("|");
    const usage = input.providerUsage;
    const observation: ManagerInferenceObservation = {
      ...input,
      observationId,
      eventType: MANAGER_INFERENCE_METRIC,
      timestamp,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      totalTokens: usage ? (usage.totalTokens ?? usage.inputTokens + usage.outputTokens) : null,
      tokenUsageSource: usage ? "PROVIDER" : "UNKNOWN",
      correlationKey,
    };
    const metrics = JSON.stringify({
      observation_id: observation.observationId, event_type: observation.eventType, timestamp: observation.timestamp, task_id: observation.taskId,
      run_id: observation.runId ?? null, project_id: observation.projectId ?? null, caller: observation.caller,
      acceptance_id: observation.acceptanceId ?? null,
      manager_role: observation.managerRole, trigger_type: observation.triggerType, trigger_id: observation.triggerId ?? null,
      provider: observation.provider ?? null, model: observation.model ?? null,
      input_tokens: observation.inputTokens, output_tokens: observation.outputTokens, total_tokens: observation.totalTokens,
      token_usage_source: observation.tokenUsageSource, context_chars: observation.contextChars ?? null,
      context_bytes: observation.contextBytes ?? null, message_count: observation.messageCount ?? null,
      result_status: observation.resultStatus, latency_ms: observation.latencyMs, retry_of: observation.retryOf ?? null,
      fallback_from: observation.fallbackFrom ?? null, next_owner: observation.nextOwner ?? null,
      next_state: observation.nextState ?? null, decision: observation.decision ?? null,
      finding: observation.finding ?? null, rationale: observation.rationale ?? null,
      correlation_key: observation.correlationKey,
    });
    this.store.db.prepare(`INSERT INTO performance_events
      (logical_key,task_id,metric_type,role,agent_id,provider,model,status,metrics_json,evidence_source,evidence_ref,occurred_at,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      `manager-inference:${observationId}`, observation.taskId, MANAGER_INFERENCE_METRIC, observation.managerRole,
      observation.caller, observation.provider ?? null, observation.model ?? null, observation.resultStatus, metrics,
      "RUNTIME_INFERENCE_OBSERVABILITY", `performance_events:manager-inference:${observationId}`, timestamp, timestamp,
    );
    return observation;
  }

  recent(limit = 20): ManagerInferenceSummary {
    const rows = this.store.db.prepare(`SELECT metrics_json FROM performance_events
      WHERE metric_type=? ORDER BY occurred_at DESC, logical_key DESC LIMIT ?`).all(MANAGER_INFERENCE_METRIC, Math.max(0, Math.floor(limit))) as Array<{ metrics_json: string }>;
    const observations = rows.map((row) => fromMetrics(JSON.parse(row.metrics_json) as Record<string, unknown>));
    return summarize(observations);
  }
}

function fromMetrics(value: Record<string, unknown>): ManagerInferenceObservation {
  const observation: ManagerInferenceObservation = {
    taskId: String(value.task_id), caller: String(value.caller), managerRole: String(value.manager_role), triggerType: String(value.trigger_type),
    inputTokens: nullableNumber(value.input_tokens), outputTokens: nullableNumber(value.output_tokens), totalTokens: nullableNumber(value.total_tokens),
    tokenUsageSource: value.token_usage_source === "PROVIDER" ? "PROVIDER" : "UNKNOWN", resultStatus: String(value.result_status) as ManagerInferenceResultStatus,
    latencyMs: Number(value.latency_ms), correlationKey: String(value.correlation_key), observationId: String(value.observation_id || "persisted"), eventType: MANAGER_INFERENCE_METRIC, timestamp: String(value.timestamp),
  };
  const optional = { runId: optionalString(value.run_id), projectId: optionalString(value.project_id), acceptanceId: optionalString(value.acceptance_id), triggerId: optionalString(value.trigger_id), provider: optionalString(value.provider), model: optionalString(value.model),
    contextChars: optionalNumber(value.context_chars), contextBytes: optionalNumber(value.context_bytes), messageCount: optionalNumber(value.message_count), retryOf: optionalString(value.retry_of),
    fallbackFrom: optionalString(value.fallback_from), nextOwner: optionalString(value.next_owner), nextState: optionalString(value.next_state),
    decision: optionalString(value.decision), finding: optionalString(value.finding), rationale: optionalString(value.rationale) };
  for (const [key, item] of Object.entries(optional)) if (item !== undefined) (observation as unknown as Record<string, unknown>)[key] = item;
  return observation;
}

function summarize(observations: ManagerInferenceObservation[]): ManagerInferenceSummary {
  const count = (values: string[]) => values.reduce<Record<string, number>>((out, value) => { out[value] = (out[value] || 0) + 1; return out; }, {});
  const repeated = new Set(observations.map((item) => item.correlationKey)).size < observations.length;
  const highContext = observations.some((item) => (item.contextBytes ?? item.contextChars ?? 0) > config.MAX_CONTEXT_BYTES);
  const unknownTokens = observations.some((item) => item.tokenUsageSource === "UNKNOWN");
  const idle = observations.some((item) => /idle|background|timer/i.test(item.triggerType));
  const pingPong = observations.length >= 3 && observations.slice(0, 3).every((item, index, list) => index === 0 || item.managerRole !== list[index - 1]!.managerRole)
    && observations.slice(0, 3).every((item) => item.managerRole === "MAIN" || item.managerRole === "ASUS");
  return {
    total: observations.length, observations,
    byRole: count(observations.map((item) => item.managerRole)), byModel: count(observations.map((item) => item.model || "UNKNOWN")),
    byTask: count(observations.map((item) => item.taskId)), byTrigger: count(observations.map((item) => item.triggerType)),
    suspiciousSignals: [...(repeated ? ["REPEATED_TRIGGER"] : []), ...(highContext ? ["HIGH_CONTEXT"] : []),
      ...(unknownTokens ? ["TOKEN_USAGE_UNKNOWN"] : []), ...(idle ? ["IDLE_INFERENCE"] : []), ...(pingPong ? ["MAIN_ASUS_PING_PONG"] : [])],
  };
}

function optionalString(value: unknown): string | undefined { return value === null || value === undefined ? undefined : String(value); }
function optionalNumber(value: unknown): number | undefined { return value === null || value === undefined ? undefined : Number(value); }
function nullableNumber(value: unknown): number | null { return value === null || value === undefined ? null : Number(value); }
