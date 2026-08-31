import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os"; import path from "node:path";
import { Store } from "../src/storage/database.js";
import { TaskRepository } from "../src/tasks/repository.js";
import { RuntimeDispatchRecovery } from "../src/runtime/dispatchRecovery.js";

const dirs: string[] = []; const stores: Store[] = [];
afterEach(() => { stores.splice(0).forEach((s) => s.close()); dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })); });
function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dispatch-recovery-")); dirs.push(dir); const store = new Store(path.join(dir, "runtime.db")); stores.push(store);
  store.db.prepare("INSERT INTO projects(project_id,name,workspace,ssot_paths_json,status,updated_at) VALUES(?,?,?,?,?,?)").run("p", "P", dir, "[]", "ACTIVE", store.now());
  const tasks = new TaskRepository(store); tasks.create({ taskId: "t", projectId: "p", title: "T", goal: "G", role: "DEVELOPER", requiredCapabilities: [], status: "DISPATCHED", assignedAgent: "OPENCODE", workspace: dir, readContext: {}, fileScope: [], doNot: [], validation: [], owner: "OWNER" });
  store.db.prepare("INSERT INTO protocol_events(event_id,task_id,event_type,sender,recipient,payload_json,created_at) VALUES(?,?,?,?,?,?,?)").run("delivery", "t", "TASK", "ORCHESTRATOR", "OPENCODE", "{}", store.now());
  const calls: string[] = []; const recovery = new RuntimeDispatchRecovery(store, tasks, async (id) => { calls.push(id); return true; }); return { store, tasks, recovery, calls, dir };
}
describe("RuntimeDispatchRecovery", () => {
  it("accepts stale DISPATCHED once and delegates without Worker selection", async () => { const x = setup(); const result = await x.recovery.recover("t", "r1", "loop guard"); expect(result).toMatchObject({ status: "SUCCEEDED", priorAssignment: "OPENCODE" }); expect(x.calls).toEqual(["t"]); expect(x.store.db.prepare("SELECT status,result FROM runtime_dispatch_recoveries WHERE recovery_id='r1'").get()).toMatchObject({ status: "SUCCEEDED", result: "REDRIVEN" }); await expect(x.recovery.recover("t", "r2", "again")).rejects.toThrow(); });
  it("rejects unsafe state", async () => {
    let x = setup(); x.store.db.prepare("INSERT INTO worker_processes(process_id,agent_id,task_id,attempt,pid,working_dir,started_at,last_seen,status,log_path) VALUES(?,?,?,?,?,?,?,?,?,?)").run("w", "OPENCODE", "t", 1, 1, x.dir, x.store.now(), x.store.now(), "RUNNING", "log"); await expect(x.recovery.recover("t", "a", "r")).rejects.toThrow("ACTIVE_WORKER");
    x = setup(); x.store.db.prepare("UPDATE tasks SET execution_hold=1 WHERE task_id='t'").run(); await expect(x.recovery.recover("t", "b", "r")).rejects.toThrow("EXECUTION_HOLD");
    for (const kind of ["ACK", "RESULT"]) { x = setup(); x.store.db.prepare("INSERT INTO protocol_events(event_id,task_id,event_type,sender,recipient,payload_json,created_at) VALUES(?,?,?,?,?,?,?)").run(kind, "t", kind, "OPENCODE", "OWNER", "{}", x.store.now()); await expect(x.recovery.recover("t", kind, "r")).rejects.toThrow("RESPONSE_EXISTS"); }
    x = setup(); x.store.db.prepare("UPDATE tasks SET status='PASS' WHERE task_id='t'").run(); await expect(x.recovery.recover("t", "c", "r")).rejects.toThrow("STATE_REJECTED");
    x = setup(); x.store.db.prepare("UPDATE tasks SET assigned_agent=NULL WHERE task_id='t'").run(); await expect(x.recovery.recover("t", "d", "r")).rejects.toThrow("ASSIGNMENT_MISSING");
    x = setup(); x.store.db.prepare("INSERT INTO workspace_locks(lock_key,task_id,token,file_scope_json,acquired_at,heartbeat_at) VALUES(?,?,?,?,?,?)").run("k", "t", "tok", "[]", x.store.now(), x.store.now()); await expect(x.recovery.recover("t", "e", "r")).rejects.toThrow("LIVE_LOCK");
  });
});
