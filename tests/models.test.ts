import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentAdapter } from "../src/agents/adapter.js";
import type { AgentId, ModelVerificationLevel } from "../src/domain/types.js";
import { ModelCatalog } from "../src/models/catalog.js";
import { Store } from "../src/storage/database.js";
import { TaskRepository } from "../src/tasks/repository.js";

const dirs: string[] = []; afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
class FakeAdapter {
  selected?: string; clears = 0;
  async modelSet(model: string) { this.selected = model; return { supported: true, model, detail: "applied" }; }
  async modelGet() { return { supported: true, ...(this.selected ? { model: this.selected } : {}), detail: this.selected || "default" }; }
  async modelClear() { this.selected = undefined; this.clears++; return { supported: true, detail: "default" }; }
}
function setup(existing?: { dir: string; dbPath: string }) {
  const dir = existing?.dir || mkdtempSync(path.join(os.tmpdir(), "symphony-models-")); if (!existing) dirs.push(dir);
  const dbPath = existing?.dbPath || path.join(dir, "state.db"); const store = new Store(dbPath);
  const fakes = { CODEX: new FakeAdapter(), CLAUDE_CODE: new FakeAdapter(), OPENCODE: new FakeAdapter(), COMMAND_CODE: new FakeAdapter() };
  const adapters = new Map<AgentId, AgentAdapter>(Object.entries(fakes).map(([id, adapter]) => [id as AgentId, adapter as unknown as AgentAdapter]));
  return { dir, dbPath, store, fakes, catalog: new ModelCatalog(store, adapters) };
}
function add(x: ReturnType<typeof setup>, agentId: AgentId, modelName: string, level: ModelVerificationLevel = "CLI_REPORTED", patch: Record<string, unknown> = {}) {
  const provider = agentId === "OPENCODE" ? "opencode-go" : agentId === "CODEX" ? "openai-chatgpt" : agentId === "CLAUDE_CODE" ? "claude.ai" : "command-code";
  return x.catalog.upsert({ agentId, provider, modelName, displayName: modelName, available: level !== "UNAVAILABLE",
    verified: ["CLI_REPORTED", "EXECUTION_VERIFIED"].includes(level), verificationLevel: level, overrideSupported: true,
    overrideValue: agentId === "OPENCODE" ? `${provider}/${modelName}` : modelName, resumeOverrideSupported: true,
    source: "test", metadata: {}, ...patch });
}

