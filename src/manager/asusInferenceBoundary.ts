import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config/env.js";
import type { Store } from "../storage/database.js";
import { ManagerInferenceObservability, type ProviderTokenUsage } from "../observability/managerInference.js";

export const ASUS_DOGFOOD_TASK = "HERMESS-DISCORD-OFFICE-DOGFOOD-01";
export const ASUS_HANDOFF_TRIGGER = "OPENCODE_RESULT_ASUS_HANDOFF";
export const ASUS_LOGICAL_HANDOFF_KEY = `asus-boundary:${ASUS_DOGFOOD_TASK}:OPENCODE->ASUS`;
const ASUS_ROLE = "ASUS";
const ALLOWED_DECISIONS = new Set(["ENGINEERING_PLAN", "TECHNICAL_REPLAN", "WORKER_CAPABILITY_JUDGMENT", "ENGINEERING_CONFLICT", "RECOVERY_JUDGMENT", "TECHNICAL_FINDING_SYNTHESIS", "SITE_INCIDENT_JUDGMENT"]);
const ALLOWED_NEXT_OWNERS = new Set(["ASUS", "MAIN", "OWNER", "RUNTIME", "WORKER"]);

export interface AsusInferenceRequest {
  taskId: string; runId?: string; projectId?: string; acceptanceId: string; triggerType: string; triggerId: string;
  sender: string; recipient: string; managerRole: string; context: AsusBoundedContext; messageCount: number;
}
export interface AsusBoundedContext { task: Record<string, unknown>; triggeringEvent: Record<string, unknown>; evidence: Record<string, unknown>; }
export interface AsusProviderResult { output: string; providerUsage?: ProviderTokenUsage; provider?: string; model?: string; }
export interface AsusInferenceProvider { readonly provider: string; readonly model: string; invoke(request: { prompt: string; context: AsusBoundedContext }): Promise<AsusProviderResult>; }
export interface AsusManagerResult { decision: string; nextOwner?: string; nextState?: string; finding?: string; rationale?: string; }
export interface AsusInferenceOutcome { result: AsusManagerResult; observationId: string; correlationKey: string; acceptanceId: string; contextChars: number; contextBytes: number; messageCount: number; }

export class AsusManagerInferenceBoundary {
  private readonly observability: ManagerInferenceObservability;
  constructor(private readonly store: Store, private readonly provider: AsusInferenceProvider, observability?: ManagerInferenceObservability) {
    this.observability = observability ?? new ManagerInferenceObservability(store);
  }

