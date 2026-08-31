import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Store } from "../src/storage/database.js";
import { TaskRepository } from "../src/tasks/repository.js";

const dirs: string[] = []; afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() { const dir = mkdtempSync(path.join(os.tmpdir(), "hermess-test-")); dirs.push(dir); const store = new Store(path.join(dir, "state.db")); return { store, repo: new TaskRepository(store), dir }; }

describe("persistent task store", () => {
  it("persists project and task", () => { const { store, repo, dir } = setup(); repo.upsertProject({ projectId: "p", name: "P", workspace: dir, ssotPaths: [], status: "ACTIVE" }); const task = repo.create({ projectId: "p", title: "T", goal: "G", role: "DEVELOPER", requiredCapabilities: ["coding"], status: "QUEUED", workspace: dir, readContext: {}, fileScope: [], doNot: [], validation: [], owner: "MAIN" }); expect(repo.get(task.taskId)?.goal).toBe("G"); store.close(); });
  it("enforces transitions", () => { const { store, repo, dir } = setup(); repo.upsertProject({ projectId: "p", name: "P", workspace: dir, ssotPaths: [], status: "ACTIVE" }); const task = repo.create({ projectId: "p", title: "T", goal: "G", role: "DEVELOPER", requiredCapabilities: ["coding"], status: "QUEUED", workspace: dir, readContext: {}, fileScope: [], doNot: [], validation: [], owner: "MAIN" }); expect(repo.transition(task.taskId, "DISPATCHED").status).toBe("DISPATCHED"); expect(() => repo.transition(task.taskId, "PASS")).toThrow(); store.close(); });
  it("stores runtime state", () => { const { store } = setup(); store.upsertRuntimeState("x", { value: 3 }); expect(store.getRuntimeState<{value:number}>("x")?.value).toBe(3); store.close(); });
});
