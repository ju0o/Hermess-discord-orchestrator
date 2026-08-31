import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/storage/database.js";
import { TaskRepository } from "../src/tasks/repository.js";
import { AgentRegistry } from "../src/registry/agentRegistry.js";
import { WorkspaceLocks } from "../src/tasks/locks.js";
import { Watchdog } from "../src/runtime/watchdog.js";

const dirs: string[] = []; afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
describe("watchdog", () => {
  it("moves stale claimed tasks to WAITING_MAIN", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hermess-watchdog-")); dirs.push(dir);
    const store = new Store(path.join(dir, "state.db")); const tasks = new TaskRepository(store); const agents = new AgentRegistry(store); const locks = new WorkspaceLocks(store);
    tasks.upsertProject({ projectId: "p", name: "P", workspace: dir, ssotPaths: [], status: "ACTIVE" });
    agents.upsert({ agentId: "CODEX", displayName: "Codex", backendType: "CLI", status: "BUSY", health: "ONLINE", capabilities: ["coding"], currentTask: "t" });
    tasks.create({ taskId: "t", projectId: "p", title: "T", goal: "G", role: "DEVELOPER", requiredCapabilities: ["coding"], assignedAgent: "CODEX", status: "QUEUED", workspace: dir, readContext: {}, fileScope: [], doNot: [], validation: [], owner: "MAIN" });
    tasks.transition("t", "DISPATCHED"); tasks.transition("t", "CLAIMED");
    store.db.prepare("UPDATE tasks SET updated_at='2000-01-01T00:00:00.000Z' WHERE task_id='t'").run();
    const alerts: string[] = []; const watchdog = new Watchdog(store, tasks, agents, locks, async (message) => { alerts.push(message); });
    expect(await watchdog.check()).toEqual(["t"]); expect(tasks.get("t")?.status).toBe("WAITING_MAIN"); expect(alerts).toHaveLength(1); store.close();
  });
});
