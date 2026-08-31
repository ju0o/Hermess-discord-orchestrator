import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentAdapter } from "../src/agents/adapter.js";
import { ClaudeCodeAdapter } from "../src/agents/claude-code/ClaudeCodeAdapter.js";
import { CodexAdapter } from "../src/agents/codex/CodexAdapter.js";
import { CommandCodeAdapter } from "../src/agents/command-code/CommandCodeAdapter.js";
import { OpenCodeAdapter } from "../src/agents/opencode/OpenCodeAdapter.js";
import type { AgentId, ContextPackage, ModelTier, Role, TaskRecord, TaskType } from "../src/domain/types.js";
import { ModelCatalog } from "../src/models/catalog.js";
import { classifyFailure, ModelEscalationService } from "../src/models/escalation.js";
import { ModelRouter } from "../src/models/router.js";
import { classifyComplexity } from "../src/routing/complexityClassifier.js";
import type { ProcessRunner, RunOutput, RunSpec } from "../src/runtime/processRunner.js";
import { Store } from "../src/storage/database.js";
import { TaskRepository } from "../src/tasks/repository.js";

const dirs: string[] = []; afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
class FakeAdapter { selected?: string; async modelSet(model: string) { this.selected = model; return { supported: true, model, detail: "ok" }; } async modelGet() { return { supported: true, detail: this.selected || "default" }; } async modelClear() { return { supported: true, detail: "default" }; } }
function setup(existing?: { dir: string; dbPath: string }) {
  const dir = existing?.dir || mkdtempSync(path.join(os.tmpdir(), "symphony-router-")); if (!existing) dirs.push(dir); const dbPath = existing?.dbPath || path.join(dir, "state.db");
  const store = new Store(dbPath); const tasks = new TaskRepository(store); tasks.upsertProject({ projectId: "p", name: "P", workspace: dir, ssotPaths: [], status: "ACTIVE" });
  const fakes = { CODEX: new FakeAdapter(), CLAUDE_CODE: new FakeAdapter(), OPENCODE: new FakeAdapter(), COMMAND_CODE: new FakeAdapter() };
  const adapters = new Map<AgentId, AgentAdapter>(Object.entries(fakes).map(([id, value]) => [id as AgentId, value as unknown as AgentAdapter]));
  const catalog = new ModelCatalog(store, adapters); const router = new ModelRouter(store, tasks, catalog); const escalation = new ModelEscalationService(store, catalog, router);
  return { dir, dbPath, store, tasks, catalog, router, escalation, fakes };
}
let id = 0;
function task(x: ReturnType<typeof setup>, patch: Partial<TaskRecord> = {}): TaskRecord {
  return x.tasks.create({ taskId: `MR-${++id}`, projectId: "p", title: "Normal feature", goal: "Implement a normal feature", taskType: "FEATURE",
    role: "DEVELOPER", requiredCapabilities: ["coding"], status: "QUEUED", workspace: x.dir, readContext: {}, fileScope: [], doNot: [], validation: [], owner: "ASUS", ...patch });
}
function memoryTask(type: TaskType, title: string, patch: Partial<TaskRecord> = {}): TaskRecord { return { taskId: "M", projectId: "p", title, goal: title, taskType: type,
  role: "DEVELOPER", requiredCapabilities: ["coding"], status: "QUEUED", workspace: "C:\\temp", readContext: {}, fileScope: [], doNot: [], validation: [], owner: "ASUS", attempt: 0, createdAt: "now", evidence: [], ...patch }; }