  async invoke(request: AsusInferenceRequest): Promise<AsusInferenceOutcome> {
    validateRequest(request);
    // The bounded experiment permits one real attempt for the logical handoff,
    // not one attempt per trigger representation. This key is the durable claim.
    const correlationKey = `${ASUS_LOGICAL_HANDOFF_KEY}:${request.acceptanceId}`;
    try {
      this.store.db.prepare("INSERT INTO manager_inference_attempts(correlation_key,task_id,trigger_id,created_at) VALUES(?,?,?,?)")
        .run(correlationKey, request.taskId, request.triggerId, this.store.now());
    } catch { throw new Error("ASUS_BOUNDARY_ALREADY_ATTEMPTED"); }
    const contextText = JSON.stringify(request.context);
    const contextChars = contextText.length;
    const contextBytes = Buffer.byteLength(contextText, "utf8");
    const started = Date.now();
    try {
      const response = await this.provider.invoke({ prompt: buildPrompt(request, contextText), context: request.context });
      const result = parseResult(response.output);
      const observation = this.observability.record({ taskId: request.taskId, ...(request.runId ? { runId: request.runId } : {}), ...(request.projectId ? { projectId: request.projectId } : {}), acceptanceId: request.acceptanceId,
        caller: "RUNTIME_ASUS_BOUNDARY", managerRole: ASUS_ROLE, triggerType: request.triggerType, triggerId: request.triggerId,
        provider: response.provider ?? this.provider.provider, model: response.model ?? this.provider.model, ...(response.providerUsage ? { providerUsage: response.providerUsage } : {}),
        contextChars, contextBytes, messageCount: request.messageCount, resultStatus: "SUCCEEDED", latencyMs: Date.now() - started,
        decision: result.decision, ...(result.finding ? { finding: result.finding } : {}), ...(result.rationale ? { rationale: result.rationale } : {}),
        ...(result.nextOwner ? { nextOwner: result.nextOwner } : {}), ...(result.nextState ? { nextState: result.nextState } : {}), correlationKey });
      return { result, observationId: observation.observationId, correlationKey, acceptanceId: request.acceptanceId, contextChars, contextBytes, messageCount: request.messageCount };
    } catch (error) {
      this.observability.record({ taskId: request.taskId, ...(request.runId ? { runId: request.runId } : {}), ...(request.projectId ? { projectId: request.projectId } : {}), acceptanceId: request.acceptanceId,
        caller: "RUNTIME_ASUS_BOUNDARY", managerRole: ASUS_ROLE, triggerType: request.triggerType, triggerId: request.triggerId,
        provider: this.provider.provider, model: this.provider.model, contextChars, contextBytes, messageCount: request.messageCount,
        resultStatus: "BLOCKED", latencyMs: Date.now() - started, correlationKey });
      throw error;
    }
  }
}

export class NousHermesProvider implements AsusInferenceProvider {
  readonly provider = "nous";
  readonly model = config.HERMES_ASUS_MODEL;
  async invoke(request: { prompt: string; context: AsusBoundedContext }): Promise<AsusProviderResult> {
    const usageFile = path.join(os.tmpdir(), `hermess-asus-usage-${randomUUID()}.json`);
    try {
      const output = await runHermes(["--profile", config.HERMES_ASUS_PROFILE, "--provider", "nous", "--model", this.model, "--reasoning", "minimal", "-z", request.prompt, "--usage-file", usageFile]);
      let providerUsage: ProviderTokenUsage | undefined;
      try { providerUsage = parseUsage(readFileSync(usageFile, "utf8")); } catch { /* provider did not return usage */ }
      return { output, ...(providerUsage ? { providerUsage } : {}) };
    } finally { try { rmSync(usageFile, { force: true }); } catch {} }
  }
}

function validateRequest(request: AsusInferenceRequest): void {
  if (request.taskId !== ASUS_DOGFOOD_TASK) throw new Error("ASUS_BOUNDARY_TASK_NOT_ALLOWED");
  if (!/^HERMESS-ASUS-BOUNDED-ACCEPTANCE-\d+$/.test(request.acceptanceId)) throw new Error("ASUS_BOUNDARY_ACCEPTANCE_ID_INVALID");
  if (request.managerRole !== ASUS_ROLE) throw new Error("ASUS_BOUNDARY_ROLE_NOT_ALLOWED");
  if (request.triggerType !== ASUS_HANDOFF_TRIGGER || request.sender !== "OPENCODE" || request.recipient !== ASUS_ROLE) throw new Error("ASUS_BOUNDARY_TRIGGER_NOT_ALLOWED");
  if (!request.triggerId || request.messageCount !== 1) throw new Error("ASUS_BOUNDARY_CONTEXT_NOT_BOUNDED");
  if (!request.context.task || !request.context.triggeringEvent || !request.context.evidence) throw new Error("ASUS_BOUNDARY_CONTEXT_INVALID");
}