describe("persistent verified model catalog", () => {
  it("adds schema 1203 without replacing legacy session fields", () => { const x = setup(); const migrations = x.store.db.prepare("SELECT version FROM schema_migrations").all() as Array<{version:number}>;
    expect(migrations.map((item) => item.version)).toContain(1203); const columns = x.store.db.prepare("PRAGMA table_info(sessions)").all() as Array<{name:string}>;
    expect(columns.map((item) => item.name)).toEqual(expect.arrayContaining(["model", "requested_model", "effective_model", "provider", "model_verification_source"])); x.store.close(); });
  it("persists catalog records across store restart", () => { const x = setup(); add(x, "CODEX", "gpt-test"); x.store.close(); const y = setup(x); expect(y.catalog.listAgentModels("CODEX")).toHaveLength(1); y.store.close(); });
  it("supports multiple models per Agent", () => { const x = setup(); add(x, "CODEX", "gpt-a"); add(x, "CODEX", "gpt-b"); expect(x.catalog.listAgentModels("CODEX")).toHaveLength(2); x.store.close(); });
  it("separates verified and discovered records", () => { const x = setup(); add(x, "CODEX", "cached", "DISCOVERED"); add(x, "CODEX", "reported"); expect(x.catalog.getVerifiedModels("CODEX").map((item) => item.modelName)).toEqual(["reported"]); x.store.close(); });
  it("does not activate an unverified discovered candidate", async () => { const x = setup(); add(x, "CODEX", "cached", "DISCOVERED"); expect(await x.catalog.setAgentModel("CODEX", "cached")).toMatchObject({ supported: false, code: "MODEL_NOT_AVAILABLE" }); x.store.close(); });
  it("rejects an unknown model", async () => { const x = setup(); expect(await x.catalog.setAgentModel("CODEX", "unknown")).toMatchObject({ supported: false, code: "MODEL_NOT_AVAILABLE" }); x.store.close(); });
  it("rejects an OpenCode provider mismatch", async () => { const x = setup(); add(x, "OPENCODE", "deepseek-test"); expect(await x.catalog.setAgentModel("OPENCODE", "other/model")).toMatchObject({ code: "MODEL_PROVIDER_MISMATCH" }); x.store.close(); });
  it("rejects unsupported override", async () => { const x = setup(); add(x, "CODEX", "fixed", "CLI_REPORTED", { overrideSupported: false }); expect(await x.catalog.setAgentModel("CODEX", "fixed")).toMatchObject({ code: "MODEL_OVERRIDE_UNSUPPORTED" }); x.store.close(); });
  it("applies and persists a supported override", async () => { const x = setup(); add(x, "CODEX", "gpt-test"); expect((await x.catalog.setAgentModel("CODEX", "gpt-test")).supported).toBe(true); expect(x.fakes.CODEX.selected).toBe("gpt-test"); expect(x.catalog.preference("CODEX")?.selectedModel).toBe("gpt-test"); x.store.close(); });
  it("maps Claude aliases to observed effective models", () => { const x = setup(); add(x, "CLAUDE_CODE", "sonnet", "EXECUTION_VERIFIED", { modelAlias: "sonnet", observedActualModel: "claude-sonnet-test" }); expect(x.catalog.supportsModel("CLAUDE_CODE", "sonnet")?.observedActualModel).toBe("claude-sonnet-test"); x.store.close(); });
  it("maps OpenCode full provider/model overrides", () => { const x = setup(); add(x, "OPENCODE", "deepseek-test"); expect(x.catalog.supportsModel("OPENCODE", "opencode-go/deepseek-test")?.modelName).toBe("deepseek-test"); x.store.close(); });
  it("maps CommandCode full model IDs", () => { const x = setup(); add(x, "COMMAND_CODE", "poolside/test"); expect(x.catalog.supportsModel("COMMAND_CODE", "poolside/test")?.provider).toBe("command-code"); x.store.close(); });
  it("records requested and effective session models separately", () => { const x = setup(); const tasks = new TaskRepository(x.store); tasks.upsertSession("s", "CLAUDE_CODE", "p", "t", "cli-s", { requestedModel: "sonnet", effectiveModel: "claude-sonnet-test", provider: "claude.ai", source: "stream" });
    expect(x.store.db.prepare("SELECT requested_model,effective_model,provider FROM sessions WHERE session_id='s'").get()).toEqual({ requested_model: "sonnet", effective_model: "claude-sonnet-test", provider: "claude.ai" }); x.store.close(); });
  it("restores a selected model after runtime restart", async () => { const x = setup(); add(x, "CODEX", "gpt-test"); await x.catalog.setAgentModel("CODEX", "gpt-test"); x.store.close(); const y = setup(x); await y.catalog.restorePreferences(); expect(y.fakes.CODEX.selected).toBe("gpt-test"); y.store.close(); });
  it("requires revalidation for a stale unavailable preference", async () => { const x = setup(); const model = add(x, "CODEX", "gpt-test"); await x.catalog.setAgentModel("CODEX", "gpt-test"); x.catalog.upsert({ ...model, available: false, verified: false, verificationLevel: "UNAVAILABLE", source: "test-unavailable", metadata: {} }); x.store.close();
    const y = setup(x); expect((await y.catalog.restorePreferences()).CODEX).toBe("MODEL_REVALIDATION_REQUIRED"); expect(y.catalog.preference("CODEX")?.verificationState).toBe("MODEL_REVALIDATION_REQUIRED"); y.store.close(); });
  it("promotes successful execution evidence", () => { const x = setup(); add(x, "OPENCODE", "deepseek-test"); const model = x.catalog.recordExecution("OPENCODE", "opencode-go/deepseek-test", "opencode-go", "deepseek-test", "session_export"); expect(model).toMatchObject({ verificationLevel: "EXECUTION_VERIFIED", observedActualModel: "deepseek-test", verified: true }); x.store.close(); });
  it("clears only the Runtime preference and returns to CLI default", async () => { const x = setup(); add(x, "CODEX", "gpt-test"); await x.catalog.setAgentModel("CODEX", "gpt-test"); await x.catalog.clearAgentModel("CODEX"); expect(x.catalog.preference("CODEX")).toBeUndefined(); expect(x.fakes.CODEX.clears).toBe(1); x.store.close(); });
});
