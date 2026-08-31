import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentAdapter } from "../src/agents/adapter.js";
import type { AgentId, AdapterTaskResult } from "../src/domain/types.js";
import { COMMANDCODE_FREE_FALLBACK_MODEL, classifyAvailabilityFailure, ModelAvailabilityFallback } from "../src/models/availabilityFallback.js";
import { ModelCatalog } from "../src/models/catalog.js";
import { Store } from "../src/storage/database.js";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hermess-model-availability-")); dirs.push(dir);
  const store = new Store(path.join(dir, "state.db"));
  const adapter = { id: "COMMAND_CODE", name: "Command Code", capabilities: [], modelSet: async () => ({ supported: true, detail: "ok" }) } as unknown as AgentAdapter;
  const catalog = new ModelCatalog(store, new Map<AgentId, AgentAdapter>([["COMMAND_CODE", adapter]]));
  catalog.upsert({ agentId: "COMMAND_CODE", provider: "command-code", modelName: COMMANDCODE_FREE_FALLBACK_MODEL, displayName: "Laguna free",
    available: true, verified: true, verificationLevel: "EXECUTION_VERIFIED", overrideSupported: true, overrideValue: COMMANDCODE_FREE_FALLBACK_MODEL,
    resumeOverrideSupported: true, source: "fixture", metadata: {}, lastVerifiedAt: store.now() });
  return { store, service: new ModelAvailabilityFallback(store, catalog, 60_000), adapter };
}
const fail = (output: string, extra: Partial<AdapterTaskResult> = {}): AdapterTaskResult => ({ ok: false, output, evidence: [], exitCode: 1, provider: "command-code", ...extra });
const pass = (model: string): AdapterTaskResult => ({ ok: true, output: "PASS", evidence: [], exitCode: 0, requestedModel: model, effectiveModel: model, provider: "command-code" });

async function execute(service: ModelAvailabilityFallback, results: AdapterTaskResult[], taskId = "T") {
  const calls: Array<string | undefined> = [];
  const answer = await service.execute({ taskId, role: "DEVELOPER", agentId: "COMMAND_CODE", requestedModel: "paid/default", adapter: {} as AgentAdapter,
    run: async (model) => { calls.push(model); const result = results.shift(); if (!result) throw new Error("fixture exhausted"); return result; } });
  return { answer, calls };
}

describe("deterministic CommandCode availability fallback", () => {
  it("A: quota exhaustion falls back once to Laguna and retains the agent", async () => {
    const x = setup(); const r = await execute(x.service, [fail("quota exhausted"), pass(COMMANDCODE_FREE_FALLBACK_MODEL)]);
    expect(r.calls).toEqual(["paid/default", COMMANDCODE_FREE_FALLBACK_MODEL]); expect(r.answer).toMatchObject({ fallbackAttempted: true, fallbackModel: COMMANDCODE_FREE_FALLBACK_MODEL, shouldFallbackWorker: false, result: { ok: true } });
    expect(x.store.db.prepare("SELECT failure_class,fallback_result FROM model_fallback_attempts").get()).toEqual({ failure_class: "QUOTA_EXHAUSTED", fallback_result: "SUCCESS" }); x.store.close();
  });
  it("B: provider network failure has the same bounded free fallback", async () => {
    const x = setup(); const r = await execute(x.service, [fail("Unable to connect to the API. Please check your network connection."), pass(COMMANDCODE_FREE_FALLBACK_MODEL)]);
    expect(r.answer).toMatchObject({ failureClass: "PROVIDER_NETWORK_ERROR", fallbackAttempted: true, result: { ok: true } }); x.store.close();
  });
  it("C: ENOENT is CLI_NOT_FOUND and never changes model", async () => {
    const x = setup(); const r = await execute(x.service, [fail("spawn commandcode ENOENT", { spawnErrorCode: "ENOENT" })]);
    expect(r.calls).toEqual(["paid/default"]); expect(r.answer).toMatchObject({ failureClass: "CLI_NOT_FOUND", fallbackAttempted: false, shouldFallbackWorker: true }); x.store.close();
  });
  it("D: authentication failure does not retry variants", async () => {
    const x = setup(); const r = await execute(x.service, [fail("authentication failure")]);
    expect(r.calls).toEqual(["paid/default"]); expect(r.answer).toMatchObject({ failureClass: "AUTH_FAILURE", fallbackAttempted: false }); x.store.close();
  });
  it("E: a failed free fallback exposes bounded other-worker fallback", async () => {
    const x = setup(); const r = await execute(x.service, [fail("requested model unavailable"), fail("provider network timeout")]);
    expect(r.calls).toEqual(["paid/default", COMMANDCODE_FREE_FALLBACK_MODEL]); expect(r.answer).toMatchObject({ fallbackAttempted: true, shouldFallbackWorker: true, result: { ok: false } }); x.store.close();
  });
  it("F: a cooled-down failed primary is not immediately reselected", async () => {
    const x = setup(); await execute(x.service, [fail("quota exhausted"), pass(COMMANDCODE_FREE_FALLBACK_MODEL)], "repeat");
    const r = await execute(x.service, [pass(COMMANDCODE_FREE_FALLBACK_MODEL)], "repeat-next");
    expect(r.calls).toEqual([COMMANDCODE_FREE_FALLBACK_MODEL]); expect(r.answer.result.ok).toBe(true); x.store.close();
  });
  it("classifies only explicit sanitized signatures", () => {
    expect(classifyAvailabilityFailure(fail("quota exhausted"))).toBe("QUOTA_EXHAUSTED");
    expect(classifyAvailabilityFailure(fail("model unavailable"))).toBe("MODEL_UNAVAILABLE");
    expect(classifyAvailabilityFailure(fail("random exit 1"))).toBe("GENERIC_TOOL_ERROR");
  });
});