function buildPrompt(request: AsusInferenceRequest, contextText: string): string {
  return ["You are ASUS, the Local Engineering Site Manager.", "Return JSON only; do not mutate Runtime state.",
    "Allowed decision values: ENGINEERING_PLAN, TECHNICAL_REPLAN, WORKER_CAPABILITY_JUDGMENT, ENGINEERING_CONFLICT, RECOVERY_JUDGMENT, TECHNICAL_FINDING_SYNTHESIS, SITE_INCIDENT_JUDGMENT.",
    "Allowed next_owner values: ASUS, MAIN, OWNER, RUNTIME, WORKER. A result is a proposal for Runtime validation, not authorization.",
    JSON.stringify({ task_id: request.taskId, trigger_type: request.triggerType, trigger_id: request.triggerId, context: JSON.parse(contextText) })].join("\n");
}

function parseResult(output: string): AsusManagerResult {
  const cleaned = output.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  let value: unknown;
  try { value = JSON.parse(cleaned); } catch { throw new Error("ASUS_RESULT_MALFORMED"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ASUS_RESULT_MALFORMED");
  const record = value as Record<string, unknown>;
  if (typeof record.decision !== "string" || !ALLOWED_DECISIONS.has(record.decision)) throw new Error("ASUS_RESULT_OUTSIDE_AUTHORITY");
  if (record.next_owner !== undefined && (typeof record.next_owner !== "string" || !ALLOWED_NEXT_OWNERS.has(record.next_owner))) throw new Error("ASUS_RESULT_OUTSIDE_AUTHORITY");
  for (const key of ["next_state", "finding", "rationale"]) if (record[key] !== undefined && (typeof record[key] !== "string" || String(record[key]).length > 1000)) throw new Error("ASUS_RESULT_MALFORMED");
  const nextOwner = typeof record.next_owner === "string" ? record.next_owner : undefined;
  const nextState = typeof record.next_state === "string" ? record.next_state : undefined;
  const finding = typeof record.finding === "string" ? record.finding : undefined;
  const rationale = typeof record.rationale === "string" ? record.rationale : undefined;
  return { decision: record.decision, ...(nextOwner ? { nextOwner } : {}), ...(nextState ? { nextState } : {}), ...(finding ? { finding } : {}), ...(rationale ? { rationale } : {}) };
}

function parseUsage(text: string): ProviderTokenUsage | undefined {
  const value = JSON.parse(text) as Record<string, unknown>;
  const input = numberValue(value.input_tokens ?? value.inputTokens ?? value.prompt_tokens);
  const output = numberValue(value.output_tokens ?? value.outputTokens ?? value.completion_tokens);
  const total = numberValue(value.total_tokens ?? value.totalTokens);
  return input !== undefined && output !== undefined ? { inputTokens: input, outputTokens: output, ...(total !== undefined ? { totalTokens: total } : {}) } : undefined;
}
function numberValue(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function runHermes(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.HERMES_CLI, args, { cwd: config.HERMESS_ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d: Buffer) => { stderr = d.toString("utf8").slice(-4000); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`NOUS_PROVIDER_FAILED_${code}: ${stderr.replace(/token|key|bearer|password/gi, "[redacted]")}`));
    });
  });
}

export function buildAsusContext(task: Record<string, unknown>, event: Record<string, unknown>): AsusBoundedContext {
  return { task: { task_id: task.task_id, project_id: task.project_id, title: task.title, goal: task.goal, status: task.status, result: task.result, next_owner: task.next_owner, thread_id: task.thread_id },
    triggeringEvent: { event_id: event.event_id, event_type: event.event_type, sender: event.sender, recipient: event.recipient, discord_message_id: event.discord_message_id, created_at: event.created_at },
    evidence: { payload: safePayload(event.payload_json) } };
}
function safePayload(raw: unknown): Record<string, unknown> { try { const value = JSON.parse(String(raw)); if (!value || typeof value !== "object" || Array.isArray(value)) return {}; const record = value as Record<string, unknown>; return { ok: record.ok, result: typeof record.result === "string" ? record.result.slice(0, 2000) : undefined, evidence: Array.isArray(record.evidence) ? record.evidence.slice(0, 20) : undefined, next_owner: record.next_owner }; } catch { return {}; } }