function model(x: ReturnType<typeof setup>, agentId: AgentId, name: string) { const provider = agentId === "OPENCODE" ? "opencode-go" : agentId === "CODEX" ? "openai-chatgpt" : agentId === "CLAUDE_CODE" ? "claude.ai" : "command-code";
  return x.catalog.upsert({ agentId, provider, modelName: name.replace(/^.*\//, ""), displayName: name, available: true, verified: true, verificationLevel: "EXECUTION_VERIFIED",
    overrideSupported: true, overrideValue: name, resumeOverrideSupported: true, observedActualModel: name.replace(/^.*\//, ""), source: "test", metadata: {} }); }
function map(x: ReturnType<typeof setup>, agentId: AgentId, tier: ModelTier, name: string, roleScope: Role | "*" = "*") { const m = model(x, agentId, name); x.router.tiers.setMapping({ agentId, roleScope, modelTier: tier, modelCatalogId: m.modelId, enabled: true, source: "test", reason: "execution verified test mapping" }); return m; }

describe("complexity classifier", () => {
  it.each([
    ["T0", memoryTask("SCRIPT", "Run deterministic metadata extraction")], ["T1", memoryTask("FEATURE", "Small isolated change")],
    ["T2", memoryTask("FEATURE", "Implement normal feature")], ["T3", memoryTask("BUG", "Debug concurrency state machine migration")],
    ["T4", memoryTask("ARCHITECTURE", "Resolve architecture tradeoff")],
  ] as const)("classifies %s by reasoning difficulty", (expected, value) => expect(classifyComplexity(value).complexity).toBe(expected));
  it("honors manual complexity override", () => expect(classifyComplexity(memoryTask("SCRIPT", "simple", { complexity: "T4", complexitySource: "MANUAL", complexityReasons: ["COMPLEXITY_OVERRIDE"] }))).toMatchObject({ complexity: "T4", source: "MANUAL" }));
});

describe("verified model router", () => {
  it.each([["T0", "CHEAP"], ["T1", "CHEAP"], ["T2", "STANDARD"], ["T3", "STANDARD"], ["T4", "STRONG"]] as const)("routes %s logically to %s", (complexity, tier) => {
    const x = setup(); map(x, "CODEX", tier, `model-${tier.toLowerCase()}`); const t = task(x, { complexity, complexitySource: "MANUAL" }); expect(x.router.route(t, "DEVELOPER", "CODEX").selectedTier).toBe(tier); x.store.close();
  });
  it("uses an upward verified fallback when CHEAP is unavailable", () => { const x = setup(); map(x, "CODEX", "STANDARD", "standard"); const d = x.router.route(task(x, { complexity: "T1", complexitySource: "MANUAL" }), "DEVELOPER", "CODEX"); expect(d).toMatchObject({ requestedTier: "CHEAP", selectedTier: "STANDARD", fallback: true }); x.store.close(); });
  it("blocks unsafe downgrade from STANDARD to CHEAP", () => { const x = setup(); map(x, "CODEX", "CHEAP", "cheap"); expect(x.router.route(task(x, { complexity: "T3", complexitySource: "MANUAL" }), "DEVELOPER", "CODEX").status).toBe("BLOCKED"); x.store.close(); });
  it("blocks T4 when only STANDARD is verified", () => { const x = setup(); map(x, "CODEX", "STANDARD", "standard"); expect(x.router.route(task(x, { complexity: "T4", complexitySource: "MANUAL" }), "DEVELOPER", "CODEX").status).toBe("BLOCKED"); x.store.close(); });
  it("honors manual tier override", () => { const x = setup(); map(x, "CODEX", "STRONG", "strong"); expect(x.router.route(task(x, { complexity: "T0", complexitySource: "MANUAL", modelTierOverride: "STRONG" }), "DEVELOPER", "CODEX").selectedTier).toBe("STRONG"); x.store.close(); });
  it("honors a verified manual model override", () => { const x = setup(); const m = map(x, "CODEX", "STANDARD", "manual-model"); const d = x.router.route(task(x, { modelOverride: m.overrideValue }), "DEVELOPER", "CODEX"); expect(d).toMatchObject({ requestedModel: "manual-model", reason: "MANUAL_MODEL_OVERRIDE" }); x.store.close(); });
  it("blocks an unknown manual model", () => { const x = setup(); map(x, "CODEX", "STANDARD", "standard"); expect(x.router.route(task(x, { modelOverride: "unknown" }), "DEVELOPER", "CODEX")).toMatchObject({ status: "BLOCKED", reason: expect.stringContaining("MODEL_NOT_AVAILABLE") }); x.store.close(); });
  it("persists routing decisions and task complexity", () => { const x = setup(); map(x, "CODEX", "STANDARD", "standard"); const t = task(x); const d = x.router.route(t, "DEVELOPER", "CODEX"); expect(x.router.latest(t.taskId, "DEVELOPER")?.decisionId).toBe(d.decisionId); expect(x.tasks.get(t.taskId)?.complexity).toBe("T2"); x.store.close(); });
  it("supports independent role-specific Developer and Reviewer mappings", () => { const x = setup(); const dev = map(x, "CODEX", "STANDARD", "dev-model", "DEVELOPER"); const review = map(x, "CODEX", "STANDARD", "review-model", "REVIEWER"); const t = task(x);
    expect(x.router.route(t, "DEVELOPER", "CODEX").modelCatalogId).toBe(dev.modelId); expect(x.router.route(t, "REVIEWER", "CODEX").modelCatalogId).toBe(review.modelId); x.store.close(); });
  it("persists tier mappings across Runtime reconstruction", () => { const x = setup(); map(x, "CODEX", "STANDARD", "standard"); x.store.close(); const y = setup(x); expect(y.router.tiers.get("CODEX", "STANDARD")?.modelTier).toBe("STANDARD"); y.store.close(); });
  it("records requested/effective mismatch observability", () => { const x = setup(); map(x, "CODEX", "STANDARD", "standard"); const d = x.router.route(task(x), "DEVELOPER", "CODEX"); x.router.recordOutcome(d, "different"); const row = x.store.db.prepare("SELECT mismatch,effective_model FROM model_routing_decisions WHERE decision_id=?").get(d.decisionId); expect(row).toEqual({ mismatch: 1, effective_model: "different" }); x.store.close(); });
});

describe("evidence based escalation", () => {
  it("retries the same model once, then escalates CHEAP to STANDARD", () => { const x = setup(); map(x, "COMMAND_CODE", "CHEAP", "cheap"); map(x, "COMMAND_CODE", "STANDARD", "standard"); const d = x.router.route(task(x, { complexity: "T1", complexitySource: "MANUAL" }), "QA", "COMMAND_CODE");
    expect(x.escalation.evaluate(d, { reason: "dependency reasoning deficiency" }).action).toBe("RETRY_SAME_MODEL"); expect(x.escalation.evaluate(d, { reason: "repeated dependency reasoning deficiency" })).toMatchObject({ action: "ESCALATED", toTier: "STANDARD", toModel: "standard" }); x.store.close(); });
  it("escalates STANDARD to STRONG when verified", () => { const x = setup(); map(x, "CODEX", "STANDARD", "standard"); map(x, "CODEX", "STRONG", "strong"); const d = x.router.route(task(x), "DEVELOPER", "CODEX"); x.escalation.evaluate(d, { reason: "dependency reasoning deficiency" }); expect(x.escalation.evaluate(d, { reason: "repeated dependency reasoning deficiency" }).toTier).toBe("STRONG"); x.store.close(); });
  it("escalates STRONG to FRONTIER when verified", () => { const x = setup(); map(x, "CODEX", "STRONG", "strong"); map(x, "CODEX", "FRONTIER", "frontier"); const d = x.router.route(task(x, { modelTierOverride: "STRONG" }), "ARCHITECT", "CODEX"); x.escalation.evaluate(d, { reason: "architecture ambiguity reasoning deficiency" }); expect(x.escalation.evaluate(d, { reason: "repeated architecture ambiguity" }).toTier).toBe("FRONTIER"); x.store.close(); });
  it("blocks escalation when no higher verified tier exists", () => { const x = setup(); map(x, "CODEX", "STRONG", "strong"); const d = x.router.route(task(x, { modelTierOverride: "STRONG" }), "DEVELOPER", "CODEX"); x.escalation.evaluate(d, { reason: "reasoning deficiency" }); expect(x.escalation.evaluate(d, { reason: "repeated reasoning deficiency" }).action).toBe("BLOCKED"); x.store.close(); });
  it.each(["network timeout", "authentication credential failure", "tool failed: command not found"])("does not escalate non-model failure: %s", (reason) => { const x = setup(); map(x, "CODEX", "STANDARD", "standard"); const d = x.router.route(task(x), "DEVELOPER", "CODEX"); expect(x.escalation.evaluate(d, { reason }).action).toBe("NO_ESCALATION"); x.store.close(); });
  it("does not escalate a repeated syntax failure", () => { const x = setup(); map(x, "CODEX", "STANDARD", "standard"); const d = x.router.route(task(x), "DEVELOPER", "CODEX"); expect(x.escalation.evaluate(d, { reason: "syntax error" }).action).toBe("RETRY_SAME_MODEL"); expect(x.escalation.evaluate(d, { reason: "same syntax error" }).action).toBe("NO_ESCALATION"); x.store.close(); });
  it("classifies model, agent, project, tool, and environment evidence", () => { expect(classifyFailure("dependency reasoning deficiency")).toBe("MODEL_CAPABILITY"); expect(classifyFailure("wrong agent capability")).toBe("AGENT_CAPABILITY"); expect(classifyFailure("syntax error")).toBe("PROJECT"); expect(classifyFailure("tool failed")).toBe("TOOL"); expect(classifyFailure("authentication failure")).toBe("ENVIRONMENT"); });
  it("persists escalation evidence", () => { const x = setup(); map(x, "CODEX", "STANDARD", "standard"); const d = x.router.route(task(x), "DEVELOPER", "CODEX"); const e = x.escalation.evaluate(d, { reason: "dependency reasoning deficiency", evidence: ["review-1"] }); expect(x.store.db.prepare("SELECT action,evidence_json FROM model_escalations WHERE escalation_id=?").get(e.escalationId)).toEqual({ action: "RETRY_SAME_MODEL", evidence_json: '["review-1"]' }); x.store.close(); });
});

class CaptureRunner {
  spec?: RunSpec;
  async run(spec: RunSpec): Promise<RunOutput> { this.spec = spec; const stdout = spec.agentId === "CLAUDE_CODE" ? '{"type":"assistant","message":{"model":"claude-sonnet-5","content":[{"type":"text","text":"ok"}]}}\n{"type":"result","result":"ok","session_id":"s"}'
    : spec.agentId === "COMMAND_CODE" ? '{"event":{"type":"model_request_start","model":"poolside/test"}}\n{"result":"ok","sessionId":"s"}' : '{"sessionID":"s","thread_id":"s","text":"ok"}';
    return { stdout, stderr: "", exitCode: 0, processId: "p", logPath: "log" }; }
  async probe(): Promise<RunOutput> { return { stdout: "", stderr: "", exitCode: 0, processId: "p", logPath: "log" }; } cancelTask() { return false; }
}
function context(dir: string): ContextPackage { return { task: memoryTask("VALIDATION", "Adapter model option", { taskId: "ADAPTER", workspace: dir, status: "RUNNING" }), projectSsot: [], discord: [], memory: [], git: {}, files: [], priority: ["FILESYSTEM_GIT", "PROJECT_SSOT", "TASK_STATE", "DISCORD", "MEMORY"] }; }

describe("adapter model invocation integration", () => {
  it.each([
    ["CODEX", CodexAdapter, "gpt-test"], ["CLAUDE_CODE", ClaudeCodeAdapter, "sonnet"],
    ["OPENCODE", OpenCodeAdapter, "opencode-go/test"], ["COMMAND_CODE", CommandCodeAdapter, "poolside/test"],
  ] as const)("applies routed model to %s CLI arguments", async (_id, Adapter, selected) => { const dir = mkdtempSync(path.join(os.tmpdir(), "adapter-model-")); dirs.push(dir); const runner = new CaptureRunner(); const adapter = new Adapter(runner as unknown as ProcessRunner); const result = await adapter.startTask(context(dir), { model: selected });
    expect(runner.spec?.args).toContain(selected); expect(result.requestedModel).toBe(selected); });
});
