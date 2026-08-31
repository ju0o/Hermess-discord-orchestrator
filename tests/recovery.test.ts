import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/storage/database.js";
import { TaskRepository } from "../src/tasks/repository.js";
import { AgentRegistry } from "../src/registry/agentRegistry.js";
import { WorkspaceLocks } from "../src/tasks/locks.js";
import { Recovery } from "../src/runtime/recovery/recovery.js";

const dirs: string[] = []; afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hermess-recovery-")); dirs.push(dir);
  const store = new Store(path.join(dir, "state.db"));
  const tasks = new TaskRepository(store);
  const agents = new AgentRegistry(store);
  const locks = new WorkspaceLocks(store);
  tasks.upsertProject({ projectId: "p", name: "P", workspace: dir, ssotPaths: [], status: "ACTIVE" });
  return { dir, store, tasks, agents, locks };
}

/** A high, effectively-unassigned PID: process.kill(DEAD_PID, 0) reliably throws (ESRCH-equivalent) on both
 *  Windows and POSIX default pid_max ranges, so pidAlive() treats it as a lost process. */
const DEAD_PID = 999_999;

function claimedTaskWithDeadWorker(tasks: TaskRepository, agents: AgentRegistry, locks: WorkspaceLocks,
  store: Store, opts: { taskId: string; agentId: "CODEX" | "CLAUDE_CODE"; lockToken: string; workspace: string }) {
  agents.upsert({ agentId: opts.agentId, displayName: opts.agentId, backendType: "CLI", status: "AVAILABLE", health: "ONLINE", capabilities: ["coding"] });
  tasks.create({ taskId: opts.taskId, projectId: "p", title: "T", goal: "G", role: "DEVELOPER", requiredCapabilities: ["coding"],
    assignedAgent: opts.agentId, status: "QUEUED", workspace: opts.workspace, readContext: {}, fileScope: [], doNot: [], validation: [], owner: "MAIN" });
  agents.markBusy(opts.agentId, opts.taskId, "p", "DEVELOPER", opts.workspace);
  store.db.prepare(`INSERT INTO workspace_locks(lock_key,task_id,token,file_scope_json,acquired_at,heartbeat_at) VALUES(?,?,?,?,?,?)`)
    .run(`${opts.workspace.toLowerCase()}|${opts.lockToken}`, opts.taskId, opts.lockToken, JSON.stringify([opts.workspace]), store.now(), store.now());
  tasks.transition(opts.taskId, "DISPATCHED", { lockToken: opts.lockToken });
  tasks.transition(opts.taskId, "CLAIMED");
  store.db.prepare(`INSERT INTO worker_processes(process_id,agent_id,task_id,attempt,pid,working_dir,session_id,started_at,last_seen,exit_code,status,log_path)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(`proc-${opts.taskId}`, opts.agentId, opts.taskId, 1, DEAD_PID, opts.workspace, null, store.now(), store.now(), null, "RUNNING", path.join(opts.workspace, "log.txt"));
}

describe("Recovery.reconcile()", () => {
  it("releases the Agent's BUSY state when it fences a dead Worker's Task to WAITING_MAIN", () => {
    const { dir, store, tasks, agents, locks } = setup();
    claimedTaskWithDeadWorker(tasks, agents, locks, store, { taskId: "t-agent", agentId: "CODEX", lockToken: "lock-agent", workspace: dir });
    const recovery = new Recovery(store, tasks, agents, locks);
    const report = recovery.reconcile();
    expect(report.tasksMovedToWaitingMain).toEqual(["t-agent"]);
    expect(report.agentsReleased).toEqual(["CODEX"]);
    const agent = agents.get("CODEX")!;
    expect(agent.status).toBe("ERROR"); // release(id, error=true) — a lost process is not a clean AVAILABLE return
    expect(agent.currentTask).toBeUndefined();
    store.close();
  });

  it("releases the workspace lock when it fences a dead Worker's Task to WAITING_MAIN", () => {
    const { dir, store, tasks, agents, locks } = setup();
    claimedTaskWithDeadWorker(tasks, agents, locks, store, { taskId: "t-lock", agentId: "CODEX", lockToken: "lock-ws", workspace: dir });
    const recovery = new Recovery(store, tasks, agents, locks);
    const report = recovery.reconcile();
    expect(report.locksReleased).toEqual(["lock-ws"]);
    expect(store.db.prepare("SELECT * FROM workspace_locks WHERE token=?").get("lock-ws")).toBeUndefined();
    store.close();
  });

  it("is idempotent on a second reconcile (no duplicate release, no crash, empty second report)", () => {
    const { dir, store, tasks, agents, locks } = setup();
    claimedTaskWithDeadWorker(tasks, agents, locks, store, { taskId: "t-idem", agentId: "CODEX", lockToken: "lock-idem", workspace: dir });
    const recovery = new Recovery(store, tasks, agents, locks);
    const first = recovery.reconcile();
    expect(first.lostProcesses).toBe(1);
    const second = recovery.reconcile();
    expect(second.processesChecked).toBe(0); // worker_processes row is now LOST, not RUNNING -- nothing left to reconcile
    expect(second.lostProcesses).toBe(0);
    expect(second.agentsReleased).toEqual([]);
    expect(second.locksReleased).toEqual([]);
    expect(tasks.get("t-idem")?.status).toBe("WAITING_MAIN"); // unchanged, not re-transitioned
    store.close();
  });

  it("does not release an Agent that was already reassigned to a different Task in the interim", () => {
    const { dir, store, tasks, agents, locks } = setup();
    claimedTaskWithDeadWorker(tasks, agents, locks, store, { taskId: "t-orig", agentId: "CODEX", lockToken: "lock-orig", workspace: dir });
    // Simulate the Agent having already been reassigned elsewhere (e.g. by a later dispatch)
    // before Recovery.reconcile() gets around to processing the stale worker_processes row.
    tasks.create({ taskId: "t-other", projectId: "p", title: "T2", goal: "G2", role: "DEVELOPER", requiredCapabilities: ["coding"],
      assignedAgent: "CODEX", status: "CLAIMED", workspace: dir, readContext: {}, fileScope: [], doNot: [], validation: [], owner: "MAIN" });
    agents.markBusy("CODEX", "t-other", "p", "DEVELOPER", dir);
    const recovery = new Recovery(store, tasks, agents, locks);
    const report = recovery.reconcile();
    expect(report.tasksMovedToWaitingMain).toEqual(["t-orig"]);
    expect(report.agentsReleased).toEqual([]); // must not clear the Agent's current legitimate assignment
    const agent = agents.get("CODEX")!;
    expect(agent.status).toBe("BUSY");
    expect(agent.currentTask).toBe("t-other");
    store.close();
  });

  it("remains safe when Recovery is constructed without agents/locks (backward compatible call site)", () => {
    const { dir, store, tasks, agents, locks } = setup();
    claimedTaskWithDeadWorker(tasks, agents, locks, store, { taskId: "t-bare", agentId: "CODEX", lockToken: "lock-bare", workspace: dir });
    const recovery = new Recovery(store, tasks); // no agents/locks injected
    const report = recovery.reconcile();
    expect(report.tasksMovedToWaitingMain).toEqual(["t-bare"]);
    expect(report.agentsReleased).toEqual([]);
    expect(report.locksReleased).toEqual([]);
    store.close();
  });
});
