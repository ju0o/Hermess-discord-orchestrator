import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FREE_TIER_CANDIDATES, FREE_TIER_CANDIDATE_NAMES, FreeModelRegistry, QWEN_WORKSPACE_FREE_PROVIDER } from "../src/models/freeTierRegistry.js";
import { Store } from "../src/storage/database.js";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "symphony-free-models-")); dirs.push(dir);
  const store = new Store(path.join(dir, "state.db"));
  return { store, registry: new FreeModelRegistry(store) };
}

describe("QwenCloud free-tier model registry", () => {
  it("registers every supplied candidate and deduplicates registry keys", () => {
    const x = setup(); const result = x.registry.registerCandidates();
    expect(result.submitted).toBe(75);
    expect(result.registered).toBe(75);
    expect(result.duplicates).toBe(0);
    expect(x.registry.list(QWEN_WORKSPACE_FREE_PROVIDER)).toHaveLength(75);
    expect(x.registry.list().every((model) => model.state === "UNKNOWN")).toBe(true);
    expect(x.registry.active("GENERAL")).toHaveLength(0);
    x.store.close();
  });

  it("preserves model-scoped state and prevents repeated probing", async () => {
    const x = setup(); x.registry.registerCandidates();
    const summary = await x.registry.probeRegistered(async (model) => ({
      state: model.modelName === "qwen-flash" ? "AVAILABLE" : "QUOTA_EXHAUSTED",
      errorCode: model.modelName === "qwen-flash" ? undefined : "AllocationQuota.FreeTierOnly",
    }));
    expect(summary.attempted).toBe(75); expect(summary.available).toBe(1); expect(summary.quotaExhausted).toBe(74);
    expect(x.registry.getByModel("qwen-flash")?.state).toBe("AVAILABLE");
    expect(x.registry.getByModel("qwen-vl-ocr")?.state).toBe("QUOTA_EXHAUSTED");
    const second = await x.registry.probeRegistered(async () => ({ state: "AVAILABLE" }));
    expect(second.attempted).toBe(0); expect(second.skipped).toBe(75);
    x.store.close();
  });

  it("keeps special models out of general automatic routing while retaining capability routes", () => {
    const x = setup(); x.registry.registerCandidates();
    for (const name of FREE_TIER_CANDIDATE_NAMES) x.registry.beginProbe(name);
    x.registry.recordProbe("qwen-vl-ocr", { state: "AVAILABLE" });
    x.registry.recordProbe("qwen3-coder-next", { state: "AVAILABLE" });
    expect(x.registry.active("OCR").map((model) => model.modelName)).toContain("qwen-vl-ocr");
    expect(x.registry.active("CODING").map((model) => model.modelName)).toContain("qwen3-coder-next");
    expect(x.registry.active("GENERAL").map((model) => model.modelName)).not.toContain("qwen-vl-ocr");
    x.store.close();
  });
});
