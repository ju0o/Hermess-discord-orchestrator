import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/storage/database.js";
import { SelfHealingLoop } from "../src/runtime/selfHealing.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("self-healing loop", () => {
  it("observes control-plane state and records a bounded recovery run", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hermess-self-healing-"));
    dirs.push(dir);
    const store = new Store(path.join(dir, "state.db"));
    const loop = new SelfHealingLoop(
      store,
      { reconcile: () => ({ processesChecked: 0, lostProcesses: 0, tasksMovedToWaitingMain: [], ambiguousDeliveries: 0 }) },
      { check: async () => [] },
      { reconcile: () => [] },
      () => [
        { agentId: "CLAUDE_CODE", connected: true, botId: "claude" },
        { agentId: "CODEX", connected: false, detail: "gateway_not_ready" },
        { agentId: "OPENCODE", connected: true, botId: "opencode" },
        { agentId: "COMMAND_CODE", connected: true, botId: "commandcode" },
      ],
      { record: (input) => ({ ...input, eventId: "event", status: "OPEN", fingerprint: "fingerprint", createdAt: "now", updatedAt: "now" }) as never },
    );

    const result = await loop.runOnce("test");
    expect(result.before.gateway.connected).toBe(3);
    expect(result.before.gateway.disconnected).toBe(1);
    expect(result.staleTasks).toEqual([]);
    expect(store.getRuntimeState<{ reason: string }>("runtime:self_healing:last_run")?.reason).toBe("test");
    store.close();
  });

  it("does not reconcile, watchdog, or reactivate work while Owner-paused", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hermess-self-healing-paused-")); dirs.push(dir);
    const store = new Store(path.join(dir, "state.db")); let actions = 0;
    const loop = new SelfHealingLoop(store,
      { reconcile: () => { actions++; return { processesChecked: 0, lostProcesses: 0, tasksMovedToWaitingMain: [], ambiguousDeliveries: 0 }; } },
      { check: async () => { actions++; return []; } }, { reconcile: () => { actions++; return []; } },
      () => [], undefined, () => true);
    const result = await loop.runOnce("interval");
    expect(actions).toBe(0); expect(result.reason).toContain("PAUSED_BY_OWNER"); store.close();
  });

  it("invokes the durable scoped continuation from the existing timer path without a global sweep", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hermess-self-healing-continuation-")); dirs.push(dir);
    const store = new Store(path.join(dir, "state.db")); const seen: unknown[] = []; let continuationRuns = 0;
    const continuation = {
      watchedTaskIds: () => ["T1", "T2"],
      runOnce: async (reason: string) => { continuationRuns++; return { reason, watchedTaskIds: ["T1", "T2"], observations: [], globalDispatcherTickUsed: false as const }; },
    };
    const loop = new SelfHealingLoop(store,
      { reconcile: (scope?: unknown) => { seen.push(scope); return { processesChecked: 0, lostProcesses: 0, tasksMovedToWaitingMain: [], ambiguousDeliveries: 0, agentsReleased: [], locksReleased: [] }; } },
      { check: async (ids?: readonly string[]) => { seen.push(ids); return []; } }, { reconcile: () => [] },
      () => [], undefined, () => false, undefined, continuation);
    const result = await loop.runOnce("interval");
    expect(continuationRuns).toBe(1); expect(result.continuation?.globalDispatcherTickUsed).toBe(false);
    expect(seen).toEqual([{ taskIds: ["T1", "T2"] }, ["T1", "T2"]]); store.close();
  });
});
